# JIRA-19: Persist LLM Decision Metadata + Fix DebugOverlay Multi-Bot Display

## Problem 1: LLM Metadata Not Persisted

LLM decision metadata (reasoning, model, token usage, latency) is **ephemeral**. It flows through the pipeline but is never written to the database:

| Data | Where it exists today | Persisted? |
|------|----------------------|------------|
| `reasoning` | Socket event `bot:turn-complete` → client DebugOverlay | No |
| `planHorizon` | Socket event → client DebugOverlay | No |
| `model` | Console log `[DecisionLog]` only | No |
| `latencyMs` | Console log only | No |
| `tokenUsage` | Console log only | No |
| `retried` | Console log only | No |
| `guardrailOverride` | Socket event → client | No |

This means:
- Post-game analysis of bot behavior requires live observation or server log scraping
- No way to query "what model was used for turn X?" or "why did the bot pass on turn 12?"
- The `bot_turn_audits.details` JSONB column exists in the schema (migration 034) but is **never populated**

## Problem 2: DebugOverlay Multi-Bot & Missing Strategy Data

The in-game DebugOverlay (`src/client/components/DebugOverlay.ts`) has several gaps that make it inadequate for real-time bot observation:

### Only tracks the last bot's turn (single-bot state)

The overlay stores a **single** `lastBotTurnInfo` object. In a multi-bot game, each `bot:turn-complete` event **overwrites** the previous bot's data (line 171-218). There is no per-bot history:

```typescript
// Current: single slot, latest bot wins
private lastBotTurnInfo: { ... } | null = null;
```

When Bot A completes, its data shows briefly — then Bot B completes and overwrites it. By the time the human player looks at the overlay, they only see Bot B's last turn. No way to compare bots or review earlier decisions.

### Missing strategy fields from the socket event

Even for the one bot it does show, key LLM decision metadata is **never sent** in the `bot:turn-complete` event:

| Field | In BotTurnResult? | In socket event? | In DebugOverlay? |
|-------|-------------------|------------------|-------------------|
| `reasoning` | Yes | Yes | Yes |
| `planHorizon` | Yes | Yes | Yes |
| `guardrailOverride` | Yes | Yes | Yes |
| `model` | **No** (dropped) | **No** | **No** |
| `llmLatencyMs` | **No** (dropped) | **No** | **No** |
| `tokenUsage` | **No** (dropped) | **No** | **No** |
| `retried` | **No** (dropped) | **No** | **No** |
| `action` | Yes | Yes | Yes (in header) |

The `model` and `tokenUsage` are the most important missing fields — you can't tell whether the bot used Gemini or a heuristic fallback, or how expensive the call was.

### No turn history in the overlay

The overlay shows **only the latest turn** for any bot. There is no scrollable history of past turns. The socket event log captures raw JSON but truncates payloads to 100 chars (line 155), making it useless for reviewing strategy reasoning.

## Proposed Solution

Populate `bot_turn_audits.details` with LLM decision metadata from a **single insertion point** in `BotTurnTrigger.onTurnChange()`, after `AIStrategyEngine.takeTurn()` returns.

### Why BotTurnTrigger, not AIStrategyEngine or TurnExecutor

There are three candidate locations. Each has tradeoffs:

#### Option A: TurnExecutor (8 handler methods) — Rejected
- Requires modifying all 8 `handleXxx()` methods to accept and pass through LLM metadata
- TurnExecutor doesn't have access to `LLMDecisionResult` — it only receives `TurnPlan`
- Violates separation of concerns: TurnExecutor executes DB mutations, it shouldn't know about LLM metadata
- MultiAction plans create multiple audit rows — which one gets the metadata?

