# JIRA-254 — Planner misses a free on-network fresh pickup that shares the delivery city of the current carried-deliver route (behavioral)

In game `6033c903-7ab8-40e8-b073-acd82e2e3c9e`, player Sonnet at T25 has just completed the Copper→Antwerpen leg of a Copper×2 corridor route and is now executing the second leg `deliver(Copper@Torino)`. The bot's `positionEnd: Antwerpen`; the route's only remaining stop is the Torino delivery; the bot is carrying one Copper unit.

Demand hand at T25 includes `Chocolate → Torino (supply Zurich, payout 8M)`. Per the demand ranking entry: `trackCostToSupply: 0, trackCostToDelivery: 0, estimatedTurns: 4, efficiencyPerTurn: 2`. The `trackCostToSupply: 0` confirms Zurich is on the bot's existing network (verified separately — Zurich appears in `citiesOnNetwork` for this game alongside Torino, Frankfurt, Antwerpen, Ruhr).

The route at T25, however, is `[deliver(Copper@Torino)]` — single carried-delivery, no Chocolate pickup added. The user reports the Chocolate detour to Zurich is ~4 mileposts (~1/3 of a turn at Freight speed), and the payout would be +8M. The planner's reasoning at T23 (when the original Copper pair-shared was selected) and T25 (when replan to the single-deliver-only route fires post-Antwerpen-delivery) annotates these candidates as `Aggregate: X.X M/turn (standalone — no feasible follow-up)`. The user's intuition: the "standalone" tag is the smell — the bot is *currently going* to Torino, so a "free" on-network fresh pickup with delivery at Torino is not really standalone.

## Source

`logs/game-6033c903-7ab8-40e8-b073-acd82e2e3c9e.ndjson`, player Sonnet, T23-T25.

## Observed trace

| Turn | action | route stops | Chocolate demand visible? | top-3 demand ranking (effPerTurn) |
|------|--------|-------------|---------------------------|-----------------------------------|
| T23  | MoveTrain | `pickup(Copper@Wroclaw), pickup(Copper@Wroclaw), deliver(Copper@Antwerpen), deliver(Copper@Torino)` | Yes, `Chocolate→Torino` payout 8, supply Zurich | Copper→Antwerpen (6.3), Copper→Torino (6), Chocolate→Torino (1.6) |
| T24  | MoveTrain | (same) | Yes (same) | Copper→Torino (8), Copper→Antwerpen (6.3), Chocolate→Torino (2) |
| T25  | MoveTrain | **`deliver(Copper@Torino)`** ← single-stop, no Chocolate | Yes (same) | Copper→Torino (8), Chocolate→Torino (2), Copper→Milano (1.9) |

Notable demand-ranking facts at T25:
- `Chocolate→Torino`: `trackCostToSupply: 0, trackCostToDelivery: 0, estimatedTurns: 4, payout: 8` — pickup at Zurich is free (on-network), delivery to Torino is free (on-network)
- `Copper→Torino` (the carried one): `trackCostToSupply: 0 (carried), trackCostToDelivery: 0, estimatedTurns: 3, payout: 24` — pure carry-deliver

A "corridor-add" candidate `[pickup(Chocolate@Zurich), deliver(Copper@Torino), deliver(Chocolate@Torino)]` would:
- Cost the same in build (0M — both Zurich and Torino on network)
- Take ~4 mileposts more in movement (1/3 of a Freight turn)
- Yield +8M payout on top of the carried Copper's 24M = 32M total
- Run in roughly the same 3-4 turn window as Copper-only

The planner doesn't enumerate this candidate. The Copper-only carry-deliver wins by default because no comparable corridor-add candidate exists in the candidate set.

## The user's hypothesis (verbatim)

> "i think it is bc the single is scored in isolation (stand-alone, no feasible follow-up) which is stupid - there is ALWAYS a next delivery. and in this case the chocolate would have been 8M payout for 4mp (1/3 of a turn!)"

This is the right diagnosis at the high level. The planner's `computeAggregateScore` looks for a follow-up *trip* after the primary trip completes. When no follow-up trip qualifies (per the existing feasibility heuristic), the primary is scored standalone. But this misses the case where a single-stop trip should be **augmented** by an on-corridor fresh pickup that shares the destination — that's a route extension, not a follow-up.

## Expected behavior

