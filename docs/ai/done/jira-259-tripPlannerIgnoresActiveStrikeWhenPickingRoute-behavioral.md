# JIRA-259 — Trip planner picks routes whose first delivery is at a coastal-Strike-blocked city, leading the bot to execute into the wall (behavioral)

In game `182bfd36-3d3d-46ef-9c1d-0c87373b983f`, with a Coastal Strike active and London + Antwerpen in the restricted set, the deterministic trip planner ranked routes whose first stop is a delivery at one of those blocked cities as the top candidate for the affected players. The bot then executed the route, which the game-rule layer rejected; on the next turn the planner picked the same restricted route again. The trip planner is consulting `snapshot.activeEffects` correctly inside the movement and build planners (via the BE-005 wiring), but its candidate-enumeration / ranking step apparently does not filter or down-rank candidates that lead with a delivery at a city in the active pickup/delivery restriction set.

## Source

`logs/game-182bfd36-3d3d-46ef-9c1d-0c87373b983f.ndjson`, players s1 (turn 31 — picked `pair:110-Cars+102-Copper:delAfirst-sup:null-Beograd` whose stop 1 is "deliver Cars at Antwerpen"; the player was already at Antwerpen and the Strike was active).

Excerpt from the s1 T31 reasoning field:

```
[route-planned] [deterministic-top-1] pair:110-Cars+102-Copper:delAfirst-sup:null-Beograd chosen.
  Picked: pair-carry+fresh — payout 31M, build 10M, 11 turns, NET 21M
  Aggregate: 1.96 M/turn (standalone — no feasible follow-up)
  Stops: 1) deliver Cars at Antwerpen; 2) pickup Copper at Beograd; 3) deliver Copper at Bruxelles
  …
  Candidates: raw=780 survivors=69 enumerationMs=5239
```

The same route was re-picked on T32 after the first execution failed. The planner is choosing a route whose first stop is rejected by the active Strike, with no awareness that the stop is blocked.

## Observed contrast

- The movement planner (`MovementPhasePlanner.ts:168`) reads `snapshot.activeEffects` and consults `pickupDeliveryRestrictions` when generating movement candidates → it correctly avoids moving the train to a Strike-blocked city.
- The build planner (`BuildPhasePlanner.ts:179`) reads `snapshot.activeEffects` for Flood-rebuild gating → it correctly avoids building over rebuildable-flood segments.
- The deterministic **trip planner** (the layer above the movement / build planners) does not appear to consult `pickupDeliveryRestrictions` when enumerating or ranking candidate routes — so it picks routes whose first stop is a deliver at a blocked city, even when the bot is positioned right there and the Strike is active.

## Expected behavior

When the deterministic trip planner enumerates candidate routes for a turn where `snapshot.activeEffects` contains pickup/delivery restrictions, it should drop or heavily down-rank any candidate whose first stop is a pickup or delivery at a city in the restricted set. The planner can keep routes whose later stops touch restricted cities — Strikes typically expire within 1-2 turns, so a 5-turn route ending at a currently-blocked city may be fine if the Strike clears before the bot arrives — but the immediate-next stop must be feasible.

A minimal safe behavior: filter the candidate set to drop any route whose `stops[0]` is a `pickup` or `deliver` at a city in the active pickup/delivery restriction set. If the filter empties the candidate set, fall back to the existing "no feasible route" path (which the bot already handles by passing the turn or discarding the hand).

## Acceptance

- **AC1** — Replicate s1 T31 snapshot: bot at Antwerpen carrying Cars, demand hand has `Cars→Antwerpen` and `Copper@Beograd→Bruxelles`, `snapshot.activeEffects` has a `CoastalStrike` listing Antwerpen as a restricted city. Invoke `planTripDeterministic`. Assert: the chosen route is NOT a route whose stop 0 is `deliver Cars at Antwerpen`. (It may be a "no feasible route" outcome, or it may be a different route picking up Copper first — either is acceptable.)
- **AC2** — Same fixture but no Strike. Assert: the `pair:110-Cars+102-Copper:delAfirst-sup:null-Beograd` route IS selected as top-1 (regression guard — the filter must not over-suppress).
- **AC3** — Bot at Antwerpen, Strike active, the ONLY route candidate the planner can build leads with the blocked delivery. Assert: the planner returns "no feasible route" and the bot falls through to whatever the no-route path does (likely a PassTurn or DiscardHand depending on hand state). The bot should NOT pick the blocked route.
- **AC4** — Stop 0 is fine (e.g., a pickup at Beograd which is not blocked), but a LATER stop touches a Strike-blocked city. Assert: the route IS selected. The planner only filters on stop 0; later stops are deferred to the per-turn re-evaluation (the Strike likely expires by the time the bot reaches the later stop).
- **AC5** — Integration: replay s1 T31 of game `182bfd36-3d3d-46ef-9c1d-0c87373b983f`. Assert: the chosen route's stops[0] is NOT a `deliver` or `pickup` at Antwerpen.

## Not in scope

- LLM-path candidate selection (Hard skill). If the LLM trip planner ignores active effects too, file a separate follow-up; this ticket scopes to the deterministic path because that's what fired in the observed game.
- Down-ranking (vs. hard filtering) of candidates whose LATER stops touch blocked cities. Strikes have short durations; modeling expiration into ranking is a separate optimization ticket.
- Movement-blocked or build-blocked candidate filtering. Those are already handled by the movement / build planners' per-turn logic; the trip planner doesn't need to duplicate them.
- Lost-turn pre-emption affecting the trip planner. The BE-005 lost-turn pre-emption is at the strategy-engine level (AIStrategyEngine.ts:215-218); the trip planner doesn't need to consult it.

## User-facing impact

Per Strike-active turn where the bot's top-ranked route leads with a blocked stop: one wasted turn (LLM picks the route, executor rejects it, guardrail loop until expiry — see also JIRA-257 for the guardrail's contribution to the same loop). Compounding with JIRA-257, the bot can lose 3+ consecutive turns to this pattern per Strike. The fix here prevents the planner from generating the bad route in the first place, which (combined with JIRA-257) makes the bot legally pass or pivot during Strikes.

## Relationship to existing JIRAs

- **JIRA-256 / BE-005**: BE-005 integrated `restrictionPredicates` into `MovementPhasePlanner` and `BuildPhasePlanner`, plus `routeHelpers.ts`. But it didn't update the deterministic trip planner's candidate enumeration / ranking. That's the residual gap this ticket fills.
- **JIRA-257**: closely related — the guardrail bypass and the trip-planner-ignores-strikes are two layers of the same failure mode. Either fix on its own helps; together they fully prevent the wasted-turn loop.
- **JIRA-251** (bot blind to active rail strike): predecessor concern that JIRA-256 was meant to address; this ticket plugs the trip-planner-layer hole.
