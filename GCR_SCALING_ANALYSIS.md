# GCR Scaling Analysis: How Many Meetings Per Instance?

## Memory Math

### Per-Meeting Memory Usage (Redis)

```
Chunk count depends on document size:
- 1 page text ≈ 2 chunks
- 10 page document ≈ 20 chunks  
- 100 page document ≈ 200 chunks
- Large PRD (50 pages) ≈ 100 chunks

Per chunk memory:
- Vector: 768 dims × 8 bytes = 6,144 bytes ≈ 6KB
- Content: ~500 bytes average
- Redis overhead: ~500 bytes
- Total: ~7KB per chunk
```

### Meeting Size Examples

| Meeting Type | Docs | Chunks | Memory |
|-------------|------|--------|--------|
| **Small** | 2-3 short docs | 50 chunks | ~350KB |
| **Medium** | 5-10 docs | 200 chunks | ~1.4MB |
| **Large** | Multiple PRDs | 500 chunks | ~3.5MB |
| **Huge** | Large spec + APIs | 1000 chunks | ~7MB |

---

## GCR Instance Capacity

### Memory Breakdown by Instance Size

| Instance Size | Total RAM | OS + Node Base | Available for Redis | Concurrent Meetings (avg 200 chunks) |
|--------------|-----------|----------------|---------------------|--------------------------------------|
| 256MB | 256MB | ~100MB | ~156MB | ~110 meetings |
| 512MB | 512MB | ~100MB | ~412MB | ~294 meetings |
| **1GB** | 1GB | ~100MB | ~924MB | **~660 meetings** |
| 2GB | 2GB | ~100MB | ~1.9GB | ~1,357 meetings |
| 4GB | 4GB | ~100MB | ~3.9GB | ~2,785 meetings |

### Real-World Scenarios

#### Scenario A: Team Standups (Small Meetings)
- Average: 50 chunks (0.35MB)
- 1GB instance: **2,640 concurrent meetings**

#### Scenario B: Sprint Planning (Medium)
- Average: 200 chunks (1.4MB)
- 1GB instance: **660 concurrent meetings**

#### Scenario C: Architecture Reviews (Large)
- Average: 500 chunks (3.5MB)
- 1GB instance: **264 concurrent meetings**

#### Scenario D: Mixed Usage (Realistic)
- 70% small (0.35MB) = 462 meetings
- 25% medium (1.4MB) = 165 meetings  
- 5% large (3.5MB) = 13 meetings
- **Total: ~640 concurrent meetings on 1GB**

---

## The Problem: Large File Uploads

**Your concern about "2 meetings using all space" is valid if:**

1. **Huge documents uploaded:**
   - 500-page technical spec = 1000+ chunks = 7MB
   - 2 such meetings = 14MB (still fine on 1GB)
   - **BUT** 50 such meetings = 350MB (getting tight)

2. **Worst case - Massive PDF:**
   - 1000-page document = 2000 chunks = 14MB
   - 2 meetings = 28MB
   - 20 meetings = 280MB
   - 50 meetings = 700MB (problem on 1GB instance)

---

## Solutions

### Option 1: File Size Limits (Immediate Fix)

```javascript
// src/services/fileUpload.js
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CHUNKS_PER_FILE = 500; // ~250 pages

async function handleFileUpload(file) {
  if (file.size > MAX_FILE_SIZE) {
    return { error: "File too large. Max 10MB." };
  }
  
  const chunks = chunkDocument(file.content);
  
  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    // Sample intelligently instead of embedding all
    return handleLargeFile(file, chunks);
  }
  
  // Normal processing
}
```

**Impact:** Prevents runaway memory usage from massive uploads.

---

### Option 2: Per-Meeting Memory Budget (Recommended)

```javascript
// src/services/roomMemoryManager.js
const MAX_CHUNKS_PER_ROOM = 1000; // ~7MB max per room

class RoomMemoryManager {
  async canActivateRoom(roomId) {
    const currentMemory = await this.getRedisMemoryUsage();
    const roomChunkCount = await this.convexClient.getRoomChunkCount(roomId);
    
    // Check if adding this room would exceed limit
    const projectedMemory = currentMemory + (roomChunkCount * 7 * 1024);
    const maxMemory = this.getMaxRedisMemory(); // e.g., 800MB of 1GB
    
    if (projectedMemory > maxMemory) {
      // Options:
      // 1. Reject new room
      // 2. Evict oldest inactive room
      // 3. Scale horizontally
      return this.handleMemoryPressure(roomId);
    }
    
    return true;
  }
  
  async handleMemoryPressure(newRoomId) {
    // Evict least recently used room
    const inactiveRooms = await this.redisClient.getInactiveRooms();
    
    if (inactiveRooms.length > 0) {
      // Deactivate oldest room
      await this.roomLifecycleManager.deactivateRoom(inactiveRooms[0]);
      return true; // Now we have space
    }
    
    // No rooms to evict - need to scale
    return false; // Signal to GCR to start new instance
  }
}
```

**Impact:** Gracefully handles memory pressure by evicting old rooms.

---

### Option 3: External Redis (Best for Scale)

