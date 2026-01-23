# Polyphony.live: Collaboration System Architecture

## Overview

**Core Vision**: Transform meetings into asynchronous-feeling experiences where everyone speaks simultaneously, and an AI agent synthesizes all inputs in real-time into a coherent "Collective Memory."

Instead of:
> "John speaks (2 min) → Sarah responds (2 min) → Bob adds (2 min)" = 6 minutes

We enable:
> Everyone speaks at once → Agent synthesizes in real-time → Discussions flow naturally = 2-3 minutes total

---

## System Architecture

### 1. **Data Flow Overview**

```
┌─────────────────────────────────────────────────────────────────┐
│                         USERS (Frontend)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ User 1   │  │ User 2   │  │ User 3   │  │ User N   │       │
│  │Listener  │  │Listener  │  │Listener  │  │Listener  │       │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └─────┬────┘       │
└────────┼─────────────┼─────────────┼─────────────┼──────────────┘
         │ WebSocket   │ WebSocket   │ WebSocket   │ WebSocket
         │ (Stream)    │ (Stream)    │ (Stream)    │ (Stream)
         └─────────────┼─────────────┼─────────────┘
                       ▼
        ┌──────────────────────────────┐
        │   Node.js Server (Port 3000) │
        │   Socket.io Message Queue    │
        └──────────────┬───────────────┘
                       │
         ┌─────────────┴──────────────┐
         │                            │
         ▼                            ▼
    ┌─────────────┐         ┌──────────────────┐
    │ Vectorizer  │         │   Hive Agent     │
    │ (OpenAI)    │         │  (LangGraph)     │
    └─────┬───────┘         └────────┬─────────┘
          │                          │
          └──────────────┬───────────┘
                         ▼
           ┌──────────────────────────┐
           │   Redis Vector Database  │
           │  ┌────────────────────┐  │
           │  │ Vector Store (VL)  │  │
           │  │ (Embeddings + TTL) │  │
           │  └────────────────────┘  │
           │  ┌────────────────────┐  │
           │  │ Metadata Store     │  │
           │  │ (User Context)     │  │
           │  └────────────────────┘  │
           │  ┌────────────────────┐  │
           │  │ Session Memory     │  │
           │  │ (Conversation Log) │  │
           │  └────────────────────┘  │
           └──────────────┬───────────┘
                          │
         ┌────────────────┴────────────────┐
         │                                 │
         ▼                                 ▼
    ┌──────────────┐            ┌──────────────────┐
    │ Broadcast    │            │ Agent Memory     │
    │ Synthesis    │            │ Context Building │
    └─────┬────────┘            └──────────────────┘
          │
          ▼
    ┌──────────────────────────────┐
    │  Push to Users via WebSocket │
    │  (Real-time Synthesis)       │
    └──────────────────────────────┘
```

---

## 2. **Core Components**

