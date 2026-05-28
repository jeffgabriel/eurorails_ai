# JIRA-255 — End-game state lock + fewest-turns-to-victory ranking (technical)

Companion to `jira-255-endGamePhaseLogicNotWired-behavioral.md`.

## Defect loci

### 1. `classifyGamePhase` is dead code

`src/server/services/ai/DeterministicTripPlanner.ts:68` — `classifyGamePhase(turn, deliveries, citiesConnected): 'early' | 'mid' | 'late'`. Defined, exported, has its own test suite. `grep -r classifyGamePhase src/` shows zero production callers.

### 2. `NetworkContext.computePhase` feeds the log/LLM only

`src/server/services/ai/context/NetworkContext.ts:259-269` produces the `gamePhase` log field. Not consumed by `DeterministicTripPlanner.scoreCandidate` or `computeAggregateScore`. The deterministic planner has no phase awareness.

### 3. `aggregateScore` is pure income velocity

`DeterministicTripPlanner.ts:1086` (`scoreCandidate`) and `1182-1184` (`computeAggregateScore`):

```ts
aggregateScore: net / Math.max(turns, 1),
// chained:
const aggregate = (c1.net + c2ChainedNet) / Math.max(c1.turns + c2Chained.turnsToComplete, 1);
```

No notion of "this candidate funds the full win cost."

### 4. `PRUNE_MAX_TURNS = 12` drops win-completers

`DeterministicTripPlanner.ts:78` — applied before scoring. The T76 log records `Discarded by prune: 831 (turns > 12)`. The only win-completing candidate at T76 (triple-Hops-Cardiff) is in this bucket.

### 5. `NetworkContext.computeUnconnectedMajorCities` is unused by the planner

`NetworkContext.ts:272-288` returns `{cityName, estimatedCost}[]` for unconnected majors, sorted cheapest-first. The data the planner needs to compute `fullWinCost` already exists; it just isn't read.

## Fix shape

Four layers. All required.

### Layer 0 — Fix same-city phantom turn in cheapPrune estimator

`PathCostEstimator.ts:188` hardcodes `estimatedTurns: 1` for trivial same-point legs:

```ts
if (fromCoord.row === toCoord.row && fromCoord.col === toCoord.col) {
  const trivial: PathCost = { buildCost: 0, pathLength: 1, estimatedTurns: 1, reachable: true, newSegments: [] };
```

A leg from a city back to itself (e.g. multi-pickup at one city) costs zero turns — game rule: pickups/deliveries do not consume movement. Change to `estimatedTurns: 0`. Triple-Hops-Cardiff's two same-city pickup-to-pickup transitions drop the cheapPrune estimate from 13 turns to 11, surviving the `PRUNE_MAX_TURNS = 12` cut even without Layer A's carve-out. Layer A still required for genuinely long win-completers.

This is the surgical estimator fix; the broader estimator overhaul (per-leg `ceil` inflation, no continuous-movement model) is out of scope and tracked separately.

### Layer A — End-game state lock

Add a sticky flag on bot memory:

```ts
// extend BotMemoryState:
endGameLocked: boolean; // once true, stays true for the rest of the game
```

Set in the planner entry point (e.g. `AIStrategyEngine` or `DeterministicTripPlanner.planTrip`):

```ts
if (snapshot.bot.money > 200 && !memory.endGameLocked) {
  memory.endGameLocked = true;
  await updateMemory(gameId, playerId, { endGameLocked: true });
}
```

The lock is one-way. Once active, end-game routing rules apply on every subsequent replan — even if cash temporarily drops below $200M from a build.

### Layer B — Pre-prune carve-out + win-completer filter

New helper (e.g. `src/server/services/ai/winCompletion.ts`):

```ts
export const CASH_WIN_THRESHOLD_M = 250;

export function fullWinCost(
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): number {
  const remaining = Math.max(0, 7 - cmcCount);
  const cityCost = unconnectedMajors.slice(0, remaining)
    .reduce((sum, c) => sum + c.estimatedCost, 0);
  return CASH_WIN_THRESHOLD_M + cityCost;
}

export function isWinCompleting(
  currentCash: number,
  candidateNet: number,
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): boolean {
  return currentCash + candidateNet >= fullWinCost(unconnectedMajors, cmcCount);
}
```

In the prune pass — skip the `turns > PRUNE_MAX_TURNS` discard when the candidate is a win-completer and the bot is in end-game state:

```ts
if (candidate.turns > PRUNE_MAX_TURNS) {
  if (memory.endGameLocked && isWinCompleting(cash, candidate.net, unconnectedMajors, cmcCount)) {
    // keep — long-turn winners survive in end-game
  } else {
    continue;
  }
}
```

### Layer C — Fewest-turns-to-victory ranking in end-game

In end-game state, replace `aggregateScore` ranking with a two-tier sort:

