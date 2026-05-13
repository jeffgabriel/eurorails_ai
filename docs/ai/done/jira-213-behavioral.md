# JIRA-213 — Initial-build supply city ranks on build cost only, ignoring round-trip turn cost

## Game evidence

- Game: `c6a99a57-9e0f-4b25-89cb-92013befb218`
- Log: `logs/game-c6a99a57-9e0f-4b25-89cb-92013befb218.ndjson`
- Bot: Nano (turn 2 — Nano's first build turn of the initial build phase)

## What happened

On turn 2, Nano holds a Cheese → Berlin demand card (payout 10M). The on-screen `demandRanking` overlay (built from `DemandEngine.scoreDemand`) shows **Cheese from Holland → Berlin** as rank #1 with `efficiencyPerTurn: -2.25`, `estimatedTurns: 4`, `trackCostToDelivery: 19`.

The actual planner output (`initialBuildOptions` in the NDJSON) ranks the same demand differently:

| rank | supply | starting | totalBuildCost | estimatedTurns | efficiency |
|------|--------|----------|----------------|----------------|------------|
| 1 | **Arhus** | Berlin | **16** | **5** | 0.96 |
| 2 | Holland | Holland | 19 | 4 | 0.91 |
| 3 | Kobenhavn | Berlin | 21 | 5 | 0.88 |

Nano commits to rank #1: starting city Berlin, build a 14-segment / 16M path Berlin → Arhus, plan to round-trip Berlin → Arhus → Berlin to fulfill the delivery.

## What we wanted

The Holland option is one-way: Nano starts at Holland (the supply), builds Holland → Berlin (19M, ~13 hex), picks up cheese and delivers it on a single forward trip. The Arhus option is a round trip: Nano starts at Berlin (the delivery), builds Berlin → Arhus (16M, 11 hex), then must travel Berlin → Arhus to pick up and Arhus → Berlin to deliver — round-trip movement, ~22 hex.

The expected ranking is Holland #1, Arhus #2 — Holland reaches the first delivery one turn sooner, which under the bot's North Star (income velocity matters more than payout size) is the better opening.

## Two compounding miscounts

The planner reports `estimatedTurns: 4` for Holland and `estimatedTurns: 5` for Arhus. Both numbers are inflated, and the inflation flattens what should be a sharper ranking signal:

- **Holland's true movement-turn count is 2, not 4.** At 13 hex distance and freight speed 9, the train picks up at Holland on its first post-build turn, moves 9 mileposts, and arrives at Berlin to deliver on the second. Two movement turns from operational start.
- **Arhus's true movement-turn count is 3, not 5.** Round-trip 22 hex at speed 9 = `ceil(22/9) = 3` movement turns (pickups, deliveries, and mid-turn direction reversal at Arhus are all free under the rules).

So the real comparison is Holland 2 vs Arhus 3 — a 50% turn premium for the cheaper-build option, not the 25% the planner currently shows. Either way, Holland delivers sooner and should rank first.

## Player-visible impact

Nano's first delivery arrives one turn later than it would have under a turn-aware ranking. In a long game that compounds — every wasted opening turn is a turn the opponent uses for their own first delivery and reinvestment. Additionally, the divergence between what the debug overlay reports as the "ranked" supply city (Holland) and what the planner actually executes (Arhus) makes the system's behaviour confusing to inspect.

## Scope

Single observation in a single game (`c6a99a57-9e0f-4b25-89cb-92013befb218`), turn 2, Nano's Cheese → Berlin opening. Not generalising to other demands, other bots, or other games. The pattern of "cheaper supply with higher round-trip turn count beats one-way supply" is plausibly a general issue in the scoring formula, but this report is anchored only on the observed turn.

## Also in scope — exclude remote cities as supply during initial build

The planner currently treats `REMOTE_DELIVERY_CITIES` (`Nantes, Bordeaux, Bilbao, Porto, Lisboa, Madrid, Roma, Napoli, Kobenhavn, Arhus, Goteborg, Oslo, Stockholm`) as ineligible **delivery** targets during initial build, because reaching them requires overextended track. The same logic applies in reverse: pulling a load *from* one of these remote cities also requires the bot to extend track into outlying terrain to reach the supply, which costs build budget and travel turns.

For game `c6a99a57`, the Arhus supply is exactly this case: Nano builds a 14-segment / 16M spur from Berlin out to Arhus solely to pick up cheese. The fact that Arhus is on this remote-cities list as a *delivery* city, but is freely chosen as a *supply* city, is an inconsistency in the policy. The intent of the list — "don't overextend during initial build" — applies to both ends of a route.

The expected behaviour is: during initial build, a city listed in `REMOTE_DELIVERY_CITIES` should be filtered out as both supply and delivery. This applies uniformly to all 13 cities in the set, not just Arhus.

## Out of scope

- The `demandRanking` overlay's own scoring formula in `DemandEngine.scoreDemand`. Its output (Holland #1) appears correct for this case; the disagreement comes from the planner re-scaling its score with a cost-only factor.
- Per-pair starting-city selection (`expandDemandOptions` line 286) — that inner loop already prefers fewer turns, then lower cost, and is consistent with what we want.
- The double-delivery pairing pipeline (`computeDoubleDeliveryPairings`). For this turn the planner returned a single-delivery plan; pairings were not the chosen branch.
- Fast-path / emergency-fallback ranking — those use a different formula and are unrelated to this ranking call.
- The `estimatedTurns` formula in the *pairing* (double-delivery) and *emergency-fallback* paths. Same shape, but those branches did not fire for this turn.
- Applying the remote-city filter outside the initial-build phase. Mid-game and late-game routing has different economics (track may already extend into peripheral regions; deliveries to remote cities may be the right play). The filter belongs to the initial-build planner only, where it lives today.
- Reviewing the membership of the remote-cities set itself. The thirteen cities currently listed are taken as given; this scope is about applying the existing list symmetrically to supply, not redefining "remote".
