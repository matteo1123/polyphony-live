# Migration Plan: Redis → Convex Vector Search

## Current State

| Component | Current | Target |
|-----------|---------|--------|
| Vector Storage | Redis Stack | Convex vector indexes |
| Vector Search | Custom hybrid (vector + keyword + fuzzy) | Convex `vectorSearch()` |
| Document Chunks | Redis hashes | Convex table with vector index |
| File Metadata | Redis | Convex table |
| Knowledge Entries | Redis | Convex table with vector index |

---

## Why Migrate?

### Current Problems with Redis Ephemeral Model:
1. **Data loss on restart** - Everything vanishes when Redis restarts
2. **No persistence** - Can't analyze past meetings
3. **No cross-session search** - Can't find insights from previous sessions
4. **Complex state management** - Memory compression, offloading to disk
5. **Hard to scale** - Redis is single-node for vector search

### Benefits of Convex:
1. **Persistent** - All data survives restarts
2. **Queryable history** - Search across all past meetings
3. **Built-in vector search** - No custom hybrid search needed
4. **Serverless scaling** - Handles growth automatically
5. **Real-time sync** - Can push updates to clients via subscriptions
6. **Single database** - Simpler architecture

---

## Migration Strategy

### Phase 1: Add Vector Tables to Convex Schema

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Existing tables
  spaces: defineTable({ ... }),
  devLogs: defineTable({ ... }),
  config: defineTable({ ... }),
  
  // NEW: Document chunks with vector search
  documentChunks: defineTable({
    roomId: v.string(),           // For filtering by room
    fileId: v.string(),           // Reference to file
    fileName: v.string(),
    chunkIndex: v.number(),
    totalChunks: v.number(),
    content: v.string(),          // The actual text
    embedding: v.array(v.float64()), // 768-dim Gemini embedding
    tags: v.array(v.string()),
    userId: v.string(),
    createdAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_fileId", ["fileId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,            // Gemini embedding-004
      filterFields: ["roomId", "tags"],
    }),

  // NEW: Knowledge entries (synthesized insights)
  knowledgeEntries: defineTable({
    roomId: v.string(),
    userId: v.string(),
    userName: v.string(),
    topic: v.string(),
    content: v.string(),
    embedding: v.array(v.float64()),
    tags: v.array(v.string()),
    importance: v.number(),       // 1-10 for hierarchy
    type: v.string(),             // 'insight', 'conflict', 'concept', etc.
    parentId: v.optional(v.id("knowledgeEntries")), // For hierarchy
    sources: v.array(v.string()), // Source document names
    createdAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_roomId_importance", ["roomId", "importance"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,
      filterFields: ["roomId", "tags", "type"],
    }),

  // NEW: Cross-document relationships
  relationships: defineTable({
    roomId: v.string(),
    fromEntryId: v.id("knowledgeEntries"),
    toEntryId: v.id("knowledgeEntries"),
    type: v.string(),             // 'contradicts', 'supports', 'elaborates'
    strength: v.number(),         // 0-1 confidence
    evidence: v.string(),         // Why this relationship exists
    createdAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_fromEntry", ["fromEntryId"])
    .index("by_toEntry", ["toEntryId"]),

  // NEW: File metadata
  uploadedFiles: defineTable({
    roomId: v.string(),
    fileId: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    totalChunks: v.number(),
    totalTokens: v.number(),
    extractedTopics: v.array(v.string()),
    userId: v.string(),
    uploadedAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_fileId", ["fileId"]),
});
```

---

### Phase 2: Create Convex Actions for Vector Operations

```typescript
// convex/vectorSearch.ts
import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Search knowledge entries by vector similarity
export const searchKnowledge = action({
  args: {
    roomId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    filterTags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // 1. Generate embedding (call external API)
    const embedding = await generateEmbedding(args.query);
    
    // 2. Vector search in Convex
    const results = await ctx.vectorSearch("knowledgeEntries", "by_embedding", {
      vector: embedding,
      limit: args.limit ?? 12,
      filter: (q) => {
        // Always filter by room
        const roomFilter = q.eq("roomId", args.roomId);
        
        // Optional tag filtering
        if (args.filterTags && args.filterTags.length > 0) {
          // For OR filtering on tags
          const tagFilters = args.filterTags.map(tag => 
            q.eq("tags", tag)  // Note: Convex array contains check
          );
          return q.and(roomFilter, q.or(...tagFilters));
        }
        
        return roomFilter;
      },
    });
    
    // 3. Fetch full documents
    const entries = await ctx.runQuery(internal.vectorSearch.fetchKnowledgeResults, {
      ids: results.map(r => r._id),
    });
    
    // 4. Add similarity scores
    return entries.map((entry, i) => ({
      ...entry,
      score: results[i]._score,
    }));
  },
});

// Search document chunks
export const searchDocumentChunks = action({
  args: {
    roomId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const embedding = await generateEmbedding(args.query);
    
    const results = await ctx.vectorSearch("documentChunks", "by_embedding", {
      vector: embedding,
      limit: args.limit ?? 12,
      filter: (q) => q.eq("roomId", args.roomId),
    });
    
    const chunks = await ctx.runQuery(internal.vectorSearch.fetchChunkResults, {
      ids: results.map(r => r._id),
    });
    
    return chunks.map((chunk, i) => ({
      ...chunk,
      score: results[i]._score,
    }));
  },
});

// Multi-query retrieval for synthesis questions
export const multiQuerySearch = action({
  args: {
    roomId: v.string(),
    queries: v.array(v.string()),
    limitPerQuery: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const seenIds = new Set();
    const allResults = [];
    
    for (const query of args.queries) {
      const embedding = await generateEmbedding(query);
      
      const results = await ctx.vectorSearch("knowledgeEntries", "by_embedding", {
        vector: embedding,
        limit: args.limitPerQuery ?? 6,
        filter: (q) => q.eq("roomId", args.roomId),
      });
      
      for (const result of results) {
        if (!seenIds.has(result._id)) {
          seenIds.add(result._id);
          allResults.push(result);
        }
      }
    }
    
    // Fetch full documents
    const entries = await ctx.runQuery(internal.vectorSearch.fetchKnowledgeResults, {
      ids: allResults.map(r => r._id),
    });
    
    return entries.map((entry, i) => ({
      ...entry,
      score: allResults[i]._score,
    }));
  },
});
```

---

### Phase 3: Refactor Agent to Use Convex

```typescript
// src/services/convexVectorDB.ts
import { ConvexHttpClient } from 'convex/browser';

export class ConvexVectorDB {
  private client: ConvexHttpClient;
  
  constructor() {
    this.client = new ConvexHttpClient(process.env.CONVEX_URL!);
  }
  
  async createKnowledgeEntry(roomId: string, userId: string, topic: string, 
                             content: string, tags: string[], importance: number) {
    // 1. Generate embedding
    const embedding = await this.generateEmbedding(`${topic} ${content}`);
    
    // 2. Insert into Convex
    return await this.client.mutation('knowledge:createEntry', {
      roomId,
      userId,
      topic,
      content,
      embedding,
      tags,
      importance,
    });
  }
  
  async searchKnowledge(roomId: string, query: string, limit: number = 12) {
    // Use Convex action for vector search
    return await this.client.action('vectorSearch:searchKnowledge', {
      roomId,
      query,
      limit,
    });
  }
  
  async multiQuerySearch(roomId: string, queries: string[], limitPerQuery: number = 6) {
    return await this.client.action('vectorSearch:multiQuerySearch', {
      roomId,
      queries,
      limitPerQuery,
    });
  }
}
```

---

### Phase 4: Hybrid Search Implementation

Convex vector search is pure vector similarity. To match your current hybrid search (vector + keyword + fuzzy), you'd implement it in the action:

```typescript
// convex/hybridSearch.ts
import { action } from "./_generated/server";

export const hybridSearch = action({
  args: {
    roomId: v.string(),
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. Vector search (semantic meaning)
    const queryEmbedding = await generateEmbedding(args.query);
    const vectorResults = await ctx.vectorSearch("knowledgeEntries", "by_embedding", {
      vector: queryEmbedding,
      limit: args.limit * 2, // Get more for re-ranking
      filter: (q) => q.eq("roomId", args.roomId),
    });
    
    // 2. Fetch full documents
    const entries = await ctx.runQuery(internal.hybridSearch.fetchEntries, {
      ids: vectorResults.map(r => r._id),
    });
    
    // 3. Calculate keyword scores (in JavaScript)
    const queryTerms = args.query.toLowerCase().split(/\s+/);
    const scoredEntries = entries.map((entry, i) => {
      const text = `${entry.topic} ${entry.content}`.toLowerCase();
      
      // Keyword matching
      let keywordScore = 0;
      for (const term of queryTerms) {
        if (text.includes(term)) keywordScore += 1;
        if (entry.topic.toLowerCase().includes(term)) keywordScore += 2;
      }
      
      // Combine scores (vector 70%, keyword 30%)
      const vectorScore = vectorResults[i]._score;
      const combinedScore = vectorScore * 0.7 + (keywordScore / queryTerms.length) * 0.3;
      
      return { ...entry, score: combinedScore };
    });
    
    // 4. Sort and return top results
    scoredEntries.sort((a, b) => b.score - a.score);
    return scoredEntries.slice(0, args.limit);
  },
});
```

---

## Trade-offs: Redis vs Convex

### Redis (Current)

**Pros:**
- ✅ You already have it working
- ✅ Full control over hybrid scoring algorithm
- ✅ In-memory = very fast
- ✅ Redis Stack has RediSearch for advanced queries

**Cons:**
- ❌ Ephemeral - data lost on restart
- ❌ No persistence for analysis
- ❌ Manual memory management (compression, offloading)
- ❌ Single-node limitation
- ❌ Need separate backup strategy

### Convex Vector Search

**Pros:**
- ✅ Persistent - survives restarts
- ✅ Query history across sessions
- ✅ Built-in real-time subscriptions
- ✅ Serverless auto-scaling
- ✅ Single database for everything
- ✅ Type-safe queries

**Cons:**
- ⚠️ Need to re-implement hybrid search (vector + keyword + fuzzy)
- ⚠️ Network latency (vs local Redis)
- ⚠️ Vector search only in actions (not queries/mutations)
- ⚠️ Cost at scale (Convex pricing)

---

## Recommendation

### Option 1: Hybrid Approach (Recommended)

Keep Redis for real-time/ephemeral stuff, Convex for persistence:

| Data | Storage | Why |
|------|---------|-----|
| Active session content | Redis | Fast, real-time |
| Persistent knowledge | Convex | Searchable history |
| Meeting summaries | Convex | Long-term storage |
| Analytics | Convex | Already there |

**Flow:**
```
File Upload
    ↓
Chunk & Embed
    ↓
Store in BOTH Redis (fast) AND Convex (persistent)
    ↓
Query uses Redis (fast) for active session
    ↓
On session end → Full export to Convex
```

### Option 2: Full Migration

Move everything to Convex:
- Simpler architecture
- All data persistent
- Can search across all sessions
- Requires more refactoring

### Option 3: Keep Redis, Add Persistence Layer

Keep current Redis implementation, just add:
- Periodic exports to Convex
- Meeting summaries saved to Convex
- Analytics in Convex

---

## My Recommendation

Given that you want to move away from "ephemeral" but Convex is already set up, I'd suggest **Option 1 (Hybrid)**:

1. **Keep Redis for active sessions** - it's fast and working
2. **Add Convex for persistent knowledge** - create `knowledgeEntries` table with vector index
3. **On session end** - export all knowledge to Convex
4. **Future enhancement** - allow searching across past sessions via Convex

This gives you:
- ✅ Fast real-time performance (Redis)
- ✅ Persistent knowledge base (Convex)
- ✅ Gradual migration path
- ✅ Minimal disruption to current code

Want me to implement the hybrid approach? Or would you prefer to migrate completely to Convex vector search?
