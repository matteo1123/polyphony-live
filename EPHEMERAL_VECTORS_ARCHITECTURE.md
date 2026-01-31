# Architecture: Persistent Text, Ephemeral Vectors

## Core Insight

| Data Type | Size | Persistence | Storage |
|-----------|------|-------------|---------|
| **Text content** | ~500KB per meeting | ✅ Persistent | Convex |
| **Vectors** | ~6MB per meeting (1000 chunks) | ❌ Ephemeral | Redis |
| **Session state** | ~10KB | ❌ Ephemeral | Redis |

**100 meetings × 6MB vectors = 600MB of ephemeral data** (cleared when inactive)
**100 meetings × 500KB text = 50MB of persistent data** (cheap to store)

---

## Architecture Flow

### When First User Joins (Room Activation)

```
User joins room "meeting-123"
    ↓
Check: Is room already active?
    ↓ NO
Fetch documents from Convex (text only, no vectors)
    ↓
Generate embeddings via Gemini API
    ↓
Store vectors in Redis (ephemeral)
    ↓
Room is now active - fast vector search available
```

### During Active Session

```
User asks question
    ↓
Redis vector search (fast, in-memory)
    ↓
Return grounded response
```

### When Last User Leaves (Room Deactivation)

```
Last user disconnects
    ↓
Delete ALL vectors from Redis
    ↓
Keep documents in Convex (already there)
    ↓
Room deactivated - RAM freed
```

### When Users Return to Old Meeting

```
User returns to "meeting-123" (2 days later)
    ↓
Fetch documents from Convex (text preserved)
    ↓
Re-generate embeddings
    ↓
Store new vectors in Redis
    ↓
Room re-activated - full search capability restored
```

---

## Why This Architecture is Perfect

### 1. **Memory Efficient**
- Only active meetings consume RAM
- 100 inactive meetings = 0 RAM usage for vectors
- Text storage in Convex is cheap (~$0.25/GB/month)

### 2. **Cost Efficient**
- Re-embedding only happens when meetings are revisited
- Most meetings are accessed once, never revisited = no re-embedding cost
- Gemini embedding API: ~$0.0001 per 1K tokens (very cheap)

### 3. **Scalable**
- Can have 10,000 archived meetings (just text in Convex)
- Only 3-5 active at a time (vectors in Redis)
- Redis can handle ~50 active meetings easily

### 4. **Persistent Where It Matters**
- Document content never lost
- Meeting summaries preserved
- Can always return and search again

### 5. **Fast When Active**
- Vector search is in-memory (Redis)
- No network calls for embeddings during queries
- Re-embedding happens once per "activation"

---

## Implementation Plan

### 1. Convex Schema (Persistent Storage)

```typescript
// convex/schema.ts
export default defineSchema({
  // ... existing tables ...

  // PERSISTENT: Meeting rooms (metadata only, no vectors)
  meetingRooms: defineTable({
    roomId: v.string(),
    name: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.string(),
    lastActiveAt: v.number(),
    status: v.string(), // 'active', 'archived', 'closed'
    participantCount: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_status", ["status"]),

  // PERSISTENT: Document metadata and text (no vectors!)
  documents: defineTable({
    roomId: v.string(),
    documentId: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    totalChunks: v.number(),
    extractedTopics: v.array(v.string()),
    uploadedBy: v.string(),
    uploadedAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_documentId", ["documentId"]),

  // PERSISTENT: Document chunks (text only, no vectors!)
  documentChunks: defineTable({
    roomId: v.string(),
    documentId: v.string(),
    chunkIndex: v.number(),
    totalChunks: v.number(),
    content: v.string(),  // The text content
    tokenEstimate: v.number(),
    tags: v.array(v.string()),
    // NOTE: No embedding field! Vectors are ephemeral in Redis
  })
    .index("by_roomId", ["roomId"])
    .index("by_documentId", ["documentId"])
    .index("by_roomId_documentId", ["roomId", "documentId"]),

  // PERSISTENT: Synthesized knowledge (text only)
  knowledgeEntries: defineTable({
    roomId: v.string(),
    entryId: v.string(),
    userId: v.string(),
    userName: v.string(),
    topic: v.string(),
    content: v.string(),
    tags: v.array(v.string()),
    importance: v.number(),
    type: v.string(),
    sources: v.array(v.string()), // Source document names
    createdAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_roomId_importance", ["roomId", "importance"]),

  // PERSISTENT: Canvas state (for restoration)
  canvasStates: defineTable({
    roomId: v.string(),
    centralIdea: v.optional(v.string()),
    hierarchy: v.any(), // JSON structure
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_roomId", ["roomId"]),
});
```

