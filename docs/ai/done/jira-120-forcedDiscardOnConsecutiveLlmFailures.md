# JIRA-120: Heuristic Fallback Fails to Discard Stale Hand After Repeated LLM Failures

## Evidence

**Game:** `48ca7f82` — Flash bot (Gemini Flash)

| Turn | Action | Model | Cash | Segs | Loads | Route | Hand |
|------|--------|-------|------|------|-------|-------|------|
| T12 | PassTurn | route-executor | 17 | 0 | Wine,Beer | active | 0.16 (Poor) |
| T13 | BuildTrack | heuristic-fallback | 13 | 2 | Wine,Beer | NONE | 0.11 (Poor) |
| T14 | MoveTrain | heuristic-fallback | 13 | 0 | Wine,Beer | NONE | 0.11 (Poor) |
| T18 | BuildTrack | heuristic-fallback | 0 | 11 | Wine,Beer | NONE | 0.79 |

**What happened:**
- T12: Route executor declares route unaffordable ($19M track to London > $17M cash). PassTurn.
- T13: Route abandoned. LLM fails (validation_error — produces invalid plan). Heuristic fallback builds 2 segments toward... somewhere. Cash drops to 13M.
- T14: LLM fails again. Heuristic moves train from Frankfurt to Bern (wrong direction from London).
- T15-17: Missing from log (likely crashed or timed out).
- T18: Still carrying Wine+Beer, cash=0. Bot spent all its money building track it didn't need.

**Core problem:** Flash is carrying Wine and Beer for London but can't afford to build there. The LLM recognizes the situation is hopeless (fails to produce a valid plan), but the heuristic fallback ignores the LLM's inability to plan and keeps making "progress" moves that waste money building track in the wrong direction.

## Root Cause Analysis

Three independent conditions prevent the discard that should happen at T13:

### 1. Heuristic fallback's discard conditions are vestigial

The discard paths in `ActionResolver.heuristicFallback()` have narrow triggers that don't match real gameplay:

- **Broke-bot discard** (line ~999): `cash < 5` — Flash has 13M, doesn't trigger. But 13M is effectively broke when the cheapest viable delivery requires $19M of track building. The $5M threshold is arbitrary and too low.
- **Dead-hand discard** (line ~1118): Requires `!hasAchievable` where achievable = `(isSupplyOnNetwork || isLoadOnTrain) && isDeliveryOnNetwork`. Flash has loads on the train (`isLoadOnTrain=true`) but London isn't on the network (`isDeliveryOnNetwork=false`), so `hasAchievable=false`. Then it checks `cheapestCost > cash` — but `estimatedTrackCostToSupply + estimatedTrackCostToDelivery` for loads already on the train has `estimatedTrackCostToSupply=0`, so the cheapest cost appears lower than it actually is.

### 2. GuardrailEnforcer explicitly skips bots with loads

`GuardrailEnforcer.ts:66`: `snapshot.bot.loads.length === 0` — carrying loads **unconditionally blocks** the stuck-detection discard. The assumption "carrying loads = making progress" is wrong. A bot can carry loads it can never afford to deliver.

### 3. Building track resets the no-progress counter

`AIStrategyEngine.ts:882`: `hadNewTrack = result.segmentsBuilt > 0` counts as progress. At T13, the heuristic builds 2 segments (in the wrong direction), resetting `noProgressTurns` to 0. The bot is actively destroying its position but the system sees "progress."

### 4. No tracking of consecutive LLM failures

The system has no memory of how many consecutive turns the LLM failed to produce a valid plan. The `model: 'heuristic-fallback'` field is set in the decision but never persisted to BotMemory. Each turn is evaluated independently — the heuristic doesn't know that the LLM has been failing for 3 turns straight, which is itself a strong signal that the hand is unplayable.

## Proposed Fix

**Principle:** The LLM's inability to plan IS the discard signal. The LLM is prompted to consider discarding (rule 9 in system prompt, POOR hand guidance). When it repeatedly fails to produce ANY valid plan, it's telling us the hand is hopeless — the heuristic shouldn't override that signal by inventing busywork.

### Add `consecutiveLlmFailures` counter to BotMemory

**File:** `src/shared/types/GameTypes.ts` (BotMemoryState)

Add a new field:
```typescript
/** Consecutive turns where LLM failed to produce a valid route plan */
consecutiveLlmFailures: number;
```

