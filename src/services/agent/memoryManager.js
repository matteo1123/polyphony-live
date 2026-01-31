/**
 * Memory Manager for Polyphony Agent
 * 
 * Manages the agent's "RAM" - all knowledge, contributions, and context
 * Handles memory pressure by compressing, reorganizing, and prioritizing
 * Supports extended storage via temp files when memory is full
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

// Memory configuration
const MEMORY_CONFIG = {
  // Token limits for different memory tiers
  // INCREASED: Larger memory to reduce offloading and keep more content searchable
  WORKING_MEMORY_TOKENS: 16000,     // ~12k tokens for active working memory (was 8000)
  COMPRESSED_MEMORY_TOKENS: 32000,  // ~24k tokens for compressed memory (was 16000)
  TOTAL_MEMORY_TOKENS: 128000,      // ~96k tokens total before forced compression (was 64000)
  
  // Compression thresholds - raised to delay compression
  COMPRESSION_THRESHOLD: 0.75,      // Compress when 75% full (was 0.7)
  URGENT_THRESHOLD: 0.92,           // Urgent compression at 92% (was 0.9)
  
  // Async settings
  COMPRESSION_BATCH_SIZE: 5,        // Process 5 items per compression batch
  MIN_COMPRESSION_INTERVAL: 60000,  // Min 60s between compression runs (was 30s)
  
  // File storage
  EXTENDED_MEMORY_DIR: process.env.EXTENDED_MEMORY_DIR || path.join(os.tmpdir(), 'polyphony-memory')
};

// Ensure extended memory directory exists
if (!fs.existsSync(MEMORY_CONFIG.EXTENDED_MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_CONFIG.EXTENDED_MEMORY_DIR, { recursive: true });
}

/**
 * Memory Entry - Represents a single piece of knowledge in RAM
 */
class MemoryEntry {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.roomId = data.roomId;
    this.userId = data.userId;
    this.userName = data.userName || 'Anonymous';
    this.topic = data.topic;
    this.content = data.content;
    this.tags = data.tags || [];
    this.type = data.type || 'knowledge'; // 'knowledge', 'contribution', 'diagram', 'compressed', 'file'
    this.importance = data.importance || 5; // 1-10 scale
    this.createdAt = data.createdAt || Date.now();
    this.lastAccessed = data.lastAccessed || Date.now();
    this.accessCount = data.accessCount || 0;
    this.compressedFrom = data.compressedFrom || null; // IDs of entries this was compressed from
    this.originalContent = data.originalContent || null; // Store original before compression
    this.filePath = data.filePath || null; // For file-backed entries
    this.tokenEstimate = this.estimateTokens();
  }

  estimateTokens() {
    // Rough estimate: ~4 chars per token
    const text = `${this.topic} ${this.content}`;
    return Math.ceil(text.length / 4);
  }

  access() {
    this.lastAccessed = Date.now();
    this.accessCount++;
  }

  toJSON() {
    return {
      id: this.id,
      roomId: this.roomId,
      userId: this.userId,
      userName: this.userName,
      topic: this.topic,
      content: this.content,
      tags: this.tags,
      type: this.type,
      importance: this.importance,
      createdAt: this.createdAt,
      lastAccessed: this.lastAccessed,
      accessCount: this.accessCount,
      compressedFrom: this.compressedFrom,
      originalContent: this.originalContent,
      filePath: this.filePath,
      tokenEstimate: this.tokenEstimate
    };
  }

  static fromJSON(data) {
    return new MemoryEntry(data);
  }
}

/**
 * Memory Manager - Handles all agent memory operations
 */
export class MemoryManager {
  constructor(roomId, model, io) {
    this.roomId = roomId;
    this.model = model; // LLM for compression/reorganization
    this.io = io;
    
    // Working memory (RAM)
    this.entries = new Map(); // id -> MemoryEntry
    
    // Extended storage (disk-backed)
    this.extendedStoragePath = path.join(MEMORY_CONFIG.EXTENDED_MEMORY_DIR, `${roomId}`);
    if (!fs.existsSync(this.extendedStoragePath)) {
      fs.mkdirSync(this.extendedStoragePath, { recursive: true });
    }
    
    // Compression state
    this.lastCompressionTime = 0;
    this.isCompressing = false;
    this.compressionQueue = [];
    
    // Persistence
    this.memoryFile = path.join(MEMORY_CONFIG.EXTENDED_MEMORY_DIR, `${roomId}-memory.json`);
    this.loadFromDisk();
    
    // Start background memory monitor
    this.startMemoryMonitor();
  }

