# Polyphony.live: Core Intelligence Diagnosis & Improvement Plan

## Executive Summary

The agent is producing generic, hallucinated responses instead of grounding answers in specific document content because of several architectural gaps in the retrieval and prompting pipeline. This document outlines the specific issues found and the fixes required.

---

## Current Architecture Flow

```
User Question
    ↓
[vectorDB.searchKnowledge(roomId, query, 5)]  ← ONLY 5 CHUNKS!
    ↓
Build System Prompt (WITHOUT retrieved chunks - code commented out!)
    ↓
Send to Gemini with generic instructions
    ↓
Response (often hallucinated because no grounding context)
```

---

## Issue-by-Issue Diagnosis

### ISSUE 1: Retrieval Breadth is Too Narrow

**Location:** 
- `src/services/agent/polyphonyAgent.js:130`
- `src/services/agent/langGraphAgent.js:474`

**Current Code:**
```javascript
// Only retrieves 5 chunks!
const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, content, 5);
```

**Problem:**
- For synthesis questions like "what are the biggest conflicts between PM and developer priorities?", 5 chunks is insufficient
- User's documents contain 10+ chunks per file across multiple files
- With only 5 results, the agent might get 3 chunks from the PM's PRD and only 2 from the developer's API docs
- Missing the developer's perspective entirely or only getting one side of the conflict

**Impact:**
- Agent sees incomplete picture - might only see PM requirements (5-min score updates, $180K budget, Aug 15 deadline)
- Misses developer constraints (84.7% API capacity, 72% CPU, trigger limitations, May 15 at-risk)
- Falls back to generic knowledge about "PMs often prioritize speed"

---

### ISSUE 2: System Prompt Does NOT Include Retrieved Context

**Location:** `src/services/agent/polyphonyAgent.js:343-388`

**Current Code:**
```javascript
buildSystemPrompt(relevantKnowledge, files, roomState, userName) {
  let prompt = `You are a knowledge synthesis agent...`;
  // ...
  // Lines 361-377: The code that adds relevantKnowledge is COMMENTED OUT!
  /*
  if (relevantKnowledge.length > 0) {
    prompt += `\nRelevant knowledge from the space:\n`;
    // ...
  }
  */
}
```

**Problem:**
- The retrieved knowledge is passed to `buildSystemPrompt()` but NEVER actually included in the prompt
- The agent has NO access to the vector search results when generating responses
- It's essentially operating blind, only knowing that files exist (from the file list)

**Impact:**
- Agent cannot reference specific facts, numbers, or requirements from documents
- Cannot make cross-document connections because it never sees the content
- Forced to rely on training data which produces generic platitudes

---

### ISSUE 3: System Prompt Lacks Grounding Instructions

**Location:** `src/services/agent/polyphonyAgent.js:347-348`

**Current Prompt:**
```
You are a knowledge synthesis agent. Use the provided tools to process knowledge 
and update the shared canvas.
```

**Problem:**
- No instruction to ground responses in specific document content
- No prohibition against using generic knowledge
- No requirement to cite specific sources
- No instruction on what to do when information is missing

**Impact:**
- Model defaults to training data when it should say "I don't have that information"
- Produces blog-post-level insights instead of document-specific analysis
- No incentive to search deeper or retrieve more context

---

### ISSUE 4: contribute() Tool Does NOT Retrieve Before Contributing

**Location:** `src/services/agent/langGraphAgent.js:743-789`

**Current Code:**
```javascript
async executeContributeTool(args, context) {
  const { type, title, content, importance = 5, tags = [] } = args;
  // ... directly creates knowledge entry WITHOUT any retrieval
  await this.vectorDB.createKnowledgeEntry(roomId, userId, title, content, ...);
}
```

**Problem:**
- When the agent decides to contribute knowledge, it does so based ONLY on its current context
- No retrieval is performed to enrich the contribution with existing knowledge
- Cannot synthesize across documents because it doesn't query for related content