```yaml
# docker-compose.yml (for local)
# OR Google Cloud Memorystore (for production)

services:
  app:
    build: .
    environment:
      - REDIS_HOST=redis  # Internal for small scale
      # - REDIS_HOST=10.0.0.3  # External Redis for large scale
  
  # Option A: Internal Redis (simple, limited scale)
  redis:
    image: redis/redis-stack:latest
    deploy:
      resources:
        limits:
          memory: 512M
  
  # Option B: No internal Redis - use external Memorystore
```

**Google Cloud Memorystore Pricing:**
- 1GB Basic tier: ~$35/month
- 5GB Basic tier: ~$85/month
- 10GB Basic tier: ~$150/month

**Break-even analysis:**
- If you run 5+ GCR instances with 1GB each to get more Redis space
- External 5GB Redis is cheaper and simpler

---

### Option 4: Horizontal Scaling with Sticky Sessions

```yaml
# service.yaml (Cloud Run)
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: polyphony-live
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "100"
        # NOTE: No session affinity - each instance has its own Redis
    spec:
      containerConcurrency: 100
      containers:
        - resources:
            limits:
              memory: "1Gi"
              cpu: "2"
```

**Problem:** Without sticky sessions, users might hit different instances:
- User joins Meeting A on Instance 1 (room activated there)
- Second user joins Meeting A on Instance 2 (room activates there too)
- Now Meeting A is active on TWO instances, wasting 2x memory

**Solution A: Sticky Sessions (not natively supported in Cloud Run)**
- Use Cloud Load Balancer with session affinity
- Or use external Redis so all instances share vector storage

**Solution B: Room-to-Instance Mapping**
```javascript
// Before activating room, check if it's active elsewhere
async function activateRoom(roomId) {
  // Check Convex: which instance has this room?
  const activeInstance = await convexClient.getRoomInstance(roomId);
  
  if (activeInstance && activeInstance !== CURRENT_INSTANCE_ID) {
    // Room is active on another instance
    // Route user there or wait for deactivation
    return { redirect: activeInstance };
  }
  
  // Activate here
  await convexClient.setRoomInstance(roomId, CURRENT_INSTANCE_ID);
  // ... activate
}
```

---

## My Recommendation

### Phase 1: Keep It Simple (Current Setup)

**1GB GCR Instance + Internal Redis**

```yaml
# service.yaml
resources:
  limits:
    memory: "1Gi"  # 1GB total
    cpu: "2"
```

**Limits:**
- Max 500-600 concurrent average meetings
- Add file size limits (10MB max, 500 chunks max)
- Monitor Redis memory usage

**When to scale:**
- Redis memory consistently > 80%
- Response times increasing
- Users report slowness

---

### Phase 2: Add Memory Pressure Handling

Add eviction logic before you need to scale horizontally:

```javascript
// Before activating a room
if (redisMemory > 700MB) {
  // Find oldest inactive room
  const oldestRoom = await getOldestInactiveRoom();
  if (oldestRoom) {
    await deactivateRoom(oldestRoom.id);
    console.log(`Evicted room ${oldestRoom.id} to free memory`);
  }
}
```

**Benefit:** One instance can handle variable load by evicting old rooms.

---

### Phase 3: External Redis (When You Need > 600 Concurrent)

When you consistently need 1000+ concurrent meetings:

```
GCR Instance (4×):
  - Memory: 512MB each (just for app)
  - No internal Redis
  
Google Memorystore Redis:
  - 10GB capacity
  - Shared across all instances
  - ~$150/month
  
Total: 4× GCR + Redis = ~$200/month
Can handle: 1000+ concurrent meetings
```

---

## Quick Decision Matrix

| Monthly Active Users | Concurrent Meetings | Recommendation |
|---------------------|---------------------|----------------|
| < 100 | < 50 | 512MB instance, internal Redis |
| 100-1000 | 50-500 | **1GB instance, internal Redis** |
| 1000-5000 | 500-1000 | 1GB instance + memory pressure eviction |
| 5000+ | 1000+ | External Redis (Memorystore) |

---

## Monitoring (Add This)

```javascript
// Health check endpoint
app.get('/health', async (req, res) => {
  const redisInfo = await redisClient.info('memory');
  const usedMemory = parseRedisMemory(redisInfo);
  const maxMemory = 1024 * 1024 * 1024; // 1GB
  
  const activeRooms = await roomManager.getActiveRoomCount();
  
  res.json({
    status: usedMemory > maxMemory * 0.9 ? 'warning' : 'healthy',
    redis: {
      usedMemoryMB: Math.round(usedMemory / 1024 / 1024),
      maxMemoryMB: Math.round(maxMemory / 1024 / 1024),
      utilization: Math.round((usedMemory / maxMemory) * 100) + '%'
    },
    activeRooms,
    maxRoomsEstimate: Math.round((maxMemory - 100*1024*1024) / (200 * 7 * 1024))
  });
});
```

---

## Bottom Line

**On a 1GB GCR instance, you can handle 500-600 concurrent average meetings.**

If you have 2 huge meetings (1000+ chunks each), that's only 14MB - still fine.

The "2 meetings using all space" problem only happens with:
- Massive documents (100+ MB PDFs)
- Thousands of chunks per meeting
- No file size limits

**Add these safeguards:**
1. 10MB file size limit
2. 500 chunk limit per file (with intelligent sampling)
3. Memory pressure eviction
4. Monitoring at `/health`

Then you can comfortably run 500+ concurrent meetings on one 1GB instance.