### 2. Room Lifecycle Manager

```typescript
// src/services/roomLifecycleManager.ts
export class RoomLifecycleManager {
  constructor(
    private convexClient: ConvexService,
    private redisClient: RedisClient,
    private vectorDB: VectorDB
  ) {}

  async activateRoom(roomId: string): Promise<boolean> {
    console.log(`Activating room ${roomId}...`);
    
    // 1. Check if already active in Redis
    const isActive = await this.redisClient.isRoomActive(roomId);
    if (isActive) {
      console.log(`Room ${roomId} already active`);
      return true;
    }

    // 2. Fetch documents from Convex
    const documents = await this.convexClient.getDocumentsForRoom(roomId);
    if (documents.length === 0) {
      console.log(`No documents found for room ${roomId}`);
      return false;
    }

    // 3. Generate embeddings and store in Redis
    console.log(`Generating embeddings for ${documents.length} documents...`);
    for (const doc of documents) {
      const chunks = await this.convexClient.getChunksForDocument(doc.documentId);
      
      for (const chunk of chunks) {
        const embedding = await this.vectorDB.generateEmbedding(
          `${doc.fileName}: ${chunk.content}`
        );
        
        await this.redisClient.storeVector(roomId, {
          id: `${roomId}:${doc.documentId}:${chunk.chunkIndex}`,
          content: chunk.content,
          embedding,
          metadata: {
            fileName: doc.fileName,
            chunkIndex: chunk.chunkIndex,
            documentId: doc.documentId,
          }
        });
      }
    }

    // 4. Mark room as active
    await this.redisClient.markRoomActive(roomId);
    console.log(`Room ${roomId} activated with vectors`);
    
    return true;
  }

  async deactivateRoom(roomId: string): Promise<void> {
    console.log(`Deactivating room ${roomId} - clearing vectors...`);
    
    // Delete ALL vectors for this room from Redis
    await this.redisClient.deleteAllVectorsForRoom(roomId);
    await this.redisClient.markRoomInactive(roomId);
    
    // Persist final canvas state to Convex
    const canvasState = await this.redisClient.getCanvasState(roomId);
    if (canvasState) {
      await this.convexClient.saveCanvasState(roomId, canvasState);
    }
    
    console.log(`Room ${roomId} deactivated, vectors cleared`);
  }

  async onUserJoin(roomId: string, userId: string): Promise<void> {
    // Ensure room is active (has vectors)
    await this.activateRoom(roomId);
    
    // Update participant count
    await this.redisClient.addUserToRoom(roomId, userId);
    await this.convexClient.updateRoomActivity(roomId);
  }

  async onUserLeave(roomId: string, userId: string): Promise<void> {
    await this.redisClient.removeUserFromRoom(roomId, userId);
    
    // Check if last user
    const userCount = await this.redisClient.getRoomUserCount(roomId);
    if (userCount === 0) {
      // Grace period before deactivation (e.g., 5 minutes)
      setTimeout(async () => {
        const stillEmpty = await this.redisClient.getRoomUserCount(roomId) === 0;
        if (stillEmpty) {
          await this.deactivateRoom(roomId);
        }
      }, 5 * 60 * 1000);
    }
  }
}
```

### 3. Updated VectorDB (Redis-only, ephemeral)

```typescript
// src/services/vectorDB.ts
export class VectorDB {
  // Only Redis - no persistent storage
  constructor(private redisClient: RedisClient) {}

  async generateEmbedding(text: string): Promise<number[]> {
    // Call Gemini API
    const result = await this.embeddingModel.embedContent(text);
    return result.embedding.values;
  }

  async searchKnowledge(
    roomId: string, 
    query: string, 
    limit: number = 12
  ): Promise<SearchResult[]> {
    // 1. Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);
    
    // 2. Search Redis (fast, in-memory)
    const results = await this.redisClient.vectorSearch(
      roomId, 
      queryEmbedding, 
      limit
    );
    
    return results;
  }

  async createKnowledgeEntry(
    roomId: string,
    userId: string,
    topic: string,
    content: string,
    tags: string[]
  ): Promise<void> {
    // 1. Store in Redis (ephemeral, for search)
    const embedding = await this.generateEmbedding(`${topic} ${content}`);
    await this.redisClient.storeKnowledgeEntry(roomId, {
      id: `${roomId}:knowledge:${uuidv4()}`,
      topic,
      content,
      embedding,
      tags,
      userId,
      createdAt: Date.now(),
    });

    // 2. Also persist to Convex (text only, no embedding)
    await this.convexClient.createKnowledgeEntry({
      roomId,
      userId,
      topic,
      content,
      tags,
      // NOTE: No embedding stored in Convex!
    });
  }
}
```

