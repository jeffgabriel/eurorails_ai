# End-Game Routing Boundary Assessment

Date: 2026-06-05

Branch: `matt/turn-snapshot-contract`
Baseline: `matt/may-29`

## Product Reading

This refactor improves the handoff between end-game route reasoning and turn execution, but it does not yet make the broad `AI Bot Engine` bubble visibly greener in Valence.

That is expected. Valence currently scores the bubble from broad code-graph signals: churn, blast radius, and whether the work is spread across one large live community. This branch adds safety contracts and tests inside the same high-churn `src/server/services/ai` community, so the product risk is lower even though the map-level health score is unchanged.

## What Changed

End-game route ownership is now concentrated in `victoryRules.ts`:

- `EndGameRoutingDecision` is the narrow producer-to-consumer contract.
- `buildEndGameRoutingDecision(...)` owns final-victory route projection, freshness gating, and carry precondition rejection.
- `buildEndGameTraceFromDecision(...)` turns the same decision into product-readable end-game trace output.

`AIStrategyEngine.ts` now consumes that handoff:

- It calls the producer once per eligible end-game turn.
- It applies a `fire` route only when it differs from the current active route.
- It logs and falls through on `skip`, including `carry_precondition_fail`.
- It passes the same decision into the end-game trace builder.

## Boundary Check

`TurnExecutorPlanner.ts` and `TurnExecutor.ts` did not gain final-victory route selection ownership.

Reviewed symbols:

- No `buildEndGameRoutingDecision`
- No `EndGameRoutingDecision`
- No `buildEndGameTraceFromDecision`
- No `findFinalVictoryOutcome`
- No `findFinalVictoryRoute`
- No `gateVictoryOutcomeFreshness`
- No `validateRouteCarryPreconditions`

`TurnExecutor.ts` does contain snapshot freshness execution checks from the larger snapshot-contract branch. That is execution safety, not final-victory route planning.

## Valence Result

Valence producer: `seeded-live-v1-community-evidence`

View: `ai_bot`

| Metric | Baseline `may-29` | Refactor branch |
| --- | ---: | ---: |
| Domains | 9 | 9 |
| Edges | 18 | 18 |
| Average health | 0.367 | 0.367 |
| Healthy bubbles | 6 | 6 |
| Watch bubbles | 1 | 1 |
| Drift bubbles | 2 | 2 |
| Boundary smells | 2 | 2 |
| AI Bot Engine health | 0.95 | 0.95 |
| Game State health | 0.67 | 0.67 |
| Demand & Delivery health | 0.51 | 0.51 |

Remaining Valence smells:

- `ai_bot -> game_state`
- `ai_bot -> track_building`

Valence still sees both sides of those smells in the live `server/services/ai` community. The branch has improved contract safety, but not yet enough graph shape to reduce the broad coupling score.

## Validation

Passed:

- `npm run build:server`
- `npm test -- --runInBand`
  - 202 suites passed
  - 1 suite skipped
  - 4163 tests passed
  - 29 tests skipped
- API/integration smoke with test server running:
  - `src/client/__tests__/lobby/lobby.integration.test.ts`: 4/4 passed
  - `src/client/__tests__/lobby/lobby.e2e.database.test.ts`: 7/8 passed
- Focused end-game routing tests:
  - `AIStrategyEngine.jira245.test.ts`
  - `AIStrategyEngine.jira279.test.ts`
  - `victoryRules.test.ts`
  - 94/94 passed
- Bot-turn integration smoke:
  - `botTurnFlow.test.ts`
  - 16/16 passed

Known issue:

- `npm run test:all` with the real test server running has 1 failing E2E assertion:
  - `src/client/__tests__/lobby/lobby.e2e.database.test.ts`
  - Test: `should call startGame API and change database status to ACTIVE`
  - Expected: `active`
  - Received: `initialBuild`

This failure is outside the end-game routing refactor. It reflects the current lobby/start-game lifecycle expectation, where `startGame` now enters `initialBuild` before active play.

## Next Refactor Slice

To make Valence visibly improve, the next slice should move graph shape, not only contract safety.

Recommended next move:

1. Keep final-victory route ownership in `victoryRules.ts`.
2. Extract the remaining end-game trace/application glue out of `AIStrategyEngine.ts` into a small consumer module, for example `EndGameRoutingConsumer.ts`.
3. Keep `TurnExecutorPlanner.ts` and `TurnExecutor.ts` as execution consumers only.
4. Rebuild and save a Valence snapshot after that slice.

Expected visible change:

- Fewer direct `AI Bot Engine -> Game State` reasons in the inspector.
- A smaller ownership surface inside `AIStrategyEngine.ts`.
- Potentially no immediate green bubble until churn drops or the AI community splits into clearer subcommunities.
