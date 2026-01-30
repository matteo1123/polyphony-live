import { ConvexHttpClient } from 'convex/browser';

/**
 * Convex client for server-side operations
 * Used to save meeting summaries and analytics when rooms close
 */
export class ConvexService {
  constructor() {
    this.client = null;
    this.url = process.env.CONVEX_URL;
    
    if (this.url) {
      try {
        this.client = new ConvexHttpClient(this.url);
        console.log('✅ Convex client initialized');
      } catch (error) {
        console.error('❌ Failed to initialize Convex client:', error.message);
      }
    } else {
      console.log('⚠️ CONVEX_URL not set - Convex features disabled');
    }
  }

  /**
   * Check if Convex is configured and available
   */
  isAvailable() {
    return this.client !== null;
  }

  /**
   * Save meeting summary to Convex when a space closes
   * @param {string} spaceId - The space/room ID
   * @param {string} summaryMarkdown - The exported markdown summary
   * @returns {Promise<boolean>} - Whether the save was successful
   */
  async saveMeetingSummary(spaceId, summaryMarkdown) {
    if (!this.isAvailable()) {
      console.log('Convex not available - skipping meeting summary save');
      return false;
    }

    if (!spaceId || !summaryMarkdown) {
      console.warn('Missing spaceId or summaryMarkdown - cannot save to Convex');
      return false;
    }

    try {
      console.log(`Saving meeting summary for space ${spaceId} to Convex...`);
      
      await this.client.mutation('spaces:recordMeetingSummary', {
        spaceId,
        summaryMarkdown,
      });

      console.log(`✅ Meeting summary saved to Convex for space ${spaceId}`);
      return true;
    } catch (error) {
      console.error('❌ Failed to save meeting summary to Convex:', error.message);
      // Don't throw - we don't want to break the room cleanup if Convex fails
      return false;
    }
  }

  /**
   * Record when a space is created (called when first user joins)
   * @param {string} spaceId - The space/room ID
   * @param {string} createdBy - Identifier of who created it
   * @returns {Promise<boolean>}
   */
  async recordSpaceCreated(spaceId, createdBy = null) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client.mutation('spaces:recordSpaceCreated', {
        spaceId,
        createdBy,
      });
      console.log(`Space ${spaceId} recorded in Convex`);
      return true;
    } catch (error) {
      console.error('Failed to record space creation:', error.message);
      return false;
    }
  }

  /**
   * Update space stats (peak users, messages, files)
   * @param {string} spaceId - The space/room ID
   * @param {Object} stats - Stats to update
   * @returns {Promise<boolean>}
   */
  async updateSpaceStats(spaceId, stats) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client.mutation('spaces:updateSpaceStats', {
        spaceId,
        ...stats,
      });
      return true;
    } catch (error) {
      console.error('Failed to update space stats:', error.message);
      return false;
    }
  }
}

// Export singleton instance
export const convexService = new ConvexService();
