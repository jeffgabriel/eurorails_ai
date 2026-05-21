# JIRA-241 — Add persistent `gameState` on bot memory and re-score routes under `end` semantics (technical)

Companion to `jira-241-botLacksPersistentEndGameState-behavioral.md`.

## Defect locus

There is no single function to point at. The defect is the absence of a persistent posture field and the absence of end-state-aware scoring. Touchpoints:

- `src/server/services/ai/BotMemory.ts` — persisted bot state across turns; needs a new field.
- `src/server/services/ai/ContextBuilder.ts` — builds `GameContext` per turn from the snapshot; needs to compute and stamp the posture.
- `src/server/services/ai/DeterministicTripPlanner.ts` — the medium-skill route scorer; needs the cap + city-cost adjustment.
- `src/server/services/ai/PostDeliveryReplanner.ts` — accepts whatever `TripPlanner` returns; needs the "strictly faster" gate.
- `src/server/services/ai/BuildPhasePlanner.ts` and `src/server/services/ai/routeHelpers.ts` — the victory-build branch and JIRA-240 secondary bundling are now superseded inside `end` state.
- `src/server/services/ai/GameLogger.ts` — needs to log `gameState` per turn for traceability.
- `src/shared/types/GameTypes.ts` — new `GameState` enum, extended `GameContext` and `BotMemoryState` shapes.

## Fix shape

### 1. Shared types

In `src/shared/types/GameTypes.ts`:

```ts
export enum GameState {
  Initial = 'initial',
  Mid = 'mid',
  End = 'end',
}

export const END_GAME_ENTRY_CASH = 200; // first turn cash > 200M latches gameState = End

// (existing) export const VICTORY_INITIAL_THRESHOLD = 250;
// (existing) VICTORY_CITY_COUNT = 7 — currently lives in routeHelpers.ts; hoist here.
```

Extend `BotMemoryState` with `gameState?: GameState`. Default behavior when absent: treat as `Mid`.

Extend `GameContext` with `gameState: GameState` (required after this change; ContextBuilder always stamps it).

### 2. New module — `victoryRules.ts`

`src/server/services/ai/victoryRules.ts`. Owns the latching logic and city-cost computation. Pure functions, easy to unit-test.

```ts
import { GameContext, GameState, BotMemoryState, END_GAME_ENTRY_CASH } from '../../shared/types/GameTypes';

export function computeGameState(
  context: { money: number },
  memory: BotMemoryState,
): GameState {
  const prior = memory.gameState ?? GameState.Mid;
  if (prior === GameState.End) return GameState.End; // latched
  if (context.money > END_GAME_ENTRY_CASH) return GameState.End;
  return prior;
}

/**
 * Cost (ECU) of building from the bot's existing network to the cheapest
 * currently-unconnected major city. Returns 0 when cities >= 7.
 * Reuses context.unconnectedMajorCities[0].estimatedCost which is already
 * computed by ContextBuilder.computeUnconnectedMajorCities.
 */
export function cheapestUnconnectedMajorConnectorCost(context: GameContext): number {
  if (context.connectedMajorCities.length >= VICTORY_CITY_COUNT) return 0;
  return context.unconnectedMajorCities[0]?.estimatedCost ?? 0;
}
```

### 3. ContextBuilder

In `ContextBuilder.makeContext`, after the existing context fields are computed:

```ts
const memory = await getMemory(snapshot.gameId, snapshot.bot.playerId);
const gameState = computeGameState({ money: snapshot.bot.money }, memory);
if (gameState !== memory.gameState) {
  await setMemory(snapshot.gameId, snapshot.bot.playerId, { ...memory, gameState });
}
return { ...context, gameState };
```

The latching happens here, on every context build. The persisted state ensures a transient cash dip on the next turn doesn't reset the posture.

### 4. DeterministicTripPlanner — end-state scoring

The candidate-scoring step (currently `computeAggregateScore` and surrounding logic in `DeterministicTripPlanner.ts`) is where the cap + cost adjustment applies. Identify the scoring entry point per candidate. For each candidate, when `context.gameState === GameState.End`:

