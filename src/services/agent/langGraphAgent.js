/**
 * LangGraph Agent for Polyphony
 * 
 * Architecture:
 * - The agent maintains a hierarchical understanding of the conversation
 * - The shared canvas represents the agent's "full picture" of the phenomena
 * - Users can ask questions (private) to get zoomed-in details
 * - The canvas adapts - old irrelevant info is replaced by new relevant info
 * - Information is organized by importance (most central/important first)
 */

import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryManager } from './memoryManager.js';

// Directory for temporary canvas storage
const CANVAS_STORAGE_DIR = process.env.CANVAS_STORAGE_DIR || path.join(os.tmpdir(), 'polyphony-canvases');

// Ensure storage directory exists
if (!fs.existsSync(CANVAS_STORAGE_DIR)) {
  fs.mkdirSync(CANVAS_STORAGE_DIR, { recursive: true });
}

// Model configuration
// ⚠️ DO NOT MODIFY - Model specified by user and verified from official docs
// New models release frequently, but trust the user's explicit model choice here
// See: https://ai.google.dev/gemini-api/docs/models
const MODEL_NAME = 'gemini-3-pro-preview';
const MAX_ITERATIONS = 5;

/**
 * Canvas State - Represents the agent's hierarchical understanding
 * Persists to disk for durability across user disconnects/reconnects
 */
class CanvasState {
  constructor(roomId, io) {
    this.roomId = roomId;
    this.io = io;
    this.canvas = {
      version: 0,
      lastUpdated: Date.now(),
      centralIdea: null,
      hierarchy: []
    };
    this.storagePath = path.join(CANVAS_STORAGE_DIR, `${roomId}.json`);
    
    // Try to load existing canvas from disk
    this.loadFromDisk();
  }

  /**
   * Load canvas from disk if it exists
   */
  loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf-8');
        const savedCanvas = JSON.parse(data);
        this.canvas = savedCanvas;
        console.log(`CanvasState: loaded version ${this.canvas.version} for room ${this.roomId} from disk`);
        return true;
      }
    } catch (error) {
      console.error(`CanvasState: error loading from disk for room ${this.roomId}:`, error);
    }
    return false;
  }

  /**
   * Save canvas to disk
   */
  saveToDisk() {
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify(this.canvas, null, 2));
      return true;
    } catch (error) {
      console.error(`CanvasState: error saving to disk for room ${this.roomId}:`, error);
      return false;
    }
  }

  /**
   * Delete canvas file from disk (called when room is cleaned up)
   */
  static deleteFromDisk(roomId) {
    try {
      const storagePath = path.join(CANVAS_STORAGE_DIR, `${roomId}.json`);
      if (fs.existsSync(storagePath)) {
        fs.unlinkSync(storagePath);
        console.log(`CanvasState: deleted storage for room ${roomId}`);
        return true;
      }
    } catch (error) {
      console.error(`CanvasState: error deleting from disk for room ${roomId}:`, error);
    }
    return false;
  }

  /**
   * Update the canvas with new hierarchical understanding
   */
  async update(hierarchicalData) {
    this.canvas.version++;
    this.canvas.lastUpdated = Date.now();
    
    if (hierarchicalData.centralIdea) {
      this.canvas.centralIdea = hierarchicalData.centralIdea;
    }
    
    if (hierarchicalData.hierarchy) {
      this.canvas.hierarchy = hierarchicalData.hierarchy;
    }

    // Save to disk for persistence
    this.saveToDisk();

    // Broadcast to all users
    this.io.to(this.roomId).emit('canvas:full_update', {
      canvas: this.canvas,
      timestamp: Date.now()
    });

    console.log(`CanvasState: updated to version ${this.canvas.version} for room ${this.roomId}`);
    return this.canvas;
  }

  /**
   * Get current canvas
   */
  get() {
    return this.canvas;
  }

  /**
   * Export canvas as markdown (hierarchical order)
   * Includes all content including diagrams
   */
  exportToMarkdown() {
    let md = `# ${this.canvas.centralIdea || 'Polyphony Session'}\n\n`;
    md += `*Last updated: ${new Date(this.canvas.lastUpdated).toLocaleString()}*\n\n`;
    
    for (const level1 of this.canvas.hierarchy || []) {
      md += this.exportNodeToMarkdown(level1, 2);
    }
    
    return md;
  }

  /**
   * Export a single node and its children to markdown
   */
  exportNodeToMarkdown(node, level) {
    const heading = '#'.repeat(level);
    let md = `${heading} ${node.title}\n\n`;
    
    // Export main content
    if (node.content) {
      md += `${node.content}\n\n`;
    }
    
    // Export expanded content (includes diagrams)
    if (node.expandedContent) {
      md += `${node.expandedContent}\n\n`;
    }
    
    // Export children recursively
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        md += this.exportNodeToMarkdown(child, level + 1);
      }
    }
    
    return md;
  }
}

/**
 * LangGraph Agent Implementation
 */
export class LangGraphAgent {
  constructor(redisClient, fileStorage, vectorDB, io) {
    this.redisClient = redisClient;
    this.fileStorage = fileStorage;
    this.vectorDB = vectorDB;
    this.io = io;
    
    // Room state management
    this.roomStates = new Map(); // roomId -> { canvasState, adminUserId, settings }
    
    // Initialize model
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY or GEMINI_API_KEY required');
    }

    this.model = new ChatGoogleGenerativeAI({
      model: MODEL_NAME,
      apiKey,
      temperature: 0.3, // Lower temperature for more consistent hierarchical organization
      maxOutputTokens: 8192
    });

    // Initialize the graph
    this.graph = this.buildGraph();
    
