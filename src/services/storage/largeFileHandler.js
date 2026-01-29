import { v4 as uuidv4 } from 'uuid';

// Configuration for large file handling
const LARGE_FILE_THRESHOLD = 50000; // Characters (~12K tokens)
const MAX_EMBED_CHUNKS = 50;        // Max chunks to auto-embed
const SAMPLE_STRATEGY = {
  beginning: 0.15,  // 15% from beginning
  end: 0.15,        // 15% from end  
  middle: 0.20,     // 20% evenly from middle
  random: 0.50      // 50% randomly distributed
};

/**
 * Handles large files with smart sampling and lazy embedding
 * Instead of embedding all chunks upfront (expensive), we:
 * 1. Store all chunks immediately (cheap)
 * 2. Embed only a strategic sample (beginning, end, middle, random)
 * 3. Lazily embed additional chunks only when they're accessed
 */
export class LargeFileHandler {
  constructor(redisClient, vectorDB) {
    this.redisClient = redisClient;
    this.vectorDB = vectorDB;
  }

  /**
   * Determine if a file should be treated as "large"
   */
  isLargeFile(totalChars, chunkCount) {
    return totalChars > LARGE_FILE_THRESHOLD || chunkCount > 100;
  }

  /**
   * Select chunks for initial embedding using strategic sampling
   */
  selectChunksForEmbedding(chunks, maxChunks = MAX_EMBED_CHUNKS) {
    if (chunks.length <= maxChunks) {
      return chunks.map((c, i) => ({ ...c, embed: true, reason: 'all' }));
    }

    const selected = new Set();
    const total = chunks.length;
    const result = [];

    // Beginning (first N chunks)
    const beginningCount = Math.floor(maxChunks * SAMPLE_STRATEGY.beginning);
    for (let i = 0; i < beginningCount && i < total; i++) {
      selected.add(i);
      result.push({ ...chunks[i], embed: true, reason: 'beginning' });
    }

    // End (last N chunks)
    const endCount = Math.floor(maxChunks * SAMPLE_STRATEGY.end);
    for (let i = 0; i < endCount && i < total; i++) {
      const idx = total - 1 - i;
      if (!selected.has(idx)) {
        selected.add(idx);
        result.push({ ...chunks[idx], embed: true, reason: 'end' });
      }
    }

    // Middle (evenly distributed)
    const middleCount = Math.floor(maxChunks * SAMPLE_STRATEGY.middle);
    const middleStart = beginningCount;
    const middleEnd = total - endCount;
    const middleRange = middleEnd - middleStart;
    
    if (middleRange > 0 && middleCount > 0) {
      const step = Math.max(1, Math.floor(middleRange / middleCount));
      for (let i = 0; i < middleCount; i++) {
        const idx = middleStart + (i * step);
        if (idx < middleEnd && !selected.has(idx)) {
          selected.add(idx);
          result.push({ ...chunks[idx], embed: true, reason: 'middle' });
        }
      }
    }

    // Random (fill remaining slots)
    const randomCount = maxChunks - result.length;
    if (randomCount > 0) {
      const available = [];
      for (let i = 0; i < total; i++) {
        if (!selected.has(i)) available.push(i);
      }
      
      // Shuffle available indices
      for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
      }
      
      for (let i = 0; i < randomCount && i < available.length; i++) {
        const idx = available[i];
        result.push({ ...chunks[idx], embed: true, reason: 'random' });
      }
    }

    // Sort by original index
    result.sort((a, b) => a.index - b.index);

    // Add unembedded chunks
    for (let i = 0; i < total; i++) {
      if (!selected.has(i)) {
        result.push({ ...chunks[i], embed: false, reason: 'lazy' });
      }
    }