### Track LLM failures in AIStrategyEngine

**File:** `src/server/services/ai/AIStrategyEngine.ts`

In the memory patch (line ~887), add:
```typescript
consecutiveLlmFailures: decision.model === 'heuristic-fallback' || decision.model === 'llm-failed'
  ? (memory.consecutiveLlmFailures ?? 0) + 1
  : 0,
```

### Force discard after 3 consecutive LLM failures in heuristic fallback

**File:** `src/server/services/ai/ActionResolver.ts` — `heuristicFallback()`

Add a new check **before** step 2 (move) and step 3 (build), right after step 1c:

```typescript
// 1d. JIRA-120: Force discard after 3+ consecutive LLM route planning failures.
// The LLM's inability to plan is itself a signal that the hand is unplayable.
// The heuristic should not override this by building/moving aimlessly.
if (!context.isInitialBuild && consecutiveLlmFailures >= 3) {
  console.warn(
    `[heuristicFallback] JIRA-120: ${consecutiveLlmFailures} consecutive LLM failures — ` +
    `forcing DiscardHand (hand quality likely too poor for viable routes).`,
  );
  return ActionResolver.resolveDiscard(snapshot);
}
```

This requires threading `consecutiveLlmFailures` from BotMemory into the heuristic fallback call. The simplest path is adding it to `GameContext` (where `noProgressTurns` is not currently passed either) or adding a new parameter to `heuristicFallback()`.

### Passing the counter

**Threading the counter via GameContext** (matches existing pattern):

Add `consecutiveLlmFailures?: number` to `GameContext` in GameTypes.ts. Inject it from BotMemory into the context in `AIStrategyEngine.takeTurn()` before calling `heuristicFallback()`. (ContextBuilder does NOT have access to BotMemory — the injection must happen in AIStrategyEngine.) The heuristic reads `context.consecutiveLlmFailures`.

### Related cleanup to consider

The new LLM failure counter may make some existing discard logic redundant or harmful. Evaluate during implementation:

- **Broke-bot discard** (`cash < 5` in heuristic fallback) — The $5M threshold is arbitrary. A bot with 13M can be just as stuck. The LLM failure counter is a better signal; this path may be removable.
- **Dead-hand discard** (heuristic fallback step 5) — Same story. If the LLM can't plan, that's the signal. The `hasAchievable` / `cheapestCost` heuristic is fragile and misses cases like Flash's.
- **GuardrailEnforcer `loads.length === 0` gate** — This is the condition that directly prevented Flash from discarding. Carrying loads is not a reason to keep a bad hand. Consider removing this condition or replacing it with the LLM failure counter check.
- **No-progress counter resets on track building** — Building track in the wrong direction (as Flash did at T13) resets `noProgressTurns` to 0, masking the stuck state. Orthogonal to the LLM failure counter but worth revisiting.

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/types/GameTypes.ts` | Add `consecutiveLlmFailures: number` to `BotMemoryState` |
| `src/server/services/ai/BotMemory.ts` | Add default `consecutiveLlmFailures: 0` |
| `src/server/services/ai/AIStrategyEngine.ts` | Track counter in memory patch; inject into context before `heuristicFallback()` calls |
| `src/server/services/ai/ActionResolver.ts` | Add JIRA-120 discard check in `heuristicFallback()` |
| `src/server/__tests__/ai/ActionResolver.test.ts` | Test: 3 consecutive failures triggers discard |
| `src/server/__tests__/ai/ActionResolver.test.ts` | Test: counter resets after successful LLM plan |
| `src/server/__tests__/ai/ActionResolver.test.ts` | Test: counter=2 does NOT trigger discard (below threshold) |

## Test Scenarios

1. **3 consecutive LLM failures → discard**: Set `consecutiveLlmFailures=3` in context. Heuristic should return DiscardHand regardless of loads on train or cash level.
2. **Successful LLM plan resets counter**: After a heuristic-fallback turn, if next turn LLM succeeds, counter resets to 0.
3. **Counter=2 does not trigger**: Below threshold, heuristic behaves normally.
4. **Discard during initial build blocked**: Even with 3 failures, `isInitialBuild=true` should skip the discard (initial build has no cards to discard).
5. **Counter increments for both `heuristic-fallback` and `llm-failed` models**: Both represent LLM planning failures.