```ts
function endGameRankKey(c: ScoredCandidate, ctx: WinContext): [number, number] {
  const completing = isWinCompleting(ctx.cash, c.net, ctx.unconnectedMajors, ctx.cmcCount);
  // Primary: completers (0) sort before non-completers (1).
  // Secondary: ascending turns. Among completers, fewer turns = better.
  //            Among non-completers, fall back to velocity.
  return [completing ? 0 : 1, completing ? c.turns : -c.aggregateScore];
}
```

If no completer exists in the candidate set, the second tier (`-aggregateScore` on non-completers) is the ranker — same as today.

Outside end-game state, ranking is unchanged.

### Layer D — Wire `classifyGamePhase` (housekeeping)

The dead `classifyGamePhase` becomes the gate on Layers B/C alongside the `endGameLocked` flag. Either:
- Use `classifyGamePhase(turn, deliveries, cmc) === 'late'` as an alternate trigger for setting `endGameLocked` (in addition to `cash > 200`), OR
- Delete `classifyGamePhase` and its tests if `endGameLocked` covers all the cases.

Recommend the first option — phase-and-cash both rotating the lock catches more cases (e.g. games where `cmc` reaches 5 before cash reaches $200M).

## Out of scope

- **Broader turn-estimator overhaul.** Both `cheapPrune` and `simulateTrip` sum per-leg `ceil(mp/speed)` instead of running a continuous-movement simulator. This inflates multi-stop candidates systematically. Layer 0 fixes only the same-city phantom-turn case (the most common over-counter for triple-pickup candidates). The per-leg ceiling drift, no-cross-leg-movement-carry, and partial ferry-rate modeling are tracked in a separate ticket. Layer A's carve-out keeps win-completers in scope regardless of remaining estimator drift.
- LLM-path scoring. The deterministic planner is the entry here (`[deterministic-top-1]` in the T76 reasoning).
- Replacing `aggregateScore` outside end-game state. Pre-end-game ranking is unchanged.

## Acceptance from behavioral

- **AC0** Unit test on `estimateGraphPathCost`: same-coord input (`from === to`) returns `estimatedTurns: 0`. Pre-fix returns `1`.
- **AC1** Unit test: bot snapshot `cash = 205M`, `endGameLocked = false`. After one replan tick, `memory.endGameLocked === true`. Persist via `updateMemory`.
- **AC2** Unit test: `endGameLocked = true`, then a build drops `cash` to $180M. Lock remains true; end-game ranking still applies.
- **AC3** Unit test on the prune pass: `endGameLocked = true`, candidate `{ net: 67, turns: 16 }`, `fullWinCost = $280M`, `cash = $227M`. Assert candidate survives. With `endGameLocked = false`, candidate is discarded by `turns > 12`.
- **AC4** Unit test on ranking: `endGameLocked = true`, candidate A `{ net: 67, turns: 16, win-completing }`, candidate B `{ net: 18, turns: 6, not win-completing }`. Assert A ranks above B.
- **AC5** Unit test on ranking: `endGameLocked = true`, both candidates win-completing, A `{ turns: 9 }`, B `{ turns: 16 }`. Assert A ranks above B (fewest turns wins).
- **AC6** Unit test on ranking: `endGameLocked = true`, no win-completer in the candidate set. Assert ranking falls back to `-aggregateScore` (i.e. existing velocity ranking).
- **AC7** Unit test outside end-game: `endGameLocked = false`, cash $80M. Assert ranking is unchanged from today's behavior.
- **AC8** Game replay on Sonnet T76 snapshot, game `6033c903`. Assert top-1 is the triple-Hops-Cardiff candidate.
- **AC9** `grep -rn "classifyGamePhase" src/` shows at least one non-test usage in the planner pipeline.

## Validation hooks

- New log fields per turn: `endGameLocked: boolean`, `fullWinCost: number`, `winCompleterCount: number`.
- Reasoning string for the picked candidate, when in end-game: `Picked: triple-3fresh — payout 89M, NET 67M, 16 turns. End-game: win-completer (projected $294M cash, full win cost $280M), ranked by fewest turns.`
- Prune log line in end-game: `Discarded by prune: 829 (turns > 12, 2 win-completing kept).`

## Relationship to existing JIRAs

- **JIRA-229** introduced `aggregateScore`. This ticket adds a phase override that does not modify mid-game ranking.
- **JIRA-242** added flat additive bonuses on `aggregateScore` for multi-delivery candidates — different pattern (additive bonus) than this ticket (rank-key override) but in the same scoring path.
- **JIRA-253** narrowed the A3 partial-path abandon predicate, allowing multi-turn builds to execute. Required for any long-turn win-completer surfaced by Layer B to actually run.
- **JIRA-252** addresses post-delivery replan ordering — sibling timing concern.
