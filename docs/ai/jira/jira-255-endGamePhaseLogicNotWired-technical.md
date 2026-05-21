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

### 3. `aggregateScore` is pure income velocity

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

There is no awareness of "this candidate's NET, added to current cash, crosses the win-condition cash threshold." A candidate that takes cash to $259M (over $250M) ranks identically to one that takes cash to $400M, and ranks **below** a faster-per-turn candidate that takes cash only to $245M.

## Fix shape

Two layers; **layer A is the main fix**, layer B is the diagnostic hook.

### Layer A — Cash-completion boost on `aggregateScore`

When the bot is in a "cash near win threshold" state, add a flat additive boost to `aggregateScore` for any candidate whose `currentCash + candidate.net >= CASH_WIN_THRESHOLD_M`. The boost should be large enough to overcome a typical M/turn gap (~0.5–1.0 M/turn) between a high-velocity short route and a moderate-velocity completing route, but bounded so that it cannot promote a wildly worse candidate purely on closing the gap.

Concrete shape:

```ts
// In DeterministicTripPlanner (or a new helper, e.g. winCompletionBoost.ts):

const CASH_WIN_THRESHOLD_M = 250;
const CASH_NEAR_THRESHOLD_WINDOW_M = 60; // ≈ a typical large-pair NET
const COMPLETION_BOOST_M_PER_TURN = 1.5; // additive boost on aggregateScore

function cashCompletionBoost(
  currentCash: number,
  candidateNet: number,
): number {
  // Dormant when cash is not near threshold.
  if (currentCash < CASH_WIN_THRESHOLD_M - CASH_NEAR_THRESHOLD_WINDOW_M) return 0;
  // Only fires when this candidate alone closes the gap.
  if (currentCash + candidateNet < CASH_WIN_THRESHOLD_M) return 0;
  return COMPLETION_BOOST_M_PER_TURN;
}
```

Apply where `aggregateScore` is set — both the no-followup path (`scoreCandidate` ≈ line 1086) and the chained path (`computeAggregateScore` ≈ lines 1182–1184). Mutate `aggregateScore` in place after the velocity calculation, before the rank-sort.

The boost is **flat** (M/turn-scaled), not multiplicative — matches the JIRA-242 precedent of a flat additive bonus on `aggregateScore`. Magnitude tuned so a $32M-NET completer beats a $18M-NET non-completer by 0.5–1 M/turn margin (the typical "lost by 0.50 / 0.67" gaps observed in the T76 reasoning).

Why a flat boost rather than a multiplicative or threshold-based reranking:
- Multiplicative scaling on a velocity figure distorts mid-game cases when one candidate happens to land in the window.
- Threshold reranking ("all completers above all non-completers") could promote a strictly worse candidate (e.g. NET +$1M just-barely-completing at 30 turns over NET $40M-non-completing-but-velocity-3.0).
- Flat additive boost matches existing aggregate-bonus pattern and is easy to tune.

### Layer B — Surface phase + cash-proximity in the trace

The behavioral file's AC4 needs an observable change in `gamePhase` or a sibling field. Two options:

**B1 (lighter touch).** Extend `NetworkContext.computePhase` to add `"Late Game (Cash Near Threshold)"` or a separate `cashNearThreshold: boolean` field on the context, returned alongside `gamePhase`. Log it via `appendTurn` (extend `GameTurnLogEntry` if needed).

**B2 (preferred — also fixes the dead `classifyGamePhase`).** Wire `classifyGamePhase` from `DeterministicTripPlanner.ts:68` into the planner's scoring step. Pass `(turn, deliveries, citiesConnected)` into `scoreCandidate`. Use the phase value in the cash-completion boost so the boost is gated by phase as well as by the cash window — e.g., the boost only fires when `phase === 'late'` AND `currentCash + candidate.net >= CASH_WIN_THRESHOLD_M`. This kills two birds: the dead classifier is now wired, and the boost is bounded to its intended phase.

Recommended: B2.

## Acceptance from behavioral

- **AC1** Unit test on `scoreCandidate`: fixture `currentCash = 227`, candidate A `{ net: 18, turns: 6 }`, candidate B `{ net: 32, turns: 13 }`. With layer A: assert `B.aggregateScore > A.aggregateScore`. Without layer A (baseline), A wins.
- **AC2** Unit test on `scoreCandidate`: fixture `currentCash = 80`, same candidates. Assert: A wins (boost dormant outside window).
- **AC3** Unit test: two candidates both completing (`(cash + net) ≥ 250`), differing by net margin and turn count. Assert: both receive the boost; among completers, the velocity formula still determines order — boost is flat, not winner-takes-all.
- **AC4** Test on `computePhase` (B1) OR `classifyGamePhase` wired into planner (B2): fixture `cash = 227, cmc = 3, deliveries = 8, turn = 76`. Assert: phase surface (whichever was extended) reports a cash-near-threshold signal that the scorer reads. Bot's chosen candidate at this fixture is the completing one.
- **AC5** Game-replay regression on Sonnet T76 snapshot from game `6033c903`. Assert: top-1 chosen candidate has `currentCash + net ≥ 250`. The single-Potatoes-Lodz candidate is no longer top-1 in this snapshot.

## Validation hooks to inspect during fix

- The turn log's `composition` block: a candidate's score breakdown should be visible (existing field, or extend it). After the fix, a non-zero `completionBoost: number` field per candidate is helpful for diagnosis.
- `gamePhase` in the turn log: should flip away from `Mid Game` (or expose a sub-signal) at T76 in the replay fixture.
- The planner's reasoning string: rewrite the picked candidate's rationale to include the boost when active, e.g. *"Picked: pair-fresh+fresh — payout 54M, build 22M, 13 turns, NET 32M (+1.5 cash-completion boost; closes win-cash gap)"*.

## Not in scope

- The city-dimension side of the win condition (`connectedMajorCities < 7`). Cardiff/Munchen/Leipzig are Small/Medium cities and would not add to `cmc`; that's a separate observation tracked elsewhere if it manifests.
- Replacing `aggregateScore` with a multi-objective scorer. The flat-boost approach preserves the current rank key.
- Re-tuning `PRUNE_MAX_TURNS = 12` to keep more long-tail candidates. The pair-Hops-Cardiff is enumerated (visible as chained-sim continuation in T76 reasoning); the prune isn't the blocker.
- LLM-path scoring. The deterministic planner is what ran here (`[deterministic-top-1]` in the reasoning). Whether the LLM-path needs the same fix is a separate question.
- Cash-side win-completion **without** a fresh route — e.g. "the bot is at $245M; should it pivot to whatever shortest delivery closes the last $5M?" That's a different bug (post-delivery replan ordering, sibling of JIRA-252) and may already be covered.

## Relationship to existing JIRAs

- **JIRA-229** introduced `aggregateScore`. Layer A extends it with a phase-aware additive term.
- **JIRA-242** added a flat additive bonus on `aggregateScore` for multi-delivery candidates — proves the additive-bonus pattern works without distorting other rank cases. Reuse the pattern.
- **JIRA-253** narrowed the A3 partial-path abandon predicate. With 253 in place, multi-turn builds for big-NET routes are no longer abandoned — so the planner can actually execute the boost-promoted candidate.
- **JIRA-252** addresses post-delivery replan ordering. Different timing concern; both bugs waste turns at the cash-completion margin.
