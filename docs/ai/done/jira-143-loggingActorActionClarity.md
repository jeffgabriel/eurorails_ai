# JIRA-143: Logging Actor/Action Clarity, LLM Transcript Separation & Turn Counter Fix

## Problem Statement

Three problems with the current logging:

1. The NDJSON game log (`logs/game-{id}.ndjson`) lacks clear differentiation between **who** made a decision (LLM vs system/heuristic) and **what** happened during a turn (the full set of sub-actions).
2. LLM call/response data (prompts, completions, token usage, latency) is **embedded inline** in the game log, bloating it and making it hard to analyze LLM behavior separately from game behavior.
3. The turn counter is off-by-one — every game starts at Turn 2.

---

## Bug: Turn Counter Off-By-One

### Observed Behavior

Every game's NDJSON log starts at Turn 2. Initial build phase logs as T2/T3 instead of T1/T2.

```
Turn   2 | gamePhase=Initial Build | action=PassTurn
Turn   3 | gamePhase=Initial Build | action=PassTurn
Turn   4 | gamePhase=Early Game    | action=BuildTrack
```

### Root Cause

In `BotTurnTrigger.ts:108-121`, the turn number is **incremented before the turn executes**, then the log adds +1 again:

1. **Line 114**: Read `current_turn_number` from DB → gets `1` (or NULL → `|| 0` → `0`)
2. **Line 119**: Increment in DB: `COALESCE(current_turn_number, 1) + 1` — first turn goes NULL → 2, or 1 → 2
3. **Line 207**: Log writes `turnNumber + 1`

The `COALESCE(current_turn_number, 1)` treats the initial state as 1 rather than 0, so the first increment produces 2 in the DB. Combined with the `+ 1` in the log line, the first turn is logged as Turn 2.

### Fix

Two options (pick one):

**Option A (preferred):** Change the COALESCE default to 0 and remove the `+ 1` from the log line:
- `BotTurnTrigger.ts:119`: `COALESCE(current_turn_number, 0) + 1` — first turn → DB stores 1
- `BotTurnTrigger.ts:207`: `turn: turnNumber + 1` stays (reads 0 pre-increment, logs as 1)

**Option B:** Read the turn number *after* incrementing, and log it directly without `+ 1`:
- Move the SELECT after the UPDATE, or use `UPDATE ... RETURNING current_turn_number`
- `BotTurnTrigger.ts:207`: `turn: turnNumber` (no +1)

Either way, ensure the `bot:turn-start` socket event (line 115) also emits the corrected value.

### Files to Change
- `src/server/services/ai/BotTurnTrigger.ts` (lines 108-121, 207)

---

## Gap Analysis: Actor & Action Differentiation

### Current Logging Architecture

Two independent logging systems:

| System | File | Output | Scope |
|---|---|---|---|
| **GameLogger** (NDJSON) | `GameLogger.ts` | `logs/game-{id}.ndjson` | One JSON line per bot turn — final result |
| **DecisionLogger** | `DecisionLogger.ts` | Console JSON | Per-phase option scoring — what was considered |

### How "Actor" Is Currently Encoded

The `model` field on `BotTurnResult` is **overloaded** to serve as both the LLM model identifier AND the decision pathway label:

| `model` value | Actual actor | What it means |
|---|---|---|
| `initial-build-planner` | System | Computed initial build plan |
| `route-executor` | System | PlanExecutor following an existing route |
| `trip-planner` | **LLM** | Trip planning via LLM call |
| `broke-bot-heuristic` | System | Auto-discard when broke |
| `heuristic-fallback` | System | Fallback after LLM failure |
| `llm-failed` | System | Pass turn after total LLM failure |
| `no-api-key` | System | Pass turn, no API key |
| `pipeline-error` | System/error | Catch-all error handler |
| *(actual model name)* | **LLM** | From `LLMStrategyBrain` calls |

### How "Action" Is Currently Encoded