#### Option B: AIStrategyEngine.takeTurn() — Viable but fragile
- Has direct access to the `decision: LLMDecisionResult` object
- Would require a post-execution `UPDATE bot_turn_audits SET details = $1 WHERE game_id AND player_id AND turn_number`
- **Problem**: MultiAction plans produce multiple audit rows per turn. The UPDATE would set identical details on all of them, which is wasteful but not incorrect.
- **Problem**: The test suite for AIStrategyEngine is complex (25 tests, heavy mocking of `db.query`). Adding a new `db.query` call creates test isolation issues — `mockQuery.mockImplementation` overrides affect all queries in the pipeline, causing cascading failures in unrelated tests. This was observed during the initial implementation attempt.
- **Problem**: The UPDATE runs inside the same `try/catch` that wraps the entire pipeline. A failure path requires careful handling to avoid masking the real execution result.

#### Option C: BotTurnTrigger.onTurnChange() — Recommended
- **Already has the full `BotTurnResult`** which contains `reasoning`, `planHorizon`, `guardrailOverride`, `guardrailReason` (lines 126-147)
- **Runs after execution is complete** — zero risk of interfering with the critical transaction path
- **Single call site** — one UPDATE after `AIStrategyEngine.takeTurn()` returns, covering all action types
- **Simple to test** — BotTurnTrigger tests mock `db.query` independently, no interaction with TurnExecutor's complex transaction mocking
- **Only gap**: `BotTurnResult` doesn't currently include `model`, `latencyMs`, `tokenUsage`, or `retried`. These need to be added to the interface and populated in AIStrategyEngine.

### Data Flow (Current → Proposed)

```
Current:
  LLMStrategyBrain.decideAction()
    → LLMDecisionResult { reasoning, model, latencyMs, tokenUsage, retried }
      → AIStrategyEngine.takeTurn()
        → BotTurnResult { reasoning, planHorizon, guardrailOverride }  ← model/latency/tokens DROPPED
          → BotTurnTrigger.onTurnChange()
            → emitToGame('bot:turn-complete', { reasoning, planHorizon })  ← ephemeral
            → TurnExecutor audit INSERT (no details)

Proposed:
  LLMStrategyBrain.decideAction()
    → LLMDecisionResult { reasoning, model, latencyMs, tokenUsage, retried }
      → AIStrategyEngine.takeTurn()
        → BotTurnResult { reasoning, planHorizon, guardrailOverride,
                          model, latencyMs, tokenUsage, retried }  ← NEW FIELDS
          → BotTurnTrigger.onTurnChange()
            → emitToGame('bot:turn-complete', { ... })
            → UPDATE bot_turn_audits SET details = $1  ← NEW
              WHERE game_id = $2 AND player_id = $3 AND turn_number = $4
```

### details JSONB Schema

```json
{
  "reasoning": "[route-planned] Build toward Berlin for coal pickup. Building segment toward Berlin",
  "planHorizon": "Route: pickup(Coal@Katowice) → deliver(Coal@Roma)",
  "model": "gemini-3-pro-preview",
  "latencyMs": 1247,
  "tokenUsage": { "input": 4832, "output": 671 },
  "retried": false,
  "guardrailOverride": false,
  "guardrailReason": null
}
```

## Implementation Plan

### Task 1: Extend BotTurnResult interface (AIStrategyEngine.ts)

Add 4 new optional fields to `BotTurnResult`:

```typescript
export interface BotTurnResult {
  // ... existing fields ...
  // LLM metadata (new)
  model?: string;
  latencyMs?: number;       // rename from durationMs to avoid confusion
  llmLatencyMs?: number;    // LLM-specific latency (vs total pipeline durationMs)
  tokenUsage?: { input: number; output: number };
  retried?: boolean;
}
```

Populate them in `AIStrategyEngine.takeTurn()` return block (~line 405):

```typescript
return {
  // ... existing fields ...
  model: decision.model,
  llmLatencyMs: decision.latencyMs,
  tokenUsage: decision.tokenUsage,
  retried: decision.retried,
};
```

### Task 2: Persist details in BotTurnTrigger (BotTurnTrigger.ts)

