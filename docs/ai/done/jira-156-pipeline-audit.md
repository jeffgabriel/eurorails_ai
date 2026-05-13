# JIRA-156: Turn Composition & Plan Execution Pipeline — Holistic Audit

## Executive Summary

The bot turn pipeline spans ~10,400 lines across 8 files. It was built incrementally over ~50 JIRAs, each solving a specific bug or adding a feature. The result is a system where **the same conceptual question is answered in multiple places with different logic**, and **state mutations happen at unpredictable points in the pipeline**. New bugs emerge because fixing behavior in one location doesn't account for the same logic running elsewhere.

## Pipeline Architecture (As-Is)

```
AIStrategyEngine.takeTurn()  [1685 lines — orchestrator]
  ├── InitialBuildPlanner     (initial build phase only)
  ├── PlanExecutor.execute()  [874 lines — route stop execution]
  │     ├── skipCompletedStops()   ← advances route index
  │     ├── reorderStopsByProximity()  ← rewrites route order
  │     ├── revalidateRemainingDeliveries()  ← removes stops
  │     ├── resolveMove/resolvePickup/resolveDeliver  ← generates plans
  │     ├── continuationBuild()  ← builds after delivery/pickup
  │     └── findDemandBuildTarget()  ← picks build target
  ├── TurnComposer.compose()  [1884 lines — plan enhancement]
  │     ├── A0: Primary action execution
  │     ├── A1: splitMoveForOpportunities()  ← pickups/deliveries en route
  │     ├── A2: Continuation chaining  ← uses findMoveTargets()
  │     ├── A3: Move prepend before build  ← uses findMoveTargets() + filterByDirection()
  │     └── tryAppendBuild()  ← BuildAdvisor + JIT gate + shouldDeferBuild
  ├── GuardrailEnforcer.checkPlan()
  ├── TurnValidator.validate()
  └── Post-delivery re-eval  [AIStrategyEngine lines 717-887]
        └── TripPlanner.planTrip()  ← full route replacement
```

## Critical Findings

### 1. "Is this stop done?" — FOUR different answers

The same question ("has this route stop been completed?") is answered with different logic in four places:

| Location | File:Line | Logic | Bug Risk |
|----------|-----------|-------|----------|
| `skipCompletedStops` | PlanExecutor:826 | `loads >= sameTypePickups` (count-aware) | Most sophisticated |
| `findMoveTargets` | TurnComposer:1553 | `context.loads.includes(loadType)` (boolean) | Ignores multi-pickup of same type |
| `reorderStopsByProximity` | RouteValidator:388 | `pickupDone.has(loadType)` from carriedLoads | Different set semantics |
| `revalidateRemainingDeliveries` | PlanExecutor:720 | `!loadOnTrain && !demandPresent && cardConsumed` | Only for deliveries |

**Impact:** A stop can be "done" in one check but "not done" in another. `skipCompletedStops` uses count-aware logic (JIRA-104), but `findMoveTargets` uses simple `includes` — so if the bot carries 2 Coal and has 2 Coal pickups, `findMoveTargets` would skip BOTH pickups after picking up just 1.

### 2. Build target — FIVE separate determinations

"Where should the bot build toward?" is computed independently in:

1. **TurnComposer.tryAppendBuild** (line 854) — scans `unreachedRouteStops`, filters for victory, passes to BuildAdvisor
2. **TurnComposer.findMoveTargets** (line 1590) — frontier approach for off-network targets (A3 move prepend)
3. **TurnComposer.shouldDeferBuild** (line 1379) — re-derives `buildTarget` from route stops
4. **PlanExecutor.findDemandBuildTarget** (line 477) — demand-scored build target when no route
5. **PlanExecutor.continuationBuild** (line 554) — simulates post-build state to find next target

Each uses slightly different iteration over route stops, different filtering criteria, and different distance calculations. When they disagree, the bot's move (A3) goes in one direction while its build goes in another — **exactly what happened in JIRA-156 Bug B**.

### 3. Network frontier — THREE implementations

"Where is the edge of the bot's track network?" is computed independently:

| Location | Method | Logic |
|----------|--------|-------|
| TurnComposer:1628 | `findMoveTargets` | Degree-1 nodes from segments, **requires city name** |
| TurnComposer:1720 | `isBotAtBuildFrontier` | Track endpoints closest to build target |
| BuildAdvisor:370 | `getNetworkFrontier` | Dead-end endpoints OR bot position OR nearest major city |

The `findMoveTargets` frontier requires named cities (skips unnamed mileposts). `getNetworkFrontier` doesn't. `isBotAtBuildFrontier` uses yet another approach. These can give different answers for the same network state.

### 4. Route mutation at unpredictable pipeline stages

The active route is mutated at these points, in this order within a single turn:

```
1. PlanExecutor.skipCompletedStops()    — advances index
2. PlanExecutor reorderStopsByProximity — rewrites stop order
3. PlanExecutor.revalidateRemaining     — removes invalid stops
4. PlanExecutor.advanceStop()           — advances index (after action)
5. TurnComposer.splitMoveForOpportunities — advances index (A1)
6. TurnComposer A2 continuation         — may advance index
7. AIStrategyEngine post-delivery        — REPLACES entire route
```

