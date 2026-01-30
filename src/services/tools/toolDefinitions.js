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
    name: 'contribute',
    description: 'Add a contribution to the shared understanding. This SINGLE tool updates: (1) the canvas (visible to all), (2) the knowledge base (searchable), and (3) the knowledge sidebar. Use this whenever you have insights, synthesized information, or key concepts to share. This is the PRIMARY way to build collective knowledge.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['insight', 'question', 'idea', 'synthesis', 'response', 'summary', 'concept', 'fact'],
          description: 'The type of contribution'
        },
        title: {
          type: 'string',
          description: 'A clear, specific title for this contribution (e.g., "Agentic Design Patterns", "The Meaning of Life in Existentialism", NOT generic like "Insight" or "Document Part 1")'
        },
        content: {
          type: 'string',
          description: 'The detailed content/explanation'
        },
        importance: {
          type: 'integer',
          description: 'Importance 1-10 (10 = central to current discussion, 1 = minor detail)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant tags for searchability (e.g., ["agentic", "design-pattern", "llm"])'
        }
      },
      required: ['type', 'title', 'content']
    }
  },
  {
    name: 'refresh_canvas',
    description: 'Trigger a full canvas refresh. This re-ingests ALL knowledge from Redis and redraws the canvas as a hierarchical representation of understanding. Use this when: (1) topic has shifted significantly, (2) new files have been uploaded, (3) you want to reorganize by importance. The canvas should always reflect the CURRENT understanding, pruning outdated info.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why the refresh is being triggered'
        }
      },
      required: ['reason']
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
  CONTRIBUTE: 'contribute',
  REFRESH_CANVAS: 'refresh_canvas'
};