When the planner enumerates candidates for a turn where the bot has a carried-deliver demand `(LoadA, CityX)`, the enumeration should also produce candidates that **add** a fresh on-network pickup for any other demand `(LoadB, CityX)` whose supply city is on the bot's network. Specifically:

- For every carried-deliver demand `D_carry = (loadA, deliveryCity_X)`,
- For every fresh demand `D_fresh = (loadB, deliveryCity_X)` where `loadB != loadA`, `supplyCity_Y is on network`, and the bot has cargo capacity,
- Enumerate the candidate: `[pickup(loadB@Y), deliver(loadA@X), deliver(loadB@X)]` (or with delivery order chosen by network distance from current position).
- Score this candidate normally; it will typically outrank carry-only because the build cost is the same (0) and the additional payout dominates the small movement detour.

This is symmetric to JIRA-250's same-supply enumeration (same load + same supply → multi-pickup), but for the orthogonal case (different load + same delivery + on-network supply → add-on pickup).

## Acceptance

- **AC1** — Replicate T25 snapshot: bot at Antwerpen, carrying 1 Copper, demand hand has `Copper→Torino (carried)` and `Chocolate→Torino (supply Zurich, on network)`. Capacity ≥ 2. Invoke `planTripDeterministic`. Assert: the candidate set contains a candidate of shape `[pickup(Chocolate@Zurich), deliver(Copper@Torino), deliver(Chocolate@Torino)]` (or equivalent delivery ordering).
- **AC2** — Same fixture. Assert: the top-1 chosen candidate is the corridor-add (not the carry-only Copper-only), because the corridor-add's aggregate score exceeds carry-only's (same build cost, +8M payout, small movement detour).
- **AC3** — Negative case: same fixture but Zurich is NOT on the bot's network. Assert: the corridor-add candidate is still enumerated, but it must include a non-zero `trackCostToSupply`. The scorer can then weigh build cost vs payout normally; carry-only may win.
- **AC4** — Negative case: same fixture but Chocolate→Torino's delivery city differs from the carried Copper's delivery. Assert: no corridor-add candidate is enumerated (the corridor must share the delivery city).
- **AC5** — Capacity gate: same fixture but bot is at full capacity (carrying 2 Copper in Freight). Assert: the corridor-add candidate is NOT enumerated (no slot for Chocolate).
- **AC6** — Replay Sonnet T23-T25 of game `6033c903` as an integration fixture. Assert: at T23 (when the original Copper pair-shared was selected), the corridor-add candidate including Chocolate is in the candidate set. The planner may still pick the Copper-pair if scoring favors it, but the Chocolate add-on must be a tracked option in `CompositionTrace.candidates` (or equivalent).

## Not in scope

- Generalized "always assume a next delivery" extension to candidate scoring (the user's broader instinct). That's a bigger ranking-policy change; this ticket scopes the fix to the specific enumeration gap: same-delivery + on-network-fresh-supply corridor-add.
- LLM-path candidate selection (Hard skill). The prompt already encourages "COMBINE CORRIDORS: Two deliveries on one route beat two separate routes" — verify if the LLM path correctly handles this case; if yes, JIRA-254 only fixes the deterministic Medium-skill path.
- Multi-delivery-city corridors (`A → X → Y → Z`). The fix is specifically for same-delivery-city add-ons; broader N-stop corridor optimization is a separate ticket.

## Relationship to existing JIRAs

- **JIRA-248** (`enumerateCarriedDeliveryFloor`) guarantees the carry-only candidate exists as a floor. JIRA-254 builds on that by ensuring an *augmented* carry-only candidate also exists when a free on-network fresh pickup shares the delivery city.
- **JIRA-250** (`enumerateSameSupplyCorridorCandidates`) handles same-supply same-load multi-pickup. JIRA-254 handles same-delivery different-load add-on pickup. Sibling enumeration rules.
- **JIRA-253** (carry-deliver-partial abandon livelock) is orthogonal — different executor concern; once 253 lands, 254 still needs separate enumeration logic.
- **JIRA-242** (multi-delivery expansion bonus) might already provide a scoring nudge for multi-stop routes; verify whether it covers this case during implementation.

## User-facing impact estimate

Losing 8M per missed corridor-add. The bot has 9 demand cards in the hand at any time; in a typical late-game state where 1-2 carried-deliver demands have on-network fresh-pickup companions, this pattern fires multiple times per game. Realistic per-game income lift: 20-50M over a 60-turn game, possibly more on Heavy/Superfreight bots with extra capacity.
