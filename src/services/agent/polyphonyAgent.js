import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiToolDeclarations } from '../tools/toolDefinitions.js';
import { ToolExecutor } from '../tools/toolExecutor.js';
import { LargeFileHandler } from '../storage/largeFileHandler.js';

// ⚠️ DO NOT MODIFY - Model specified by user and verified from official docs
// New models release frequently, but trust the user's explicit model choice here
// See: https://ai.google.dev/gemini-api/docs/models
const MODEL = 'gemini-3-flash-preview';
const MAX_ITERATIONS = 5;
const AUTO_READ_CHUNKS = 3; // Read first 3 chunks (~1500 tokens) initially

export class PolyphonyAgent {
  constructor(redisClient, fileStorage, vectorDB, io) {
    this.redisClient = redisClient;
    this.fileStorage = fileStorage;
    this.vectorDB = vectorDB;
    this.io = io;
    this.activeRooms = new Map(); // roomId -> { settings, canvas, adminUserId }
    this.toolExecutor = null;

    // Initialize Gemini
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({
        model: MODEL,
        tools: [geminiToolDeclarations]
      });
      console.log(`PolyphonyAgent initialized with model: ${MODEL}`);
    } else {
      console.warn('PolyphonyAgent: No API key - agent will use placeholder responses');
      this.model = null;
    }

    // Initialize tool executor with callbacks
    this.toolExecutor = new ToolExecutor(
      fileStorage,
      vectorDB,
      this.handleVisualization.bind(this),
      this.handleCanvasAdd.bind(this)
    );

