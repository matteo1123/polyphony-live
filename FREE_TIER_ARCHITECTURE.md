# Free Tier Architecture: Maximum Wow, Zero Cost

## Budget: $0/month

## Goals
1. **Impress potential employers** - They see grounded, intelligent responses
2. **Demo-ready** - 1-2 concurrent meetings, rock solid
3. **Simple** - Remove complexity, focus on what matters
4. **Fast** - Sub-second responses feel magical

---

## Stack (All Free Tier)

| Service | Tier | Limits | Our Usage |
|---------|------|--------|-----------|
| **Google Cloud Run** | Free | 2M requests/mo, 512MB | 1 instance, 512MB |
| **Convex** | Free | 1M calls/mo, 5GB storage | Analytics + persistence |
| **Redis** | Internal | Uses GCR memory | Vectors + session state |
| **Gemini API** | Free | 60 requests/min | Embeddings + responses |

---

## Simplified Architecture

```
┌─────────────────────────────────────┐
│     Google Cloud Run (1 instance)   │
│           512MB RAM                 │
│  ┌─────────────────────────────┐   │
│  │   Node.js App               │   │
│  │   - Socket.io server        │   │
│  │   - LangGraph Agent         │   │
│  │   - File processing         │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │   Redis (internal)          │   │
│  │   - Vectors: ~100MB         │   │
│  │   - Session state: ~10MB    │   │
│  │   - Total: ~110MB for       │   │
│  │     10 concurrent meetings  │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│   Convex (free tier)                │
│   - Meeting summaries               │
│   - Analytics/logs                  │
│   - User session persistence        │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│   Gemini API (free tier)            │
│   - Embeddings (text-embedding-004) │
│   - Chat responses (gemini-2.0-flash)│
└─────────────────────────────────────┘
```

---

## What We're Simplifying

### REMOVED (Too Complex for Demo)

1. **RoomMemoryManager** - Don't need eviction logic for 10 meetings
2. **LargeFileHandler** - Overkill, just limit file size
3. **Memory compression** - 512MB is plenty
4. **Extended storage** - Not needed
5. **Multi-instance scaling** - Max 1 GCR instance
6. **Session affinity** - Only 1 instance

### KEPT (The Wow Factors)

1. ✅ **Grounded responses** - Cite specific documents
2. ✅ **Cross-document synthesis** - Detect conflicts automatically
3. ✅ **12-chunk retrieval** - Better context for synthesis
4. ✅ **Multi-query retrieval** - Smart conflict detection
5. ✅ **Canvas with importance** - Visual hierarchy
6. ✅ **Mermaid diagrams** - Visual synthesis

---

## GCR Configuration

```yaml
# service.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: polyphony-live
spec:
  template:
    metadata:
      annotations:
        # FREE TIER: Keep min 0, max 1
        autoscaling.knative.dev/minScale: "0"  # Scale to 0 when idle (saves money)
        autoscaling.knative.dev/maxScale: "1"  # NEVER scale beyond 1
    spec:
      containerConcurrency: 100  # One instance handles 100 concurrent connections
      containers:
        - image: gcr.io/PROJECT/polyphony-live
          resources:
            limits:
              memory: "512Mi"  # FREE TIER LIMIT
              cpu: "1"
          env:
            - name: NODE_ENV
              value: "production"
            - name: CONVEX_URL
              valueFrom:
                secretKeyRef:
                  name: convex-url
                  key: url
            - name: GOOGLE_AI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: google-ai-key
                  key: apikey
```

**Why scale to 0?**
- When no meetings running = $0
- Cold start: ~5 seconds (acceptable for demo)
- Once running, stays up while users connected

---

## Simplified File Handling

```javascript
// Simple 10MB limit, no complex sampling
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CHUNKS = 100; // Hard limit

async function handleFileUpload(file) {
  if (file.size > MAX_FILE_SIZE) {
    return { 
      error: "File too large (max 10MB). Try splitting into smaller files." 
    };
  }
  
  const chunks = chunkDocument(file.content, MAX_CHUNKS);
  
  // Simple: embed ALL chunks (we have room for 100)
  for (const chunk of chunks) {
    await vectorDB.createKnowledgeEntry(roomId, chunk);
  }
  
  return { success: true, chunkCount: chunks.length };
}
```

---

## The "Wow" Features to Highlight

### 1. Grounded Responses
**Demo script:**
> Upload PM PRD + Dev API docs
> Ask: "What are the conflicts?"
> **Expected wow:** Response cites specific requirement IDs, numbers, deadlines

