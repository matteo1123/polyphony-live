# Polyphony.live: Core Intelligence Improvements - Summary of Changes

## Overview

This document summarizes all changes made to fix the agent's grounding issues. The agent was producing generic, hallucinated responses instead of grounding answers in specific document content.

---

## Changes Made

### 1. Fixed System Prompt to Include Retrieved Context (CRITICAL)

**File:** `src/services/agent/polyphonyAgent.js`

**Before:**
- The `buildSystemPrompt()` method received `relevantKnowledge` as a parameter but the code to include it in the prompt was **commented out** (lines 361-377)
- The agent was essentially "flying blind" - it knew files existed but couldn't see their content

**After:**
- Uncommented and enhanced the code that includes retrieved knowledge in the system prompt
- Now formats each retrieved entry with:
  - Numbered index for easy reference
  - Source topic/title
  - Full content (up to 400 chars)
  - Tags for context
- Added explicit warning when no relevant knowledge is found

**Code Location:** `buildSystemPrompt()` method, lines 343-430

**Expected Impact:**
- Agent now sees actual document content when generating responses
- Can reference specific facts, numbers, and requirements
- Reduces hallucination by providing grounding context

---

### 2. Added Explicit Grounding Instructions to System Prompt (CRITICAL)

**Files:** 
- `src/services/agent/polyphonyAgent.js` 
- `src/services/agent/langGraphAgent.js`

**Before:**
```
You are a knowledge synthesis agent. Use the provided tools to process knowledge 
and update the shared canvas.
```
- No instruction to ground responses in document content
- No prohibition against using generic knowledge
- No requirement to cite sources

**After:**
Added explicit grounding instructions:
```
CRITICAL INSTRUCTIONS - YOUR RESPONSES MUST BE GROUNDED:
1. You MUST only reference specific facts, numbers, dates, requirements, and details 
   from the RELEVANT KNOWLEDGE provided below
2. NEVER produce generalized knowledge, platitudes, or training data (e.g., NEVER say 
   "PMs often prioritize speed" - instead cite the specific requirement from the documents)
3. Every claim must be traceable to a specific source with specific evidence
4. ALWAYS cite your sources: mention document names, requirement IDs, and specific data points
5. If you cannot find relevant information in the provided context, say 
   "I don't have specific information about that in the uploaded documents" - DO NOT hallucinate
6. When asked about conflicts, comparisons, or relationships between sources, ensure you 
   cite evidence from ALL relevant perspectives
7. Prefer specific numbers and requirements over general descriptions
```

**Code Locations:**
- `polyphonyAgent.js`: `buildSystemPrompt()` method
- `langGraphAgent.js`: `answerQuestionNode()` method, lines 576-620

**Expected Impact:**
- Model understands it must ground responses in documents
- Knows to say "I don't know" rather than hallucinate
- Will use search tools more aggressively to find evidence

---

### 3. Increased Retrieval Breadth for Synthesis Questions (HIGH)

**File:** `src/services/agent/polyphonyAgent.js`

**Before:**
```javascript
const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, content, 5);
// Always 5 chunks regardless of question type
```

**After:**
- Added `isSynthesisQuestion()` method to detect synthesis keywords
- Added `getRetrievalLimit()` method that returns:
  - 12 chunks for synthesis questions (conflicts, comparisons, etc.)
  - 5 chunks for standard questions
- Synthesis keywords detected: 'conflict', 'compare', 'difference', 'both', 'vs', 
  'priorities', 'tension', 'trade-off', 'how does', 'affect', 'impact', etc.

**Code Location:** Lines 123-154, new methods added

**Example:**
- User asks: "What are the biggest conflicts between PM and developer priorities?"
- System detects synthesis keywords ('conflicts', 'priorities')
- Retrieves 12 chunks instead of 5
- Higher probability of capturing both PM and developer perspectives

**Expected Impact:**
- Synthesis questions get 12 chunks instead of 5
- Much higher probability of seeing both perspectives
- Better coverage of large documents

---

### 4. Added Retrieval Before contribute() Execution (HIGH)

**File:** `src/services/agent/langGraphAgent.js`

