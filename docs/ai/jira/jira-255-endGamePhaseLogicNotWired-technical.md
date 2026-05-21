# JIRA-255 — Wire end-game phase awareness into scoring; add cash-completion boost (technical)

Companion to `jira-255-endGamePhaseLogicNotWired-behavioral.md`.

## Defect loci

### 1. `classifyGamePhase` is dead code

`src/server/services/ai/DeterministicTripPlanner.ts:68-76`:

```ts
export function classifyGamePhase(
  turn: number,
  deliveries: number,
  citiesConnected: number,
): 'early' | 'mid' | 'late' {
  if (citiesConnected >= 5 || turn >= 80) return 'late';
  if (turn < 25 || deliveries < 3 || citiesConnected < 2) return 'early';
  return 'mid';
}
```

`grep -r classifyGamePhase src/` shows the function is exported and has its own test block (`src/server/__tests__/ai/DeterministicTripPlanner.test.ts:265-310`) — but it is **never called from production code**. The phase classifier is a stub.

### 2. `NetworkContext.computePhase` feeds the log + LLM prompt, not the scorer

`src/server/services/ai/context/NetworkContext.ts:258-269`:

```ts
static computePhase(snapshot, connectedMajorCities): string {
  if (snapshot.gameStatus === 'initialBuild') return 'Initial Build';
  if (connectedMajorCities.length >= 6 && snapshot.bot.money >= 230) return 'Victory Imminent';
  if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 250) return 'Victory Imminent';
  if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 150) return 'Late Game';
  if (connectedMajorCities.length >= 3 || snapshot.bot.money >= 80) return 'Mid Game';
  return 'Early Game';
}
```

`computePhase` is wired into `ContextBuilder` → `WhisperService` → LLM prompt; the value also lands in the turn log as `gamePhase`. It is **not** read by `DeterministicTripPlanner.scoreCandidate` or `computeAggregateScore`. So the deterministic planner (the path Sonnet's T76 replan ran through, `[deterministic-top-1]`) does not see the phase.

In Sonnet's T76 state (`cmc=3`, `cash=227`), `computePhase` returns `'Mid Game'` because `cmc < 5` short-circuits the `Late Game` and `Victory Imminent` cases — even though cash is just $3M from the `Victory Imminent` cash threshold of $230M (the `cmc >= 6 && money >= 230` rule's cash side).

### 3. `aggregateScore` is pure income velocity (no win-completion term)

`src/server/services/ai/DeterministicTripPlanner.ts:1086`:

```ts
aggregateScore: net / Math.max(turns, 1),
```

And the chained variant at lines 1182–1184:

```ts
const aggregateTurns = Math.max(c1.turns + c2Chained.turnsToComplete, 1);
const aggregateNet = c1.net + c2ChainedNet;
const aggregate = aggregateNet / aggregateTurns;
```

There is no awareness of "this candidate's NET, added to current cash and minus the remaining city-connection track cost, clears the full win cost." A candidate that funds both win dimensions ranks identically on velocity to one that overshoots cash but leaves cities unfunded.

### 4. `PRUNE_MAX_TURNS = 12` discards win-completing candidates before scoring

`src/server/services/ai/DeterministicTripPlanner.ts:78`:

```ts
export const PRUNE_MAX_TURNS = 12;
```

Applied in the candidate-filtering pass before `scoreCandidate` runs. The T76 log shows `"Discarded by prune: 831 (turns > 12)"`. The triple-Hops-Cardiff route (3 pickups + 3 deliveries + 22M ferry build ≈ 14-18 turns) is in this bucket. Layer A's scoring boost is useless if the candidate is pruned before it can be scored.

### 5. The win-cost formula needs the city-connection budget too

`src/server/services/ai/context/NetworkContext.ts:272-288` already exposes the per-city cost for unconnected majors via `computeUnconnectedMajorCities`, returning `{cityName, estimatedCost}[]` sorted cheapest-first:

```ts
return unconnected.map(cityName => ({
  cityName,
  estimatedCost: NetworkContext.estimateTrackCostToCity(cityName, segments, gridPoints),
})).sort((a, b) => a.estimatedCost - b.estimatedCost);
```

Summing the cheapest `(7 - cmc.length)` entries gives `costToConnectRemainingMajors`. The full win cost is `CASH_WIN_THRESHOLD_M + costToConnectRemainingMajors`. The boost/protection should gate on `(currentCash + candidate.net) − costToConnectRemainingMajors ≥ CASH_WIN_THRESHOLD_M`.

## Fix shape

