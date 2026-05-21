# JIRA-255 — Scorer doesn't prefer routes that close the win-condition cash gap; end-game phase logic is unwired (behavioral)

In game `6033c903-7ab8-40e8-b073-acd82e2e3c9e`, player Sonnet at **T76** completes the previous route (Bauxite→Torino, payment 11M), triggering a replan. Cash is **$227M**, connected major cities = `['Milano', 'Ruhr', 'Wien']` (3 of 7), `victoryCheck.threshold = 250`, `victoryCheck.outcome = 'insufficient-funds'`, `victoryCheck.netWorth = 227`. Bot is **$23M short of the cash side of the win condition**.

Sonnet's hand at T76 includes three Hops-from-Cardiff demand cards (all `trackCostToSupply = 22M` due to one ferry, all `trackCostToDelivery = 0`):

| Card | Demand | Payout |
|------|--------|--------|
| 66   | Hops Cardiff → Munchen | $29M |
| 83   | Hops Cardiff → Leipzig | $25M |
| 120  | Hops Cardiff → Lodz    | $35M |

A pair pickup at Cardiff covering Munchen + Leipzig (the user's framing — $54M combined payout, 22M build → **NET $32M**) closes the cash dimension by itself: `$227M + $32M = $259M`, comfortably over the $250M threshold.

The planner picks instead:

```
[deterministic-top-1] single:120:Potatoes-sup:Lodz chosen.
  Picked: single-fresh — payout 21M, build 3M, 6 turns, NET 18M
  Aggregate: 2.17 M/turn (chained with pair:66-Hops+83-Hops:AB-sup:Cardiff-Cardiff, chained-sim)
  Runner-up #2: pair:120-Potatoes+83-Wine:AB-sup:Lodz-Frankfurt, aggregate 1.67 M/turn, NET 26M, 9 turns. Lost by 0.50.
  Runner-up #3: single:66:Wheat-sup:Lyon, aggregate 1.50 M/turn, NET 11M, 4 turns. Lost by 0.67.
```

Top-1 is the single Potatoes route (NET $18M). Pair-Hops-Cardiff was enumerated — the reasoning even shows it as the **chained-sim follow-up** to single-Potatoes — but it does not appear in the top-3 first-move candidates. Runner-up #2 (pair Potatoes+Wine, NET $26M) also closes the cash gap ($227M + $26M = $253M) and ranks second on `aggregateScore`-M/turn but loses to single-Potatoes by 0.50 M/turn.

The bot executes single-Potatoes:

| Turn | action | cash | activeRoute stop | gamePhase |
|------|--------|------|------------------|-----------|
| T76  | MoveTrain  | 227 | (replan picked Potatoes Lodz→Bern) | Mid Game |
| T77  | BuildTrack | 224 | stop 0/2 (3M build) | Mid Game |
| T78–T80 | MoveTrain | 224 | pickup at Lodz, head to Bern | Mid Game |
| **T81**  | BuildTrack | **239** | Potatoes delivered (+21M), replan: pair Chocolate+Wine NET 48M | Mid Game |
| T82  | BuildTrack | 233 | pair travel | Mid Game |
| T83  | BuildTrack | 226 | (continues) | **Late Game** |

Post-delivery cash at T81 is `224 + 21 = 245` before the next build segment — exactly $5M short of the cash threshold. The replan picks another big pair (NET 48M) **for cash the bot already had a cheaper opportunity to earn**.

The `gamePhase` field is logged as `Mid Game` on every turn from T76 through T82, **even though cash is $3M from the "Victory Imminent" cash threshold of $230M** as defined in `NetworkContext.computePhase`. The phase only flips to `Late Game` at T83 (after Madrid is connected — `cmc` reaches 5). The phase classification gates on `cmc ≥ 5`, not on cash proximity.

The user's framing of the symptom: *"end game phase logic doesn't appear to be working. Sonnet would have won by selecting a double pickup of Hops at Cardiff … when it only needs 5M to win"*. The framing assumes the cash side is the bottleneck — and on the cash side, the bot **had** a single-route opportunity to close the gap and chose the route with higher per-turn velocity instead.

## Source

`logs/game-6033c903-7ab8-40e8-b073-acd82e2e3c9e.ndjson`, player Sonnet, T76–T83. Top-1 reasoning string from T76 entry shows the ranking and the chained-sim continuation.

## Observed scorer behaviour

`aggregateScore` is income velocity (`net / turns`), optionally chained with a follow-up trip. With cash at $227M and the win threshold at $250M:

- Single Potatoes-Lodz: NET $18M, 6 turns → 3.0 M/turn standalone, 2.17 chained. **Leaves bot at $245M** (still short).
- Pair Potatoes+Wine: NET $26M, 9 turns → 2.89 M/turn standalone, 1.67 chained. **Closes cash gap to $253M.**
- Pair Hops-Hops Cardiff (user's pick): NET $32M, ~13 turns → ~2.46 M/turn standalone. **Closes cash gap to $259M.**

The scorer ranks by velocity; the route that closes the cash gap in a single delivery is not preferred. The bot was indifferent to the "this completes the cash side of the win condition" property, so it took a longer path through 2 sequential routes to the same end-cash.

## Expected behavior

When the bot's current cash is within range of the cash side of the win condition (e.g., within 1× a typical large-pair payout, say $60M), the planner should preferentially rank candidates whose NET — added to current cash — meets or exceeds the win-condition cash threshold. Velocity remains the rank key in other phases. The boost only applies when "this route alone closes the cash dimension."

What must NOT happen:
- Bot at $227M cash with a candidate that NETs $32M (taking it to $259M, over threshold) ranks below a $18M-NET candidate solely because of M/turn aggregate.
- `gamePhase` stays `Mid Game` for the entire stretch where cash is $0–$20M short of the threshold.
- Bot needs two sequential routes to close a cash gap that one route would have closed.

Not in scope here (but related): the city dimension of the win condition (`connectedMajorCities` 3/7 at T76 — Cardiff is a Small City; Munchen is Medium; Leipzig is Small; none add to `cmc`). The user's "needs 5M to win" framing is cash-only; this ticket follows that framing. The major-city-dimension scoring may need its own treatment but is a separate observation.

## Acceptance

- **AC1 — Cash-completion boost** Fixture: bot cash $227M, win threshold $250M, candidate A (NET $18M, 6 turns), candidate B (NET $32M, 13 turns). Assert: B ranks above A. Without the boost, A would win on M/turn.
- **AC2 — Boost does not distort mid-game ranking.** Fixture: bot cash $80M, win threshold $250M, same two candidates. Assert: A still ranks above B (boost is dormant when cash is not near threshold).
- **AC3 — Boost magnitude is bounded by completion margin.** Fixture: candidate that overshoots threshold by $1M vs candidate that overshoots by $30M. Both should rank above non-completing candidates; the larger-margin completion can rank higher among completers, but neither should win against a completer-with-much-higher-velocity in cases where velocity dominates safely.
- **AC4 — Phase logging reflects cash-near-threshold.** Fixture: bot at cash $227M, `cmc=3`. Assert: `gamePhase` exposes a state that signals "cash approaching threshold" — either a new phase label or a sub-flag visible in the log alongside `gamePhase`. Bot's behaviour, not just the label, must change.
- **AC5 — Game replay regression.** Replay Sonnet T76 snapshot from game `6033c903`. Assert: top-1 selection contains a route whose `(currentCash + net) ≥ 250M`. The bot does not pick a route that leaves cash exactly $5M short when a closer-of-the-gap candidate exists.

## Relationship to existing JIRAs

- **JIRA-229** introduced `aggregateScore` (chained two-trip income velocity). The velocity formula is fine for mid-game; it's the missing late-game cash-completion boost on top of it.
- **JIRA-242** added a flat additive bonus for multi-delivery candidates — proves the precedent of additive bonuses on `aggregateScore`. JIRA-255 is a sibling additive bonus tied to win-condition proximity.
- **JIRA-253/252** were also "scorer/executor mishandles a near-decision" bugs — sequential-route waste at high cash, like 255, is in the same family.
