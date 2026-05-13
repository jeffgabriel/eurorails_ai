# JIRA-141: Trip Planner Affordability Gate

## Problem

Bots commit to unaffordable routes, drain all cash building toward unreachable destinations, and go broke. In game `01fcd29d`, Nano chose Machinery Barcelona → Madrid with 30M cash. The trip planner's own reasoning said "all demands are unaffordable" but picked one anyway. The bot spent all 50M on partial track toward Barcelona/Spain and went broke by turn 6, never picking up the load.

## Root Cause Analysis

### What should have caught this

1. **RouteValidator.checkCumulativeBudget()** (`RouteValidator.ts:265-315`) — Checks if `estimatedTrackCost > runningCash` per stop. This DID run but the route passed, meaning `estimatedTrackCostToSupply` for Barcelona was ≤ 30M. The cost estimate was wrong — building from an empty network to Barcelona through mountains/alpine terrain costs far more than estimated.

2. **ContextBuilder.estimateTrackCost()** — Produces the `estimatedTrackCostToSupply` values used by RouteValidator. During cold start (no track), it uses `estimateColdStartRouteCost()` which picks an optimal starting major city and estimates costs from there. The estimate may undercount because:
   - It uses a terrain multiplier that doesn't account for actual path geography
   - It doesn't know what track the bot will actually build (the build advisor may route differently)
   - Alpine terrain (5M/segment) and mountain (2M/segment) can make short distances very expensive

3. **Trip planner prompt** — Previously told the LLM to check budget, but we trimmed that in the prompt rework (code should enforce this, not the LLM).

### What didn't exist

There is no **post-selection rejection** in TripPlanner. After `scoreCandidates()` returns sorted candidates, the best one is used even if its `netValue` is negative or `buildCostEstimate` exceeds cash. The scoring penalizes expensive routes via `score = netValue / estimatedTurns`, but if ALL candidates are bad, the "best" bad one still gets selected.

## Proposed Fix

### 1. TripPlanner: Reject candidates where buildCostEstimate > cash

In `TripPlanner.scoreCandidates()` (or after it returns), filter out candidates where `buildCostEstimate > snapshot.bot.money`. If no candidates survive, return null/empty — the caller (AIStrategyEngine) should then trigger DISCARD_HAND via the existing broke-bot/stuck-detection heuristic.

**Location:** `src/server/services/ai/TripPlanner.ts:309-320` (after candidates are scored, before returning)

```typescript
// Reject candidates that cost more than available cash
const affordableCandidates = validCandidates.filter(c => c.buildCostEstimate <= snapshot.bot.money);
if (affordableCandidates.length === 0) {
  console.warn('[TripPlanner] All candidates exceed available cash — no viable trip');
  return [];
}
return affordableCandidates.sort((a, b) => b.score - a.score);
```

### 2. TripPlanner.planTrip(): Handle empty candidates

When `scoreCandidates()` returns empty (all unaffordable), `planTrip()` should return null so the caller falls through to heuristic (which triggers DISCARD_HAND via broke-bot gate).

**Location:** `src/server/services/ai/TripPlanner.ts` — in `planTrip()` after `scoreCandidates()` call

### 3. Consider: Add margin to affordability check

Instead of `buildCostEstimate <= money`, use `buildCostEstimate <= money * 0.8` (leave 20% margin) since cost estimates are known to undercount. This prevents marginal routes that drain all cash even when the estimate is "technically" affordable.

## Files to Modify

- `src/server/services/ai/TripPlanner.ts` — Add affordability filter in `scoreCandidates()`, handle empty result in `planTrip()`
- `src/server/__tests__/ai/TripPlanner.test.ts` — Test that unaffordable candidates are filtered

## Complexity Estimate

**Trivial** — 1 file modified, 1 filter added, 1 test. The RouteValidator already does per-stop budget checking; this adds a total-route budget gate at the candidate selection level.

## Related

- JIRA-127: Build Cost Estimator Accuracy — improved cost estimates but they still undercount for long peripheral routes
- The underlying issue of bad cost estimates is a separate concern (the estimator uses heuristic distances, not actual pathfinding costs)