    console.log(`LangGraphAgent initialized with model: ${MODEL_NAME}`);
  }

  /**
   * Build the LangGraph state graph
   */
  buildGraph() {
    // Define the state annotation
    const StateAnnotation = Annotation.Root({
      messages: Annotation({
        reducer: (x, y) => x.concat(y),
        default: () => []
      }),
      roomId: Annotation({
        default: () => ''
      }),
      userId: Annotation({
        default: () => ''
      }),
      userName: Annotation({
        default: () => ''
      }),
      socketId: Annotation({
        default: () => ''
      }),
      iteration: Annotation({
        default: () => 0
      }),
      canvasNeedsRefresh: Annotation({
        default: () => false
      }),
      knowledgeEntries: Annotation({
        default: () => []
      }),
      finalResponse: Annotation({
        default: () => ''
      })
    });

    // Create the graph
    const workflow = new StateGraph(StateAnnotation);

    // Add nodes
    workflow.addNode('understand', this.understandNode.bind(this));
    workflow.addNode('refresh_canvas', this.refreshCanvasNode.bind(this));
    workflow.addNode('answer_question', this.answerQuestionNode.bind(this));

    // Define edges
    workflow.setEntryPoint('understand');
    
    // Conditional edges from understand
    workflow.addConditionalEdges(
      'understand',
      (state) => {
        if (state.canvasNeedsRefresh) return 'refresh_canvas';
        return 'answer_question';
      },
      {
        refresh_canvas: 'refresh_canvas',
        answer_question: 'answer_question'
      }
    );
    
    workflow.addEdge('refresh_canvas', 'answer_question');
    workflow.addEdge('answer_question', END);

    return workflow.compile();
  }

  /**
   * Understand Node: Analyze the user's message and current state
   */
  async understandNode(state) {
    const { roomId } = state;
    const messages = state.messages || [];
    
    if (!messages.length) {
      console.warn('understandNode: No messages in state');
      return {
        ...state,
        canvasNeedsRefresh: false,
        knowledgeEntries: [],
        iteration: state.iteration + 1
      };
    }
    
    // Get all knowledge entries for context
    const allKnowledge = await this.vectorDB.getAllKnowledge(roomId);
    
    // Get current canvas
    const roomState = this.roomStates.get(roomId);
    const currentCanvas = roomState?.canvasState?.get() || { hierarchy: [] };
    
    // Build understanding prompt
    const understandingPrompt = `You are analyzing the user's message to update the canvas model.

Current Canvas:
Central Idea: ${currentCanvas?.centralIdea || 'None yet'}
Current Themes: ${currentCanvas?.hierarchy?.map(h => h.title).join(', ') || 'None'}

Existing Knowledge (${allKnowledge.length} entries):
${allKnowledge.slice(0, 10).map(k => `- ${k.topic}`).join('\n')}

Your task:
1. EXTRACT the actual topic/theme from the user's message
2. Determine if canvas needs refresh

CRITICAL - Trigger refresh (NEEDS_REFRESH: true) when:
- Canvas is empty (no central idea yet)
- First user message in the conversation
- New file/document was just uploaded
- User introduces a new major topic/theme
- The current canvas doesn't capture what they're discussing

Respond:
ANALYSIS: <what the user is actually discussing>
NEEDS_REFRESH: <true/false - be proactive, refresh when there's new content to model>
EXTRACTED_THEME: <the actual subject>`;

    const lastMessage = messages[messages.length - 1];
    const messageContent = typeof lastMessage.content === 'string' 
      ? lastMessage.content 
      : lastMessage.content.toString();

    const response = await this.model.invoke([
      new SystemMessage(understandingPrompt),
      new HumanMessage(messageContent)
    ]);

    const content = response.content.toString();
    const needsRefresh = content.includes('NEEDS_REFRESH: true');
    
    return {
      ...state,
      canvasNeedsRefresh: needsRefresh,
      knowledgeEntries: allKnowledge,
      iteration: state.iteration + 1
    };
  }

  /**
   * Refresh Canvas Node: Re-ingest all data and redraw the canvas
   */
  async refreshCanvasNode(state) {
    const { roomId } = state;
    
    console.log(`LangGraphAgent: refreshing canvas for room ${roomId}`);
    
    // Get ALL data from Redis
    const allKnowledge = await this.vectorDB.getAllKnowledge(roomId);
    const files = this.fileStorage.listRoomFiles(roomId);
    const roomState = this.roomStates.get(roomId);
    
    // Build comprehensive refresh prompt
    const refreshPrompt = `You are the Polyphony Synthesis Agent. Your job is to MODEL THE ACTUAL CONVERSATION happening in this space.

ALL Knowledge Entries (${allKnowledge.length}):
${allKnowledge.map(k => `
TOPIC: ${k.topic}
CONTENT: ${k.content}
TAGS: ${(k.tags || []).join(', ')}
USER: ${k.userId}
---`).join('\n')}

Uploaded Files (${files.length}):
${files.map(f => `- ${f.fileName} (${f.pageCount} pages)`).join('\n')}

CRITICAL - EXTRACT ACTUAL THEMES FROM THE CONTENT:
- If users talk about "meaning of life" → Central Idea: "The Meaning of Life"
- If they discuss philosophy → Themes: "Philosophical Perspectives", "Existentialism", "Ethics"
- If they mention happiness → Sub-theme: "Happiness vs Meaning"

NEVER create meta-categories like:
- "Hierarchical Structuring"
- "Knowledge Organization" 
- "Information Architecture"

Your task - Create a CANVAS that MODELS THE ACTUAL DISCUSSION:

1. Identify the CENTRAL IDEA from what users are actually discussing
2. Extract REAL THEMES from their messages (not generic templates)
3. DETECT CROSS-DOCUMENT CONNECTIONS:
   - Look for CONFLICTS between different sources (e.g., PM requires X but Dev says Y is impossible)
   - Look for DEPENDENCIES between documents (e.g., implementation requires both A and B)
   - Look for ALIGNMENTS where sources agree or support each other
4. Organize by IMPORTANCE to the central topic using THIS SPECIFIC SCORING:
   - Level 1 (importance 10): Cross-document conflicts, tensions, or critical trade-offs - THESE ARE THE MOST VALUABLE
   - Level 1 (importance 9): Cross-document synthesis or key alignments between sources
   - Level 1 (importance 8): Major single-document insights with specific numbers/requirements
   - Level 2 (importance 5-7): Supporting concepts from individual sources
   - Level 3 (importance 3-4): Specific details and examples
5. PRUNE off-topic or outdated info
6. SYNTHESIZE across sources - connect the dots between different documents

WHEN YOU IDENTIFY A CONFLICT (e.g., "PRD requires 5-min updates" vs "API doc shows 84.7% capacity"):
- Create a specific node titled something like "Conflict: X vs Y"
- Give it importance: 10
- Include specific details from BOTH sources
- This is MORE important than individual document summaries

Respond in this JSON format:
{
  "centralIdea": "The actual topic users are discussing",
  "hierarchy": [
    {
      "title": "Actual Theme from Conversation",
      "content": "What this theme means in context",
      "importance": 10,
      "children": [
        {
          "title": "Related Sub-theme",
          "content": "Explanation",
          "importance": 7
        }
      ]
    }
  ]
}

IMPORTANCE SCORING GUIDE:
- 10: Critical cross-document conflict or tension (highest priority)
- 9: Cross-document synthesis or significant alignment
- 8: Key single-document insight with specific numbers/requirements
- 5-7: Supporting concepts
- 3-4: Background details
- 1-2: Minor points`;

    const response = await this.model.invoke([
      new SystemMessage(refreshPrompt),
      new HumanMessage('Please refresh the canvas based on all available information.')
    ]);

    // Parse the JSON response
    let canvasData;
    try {
      const content = response.content.toString();
      // Extract JSON from potential markdown code blocks
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || 
                       content.match(/```\s*([\s\S]*?)```/) ||
                       [null, content];
      canvasData = JSON.parse(jsonMatch[1] || content);
    } catch (e) {
      console.error('Failed to parse canvas refresh response:', e);
      // Fallback: create a simple structure
      canvasData = {
        centralIdea: 'Discussion Summary',
        hierarchy: [{
          title: 'Key Points',
          content: response.content.toString().slice(0, 500),
          importance: 5,
          children: []
        }]
      };
    }

    // Update the canvas
    if (roomState?.canvasState) {
      await roomState.canvasState.update(canvasData);
    }

    return {
      ...state,
      canvasData
    };
  }

  /**
   * Detect synthesis questions that need multi-query retrieval
   */
  detectSynthesisPattern(query) {
    const patterns = [
      {
        keywords: ['conflict', 'tension', 'disagree', 'opposing', 'clash', 'mismatch'],
        queries: ['PM requirements priorities', 'developer constraints limitations', 'stakeholder priorities', 'technical constraints'],
        name: 'conflict_detection'
      },
      {
        keywords: ['compare', 'comparison', 'difference', 'differences', 'vs', 'versus', 'contrast'],
        queries: ['PM perspective view', 'developer perspective view', 'different approaches'],
        name: 'comparison'
      },
      {
        keywords: ['budget', 'cost', 'price', 'financial', 'funding', 'expense'],
        queries: ['budget cost financial', 'expense pricing cost', 'funding allocation'],
        name: 'budget_analysis'
      },
      {
        keywords: ['timeline', 'deadline', 'schedule', 'milestone', 'date', 'delivery'],
        queries: ['timeline deadline date', 'schedule milestone delivery', 'release date'],
        name: 'timeline_analysis'
      },
      {
        keywords: ['priority', 'priorities', 'requirement', 'requirements', 'P0', 'critical'],
        queries: ['priorities requirements', 'critical requirements', 'must have'],
        name: 'priorities'
      },
      {
        keywords: ['constraint', 'constraints', 'limitation', 'limitations', 'blocker', 'blocking'],
        queries: ['constraints limitations', 'technical constraints', 'blocking issues'],
        name: 'constraints'
      },
      {
        keywords: ['both', 'either', 'impact', 'affect', 'relationship', 'connection'],
        queries: ['cross-functional impact', 'stakeholder impact', 'dependencies'],
        name: 'cross_cutting'
      }
    ];
    
    const queryLower = query.toLowerCase();
    
    for (const pattern of patterns) {
      if (pattern.keywords.some(kw => queryLower.includes(kw))) {
        return pattern;
      }
    }
    
    return null;
  }

  /**
   * Perform multi-query retrieval for synthesis questions
   */
  async performMultiQueryRetrieval(roomId, query, pattern) {
    console.log(`LangGraphAgent: Using multi-query retrieval for ${pattern.name}: "${query.slice(0, 50)}..."`);
    
    const allResults = [];
    const seenIds = new Set();
    
    // Execute multiple targeted queries
    for (const subQuery of pattern.queries) {
      const results = await this.vectorDB.searchKnowledge(roomId, subQuery, 6);
      
      for (const result of results) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          allResults.push(result);
        }
      }
    }
    
    // Also do a general query to catch anything missed
    const generalResults = await this.vectorDB.searchKnowledge(roomId, query, 6);
    for (const result of generalResults) {
      if (!seenIds.has(result.id)) {
        seenIds.add(result.id);
        allResults.push(result);
      }
    }
    
    // Sort by score and take top results
    allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
    const finalResults = allResults.slice(0, 12);
    
    console.log(`LangGraphAgent: Multi-query retrieval found ${finalResults.length} unique results`);
    return finalResults;
  }

  /**
   * Answer Question Node: Generate response to user question
   */
  async answerQuestionNode(state) {
    const { roomId, knowledgeEntries, canvasData } = state;
    const messages = state.messages || [];
    
    // Get current canvas
    const roomState = this.roomStates.get(roomId);
    const currentCanvas = roomState?.canvasState?.get() || canvasData;
    
    // Get query from last message
    const lastMessage = messages[messages.length - 1];
    const query = lastMessage?.content 
      ? (typeof lastMessage.content === 'string' ? lastMessage.content : lastMessage.content.toString())
      : '';
    
    // Detect synthesis patterns and use multi-query retrieval if needed
    const synthesisPattern = this.detectSynthesisPattern(query);
    let relevantKnowledge;
    
    if (synthesisPattern) {
      // Use multi-query retrieval for synthesis questions
      relevantKnowledge = await this.performMultiQueryRetrieval(roomId, query, synthesisPattern);
    } else {
      // Standard single-query retrieval
      relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, query, 5);
    }
    
    // Build answer prompt with explicit grounding instructions
    const answerPrompt = `You are the Polyphony Agent - a synthesis agent that helps users explore complex topics by grounding responses in the uploaded documents.

CRITICAL INSTRUCTIONS - YOUR RESPONSES MUST BE GROUNDED:
1. You MUST only reference specific facts, numbers, dates, requirements, and details from the RELEVANT KNOWLEDGE provided below
2. NEVER produce generalized knowledge, platitudes, or training data (e.g., NEVER say "PMs often prioritize speed" - instead cite the specific requirement from the documents)
3. Every claim must be traceable to a specific source with specific evidence
4. ALWAYS cite your sources: mention document names, requirement IDs, and specific data points (e.g., "According to the PRD (FR-1), score updates must happen within 5 minutes")
5. If you cannot find relevant information in the provided context, say "I don't have specific information about that in the uploaded documents" - DO NOT hallucinate
6. When asked about conflicts, comparisons, or relationships between sources, ensure you cite evidence from ALL relevant perspectives
7. Prefer specific numbers and requirements over general descriptions

CURRENT CANVAS (Your evolving understanding of THIS conversation):
Central Topic: ${currentCanvas?.centralIdea || 'Not yet established - waiting for user input'}

Current Structure:
${JSON.stringify(currentCanvas?.hierarchy || [], null, 2)}

=== RELEVANT KNOWLEDGE (YOUR PRIMARY SOURCE OF TRUTH) ===
${relevantKnowledge.map((k, i) => `
[${i + 1}] SOURCE: "${k.topic}"
    CONTENT: ${k.content.slice(0, 400)}${k.content.length > 400 ? '...' : ''}
    ${k.tags ? `TAGS: ${k.tags.join(', ')}` : ''}
