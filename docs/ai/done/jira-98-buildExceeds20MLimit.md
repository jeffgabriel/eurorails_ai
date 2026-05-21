# JIRA-98: Build Execution Exceeds $20M/Turn Limit

## Problem

The build execution path allows spending more than the $20M per turn limit on track building. At T5 in game 069de7f0, the route-executor built 22 segments costing $30M in a single turn.

### Example: Game 069de7f0, T5 (player a9046055)

Bot at T4 had $26M. At T5:
1. PlanExecutor resolves MOVE toward Wroclaw (route: pickup Steel@Ruhr → deliver Steel@Wroclaw)
2. TurnComposer A1 finds mid-movement delivery opportunity: delivers Steel at Wroclaw (~$14M payout)
3. TurnComposer A2 chains continuation MOVE (9mp total used)
4. **Composition trace shows `build.target: null, build.cost: 0`** — TurnComposer Phase B did NOT append a build
5. Route completes → LLM replans new route (Iron: Kaliningrad → Bremen)
6. PlanExecutor.resolveBuild() builds 22 segments costing $30M toward Kaliningrad
7. Bot ends at $10M ($40M post-delivery minus $30M build)

**Key finding:** The $30M build came from `PlanExecutor.resolveBuild()` (route executor), NOT from `TurnComposer.tryAppendBuild()` (Phase B). The composition trace confirms Phase B appended nothing. The route executor's build path is the one violating the cap.

### Game Rules

> "A player may spend up to ECU 20 million per turn to: 1. Build track, OR 2. Upgrade their train."

The $20M limit is a hard cap per turn. No exceptions.

### Root Cause

The build budget is not being enforced as a hard $20M cap in the route executor path. When `PlanExecutor.resolveBuild()` calls `ActionResolver.resolve()` with action BUILD, the budget parameter passed to `computeBuildSegments()` likely uses `bot.money` (which is $40M post-delivery) instead of `min(bot.money, 20 - turnBuildCost)`. The delivery payout inflated the available cash mid-turn, and the build consumed all of it without respecting the $20M cap.

`continuationBuild()` is NOT the culprit here — that's only called during `initialBuild`. This is the normal `resolveBuild()` path.

## Possible Fix - Needs Validated

Enforce `buildBudget = min(bot.money, 20 - turnBuildCost)` as a hard cap in `ActionResolver.resolve()` or in `computeBuildSegments()`. The budget must account for any track already built this turn (`turnBuildCost`).

## Files to Investigate

- `ActionResolver.ts` — `resolve()` for BUILD action — where build budget is calculated and passed to computeBuildSegments
- `computeBuildSegments.ts` — where Dijkstra pathfinding determines segments to build — verify it respects the budget parameter
- `PlanExecutor.ts` — `resolveBuild()` — confirm it passes the correct budget context
- `TurnComposer.ts` — `tryAppendBuild()` — verify it independently caps at `20 - turnBuildCost` (appears correct based on log evidence)
