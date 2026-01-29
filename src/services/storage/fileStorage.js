import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const BASE_DIR = '/tmp/polyphony';

// Intelligent chunking configuration
const CHUNK_CONFIG = {
  targetTokens: 512,        // Target tokens per chunk
  maxTokens: 1024,          // Maximum tokens per chunk
  overlapTokens: 64,        // Overlap between chunks for context
  minChunkTokens: 100       // Minimum tokens to keep a chunk
};

// Average characters per token (rough estimate for mixed text)
const CHARS_PER_TOKEN = 4;

export class FileStorage {
  constructor() {
    this.files = new Map(); // fileId -> file metadata
  }

  async init() {
    // Ensure base directory exists
    await fs.mkdir(BASE_DIR, { recursive: true });
    console.log('FileStorage initialized at', BASE_DIR);
  }

  async ensureRoomDir(roomId) {
    const roomDir = path.join(BASE_DIR, roomId);
    await fs.mkdir(roomDir, { recursive: true });
    return roomDir;
  }

  // Estimate token count from text
  estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  // Intelligent semantic chunking
  chunkTextIntelligently(text, sourceInfo = {}) {
    const chunks = [];
    const targetChars = CHUNK_CONFIG.targetTokens * CHARS_PER_TOKEN;
    const maxChars = CHUNK_CONFIG.maxTokens * CHARS_PER_TOKEN;
    const overlapChars = CHUNK_CONFIG.overlapTokens * CHARS_PER_TOKEN;
    const minChars = CHUNK_CONFIG.minChunkTokens * CHARS_PER_TOKEN;

    // Split into semantic units first (paragraphs)
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    
    let currentChunk = '';
    let currentTokens = 0;
    let chunkIndex = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const paragraphTokens = this.estimateTokens(paragraph);

      // Handle very long paragraphs - split by sentences
      if (paragraph.length > maxChars) {
        // Flush current chunk if it has content
        if (currentChunk.trim()) {
          chunks.push(this._createChunk(currentChunk, chunkIndex++, sourceInfo));
          currentChunk = '';
          currentTokens = 0;
        }

        // Split paragraph by sentences
        const sentences = paragraph.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [paragraph];
        
        for (const sentence of sentences) {
          const sentenceTokens = this.estimateTokens(sentence);
          
          if (currentTokens + sentenceTokens > CHUNK_CONFIG.maxTokens && currentChunk.trim()) {
            chunks.push(this._createChunk(currentChunk, chunkIndex++, sourceInfo));
            // Keep overlap for context
            const words = currentChunk.split(/\s+/);
            const overlapWords = words.slice(-CHUNK_CONFIG.overlapTokens);
            currentChunk = overlapWords.join(' ') + ' ' + sentence;
            currentTokens = this.estimateTokens(currentChunk);
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
            currentTokens += sentenceTokens;
          }
        }
      } else {
        // Normal paragraph - check if adding it exceeds target
        if (currentTokens + paragraphTokens > CHUNK_CONFIG.maxTokens * 1.2 && currentChunk.trim()) {
          chunks.push(this._createChunk(currentChunk, chunkIndex++, sourceInfo));
          
          // Add overlap for context continuity
          const words = currentChunk.split(/\s+/);
          const overlapText = words.slice(-CHUNK_CONFIG.overlapTokens / 2).join(' ');
          currentChunk = overlapText + '\n\n' + paragraph;
          currentTokens = this.estimateTokens(currentChunk);
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
          currentTokens += paragraphTokens;
        }
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim() && currentChunk.length >= minChars) {
      chunks.push(this._createChunk(currentChunk, chunkIndex++, sourceInfo));
    }

    return chunks;
  }

  _createChunk(text, index, sourceInfo) {
    return {
      text: text.trim(),
      index,
      tokens: this.estimateTokens(text),
      ...sourceInfo
    };
  }

  // Save a file and parse it into intelligent chunks
  async saveFile(roomId, fileName, fileType, content) {
    const roomDir = await this.ensureRoomDir(roomId);
    const fileId = uuidv4();
    const filePath = path.join(roomDir, `${fileId}${fileType}`);

    // Parse content based on type
    let textContent;
    let parseError = null;
    
    try {
      if (fileType === '.txt' || fileType === '.md') {
        textContent = typeof content === 'string' ? content : content.toString('utf-8');
        await fs.writeFile(filePath, textContent, 'utf-8');
      } else if (fileType === '.pdf') {
        textContent = await this.parsePDF(content);
        await fs.writeFile(filePath, Buffer.from(content));
      } else if (fileType === '.docx') {
        textContent = await this.parseDOCX(content);
        await fs.writeFile(filePath, Buffer.from(content));
      } else {
        throw new Error(`Unsupported file type: ${fileType}`);
      }
    } catch (error) {
      parseError = error.message;
      console.error(`FileStorage: error parsing ${fileName}:`, error.message);
      // Still save the file but with error info
      textContent = `[Error parsing file: ${error.message}]`;
    }

    // Clean up text
    textContent = this.cleanText(textContent);

    // Create intelligent chunks
    const chunks = this.chunkTextIntelligently(textContent, {
      sourceFile: fileName,
      sourceType: fileType
    });

    // Store metadata
    const metadata = {
      fileId,
      roomId,
      fileName,
      fileType,
      filePath,
      totalChars: textContent.length,
      totalTokens: this.estimateTokens(textContent),
      chunkCount: chunks.length,
      chunks, // Store chunks in memory for quick access
      parseError,
      createdAt: Date.now()
    };

    this.files.set(fileId, metadata);

    console.log(`FileStorage: saved ${fileName} (${chunks.length} chunks, ${metadata.totalTokens} tokens, ${parseError ? 'PARSE ERROR' : 'OK'})`);

    return {
      fileId,
      fileName,
      fileType,
      chunkCount: chunks.length,
      totalTokens: metadata.totalTokens,
      totalChars: metadata.totalChars,
      parseError
    };
  }