### 2. Automatic Conflict Detection
**Demo script:**
> Upload two docs with opposing requirements
> Watch canvas auto-populate with "Conflict: X vs Y" node
> Importance: 10 (top of hierarchy)

### 3. Visual Synthesis
**Demo script:**
> Ask: "Show me a diagram of the architecture"
> Auto-generated Mermaid diagram appears on canvas
> Updates as new docs uploaded

### 4. Smart Retrieval
**Demo script:**
> Ask synthesis question
> Check logs: "Multi-query retrieval found 12 results"
> Response synthesizes across multiple sources

---

## Convex Schema (Minimal)

```typescript
// Only what we need for persistence
export default defineSchema({
  // Analytics (already there)
  spaces: defineTable({
    spaceId: v.string(),
    createdAt: v.number(),
    summaryMarkdown: v.optional(v.string()),
    // ... minimal fields
  }),

  // Simple meeting persistence (for "return to meeting" feature)
  meetings: defineTable({
    roomId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    lastActiveAt: v.number(),
    isActive: v.boolean(),
    documentCount: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_active", ["isActive"]),

  // Just store the text, no vectors (vectors are ephemeral in Redis)
  documents: defineTable({
    roomId: v.string(),
    fileName: v.string(),
    content: v.string(), // Full text (compressed if large)
    chunkCount: v.number(),
    uploadedAt: v.number(),
  })
    .index("by_roomId", ["roomId"]),
});
```

---

## Cost Projections (Free Tier)

### Scenario: Demo Day

| Metric | Usage | Free Tier | Status |
|--------|-------|-----------|--------|
| GCR requests | 1,000 | 2M | ✅ Free |
| GCR memory | 512MB × 4 hours | 360K GB-sec | ✅ Free |
| Convex calls | 5,000 | 1M | ✅ Free |
| Convex storage | 50MB | 5GB | ✅ Free |
| Gemini API | 500 calls | 60/min | ✅ Free |

**Total: $0**

---

## Reliability for Demo

### What Could Go Wrong

1. **Cold start (5 sec)** - Show "Waking up..." spinner
2. **Gemini rate limit** - Cache responses, retry with backoff
3. **Redis OOM** - Hard limit 10 concurrent meetings, show friendly error
4. **File too big** - Clear 10MB limit, helpful error message

### Health Check

```javascript
app.get('/health', async (req, res) => {
  const redisInfo = await redisClient.info('memory');
  const usedMB = parseRedisMemory(redisInfo);
  
  res.json({
    status: usedMB > 400 ? 'warning' : 'healthy',
    meetings: await redisClient.getActiveRoomCount(),
    memoryUsedMB: usedMB,
    message: usedMB > 400 ? 'High memory usage' : 'All systems go'
  });
});
```

---

## Deployment Checklist

- [ ] Set GCR maxScale: 1
- [ ] Set GCR memory: 512Mi
- [ ] Configure cold start message
- [ ] Test with 2 large documents
- [ ] Verify conflict detection works
- [ ] Check mermaid diagrams render
- [ ] Ensure graceful error messages
- [ ] Set up Convex (free tier)
- [ ] Add Google AI API key
- [ ] Deploy and test end-to-end

---

## The Demo Script

### Setup (2 minutes)
1. Create new space
2. Upload "PM-PRD.pdf" (requirements doc)
3. Upload "Dev-Constraints.pdf" (technical limits)

### The Wow (3 minutes)
1. **Ask:** "What are the biggest conflicts?"
   - Watch canvas populate
   - See importance 10 conflict node
   - Response cites specific requirement IDs

2. **Ask:** "Show me the timeline tension"
   - Mermaid diagram auto-generates
   - Shows PM deadline vs Dev realistic estimate

3. **Upload:** "Budget-Analysis.pdf"
   - Watch canvas refresh automatically
   - New budget conflict appears

4. **Export:** Click export button
   - Full markdown with all insights
   - Save for later reference

### The Pitch (1 minute)
> "This is Polyphony - it doesn't just store documents, it **understands** them. 
> It finds conflicts I'd miss, cites specific requirements, and visualizes tensions.
> Built on Gemini 2.0 Flash, LangGraph, and Convex."

---

## Next Steps

1. **Clean up** - Remove complex scaling code
2. **Optimize** - Focus on speed and reliability
3. **Polish** - Error messages, loading states
4. **Deploy** - GCR free tier
5. **Demo** - Blow some minds