  /**
   * Add a new entry to memory
   */
  async addEntry(data) {
    const entry = new MemoryEntry({
      ...data,
      roomId: this.roomId
    });

    // Check if we need to offload to extended storage immediately
    if (this.getTotalTokens() + entry.tokenEstimate > MEMORY_CONFIG.TOTAL_MEMORY_TOKENS) {
      await this.offloadToExtendedStorage(entry);
    } else {
      this.entries.set(entry.id, entry);
    }

    // Check memory pressure
    this.checkMemoryPressure();
    
    // Save to disk
    this.saveToDisk();
    
    return entry;
  }

  /**
   * Get entry by ID
   */
  getEntry(id) {
    // Check working memory first
    const entry = this.entries.get(id);
    if (entry) {
      entry.access();
      return entry;
    }

    // Check extended storage
    return this.loadFromExtendedStorage(id);
  }

  /**
   * Get all entries (for export)
   */
  getAllEntries() {
    // Get all working memory entries
    const workingEntries = Array.from(this.entries.values());
    
    // Get all extended storage entries
    const extendedEntries = this.getAllExtendedStorageEntries();
    
    return [...workingEntries, ...extendedEntries];
  }

  /**
   * Search entries by query
   */
  async searchEntries(query, limit = 10) {
    // Simple keyword search for now
    // Could be enhanced with embeddings
    const allEntries = this.getAllEntries();
    const queryLower = query.toLowerCase();
    
    const scored = allEntries.map(entry => {
      const text = `${entry.topic} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
      let score = 0;
      
      // Exact match bonus
      if (entry.topic.toLowerCase().includes(queryLower)) score += 10;
      if (text.includes(queryLower)) score += 5;
      
      // Importance bonus
      score += entry.importance;
      
      // Recency bonus
      const age = Date.now() - entry.createdAt;
      score += Math.max(0, 5 - age / (1000 * 60 * 60)); // Bonus for entries < 1 hour
      
      // Access count bonus
      score += Math.min(5, entry.accessCount);
      
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entry);
  }

  /**
   * Check memory pressure and trigger compression if needed
   */
  checkMemoryPressure() {
    const totalTokens = this.getTotalTokens();
    const workingTokens = this.getWorkingMemoryTokens();
    const ratio = workingTokens / MEMORY_CONFIG.WORKING_MEMORY_TOKENS;

    if (ratio >= MEMORY_CONFIG.URGENT_THRESHOLD && !this.isCompressing) {
      console.log(`MemoryManager: URGENT compression needed (${Math.round(ratio * 100)}% full)`);
      this.triggerCompression(true);
    } else if (ratio >= MEMORY_CONFIG.COMPRESSION_THRESHOLD && !this.isCompressing) {
      const timeSinceLastCompression = Date.now() - this.lastCompressionTime;
      if (timeSinceLastCompression > MEMORY_CONFIG.MIN_COMPRESSION_INTERVAL) {
        console.log(`MemoryManager: Compression recommended (${Math.round(ratio * 100)}% full)`);
        this.triggerCompression(false);
      }
    }
  }

  /**
   * Trigger async compression
   */
  triggerCompression(urgent = false) {
    if (this.isCompressing) return;
    
    this.isCompressing = true;
    
    // Run compression asynchronously
    this.runCompression(urgent).then(() => {
      this.isCompressing = false;
      this.lastCompressionTime = Date.now();
    }).catch(error => {
      console.error('MemoryManager: Compression failed:', error);
      this.isCompressing = false;
    });
  }

  /**
   * Run compression algorithm
   */
  async runCompression(urgent = false) {
    console.log(`MemoryManager: Starting ${urgent ? 'URGENT' : 'routine'} compression`);
    
    // Get all entries sorted by priority (low importance + old + low access = compressible)
    const entries = Array.from(this.entries.values());
    const compressible = entries.filter(e => 
      e.type !== 'compressed' && 
      e.importance < 8 && 
      !e.filePath
    );

    // Sort by compressibility score (lower = more compressible)
    compressible.sort((a, b) => {
      const scoreA = this.calculateCompressibilityScore(a);
      const scoreB = this.calculateCompressibilityScore(b);
      return scoreA - scoreB;
    });

    // Batch process
    const batchSize = urgent ? MEMORY_CONFIG.COMPRESSION_BATCH_SIZE * 2 : MEMORY_CONFIG.COMPRESSION_BATCH_SIZE;
    const toCompress = compressible.slice(0, batchSize);

    if (toCompress.length === 0) {
      console.log('MemoryManager: Nothing to compress');
      return;
    }

    // Group related entries for combined compression
    const groups = this.groupRelatedEntries(toCompress);
    
    for (const group of groups) {
      await this.compressGroup(group);
    }

    // If still under pressure, offload to extended storage
    if (urgent && this.getWorkingMemoryTokens() > MEMORY_CONFIG.WORKING_MEMORY_TOKENS * 0.9) {
      await this.offloadOldestToExtendedStorage();
    }

    // Save changes
    this.saveToDisk();
    
    console.log(`MemoryManager: Compression complete. Working memory: ${this.getWorkingMemoryTokens()} tokens`);
  }

  /**
   * Calculate how compressible an entry is (lower score = more compressible)
   */
  calculateCompressibilityScore(entry) {
    let score = 0;
    
    // Importance (high importance = less compressible)
    score += entry.importance * 10;
    
    // Age (older = more compressible)
    const age = Date.now() - entry.createdAt;
    score -= Math.min(50, age / (1000 * 60 * 10)); // -1 per 10 minutes, max -50
    
    // Access count (frequently accessed = less compressible)
    score -= entry.accessCount * 2;
    
    // Size (larger = more benefit from compression)
    score -= entry.tokenEstimate / 100;
    
    return score;
  }

  /**
   * Group related entries for combined compression
   */
  groupRelatedEntries(entries) {
    // Simple grouping by tags and topics
    const groups = [];
    const used = new Set();
    
    for (const entry of entries) {
      if (used.has(entry.id)) continue;
      
      const group = [entry];
      used.add(entry.id);
      
      // Find related entries
      for (const other of entries) {
        if (used.has(other.id)) continue;
        
        // Check tag overlap
        const sharedTags = entry.tags.filter(t => other.tags.includes(t));
        if (sharedTags.length > 0) {
          group.push(other);
          used.add(other.id);
        }
      }
      
      groups.push(group);
    }
    
    return groups;
  }

  /**
   * Compress a group of entries using LLM
   */
  async compressGroup(entries) {
    if (entries.length === 0) return;
    if (entries.length === 1) {
      // Single entry compression
      await this.compressSingleEntry(entries[0]);
      return;
    }

    const totalTokens = entries.reduce((sum, e) => sum + e.tokenEstimate, 0);
    const originalIds = entries.map(e => e.id);

    try {
      const compressionPrompt = `You are compressing multiple related knowledge entries into a single, dense summary.

ENTRIES TO COMPRESS (${entries.length} entries, ~${totalTokens} tokens):
${entries.map(e => `
TOPIC: ${e.topic}
CONTENT: ${e.content.slice(0, 500)}${e.content.length > 500 ? '...' : ''}
IMPORTANCE: ${e.importance}/10
---`).join('\n')}

Create a compressed version that:
1. Captures the ESSENTIAL information from all entries
2. Removes redundancy and fluff
3. Maintains key facts, relationships, and insights
4. Is significantly shorter but information-dense

Respond with JSON:
{
  "topic": "Concise combined topic",
  "content": "Compressed, information-dense content",
  "keyPoints": ["point 1", "point 2"]
}`;

      const response = await this.model.invoke([
        { role: 'system', content: compressionPrompt }
      ]);

      const result = JSON.parse(response.content);
      
      // Create compressed entry
      const compressedEntry = new MemoryEntry({
        roomId: this.roomId,
        userId: 'system',
        userName: 'Memory Manager',
        topic: `Compressed: ${result.topic}`,
        content: result.content + '\n\nKey points: ' + result.keyPoints.join('; '),
        tags: [...new Set(entries.flatMap(e => e.tags)), 'compressed'],
        type: 'compressed',
        importance: Math.max(...entries.map(e => e.importance)),
        compressedFrom: originalIds,
        originalContent: JSON.stringify(entries.map(e => ({
          topic: e.topic,
          content: e.content,
          createdAt: e.createdAt
        })))
      });

      // Replace old entries with compressed
      for (const entry of entries) {
        this.entries.delete(entry.id);
      }
      this.entries.set(compressedEntry.id, compressedEntry);

      console.log(`MemoryManager: Compressed ${entries.length} entries into 1 (${totalTokens} -> ${compressedEntry.tokenEstimate} tokens)`);

    } catch (error) {
      console.error('MemoryManager: Compression failed for group:', error);
      // Mark entries as failed compression to avoid retry
      for (const entry of entries) {
        entry.tags.push('compression-failed');
      }
    }
  }

  /**
   * Compress a single entry
   */
  async compressSingleEntry(entry) {
    try {
      const compressionPrompt = `Compress this knowledge entry into a denser form:

TOPIC: ${entry.topic}
CONTENT: ${entry.content}

Create a compressed version that keeps the essential information but removes redundancy.

Respond with JSON:
{
  "topic": "Compressed topic",
  "content": "Dense, compressed content"
}`;

      const response = await this.model.invoke([
        { role: 'system', content: compressionPrompt }
      ]);

      const result = JSON.parse(response.content);
      
      // Store original
      entry.originalContent = entry.content;
      entry.content = result.content;
      entry.topic = result.topic;
      entry.tags.push('compressed');
      entry.type = 'compressed';
      entry.tokenEstimate = entry.estimateTokens();

      console.log(`MemoryManager: Compressed single entry ${entry.id}`);

    } catch (error) {
      console.error('MemoryManager: Single entry compression failed:', error);
    }
  }

  /**
   * Offload entry to extended storage (disk)
   */
  async offloadToExtendedStorage(entry) {
    const fileName = `${entry.id}.json`;
    const filePath = path.join(this.extendedStoragePath, fileName);
    
    fs.writeFileSync(filePath, JSON.stringify(entry.toJSON(), null, 2));
    
    // Keep a reference entry in working memory
    const referenceEntry = new MemoryEntry({
      id: entry.id,
      roomId: this.roomId,
      userId: entry.userId,
      userName: entry.userName,
      topic: entry.topic,
      content: `[Stored in extended memory - ${entry.tokenEstimate} tokens]`,
      tags: [...entry.tags, 'offloaded'],
      type: 'reference',
      importance: entry.importance,
      filePath: filePath
    });
    
    this.entries.set(entry.id, referenceEntry);
    console.log(`MemoryManager: Offloaded entry ${entry.id} to ${filePath}`);
  }

  /**
   * Load entry from extended storage
   */
  loadFromExtendedStorage(id) {
    const filePath = path.join(this.extendedStoragePath, `${id}.json`);
    
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const entry = MemoryEntry.fromJSON(data);
        entry.access();
        return entry;
      } catch (error) {
        console.error(`MemoryManager: Failed to load ${id} from extended storage:`, error);
      }
    }
    
    return null;
  }

  /**
   * Get all entries from extended storage
   */
  getAllExtendedStorageEntries() {
    const entries = [];
    
    if (fs.existsSync(this.extendedStoragePath)) {
      const files = fs.readdirSync(this.extendedStoragePath);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(this.extendedStoragePath, file), 'utf-8'));
            entries.push(MemoryEntry.fromJSON(data));
          } catch (error) {
            console.error(`MemoryManager: Failed to load ${file}:`, error);
          }
        }
      }
    }
    
    return entries;
  }

  /**
   * Offload oldest entries to extended storage
   */
  async offloadOldestToExtendedStorage() {
    // Sort by last accessed (oldest first)
    const entries = Array.from(this.entries.values())
      .filter(e => !e.filePath && e.type !== 'compressed')
      .sort((a, b) => a.lastAccessed - b.lastAccessed);
    
    const toOffload = entries.slice(0, 3); // Offload 3 oldest
    
    for (const entry of toOffload) {
      // Remove from working memory
      this.entries.delete(entry.id);
      // Add to extended storage
      await this.offloadToExtendedStorage(entry);
    }
  }

  /**
   * Get total tokens across all memory tiers
   */
  getTotalTokens() {
    const workingTokens = this.getWorkingMemoryTokens();
    const extendedTokens = this.getAllExtendedStorageEntries()
      .reduce((sum, e) => sum + e.tokenEstimate, 0);
    return workingTokens + extendedTokens;
  }

  /**
   * Get working memory tokens only
   */
  getWorkingMemoryTokens() {
    return Array.from(this.entries.values())
      .reduce((sum, e) => sum + e.tokenEstimate, 0);
  }

  /**
   * Get memory statistics
   */
  getStats() {
    const workingEntries = Array.from(this.entries.values());
    const extendedEntries = this.getAllExtendedStorageEntries();
    
    return {
      workingMemory: {
        entries: workingEntries.length,
        tokens: this.getWorkingMemoryTokens(),
        maxTokens: MEMORY_CONFIG.WORKING_MEMORY_TOKENS
      },
      extendedStorage: {
        entries: extendedEntries.length,
        tokens: extendedEntries.reduce((sum, e) => sum + e.tokenEstimate, 0)
      },
      total: {
        entries: workingEntries.length + extendedEntries.length,
        tokens: this.getTotalTokens()
      },
      byType: {
        knowledge: workingEntries.filter(e => e.type === 'knowledge').length,
        contribution: workingEntries.filter(e => e.type === 'contribution').length,
        diagram: workingEntries.filter(e => e.type === 'diagram').length,
        compressed: workingEntries.filter(e => e.type === 'compressed').length,
        file: extendedEntries.filter(e => e.type === 'file').length
      }
    };
  }

  /**
   * Start background memory monitor
   */
  startMemoryMonitor() {
    // Check memory every 60 seconds
    setInterval(() => {
      this.checkMemoryPressure();
    }, 60000);
  }

  /**
   * Save memory to disk
   */
  saveToDisk() {
    try {
      const data = {
        roomId: this.roomId,
        lastSaved: Date.now(),
        entries: Array.from(this.entries.values()).map(e => e.toJSON()),
        stats: this.getStats()
      };
      fs.writeFileSync(this.memoryFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('MemoryManager: Failed to save to disk:', error);
    }
  }

  /**
   * Load memory from disk
   */
  loadFromDisk() {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const data = JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8'));
        
        for (const entryData of data.entries || []) {
          this.entries.set(entryData.id, MemoryEntry.fromJSON(entryData));
        }
        
        console.log(`MemoryManager: Loaded ${this.entries.size} entries for room ${this.roomId}`);
        return true;
      }
    } catch (error) {
      console.error('MemoryManager: Failed to load from disk:', error);
    }
    return false;
  }

  /**
   * Delete all memory files for this room
   */
  deleteAllStorage() {
    try {
      // Delete memory file
      if (fs.existsSync(this.memoryFile)) {
        fs.unlinkSync(this.memoryFile);
      }
      
      // Delete extended storage directory
      if (fs.existsSync(this.extendedStoragePath)) {
        fs.rmSync(this.extendedStoragePath, { recursive: true, force: true });
      }
      
      console.log(`MemoryManager: Deleted all storage for room ${this.roomId}`);
    } catch (error) {
      console.error('MemoryManager: Failed to delete storage:', error);
    }
  }

  /**
   * Export all memory as comprehensive markdown
   */
  exportToMarkdown() {
    const allEntries = this.getAllEntries();
    const stats = this.getStats();
    
    let md = `# Polyphony Session Export\n\n`;
    md += `*Generated: ${new Date().toLocaleString()}*\n\n`;
    md += `## Session Statistics\n\n`;
    md += `- Total Entries: ${stats.total.entries}\n`;
    md += `- Total Tokens: ~${stats.total.tokens}\n`;
    md += `- Working Memory: ${stats.workingMemory.entries} entries (~${stats.workingMemory.tokens} tokens)\n`;
    md += `- Extended Storage: ${stats.extendedStorage.entries} entries (~${stats.extendedStorage.tokens} tokens)\n\n`;
    md += `## Content by Type\n\n`;
    md += `- Knowledge: ${stats.byType.knowledge}\n`;
    md += `- Contributions: ${stats.byType.contribution}\n`;
    md += `- Diagrams: ${stats.byType.diagram}\n`;
    md += `- Compressed: ${stats.byType.compressed}\n`;
    md += `- Files: ${stats.byType.file}\n\n`;
    
    md += `---\n\n`;
    md += `## All Knowledge and Contributions\n\n`;
    
    // Sort by importance then recency
    const sortedEntries = allEntries.sort((a, b) => {
      if (a.importance !== b.importance) return b.importance - a.importance;
      return b.createdAt - a.createdAt;
    });
    
    for (const entry of sortedEntries) {
      md += this.entryToMarkdown(entry);
    }
    
    return md;
  }

  /**
   * Convert a single entry to markdown
   */
  entryToMarkdown(entry) {
    const importanceStars = '★'.repeat(entry.importance) + '☆'.repeat(10 - entry.importance);
    let md = `### ${entry.topic}\n\n`;
    md += `**Type:** ${entry.type} | **Importance:** ${importanceStars} | **By:** ${entry.userName}\n\n`;
    md += `**Created:** ${new Date(entry.createdAt).toLocaleString()}\n\n`;
    
    if (entry.tags.length > 0) {
      md += `**Tags:** ${entry.tags.join(', ')}\n\n`;
    }
    
    md += `${entry.content}\n\n`;
    
    // If compressed, note the original content
    if (entry.originalContent && entry.type === 'compressed') {
      md += `<details>\n<summary>Original Content (Pre-compression)</summary>\n\n`;
      md += `${entry.originalContent}\n\n`;
      md += `</details>\n\n`;
    }
    
    // If offloaded, note where it's stored
    if (entry.filePath) {
      md += `*Stored in: ${entry.filePath}*\n\n`;
    }
    
    md += `---\n\n`;
    return md;
  }
}

export default MemoryManager;