  // Clean up extracted text
  cleanText(text) {
    return text
      .replace(/\r\n/g, '\n')           // Normalize line endings
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')       // Max 2 consecutive newlines
      .replace(/[\t ]+/g, ' ')          // Normalize whitespace
      .replace(/^ +/gm, '')             // Remove leading spaces
      .replace(/ +$/gm, '')             // Remove trailing spaces
      .trim();
  }

  // Parse PDF content
  async parsePDF(content) {
    try {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const buffer = Buffer.from(content);
      const data = await pdfParse(buffer);
      return data.text;
    } catch (error) {
      console.error('PDF parsing error:', error);
      throw new Error('Failed to parse PDF file');
    }
  }

  // Parse DOCX content
  async parseDOCX(content) {
    try {
      const mammoth = await import('mammoth');
      const buffer = Buffer.from(content);
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (error) {
      console.error('DOCX parsing error:', error);
      throw new Error('Failed to parse DOCX file');
    }
  }

  // Read specific chunk(s) from a file
  readFileSection(fileId, startChunk, endChunk) {
    const metadata = this.files.get(fileId);
    if (!metadata) {
      return { error: `File not found: ${fileId}` };
    }

    // Validate chunk numbers (0-indexed)
    const start = Math.max(0, startChunk);
    const end = Math.min(metadata.chunkCount - 1, endChunk);

    if (start >= metadata.chunkCount) {
      return {
        fileId,
        fileName: metadata.fileName,
        error: `Start chunk ${startChunk} exceeds file length (${metadata.chunkCount} chunks)`
      };
    }

    const chunks = metadata.chunks.slice(start, end + 1);

    return {
      fileId,
      fileName: metadata.fileName,
      startChunk: start,
      endChunk: end,
      totalChunks: metadata.chunkCount,
      content: chunks.map(c => c.text).join('\n\n--- Chunk Break ---\n\n'),
      tokens: chunks.reduce((sum, c) => sum + c.tokens, 0)
    };
  }

  // Get specific chunk by index
  getChunk(fileId, chunkIndex) {
    const metadata = this.files.get(fileId);
    if (!metadata) {
      return { error: `File not found: ${fileId}` };
    }

    if (chunkIndex < 0 || chunkIndex >= metadata.chunkCount) {
      return {
        fileId,
        fileName: metadata.fileName,
        error: `Invalid chunk index: ${chunkIndex}`
      };
    }

    const chunk = metadata.chunks[chunkIndex];
    return {
      fileId,
      fileName: metadata.fileName,
      chunkIndex,
      totalChunks: metadata.chunkCount,
      content: chunk.text,
      tokens: chunk.tokens
    };
  }

  // Get file metadata
  getFileMetadata(fileId) {
    return this.files.get(fileId);
  }

  // List all files in a room
  listRoomFiles(roomId) {
    const files = [];
    for (const [fileId, metadata] of this.files) {
      if (metadata.roomId === roomId) {
        files.push({
          fileId,
          fileName: metadata.fileName,
          fileType: metadata.fileType,
          chunkCount: metadata.chunkCount,
          totalTokens: metadata.totalTokens,
          totalChars: metadata.totalChars,
          parseError: metadata.parseError,
          createdAt: metadata.createdAt
        });
      }
    }
    return files;
  }

  // Get chunk info for all files in a room (for embedding)
  getAllChunks(roomId) {
    const chunks = [];
    for (const [fileId, metadata] of this.files) {
      if (metadata.roomId === roomId) {
        for (const chunk of metadata.chunks) {
          chunks.push({
            fileId,
            fileName: metadata.fileName,
            chunkIndex: chunk.index,
            totalChunks: metadata.chunkCount,
            content: chunk.text,
            tokens: chunk.tokens
          });
        }
      }
    }
    return chunks;
  }

  // Search within file content
  searchInFiles(roomId, query) {
    const queryLower = query.toLowerCase();
    const results = [];

    for (const [fileId, metadata] of this.files) {
      if (metadata.roomId !== roomId) continue;

      for (const chunk of metadata.chunks) {
        if (chunk.text.toLowerCase().includes(queryLower)) {
          results.push({
            fileId,
            fileName: metadata.fileName,
            chunkIndex: chunk.index,
            content: chunk.text.slice(0, 200) + (chunk.text.length > 200 ? '...' : ''),
            tokens: chunk.tokens
          });
        }
      }
    }

    return results;
  }

  // Cleanup room files
  async cleanupRoom(roomId) {
    const roomDir = path.join(BASE_DIR, roomId);

    // Remove files from memory
    let fileCount = 0;
    for (const [fileId, metadata] of this.files) {
      if (metadata.roomId === roomId) {
        this.files.delete(fileId);
        fileCount++;
      }
    }

    // Remove directory
    try {
      await fs.rm(roomDir, { recursive: true, force: true });
      console.log(`FileStorage: cleaned up room ${roomId} (${fileCount} files)`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`FileStorage: error cleaning up room ${roomId}:`, error);
      }
    }
  }

  // Get storage statistics
  getStats() {
    let totalFiles = 0;
    let totalChunks = 0;
    let totalTokens = 0;

    for (const metadata of this.files.values()) {
      totalFiles++;
      totalChunks += metadata.chunkCount;
      totalTokens += metadata.totalTokens;
    }

    return {
      totalFiles,
      totalChunks,
      totalTokens,
      rooms: new Set([...this.files.values()].map(m => m.roomId)).size
    };
  }
}