```ts
function scoreCandidateForEnd(candidate, context) {
  const cashGap = Math.max(0, VICTORY_INITIAL_THRESHOLD - context.money);
  const effectivePayoff = Math.min(candidate.payoff, cashGap);

  const needsCity = context.connectedMajorCities.length < VICTORY_CITY_COUNT;
  const candidateConnectsMajor = candidateTouchesUnconnectedMajor(candidate, context);
  const cityCost = (needsCity && !candidateConnectsMajor)
    ? cheapestUnconnectedMajorConnectorCost(context)
    : 0;

  const effectiveCost = candidate.ecuCost + cityCost;
  const effectiveNet = effectivePayoff - effectiveCost;
  return effectiveNet / candidate.turns;
}
```

Helpers to add:

- `candidateTouchesUnconnectedMajor(candidate, context): boolean` — examines the candidate's `builtSegments` (already on `TripSimulation`/`ScoredCandidate` after JIRA-237 Task 1) and returns true if any segment terminates at an unconnected major's milepost. Reuse `getConnectedMajorCities` against the union of `snapshot.bot.existingSegments` + `candidate.builtSegments` and compare to baseline.

- **First-delivery-wins refinement** (behavioral AC subtlety): when `context.money + candidate.firstDeliveryPayoff >= VICTORY_INITIAL_THRESHOLD`, set `candidate.turnsForScoring = candidate.firstDeliveryTurn` rather than `candidate.totalTurns`. This prevents a long route from looking competitive when its first stop alone would have ended the game. `candidate.firstDeliveryTurn` and `candidate.firstDeliveryPayoff` are derivable from the existing `simulateTrip` stop-by-stop trace.

Replace the existing scoring step's score-formula for `end`-state candidates with the formula above. The candidate ranking, top-K selection, and aggregate-pass logic (JIRA-237) remain otherwise unchanged.

### 5. PostDeliveryReplanner — strictly-faster gate

In `PostDeliveryReplanner.replan`, after `TripPlanner.planTrip` returns a candidate route, before accepting it:

```ts
if (
  context.gameState === GameState.End &&
  replanResult.route &&
  postDeliveryRoute /* existing route */
) {
  const currentRemaining = computeRemainingTurns(postDeliveryRoute, snapshot, context);
  const candidateTurns = computeTotalTurns(replanResult.route, snapshot, context);
  if (candidateTurns >= currentRemaining) {
    console.log(
      `${tag} [PostDeliveryReplanner] END-STATE: candidate (${candidateTurns}t) not strictly faster than current (${currentRemaining}t) — keeping existing route`,
    );
    const revalidated = TurnExecutorPlanner.revalidateRemainingDeliveries(activeRoute, context);
    const skipped = TurnExecutorPlanner.skipCompletedStops(revalidated, context);
    return { route: skipped, moveTargetInvalidated: false, /* propagate llm log etc. */ };
  }
}
```

`computeRemainingTurns` and `computeTotalTurns` are thin wrappers that reuse the planner's per-route turn estimate (already present on `ScoredCandidate`). For the current route, simulate forward from `currentStopIndex` using the existing `simulateTrip` machinery.

The replan gate fires only in `end` state. In `mid`, current behavior is preserved.

### 6. BuildPhasePlanner / routeHelpers — suppress victory-build branch in `end`

In `routeHelpers.resolveBuildTarget`, change the victory-eligible check from `cash ≥ 230 AND cities < 7` to: only fire the `findCheapestUnconnectedMajorCity` branch when **`context.gameState !== GameState.End`** AND the existing eligibility holds. In `end` state, fall through to `findRouteBasedTarget`. The city goal is now handled inside trip scoring; we don't need a parallel build-target override.

Same change for the JIRA-240 secondary-target bundling: skip when `context.gameState === GameState.End`.

This makes `VICTORY_BUILD_TRIGGER_M = 230` effectively only fire in `mid` state. Since `end` latches at cash > 200, in practice the 230 branch becomes a brief window between 230 < cash ≤ 200... which is empty. So the 230 branch never fires once this change lands. Mark it as obsolete in a code comment; deletion is a follow-up.

### 7. GameLogger

In `GameLogger.logBotTurn` (or the equivalent per-turn entry point), include `gameState: context.gameState` in the per-turn JSON record. One line of plumbing.