    return result;
  }

  /**
   * Process a large file upload with smart sampling
   */
  async processLargeFile(roomId, userId, fileInfo, chunks, io, socketId) {
    const client = this.redisClient.getClient();
    const fileId = fileInfo.fileId;
    const totalChunks = chunks.length;
    
    console.log(`LargeFileHandler: Processing ${totalChunks} chunks for ${fileInfo.fileName}`);

    // Select which chunks to embed
    const sampledChunks = this.selectChunksForEmbedding(chunks);
    const toEmbed = sampledChunks.filter(c => c.embed);
    const lazyChunks = sampledChunks.filter(c => !c.embed);

    console.log(`  - Embedding ${toEmbed.length} chunks now`);
    console.log(`  - ${lazyChunks.length} chunks will be embedded on-demand`);

    // Notify client of progress
    this._emitProgress(io, socketId, fileId, 'analyzing', {
      totalChunks,
      embeddingNow: toEmbed.length,
      lazyChunks: lazyChunks.length,
      sampleStrategy: 'beginning/end/middle/random'
    });

    // Store all chunks in Redis (without embeddings)
    const storedChunks = [];
    for (const chunk of sampledChunks) {
      const chunkId = `${roomId}:chunk:${fileId}:${chunk.index}`;
      const chunkData = {
        id: chunkId,
        roomId,
        fileId,
        fileName: fileInfo.fileName,
        chunkIndex: (chunk.index ?? 0).toString(),
        totalChunks: totalChunks.toString(),
        content: chunk.text || '',
        tokens: (chunk.tokens ?? 0).toString(),
        embedded: chunk.embed ? 'pending' : 'lazy',
        sampleReason: chunk.reason || 'unknown',
        createdAt: Date.now().toString()
      };

      await client.hSet(chunkId, chunkData);
      await client.zAdd(`${roomId}:file:${fileId}:chunks`, {
        score: chunk.index ?? 0,
        value: chunkId
      });
      
      storedChunks.push(chunkData);
    }

    // Index file metadata
    await client.hSet(`${roomId}:file:${fileId}:meta`, {
      fileId,
      roomId,
      fileName: fileInfo.fileName,
      totalChunks: totalChunks.toString(),
      embeddedChunks: toEmbed.length.toString(),
      lazyChunks: lazyChunks.length.toString(),
      isLargeFile: 'true',
      createdAt: Date.now().toString()
    });

    // Embed selected chunks in batches
    this._emitProgress(io, socketId, fileId, 'embedding', {
      current: 0,
      total: toEmbed.length
    });

    const embeddedCount = await this._embedChunksBatch(
      roomId, 
      userId, 
      toEmbed, 
      fileInfo.fileName,
      io,
      socketId,
      fileId
    );

    // Create a summary entry for the file
    await this.vectorDB.createKnowledgeEntry(
      roomId,
      userId,
      `${fileInfo.fileName} (Overview)`,
      `Large document with ${totalChunks} chunks. ${embeddedCount} chunks initially embedded using strategic sampling. ` +
      `Sampling strategy: beginning (introduction), end (conclusion), middle (representative sections), and random distribution.`,
      ['large-file', fileInfo.fileType?.slice(1) || 'document', 'sampled'],
      [],
      { sourceMetadata: { fileName: fileInfo.fileName, totalChunks, embeddedChunks: embeddedCount } }
    );

    // Final progress update
    this._emitProgress(io, socketId, fileId, 'complete', {
      totalChunks,
      embeddedChunks: embeddedCount,
      lazyChunks: lazyChunks.length
    });

    return {
      fileId,
      totalChunks,
      embeddedChunks: embeddedCount,
      lazyChunks: lazyChunks.length,
      storedChunks
    };
  }

  /**
   * Embed chunks in batches with progress updates
   */
  async _embedChunksBatch(roomId, userId, chunks, fileName, io, socketId, fileId) {
    const BATCH_SIZE = 10;
    let embeddedCount = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      
      // Generate embeddings for batch
      const embeddings = await this.vectorDB.generateEmbeddingsBatch(
        batch.map(c => {
          const text = c.text || c.content || '';
          return `${fileName} part ${(c.index ?? 0) + 1}: ${text.slice(0, 1000)}`;
        })
      );

      // Store embedded knowledge entries
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = embeddings[j];

        if (embedding) {
          const chunkText = chunk.text || chunk.content || '';
          await this.vectorDB.createKnowledgeEntry(
            roomId,
            userId,
            `${fileName} (Part ${(chunk.index ?? 0) + 1})`,
            chunkText,
            ['file-upload', 'chunk', chunk.reason || 'embedded'],
            [],
            { 
              sourceMetadata: { 
                fileName, 
                chunkIndex: chunk.index ?? 0,
                sampleReason: chunk.reason || 'embedded'
              } 
            }
          );
          embeddedCount++;

          // Update chunk status
          const chunkId = `${roomId}:chunk:${fileId}:${chunk.index}`;
          await this.redisClient.getClient().hSet(chunkId, 'embedded', 'true');
        }
      }

      // Progress update
      this._emitProgress(io, socketId, fileId, 'embedding', {
        current: Math.min(i + BATCH_SIZE, chunks.length),
        total: chunks.length
      });

      // Small delay to prevent rate limiting
      if (i + BATCH_SIZE < chunks.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return embeddedCount;
  }

  /**
   * Lazily embed a chunk when it's accessed
   */
  async lazyEmbedChunk(roomId, userId, fileId, chunkIndex) {
    const client = this.redisClient.getClient();
    const chunkId = `${roomId}:chunk:${fileId}:${chunkIndex}`;
    
    const chunk = await client.hGetAll(chunkId);
    if (!chunk.id || chunk.embedded !== 'lazy') {
      return null; // Already embedded or doesn't exist
    }

    console.log(`LargeFileHandler: Lazy embedding chunk ${chunkIndex} of ${fileId}`);

    // Generate embedding
    const embedding = await this.vectorDB.generateEmbedding(
      `${chunk.fileName} part ${chunkIndex}: ${chunk.content.slice(0, 1000)}`
    );

    if (embedding) {
      // Create knowledge entry
      await this.vectorDB.createKnowledgeEntry(
        roomId,
        userId,
        `${chunk.fileName} (Part ${parseInt(chunkIndex) + 1})`,
        chunk.content,
        ['file-upload', 'chunk', 'lazy-embedded'],
        [],
        { sourceMetadata: { fileName: chunk.fileName, chunkIndex: parseInt(chunkIndex) } }
      );

      // Update status
      await client.hSet(chunkId, 'embedded', 'true');
      
      return true;
    }

    return false;
  }

  /**
   * Read chunks from a large file
   */
  async readLargeFileChunks(roomId, fileId, startChunk, endChunk) {
    const client = this.redisClient.getClient();
    const results = [];

    for (let i = startChunk; i <= endChunk; i++) {
      const chunkId = `${roomId}:chunk:${fileId}:${i}`;
      const chunk = await client.hGetAll(chunkId);
      
      if (chunk.id) {
        results.push({
          index: parseInt(chunk.chunkIndex),
          content: chunk.content,
          tokens: parseInt(chunk.tokens),
          embedded: chunk.embedded === 'true'
        });

        // Trigger lazy embedding if needed
        if (chunk.embedded === 'lazy') {
          // Fire and forget - don't wait
          this.lazyEmbedChunk(roomId, 'system', fileId, i);
        }
      }
    }

    return results;
  }

  /**
   * Search within a large file (keyword only, no vectors for unembedded chunks)
   */
  async searchInLargeFile(roomId, fileId, query) {
    const client = this.redisClient.getClient();
    const chunkIds = await client.zRange(`${roomId}:file:${fileId}:chunks`, 0, -1);
    
    const queryLower = query.toLowerCase();
    const results = [];

    for (const chunkId of chunkIds) {
      const chunk = await client.hGetAll(chunkId);
      if (chunk.content && chunk.content.toLowerCase().includes(queryLower)) {
        results.push({
          fileId: chunk.fileId,
          fileName: chunk.fileName,
          chunkIndex: parseInt(chunk.chunkIndex),
          content: chunk.content.slice(0, 300) + (chunk.content.length > 300 ? '...' : ''),
          embedded: chunk.embedded === 'true'
        });
      }
    }

    return results;
  }

  /**
   * Get statistics about a large file
   */
  async getLargeFileStats(roomId, fileId) {
    const client = this.redisClient.getClient();
    const meta = await client.hGetAll(`${roomId}:file:${fileId}:meta`);
    
    if (!meta.fileId) return null;

    const chunkIds = await client.zRange(`${roomId}:file:${fileId}:chunks`, 0, -1);
    let embeddedCount = 0;
    let lazyCount = 0;

    for (const chunkId of chunkIds) {
      const chunk = await client.hGetAll(chunkId);
      if (chunk.embedded === 'true') embeddedCount++;
      else if (chunk.embedded === 'lazy') lazyCount++;
    }

    return {
      fileId: meta.fileId,
      fileName: meta.fileName,
      totalChunks: parseInt(meta.totalChunks),
      embeddedChunks: embeddedCount,
      lazyChunks: lazyCount,
      pendingChunks: parseInt(meta.totalChunks) - embeddedCount - lazyCount
    };
  }

  /**
   * Emit progress updates to client
   */
  _emitProgress(io, socketId, fileId, status, data) {
    io.to(socketId).emit('file:progress', {
      fileId,
      status,
      timestamp: Date.now(),
      ...data
    });
  }

  /**
   * Cleanup large file data
   */
  async cleanupLargeFile(roomId, fileId) {
    const client = this.redisClient.getClient();
    
    const chunkIds = await client.zRange(`${roomId}:file:${fileId}:chunks`, 0, -1);
    
    if (chunkIds.length > 0) {
      await client.del(chunkIds);
    }
    
    await client.del(`${roomId}:file:${fileId}:chunks`);
    await client.del(`${roomId}:file:${fileId}:meta`);
    
    console.log(`LargeFileHandler: cleaned up ${chunkIds.length} chunks for ${fileId}`);
  }
}