### **A. Frontend Listener (React)**
- Captures user input (text/audio transcription)
- Sends via WebSocket to server in real-time
- Each message tagged with: `userId`, `timestamp`, `messageId`
- Streams thoughts (doesn't wait for user to finish)

**Message Format:**
```json
{
  "type": "thought_stream",
  "userId": "user-123",
  "userName": "John",
  "content": "I think we should...",
  "timestamp": 1674567890000,
  "messageId": "msg-uuid-123"
}
```

---

### **B. Node.js Server + Socket.io**
**Responsibilities:**
1. Accept WebSocket connections from multiple users
2. Validate & authenticate user sessions
3. Queue incoming messages
4. Route to Vectorizer & Hive Agent
5. Broadcast synthesis responses back to users

**Key Endpoints/Events:**
- `connection` - User joins session
- `thought_stream` - Receive user input
- `disconnect` - User leaves session
- `synthesis_update` - Server broadcasts agent synthesis
- `context_request` - User requests current shared context

---

### **C. Vectorizer Service**
**Responsibility:** Convert text to embeddings + metadata storage

**Process:**
1. Receive message from user
2. Call OpenAI/Cohere API to generate embedding (1536 dims for GPT-4)
3. Store in Redis Vector Index with metadata:
   - `userId`, `userName`, `timestamp`, `original_text`
   - TTL: 30 minutes (ephemeral)
4. Return embedding to Hive Agent

**Key Decision:** All embeddings computed immediately (no batching) for real-time responsiveness.

---

### **D. Redis Vector Database (The Brain)**

#### **Structure:**

```
NAMESPACE: polyphony:hive:{sessionId}

1. VECTOR INDEX: polyphony:hive:{sessionId}:vectors
   ├─ Vector: [1536-dim embedding]
   ├─ Metadata:
   │  ├─ user_id (indexed for filtering)
   │  ├─ user_name (indexed)
   │  ├─ content (original text, searchable)
   │  ├─ timestamp (indexed for sorting)
   │  └─ message_id (unique key)
   └─ TTL: 30 minutes (auto-cleanup)

2. METADATA STORE: polyphony:hive:{sessionId}:metadata:{messageId}
   ├─ Original text (full)
   ├─ User context (role, department, etc.)
   ├─ Synthesis count (how many times included in synthesis)
   └─ Relevance score (computed by agent)

3. CONVERSATION LOG: polyphony:hive:{sessionId}:log
   ├─ Each entry: user message + agent response timestamp
   ├─ Indexed by timestamp
   └─ Persisted for session duration

4. SESSION STATE: polyphony:hive:{sessionId}:state
   ├─ active_users: [user1, user2, ...]
   ├─ start_time: timestamp
   ├─ synthesis_round: counter
   ├─ last_synthesis: timestamp
   └─ collective_themes: [theme1, theme2, ...]

5. USER CONTEXT: polyphony:user:{userId}
   ├─ preferences (verbosity, focus areas)
   ├─ contribution_count
   ├─ last_activity
   └─ individual_feedback (what user said they care about)
```

---

### **E. Hive Agent (LangGraph-based)**

**Responsibilities:**
1. Continuous synthesis loop (every 3-5 seconds)
2. Vector similarity search across all users
3. Identify patterns & conflicts
4. Generate real-time insights
5. Maintain per-user conversation state
6. Manage individual user contexts

**Synthesis Loop Algorithm:**

```
EVERY 3-5 SECONDS:

1. VECTOR RANGE SEARCH
   - Query: "What are the main themes?"
   - Range: Similarity > 0.75
   - Filter: Last 5 minutes of messages
   - Return: Grouped by semantic similarity

2. PATTERN DETECTION
   - Identify converging viewpoints (agreement)
   - Identify conflicting viewpoints (disagreement)
   - Identify new topics introduced
   - Calculate "temperature" (consensus level 0-100)

3. CONTEXT ASSEMBLY
   - For EACH user individually:
     a. What did they say?
     b. How does it relate to collective themes?
     c. What questions might they have?
     d. What connections should we highlight?

4. SYNTHESIS GENERATION
   - Build prompt:
     * All user inputs (vectorized)
     * Detected patterns
     * Consensus level
     * Unresolved conflicts
   
   - Call LLM (GPT-4) to generate:
     * Collective summary (what we've learned)
     * Per-user insights (tailored to each person)
     * Questions to deepen discussion
     * Areas of consensus/conflict

5. BROADCAST TO USERS
   - Send personalized synthesis to each user:
     {
       "type": "synthesis_update",
       "collective_summary": "...",
       "your_perspective": "How John's point fits in",
       "emerging_themes": [...],
       "conflicts_detected": [...],
       "next_steps": "..."
     }

6. UPDATE MEMORY
   - Store synthesis in Redis:
     * Link to message IDs that informed it
     * Timestamp
     * User feedback (if they react)
   - Update conversation log
   - Mark relevant vectors as "synthesized"
```

---

### **F. Per-User Conversation Thread**

Each user maintains **isolated but synchronized** conversations:

**User 1's View:**
```
Agent: "John, you mentioned X. Sarah also brought up Y which aligns with X."
John: "Yes, but did you see that Bob said Z?"
Agent: "Good point - Z challenges the consensus on X. Let me synthesize..."
```

**User 2's View (Same Time, Different Perspective):**
```
Agent: "Sarah, John and you are actually on the same page about X."
Sarah: "Wait, Bob said what about Z?"
Agent: "Bob is concerned that Z might contradict our X consensus..."
```

**Key Insight:** Users see the SAME synthesis, but their context is personalized. The agent acts as a translator between different perspectives.

---

## 3. **Real-Time Workflow Example**

### **Scenario: 3-person brainstorm meeting (2 minutes)**

**T=0s**: Session starts
- Alice, Bob, Charlie join

**T=5s**: Alice speaks
- Message: "We need better customer analytics"
- Vectorized & stored
- Agent notes: Theme A (Analytics Importance)

**T=8s**: Bob speaks (overlapping)
- Message: "Our current dashboard is too slow"
- Vectorized & stored
- Agent detects: Semantic similarity to Alice (0.82)

**T=12s**: Charlie speaks (overlapping)
- Message: "I want real-time insights, not batch reports"
- Vectorized & stored
- Agent detects: Alignment with Alice + Bob (0.89)

**T=15s**: FIRST SYNTHESIS (after 3-5 messages)
- Agent identifies: Consensus emerging around "real-time analytics"
- Broadcasts to all 3 users:
  ```
  Collective: "You're all aligned on needing real-time analytics"
  Alice's note: "Both Bob and Charlie want real-time, not batch"
  Bob's note: "Alice started this, Charlie wants speed too"
  Charlie's note: "Alice & Bob both concerned with performance"
  Questions: "What's your timeline? Budget? Current tech stack?"
  ```

**T=20s**: Alice responds
- Message: "Timeline: 2 weeks, Budget: $50k"
- Agent updates Alice's context
- Vector: Stored with metadata linking to previous synthesis

**T=25s**: Bob responds
- Message: "That won't work. Need 4 weeks minimum"
- Agent detects: CONFLICT detected (Alice vs Bob on timeline)
- Marks for highlighting in next synthesis

**T=30s**: SECOND SYNTHESIS (conflict resolution)
- Agent synthesizes the conflict:
  ```
  Collective: "Timeline gap: Alice wants 2 weeks, Bob needs 4"
  Alice's note: "Bob's concern about 2-week timeline - is implementation the constraint?"
  Bob's note: "Alice pushing aggressive timeline. Help set realistic expectations?"
  Charlie's note: "Both concerned about timeline. Charlie hasn't weighed in yet"
  Action: "Let's discuss: What's blocking a 2-week implementation?"
  ```

**T=35s**: Charlie speaks
- Message: "We could use no-code tools for 2 weeks, then rebuild properly"
- Agent synthesizes: CONFLICT RESOLUTION emerging

**T=40s**: FINAL SYNTHESIS
- Agent generates session summary
- Decision: "2-week MVP with no-code, 4-week rebuild"
- All users see consensus achieved
- Ready for next phase (action items, owners, etc.)

**T=120s**: Session ends or continues to next topic

**Result**: What would take 15 minutes in a traditional meeting took 2 minutes because:
- Everyone spoke simultaneously (no waiting)
- Agent synthesized in real-time
- Conflicts surfaced & resolved instantly
- Decisions were explicit & shared

---

## 4. **Vector Search Queries**

### **Example 1: Finding Semantic Patterns**
```redis
FT.SEARCH polyphony:hive:{sessionId}:vectors
  "@timestamp:[30m AGO TO NOW]"
  "=>(knn 5 @embedding $query_vec)"
  RETURN embedding_distance
```

**Result:** Top 5 semantically similar messages in last 30 minutes

### **Example 2: User-Filtered Search**
```redis
FT.SEARCH polyphony:hive:{sessionId}:vectors
  "@user_id:{user123} @timestamp:[5m AGO TO NOW]"
  RETURN content, timestamp
```

**Result:** All of User 123's messages in last 5 minutes

### **Example 3: Conflict Detection**
```
Query 1 Vector: "We should move fast"
Query 2 Vector: "We need to be careful"
Result: Similarity 0.15 (low) = Conflict detected
```

---

## 5. **Ephemeral State Management**

### **Session Lifecycle:**

```
1. SESSION CREATION
   - First user joins
   - SessionId generated (UUID)
   - TTL set to 4 hours
   - State: {"active_users": ["user1"], "start_time": now}

2. ACTIVE PHASE
   - Users join/leave dynamically
   - Update active_users list
   - All vectors & metadata stored with 30-min TTL
   - Conversation log maintained

3. CLEANUP TRIGGER
   - Last user disconnects
   - active_users.length == 0
   - Start cleanup process:
     a. Query all vectors for session
     b. Generate final markdown summary
     c. Offer download to last user
     d. Wait 5 minutes (users can re-join)

4. FINAL DELETION
   - After 5-minute grace period:
     a. Delete all vectors
     b. Delete metadata
     c. Delete conversation log
     d. Delete session state
     e. Archive summary to S3 (optional)
```

### **Export Flow (Before Deletion):**

```javascript
// When last user leaves:
async function generateSessionSummary(sessionId) {
  const vectors = await redis.querySession(sessionId);
  const log = await redis.getConversationLog(sessionId);
  
  const summary = await agent.generateMarkdown({
    messages: vectors,
    log: log,
    format: 'markdown'
  });
  
  // Generate downloadable summary:
  // # Collective Memory: [Date] [Duration]
  // ## Participants: [User List]
  // ## Main Themes: [...]
  // ## Decisions Made: [...]
  // ## Action Items: [...]
  // ## Unresolved Items: [...]
}
```

---

## 6. **Implementation Roadmap**

### **Phase 1: Core Infrastructure** ✅ (DONE)
- [x] Docker-compose with Redis Stack
- [x] Node.js server with Socket.io
- [x] Basic message routing
- [x] Redis client setup

### **Phase 2: Vectorization & Storage** (NEXT)
- [ ] OpenAI integration for embeddings
- [ ] Redis Vector Index setup
- [ ] TTL management
- [ ] Metadata storage

### **Phase 3: Hive Agent Core**
- [ ] LangGraph state machine
- [ ] Synthesis loop (3-5 second cycles)
- [ ] Pattern detection algorithm
- [ ] Conflict detection

### **Phase 4: Real-time Broadcast**
- [ ] Per-user synthesis generation
- [ ] WebSocket broadcast optimization
- [ ] Message deduplication
- [ ] Feedback loop

### **Phase 5: Persistence & Export**
- [ ] Conversation logging
- [ ] Summary generation (Markdown)
- [ ] Export to PDF/JSON
- [ ] Session cleanup

### **Phase 6: Frontend Integration**
- [ ] React listener component
- [ ] Real-time synthesis display
- [ ] User context UI
- [ ] Download summary feature

---

## 7. **Technical Decisions & Rationale**

| Decision | Rationale |
|----------|-----------|
| **WebSocket (Socket.io)** | Low-latency bidirectional communication; handles simultaneous connections |
| **Redis Vector DB** | Sub-millisecond similarity search; built-in TTL for ephemeral data |
| **LangGraph** | Explicit state management; handles complex agent workflows |
| **OpenAI Embeddings** | High-quality semantic search; battle-tested for production |
| **3-5 sec synthesis loop** | Fast enough for real-time feel; slow enough to batch messages |
| **Per-user conversations** | Users feel heard individually; reduces "lost in the crowd" feeling |
| **Markdown export** | Human-readable; version control friendly; shareable |

---

## 8. **Metrics & Monitoring**

### **Performance KPIs:**
- **Message-to-Vector latency:** < 200ms
- **Vector search latency:** < 50ms
- **Synthesis generation time:** < 2 seconds
- **WebSocket broadcast latency:** < 100ms
- **Session memory usage:** < 10MB per active session

### **Business KPIs:**
- **Meeting duration reduction:** Target 60% reduction
- **Decision clarity:** Post-meeting survey
- **User engagement:** Concurrent connections per session
- **Export adoption:** % of sessions with export

---

## 9. **Security & Privacy Considerations**

1. **Data Encryption:**
   - Redis data at rest (TLS in Hetzner)
   - WebSocket connections use WSS (secure)

2. **Access Control:**
   - Session-based auth (JWT tokens)
   - Users can only see own context, not others' private metadata

3. **Ephemeral By Design:**
   - 30-minute TTL on all vectors
   - Session cleanup after 4 hours inactive
   - No permanent storage of raw conversations (unless opted-in)

4. **API Rate Limiting:**
   - Prevent spam/DOS via OpenAI API
   - User message throttling

---

## 10. **Future Enhancements**

- [ ] Multi-language support (automatic translation)
- [ ] Tone detection (angry, excited, confused)
- [ ] Action item assignment (AI-extracted from synthesis)
- [ ] Async continuation (users join later to see summary + continue)
- [ ] Integration with Slack/Teams (cross-platform)
- [ ] Audio transcription (real-time speech-to-text)
- [ ] Persistent archives (optional opt-in)
- [ ] Custom LLM models (fine-tuned for specific domains)

---

## Summary

**Polyphony.live** transforms traditional meetings by:
1. **Eliminating wait time** (everyone speaks simultaneously)
2. **Synthesizing in real-time** (agent finds patterns instantly)
3. **Personalizing context** (each user sees relevant connections)
4. **Maintaining coherence** (collective memory via vector DB)
5. **Respecting privacy** (ephemeral by default)

The result: **Faster, smarter, more inclusive meetings.**
