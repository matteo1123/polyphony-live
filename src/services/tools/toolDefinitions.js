// Tool definitions for Gemini function calling
// Following Google's function calling specification

export const tools = [
  {
    name: 'read_file_section',
    description: 'Read specific chunks from an uploaded file. Files are split into semantic chunks (~512 tokens each) that preserve paragraph boundaries. Use this to access document content.',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The unique ID of the file to read'
        },
        start_chunk: {
          type: 'integer',
          description: 'The chunk number to start reading from (0-indexed)'
        },
        end_chunk: {
          type: 'integer',
          description: 'The chunk number to stop reading at (inclusive)'
        }
      },
      required: ['file_id', 'start_chunk', 'end_chunk']
    }
  },
  {
    name: 'create_knowledge_entry',
    description: 'Create a knowledge entry in the shared knowledge base. Use this to save important information, concepts, or insights extracted from documents or conversations. All users in the space can see knowledge entries.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'A short, descriptive title for this knowledge entry'
        },
        content: {
          type: 'string',
          description: 'The detailed content of the knowledge entry. Be comprehensive but concise.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorizing this entry (e.g., ["concept", "definition", "example"])'
        },
        relationships: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of related knowledge entries, if any'
        }
      },
      required: ['topic', 'content']
    }
  },
  {
    name: 'search_knowledge',
    description: 'Search the knowledge base for relevant information. Uses semantic similarity to find matching entries. Use this before answering questions to check what knowledge has already been captured.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query - describe what you are looking for'
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 5)'
        },
        filter_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only return entries with ALL of these tags'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'render_visualization',
    description: 'Display a visualization in the user\'s visualization area. Supports HTML, SVG, charts, and markdown. Use this for diagrams, graphs, tables, or any visual representation of information.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['html', 'svg', 'chart', 'markdown'],
          description: 'The type of visualization to render'
        },
        title: {
          type: 'string',
          description: 'A title for the visualization'
        },
        data: {
          type: 'object',
          description: 'For chart type: { chartType: "bar"|"line"|"pie"|"doughnut", labels: [...], datasets: [{ label, data, backgroundColor }] }. For html/svg/markdown: use the content field instead.'
        },
        content: {
          type: 'string',
          description: 'For html/svg/markdown types: the raw content to render'
        }
      },
      required: ['type', 'title']
    }
  },
  {
    name: 'add_to_canvas',
    description: 'Add a contribution to the shared canvas visible to ALL users. Use this to share insights, ideas, questions, or synthesized thoughts. In mediation mode, rephrase user contributions diplomatically before adding.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['insight', 'question', 'idea', 'synthesis', 'response', 'summary', 'file_summary'],
          description: 'The type of contribution'
        },
        content: {
          type: 'string',
          description: 'The content to share. If mediating, rephrase diplomatically - never share raw user messages.'
        },
        relatedTo: {
          type: 'string',
          description: 'Optional: ID of a canvas item this relates to (for threading)'
        }
      },
      required: ['type', 'content']
    }
  }
];

// Convert to Gemini function declaration format
export const geminiToolDeclarations = {
  functionDeclarations: tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }))
};

// Tool name constants for type safety
export const TOOLS = {
  READ_FILE_SECTION: 'read_file_section',
  CREATE_KNOWLEDGE_ENTRY: 'create_knowledge_entry',
  SEARCH_KNOWLEDGE: 'search_knowledge',
  RENDER_VISUALIZATION: 'render_visualization',
  ADD_TO_CANVAS: 'add_to_canvas'
};
