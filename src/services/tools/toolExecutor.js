import { TOOLS } from './toolDefinitions.js';

export class ToolExecutor {
  constructor(fileStorage, vectorDB, visualizationCallback, canvasCallback) {
    this.fileStorage = fileStorage;
    this.vectorDB = vectorDB;
    this.visualizationCallback = visualizationCallback; // Called when visualization should be rendered
    this.canvasCallback = canvasCallback; // Called when adding to shared canvas
  }

  // Execute a tool call
  async execute(toolName, args, context) {
    const { roomId, userId } = context;

    console.log(`ToolExecutor: executing ${toolName} with args:`, JSON.stringify(args));

    try {
      switch (toolName) {
        case TOOLS.READ_FILE_SECTION:
          return this.executeReadFileSection(args);

        case TOOLS.CREATE_KNOWLEDGE_ENTRY:
          return await this.executeCreateKnowledgeEntry(args, roomId, userId);

        case TOOLS.SEARCH_KNOWLEDGE:
          return await this.executeSearchKnowledge(args, roomId);

        case TOOLS.RENDER_VISUALIZATION:
          return await this.executeRenderVisualization(args, context);

        case TOOLS.ADD_TO_CANVAS:
          return await this.executeAddToCanvas(args, context);

        default:
          return { error: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      console.error(`ToolExecutor: error executing ${toolName}:`, error);
      return { error: error.message };
    }
  }

  // Read file section tool
  executeReadFileSection(args) {
    const { file_id, start_chunk, end_chunk, start_page, end_page } = args;

    if (!file_id) {
      return { error: 'file_id is required' };
    }

    // Support both old (page) and new (chunk) parameter names
    const start = start_chunk ?? (start_page ? start_page - 1 : 0);
    const end = end_chunk ?? (end_page ? end_page - 1 : start);

    const result = this.fileStorage.readFileSection(file_id, start, end);
    return result;
  }

  // Create knowledge entry tool
  async executeCreateKnowledgeEntry(args, roomId, userId) {
    const { topic, content, tags = [], relationships = [] } = args;

    if (!topic || !content) {
      return { error: 'topic and content are required' };
    }

    const entry = await this.vectorDB.createKnowledgeEntry(
      roomId,
      userId,
      topic,
      content,
      tags,
      relationships
    );

    return {
      success: true,
      entry: {
        id: entry.id,
        topic: entry.topic,
        tags: entry.tags
      }
    };
  }

  // Search knowledge tool
  async executeSearchKnowledge(args, roomId) {
    const { query, limit = 5, filter_tags = [] } = args;

    if (!query) {
      return { error: 'query is required' };
    }

    const results = await this.vectorDB.searchKnowledge(
      roomId,
      query,
      limit,
      filter_tags
    );

    return {
      query,
      resultCount: results.length,
      results: results.map(r => ({
        id: r.id,
        topic: r.topic,
        content: r.content.slice(0, 500) + (r.content.length > 500 ? '...' : ''),
        tags: r.tags,
        score: Math.round(r.score * 100) / 100
      }))
    };
  }

  // Render visualization tool
  async executeRenderVisualization(args, context) {
    const { type, title, data, content } = args;

    if (!type || !title) {
      return { error: 'type and title are required' };
    }

    const visualization = {
      type,
      title,
      data: data || null,
      content: content || null,
      timestamp: Date.now()
    };

    // Call the callback to emit visualization to client
    if (this.visualizationCallback) {
      await this.visualizationCallback(context, visualization);
    }

    return {
      success: true,
      message: `Visualization "${title}" rendered`,
      type
    };
  }

  // Add to canvas tool
  async executeAddToCanvas(args, context) {
    const { type, content, relatedTo } = args;
    const { userName } = context;

    if (!type || !content) {
      return { error: 'type and content are required' };
    }

    const contribution = {
      type,
      content,
      userName: userName || 'Anonymous',
      relatedTo: relatedTo || null
    };

    // Call the callback to add to canvas
    if (this.canvasCallback) {
      await this.canvasCallback(context, contribution);
    }

    return {
      success: true,
      message: `Added ${type} to shared canvas`,
      type
    };
  }

  // Helper to format tool results for the agent
  formatToolResult(toolName, result) {
    if (result.error) {
      return `Tool ${toolName} failed: ${result.error}`;
    }

    return JSON.stringify(result, null, 2);
  }
}