**Before:**
```javascript
async executeContributeTool(args, context) {
  // Directly creates knowledge entry WITHOUT any retrieval
  await this.vectorDB.createKnowledgeEntry(roomId, userId, title, content, ...);
}
```

**After:**
- Added `shouldEnrichContribution()` method to detect synthesis-type contributions
- Added retrieval step that:
  1. Searches for relevant knowledge (8 results)
  2. If found, uses LLM to enhance the contribution with specific facts
  3. Cites sources in the enriched content
- Enrichment keywords: 'synthesis', 'insight', 'conflict', 'comparison', 'summary'

**Code Location:** Lines 756-848, `executeContributeTool()` method

**Example Flow:**
1. Agent wants to contribute: "Conflict between PM and Dev priorities"
2. Retrieves relevant knowledge about PM requirements and dev constraints
3. Enhances content with specific facts:
   - "PRD (FR-1) requires score updates within 5 minutes"
   - "API doc shows 84.7% capacity (847K of 1M calls)"
   - "CPU at 72%, synchronous callouts prohibited"
4. Stores enriched, grounded contribution

**Expected Impact:**
- Contributions are enriched with retrieved context
- Cross-document synthesis happens at contribution time
- Knowledge base contains connected, grounded insights

---

### 5. Implemented Multi-Query Retrieval for Synthesis Questions (MEDIUM)

**File:** `src/services/agent/langGraphAgent.js`

**Before:**
```javascript
// Single query only
const relevantKnowledge = await this.vectorDB.searchKnowledge(roomId, query, 5);
```

**After:**
- Added `detectSynthesisPattern()` method that recognizes 7 types of synthesis questions:
  1. Conflict detection: queries for 'PM requirements' AND 'developer constraints'
  2. Comparison: queries for 'PM perspective' AND 'developer perspective'
  3. Budget analysis: queries for 'budget' AND 'expense'
  4. Timeline analysis: queries for 'timeline' AND 'schedule'
  5. Priorities: queries for 'priorities' AND 'critical requirements'
  6. Constraints: queries for 'constraints' AND 'limitations'
  7. Cross-cutting: queries for 'impact' AND 'dependencies'

- Added `performMultiQueryRetrieval()` method that:
  1. Executes multiple targeted queries based on pattern
  2. Deduplicates results by ID
  3. Sorts by relevance score
  4. Returns top 12 results

**Code Location:** Lines 459-545, new methods added

**Example:**
- User asks: "What are the conflicts between PM and developer?"
- Pattern detected: `conflict_detection`
- Queries executed:
  - "PM requirements priorities" → 6 results
  - "developer constraints limitations" → 6 results
  - "stakeholder priorities" → 6 results
  - "technical constraints" → 6 results
  - General query → 6 results
- Deduplicated and top 12 returned

**Expected Impact:**
- Ensures balanced retrieval from both sides of a comparison
- Higher chance of finding cross-document connections
- Better coverage of diverse perspectives

---

### 6. Weighted Cross-Document Connections Higher in Canvas (MEDIUM)

**File:** `src/services/agent/langGraphAgent.js`

**Before:**
```
Organize by IMPORTANCE to the central topic:
- Level 1: Major concepts/themes from the conversation (3-5 items)
- Level 2: Supporting ideas (2-4 per Level 1)
- Level 3: Specific details/examples

Importance: 1-10 based on centrality to the actual discussion
```

**After:**
Added explicit importance scoring guide:
```
IMPORTANCE SCORING GUIDE:
- 10: Critical cross-document conflict or tension (highest priority)
- 9: Cross-document synthesis or significant alignment
- 8: Key single-document insight with specific numbers/requirements
- 5-7: Supporting concepts
- 3-4: Background details
- 1-2: Minor points

WHEN YOU IDENTIFY A CONFLICT (e.g., "PRD requires 5-min updates" vs "API doc shows 84.7% capacity"):
- Create a specific node titled something like "Conflict: X vs Y"
- Give it importance: 10
- Include specific details from BOTH sources
- This is MORE important than individual document summaries
```

**Code Location:** `refreshCanvasNode()` method, lines 385-432