The `action` field uses `AIActionType` enum: `PassTurn`, `BuildTrack`, `MoveTrain`, `PickupLoad`, `DeliverLoad`, `DropLoad`, `UpgradeTrain`, `DiscardHand`.

This only captures the **primary** action — a turn with move + pickup + build logs only the "most important" one.

---

## Identified Gaps

### Gap 1: No explicit `actor` field

The `model` field mixes two concerns: LLM model name (e.g., `claude-haiku-4-5-20251001`) and decision pathway label (e.g., `route-executor`). When LLM is the actor, `model` holds the real model name. When a heuristic acts, `model` holds a pseudo-label. There's no clean way to query "all LLM-decided turns" vs "all system-decided turns."

### Gap 2: No per-sub-action actor tracking

A single turn can involve multiple actors:
- LLM plans the route (trip-planner)
- TurnComposer adds opportunistic pickups (system/A1 phase)
- Build Advisor decides build waypoints (LLM or heuristic fallback)
- GuardrailEnforcer overrides the action (system)

The log records only one `model` value for the whole turn.

### Gap 3: `action` only captures the primary action

Turn 14 example: `action=MoveTrain`, but the bot also built track (`advisor=build`). The composition trace has the details, but the top-level `action` is misleading for analysis queries like "how many turns included building?"

### Gap 4: Build Advisor actor type not surfaced

`advisorAction` exists (values: `build`, `replan`, `n/a`), but doesn't record whether the advisor used **LLM** or fell back to **heuristic**. The `advisor.fallback` boolean exists in the composition trace but isn't promoted to NDJSON top-level.

### Gap 5: Guardrail overrides lose the original plan

`guardrailOverride=true` + `guardrailReason` records that the guardrail fired, but the original LLM plan that was overridden is discarded. Can't compare "what LLM wanted" vs "what actually happened."

### Gap 6: `actionTimeline` never written to NDJSON

The `actionTimeline` field (per-step action breakdown for animation) is built in `AIStrategyEngine.buildActionTimeline()` and emitted via socket to the client, but is **not included** in the `appendTurn()` call. It's missing from the NDJSON schema entirely.

### Gap 7: DecisionLogger and GameLogger are disconnected

DecisionLogger captures phase-by-phase option scoring (what was considered, which was chosen). GameLogger captures the final result. Neither cross-references the other — analyzing "why did the bot choose X over Y" requires correlating two separate log streams by turn number.

### Gap 8: No `actionBreakdown` for multi-action turns

The `composition.outputPlan` has step type names but no detail or actor attribution. There's no array like:
```json
[
  {"action": "MoveTrain", "actor": "route-executor"},
  {"action": "PickupLoad", "actor": "a1-opportunistic"},
  {"action": "BuildTrack", "actor": "build-advisor-llm"}
]
```

### Gap 9: LLM calls and responses are inlined in the game log

LLM data is scattered across multiple fields in the game NDJSON: `systemPrompt`, `userPrompt`, `llmLog` (attempts/responses/errors), `tokenUsage`, `llmLatencyMs`, `advisorSystemPrompt`, `advisorUserPrompt`, `advisorReasoning`, `advisorLatencyMs`, and `tripPlanning` (which embeds `llmLatencyMs`, `llmTokens`, `llmReasoning`).

This causes several problems:
- **Bloated game log**: Full prompt text (often thousands of tokens) inflates game log entries, making them harder to scan for game-state analysis.
- **Can't analyze LLM behavior independently**: Querying "what did the LLM say across all turns?" requires parsing the full game log and extracting from multiple inconsistent field locations.
- **Multiple LLM calls per turn are flattened**: A single turn can invoke the LLM up to 4 times (TripPlanner, LLMStrategyBrain route planning, BuildAdvisor, cargo/upgrade evaluation). These are collapsed into a single `llmLog` array or spread across `advisor*` fields with no unified structure.
- **No caller identification**: The `llmLog` entries don't record which component made the call (was it the TripPlanner? BuildAdvisor? StrategyBrain?).