**Impact:**
- Contributions are shallow summaries of single sources
- No cross-document synthesis happens at contribution time
- Knowledge base accumulates isolated facts rather than connected insights

---

### ISSUE 5: No Cross-Document Query Strategy

**Location:** `src/services/agent/langGraphAgent.js:459-548` (answerQuestionNode)

**Current Code:**
```javascript
// Single query only
const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, query, 5);
```

**Problem:**
- For synthesis questions like "compare PM and developer priorities", there's no strategy to ensure both sides are retrieved
- Single vector search might return 5 chunks all from one document if it's semantically closer
- No detection of synthesis keywords ("compare", "conflict", "both sides", "differences")
- No multi-query approach to get diverse perspectives

**Impact:**
- Agent gets unbalanced view - might see only PM perspective or only developer perspective
- Cannot identify conflicts because it doesn't have both sides
- Misses the specific numbers and constraints that would reveal tensions

---

### ISSUE 6: Extended Storage Not Searched

**Location:** `src/services/agent/memoryManager.js:476-498`

**Current Behavior:**
- When memory is full, entries are offloaded to disk (`offloadToExtendedStorage`)
- A reference entry replaces the content: `[Stored in extended memory - ${entry.tokenEstimate} tokens]`
- The `searchEntries()` method at line 185 can find these reference entries but the actual content is NOT searchable via vector similarity

**Problem:**
- Rich data points pushed to "extended storage" are effectively invisible to vector search
- The reference entries contain no content to match against queries
- Even if retrieved, they don't contain the actual information

**Impact:**
- Critical details that were compressed or offloaded are lost for synthesis
- Agent cannot access the full corpus of uploaded documents
- Large files with strategic sampling (lazy chunks) may have critical sections unsearchable

---

### ISSUE 7: Importance Scoring Doesn't Weight Cross-Document Connections

**Location:** `src/services/agent/langGraphAgent.js:362-454` (refreshCanvasNode)

**Current Prompt:**
```javascript
Organize by IMPORTANCE to the central topic:
- Level 1: Major concepts/themes from the conversation (3-5 items)
- Level 2: Supporting ideas (2-4 per Level 1)
- Level 3: Specific details/examples
```

**Problem:**
- No instruction that cross-document conflicts/connections are MORE important than single-source knowledge
- A PM requirement (from one doc) gets same importance weight as the CONFLICT between PM req and dev constraint
- No bonus for "tension points" or "trade-offs" that span multiple sources

**Impact:**
- Conflicts get buried under individual document summaries
- The most valuable synthesis insights (cross-document tensions) are deprioritized
- Canvas shows isolated facts instead of connected understanding

---

## Required Fixes (In Priority Order)

### FIX 1: Restore Retrieved Context to System Prompt (CRITICAL)

**File:** `src/services/agent/polyphonyAgent.js`

**Change:**
- Uncomment and fix the code at lines 361-377 that includes `relevantKnowledge` in the system prompt
- Ensure retrieved chunks are formatted with their source document and specific content

**Expected Impact:**
- Agent will see actual document content when generating responses
- Can reference specific facts, numbers, and requirements
- Reduces hallucination by providing grounding context

---

### FIX 2: Add Explicit Grounding Instructions to System Prompt (CRITICAL)

**File:** `src/services/agent/polyphonyAgent.js`

**Change:**
Replace the generic prompt with explicit grounding instructions:
```
You are a knowledge synthesis agent. Your responses MUST be grounded in the 
uploaded documents. 

CRITICAL INSTRUCTIONS:
1. You MUST only reference specific facts, numbers, and details from the uploaded documents
2. NEVER produce generalized knowledge or platitudes like "PMs often prioritize speed"
3. Every claim must be traceable to a specific document with specific evidence
4. Cite document names and specific data points (e.g., "According to the PRD, FR-1 requires...")
5. If you cannot find relevant information in the provided context, say "I don't have specific 
   information about that in the uploaded documents"
6. When comparing or finding conflicts, retrieve content from BOTH sides before responding

You have access to these tools:
- search_knowledge: Query the vector database for specific information
- read_file_section: Read specific parts of uploaded documents
- contribute: Add synthesized insights to the shared canvas
```