Steps 1-3 run in PlanExecutor at turn start. Steps 5-6 run in TurnComposer during composition. Step 7 runs in AIStrategyEngine after execution. **The route object is passed by reference in some cases and cloned in others.** There's no single "route state machine" — mutations happen wherever code touches the route.

### 5. `findMoveTargets` serves two masters

`findMoveTargets()` (TurnComposer:1535) is called by both A2 (continuation after move) and A3 (prepend move before build). These have different needs:

- **A2 (line 393):** After a move+action, find the next useful destination. Wants the next route stop or nearest demand city.
- **A3 (line 475):** Before a build, find where to position the bot. Wants the frontier node closest to the build target.

The same function tries to serve both, with Priority 1 (route stops), Priority 1.5 (frontier approach), Priority 2 (demand deliveries), Priority 3 (demand pickups), Priority 4 (unconnected major cities). **A2 doesn't need frontier approach at all. A3 doesn't need demand scoring.** The mixed priorities cause A3 to sometimes pick a demand city when it should pick a frontier, and A2 to sometimes pick a frontier when it should pick a demand city.

### 6. Proximity reorder overrides LLM route planning

`reorderStopsByProximity` (RouteValidator:371) uses a greedy nearest-neighbor algorithm. It fires:
- In PlanExecutor (line 66) when any stop is skipped — **including pickups** (JIRA-156 Bug A)
- The reorder uses Manhattan/hex distance, ignoring track topology, build costs, and the LLM's original reasoning

The TripPlanner calls the LLM with full game context to determine optimal stop ordering. Then `reorderStopsByProximity` overwrites that ordering with a naive distance heuristic. This is **always wrong** when the LLM intentionally ordered stops out of proximity sequence (e.g., "deliver Beer first because you're passing through Holland on the way to Ruhr").

### 7. Demand ranking — mostly stable, but consumed in different ways

The demand ranking itself (`ContextBuilder.computeDemandScores`) appears consistent. However, it's consumed differently:

- **TripPlanner** receives ranked demands in the LLM prompt — LLM makes the final call
- **PlanExecutor.findDemandBuildTarget** uses `demand.demandScore` directly for sorting
- **TurnComposer.findMoveTargets** Priority 2-3 sorts by `demandScore` and checks `isDeliveryOnNetwork`/`isSupplyOnNetwork`
- **PlanExecutor.evaluateCargoForDrop** uses a separate hardcoded scoring formula

The risk here is lower than the route/build issues because demand ranking is mostly a read-only input. The main gap: `evaluateCargoForDrop` reimplements scoring instead of using the ranked demands.

## Structural Problems (Root Causes)

### A. No single source of truth for route state

The `StrategicRoute` object is the bot's "plan." It should be immutable within a turn phase, with a clear state machine (PLANNED → EXECUTING → COMPLETED/ABANDONED). Instead, it's mutated freely by PlanExecutor, TurnComposer, and AIStrategyEngine, each applying their own transformations in their own order.

### B. Composition phases (A0-A3) grew organically

A0 executes the primary action. A1 finds en-route opportunities. A2 chains continuation moves. A3 prepends moves before builds. Each was added by a different JIRA to fix a specific gap. They share helper functions (`findMoveTargets`, `splitMoveForOpportunities`) that try to serve all phases but have phase-specific conditionals scattered throughout.

### C. PlanExecutor and TurnComposer overlap

Both modify the route. Both generate move/pickup/deliver/build actions. Both determine build targets. The intended boundary is: PlanExecutor generates the **primary** action from the route, TurnComposer **enhances** it with additional actions. But:
- PlanExecutor's `continuationBuild` generates additional build actions (enhancement territory)
- TurnComposer's A3 generates primary move actions (executor territory)
- Both skip/reorder stops

### D. No pipeline-level invariant checking

There's no assertion that route stops can only be reordered after a delivery, or that build direction must agree with move direction, or that the route hasn't been mutated between phases. Bugs surface as wrong behavior in games, not as failed assertions.

## Recommended Approach

This isn't a "fix 2 bugs" situation. The pipeline needs a **structural refactor** focused on:

1. **Single route state machine** — Route mutations happen through a central API with explicit transition rules (e.g., "reorder only after delivery")
2. **Split `findMoveTargets`** — Separate A2 (continuation) and A3 (frontier) target finders
3. **Unify "is stop done?"** — One function, called everywhere
4. **Unify "build target"** — One function that determines where to build, used by JIT gate, BuildAdvisor, A3, and PlanExecutor
5. **Unify "network frontier"** — One function with consistent unnamed-node handling
6. **Remove proximity reorder** — Or gate it strictly on delivery-only events with an opt-out for LLM-planned routes
7. **Add pipeline assertions** — Post-phase checks that catch state inconsistencies before they produce wrong behavior

The JIRA-156 bug fixes can go in immediately as targeted patches. The structural refactor should be a separate planned effort.