`).join('\n')}
=== END RELEVANT KNOWLEDGE ===

AVAILABLE TOOLS:
- contribute(type, title, content, importance, tags): Add insights to the collective understanding. This updates BOTH the canvas AND knowledge base automatically. Use for synthesis, insights, and key findings.
- refresh_canvas(reason): Rebuild the entire canvas when topic shifts significantly.
- mermaid_visualize(mermaid_code): Create a Mermaid diagram and display it on the shared canvas. Use for flowcharts, sequence diagrams, mind maps, or any visual representation.

WHEN TO USE contribute:
- When you have a clear insight or concept to share
- When you identify cross-document connections, conflicts, or synthesis opportunities
- When explaining an important concept grounded in the documents
- When the user asks about conflicts, priorities, or comparisons

WHEN TO USE mermaid_visualize:
- When the user asks for a diagram, flowchart, or visual representation
- When explaining complex relationships or processes found in the documents
- When visualizing conflicts or dependencies between different stakeholder requirements

MERMAID EXAMPLES:
- Flowchart: \`\`\`mermaid\ngraph TD;\n  A[Start] --> B{Decision};\n  B -->|Yes| C[Action];\n  B -->|No| D[End];\n\`\`\`
- Sequence: \`\`\`mermaid\nsequenceDiagram;\n  participant A;\n  participant B;\n  A->>B: Message;\n\`\`\`

EXAMPLES of good contribute calls:
- contribute("insight", "PM vs Dev Priority Conflict", "PRD requires 5-min updates (FR-1) but API doc shows 84.7% capacity utilization...", 10, ["conflict", "PM", "developer", "priority"])
- contribute("synthesis", "Budget Tension Analysis", "PM budgets $180K but dev flags $25-100K additional API costs...", 9, ["budget", "conflict", "cost"])

ADDITIONAL INSTRUCTIONS:
1. The canvas represents YOUR UNDERSTANDING of what users are discussing - NOT a generic template
2. Extract actual themes from the documents (requirements, constraints, priorities)
3. Cross-document conflicts and connections are the MOST valuable insights - prioritize these
4. USE the contribute tool liberally for synthesis insights, especially when conflicts are identified
5. Be conversational but always grounded in the specific document content provided above`;

    // Convert messages to proper format
    const messageHistory = messages.slice(-5).map(m => {
      const content = typeof m.content === 'string' ? m.content : m.content.toString();
      return m instanceof HumanMessage ? new HumanMessage(content) : new AIMessage(content);
    });

    const response = await this.model.invoke([
      new SystemMessage(answerPrompt),
      ...messageHistory
    ]);

    let finalResponse = response.content.toString();

    // Execute any tool calls in the response
    const toolResults = await this.executeToolCalls(finalResponse, state);
    
    // If tools were executed, include results in response
    if (toolResults.length > 0) {
      finalResponse += '\n\n[Tools executed: ' + toolResults.map(r => r.tool).join(', ') + ']';
    }

    return {
      ...state,
      finalResponse,
      toolResults
    };
  }

  /**
   * Register a room
   */
  registerRoom(roomId, adminUserId, metadata = {}) {
    const canvasState = new CanvasState(roomId, this.io);
    
    // Initialize memory manager for this room
    const memoryManager = new MemoryManager(roomId, this.model, this.io);
    
    this.roomStates.set(roomId, {
      ...metadata,
      adminUserId,
      createdAt: Date.now(),
      settings: {
        groupChatEnabled: false
      },
      canvasState,
      memoryManager
    });

    console.log(`LangGraphAgent: room registered ${roomId}, admin: ${adminUserId}`);
  }

  /**
   * Unregister a room
   */
  unregisterRoom(roomId) {
    this.roomStates.delete(roomId);
    console.log(`LangGraphAgent: room unregistered ${roomId}`);
  }

  /**
   * Get room state
   */
  getRoomState(roomId) {
    const state = this.roomStates.get(roomId);
    if (!state) return null;
    
    return {
      settings: state.settings,
      canvas: state.canvasState?.get() || []
    };
  }

  /**
   * Check if user is admin
   */
  isAdmin(roomId, userId) {
    const room = this.roomStates.get(roomId);
    return room && room.adminUserId === userId;
  }

  /**
   * Set group chat
   */
  setGroupChat(roomId, userId, enabled) {
    const room = this.roomStates.get(roomId);
    if (!room) return { error: 'Room not found' };
    if (room.adminUserId !== userId) return { error: 'Only admin can change settings' };

    room.settings.groupChatEnabled = enabled;
    console.log(`LangGraphAgent: room ${roomId} groupChat=${enabled}`);
    return { success: true, groupChatEnabled: enabled };
  }

  /**
   * Handle incoming message
   */
  async handleMessage(roomId, userId, userName, socketId, content, conversationHistory = []) {
    try {
      // Get room state
      const roomState = this.roomStates.get(roomId);
      const memoryManager = roomState?.memoryManager;
      
      // Create knowledge entry from user's message
      const knowledgeEntry = await this.vectorDB.createKnowledgeEntry(
        roomId,
        userId,
        `User: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
        content,
        ['user-input'],
        []
      );
      
      // Also add to memory manager
      if (memoryManager) {
        await memoryManager.addEntry({
          userId,
          userName,
          topic: `User Input: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
          content,
          tags: ['user-input', 'message'],
          type: 'knowledge',
          importance: 5
        });
      }

      // Build message history
      const messages = [
        ...conversationHistory.map(msg => 
          msg.role === 'user' 
            ? new HumanMessage(msg.content)
            : new AIMessage(msg.content)
        ),
        new HumanMessage(content)
      ];

      // Run the graph
      const result = await this.graph.invoke({
        messages,
        roomId,
        userId,
        userName,
        socketId,
        iteration: 0,
        canvasNeedsRefresh: false,
        knowledgeEntries: []
      });

      // Get updated canvas for UI
      const knowledgeUpdate = this.buildKnowledgeTreeFromCanvas(
        roomState?.canvasState?.get()
      );

      return {
        content: result.finalResponse || 'I processed your message.',
        knowledgeUpdate
      };
    } catch (error) {
      console.error('LangGraphAgent error:', error);
      return {
        content: `I encountered an error: ${error.message}`,
        knowledgeUpdate: null
      };
    }
  }

  /**
   * Execute tool calls found in the model's response
   * Parses tool calls in format: tool_name({ json_args })
   */
  async executeToolCalls(response, state) {
    const { roomId, userId, userName, socketId } = state;
    const results = [];
    
    // Find tool calls in the response
    // Match patterns like: contribute({ ... }) or mermaid_visualize({ ... })
    const toolCallRegex = /(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
    let match;
    
    while ((match = toolCallRegex.exec(response)) !== null) {
      const toolName = match[1];
      const argsJson = match[2];
      
      // Only process known tools
      if (!['contribute', 'refresh_canvas', 'mermaid_visualize'].includes(toolName)) {
        continue;
      }
      
      try {
        const args = JSON.parse(argsJson);
        
        console.log(`LangGraphAgent: executing tool ${toolName} with args:`, args);
        
        switch (toolName) {
          case 'contribute':
            await this.executeContributeTool(args, { roomId, userId, userName, socketId });
            results.push({ tool: toolName, success: true });
            break;
            
          case 'refresh_canvas':
            await this.queueCanvasRefresh(roomId);
            results.push({ tool: toolName, success: true });
            break;
            
          case 'mermaid_visualize':
            await this.executeMermaidTool(args, { roomId, userId, userName, socketId });
            results.push({ tool: toolName, success: true });
            break;
        }
      } catch (error) {
        console.error(`LangGraphAgent: tool ${toolName} failed:`, error);
        results.push({ tool: toolName, success: false, error: error.message });
      }
    }
    
    return results;
  }
  
  /**
   * Detect if a contribution should be enriched with retrieved context
   */
  shouldEnrichContribution(type, title, tags) {
    const enrichmentKeywords = ['synthesis', 'insight', 'conflict', 'comparison', 'summary'];
    const titleLower = title.toLowerCase();
    const typeLower = type.toLowerCase();
    const tagsLower = tags.map(t => t.toLowerCase());
    
    return enrichmentKeywords.some(kw => 
      titleLower.includes(kw) || 
      typeLower.includes(kw) ||
      tagsLower.some(t => t.includes(kw))
    );
  }

  /**
   * Execute contribute tool - adds to canvas, knowledge base, and memory
   * Now with retrieval enrichment for synthesis-type contributions
   */
  async executeContributeTool(args, context) {
    const { roomId, userId, userName } = context;
    const { type, title, content, importance = 5, tags = [] } = args;
    
    if (!type || !title || !content) {
      throw new Error('contribute requires type, title, and content');
    }
    
    let enhancedContent = content;
    let sources = [];
    
    // NEW: Retrieve relevant knowledge to enrich synthesis contributions
    if (this.shouldEnrichContribution(type, title, tags)) {
      console.log(`LangGraphAgent: Enriching contribution "${title}" with retrieved context`);
      
      try {
        // Retrieve relevant knowledge for this topic
        const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, title, 8);
        
        if (relevantKnowledge.length > 0) {
          sources = relevantKnowledge.map(k => k.topic);
          
          // Enhance content with retrieved context
          const enrichmentPrompt = `Enhance the following contribution with specific details from the retrieved sources.

ORIGINAL CONTRIBUTION:
Title: ${title}
Type: ${type}
Content: ${content}

RETRIEVED SOURCES (use these to add specific facts, numbers, and citations):
${relevantKnowledge.map((k, i) => `
[${i + 1}] ${k.topic}:
${k.content.slice(0, 500)}${k.content.length > 500 ? '...' : ''}
`).join('\n')}

INSTRUCTIONS:
1. Keep the original insights but enhance with specific facts, numbers, and details from the retrieved sources
2. Cite specific sources when mentioning facts (e.g., "According to [source name]...")
3. Identify any conflicts or connections between different sources
4. If sources contain numbers, dates, or requirements, include them explicitly
5. Maintain the original structure and purpose of the contribution

Output the enhanced content only:`;

          const response = await this.model.invoke([
            new SystemMessage(enrichmentPrompt)
          ]);
          
          enhancedContent = response.content.toString();
          console.log(`LangGraphAgent: Enriched contribution with ${relevantKnowledge.length} sources`);
        }
      } catch (error) {
        console.warn(`LangGraphAgent: Failed to enrich contribution "${title}":`, error.message);
        // Fall back to original content
        enhancedContent = content;
      }
    }
    
    // Add to knowledge base with enhanced content
    await this.vectorDB.createKnowledgeEntry(
      roomId,
      userId,
      title,
      enhancedContent,
      [...tags, type, 'contribution'],
      []
    );
    
    // Add to memory manager
    const roomState = this.roomStates.get(roomId);
    if (roomState?.memoryManager) {
      await roomState.memoryManager.addEntry({
        userId,
        userName,
        topic: title,
        content: enhancedContent,
        tags: [...tags, type, 'contribution'],
        type: 'contribution',
        importance
      });
    }
    
    // Add to canvas via socket
    const contribution = {
      id: `contrib-${Date.now()}`,
      type,
      title,
      content: enhancedContent,
      importance,
      userName: userName || 'Agent',
      timestamp: Date.now(),
      tags,
      sources: sources.length > 0 ? sources : undefined
    };
    
    this.io.to(roomId).emit('canvas:update', { contribution });
    console.log(`LangGraphAgent: contributed "${title}" to canvas and memory${sources.length > 0 ? ` (enriched with ${sources.length} sources)` : ''}`);
  }
  
  /**
   * Execute mermaid visualize tool - posts diagram to canvas and memory
   */
  async executeMermaidTool(args, context) {
    const { roomId, userId, userName } = context;
    const { mermaid_code } = args;
    
    if (!mermaid_code) {
      throw new Error('mermaid_visualize requires mermaid_code');
    }
    
    // Ensure mermaid code has the ```mermaid wrapper
    let formattedCode = mermaid_code.trim();
    if (!formattedCode.startsWith('```mermaid')) {
      formattedCode = '```mermaid\n' + formattedCode + '\n```';
    }
    
    // Add to memory manager
    const roomState = this.roomStates.get(roomId);
    if (roomState?.memoryManager) {
      await roomState.memoryManager.addEntry({
        userId,
        userName,
        topic: 'Mermaid Diagram',
        content: formattedCode,
        tags: ['diagram', 'mermaid'],
        type: 'diagram',
        importance: 7
      });
    }
    
    // Add to canvas via socket
    const contribution = {
      id: `diagram-${Date.now()}`,
      type: 'DIAGRAM',
      title: 'Mermaid Diagram',
      content: formattedCode,
      importance: 7,
      userName: userName || 'Agent',
      timestamp: Date.now(),
      tags: ['diagram', 'mermaid']
    };
    
    this.io.to(roomId).emit('canvas:update', { contribution });
    console.log(`LangGraphAgent: posted mermaid diagram to canvas and memory`);
  }

  /**
   * Build knowledge tree from canvas for UI
   */
  buildKnowledgeTreeFromCanvas(canvas) {
    if (!canvas || !canvas.hierarchy) {
      return { topics: [] };
    }

    const topics = canvas.hierarchy.map(level1 => ({
      title: level1.title,
      badge: `${level1.importance || 5}/10`,
      content: level1.content,
      children: (level1.children || []).map(level2 => ({
        title: level2.title,
        content: level2.content,
        badge: `${level2.importance || 5}/10`,
        children: (level2.children || []).map(level3 => ({
          title: level3.title,
          content: level3.content,
          badge: `${level3.importance || 5}/10`
        }))
      }))
    }));

    return { topics };
  }

  /**
   * Handle file upload with semantic chunking
   */
  async handleFileUpload(roomId, userId, socketId, fileName, fileType, content) {
    try {
      // Save file
      const fileInfo = await this.fileStorage.saveFile(roomId, fileName, fileType, content);
      
      // Get chunks
      const chunks = this.fileStorage.getAllChunks(roomId).filter(c => c.fileId === fileInfo.fileId);
      
      // Sample chunks for LLM analysis
      const sampleChunks = chunks.slice(0, Math.min(5, chunks.length));
      const sampleContent = sampleChunks.map(c => c.content).join('\n\n---\n\n');
      
      // Use LLM to extract semantic topics
      const topicExtractionPrompt = `Extract key topics/concepts from this document excerpt:

DOCUMENT: ${fileName}

CONTENT:
${sampleContent.slice(0, 3000)}

Extract 3-7 main topics/concepts. For each:
1. Give it a clear, descriptive title (NOT "Part 1" - actual topic name)
2. Write a brief summary of what this section covers

Respond as JSON:
[
  {"title": "Actual Topic Name", "summary": "Brief description of content"},
  ...
]`;

      let extractedTopics = [];
      try {
        const topicResponse = await this.model.invoke([
          new SystemMessage(topicExtractionPrompt)
        ]);
        
        const topicContent = topicResponse.content.toString();
        const jsonMatch = topicContent.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          extractedTopics = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.warn('Topic extraction failed, using fallback:', e.message);
      }

      // Create knowledge entries with semantic topics
      const entriesToCreate = extractedTopics.length > 0 
        ? extractedTopics.slice(0, Math.min(7, extractedTopics.length))
        : chunks.slice(0, 5).map((c, i) => ({
            title: `${fileName} - Section ${i + 1}`,
            summary: c.content.slice(0, 200)
          }));

      // Get room state for memory manager
      const roomState = this.roomStates.get(roomId);
      
      for (let i = 0; i < entriesToCreate.length; i++) {
        const topic = entriesToCreate[i];
        const chunkContent = chunks[i]?.content || topic.summary;
        
        await this.vectorDB.createKnowledgeEntry(
          roomId,
          userId,
          topic.title,
          chunkContent,
          ['file-upload', fileType.slice(1), 'extracted-topic'],
          [],
          { sourceMetadata: { fileName, topic: topic.title } }
        );
        
        // Also add to memory manager
        if (roomState?.memoryManager) {
          await roomState.memoryManager.addEntry({
            userId,
            userName: 'System',
            topic: topic.title,
            content: chunkContent,
            tags: ['file-upload', fileType.slice(1), 'extracted-topic'],
            type: 'knowledge',
            importance: 6,
            sourceMetadata: { fileName }
          });
        }
      }

      // Trigger canvas refresh
      if (roomState?.canvasState) {
        this.queueCanvasRefresh(roomId);
      }

      const topicList = extractedTopics.map(t => t.title).join(', ');
      
      return {
        fileInfo: {
          ...fileInfo,
          extractedTopics: extractedTopics.map(t => t.title)
        },
        agentSummary: `File "${fileName}" processed. I extracted these topics: ${topicList || 'key sections'}. The canvas will update shortly.`,
        knowledgeUpdate: this.buildKnowledgeTreeFromCanvas(roomState?.canvasState?.get())
      };
    } catch (error) {
      console.error('LangGraphAgent: error in handleFileUpload:', error);
      throw error;
    }
  }

  /**
   * Queue a canvas refresh
   */
  async queueCanvasRefresh(roomId) {
    // Debounce refreshes
    const roomState = this.roomStates.get(roomId);
    if (!roomState) return;

    if (roomState.refreshTimeout) {
      clearTimeout(roomState.refreshTimeout);
    }

    roomState.refreshTimeout = setTimeout(async () => {
      try {
        await this.graph.invoke({
          messages: [new HumanMessage('Please refresh the canvas')],
          roomId,
          userId: 'system',
          userName: 'System',
          socketId: null,
          iteration: 0,
          canvasNeedsRefresh: true,
          knowledgeEntries: []
        });
      } catch (error) {
        console.error('Canvas refresh error:', error);
      }
    }, 2000); // Wait 2 seconds after last activity
  }

  /**
   * Generate comprehensive export of ALL memory
   */
  async generateExport(roomId) {
    const roomState = this.roomStates.get(roomId);
    if (!roomState) {
      return '# No room data available';
    }

    let md = `# Polyphony Session Export\n\n`;
    md += `*Room: ${roomId}*\n`;
    md += `*Exported: ${new Date().toLocaleString()}*\n\n`;
    
    // Add comprehensive memory export if available
    if (roomState.memoryManager) {
      md += roomState.memoryManager.exportToMarkdown();
    } else if (roomState.canvasState) {
      // Fallback to canvas-only export
      md += roomState.canvasState.exportToMarkdown();
    } else {
      md += '# No data available';
    }
    
    return md;
  }

  /**
   * Handle topic expansion (when user clicks on canvas item)
   */
  async handleTopicExpansion(roomId, userId, userName, socketId, topicPath, topicTitle, topicContent) {
    try {
      console.log(`LangGraphAgent: expanding topic "${topicTitle}" for room ${roomId}`);

      // Get current canvas for context
      const roomState = this.roomStates.get(roomId);
      const currentCanvas = roomState?.canvasState?.get();

      // Get relevant knowledge about this topic (increased limit for better coverage)
      const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, topicTitle, 8);

      // Build expansion prompt
      const expansionPrompt = `You are expanding on a specific topic from the canvas.

CANVAS CONTEXT:
Central Idea: ${currentCanvas?.centralIdea || 'Not established'}

Topic to Expand: "${topicTitle}"
Current Content: ${topicContent || 'No content yet'}
Topic Path: ${topicPath.join(' > ')}

Relevant Knowledge:
${relevantKnowledge.map(k => `- ${k.topic}: ${k.content.slice(0, 300)}...`).join('\n')}

Your task:
1. Provide a detailed exploration of "${topicTitle}"
2. Identify 3-5 sub-topics or key aspects
3. Explain relationships, implications, and nuance
4. Be conversational but informative

Respond with:
1. A rich explanation of the topic
2. Suggested sub-topics that could be added to the canvas`;

      const response = await this.model.invoke([
        new SystemMessage(expansionPrompt),
        new HumanMessage(`Please expand on "${topicTitle}".`)
      ]);

      const expansionContent = response.content.toString();

      // Generate sub-topics structure
      const subTopicsMatch = expansionContent.match(/Sub-topics?:?\s*([\s\S]*?)(?:\n\n|$)/i);
      const subTopics = subTopicsMatch 
        ? subTopicsMatch[1].split(/\n- |\n\d+\. /).filter(s => s.trim())
        : [];

      // Build expansion object
      const expansion = {
        title: topicTitle,
        expandedContent: expansionContent,
        subTopics: subTopics.slice(0, 5).map((st, i) => ({
          title: st.trim().replace(/^[\d\-\*]\.?\s*/, ''),
          content: '',
          importance: 5
        }))
      };

      // Update the canvas with expansion
      if (roomState?.canvasState) {
        await this.addExpansionToCanvas(roomId, topicPath, expansion);
      }

      return {
        content: expansionContent,
        expansion
      };
    } catch (error) {
      console.error('LangGraphAgent: error in handleTopicExpansion:', error);
      return {
        content: `I encountered an error expanding this topic: ${error.message}`,
        expansion: null
      };
    }
  }

  /**
   * Add expansion to canvas
   */
  async addExpansionToCanvas(roomId, topicPath, expansion) {
    const roomState = this.roomStates.get(roomId);
    if (!roomState?.canvasState) return;

    const canvas = roomState.canvasState.get();
    
    // Navigate to the topic and add children
    let current = canvas.hierarchy;
    let target = null;

    // Find the target node
    for (let i = 0; i < topicPath.length; i++) {
      const index = topicPath[i];
      if (i === topicPath.length - 1) {
        target = current[index];
      } else {
        current = current[index]?.children || [];
      }
    }

    if (target) {
      // Add expanded content and sub-topics
      target.expandedContent = expansion.expandedContent;
      if (!target.children) target.children = [];
      
      // Add new sub-topics
      for (const subTopic of expansion.subTopics) {
        if (!target.children.find(c => c.title === subTopic.title)) {
          target.children.push(subTopic);
        }
      }

      // Update canvas
      await roomState.canvasState.update({
        centralIdea: canvas.centralIdea,
        hierarchy: canvas.hierarchy
      });
    }
  }

  /**
   * Handle diagram generation request for a specific topic
   */
  async handleDiagramGeneration(roomId, userId, userName, socketId, topicPath, topicTitle, topicContent) {
    try {
      console.log(`LangGraphAgent: generating diagram for "${topicTitle}" in room ${roomId}`);

      // Get current canvas for context
      const roomState = this.roomStates.get(roomId);
      const currentCanvas = roomState?.canvasState?.get();

      // Get relevant knowledge about this topic (increased limit for better diagram content)
      const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, topicTitle, 8);

      // Build diagram generation prompt
      // Limit content length to avoid overwhelming the LLM
      const truncatedContent = topicContent ? topicContent.slice(0, 1000) : 'No content yet';
      
      const diagramPrompt = `You are creating a Mermaid diagram to visualize the topic: "${topicTitle}".

CRITICAL: You MUST output valid Mermaid syntax that can be rendered by the Mermaid library.

Topic: ${topicTitle}
Content Summary: ${truncatedContent}

Valid Mermaid diagram types and their CORRECT syntax:

1. FLOWCHART (graph TD):
\`\`\`mermaid
graph TD;
  A[Start] --> B{Decision};
  B -->|Yes| C[Action 1];
  B -->|No| D[Action 2];
  C --> E[End];
  D --> E;
\`\`\`

2. MINDMAP:
\`\`\`mermaid
mindmap
  root((Central Topic))
    Subtopic1
      Detail A
      Detail B
    Subtopic2
      Detail C
\`\`\`

3. SEQUENCE DIAGRAM:
\`\`\`mermaid
sequenceDiagram
  participant A as User
  participant B as System
  A->>B: Request
  B-->>A: Response
\`\`\`

4. CLASS DIAGRAM:
\`\`\`mermaid
classDiagram
  class ClassA {
    +attribute
    +method()
  }
  class ClassB
  ClassA --> ClassB
\`\`\`

RULES:
- Use proper Mermaid keywords: graph TD, mindmap, sequenceDiagram, classDiagram, stateDiagram, erDiagram, pie, gantt
- Use arrows: --> for flowcharts, ->> for sequence diagrams
- Use brackets: [] for rectangles, {} for diamonds, () for circles
- DO NOT output indented text lists - those are NOT valid Mermaid
- Always wrap in \`\`\`mermaid code blocks
- Keep it simple: 5-12 elements maximum

Your task:
1. Analyze the topic and content
2. Choose ONE appropriate diagram type
3. Create a valid Mermaid diagram using the exact syntax shown above
4. Output ONLY the code block with the diagram

Now create a Mermaid diagram for: "${topicTitle}"`;

      const response = await this.model.invoke([
        new SystemMessage(diagramPrompt),
        new HumanMessage(`Please create a diagram for "${topicTitle}".`)
      ]);

      let responseContent = response.content.toString();

      // Extract mermaid code from response
      const mermaidMatch = responseContent.match(/```mermaid\s*\n?([\s\S]*?)```/);
      let diagramCode = '';
      let mermaidBody = '';
      
      if (mermaidMatch) {
        diagramCode = mermaidMatch[0]; // Include the full code block
        mermaidBody = mermaidMatch[1].trim();
      } else {
        // If no code block found, wrap the whole response
        mermaidBody = responseContent.trim();
        diagramCode = '```mermaid\n' + mermaidBody + '\n```';
      }

      // Validate that it looks like valid Mermaid (not just indented text)
      const validMermaidPatterns = [
        /^\s*(graph\s+(TD|TB|BT|RL|LR)|mindmap|sequenceDiagram|classDiagram|stateDiagram|erDiagram|pie|gantt|journey|flowchart\s+(TD|TB|BT|RL|LR))/im,
        /\[.+\]/,  // Has bracket syntax like [Node]
        /-->/,     // Has arrows
        /\{.+\}/,  // Has curly braces
        /\(.+\)/   // Has parentheses
      ];
      
      const looksLikeMermaid = validMermaidPatterns.some(pattern => pattern.test(mermaidBody));
      
      if (!looksLikeMermaid) {
        // The LLM generated indented text instead of mermaid - retry with stronger prompt
        console.warn(`LangGraphAgent: Invalid mermaid detected for "${topicTitle}", retrying...`);
        
        const retryPrompt = `The previous attempt did not produce valid Mermaid syntax.

You MUST use proper Mermaid syntax. Here is a valid mindmap example for "${topicTitle}":

\`\`\`mermaid
mindmap
  root((${topicTitle}))
    KeyAspect1
      Detail1A
      Detail1B
    KeyAspect2
      Detail2A
    KeyAspect3
\`\`\`

Or use a flowchart:

\`\`\`mermaid
graph TD;
  A[${topicTitle}] --> B[Aspect 1];
  A --> C[Aspect 2];
  A --> D[Aspect 3];
  B --> E[Detail 1];
  C --> F[Detail 2];
\`\`\`

Output ONLY the valid mermaid code block:`;

        const retryResponse = await this.model.invoke([
          new SystemMessage(retryPrompt)
        ]);
        
        const retryContent = retryResponse.content.toString();
        const retryMatch = retryContent.match(/```mermaid\s*\n?([\s\S]*?)```/);
        
        if (retryMatch) {
          diagramCode = retryMatch[0];
          mermaidBody = retryMatch[1].trim();
        }
      }

      // Add diagram to the canvas node
      await this.addDiagramToCanvas(roomId, topicPath, diagramCode);
      
      // Also add to memory manager
      if (roomState?.memoryManager) {
        await roomState.memoryManager.addEntry({
          userId,
          userName,
          topic: `Diagram: ${topicTitle}`,
          content: diagramCode,
          tags: ['diagram', 'mermaid', 'topic-diagram'],
          type: 'diagram',
          importance: 7
        });
      }

      return {
        content: `I've created a diagram for "${topicTitle}". You can see it in the canvas above!`,
        diagram: diagramCode
      };
    } catch (error) {
      console.error('LangGraphAgent: error in handleDiagramGeneration:', error);
      return {
        content: `I encountered an error creating the diagram: ${error.message}`,
        diagram: null
      };
    }
  }

  /**
   * Add diagram to a specific canvas node
   */
  async addDiagramToCanvas(roomId, topicPath, diagramCode) {
    const roomState = this.roomStates.get(roomId);
    if (!roomState?.canvasState) return;

    const canvas = roomState.canvasState.get();
    
    // Navigate to the topic
    let current = canvas.hierarchy;
    let target = null;

    for (let i = 0; i < topicPath.length; i++) {
      const index = topicPath[i];
      if (i === topicPath.length - 1) {
        target = current[index];
      } else {
        current = current[index]?.children || [];
      }
    }

    if (target) {
      // Add diagram to expanded content
      if (!target.expandedContent) {
        target.expandedContent = '';
      }
      target.expandedContent += '\n\n' + diagramCode;

      // Update canvas
      await roomState.canvasState.update({
        centralIdea: canvas.centralIdea,
        hierarchy: canvas.hierarchy
      });
    }
  }

  /**
   * Room cleanup
   */
  async handleRoomCleanup(roomId) {
    console.log(`LangGraphAgent: cleaning up room ${roomId}`);
    
    // Delete the persistent canvas file
    CanvasState.deleteFromDisk(roomId);
    
    // Delete all memory storage
    const roomState = this.roomStates.get(roomId);
    if (roomState?.memoryManager) {
      roomState.memoryManager.deleteAllStorage();
    }
    
    await this.fileStorage.cleanupRoom(roomId);
    await this.vectorDB.cleanupRoom(roomId);
    await this.redisClient.cleanupRoom(roomId);
    console.log(`LangGraphAgent: room ${roomId} cleaned up`);
  }
}