**Expected Impact:**
- Model understands it must ground responses in documents
- Knows to say "I don't know" rather than hallucinate
- Will use search tools more aggressively to find evidence

---

### FIX 3: Increase Retrieval Breadth for Synthesis Questions (HIGH)

**Files:** 
- `src/services/agent/polyphonyAgent.js:130`
- `src/services/agent/langGraphAgent.js:474`

**Change:**
```javascript
// Detect synthesis keywords
const synthesisKeywords = ['conflict', 'compare', 'difference', 'both', 'vs', 'versus', 
  'priorities', 'tension', 'trade-off', 'tradeoff', 'how does', 'affect', 'impact'];
const isSynthesisQuestion = synthesisKeywords.some(kw => query.toLowerCase().includes(kw));

// Retrieve more chunks for synthesis questions
const retrievalLimit = isSynthesisQuestion ? 12 : 5;
const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, query, retrievalLimit);
```

**Expected Impact:**
- Synthesis questions get 12 chunks instead of 5
- Much higher probability of seeing both PM and developer perspectives
- Better coverage of large documents

---

### FIX 4: Add Retrieval Step Before contribute() (HIGH)

**File:** `src/services/agent/langGraphAgent.js:743-789`

**Change:**
```javascript
async executeContributeTool(args, context) {
  const { roomId, userId, userName } = context;
  const { type, title, content, importance = 5, tags = [] } = args;
  
  // NEW: Retrieve relevant knowledge to enrich contribution
  const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, title, 8);
  
  // NEW: If this is a synthesis-type contribution, enhance it
  let enhancedContent = content;
  if (relevantKnowledge.length > 0 && type === 'synthesis') {
    // Re-generate contribution with full context
    const synthesisPrompt = `Synthesize a comprehensive insight about "${title}" 
    using these relevant sources:
    
    ${relevantKnowledge.map(k => `- ${k.topic}: ${k.content}`).join('\n')}
    
    Original draft: ${content}
    
    Create an enhanced version that:
    1. Cites specific facts and numbers from the sources
    2. Identifies connections between different sources
    3. Notes any conflicts or tensions
    4. Is grounded in the actual document content`;
    
    const response = await this.model.invoke([new SystemMessage(synthesisPrompt)]);
    enhancedContent = response.content.toString();
  }
  
  // Use enhancedContent instead of content
  await this.vectorDB.createKnowledgeEntry(roomId, userId, title, enhancedContent, ...);
}
```

**Expected Impact:**
- Contributions are enriched with retrieved context
- Cross-document synthesis happens at contribution time
- Knowledge base contains connected, grounded insights

---

### FIX 5: Implement Multi-Query Retrieval for Synthesis Questions (MEDIUM)

**File:** `src/services/agent/langGraphAgent.js:459-548`

**Change:**
```javascript
// Detect synthesis questions and do multi-query retrieval
const synthesisPatterns = [
  { pattern: /conflict|tension|disagree/i, queries: ['PM priorities requirements', 'developer constraints limitations'] },
  { pattern: /compare|difference|vs|versus/i, queries: ['PM perspective', 'developer perspective'] },
  { pattern: /budget|cost|price/i, queries: ['budget cost financial', 'expense pricing'] },
  { pattern: /timeline|deadline|schedule/i, queries: ['timeline deadline date', 'schedule milestone'] },
];

let relevantKnowledge = [];
const matchedPattern = synthesisPatterns.find(p => p.pattern.test(query));

if (matchedPattern) {
  // Do multiple targeted retrievals
  for (const subQuery of matchedPattern.queries) {
    const results = await this.vectorDB.searchKnowledge(roomId, subQuery, 6);
    relevantKnowledge.push(...results);
  }
  // Deduplicate by ID
  relevantKnowledge = [...new Map(relevantKnowledge.map(k => [k.id, k])).values()];
} else {
  relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, query, 5);
}
```

