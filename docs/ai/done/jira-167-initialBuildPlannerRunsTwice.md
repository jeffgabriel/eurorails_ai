# JIRA-167 — InitialBuildPlanner runs on every initial-build turn, clobbering the previously-planned route

## Symptom

In game `ed4f7b5e-c488-49c1-9f58-144576e6609a`, Haiku's initial-build-planner ran on **both T2 and T3** (Eurorails has 2 initial-build turns). On T2 it planned `Cattle Bern→Berlin` and built track toward Bern. On T3 it re-planned from scratch, picked a different route (`Imports Hamburg→Beograd`), and overwrote the active route — orphaning the Bern-direction track from T2 and contributing to a stale-network movement bug downstream (frontier logic / first-move detour to Bern on T4).

Game log evidence (Haiku only, from `scripts/game-analysis.ts --player haiku`):

- T2: `[initial-build-planner] Build toward Bern for Cattle pickup`, route=`Cattle Bern→Berlin`, build target Bern.
- T3: `[initial-build-planner] Build toward Hamburg for Imports pickup`, route=`Imports Hamburg→Beograd`, build target Beograd.

Two distinct planner invocations, two distinct routes, in a single 2-turn initial-build phase.

## Root cause

`src/server/services/ai/AIStrategyEngine.ts:292`:

```ts
if (context.isInitialBuild) {
  // ... unconditionally calls InitialBuildPlanner.planInitialBuild() ...
  const buildPlan = InitialBuildPlanner.planInitialBuild(snapshot, gridPoints, demandScores);
  activeRoute = {
    stops: buildPlan.route,
    currentStopIndex: 0,
    phase: 'build',
    startingCity: buildPlan.startingCity,
    createdAtTurn: snapshot.turnNumber,
    reasoning: `[initial-build-planner] ${buildPlan.buildPriority}`,
  };
  // ... runs TurnExecutorPlanner.execute() to compute Phase B segments ...
}
```

`isInitialBuild` is just `snapshot.gameStatus === 'initialBuild'` (`ContextBuilder.ts:110`). Since Eurorails has 2 initial-build turns, this flag is true for **both** T2 and T3, and the branch has **no guard against re-planning**. Every initial-build turn:

1. Calls `InitialBuildPlanner.planInitialBuild()` from scratch with current demand scores and current network state.
2. Overwrites `activeRoute` unconditionally.
3. Recomputes Phase B segments via `TurnExecutorPlanner.execute()`.

Demand scores / network connectivity / pairing heuristics shift slightly between T2 and T3 (T2 has no track; T3 has the partial Bern-side build from T2), so the planner picks a different "best" pairing the second time and silently abandons the T2 plan. Track already paid for under the abandoned plan is orphaned and becomes stale-network noise that confuses downstream movement logic.

## Expected behavior

Initial-build planning should run **exactly once** per game — on the first initial-build turn. On subsequent initial-build turns, the bot should **continue executing the existing plan** (build more track toward the same pickup/delivery cities, up to the per-turn 20M build cap), not re-plan from scratch.

## Proposed fix

Guard the planning call: only invoke `InitialBuildPlanner.planInitialBuild()` if there is no `activeRoute` (or if the existing activeRoute is not in `phase: 'build'`). On subsequent initial-build turns, route through the executor branch so `TurnExecutorPlanner.execute()` continues the existing build plan.

```ts
if (context.isInitialBuild) {
  if (!activeRoute || activeRoute.phase !== 'build') {
    // First initial-build turn — plan from scratch
    const buildPlan = InitialBuildPlanner.planInitialBuild(snapshot, gridPoints, demandScores);
    activeRoute = { stops: buildPlan.route, currentStopIndex: 0, phase: 'build', ... };
    // ... existing planning path ...
  } else {
    // Subsequent initial-build turn — execute the existing plan
    const execResult = await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints);
    // ... assemble decision from execResult, same as the main route-executor branch ...
  }
}
```

Two implementation notes:

1. **Persistence**: confirm `activeRoute` actually round-trips between turns during the initial-build phase. If it's cleared somewhere on turn boundaries before the second initial-build turn, the guard above will misfire and re-plan anyway. (A separate suspect — see Bug 2 below — already hints that route persistence around the initial-build → play transition is fragile.)
2. **Reasoning string**: subsequent-turn decisions should still tag `[initial-build-planner] (continued)` or similar so logs make it clear the original plan is being honored.

## Out of scope (separate bugs noted but not addressed here)

- **Bug 2**: T3→T4 route flipped a *third* time (Imports Hamburg→Beograd → Oil Beograd→Zurich) without `initial-build-planner` running on T4. Reasoning on T4 is `[route-executor]`, meaning the new route was already in place when the executor ran. Suspect: post-initial-build cleanup clears `activeRoute` and a trip-planner / no-route branch generates a fresh route, OR a build-route → execution-route hand-off swaps stops. Needs its own investigation.
- **Frontier logic bug**: route-executor's `stop_city_not_on_network` fallback walks the train toward the closest connected major city (Bern, leftover from the Cattle plan) instead of the active route's pickup (Beograd). Already fixed conceptually in prior work — needs to be re-verified after Bug 1 + Bug 2 are resolved, since the orphaned track from this bug is what gives the frontier-logic bug its ammunition.

## Acceptance criteria

- In a fresh game, `InitialBuildPlanner.planInitialBuild()` is called exactly once per bot during the initial-build phase.
- The `activeRoute` selected on the first initial-build turn is preserved (same stops, same starting city) into the second initial-build turn.
- Track built on the second initial-build turn extends toward the same pickup/delivery cities as the first turn — no abandoned legs.
- Game log shows `[initial-build-planner]` reasoning on T2 only; T3 shows continuation reasoning, not a new plan.
