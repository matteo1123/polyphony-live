import { v4 as uuidv4 } from 'uuid';

// Simplified for demo - just hard limits
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CHUNKS = 100; // Hard limit for demo (plenty for 512MB RAM)

/**
 * Simplified file handler for demo purposes
 * No complex sampling - just embed all chunks up to MAX_CHUNKS
 */
export class LargeFileHandler {
  constructor(redisClient, vectorDB) {
    this.redisClient = redisClient;
    this.vectorDB = vectorDB;
  }

  /**
   * Check if file is too large
   */
  isTooLarge(contentLength) {
    return contentLength > MAX_FILE_SIZE;
  }

  /**
   * Process file upload - simplified for demo
   */
  async processFile(roomId, userId, fileInfo, chunks, io, socketId) {
    const totalChunks = chunks.length;
    
    // Simple limit - if too many chunks, just take first MAX_CHUNKS
    // For demo, this is fine - users should split huge docs
    const chunksToProcess = chunks.slice(0, MAX_CHUNKS);
    const wasTruncated = totalChunks > MAX_CHUNKS;
    
    console.log(`Processing ${chunksToProcess.length}/${totalChunks} chunks for ${fileInfo.fileName}`);

    // Notify client
    io.to(socketId).emit('file:progress', {
      fileId: fileInfo.fileId,
      status: 'embedding',
      current: 0,
      total: chunksToProcess.length
    });

    // Embed chunks in batches
    const embeddedCount = await this.embedChunksBatch(
      roomId, 
      userId, 
      fileInfo, 
      chunksToProcess,
      io,
      socketId
    );

    // Create overview entry
    await this.vectorDB.createKnowledgeEntry(
      roomId,
      userId,
      `${fileInfo.fileName} (Overview)`,
      `Document with ${totalChunks} chunks${wasTruncated ? ` (first ${MAX_CHUNKS} embedded)` : ''}. ` +
      `File type: ${fileInfo.fileType}. Processed ${embeddedCount} chunks.`,
      ['file-overview', fileInfo.fileType?.slice(1) || 'document'],
      [],
      { sourceMetadata: { fileName: fileInfo.fileName, totalChunks, embeddedChunks: embeddedCount } }
    );

    return {
      fileId: fileInfo.fileId,
      totalChunks,
      embeddedChunks: embeddedCount,
      wasTruncated,
      message: wasTruncated 
        ? `Large document: embedded first ${MAX_CHUNKS} of ${totalChunks} sections. Split into smaller files for complete coverage.`
        : `Document processed: ${embeddedCount} sections embedded.`
    };
  }

  /**
   * Embed chunks in batches
   */
  async embedChunksBatch(roomId, userId, fileInfo, chunks, io, socketId) {
    const BATCH_SIZE = 10;
    let embeddedCount = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      
      // Generate embeddings for batch
      const embeddings = await this.vectorDB.generateEmbeddingsBatch(
        batch.map(c => `${fileInfo.fileName} part ${(c.index ?? 0) + 1}: ${(c.text || c.content || '').slice(0, 1000)}`)
      );

      // Store embedded knowledge entries
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = embeddings[j];
        const chunkText = chunk.text || chunk.content || '';

        if (embedding) {
          await this.vectorDB.createKnowledgeEntry(
            roomId,
            userId,
            `${fileInfo.fileName} (Part ${(chunk.index ?? 0) + 1})`,
            chunkText,
            ['file-upload', 'chunk'],
            [],
            { 
              sourceMetadata: { 
                fileName: fileInfo.fileName, 
                chunkIndex: chunk.index ?? 0 
              } 
            }
          );
          embeddedCount++;
        }
      }

      // Progress update
      io.to(socketId).emit('file:progress', {
        fileId: fileInfo.fileId,
        status: 'embedding',
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
}