Three layers. **Layer A (pre-prune protection) and Layer B (completion boost) are both required** — a boost on a pruned candidate does nothing, and surviving prune without a boost still loses to a faster non-completing candidate. Layer C wires phase classification.

### Layer A — Pre-prune protection for win-completing candidates

Modify the candidate filtering pass so that a candidate with `turns > PRUNE_MAX_TURNS` is **only** pruned if it is *not* a win-completing candidate. Concretely:

```ts
// New helper, e.g. src/server/services/ai/winCompletion.ts:

export const CASH_WIN_THRESHOLD_M = 250;

/**
 * The full win budget: $250M cash + the track cost to connect the remaining
 * unconnected major cities. Computed from existing NetworkContext data.
 */
export function fullWinCost(
  currentCash: number,
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): number {
  const remainingToConnect = Math.max(0, 7 - cmcCount);
  const cityCost = unconnectedMajors
    .slice(0, remainingToConnect)
    .reduce((sum, c) => sum + c.estimatedCost, 0);
  return CASH_WIN_THRESHOLD_M + cityCost;
}

/**
 * True if this candidate's projected cash, minus the remaining city-track
 * budget, clears the full win cost.
 */
export function isWinCompleting(
  currentCash: number,
  candidate: { net: number },
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): boolean {
  return (currentCash + candidate.net) >= fullWinCost(currentCash, unconnectedMajors, cmcCount);
}
```

In the prune pass (search for the `turns > PRUNE_MAX_TURNS` discard, near where the T76 reasoning prints `Discarded by prune: 831 (turns > 12)`):

```ts
if (candidate.turns > PRUNE_MAX_TURNS) {
  if (!isWinCompleting(currentCash, candidate, unconnectedMajors, cmcCount)) {
    continue; // existing prune behavior
  }
  // win-completing → keep in scoring pool regardless of turn count
}
```

Keep a hard ceiling (e.g. `WIN_COMPLETING_MAX_TURNS = 25`) so a 50-turn candidate doesn't bypass prune.

### Layer B — Win-completion boost on `aggregateScore`

After Layer A keeps the candidate in the pool, the boost ensures it ranks above faster non-completers:

```ts
const COMPLETION_BOOST_M_PER_TURN = 2.0; // additive boost on aggregateScore

function winCompletionBoost(
  currentCash: number,
  candidate: { net: number },
  unconnectedMajors: Array<{ cityName: string; estimatedCost: number }>,
  cmcCount: number,
): number {
  if (!isWinCompleting(currentCash, candidate, unconnectedMajors, cmcCount)) return 0;
  return COMPLETION_BOOST_M_PER_TURN;
}
```

Apply where `aggregateScore` is set — both the no-followup path (`scoreCandidate` ≈ line 1086) and the chained path (`computeAggregateScore` ≈ lines 1182–1184). Mutate `aggregateScore` in place after the velocity calculation, before the rank-sort.

The boost is **flat** (M/turn-scaled), not multiplicative — matches the JIRA-242 precedent of a flat additive bonus on `aggregateScore`. Magnitude tuned so a $67M-NET / 16-turn triple completer (velocity 4.19) beats a $18M-NET / 6-turn single non-completer (velocity 3.0) with boost-margin to spare.

Why a flat boost rather than threshold-based reranking:
- Threshold reranking ("all completers above all non-completers") could promote a strictly worse candidate (e.g. NET +$1M just-barely-completing over a NET +$40M non-completing with massive headroom). The flat boost keeps velocity in the picture among completers, just shifts them as a group above non-completers when the win is actually on the table.
- Multiplicative scaling distorts mid-game cases.
- The flat additive bonus matches existing JIRA-242 pattern.

### Layer C — Wire `classifyGamePhase` into the scorer

Wire the dead `classifyGamePhase` from `DeterministicTripPlanner.ts:68` into the planner's pipeline. Use it as a coarse gate on the Layer A/B logic — e.g. only apply pre-prune protection and the boost when `classifyGamePhase(turn, deliveries, cmc) === 'late'`. Pass `(turn, deliveries, citiesConnected)` into `scoreCandidate` and the prune.

This kills two birds: the dead classifier is now load-bearing, and the boost is bounded to its intended phase — no risk of distorting early/mid-game cases.

For traceability, the boost should be recorded in the candidate's reasoning string (the human-readable rationale already emits things like "Picked: pair-fresh+fresh — payout 48M, build 0M, 12 turns, NET 48M"). Append `(+2.0 win-completion boost; projected cash $294M ≥ full win cost $280M)` when active.

## Acceptance from behavioral

