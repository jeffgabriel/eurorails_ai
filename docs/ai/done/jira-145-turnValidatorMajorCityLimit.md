# JIRA-145: Initial Build Self-Referential Target + Diagnostic Logging

## Problem

When the first route stop is a pickup at the starting city (e.g., start Ruhr, pickup Steel at Ruhr, deliver to Warszawa), two code paths target "Ruhr" for building:

1. `AIStrategyEngine:268` — `targetCity = buildPlan.route[0]?.city` → "Ruhr"
2. `BuildAdvisor.getTargetCoord:329` — `activeRoute.stops[currentStopIndex].city` → "Ruhr"

BuildAdvisor renders a Ruhr→Ruhr corridor map. The LLM produces waypoints that zigzag through Ruhr mileposts. TurnValidator correctly rejects (>2 sections from a major city per turn — preserves connection openings for other players). Recomposition strips BuildTrack → PassTurn. Both initial build turns wasted.

**Evidence** (game `3e9f8bd2`):
```
Turn 2: firstViolation="Cannot build more than 2 track sections from major city Ruhr (attempted 4)"
Turn 3: firstViolation="Cannot build more than 2 track sections from major city Ruhr (attempted 5)"
```

**Confirmed**: `computeBuildSegments` from Ruhr toward Warszawa (correct target) produces 15 segments, only 1 from Ruhr, passes all gates.

**Prior art**: `PlanExecutor.findInitialBuildTarget` (`bf5bd1e`) already has skip-starting-city logic. `BuildAdvisor.getTargetCoord` does not.

## Fix 1: AIStrategyEngine — target delivery city, not pickup city

`src/server/services/ai/AIStrategyEngine.ts:268`

```typescript
// Before:
const targetCity = buildPlan.route[0]?.city ?? buildPlan.startingCity;

// After: skip stops at starting city
const targetCity = buildPlan.route.find(
  s => s.city.toLowerCase() !== buildPlan.startingCity.toLowerCase()
)?.city ?? buildPlan.route[0]?.city ?? buildPlan.startingCity;
```

## Fix 2: BuildAdvisor.getTargetCoord — skip starting city / on-network stops

`src/server/services/ai/BuildAdvisor.ts:321-340`

Mirror `PlanExecutor.findInitialBuildTarget` logic: iterate route stops, skip any that are the starting city or already on-network, return the first unreached stop. Fall back to current stop if all are reachable.

## Fix 3: Preserve advisor trace across recomposition

`src/server/services/ai/AIStrategyEngine.ts:~598`

When TurnValidator rejects and recomposes, `compositionTrace` is overwritten — losing advisor action, waypoints, and reasoning. Save `firstCompositionTrace` before the recompose loop and use it for NDJSON advisor fields when `recomposeCount > 0`. The `firstViolation` field is already implemented.

## Files

| File | Change |
|------|--------|
| `AIStrategyEngine.ts:268` | Skip starting city in initial build target selection |
| `BuildAdvisor.ts:321-340` | Skip starting city / on-network in `getTargetCoord` |
| `AIStrategyEngine.ts:~598,~1222` | Preserve first composition trace for advisor logging |