After `AIStrategyEngine.takeTurn()` returns (line 122) and before `advanceTurnAfterBot()` (line 150), add a best-effort UPDATE:

```typescript
// Persist LLM decision metadata into audit records (best-effort)
try {
  const details = {
    reasoning: result.reasoning,
    planHorizon: result.planHorizon,
    model: result.model,
    llmLatencyMs: result.llmLatencyMs,
    tokenUsage: result.tokenUsage ?? null,
    retried: result.retried ?? false,
    guardrailOverride: result.guardrailOverride ?? false,
    guardrailReason: result.guardrailReason ?? null,
  };
  await db.query(
    `UPDATE bot_turn_audits SET details = $1
     WHERE game_id = $2 AND player_id = $3 AND turn_number = $4`,
    [JSON.stringify(details), gameId, currentPlayerId, turnNumber + 1],
  );
} catch (detailsErr) {
  console.error(`[BotTurnTrigger] LLM details UPDATE failed (turn executed):`,
    detailsErr instanceof Error ? detailsErr.message : detailsErr);
}
```

### Task 3: Tests

**BotTurnTrigger test** — verify:
- details UPDATE is called with correct JSONB after successful turn
- Pipeline doesn't crash if details UPDATE fails
- details contain all expected fields (reasoning, model, tokenUsage, etc.)

**AIStrategyEngine test** — verify:
- `BotTurnResult` includes new LLM metadata fields
- Route-executor path populates `model: 'route-executor'`
- LLM path populates actual model name and token counts

### Task 4: Enrich bot:turn-complete socket event

Add `model`, `llmLatencyMs`, `tokenUsage`, `retried` to the socket emission so the DebugOverlay can display them:

```typescript
emitToGame(gameId, 'bot:turn-complete', {
  // ... existing fields ...
  model: result.model,               // NEW
  llmLatencyMs: result.llmLatencyMs,  // NEW
  tokenUsage: result.tokenUsage,      // NEW
  retried: result.retried,            // NEW
});
```

### Task 5: DebugOverlay per-bot turn history (DebugOverlay.ts)

Replace the single `lastBotTurnInfo` slot with a **per-bot map + turn history ring buffer**:

```typescript
// Current (broken for multi-bot):
private lastBotTurnInfo: { ... } | null = null;

// Proposed:
private botTurnHistory: Map<string, BotTurnEntry[]> = new Map();  // botPlayerId → last N turns
private static readonly MAX_BOT_TURNS_PER_PLAYER = 10;
```

Where `BotTurnEntry` captures one turn's full data:

```typescript
interface BotTurnEntry {
  turnNumber: number;
  timestamp: number;
  action: string;
  durationMs: number;
  reasoning?: string;
  planHorizon?: string;
  model?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };
  retried?: boolean;
  guardrailOverride?: boolean;
  guardrailReason?: string;
  buildTrackData?: { segmentsBuilt: number; totalCost: number; targetCity?: string };
  movementData?: { from: { row: number; col: number }; to: { row: number; col: number }; mileposts: number; trackUsageFee: number };
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
  activeRoute?: { stops: Array<{ action: string; loadType: string; city: string }>; currentStopIndex: number; phase: string };
  demandRanking?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number }>;
}
```

On `bot:turn-complete`, push to the history for that bot (capped at 10 entries per bot).

### Task 6: DebugOverlay render per-bot sections (DebugOverlay.ts)

Replace `renderBotTurnSection()` with a new renderer that:

