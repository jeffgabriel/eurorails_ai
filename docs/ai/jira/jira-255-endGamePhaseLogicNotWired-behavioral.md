# JIRA-255 — Scorer doesn't prefer routes that close the win-condition cash gap; end-game phase logic is unwired (behavioral)

In game `6033c903-7ab8-40e8-b073-acd82e2e3c9e`, player Sonnet at **T76** completes the previous route (Bauxite→Torino, payment 11M), triggering a replan. Cash is **$227M**, connected major cities = `['Milano', 'Ruhr', 'Wien']` (3 of 7), `victoryCheck.threshold = 250`, `victoryCheck.outcome = 'insufficient-funds'`, `victoryCheck.netWorth = 227`. Train capacity = 3 (Sonnet upgraded to Heavy Freight at T10). Bot still needs **4 more major cities + $23M cash** to win — the full win cost is `$250M + cost-to-connect-4-majors ≈ $280M` (the user estimates ~$30M of additional track to reach the 4 cheapest unconnected majors).

Sonnet's hand at T76 includes **three Hops-from-Cardiff demand cards** (all `trackCostToSupply = 22M` due to one ferry, all `trackCostToDelivery = 0`), one per physical demand card in hand:

| Card | Demand | Payout |
|------|--------|--------|
| 66   | Hops Cardiff → Munchen | $29M |
| 83   | Hops Cardiff → Leipzig | $25M |
| 120  | Hops Cardiff → Lodz    | $35M |

Since train capacity = 3, the bot can pick up **all three** Hops at Cardiff in a single visit and deliver them across Munchen / Leipzig / Lodz. Triple-Hops-Cardiff math: payout `$35 + $29 + $25 = $89M`, build `$22M` (one trip to Cardiff via ferry), **NET ≈ $67M**. End-of-route cash: `$227M + $67M = $294M`. After the ~$30M of additional track needed to connect the 4 remaining major cities: `$294M - $30M = $264M` — **clears the $250M cash threshold by $14M, with the major-city dimension funded**. This is the route that wins the game.

A pair pickup (the earlier framing of this ticket — $54M combined Munchen+Leipzig, NET $32M) only reaches `$227M + $32M = $259M`, then `$259M - $30M = $229M` after city-connection track — **doesn't win**. Two of the three Hops aren't enough.

The planner picks instead:

```
[deterministic-top-1] single:120:Potatoes-sup:Lodz chosen.
  Picked: single-fresh — payout 21M, build 3M, 6 turns, NET 18M
  Aggregate: 2.17 M/turn (chained with pair:66-Hops+83-Hops:AB-sup:Cardiff-Cardiff, chained-sim)
  Runner-up #2: pair:120-Potatoes+83-Wine:AB-sup:Lodz-Frankfurt, aggregate 1.67 M/turn, NET 26M, 9 turns. Lost by 0.50.
  Runner-up #3: single:66:Wheat-sup:Lyon, aggregate 1.50 M/turn, NET 11M, 4 turns. Lost by 0.67.
```

Top-1 is the single Potatoes route (NET $18M). Pair-Hops-Cardiff was enumerated — the reasoning even shows it as the **chained-sim follow-up** to single-Potatoes — but it does not appear in the top-3 first-move candidates. Runner-up #2 (pair Potatoes+Wine, NET $26M) ranks second on `aggregateScore`-M/turn but loses to single-Potatoes by 0.50 M/turn.

The **triple-Hops-Cardiff** candidate is enumerated by `genTriples` (DeterministicTripPlanner.ts:552-686, the `3f-ABC` variant — three fresh pickups at Cardiff, three deliveries) but is almost certainly inside the **`Discarded by prune: 831 (turns > 12)`** bucket reported in the T76 reasoning. Three pickups + three deliveries with a ~22M build to Cardiff is ~14-18 turns, well past the `PRUNE_MAX_TURNS = 12` cap. The win-completing candidate is filtered out before scoring even runs.

The bot executes single-Potatoes:

| Turn | action | cash | activeRoute stop | gamePhase |
|------|--------|------|------------------|-----------|
| T76  | MoveTrain  | 227 | (replan picked Potatoes Lodz→Bern) | Mid Game |
| T77  | BuildTrack | 224 | stop 0/2 (3M build) | Mid Game |
| T78–T80 | MoveTrain | 224 | pickup at Lodz, head to Bern | Mid Game |
| **T81**  | BuildTrack | **239** | Potatoes delivered (+21M), replan: pair Chocolate+Wine NET 48M | Mid Game |
| T82  | BuildTrack | 233 | pair travel | Mid Game |
| T83  | BuildTrack | 226 | (continues) | **Late Game** |

Post-delivery cash at T81 is `224 + 21 = 245` before the next build segment. The replan picks another big pair (NET 48M) — fully restarting the cash-accumulation loop because the prior route didn't fund the full win cost (cash + city-connection track).

The `gamePhase` field is logged as `Mid Game` on every turn from T76 through T82. The phase only flips to `Late Game` at T83 (after Madrid is connected — `cmc` reaches 5). The phase classification in `NetworkContext.computePhase` gates `Late Game` on `cmc ≥ 5`, not on cash proximity AND not on "cash + city-track-cost is close to the full win budget."