## Test coverage

### `victoryRules.test.ts` (new)

- AC1a: `computeGameState` with `memory.gameState = undefined`, `cash = 150` → `mid`.
- AC1b: `cash = 201` → `end`.
- AC1c: `memory.gameState = 'end'`, `cash = 180` → `end` (latched).
- AC1d: `memory.gameState = 'end'`, `cash = 300` → `end`.

### `DeterministicTripPlanner.test.ts`

- AC3 (overshoot cap): fixture at 249M cash, 7 cities, two candidates A (5M, 2t) and B (30M, 8t). Expect A wins under `end` scoring.
- AC4 (city cost adjustment): 6 cities, Wien 14M connector, candidate A connects Wien with NET 20M / 8t, candidate B does not connect any major with NET 25M / 8t. Expect A wins (B's effective NET = 25 − 14 = 11 < 20).
- AC4b: cities already 7. Candidate A and B as above. Expect B wins (no city-cost adjustment applies).
- First-delivery-wins refinement: 248M cash, candidate route with first delivery 5M (turn 2) + second delivery 20M (turn 7). Expect `turnsForScoring = 2`, not 7.

### `PostDeliveryReplanner.test.ts`

- AC2 (181cf810 t80 regression): full snapshot reconstruction. Expect existing route preserved.
- AC5 (no replan when not strictly faster): current route remaining = 3t, candidate total = 3t. Expect no swap.
- AC5b (replan when faster): current remaining = 5t, candidate total = 3t. Expect swap.
- AC5c (`mid` state unaffected): same fixture as AC5 but `gameState = Mid`. Expect normal replan behavior (current code path).

### `routeHelpers.test.ts`

- AC6 (no victory-build in `end`): cash = 240, cities = 5, `gameState = End`. Expect `resolveBuildTarget` returns either null or a route-based target — never the cheapest unconnected major's name.
- AC6b (no JIRA-240 secondary in `end`): same fixture, ensure `secondaryTarget` is undefined.

### Game-log regression

- AC8: feed the `181cf810` t80 snapshot into the full bot turn pipeline (`AIStrategyEngine.executeBotTurn` or equivalent). Walk it forward turn-by-turn until victory is declared. Assert win turn ≤ t82.

## Rollout / migration

- The `gameState` field on `BotMemoryState` is optional in storage; existing persisted memories without the field deserialize to `gameState = undefined`, which `computeGameState` interprets as `mid`. No migration script.
- `VICTORY_BUILD_TRIGGER_M = 230` becomes effectively dead after this lands (its window 230 < cash ≤ 200 is empty since `end` latches at > 200). Leave the constant in place with a `// JIRA-241: subsumed by gameState === End` comment. Cleanup is a follow-up.
- JIRA-239's delivery-first guard in `resolveBuildTarget`'s victory branch is also subsumed in practice (since the victory branch no longer fires in `end`), but leave it in place — it remains the right behavior for the brief `cash >= 230 && cities < 7 && gameState === Mid` window that exists only for bots whose `gameState` is somehow not yet `end`. Defensive.

## Why a persistent field, not a per-turn check

A per-turn check `if (cash > 200 || cities >= 7)` would have the same effect on the first turn it fires but would silently flip back to `mid` semantics the turn after a 20M build dropped cash below 200. The whole point of the fix is to keep the bot's mindset stable through expenditures. Persistence in `BotMemoryState` is the simplest correct expression of "latched" — the memory layer is already designed for cross-turn bot state.

## Out of scope

- `Initial → Mid` transition. Setup code paths exist; formalizing them is deferred.
- Threshold tuning (200M, 250M, 7 cities). Use the values from the rules verbatim.
- Multi-major prorated or summed city-cost models — single cheapest only.
- Bonus for routes connecting multiple unconnected majors — zero penalty for connecting one, no extra credit.
- Removing `VICTORY_BUILD_TRIGGER_M`. The constant becomes effectively unreachable; deletion is a hygiene follow-up.
- LLM-path scoring. Bot is deterministic medium-skill.
- Cross-skill propagation (Easy/Hard). Apply only to Medium for this iteration; mirror to other skills if observed beneficial.