**Current LLM call sites** (all go through `ProviderAdapter.chat()`):

| Component | Method(s) | Calls per turn |
|---|---|---|
| `LLMStrategyBrain` | `planRoute()`, `evaluateUpgradeBeforeDrop()`, `evaluateCargoConflict()`, `evaluateUpgrade()` | 1-2 |
| `TripPlanner` | `planTrip()` | 0-1 |
| `BuildAdvisor` | `adviseBuild()`, `adviseBuildInitial()`, `adviseBuildVictory()` | 0-1 |

Up to 4 LLM calls per turn, but the game log has no clean way to see them all.

---

## Implementation Plan

### Phase 1: Fix turn counter off-by-one

**Files:** `BotTurnTrigger.ts`

- Change `COALESCE(current_turn_number, 1) + 1` → `COALESCE(current_turn_number, 0) + 1`
- Verify `turnNumber + 1` in the log line produces Turn 1 for the first turn
- Ensure `bot:turn-start` socket event also emits the corrected value

### Phase 2: Separate LLM transcript log

**New file:** `src/server/services/ai/LLMTranscriptLogger.ts`
**Output:** `logs/llm-{gameId}.ndjson`

Extract all LLM call/response data into a dedicated NDJSON file, one line per LLM invocation. The game log keeps a lightweight reference (`llmCallIds`) instead of embedding full prompt text.

#### LLM Transcript Entry Schema

```typescript
export interface LLMTranscriptEntry {
  /** Unique ID for this LLM call, referenced from game log */
  callId: string;
  /** Correlation fields — join back to game log */
  gameId: string;
  playerId: string;
  turn: number;
  timestamp: string;

  /** Which component made the call */
  caller: 'trip-planner' | 'strategy-brain' | 'build-advisor' | 'cargo-conflict' | 'upgrade-eval';
  /** Method name within the caller */
  method: string;

  /** Request */
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;

  /** Response */
  responseText: string;
  status: 'success' | 'error' | 'timeout' | 'validation_error';
  error?: string;

  /** Metrics */
  latencyMs: number;
  tokenUsage?: { input: number; output: number };
  attemptNumber: number;
  totalAttempts: number;
}
```

#### Interception point: `ProviderAdapter.chat()`

All LLM calls go through `ProviderAdapter.chat()`. Two implementation options:

**Option A — Wrapper/decorator at call sites:** Each caller (`LLMStrategyBrain`, `TripPlanner`, `BuildAdvisor`) wraps its `adapter.chat()` call to log before/after. Pros: callers can tag with `caller` and `method`. Cons: repeated boilerplate at ~8 call sites.

**Option B (preferred) — Logging adapter wrapper:** Create a `LoggingProviderAdapter` that wraps any `ProviderAdapter`, intercepts `chat()`, logs the entry, and delegates. The wrapper receives context (gameId, playerId, turn, caller) via a `setContext()` call at the start of each turn.

```typescript
class LoggingProviderAdapter implements ProviderAdapter {
  constructor(private inner: ProviderAdapter) {}

  setContext(ctx: { gameId: string; playerId: string; turn: number; caller: string }) { ... }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const start = Date.now();
    try {
      const response = await this.inner.chat(request);
      appendLLMCall(this.context.gameId, { ...entry, status: 'success', responseText: response.text });
      return response;
    } catch (err) {
      appendLLMCall(this.context.gameId, { ...entry, status: 'error', error: err.message });
      throw err;
    }
  }
}
```

Each caller sets `caller` before making its call:
- `TripPlanner.planTrip()` → `adapter.setContext({ caller: 'trip-planner', method: 'planTrip' })`
- `BuildAdvisor.adviseBuild()` → `adapter.setContext({ caller: 'build-advisor', method: 'adviseBuild' })`
- `LLMStrategyBrain.planRoute()` → `adapter.setContext({ caller: 'strategy-brain', method: 'planRoute' })`
- etc.