    // Initialize large file handler
    this.largeFileHandler = new LargeFileHandler(redisClient, vectorDB);
  }

  registerRoom(roomId, adminUserId, metadata = {}) {
    this.activeRooms.set(roomId, {
      ...metadata,
      adminUserId,
      createdAt: Date.now(),
      settings: {
        groupChatEnabled: false // Default: private chat with agent only
      },
      canvas: [] // Shared contributions visible to all
    });
    console.log(`PolyphonyAgent: room registered ${roomId}, admin: ${adminUserId}`);
  }

  unregisterRoom(roomId) {
    this.activeRooms.delete(roomId);
    console.log(`PolyphonyAgent: room unregistered ${roomId}`);
  }

  // Get room state
  getRoomState(roomId) {
    return this.activeRooms.get(roomId);
  }

  // Check if user is admin
  isAdmin(roomId, userId) {
    const room = this.activeRooms.get(roomId);
    return room && room.adminUserId === userId;
  }

  // Toggle group chat (admin only)
  setGroupChat(roomId, userId, enabled) {
    const room = this.activeRooms.get(roomId);
    if (!room) return { error: 'Room not found' };
    if (room.adminUserId !== userId) return { error: 'Only admin can change settings' };

    room.settings.groupChatEnabled = enabled;
    console.log(`PolyphonyAgent: room ${roomId} groupChat=${enabled}`);
    return { success: true, groupChatEnabled: enabled };
  }

  // Add contribution to shared canvas
  addToCanvas(roomId, contribution) {
    const room = this.activeRooms.get(roomId);
    if (!room) return;

    room.canvas.push({
      id: `canvas-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...contribution,
      timestamp: Date.now()
    });

    // Broadcast canvas update to all users in room
    this.io.to(roomId).emit('canvas:update', {
      contribution: room.canvas[room.canvas.length - 1],
      canvas: room.canvas
    });
  }

  // Get canvas
  getCanvas(roomId) {
    const room = this.activeRooms.get(roomId);
    return room ? room.canvas : [];
  }

  // Handle visualization tool callback
  async handleVisualization(context, visualization) {
    const { roomId, socketId } = context;
    // Emit visualization only to the requesting user's socket
    this.io.to(socketId).emit('visualization:render', visualization);
  }

  // Handle canvas add tool callback
  async handleCanvasAdd(context, contribution) {
    const { roomId } = context;
    this.addToCanvas(roomId, contribution);
  }

  // Detect if a query is asking for synthesis/comparison/conflict analysis
  isSynthesisQuestion(query) {
    const synthesisKeywords = [
      'conflict', 'conflicts', 'compare', 'comparison', 'difference', 'differences',
      'both', 'vs', 'versus', 'priorities', 'tension', 'tensions', 'trade-off', 
      'tradeoff', 'trade off', 'how does', 'affect', 'impact', 'synthesize',
      'relationship', 'relationships', 'connection', 'connections', 'contrast',
      'opposing', 'alignment', 'align', 'misalignment', 'gap', 'gaps',
      'pm', 'developer', 'dev', 'stakeholder', 'requirement', 'requirements',
      'constraint', 'constraints', 'limitation', 'limitations', 'budget', 'timeline'
    ];
    const queryLower = query.toLowerCase();
    return synthesisKeywords.some(kw => queryLower.includes(kw.toLowerCase()));
  }

  // Get retrieval limit based on query type
  getRetrievalLimit(query) {
    // For synthesis questions, retrieve more chunks to ensure diverse perspectives
    if (this.isSynthesisQuestion(query)) {
      return 12; // Increased from 5 for cross-document synthesis
    }
    return 5;
  }

  // Main message handler with ReAct loop
  async handleMessage(roomId, userId, userName, socketId, content, conversationHistory = []) {
    const context = { roomId, userId, userName, socketId };
    const roomState = this.getRoomState(roomId);

    try {
      // Search for relevant knowledge first
      // Use increased limit for synthesis questions to get diverse perspectives
      const retrievalLimit = this.getRetrievalLimit(content);
      const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, content, retrievalLimit);
      
      if (retrievalLimit > 5) {
        console.log(`Agent: Using expanded retrieval (${retrievalLimit} chunks) for synthesis question: "${content.slice(0, 50)}..."`);
      }
      
      const files = this.fileStorage.listRoomFiles(roomId);

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(relevantKnowledge, files, roomState, userName);

      if (!this.model) {
        return {
          content: `[Agent placeholder] I received your message: "${content}". Configure GOOGLE_AI_API_KEY to enable AI responses.`,
          knowledgeUpdate: null
        };
      }

      // Build chat history
      const chatHistory = this.buildChatHistory(conversationHistory);
      console.log(`Agent: chat history has ${chatHistory.length} messages`);

      // Start chat with tools
      const chat = this.model.startChat({
        history: chatHistory,
        systemInstruction: {
          role: 'system',
          parts: [{ text: systemPrompt }]
        }
      });

      // ReAct loop
      console.log(`Agent: sending message to Gemini...`);
      let response = await chat.sendMessage(content);
      console.log(`Agent: received initial response`);
      let iterations = 0;

      while (iterations < MAX_ITERATIONS) {
        const candidate = response.response.candidates?.[0];
        if (!candidate) break;

        // Check for function calls
        const functionCalls = candidate.content?.parts?.filter(p => p.functionCall);

        if (!functionCalls || functionCalls.length === 0) {
          // No more function calls, we're done
          break;
        }

        // Execute each function call
        const functionResponses = [];
        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          console.log(`Agent: executing tool "${name}" with args:`, args);

          const result = await this.toolExecutor.execute(name, args, context);
          console.log(`Agent: tool "${name}" result:`, result.success ? 'success' : (result.error || 'done'));

          functionResponses.push({
            functionResponse: {
              name,
              response: result
            }
          });
        }

        // Send function responses back to model
        response = await chat.sendMessage(functionResponses);
        iterations++;
      }

      // Extract final text response - handle case where response might be empty
      let finalText;
      try {
        finalText = response.response.text();
      } catch (e) {
        // If text() fails, check if we have parts with text
        const parts = response.response.candidates?.[0]?.content?.parts;
        const textParts = parts?.filter(p => p.text).map(p => p.text);
        finalText = textParts?.join('\n') || 'I processed your request.';
      }

      // Get updated knowledge for UI
      const knowledgeUpdate = await this.buildKnowledgeTree(roomId);

      return {
        content: finalText,
        knowledgeUpdate
      };
    } catch (error) {
      console.error('=== POLYPHONY AGENT ERROR ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Room:', roomId, 'User:', userId);
      console.error('Content:', content?.slice(0, 100));
      console.error('=============================');
      return {
        content: `I encountered an error processing your message. Please try again. (${error.message})`,
        knowledgeUpdate: null
      };
    }
  }

  // Handle file upload - auto-process and create knowledge entries
  async handleFileUpload(roomId, userId, socketId, fileName, fileType, content) {
    try {
      // Save file and parse into intelligent chunks
      const fileInfo = await this.fileStorage.saveFile(roomId, fileName, fileType, content);

      console.log(`Agent: processing file ${fileName} (${fileInfo.chunkCount} chunks, ${fileInfo.totalTokens} tokens)`);

      // Check if this is a large file that needs special handling
      const isLargeFile = this.largeFileHandler.isLargeFile(fileInfo.totalChars, fileInfo.chunkCount);
      
      if (isLargeFile) {
        console.log(`  -> Using large file handler (strategic sampling)`);
        
        // Get all chunks for processing
        const chunks = this.fileStorage.getAllChunks(roomId).filter(c => c.fileId === fileInfo.fileId);
        
        // Use large file handler for smart processing
        const largeFileResult = await this.largeFileHandler.processLargeFile(
          roomId, 
          userId, 
          fileInfo, 
          chunks,
          this.io,
          socketId
        );

        // Create summary message for agent analysis
        const sampleChunks = chunks.slice(0, 3);
        const analysisPrompt = `A LARGE file has been uploaded: ${fileName}

Size: ${fileInfo.chunkCount} chunks (~${fileInfo.totalTokens} tokens)
Processing: Used strategic sampling - embedded ${largeFileResult.embeddedChunks} representative chunks (beginning, end, middle, random distribution). ${largeFileResult.lazyChunks} chunks available on-demand.

Here's a sample of the content:

${sampleChunks.map(c => `[Part ${c.chunkIndex + 1}]: ${c.content.slice(0, 500)}...`).join('\n\n')}

Please create a high-level overview knowledge entry summarizing:
1. What this document appears to be about
2. Key themes or topics covered
3. Any important context users should know

The detailed content is available - users can ask specific questions and I'll retrieve relevant sections.`;

        const result = await this.handleMessage(roomId, userId, 'System', socketId, analysisPrompt, []);

        return {
          fileInfo: {
            ...fileInfo,
            isLargeFile: true,
            embeddedChunks: largeFileResult.embeddedChunks,
            lazyChunks: largeFileResult.lazyChunks
          },
          agentSummary: result.content,
          knowledgeUpdate: result.knowledgeUpdate
        };
      }

      // Normal processing for smaller files
      if (!this.model) {
        return {
          fileInfo,
          knowledgeUpdate: await this.buildKnowledgeTree(roomId)
        };
      }

      // Auto-read first N chunks
      const chunksToRead = Math.min(AUTO_READ_CHUNKS, fileInfo.chunkCount);
      const autoReadResult = this.fileStorage.readFileSection(
        fileInfo.fileId,
        0,
        chunksToRead - 1
      );

      // Create knowledge entries from chunks
      const chunks = this.fileStorage.getAllChunks(roomId).filter(c => c.fileId === fileInfo.fileId);
      
      for (const chunk of chunks.slice(0, Math.min(10, chunks.length))) {
        await this.vectorDB.createKnowledgeEntry(
          roomId,
          userId,
          `${fileName} (Part ${chunk.chunkIndex + 1})`,
          chunk.content,
          ['file-upload', fileType.slice(1), 'auto-extracted'],
          [],
          { sourceMetadata: { fileName, chunkIndex: chunk.chunkIndex } }
        );
      }

      // Ask agent to analyze
      const analysisPrompt = `A file has been uploaded: ${fileName}

Size: ${fileInfo.chunkCount} chunks (~${fileInfo.totalTokens} tokens)

Content sample:

${autoReadResult.content}

Please analyze and create knowledge entries for key concepts.`;

      const result = await this.handleMessage(roomId, userId, 'System', socketId, analysisPrompt, []);

      return {
        fileInfo,
        agentSummary: result.content,
        knowledgeUpdate: result.knowledgeUpdate
      };
    } catch (error) {
      console.error('PolyphonyAgent: error in handleFileUpload:', error);
      throw error;
    }
  }

  // Build system prompt with context
  buildSystemPrompt(relevantKnowledge, files, roomState, userName) {
    const groupChatEnabled = roomState?.settings?.groupChatEnabled ?? false;
    const canvas = roomState?.canvas || [];

    let prompt = `You are a knowledge synthesis agent for Polyphony.live. Your responses MUST be grounded in the uploaded documents and previously extracted knowledge.

CRITICAL INSTRUCTIONS - FOLLOW EXACTLY:
1. You MUST only reference specific facts, numbers, dates, requirements, and details from the uploaded documents and knowledge base
2. NEVER produce generalized knowledge, platitudes, or training data (e.g., NEVER say "PMs often prioritize speed" - instead cite the specific requirement from the PRD)
3. Every claim must be traceable to a specific document with specific evidence
4. ALWAYS cite your sources: mention document names, requirement IDs, and specific data points (e.g., "According to the PRD (FR-1), score updates must happen within 5 minutes")
5. If you cannot find relevant information in the provided context, say "I don't have specific information about that in the uploaded documents" - DO NOT hallucinate
6. When comparing, finding conflicts, or synthesizing across sources, use search_knowledge to retrieve content from ALL relevant perspectives before responding
7. Prefer specific numbers and requirements over general descriptions

You have access to these tools:
- search_knowledge(query, limit): Query the vector database for specific information. Use this liberally to find relevant facts.
- read_file_section(file_id, start_chunk, end_chunk): Read specific parts of uploaded documents
- contribute(type, title, content, importance, tags): Add synthesized insights to the shared canvas
- mermaid_visualize(mermaid_code): Create diagrams when requested
`;

    if (!groupChatEnabled) {
      prompt += `\nIMPORTANT - MEDIATION MODE: Converse privately with the user, but use the contribute tool to share high-level, diplomatic insights with all users on the shared canvas.\n`;
    }

    prompt += `\nWhen asked to create a diagram, flowchart, sequence diagram, mind map, or any structured visualization, you MUST use the mermaid_visualize tool. Pass the complete Mermaid markdown block (including triple backticks and "mermaid" language identifier) as the mermaid_code parameter. Explain the diagram to the user before posting the code.\n`;

    // Include relevant knowledge in context - THIS IS CRITICAL FOR GROUNDING
    if (relevantKnowledge.length > 0) {
      prompt += `\n=== RELEVANT KNOWLEDGE FROM VECTOR SEARCH ===\n`;
      prompt += `The following content was retrieved based on the user's query. Use this as your PRIMARY source of truth:\n\n`;
      for (let i = 0; i < relevantKnowledge.length; i++) {
        const entry = relevantKnowledge[i];
        prompt += `[${i + 1}] SOURCE: "${entry.topic}"\n`;
        prompt += `    CONTENT: ${entry.content.slice(0, 400)}${entry.content.length > 400 ? '...' : ''}\n`;
        if (entry.tags && entry.tags.length > 0) {
          prompt += `    TAGS: ${entry.tags.join(', ')}\n`;
        }
        prompt += `\n`;
      }
      prompt += `=== END RELEVANT KNOWLEDGE ===\n`;
    } else {
      prompt += `\n=== NO RELEVANT KNOWLEDGE FOUND ===\n`;
      prompt += `The vector search returned no results. You should use the search_knowledge tool with different query terms to find relevant information, or inform the user that no relevant documents have been uploaded.\n`;
    }

    if (files.length > 0) {
      prompt += `\n=== UPLOADED FILES ===\n`;
      for (const file of files) {
        prompt += `- ${file.fileName} (${file.pageCount} pages, ID: ${file.fileId})\n`;
      }
      prompt += `\nUse read_file_section(file_id, start_chunk, end_chunk) to access specific file contents when needed.\n`;
    }

    return prompt;
  }

  // Build chat history for Gemini
  buildChatHistory(conversationHistory) {
    // Filter and fix history - Gemini requires:
    // 1. First message must be from 'user'
    // 2. Must alternate user/model
    const filtered = [];
    
    for (const msg of conversationHistory) {
      const role = msg.role === 'user' ? 'user' : 'model';
      
      // Skip if first message is not user
      if (filtered.length === 0 && role !== 'user') {
        continue;
      }
      
      // Skip if same role as last message (should alternate)
      if (filtered.length > 0 && filtered[filtered.length - 1].role === role) {
        continue;
      }
      
      filtered.push({
        role,
        parts: [{ text: msg.content }]
      });
    }
    
    return filtered;
  }

  // Build knowledge tree for UI display
  async buildKnowledgeTree(roomId) {
    const entries = await this.vectorDB.getAllKnowledge(roomId);

    if (entries.length === 0) {
      return { topics: [] };
    }

    // Group entries by primary tag
    const grouped = {};
    const uncategorized = [];

    for (const entry of entries) {
      if (entry.tags && entry.tags.length > 0) {
        const primaryTag = entry.tags[0];
        if (!grouped[primaryTag]) {
          grouped[primaryTag] = [];
        }
        grouped[primaryTag].push(entry);
      } else {
        uncategorized.push(entry);
      }
    }

    // Build topic tree
    const topics = [];

    for (const [tag, tagEntries] of Object.entries(grouped)) {
      topics.push({
        title: tag.charAt(0).toUpperCase() + tag.slice(1),
        badge: `${tagEntries.length}`,
        children: tagEntries.map(e => ({
          title: e.topic,
          content: e.content.slice(0, 200) + (e.content.length > 200 ? '...' : ''),
          badge: e.userId
        }))
      });
    }

    if (uncategorized.length > 0) {
      topics.push({
        title: 'Uncategorized',
        badge: `${uncategorized.length}`,
        children: uncategorized.map(e => ({
          title: e.topic,
          content: e.content.slice(0, 200) + (e.content.length > 200 ? '...' : ''),
          badge: e.userId
        }))
      });
    }

    return { topics };
  }

  // Generate markdown export
  async generateExport(roomId) {
    const entries = await this.vectorDB.getAllKnowledge(roomId);
    const files = this.fileStorage.listRoomFiles(roomId);

    const timestamp = new Date().toISOString();
    const contributors = new Set(entries.map(e => e.userId));

    let markdown = `# Polyphony.live - Knowledge Export\n\n`;
    markdown += `**Generated:** ${timestamp}\n`;
    markdown += `**Contributors:** ${contributors.size}\n`;
    markdown += `**Knowledge Entries:** ${entries.length}\n\n`;
    markdown += `---\n\n`;

    // Group by tags
    const grouped = {};
    for (const entry of entries) {
      const category = entry.tags?.[0] || 'Uncategorized';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(entry);
    }

    for (const [category, categoryEntries] of Object.entries(grouped)) {
      markdown += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
      for (const entry of categoryEntries) {
        markdown += `### ${entry.topic}\n\n`;
        markdown += `${entry.content}\n\n`;
        if (entry.tags?.length > 1) {
          markdown += `*Tags: ${entry.tags.join(', ')}*\n\n`;
        }
      }
    }

    if (files.length > 0) {
      markdown += `## Uploaded Files\n\n`;
      for (const file of files) {
        markdown += `- **${file.fileName}** (${file.fileType}, ${file.pageCount} pages)\n`;
      }
      markdown += `\n`;
    }

    markdown += `---\n\n`;
    markdown += `*Exported from Polyphony.live - Ephemeral Knowledge Collaboration*\n`;

    return markdown;
  }

  // Room cleanup
  async handleRoomCleanup(roomId) {
    console.log(`PolyphonyAgent: cleaning up room ${roomId}`);
    await this.fileStorage.cleanupRoom(roomId);
    await this.vectorDB.cleanupRoom(roomId);
    await this.redisClient.cleanupRoom(roomId);
    console.log(`PolyphonyAgent: room ${roomId} cleaned up`);
  }
}