### 4. Migration Path

```typescript
// One-time migration script
async function migrateFromRedisToConvex() {
  const allRooms = await redisClient.getAllRoomIds();
  
  for (const roomId of allRooms) {
    // 1. Copy documents to Convex (text only)
    const documents = await redisClient.getDocuments(roomId);
    for (const doc of documents) {
      await convexClient.insertDocument({
        roomId,
        documentId: doc.fileId,
        fileName: doc.fileName,
        fileType: doc.fileType,
        totalChunks: doc.chunkCount,
        extractedTopics: doc.extractedTopics,
        uploadedAt: doc.createdAt,
      });
      
      // Copy chunks (text only)
      const chunks = await redisClient.getChunks(doc.fileId);
      for (const chunk of chunks) {
        await convexClient.insertChunk({
          roomId,
          documentId: doc.fileId,
          chunkIndex: chunk.index,
          totalChunks: chunks.length,
          content: chunk.text,
          tokenEstimate: chunk.tokenEstimate,
        });
      }
    }
    
    // 2. Knowledge entries (text only)
    const entries = await redisClient.getKnowledgeEntries(roomId);
    for (const entry of entries) {
      await convexClient.createKnowledgeEntry({
        roomId,
        userId: entry.userId,
        topic: entry.topic,
        content: entry.content,
        tags: entry.tags,
        importance: entry.importance,
        type: entry.type,
      });
    }
    
    console.log(`Migrated room ${roomId}`);
  }
}
```

---

## Cost Analysis

### Storage Costs (Convex)

| Item | Size | Cost/Month |
|------|------|------------|
| 1 meeting (text) | 500KB | ~$0.0001 |
| 100 meetings | 50MB | ~$0.01 |
| 10,000 meetings | 5GB | ~$1.00 |

### Embedding Costs (Gemini API)

| Scenario | Chunks | Cost |
|----------|--------|------|
| New meeting (1000 chunks) | 1000 | ~$0.01 |
| Reactivate old meeting | 1000 | ~$0.01 |
| Most meetings (never revisited) | 0 | $0 |

### Comparison: Persistent vs Ephemeral Vectors

| Approach | 100 meetings RAM | 100 meetings Storage Cost |
|----------|------------------|---------------------------|
| **Persistent vectors (Redis)** | 600MB always | Redis instance cost (~$20/mo) |
| **Persistent vectors (Convex)** | 0 | ~$4/mo (vectors are huge!) |
| **Ephemeral vectors (this design)** | 6-30MB (3-5 active) | ~$0.01/mo (text only) |

---

## FAQ

### Q: Won't re-embedding be slow when users return?
**A:** For a typical meeting (500 chunks), re-embedding takes ~5-10 seconds. Users see a "Restoring meeting..." spinner. After that, full speed.

### Q: What if 10 users return to 10 different old meetings at once?
**A:** Each re-embedding is independent. Total RAM still capped at ~60MB (10 × 6MB). Can also add rate limiting.

### Q: Do we lose the canvas state?
**A:** No! Canvas state is also persisted to Convex as JSON when room deactivates, restored when reactivated.

### Q: What about ongoing knowledge synthesis during the meeting?
**A:** Knowledge entries are created in BOTH Redis (for search) AND Convex (for persistence). Best of both worlds.

---

## Implementation Checklist

- [ ] Update Convex schema (add document/text tables, remove vectors)
- [ ] Create RoomLifecycleManager
- [ ] Refactor VectorDB to be Redis-only
- [ ] Add Convex client methods for text persistence
- [ ] Implement room activation/deactivation logic
- [ ] Add "restoring meeting" UI state
- [ ] Migration script for existing Redis data
- [ ] Grace period before deactivation (5 min)
- [ ] Test: Activate → Use → Deactivate → Reactivate → Verify