**Expected Impact:**
- Conflicts appear at top of canvas with importance 10
- Cross-document synthesis gets priority over isolated facts
- Users see the most valuable insights first
- Canvas shows connected understanding, not isolated facts

---

### 7. Increased Memory Limits (LOW)

**File:** `src/services/agent/memoryManager.js`

**Before:**
```javascript
const MEMORY_CONFIG = {
  WORKING_MEMORY_TOKENS: 8000,      // ~6k tokens
  COMPRESSED_MEMORY_TOKENS: 16000,  // ~12k tokens
  TOTAL_MEMORY_TOKENS: 64000,       // ~48k tokens
  COMPRESSION_THRESHOLD: 0.7,       // Compress at 70%
  URGENT_THRESHOLD: 0.9,            // Urgent at 90%
}
```

**After:**
```javascript
const MEMORY_CONFIG = {
  WORKING_MEMORY_TOKENS: 16000,     // ~12k tokens (was 8000)
  COMPRESSED_MEMORY_TOKENS: 32000,  // ~24k tokens (was 16000)
  TOTAL_MEMORY_TOKENS: 128000,      // ~96k tokens (was 64000)
  COMPRESSION_THRESHOLD: 0.75,      // Compress at 75% (was 70%)
  URGENT_THRESHOLD: 0.92,           // Urgent at 92% (was 90%)
}
```

**Code Location:** Lines 15-33

**Expected Impact:**
- More content stays in searchable working memory
- Less content gets offloaded to extended storage
- Reduced risk of losing searchable content

---

### 8. Consistent Retrieval Increases in Other Methods (LOW)

**File:** `src/services/agent/langGraphAgent.js`

**Changes:**
- `handleTopicExpansion()`: 5 → 8 chunks
- `handleDiagramGeneration()`: 5 → 8 chunks

**Expected Impact:**
- Topic expansions have more context
- Diagrams are generated with richer content
- Consistent behavior across all retrieval operations

---

## Testing Recommendations

### Test Case 1: Specific Data Grounding
**Input:** "What are the PM's requirements for score updates?"
**Expected:** Response cites "FR-1, P0 requirement" and "5 minutes" specifically from PRD
**Check:** Verify citation of specific document and requirement ID

### Test Case 2: Cross-Document Conflict Detection
**Input:** "What are the biggest conflicts between PM and developer priorities?"
**Expected:** Response identifies specific conflicts:
- PM: 5-min score updates (FR-1) vs Dev: API at 84.7% capacity
- PM: $180K budget vs Dev: $25-100K additional cost
- PM: Aug 15 deadline vs Dev: May 15 MVP "AT RISK"
**Check:** Verify all three conflicts are mentioned with specific numbers

### Test Case 3: Constraint Awareness
**Input:** "What technical constraints affect the score update requirement?"
**Expected:** Response cites:
- "CPU time is at 72% utilization"
- "Synchronous callouts prohibited in trigger context"
- "Org at 84.7% daily API capacity (847K of 1M calls)"
**Check:** Verify specific technical constraints with numbers

### Test Case 4: Hallucination Prevention
**Input:** "What are the marketing team's priorities?" (when no marketing docs exist)
**Expected:** "I don't have specific information about marketing team priorities in the uploaded documents"
**Check:** Verify agent admits lack of knowledge instead of hallucinating

---

## Success Metrics

| Metric | Before | Target After |
|--------|--------|--------------|
| Citation Rate | ~10% | >80% |
| Specificity Score | Low | High |
| Conflict Detection | ~20% | >70% |
| Hallucination Rate | ~40% | <10% |

---

## Files Modified

1. `src/services/agent/polyphonyAgent.js` - Main agent system prompt and retrieval logic
2. `src/services/agent/langGraphAgent.js` - LangGraph agent with multi-query retrieval
3. `src/services/agent/memoryManager.js` - Memory limits increased

---

## Next Steps

1. Deploy changes to staging environment
2. Run test cases with sample PM and Developer documents
3. Monitor logs for:
   - "Using expanded retrieval" messages (indicates Fix 3 working)
   - "Multi-query retrieval" messages (indicates Fix 5 working)
   - "Enriching contribution" messages (indicates Fix 4 working)
4. Evaluate responses against success metrics
5. Iterate based on results