#### Game log changes — replace inline LLM data with references

Remove from `GameTurnLogEntry`:
- `systemPrompt`, `userPrompt` (full prompt text)
- `llmLog` (attempt details with response text)
- `advisorSystemPrompt`, `advisorUserPrompt`

Replace with:
```typescript
/** IDs of LLM calls made this turn — join to llm-{gameId}.ndjson */
llmCallIds?: string[];
/** Summary only: total LLM calls, total latency, total tokens */
llmSummary?: {
  callCount: number;
  totalLatencyMs: number;
  totalTokens: { input: number; output: number };
  callers: string[];  // e.g., ['trip-planner', 'build-advisor']
};
```

Keep lightweight fields that are useful for game analysis without needing the transcript:
- `model` (or new `llmModel`) — which model was primary decision maker
- `reasoning` — the final chosen reasoning (short string)
- `llmLatencyMs` — total latency for the turn
- `advisorAction`, `advisorReasoning` — short strings

#### Socket event (`bot:turn-complete`) — no change

The client-side `LLMTranscriptOverlay` still receives full prompts/responses via the socket event for real-time display. The separation is purely for the file-based logs.

### Phase 3: Add explicit actor metadata to NDJSON

**Files:** `GameLogger.ts` (schema), `AIStrategyEngine.ts` (populate), `BotTurnTrigger.ts` (pass-through)

Add three new top-level fields to `GameTurnLogEntry`:

```typescript
actor: 'llm' | 'system' | 'heuristic' | 'guardrail' | 'error';
actorDetail: string;    // e.g., 'trip-planner', 'route-executor'
llmModel?: string;      // actual model ID, only when actor='llm'
```

Populate from existing `model` field logic in `AIStrategyEngine`. Keep `model` for backwards compat.

### Phase 4: Add per-step `actionBreakdown` array

**Files:** `GameLogger.ts` (schema), `AIStrategyEngine.ts` (build from composed steps + trace)

```typescript
actionBreakdown: Array<{
  action: AIActionType;
  actor: 'llm' | 'system' | 'heuristic';
  detail?: string;  // e.g., "a1-opportunistic-pickup", "build-advisor-llm"
}>;
```

Derived from the composed plan steps + `CompositionTrace`. Each step in `allSteps` gets an actor tag based on how it was produced (A1 opportunistic, A2 continuation, primary plan, build phase, etc.).

### Phase 5: Capture pre-guardrail plan

**Files:** `GameLogger.ts` (schema), `AIStrategyEngine.ts` (populate)

When `guardrailOverride=true`, also log:
```typescript
originalPlan?: { action: string; reasoning: string };
```

### Phase 6: Surface Build Advisor actor type

**Files:** `GameLogger.ts` (schema), `BotTurnTrigger.ts` (pass-through)

Promote `advisor.fallback` from composition trace to top-level:
```typescript
advisorUsedFallback?: boolean;
```

### Phase 7: Include `actionTimeline` in NDJSON

**Files:** `BotTurnTrigger.ts`

The timeline is already built in `AIStrategyEngine.buildActionTimeline()` and returned in the result. Just need to add it to the `appendTurn()` call and the `GameTurnLogEntry` interface.

### Phase 8 (optional): Merge DecisionLogger into NDJSON

**Files:** `GameLogger.ts`, `DecisionLogger.ts`, `AIStrategyEngine.ts`

Fold per-phase option scoring into NDJSON as:
```typescript
decisionPhases?: PhaseDecisionLog[];
```

This eliminates the need to correlate two separate log streams. DecisionLogger console output could remain for real-time debugging.

---

## Target Log Architecture (After)