1. **Shows a tab/section per bot player** — each bot gets its own collapsible section with the bot name as header
2. **Shows the most recent turn prominently** with all fields including model, latency, token usage
3. **Shows turn history** as a scrollable list of past turns (condensed: turn#, action, reasoning summary, model, latency)
4. **Color-codes by bot** for visual differentiation

Layout sketch:
```
┌─ Bot: AlphaBot (Hard) ─────────────────────────────────┐
│ Turn 14: BuildTrack (gemini-3-pro-preview, 1247ms)      │
│ Strategy: [route-planned] Build toward Berlin for coal   │
│ Plan: Route: pickup(Coal@Katowice) → deliver(Coal@Roma)  │
│ Tokens: 4832 in / 671 out | Retried: No                 │
│                                                          │
│ History:                                                 │
│  T13: MoveTrain → "Moving along route to Katowice" (1.1s)│
│  T12: BuildTrack → "Build toward Wien" (1.3s)            │
│  T11: PassTurn → "No viable route" [guardrail] (0.8s)    │
└──────────────────────────────────────────────────────────┘
┌─ Bot: BetaBot (Medium) ────────────────────────────────┐
│ Turn 14: PickupLoad (gemini-3-pro-preview, 980ms)       │
│ ...                                                      │
└──────────────────────────────────────────────────────────┘
```

### Task 7: DebugOverlay display new LLM metadata fields (DebugOverlay.ts)

In the per-bot current turn display, add the new fields from Task 4:

```html
<!-- Model badge -->
<span style="...">gemini-3-pro-preview</span>

<!-- LLM latency (distinct from pipeline durationMs) -->
<span>LLM: 1247ms</span>

<!-- Token usage -->
<span>Tokens: 4832↓ 671↑</span>

<!-- Retried indicator -->
<span style="color:#fbbf24;">⟳ Retried</span>
```

### Task 8: DebugOverlay + BotTurnTrigger tests

**DebugOverlay tests** — add/update:
- Multi-bot: two bots complete turns → both have separate sections rendered
- Turn history: 5 turns for one bot → all 5 visible, newest first
- New fields: `model`, `llmLatencyMs`, `tokenUsage`, `retried` appear in rendered HTML
- Ring buffer cap: 11th turn evicts oldest

**BotTurnTrigger tests** (from Task 3) — verify:
- details UPDATE is called with correct JSONB after successful turn
- Pipeline doesn't crash if details UPDATE fails
- Socket event includes new `model`, `llmLatencyMs`, `tokenUsage`, `retried` fields

**AIStrategyEngine tests** (from Task 3) — verify:
- `BotTurnResult` includes new LLM metadata fields
- Route-executor path populates `model: 'route-executor'`
- LLM path populates actual model name and token counts

## Files Changed

| File | Change |
|------|--------|
| `src/server/services/ai/AIStrategyEngine.ts` | Add model/llmLatencyMs/tokenUsage/retried to BotTurnResult interface and return block |
| `src/server/services/ai/BotTurnTrigger.ts` | Add best-effort UPDATE to bot_turn_audits.details after takeTurn; add new fields to socket emission |
| `src/client/components/DebugOverlay.ts` | Per-bot turn history map, new LLM metadata display, multi-bot section rendering |
| `src/server/__tests__/ai/BotTurnTrigger.test.ts` | Test details persistence, failure isolation, new socket fields |
| `src/server/__tests__/ai/AIStrategyEngine.test.ts` | Test new BotTurnResult fields are populated |
| `src/client/__tests__/DebugOverlay.test.ts` | Test multi-bot sections, turn history, new field rendering |

## No Migration Required

The `details JSONB` column already exists in `bot_turn_audits` (migration 034, line 25). No schema change needed.

## Risks

- **None to critical path**: The UPDATE is best-effort, wrapped in try/catch, runs after execution completes
- **MultiAction turns**: Multiple audit rows per turn all get the same details object (acceptable — the decision metadata applies to the entire turn, not individual sub-actions)
- **Turn number alignment**: BotTurnTrigger increments turn_number before calling takeTurn (line 109). The UPDATE WHERE clause must use `turnNumber + 1` to match the audit rows written by TurnExecutor (which uses `snapshot.turnNumber`)
- **DebugOverlay memory**: Per-bot history capped at 10 entries per bot. With 3 bots that's max 30 entries in memory — negligible