- **AC1 — Pre-prune protection.** Unit test on the candidate prune pass: fixture `currentCash = 227`, `cmc = 3`, capacity 3, `unconnectedMajorCost = $30M`, candidate `{ net: 67, turns: 16 }` (triple-Hops-Cardiff). With Layer A: assert the candidate appears in the survivors list. Without Layer A (baseline): assert it is in the `turns > 12` discard bucket.
- **AC2 — Win-completion boost.** Unit test on `scoreCandidate`: same fixture + a competing candidate `{ net: 18, turns: 6 }` (single-Potatoes). With Layer B: assert the triple's `aggregateScore > single`. Without Layer B: single wins on velocity.
- **AC3 — Win cost includes city-track-budget.** Unit test on `isWinCompleting`: fixture `currentCash = 260, cmc = 3, unconnectedMajorCost = $30M`, candidate `{ net: 10 }`. Assert: NOT win-completing (`260 + 10 − 30 = 240 < 250`). Same fixture with candidate `{ net: 25 }`: assert IS win-completing (`260 + 25 − 30 = 255 ≥ 250`).
- **AC4 — Boost dormant outside late phase.** Unit test on Layer C gate: fixture `currentCash = 80, turn = 20, deliveries = 1, cmc = 2` (classifies as `'early'`). Assert: boost does not fire even if `(cash + net) − cityCost ≥ 250` mathematically.
- **AC5 — Hard ceiling on pre-prune protection.** Unit test: fixture with a win-completing candidate `{ turns: 30 }`. Assert: candidate is pruned by the `WIN_COMPLETING_MAX_TURNS` ceiling even though it satisfies `isWinCompleting`.
- **AC6 — Game replay regression.** Replay Sonnet T76 snapshot from game `6033c903`. Assert: top-1 chosen candidate is the triple-Hops-Cardiff (or equivalent win-completer). Reasoning string includes the boost annotation. Single-Potatoes-Lodz is no longer top-1.
- **AC7 — Phase classifier wired.** After Layer C: `grep -rn "classifyGamePhase" src/` shows at least one non-test usage in `DeterministicTripPlanner` (or wherever the prune/score pipeline runs).

## Validation hooks to inspect during fix

- The turn log's `composition` block: a candidate's score breakdown should expose `completionBoost: number` and `fullWinCost: number` fields per candidate (extend the existing diagnostic emit).
- `gamePhase` (or sibling) in the turn log: should reflect the late-phase classification at T76 in the replay fixture, surfaced from `classifyGamePhase`, not just from `NetworkContext.computePhase`.
- The planner's reasoning string: include the boost annotation when active — e.g. `"Picked: triple-3fresh — payout 89M, build 22M, 16 turns, NET 67M (+2.0 win-completion boost; projected cash $294M − $30M city-track ≥ $280M full win cost)"`.
- `Discarded by prune` log line: post-fix, should report the carve-out — `"Discarded by prune: 831 (turns > 12, 0 win-completing kept)"` or similar.

## Not in scope

- Replacing `aggregateScore` with a multi-objective scorer. The flat-boost approach preserves the current rank key.
- Re-tuning `PRUNE_MAX_TURNS = 12` globally. Layer A is a targeted carve-out for win-completers, not a blanket increase.
- LLM-path scoring. The deterministic planner is what ran here (`[deterministic-top-1]` in the reasoning). Whether the LLM-path needs the same fix is a separate question.
- Cash-side win-completion **without** a fresh route — e.g. "the bot is at $245M; should it pivot to whatever shortest delivery closes the last $5M?" That's a different bug (post-delivery replan ordering, sibling of JIRA-252).
- Refining the `estimateTrackCostToCity` Dijkstra heuristic. We use it as-is; if its estimates drift from actual build cost, that's a separate bug in `NetworkContext`.

## Relationship to existing JIRAs

- **JIRA-229** introduced `aggregateScore`. Layer B extends it with a phase-gated additive term.
- **JIRA-242** added a flat additive bonus on `aggregateScore` for multi-delivery candidates — proves the additive-bonus pattern works without distorting other rank cases. Reuse the pattern.
- **JIRA-253** narrowed the A3 partial-path abandon predicate. With 253 in place, multi-turn builds for big-NET routes are no longer abandoned — so the planner can actually execute the boost-promoted candidate.
- **JIRA-252** addresses post-delivery replan ordering. Different timing concern; both bugs waste turns at the cash-completion margin.
- **`PRUNE_MAX_TURNS` (JIRA-237 background, line 78)** is a velocity-only filter. Layer A is its first phase-aware carve-out.
