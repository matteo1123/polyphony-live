import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';

const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIMENSIONS = 768;
const MAX_CHUNK_SIZE = 8000; // Gemini embedding limit
const TARGET_CHUNK_TOKENS = 512; // Target ~512 tokens per chunk

export class VectorDB {
  constructor(redisClient) {
    this.redisClient = redisClient;
    this.genAI = null;
    this.embeddingModel = null;

    // Initialize embedding model
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.embeddingModel = this.genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
      console.log(`VectorDB initialized with embedding model: ${EMBEDDING_MODEL}`);
    } else {
      console.warn('VectorDB: No API key - embeddings disabled, using keyword search fallback');
    }
  }

  // Generate embedding for text with caching
  async generateEmbedding(text) {
    if (!this.embeddingModel) {
      return null;
    }

    try {
      // Truncate text if too long (embedding model has limits)
      const truncatedText = text.slice(0, MAX_CHUNK_SIZE);
      const result = await this.embeddingModel.embedContent(truncatedText);
      return result.embedding.values;
    } catch (error) {
      console.error('Embedding generation error:', error);
      return null;
    }
  }

  // Batch generate embeddings efficiently
  async generateEmbeddingsBatch(texts) {
    if (!this.embeddingModel || texts.length === 0) {
      return texts.map(() => null);
    }

    // Process in batches of 100 (API limit consideration)
    const batchSize = 100;
    const results = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(text => this.generateEmbedding(text));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }

  // Intelligent semantic chunking that preserves meaning
  chunkTextIntelligently(text, metadata = {}) {
    const chunks = [];
    
    // First, split into semantic units (paragraphs)
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    
    let currentChunk = '';
    let currentChunkTokens = 0;
    let chunkIndex = 0;
    
    const avgCharsPerToken = 4; // Rough estimate
    const targetChars = TARGET_CHUNK_TOKENS * avgCharsPerToken;
    
    for (const paragraph of paragraphs) {
      const paragraphTokens = paragraph.length / avgCharsPerToken;
      
      // If paragraph is very long, split by sentences
      if (paragraph.length > targetChars * 1.5) {
        // Flush current chunk if it has content
        if (currentChunk.trim()) {
          chunks.push({
            text: currentChunk.trim(),
            index: chunkIndex++,
            tokenEstimate: currentChunkTokens,
            ...metadata
          });
          currentChunk = '';
          currentChunkTokens = 0;
        }
        
        // Split long paragraph by sentences
        const sentences = paragraph.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [paragraph];
        
        for (const sentence of sentences) {
          const sentenceTokens = sentence.length / avgCharsPerToken;
          
          if (currentChunkTokens + sentenceTokens > TARGET_CHUNK_TOKENS && currentChunk.trim()) {
            chunks.push({
              text: currentChunk.trim(),
              index: chunkIndex++,
              tokenEstimate: currentChunkTokens,
              ...metadata
            });
            currentChunk = sentence;
            currentChunkTokens = sentenceTokens;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
            currentChunkTokens += sentenceTokens;
          }
        }
      } else {
        // Normal paragraph - check if adding it exceeds target
        if (currentChunkTokens + paragraphTokens > TARGET_CHUNK_TOKENS * 1.2 && currentChunk.trim()) {
          chunks.push({
            text: currentChunk.trim(),
            index: chunkIndex++,
            tokenEstimate: currentChunkTokens,
            ...metadata
          });
          currentChunk = paragraph;
          currentChunkTokens = paragraphTokens;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
          currentChunkTokens += paragraphTokens;
        }
      }
    }
    
    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        index: chunkIndex++,
        tokenEstimate: currentChunkTokens,
        ...metadata
      });
    }
    
    return chunks;
  }

  // Create knowledge entry with optional chunking
  async createKnowledgeEntry(roomId, userId, topic, content, tags = [], relationships = [], options = {}) {
    const { chunkLargeContent = false, sourceMetadata = {} } = options;
    
    // If content is very large and chunking is enabled, chunk it
    if (chunkLargeContent && content.length > MAX_CHUNK_SIZE) {
      const chunks = this.chunkTextIntelligently(content, { topic, ...sourceMetadata });
      const entries = [];
      
      // Generate embeddings for all chunks in batch
      const textsToEmbed = chunks.map(c => `${c.topic || topic}: ${c.text}`);
      const embeddings = await this.generateEmbeddingsBatch(textsToEmbed);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const entryId = `${roomId}:knowledge:${uuidv4()}`;
        
        const entry = {
          id: entryId,
          roomId,
          userId,
          topic: chunks.length > 1 ? `${topic} (Part ${i + 1}/${chunks.length})` : topic,
          content: chunk.text,
          tags: JSON.stringify([...tags, ...(i === 0 ? [] : ['chunk']), ...(chunk.tags || [])]),
          relationships: JSON.stringify(relationships),
          embedding: embeddings[i] ? JSON.stringify(embeddings[i]) : null,
          chunkIndex: i,
          totalChunks: chunks.length,
          createdAt: Date.now().toString()
        };
        
        await this._storeEntry(client, entryId, entry, roomId, tags);
        entries.push({ id: entryId, topic: entry.topic, content: chunk.text, tags });
      }
      
      console.log(`VectorDB: created ${entries.length} chunked entries for "${topic}" in room ${roomId}`);
      return entries;
    }
    
    // Single entry
    const entryId = `${roomId}:knowledge:${uuidv4()}`;
    const embedding = await this.generateEmbedding(`${topic} ${content}`);
    
    const entry = {
      id: entryId,
      roomId,
      userId,
      topic,
      content,
      tags: JSON.stringify(tags),
      relationships: JSON.stringify(relationships),
      embedding: embedding ? JSON.stringify(embedding) : null,
      chunkIndex: 0,
      totalChunks: 1,
      createdAt: Date.now().toString()
    };
    
    await this._storeEntry(this.redisClient.getClient(), entryId, entry, roomId, tags);
    
    console.log(`VectorDB: created knowledge entry "${topic}" in room ${roomId}`);
    return [{ id: entryId, topic, content, tags }];
  }

  // Helper to store entry in Redis
  async _storeEntry(client, entryId, entry, roomId, tags) {
    await client.hSet(entryId, entry);
    await client.zAdd(`${roomId}:knowledge`, {
      score: Date.now(),
      value: entryId
    });
    
    for (const tag of tags) {
      await client.sAdd(`${roomId}:tag:${tag.toLowerCase()}`, entryId);
    }
  }

  // Hybrid search: Vector + Keyword + Fuzzy + Recency
  async searchKnowledge(roomId, query, limit = 10, filterTags = []) {
    const client = this.redisClient.getClient();
    const startTime = Date.now();

    // Get all knowledge entries for the room
    let entryIds = await client.zRange(`${roomId}:knowledge`, 0, -1);
    
    if (entryIds.length === 0) {
      return [];
    }

    // Filter by tags if specified
    if (filterTags.length > 0) {
      entryIds = await this._filterByTags(client, roomId, entryIds, filterTags);
      if (entryIds.length === 0) return [];
    }

    // Fetch all entries in batch using pipeline pattern
    const entries = await this._fetchEntries(client, entryIds);
    if (entries.length === 0) return [];

    // Generate query embedding once
    const queryEmbedding = await this.generateEmbedding(query);
    const queryLower = query.toLowerCase();
    const queryTerms = this._extractTerms(queryLower);

    // Score all entries using multiple signals
    const scoredEntries = entries.map(entry => {
      const scores = {
        vector: 0,
        keyword: 0,
        fuzzy: 0,
        recency: 0,
        tagMatch: 0
      };

      // 1. Vector similarity (semantic meaning)
      if (queryEmbedding && entry.embedding) {
        scores.vector = this.cosineSimilarity(queryEmbedding, entry.embedding);
      }

      // 2. Keyword matching (exact matches)
      scores.keyword = this.keywordScore(queryTerms, entry);

      // 3. Fuzzy matching (typo tolerance)
      scores.fuzzy = this.fuzzyScore(queryLower, entry);

      // 4. Recency boost (newer entries get slight boost)
      const ageHours = (Date.now() - entry.createdAt) / (1000 * 60 * 60);
      scores.recency = Math.max(0, 1 - (ageHours / 168)); // Decay over 1 week

      // 5. Tag relevance boost
      if (entry.tags && entry.tags.length > 0) {
        const entryTags = entry.tags.map(t => t.toLowerCase());
        const matchingTags = queryTerms.filter(term => 
          entryTags.some(tag => tag.includes(term) || term.includes(tag))
        );
        scores.tagMatch = matchingTags.length / Math.max(queryTerms.length, entryTags.length);
      }

      // Combined score with weights
      const combinedScore = 
        scores.vector * 0.45 +      // Semantic meaning
        scores.keyword * 0.30 +     // Exact matches
        scores.fuzzy * 0.10 +       // Typo tolerance
        scores.recency * 0.05 +     // Freshness
        scores.tagMatch * 0.10;     // Tag relevance

      return {
        ...entry,
        scores,
        score: combinedScore
      };
    });

    // Sort by combined score
    scoredEntries.sort((a, b) => b.score - a.score);

    // Take top results
    const topResults = scoredEntries.slice(0, limit);

    // Re-rank top candidates for better precision
    const rerankedResults = await this._rerankResults(query, topResults);

    const duration = Date.now() - startTime;
    console.log(`VectorDB: searched ${entries.length} entries in ${duration}ms, found ${rerankedResults.length} results for query: "${query.slice(0, 50)}..."`);

    return rerankedResults.map(e => ({
      id: e.id,
      topic: e.topic,
      content: e.content,
      tags: e.tags,
      relationships: e.relationships,
      score: Math.round(e.score * 1000) / 1000,
      createdAt: e.createdAt
    }));
  }

  // Filter entries by tags (intersection)
  async _filterByTags(client, roomId, entryIds, filterTags) {
    const tagSets = await Promise.all(
      filterTags.map(tag => client.sMembers(`${roomId}:tag:${tag.toLowerCase()}`))
    );
    
    const tagEntryIds = new Set(tagSets[0] || []);
    for (let i = 1; i < tagSets.length; i++) {
      const nextSet = new Set(tagSets[i] || []);
      for (const id of tagEntryIds) {
        if (!nextSet.has(id)) tagEntryIds.delete(id);
      }
    }
    
    return entryIds.filter(id => tagEntryIds.has(id));
  }

  // Fetch entries with proper parsing
  async _fetchEntries(client, entryIds) {
    const entries = [];
    for (const entryId of entryIds) {
      const entry = await client.hGetAll(entryId);
      if (Object.keys(entry).length > 0) {
        entries.push({
          ...entry,
          tags: JSON.parse(entry.tags || '[]'),
          relationships: JSON.parse(entry.relationships || '[]'),
          embedding: entry.embedding ? JSON.parse(entry.embedding) : null,
          createdAt: parseInt(entry.createdAt) || 0
        });
      }
    }
    return entries;
  }

  // Extract search terms from query
  _extractTerms(query) {
    // Remove punctuation and split
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2); // Filter out very short words
  }

  // Enhanced keyword scoring with TF-IDF-like weighting
  keywordScore(queryTerms, entry) {
    if (!queryTerms.length) return 0;
    
    const text = `${entry.topic} ${entry.content}`.toLowerCase();
    const textTerms = this._extractTerms(text);
    
    // Calculate term frequency in document
    const termFreq = {};
    textTerms.forEach(term => { termFreq[term] = (termFreq[term] || 0) + 1; });
    
    let score = 0;
    let matchedTerms = 0;
    
    for (const term of queryTerms) {
      // Exact match
      if (text.includes(term)) {
        const tf = termFreq[term] || 0;
        const idf = Math.log(1 + 1 / (tf + 1)); // Simple IDF
        score += (1 + tf) * (1 + idf);
        matchedTerms++;
      }
      
      // Title match gets higher weight
      if (entry.topic.toLowerCase().includes(term)) {
        score += 2;
      }
    }
    
    // Normalize by query length
    const coverage = matchedTerms / queryTerms.length;
    return (score / queryTerms.length) * (0.5 + 0.5 * coverage);
  }

  // Fuzzy matching for typo tolerance
  fuzzyScore(query, entry) {
    const text = `${entry.topic} ${entry.content}`.toLowerCase();
    const queryWords = query.split(/\s+/);
    const textWords = text.split(/\s+/);
    
    let totalScore = 0;
    
    for (const qWord of queryWords) {
      if (qWord.length < 3) continue; // Skip short words
      
      let bestMatch = 0;
      for (const tWord of textWords) {
        if (tWord.length < 3) continue;
        
        const similarity = this._levenshteinSimilarity(qWord, tWord);
        if (similarity > bestMatch) {
          bestMatch = similarity;
        }
      }
      
      totalScore += bestMatch;
    }
    
    return queryWords.length > 0 ? totalScore / queryWords.length : 0;
  }

  // Levenshtein similarity (0-1)
  _levenshteinSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    
    const distance = this._levenshteinDistance(a, b);
    const maxLen = Math.max(a.length, b.length);
    return 1 - distance / maxLen;
  }

  // Calculate Levenshtein distance
  _levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  // Re-rank top results for better precision
  async _rerankResults(query, candidates) {
    if (candidates.length <= 1) return candidates;
    
    // Simple re-ranking: boost results that have more query terms
    return candidates.map(c => {
      const queryTerms = this._extractTerms(query);
      const text = `${c.topic} ${c.content}`.toLowerCase();
      
      let termMatches = 0;
      let phraseMatches = 0;
      
      for (const term of queryTerms) {
        if (text.includes(term)) termMatches++;
      }
      
      // Check for phrase matches
      const queryLower = query.toLowerCase();
      if (text.includes(queryLower)) {
        phraseMatches = 2; // Big boost for exact phrase match
      }
      
      const termCoverage = termMatches / queryTerms.length;
      const boost = (termCoverage * 0.1) + (phraseMatches * 0.15);
      
      return {
        ...c,
        score: Math.min(1, c.score + boost)
      };
    }).sort((a, b) => b.score - a.score);
  }

  // Cosine similarity between two vectors
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  // Get all knowledge entries for a room (for display/export)
  async getAllKnowledge(roomId) {
    const client = this.redisClient.getClient();
    const entryIds = await client.zRange(`${roomId}:knowledge`, 0, -1);

    const entries = [];
    for (const entryId of entryIds) {
      const entry = await client.hGetAll(entryId);
      if (Object.keys(entry).length > 0) {
        entries.push({
          id: entry.id,
          topic: entry.topic,
          content: entry.content,
          tags: JSON.parse(entry.tags || '[]'),
          relationships: JSON.parse(entry.relationships || '[]'),
          userId: entry.userId,
          createdAt: parseInt(entry.createdAt),
          chunkIndex: parseInt(entry.chunkIndex) || 0,
          totalChunks: parseInt(entry.totalChunks) || 1
        });
      }
    }

    return entries;
  }

  // Delete a knowledge entry
  async deleteKnowledgeEntry(roomId, entryId) {
    const client = this.redisClient.getClient();

    // Get entry to find its tags
    const entry = await client.hGetAll(entryId);
    if (entry.tags) {
      const tags = JSON.parse(entry.tags);
      for (const tag of tags) {
        await client.sRem(`${roomId}:tag:${tag.toLowerCase()}`, entryId);
      }
    }

    // Remove from index and delete
    await client.zRem(`${roomId}:knowledge`, entryId);
    await client.del(entryId);
  }

  // Cleanup room knowledge
  async cleanupRoom(roomId) {
    const client = this.redisClient.getClient();

    // Get all entries
    const entryIds = await client.zRange(`${roomId}:knowledge`, 0, -1);

    // Delete each entry
    for (const entryId of entryIds) {
      await client.del(entryId);
    }

    // Delete index and tag sets
    const keys = await client.keys(`${roomId}:knowledge*`);
    const tagKeys = await client.keys(`${roomId}:tag:*`);
    const allKeys = [...keys, ...tagKeys];

    if (allKeys.length > 0) {
      await client.del(allKeys);
    }

    console.log(`VectorDB: cleaned up room ${roomId} (${entryIds.length} entries)`);
  }

  // Get search statistics for a room
  async getStats(roomId) {
    const client = this.redisClient.getClient();
    const entryCount = await client.zCard(`${roomId}:knowledge`);
    const tagKeys = await client.keys(`${roomId}:tag:*`);
    
    return {
      entryCount,
      tagCount: tagKeys.length
    };
  }
}