**Expected Impact:**
- For conflict questions, explicitly retrieves both PM and dev perspectives
- Ensures balanced view for comparison questions
- Higher chance of finding cross-document connections

---

### FIX 6: Weight Cross-Document Connections Higher in Importance (MEDIUM)

**File:** `src/services/agent/langGraphAgent.js:362-454`

**Change:**
Add to the refresh canvas prompt:
```
IMPORTANCE SCORING:
- Cross-document conflicts or tensions: 9-10 (highest priority)
- Cross-document connections/synthesis: 8-9 (high priority)  
- Single-document key insights: 6-8 (medium priority)
- Background context: 3-5 (lower priority)

When you identify a conflict between two documents (e.g., PM requires X but 
Developer says Y is impossible), this is the MOST important information to 
display prominently.
```

**Expected Impact:**
- Conflicts appear at top of canvas
- Cross-document synthesis gets priority over isolated facts
- Users see the most valuable insights first

---

### FIX 7: Ensure Extended Storage Content is Searchable (LOW - Future)

**Problem:** Offloaded/compressed memory entries lose their searchable content

**Approach:** 
- When offloading, still index the content in vector DB with a reference flag
- Or use a two-stage retrieval: find reference entries, then load from extended storage
- For now, increase memory limits to reduce offloading frequency

**Quick Fix:**
```javascript
// In memoryManager.js - increase thresholds
const MEMORY_CONFIG = {
  WORKING_MEMORY_TOKENS: 16000,      // Increased from 8000
  COMPRESSED_MEMORY_TOKENS: 32000,   // Increased from 16000
  TOTAL_MEMORY_TOKENS: 128000,       // Increased from 64000
  // ...
};
```

---

## Implementation Checklist

- [ ] FIX 1: Restore retrieved context to system prompt in polyphonyAgent.js
- [ ] FIX 2: Add explicit grounding instructions to system prompt
- [ ] FIX 3: Increase retrieval limit for synthesis questions (5 → 12)
- [ ] FIX 4: Add retrieval step before contribute() execution
- [ ] FIX 5: Implement multi-query retrieval for synthesis patterns
- [ ] FIX 6: Update canvas refresh prompt to weight cross-document connections higher
- [ ] FIX 7: Increase memory limits to reduce extended storage issues
- [ ] TEST: Verify agent cites specific document data in responses
- [ ] TEST: Verify agent identifies conflicts between PM and developer docs
- [ ] TEST: Verify agent does not produce generic platitudes

---

## Testing Strategy

### Test Case 1: Specific Data Grounding
**Input:** "What are the PM's requirements for score updates?"
**Expected:** Response cites "FR-1, P0 requirement" and "5 minutes" specifically from PRD
**Failure:** Generic response about "PMs typically want fast updates"

### Test Case 2: Cross-Document Conflict Detection  
**Input:** "What are the biggest conflicts between PM and developer priorities?"
**Expected:** Response identifies specific conflicts:
- PM: 5-min score updates (FR-1) vs Dev: API at 84.7% capacity
- PM: $180K budget vs Dev: $25-100K additional cost flagged
- PM: Aug 15 deadline vs Dev: May 15 MVP "AT RISK"
**Failure:** Generic response about "communication issues" or "different priorities"

### Test Case 3: Constraint Awareness
**Input:** "What technical constraints affect the score update requirement?"
**Expected:** Response cites:
- "CPU time is at 72% utilization"
- "Synchronous callouts prohibited in trigger context"
- "Org at 84.7% daily API capacity (847K of 1M calls)"
**Failure:** Generic response about "technical debt" or "system limitations"

---

## Success Metrics

1. **Citation Rate:** Agent cites specific document sources in >80% of factual claims
2. **Specificity Score:** Responses contain specific numbers/dates/requirements vs generic statements
3. **Conflict Detection:** Agent correctly identifies >70% of explicit cross-document conflicts
4. **Hallucination Rate:** <10% of responses contain claims not found in uploaded documents
