# Polyphony.live: Shared Knowledge Modeling Platform

## Overview

**Core Vision**: A collaborative space where multiple users contribute data (voice, text, files) to a shared knowledge model. An AI agent continuously renders the best representation of this collective knowledge on a shared page that all users see in real-time.

**Key Principle**: Ephemeral by design. Everything lives in RAM until the last user disconnects, then it vanishes. Users can export a comprehensive markdown file that captures the semantic state well enough to restore context in a future session.

---

## Architecture: Event-Driven, Not Polling

Unlike traditional synthesis loops, Polyphony.live is **reactive**:

1. **Data arrives** → Ingest immediately → Update shared page
2. **User asks a question** → Agent responds using vector search over all ingested content
3. **User requests export** → Generate comprehensive markdown

There is **no background synthesis loop**. The agent processes input as it arrives and responds when asked.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USERS (Frontend)                              │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              SHARED LIVE PAGE (Same for all users)               │  │
│  │  ┌─────────────────────────────────────────────────────────────┐ │  │
│  │  │  Agent's Best Representation of the Phenomenon              │ │  │
│  │  │  ├── Key Topic A [expandable button]                        │ │  │
│  │  │  ├── Key Topic B [expandable button]                        │ │  │
│  │  │  ├── Conflict: X vs Y [highlighted]                         │ │  │
│  │  │  └── Recent Insights [collapsible]                          │ │  │
│  │  └─────────────────────────────────────────────────────────────┘ │  │
│  │                                                                    │  │
│  │  INPUT METHODS:                                                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────────────────────┐  │  │
│  │  │ Voice    │ │ Text     │ │ File Upload (PDF/DOCX/TXT/MD)    │  │  │
│  │  │ (Piper)  │ │ Chat     │ │                                  │  │  │
│  │  └──────────┘ └──────────┘ └──────────────────────────────────┘  │  │
│  │                                                                    │  │
│  │  CLIENT-SIDE CONVERSATION HISTORY (lost on refresh)              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket (Socket.io)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Node.js Server (Express + Socket.io)               │
│  ┌────────────────────────────────────────────────────────────────────┐│
│  │ Event Handlers:                                                     ││
│  │  • file:upload    → Parse → Extract text → Embed → Store           ││
│  │  • voice:chunk    → Piper STT → Text → Embed → Store               ││
│  │  • message:send   → Agent responds using vector search             ││
│  │  • page:request   → Agent renders current state                    ││
│  │  • export:request → Generate comprehensive markdown                 ││
│  └────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
           ┌──────────────┐ ┌─────────────┐ ┌─────────────────┐
           │ File Parser  │ │ Piper STT   │ │ Gemini 3 Flash  │
           │ (PDF/DOCX/   │ │ (Voice →    │ │ (Agent Brain)   │
           │  TXT/MD)     │ │  Text)      │ │                 │
           └──────────────┘ └─────────────┘ └─────────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
           ┌─────────────────────────────────────────────────────┐
           │              Redis Stack (Ephemeral)                │
           │  ┌───────────────────────────────────────────────┐  │
           │  │ Vector Store (embeddings + metadata)          │  │
           │  │  • All ingested content as vectors            │  │
           │  │  • Source tracking (file, voice, message)     │  │
           │  │  • No TTL - lives until room closes           │  │
           │  └───────────────────────────────────────────────┘  │
           │  ┌───────────────────────────────────────────────┐  │
           │  │ Room State                                    │  │
           │  │  • Active users                               │  │
           │  │  • Current page state (agent's representation)│  │
           │  │  • Ingested content index                     │  │
           │  └───────────────────────────────────────────────┘  │
           └─────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Shared Live Page

All users see the **same page** - the agent's best representation of all ingested knowledge.

**Features:**
- Hierarchical/collapsible structure (topics as expandable buttons)
- Real-time updates when new data is ingested
- Abbreviated view by default, drill-down on demand
- Highlights conflicts, consensus, key insights

**Update Flow:**
```
New data ingested
    ↓
Agent re-evaluates representation
    ↓
Broadcast updated page to all clients
    ↓
All users see the same updated view
```

### 2. Input Methods

#### A. Voice Input (Piper STT)
- Browser captures audio
- Streams to server
- Piper converts to text
- Text is embedded and stored

#### B. Text Chat
- User types message
- Agent responds (with access to all vector content)
- Response broadcast to all users
- Conversation history stored **client-side only**

#### C. File Upload
Supported formats:
- **TXT** - Direct text extraction
- **MD** - Direct text extraction
- **PDF** - pdf-parse or similar
- **DOCX** - mammoth or similar

**Flow:**
```
User uploads file
    ↓
Server parses → extracts text
    ↓
Text chunked (if large)
    ↓
Each chunk embedded (Gemini)
    ↓
Stored in Redis vector DB
    ↓
Agent updates shared page
    ↓
All users see update
```

### 3. AI Agent (Gemini 3 Flash)

```javascript
// DO NOT MODIFY - Model specified by user, verified from docs
const MODEL = "gemini-3-flash-preview";
```

**Agent Tools:**
1. `getAllContent()` - Retrieve full text of all ingested content
2. `vectorSearch(query, k)` - Semantic search over all content
3. `getContentBySource(sourceId)` - Get specific file/message content
4. `createRelationship(from, to, type, evidence)` - Link content nodes
5. `getRelationships(contentId)` - Get all relationships for a node
6. `queryRelationships(type)` - Find all relationships of a type (e.g., "contradicts")

**Agent Responsibilities:**
- Respond to user messages using relevant context
- Render the shared page representation (hierarchical, never-delete, always-contextualize)
- Create and maintain relationship objects between content
- Generate comprehensive markdown exports

### 4. Hierarchical Representation Model

**Core Principle**: Nothing is deleted, only reorganized and abbreviated.

On each new input, the agent:
1. Ingests content into vector DB
2. Considers the **full corpus** (complete picture)
3. Identifies where new content fits in existing hierarchy
4. Creates relationship objects linking to related content
5. Possibly reorganizes (a topic may become a subtopic of a newly-emerged theme)
6. Adjusts detail levels (abbreviates less critical areas)
7. Broadcasts updated page to all users

**As Corpus Grows:**
- Top-level stays readable (major themes)
- Subtopics collapse but remain present
- Details accessible via drill-down
- Abbreviation is presentational, not data loss

### 5. Relationship Junction Objects

Like graph DB edges, but as first-class objects with their own data.

**Structure:**
```
Relationship {
  id: uuid
  from: content_id
  to: content_id
  type: "supports" | "contradicts" | "elaborates" | "depends_on" | "supersedes" | "parent_of"
  strength: 0.0 - 1.0
  evidence: "Why this relationship exists"
  discovered_at: timestamp
  discovered_by: "ingestion" | "agent_reorg" | "user"
}
```

**Relationship Types:**
| Type | Meaning |
|------|---------|
| `supports` | A provides evidence for B |
| `contradicts` | A conflicts with B |
| `elaborates` | A adds detail to B |
| `depends_on` | A requires B to make sense |
| `supersedes` | A replaces/updates B |
| `parent_of` | A is a theme containing B as subtopic |

**Redis Storage:**
```
# Content nodes
content:{id} → {text, embedding, source, timestamp, ...}

# Relationship objects (junction table pattern)
relationship:{id} → {from, to, type, strength, evidence, ...}

# Indexes for fast lookups
content:{id}:rels:outgoing → [rel_id, ...]
content:{id}:rels:incoming → [rel_id, ...]
relationships:by_type:{type} → [rel_id, ...]
```

**Value:**
- Query "show all contradictions" instantly
- Explain why things are linked
- Relationships evolve as context grows
- Hierarchies are explicit (parent_of relationships)

### 6. Client-Side Conversation

- Chat history lives in browser localStorage/memory
- Lost on page refresh
- But the **knowledge** persists in vector DB
- User can continue asking questions, agent still has all context

### 7. Markdown Export

**Critical Requirement**: Export must be comprehensive enough that importing it into a new session restores the semantic state.

**Export Structure:**
```markdown
# Polyphony Session: [Topic/Title]
Generated: [timestamp]
Participants: [count]

## Key Topics

### Topic A
[Full content/summary]
- Sub-point 1
- Sub-point 2

### Topic B
[Full content/summary]

## Conflicts & Tensions
- X vs Y: [description]

## Consensus Points
- [agreed items]

## Source Materials
### Uploaded Files
- filename.pdf: [summary]
- document.docx: [summary]

### Voice Contributions
- [transcripts or summaries]

### Chat Highlights
- [key exchanges]

## Raw Content Index
[For restoration - all key text that would be needed to rebuild vector DB]
```

**Restoration Flow:**
```
User uploads previous session's markdown
    ↓
Agent ingests and chunks
    ↓
Key topics re-emerge naturally
    ↓
Session effectively restored at semantic level
```

---

## Data Flow Examples

### Example 1: File Upload
```
1. User drags PDF into upload zone
2. Server receives file via Socket.io binary
3. pdf-parse extracts text
4. Text split into ~500 token chunks
5. Each chunk → Gemini embedding → Redis vector store
6. Agent regenerates shared page
7. All clients receive page update
8. Users see new topic appear on shared view
```

### Example 2: Voice Input
```
1. User clicks mic, speaks
2. Audio chunks stream to server
3. Piper STT converts to text
4. Text embedded and stored
5. Agent updates page
6. All users see contribution
```

### Example 3: Question/Response
```
1. User types: "What are the main disagreements?"
2. Server receives message
3. Agent does vector search for conflict-related content
4. Agent generates response using Gemini
5. Response sent to user (stored client-side)
6. Response also broadcast so all users see it
```

### Example 4: Session End & Export
```
1. User clicks "Export"
2. Agent generates comprehensive markdown
3. User downloads file
4. Last user disconnects
5. Redis data deleted
6. Everything vanishes
```

---

## Technical Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| Runtime | Node.js 20+ | |
| Server | Express + Socket.io | Real-time bidirectional |
| Database | Redis Stack | Vector search, ephemeral |
| AI Model | Gemini 3 Flash | DO NOT MODIFY |
| STT | Piper | Local, fast, privacy-friendly |
| PDF Parse | pdf-parse | Node library |
| DOCX Parse | mammoth | Node library |
| Embeddings | Gemini | Same model for consistency |
| Frontend | TBD (React/Vue/Svelte) | Shared reactive view |

---

## Implementation Phases

### Phase 1: File Ingestion Pipeline
- [ ] File upload handler (Socket.io binary)
- [ ] PDF parser integration (pdf-parse)
- [ ] DOCX parser integration (mammoth)
- [ ] TXT/MD direct ingestion
- [ ] Text chunking logic
- [ ] Gemini embedding integration
- [ ] Redis vector storage

### Phase 2: Gemini Agent Core
- [ ] Gemini 3 Flash client setup
- [ ] Agent tools (getAllContent, vectorSearch)
- [ ] Message response handler
- [ ] Page rendering logic

### Phase 3: Shared Page System
- [ ] Page state structure
- [ ] Broadcast mechanism
- [ ] Client rendering (collapsible/expandable)
- [ ] Real-time sync

### Phase 4: Voice Input (Piper)
- [ ] Audio capture (browser)
- [ ] Stream to server
- [ ] Piper STT integration
- [ ] Text → embedding → storage flow

### Phase 5: Export System
- [ ] Comprehensive markdown generation
- [ ] Download mechanism
- [ ] Import/restore flow

### Phase 6: Session Management
- [ ] Room creation/joining
- [ ] User tracking
- [ ] Cleanup on last disconnect
- [ ] Grace period handling

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Event-driven, no synthesis loop** | Simpler, more responsive, processes data as it arrives |
| **Same view for all users** | True shared context, everyone sees what the agent sees |
| **Client-side conversation history** | Keeps server stateless for chat, reduces complexity |
| **Comprehensive MD export** | Enables semantic restoration without exact state preservation |
| **Gemini 3 Flash** | User-specified, fast, capable |
| **Piper STT** | Local processing, no external API dependency for voice |
| **Collapsible UI** | Handles information density without overwhelming |

---

## Removed from Original Plan

The following were in the original architecture but are **no longer part of the design**:

- ~~3-5 second synthesis loop~~ → Replaced with event-driven updates
- ~~Per-user personalized views~~ → All users see same shared page
- ~~LangGraph state machine~~ → Simple agent with tools
- ~~OpenAI/Cohere embeddings~~ → Using Gemini for consistency
- ~~30-minute TTL on vectors~~ → Data lives until room closes
- ~~Automatic periodic synthesis~~ → Agent responds on-demand

---

## Open Questions / Future

- Collapsible UI component library choice
- Maximum file size limits
- Chunking strategy optimization
- Multi-room support (multiple parallel sessions)
- Authentication/user identity
- Rate limiting for AI calls
