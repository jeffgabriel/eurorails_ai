# JIRA-255 — End-game routing must optimize for fewest turns to victory, not income velocity (behavioral)

## Symptom

In game `6033c903-7ab8-40e8-b073-acd82e2e3c9e`, player Sonnet at **T76** with cash **$227M**, `cmc = ['Milano', 'Ruhr', 'Wien']` (3 of 7), train capacity 3 (Heavy Freight). Hand contains three Hops-from-Cardiff demand cards:

| Card | Demand | Payout |
|------|--------|--------|
| 66   | Hops Cardiff → Munchen | $29M |
| 83   | Hops Cardiff → Leipzig | $25M |
| 120  | Hops Cardiff → Lodz    | $35M |

A triple-pickup at Cardiff delivers all three: payout `$89M`, build `$22M` (one ferry trip), NET `~$67M`. End cash `$227M + $67M = $294M`. After ~$30M of track to connect the 4 remaining major cities: `$264M ≥ $250M`. **This route wins the game.**

Planner picks instead `single Potatoes Lodz → Bern` (NET $18M, 6 turns) on `aggregateScore = 2.17 M/turn`. The triple-Hops candidate is enumerated by `genTriples` but discarded by the `PRUNE_MAX_TURNS = 12` filter (T76 log: `Discarded by prune: 831 (turns > 12)`). Bot ends T81 at $245M — close to cash threshold, nowhere near closing the city-connection budget — then enters another multi-route cycle.

## Win cost

Bot wins by reaching:
- `$250M` cash, AND
- 7 connected major cities — which costs `sum(estimatedCost for cheapest (7 − cmc) unconnected majors)`, retrievable from existing `NetworkContext.computeUnconnectedMajorCities`.

**Full win cost** = `$250M + costToConnectRemainingMajors`.

A candidate is **win-completing** when `(currentCash + candidate.net) ≥ fullWinCost`.

## End-game state lock

When bot cash crosses **$200M**, the planner enters end-game state. The state is **sticky** — it does not unlock if cash dips below $200M from a build. In this state:

1. **Route candidates are filtered to win-completers** (when at least one exists).
2. **Ranking is by fewest turns to victory**, not income velocity.
3. The `PRUNE_MAX_TURNS = 12` filter does not apply to win-completers — a long-turn winning route beats a short-turn non-winning one.

When no win-completer exists in the candidate set, fall through to the normal `aggregateScore` ranking — but the state stays end-game (re-enter the win-completer filter on the next replan).

## Caveat — turn counting is suspect

Triple Hops-Cardiff is currently estimated at ~14-18 turns (and pruned). The actual game time, accounting for Heavy Freight 9 mp/turn movement, one ferry crossing, and the 22M build (over 2 turns with the 20M Phase B cap), looks closer to **9 turns**, not 16. Fixing the turn-count estimator is **out of scope here** — but the discrepancy strengthens the case for the prune carve-out: even if turn counts are inflated, win-completers must not be silently dropped.

## Acceptance

- **AC1** End-game state activates at `cash > $200M` and remains sticky across the rest of the game.
- **AC2** In end-game state, triple-Hops-Cardiff (the only win-completer in the T76 candidate set) survives pruning regardless of estimated turn count.
- **AC3** In end-game state, among win-completers, ranking is by ascending turns. The triple-Hops candidate beats any equally-completing slower alternative.
- **AC4** Outside end-game state, ranking is unchanged (`aggregateScore = net / turns`).
- **AC5** Replay Sonnet T76 snapshot from game `6033c903`: top-1 is the triple-Hops-Cardiff candidate (or another win-completer with fewer turns to victory). Single-Potatoes-Lodz is not top-1.

## Source

`logs/game-6033c903-7ab8-40e8-b073-acd82e2e3c9e.ndjson`, Sonnet T76 entry — reasoning string, demandRanking, victoryCheck, gameState.

## Relationship to existing JIRAs

- **JIRA-229** introduced `aggregateScore` for mid-game velocity ranking. This ticket adds a phase override.
- **JIRA-253** removed an A3 abandon predicate that killed multi-turn builds. With 253 in place, a long-build win-completer can actually execute.
- **JIRA-252** addresses post-delivery replan ordering — sibling timing concern.
