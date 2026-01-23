export class HiveAgent {
  constructor(redisClient, io) {
    this.redisClient = redisClient;
    this.io = io;
    this.synthesisLoopInterval = null;
    this.synthesisIntervalMs = 3000; // Run synthesis every 3 seconds
    this.activeRooms = new Map(); // Track active rooms
  }

  startSynthesisLoop() {
    this.synthesisLoopInterval = setInterval(() => {
      this.synthesizeCollectiveMemory();
    }, this.synthesisIntervalMs);

    console.log(`🧠 Hive Agent synthesis loop started (${this.synthesisIntervalMs}ms interval)`);
  }

  stopSynthesisLoop() {
    if (this.synthesisLoopInterval) {
      clearInterval(this.synthesisLoopInterval);
      this.synthesisLoopInterval = null;
      console.log('🛑 Hive Agent synthesis loop stopped');
    }
  }

  async synthesizeCollectiveMemory() {
    try {
      // Iterate through active rooms
      for (const [roomId, metadata] of this.activeRooms.entries()) {
        const activeUserCount = await this.redisClient.getActiveUserCount(roomId);

        // If no active users, cleanup room
        if (activeUserCount === 0) {
          await this.handleRoomCleanup(roomId);
          this.activeRooms.delete(roomId);
          continue;
        }

        // Get recent thoughts
        const thoughts = await this.redisClient.getThoughtsByRoom(roomId, 50);

        if (thoughts.length === 0) {
          continue;
        }

        // Extract unique users who contributed thoughts
        const contributors = new Set(thoughts.map(t => t.userId));

        // If thoughts from multiple users, trigger synthesis
        if (contributors.size > 1) {
          const synthesis = await this.generateSynthesis(roomId, thoughts, Array.from(contributors));
          
          // Broadcast synthesis to all clients in room
          this.io.to(roomId).emit('synthesis:update', {
            timestamp: Date.now(),
            contributors: Array.from(contributors),
            summary: synthesis.summary,
            conflicts: synthesis.conflicts,
            insights: synthesis.insights
          });
        }
      }
    } catch (error) {
      console.error('❌ Error during synthesis:', error);
    }
  }

  async generateSynthesis(roomId, thoughts, contributors) {
    // Placeholder for LangGraph integration
    // This will be replaced with actual LangGraph implementation
    
    const thoughtContents = thoughts.map(t => t.content).join(' ');
    const uniqueTopics = this.extractTopics(thoughtContents);

    return {
      summary: `Synthesis from ${contributors.length} contributors discussing: ${uniqueTopics.join(', ')}`,
      conflicts: this.detectConflicts(thoughts),
      insights: this.generateInsights(thoughts)
    };
  }

  extractTopics(text) {
    // Simple keyword extraction (will be enhanced)
    const words = text.toLowerCase().split(/\s+/);
    const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for']);
    const filtered = words.filter(w => w.length > 4 && !stopwords.has(w));
    return [...new Set(filtered)].slice(0, 5);
  }

  detectConflicts(thoughts) {
    // Placeholder for conflict detection
    // Will use vector similarity to find opposing views
    return [];
  }

  generateInsights(thoughts) {
    // Placeholder for insight generation
    // Will use embeddings to find novel combinations
    return [];
  }

  async handleRoomCleanup(roomId) {
    console.log(`🧹 Room ${roomId} cleanup triggered`);
    
    // Generate final summary before cleanup
    const thoughts = await this.redisClient.getThoughtsByRoom(roomId, 1000);
    
    if (thoughts.length > 0) {
      const finalSummary = await this.generateFinalSummary(roomId, thoughts);
      
      // Emit final summary to remaining clients
      this.io.to(roomId).emit('room:final_summary', {
        timestamp: Date.now(),
        markdown: finalSummary,
        message: 'Your Collective Memory is ready for download'
      });
    }

    // Cleanup Redis data
    await this.redisClient.cleanupRoom(roomId);
  }

  async generateFinalSummary(roomId, thoughts) {
    // Generate markdown summary
    const timestamp = new Date().toISOString();
    const contributors = new Set(thoughts.map(t => t.userId));

    let markdown = `# Polyphony.live - Collective Memory\n\n`;
    markdown += `**Room:** ${roomId}\n`;
    markdown += `**Generated:** ${timestamp}\n`;
    markdown += `**Contributors:** ${contributors.size}\n\n`;

    markdown += `## Thoughts Captured\n\n`;
    
    // Group by user
    const groupedByUser = {};
    for (const thought of thoughts) {
      if (!groupedByUser[thought.userId]) {
        groupedByUser[thought.userId] = [];
      }
      groupedByUser[thought.userId].push(thought.content);
    }

    for (const [userId, userThoughts] of Object.entries(groupedByUser)) {
      markdown += `### ${userId}\n`;
      for (const thought of userThoughts) {
        markdown += `- ${thought}\n`;
      }
      markdown += `\n`;
    }

    return markdown;
  }

  registerRoom(roomId, metadata = {}) {
    this.activeRooms.set(roomId, {
      ...metadata,
      createdAt: Date.now()
    });
    console.log(`📍 Room registered: ${roomId}`);
  }

  unregisterRoom(roomId) {
    this.activeRooms.delete(roomId);
    console.log(`📍 Room unregistered: ${roomId}`);
  }
}