```
logs/
  game-{gameId}.ndjson        # Game state log — one line per bot turn
                               # Actions, positions, composition, actor tags
                               # Lightweight: no full prompts or LLM responses
                               # Contains llmCallIds for joining to transcript

  llm-{gameId}.ndjson          # LLM transcript log — one line per LLM call
                               # Full prompts, responses, errors, retries
                               # Tagged with caller component and method
                               # Multiple entries per turn when multiple calls made
```

**Joining:** `game` log entry has `llmCallIds: ["abc", "def"]` → grep `llm` log for those IDs.
**Independent analysis:** Can analyze LLM cost/latency/error rates from `llm-*.ndjson` alone without parsing game state.

---

## Files Impacted

| File | Changes |
|---|---|
| `src/server/services/ai/BotTurnTrigger.ts` | Turn counter fix, pass new fields to appendTurn, remove inline LLM prompts from appendTurn |
| `src/server/services/ai/GameLogger.ts` | Schema: add actor/actorDetail/llmModel/actionBreakdown/originalPlan/advisorUsedFallback/actionTimeline/llmCallIds/llmSummary. Remove systemPrompt/userPrompt/llmLog/advisorSystemPrompt/advisorUserPrompt |
| `src/server/services/ai/LLMTranscriptLogger.ts` | **New file** — `appendLLMCall()`, `LLMTranscriptEntry` interface |
| `src/server/services/ai/LoggingProviderAdapter.ts` | **New file** — wraps `ProviderAdapter` to intercept and log all LLM calls |
| `src/server/services/ai/AIStrategyEngine.ts` | Populate actor/actorDetail/llmModel, build actionBreakdown, capture pre-guardrail plan, collect llmCallIds |
| `src/server/services/ai/LLMStrategyBrain.ts` | Set caller context before adapter.chat() calls |
| `src/server/services/ai/TripPlanner.ts` | Set caller context before adapter.chat() call |
| `src/server/services/ai/BuildAdvisor.ts` | Set caller context before adapter.chat() calls |
| `src/server/services/ai/DecisionLogger.ts` | Phase 8 only: optional merge into NDJSON |

## Expected Output After Changes

### Game log entry (`game-{gameId}.ndjson`)

```json
{
  "turn": 1,
  "playerId": "abc-123",
  "playerName": "Haiku",
  "timestamp": "2026-03-24T12:27:11.904Z",
  "actor": "llm",
  "actorDetail": "trip-planner",
  "llmModel": "claude-haiku-4-5-20251001",
  "action": "BuildTrack",
  "actionBreakdown": [
    {"action": "MoveTrain", "actor": "system", "detail": "route-executor"},
    {"action": "PickupLoad", "actor": "system", "detail": "a1-opportunistic"},
    {"action": "BuildTrack", "actor": "llm", "detail": "build-advisor"}
  ],
  "llmCallIds": ["call-001", "call-002"],
  "llmSummary": {
    "callCount": 2,
    "totalLatencyMs": 1450,
    "totalTokens": {"input": 3200, "output": 480},
    "callers": ["trip-planner", "build-advisor"]
  },
  "reasoning": "Building toward Torino for Cars pickup",
  "advisorAction": "build",
  "advisorUsedFallback": false,
  "gamePhase": "Early Game",
  "..."
}
```

### LLM transcript entry (`llm-{gameId}.ndjson`)

```json
{
  "callId": "call-001",
  "gameId": "game-123",
  "playerId": "abc-123",
  "turn": 1,
  "timestamp": "2026-03-24T12:27:11.500Z",
  "caller": "trip-planner",
  "method": "planTrip",
  "model": "claude-haiku-4-5-20251001",
  "systemPrompt": "You are a freight rail strategy advisor...",
  "userPrompt": "Plan a delivery route for the following demands...",
  "responseText": "{\"route\": [...], \"reasoning\": \"...\"}",
  "status": "success",
  "latencyMs": 1200,
  "tokenUsage": {"input": 2800, "output": 350},
  "attemptNumber": 1,
  "totalAttempts": 1
}
```