The user's corrected framing of the symptom: *"end game phase logic doesn't appear to be working. The bot needed 3 Hops deliveries (which it conveniently could have done!) — not 2 — to fund the full win including ~$30M of track to connect the remaining major cities."* The bot had the train capacity (3), the supply cards (three Hops Cardiff), and the cash budget. The deterministic planner enumerated all the pieces, then **pruned the only candidate that closes both dimensions** because it took more than 12 turns.

## Source

`logs/game-6033c903-7ab8-40e8-b073-acd82e2e3c9e.ndjson`, player Sonnet, T76–T83. Top-1 reasoning string from T76 entry shows the ranking and the chained-sim continuation.

## Observed scorer + prune behaviour

`aggregateScore` is income velocity (`net / turns`), optionally chained with a follow-up trip. The `PRUNE_MAX_TURNS = 12` filter discards any candidate exceeding 12 estimated turns **before** scoring runs. At T76 with bot cash $227M, win cash threshold $250M, and unconnected-major-cities cost ≈ $30M (full win cost ≈ $280M):

| Candidate | NET | Turns | End cash | End cash − city-track | Wins? | Pruned? |
|-----------|-----|-------|----------|------------------------|-------|---------|
| single Potatoes-Lodz (picked) | $18M | 6 | $245M | $215M | no | no |
| pair Potatoes+Wine | $26M | 9 | $253M | $223M | no | no |
| pair Hops-Hops Cardiff | $32M | ~13 | $259M | $229M | no | maybe |
| **triple Hops-Hops-Hops Cardiff** | **$67M** | **~16** | **$294M** | **$264M** | **yes** | **yes (turns > 12)** |

The only candidate that wins the game is **pruned for taking more than 12 turns**. Among the candidates that survive prune, none completes the full win-cost budget; the scorer correctly ranks the highest-velocity one. The bug is upstream: the prune discards the only winning candidate, and there is no carve-out for "long-turn but win-completing" routes.

## Expected behavior

When the bot's projected end-cash from a candidate, minus the cost of connecting the remaining unconnected major cities, meets or exceeds the cash-win threshold ($250M), the planner should:

1. **Not prune the candidate by `turns > 12`** — keep it in the scoring pool regardless of turn count.
2. **Boost its `aggregateScore`** so it ranks above non-completing candidates that happen to have higher M/turn velocity.

Both layers are needed: a boost on a pruned candidate is useless; surviving prune without a scoring boost still loses to a fast non-completing candidate.

What must NOT happen:
- A win-completing candidate (cash + city-track-budget covered) is discarded by `PRUNE_MAX_TURNS`.
- A non-completing candidate is preferred over a completing one purely on per-turn velocity, when the completer fits the bot's hand and train capacity.
- `gamePhase` stays `Mid Game` for the entire stretch where the bot has a single-route win available.

The user's "needs 5M to win" framing was understated — the win cost is `$250M + estimatedCostToConnectRemainingMajorCities`. The bot needed to fund both dimensions. The triple-Hops route does exactly that.

## Acceptance

- **AC1 — Win-completing candidate survives prune.** Fixture: bot cash $227M, `cmc=3`, capacity 3, three Hops-Cardiff demand cards in hand. Run the candidate enumeration + prune pipeline. Assert: the triple-Hops-Cardiff candidate appears in the post-prune survivors list with `turns > 12`. Without the carve-out, it is in the `Discarded by prune (turns > 12)` bucket.
- **AC2 — Win-completion boost on `aggregateScore`.** Same fixture as AC1. Assert: triple-Hops-Cardiff ranks top-1 ahead of single-Potatoes (NET $18M, 6 turns, M/turn 3.0). Without the boost, single-Potatoes would win on velocity.
- **AC3 — Boost dormant outside the completion window.** Fixture: bot cash $80M, same candidates. Assert: single-Potatoes ranks top-1 (no boost on triple-Hops because it doesn't complete the win from $80M).
- **AC4 — Win-cost includes city-connection track.** Fixture: bot cash $260M, `cmc=3` with ~$30M of unconnected-major-city track ahead. Assert: a candidate that NETs $10M is *not* treated as completing the win — even though `(cash + net) ≥ 250`, the city-track-cost is unfunded. The boost requires `(cash + net) − costToConnectMajors ≥ 250`.
- **AC5 — `gamePhase` exposes a cash-near-full-win-cost signal.** Fixture: bot cash $227M, `cmc=3`. Assert: the log surfaces a state (new phase label OR sibling field) that the scorer reads. Bot's behaviour, not just the label, must change.
- **AC6 — Game replay regression.** Replay Sonnet T76 snapshot from game `6033c903`. Assert: top-1 selection is the triple-Hops-Cardiff candidate (or a route whose `(currentCash + net) − estimatedCostToConnectRemainingMajors ≥ 250M`). Single-Potatoes is no longer top-1.

## Relationship to existing JIRAs

- **JIRA-229** introduced `aggregateScore` (chained two-trip income velocity). The velocity formula is fine for mid-game; it's the missing late-game cash-completion boost on top of it.
- **JIRA-242** added a flat additive bonus for multi-delivery candidates — proves the precedent of additive bonuses on `aggregateScore`. JIRA-255 is a sibling additive bonus tied to win-condition proximity.
- **JIRA-253/252** were also "scorer/executor mishandles a near-decision" bugs — sequential-route waste at high cash, like 255, is in the same family.
