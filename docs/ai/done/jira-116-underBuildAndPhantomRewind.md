# JIRA-116: End-of-Turn Under-Building + Phantom Position Rewind After Early Execution

## Symptom

Game `00df7daa`, Flash bot, turns 9–11. Two related issues compound into a multi-turn setback:

1. **T9 under-building**: Flash moves to Berlin, builds only 2 segments (4M) toward Szczecin despite having 19M cash and a 20M build budget. The next route leg (Szczecin → Kaliningrad) needs ~14M of track, but the build phase stops after reaching the immediate next stop. 15M of build budget is left unspent.

2. **T10 phantom rewind**: Flash's train appears to teleport from Berlin (25,52) back to Szczecin (21,53). The logged `movementPath` starts at Szczecin, not Berlin. The turn then fails with `"Train at full capacity (2/2)"`. On T11, Flash starts at Szczecin and wastes 7/9 movement reaching Berlin area before spending 14M building the track it should have built on T9.

A human would have built 15M+ of track toward Kaliningrad on T9, enabling full movement on T10.

## Timeline

| Turn | Start | End | Action | Cash | Build Spent | Notes |
|------|-------|-----|--------|------|-------------|-------|
| 9 | (28,48) | Berlin (25,52) | Move 8mp + Build 2 seg | 19M | 4M | Built toward Szczecin only. 15M unspent. 1mp wasted |
| 10 | Berlin (25,52) | Szczecin (21,53) | Early-exec: Move+Deliver+Pickup → FAIL | — | — | movementPath starts at Szczecin. Fails on capacity check. Position commits to Szczecin |
| 11 | Szczecin (21,53) | (23,52) | Move 2mp + Build 14M | — | 14M | Only 2mp used of 9 budget. Builds track that should have been built on T9 |

Net impact: ~1.5 turns wasted (7mp wasted on T11 + cascading delay).

## Root Cause — Bug A: Under-Building

`TurnComposer.tryAppendBuild()` (TurnComposer.ts:718-773) selects the **first unreached city** from the active route's remaining stops as the build target. On T9:

1. Route stops: Leipzig (done) → Szczecin (next) → Kaliningrad (after)
2. Build target = Szczecin (2 segments, 4M)
3. `computeBuildSegments()` builds to Szczecin and stops
4. **No look-ahead**: the build phase never considers that Kaliningrad (the stop after Szczecin) still needs ~14M of track

The build logic asks "can I reach the next city?" but never asks "will I have enough track for next turn's full movement budget?" There is no forward-looking movement analysis.

**Key code path:**
- `tryAppendBuild()` line 728-758: iterates `activeRoute.stops` from `currentStopIndex`, finds first unreached city, builds toward it, done
- `computeBuildSegments.ts:188`: Dijkstra builds cheapest path toward target within budget — no concept of movement runway

## Root Cause — Bug B: Phantom Position Rewind

The JIRA-91 early execution mechanism in `AIStrategyEngine.ts` causes the visual rewind:

1. **Primary plan** (line 521): TurnComposer generates [MOVE Berlin→Szczecin, DELIVER Beer, PICKUP Potatoes, MOVE continuation, BUILD]
2. **Early execution** (lines 590-601): Steps up through last delivery are executed against DB: `[MOVE Berlin→Szczecin, DELIVER Beer, PICKUP Potatoes]`. Bot position commits to Szczecin in DB.
3. **PICKUP fails**: `"Train at full capacity (2/2)"` — the capacity check doesn't account for the Beer delivery freeing a slot (ordering/state bug in early execution)
4. **Re-eval recomposition** (lines 604-755): Fresh snapshot captured from DB shows position = Szczecin. New plan is composed starting from Szczecin.
5. **JIRA-91 stripping** (lines 798-807): `remainingSteps = planSteps.slice(earlyExecutedSteps.length)` removes the already-executed Berlin→Szczecin segment from the plan.
6. **movementPath extraction** (lines 1078-1091): Only sees post-stripping steps. Path starts at Szczecin, not Berlin. The Berlin→Szczecin leg is lost from the logged output.

From the user's perspective: the train was at Berlin, then the log shows movement starting from Szczecin — a phantom teleport backward. The actual game state transitions are correct (the bot did travel Berlin→Szczecin via early execution), but the logged movementPath is incomplete.

**Compounding factor**: The capacity failure means the turn rolls back partially, but the early-executed MOVE to Szczecin is already committed. The bot ends at Szczecin with the failed turn, losing the continuation movement.

## Impact

- **Under-building** wastes 15M of build budget on T9, directly causing 7/9 wasted movement on T11
- **Phantom rewind** makes game replay/debugging misleading — position appears to jump backward
- **Capacity ordering bug** causes a valid turn to fail (Beer delivery should free capacity for Potatoes pickup)
- Combined: ~1.5 turns of wasted progress, delayed Kaliningrad delivery

## Proposed Fix

### Bug A: Look-ahead building

After building toward the immediate next stop, `tryAppendBuild` should continue building toward subsequent route stops with remaining budget:

```typescript
// TurnComposer.ts tryAppendBuild() — after building to immediate stop
let remainingBudget = Math.min(20 - context.turnBuildCost, snapshot.bot.money) - segmentsCost;
if (remainingBudget > 0 && activeRoute) {
  // Continue building toward next stops beyond the one just reached
  for (let i = targetStopIdx + 1; i < activeRoute.stops.length; i++) {
    const nextStop = activeRoute.stops[i];
    const additionalSegments = computeBuildSegments(
      /* from: */ lastBuiltMilepost,
      /* toward: */ nextStop.city,
      /* budget: */ remainingBudget,
      ...
    );
    if (additionalSegments.length > 0) {
      segments.push(...additionalSegments);
      remainingBudget -= additionalSegments.cost;
    }
    if (remainingBudget <= 0) break;
  }
}
```

### Bug B: Include early-executed segments in movementPath

When extracting `movementPath` at lines 1078-1091, prepend the path segments from early-executed MOVE steps:

```typescript
// AIStrategyEngine.ts — movementPath extraction
const earlyMovePaths = earlyExecutedSteps
  .filter(s => s.action === 'MOVE' && s.details?.path)
  .flatMap(s => s.details.path);
const remainingMovePaths = /* existing extraction from finalPlan.steps */;
const movementPath = [...earlyMovePaths, ...remainingMovePaths];
```

### Bug B (secondary): Capacity check ordering

Investigate why the PICKUP after DELIVER fails with "full capacity" — the delivery should have freed a cargo slot before the pickup capacity check runs.

## Files

- `src/server/services/ai/TurnComposer.ts` — `tryAppendBuild()` lines 718-773 (Bug A)
- `src/server/services/ai/computeBuildSegments.ts` — line 188, Dijkstra build logic (Bug A)
- `src/server/services/ai/AIStrategyEngine.ts` — lines 590-601 early execution, 798-807 stripping, 1078-1091 movementPath (Bug B)
- `src/server/services/ai/TurnExecutor.ts` — `executeMultiAction()` lines 253-256, capacity check ordering (Bug B secondary)
- Log: `logs/game-00df7daa-9a4f-4fc7-84c5-8731d29e73f4.ndjson`
