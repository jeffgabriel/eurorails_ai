# JIRA-250 — Planner fails to pick up a second load at the same supply city when two demands share the supply and the corridor (behavioral)

In game `75c6afc8-8d99-49b0-b878-e5e19512478d`, player Sonnet at T45 picks up one Fish load at Oslo for delivery to Zurich. Between T45 and T46 the demand hand turns over and the bot now holds **two** Fish demands: `Fish → Zurich` and `Fish → Milano`. Both demand cards have `supplyCity = null`, indicating the planner treats them as matched to the load already on the train (the single Fish picked up at T45).

The bot has cargo capacity for at least one more load (Freight=2 slots, Heavy Freight/Superfreight=3). Fish is still available at Oslo (the bot just picked one up; the load chip count for Fish is 4 in the standard rules). **Zurich lies geographically on the corridor from Oslo to Milano** — the user's observation matches the map: Oslo → south through central Europe → Zurich → Milano is a natural single-trip path.

At T46, the new route is `pickup(Fish@Oslo) → deliver(Fish@Milano)`. The planner:

1. Did not include a `deliver(Fish@Zurich)` stop — even though the corridor would make it a near-free side delivery.
2. Did not include a second `pickup(Fish@Oslo)` stop — even though the bot is at Oslo (or close), Fish is still available there, and the bot has the slot.
3. Treated both `Fish` demands as if the single carried Fish satisfies both, which it does not — each delivery requires its own load.

The bot follows this single-delivery route across T46–T50 (MoveTrain every turn, no replans). By T51 the route changes to a completely different Wine trip and Fish→Zurich is back in hand with `supplyCity = Oslo` (no longer null), suggesting the Fish→Milano delivery happened around T50→T51 and the Zurich demand reverted to "fresh" — meaning the bot will eventually have to detour back to Oslo for the Zurich Fish in a future trip.

Net cost: the planner missed a free corridor optimization. The bot will need to make a second Oslo trip later for what should have been a single Oslo → Zurich → Milano run.

## Source

`logs/game-75c6afc8-8d99-49b0-b878-e5e19512478d.ndjson`, player Sonnet, T45 → T46 replan boundary.

## Observed trace (Sonnet T43–T52)

| Turn | Action     | Loads picked up    | Route stops                                                            | Fish demands |
|------|------------|---------------------|------------------------------------------------------------------------|--------------|
| T43  | BuildTrack | —                  | `pickup(Tourists@Ruhr), deliver(Tourists@Oslo), pickup(Fish@Oslo), deliver(Fish@Zurich)` | Fish→Zurich/from Oslo |
| T44  | MoveTrain  | —                  | (same)                                                                 | Fish→Zurich/from Oslo |
| T45  | MoveTrain  | **`Fish@Oslo`**    | (empty — route just completed Tourists leg)                            | **Two Fish demands now: Fish→Zurich/null + Fish→Milano/null** |
| T46  | MoveTrain  | —                  | **`pickup(Fish@Oslo), deliver(Fish@Milano)`** — Zurich omitted          | Fish→Zurich/null + Fish→Milano/null |
| T47–50 | MoveTrain | —                  | (same Milano-only route)                                                | (same) |
| T51  | MoveTrain  | —                  | `pickup(Wine@Frankfurt), deliver(Wine@Napoli)` — Fish trip complete    | Fish→Zurich/**from Oslo** (no longer carried — needs detour) |

The smoking gun is the T46 route. The bot is at Oslo (or nearby), carrying one Fish. Two Fish demands sit in the hand. The planner sees both demands but constructs a route that satisfies only one delivery, ignoring the corridor.

## Expected behavior

When the planner is invoked with:
1. ≥1 demand cards of the same load type,
2. The same supply city for both,
3. At least one delivery city on the path between the current position and the other delivery city,
4. Available cargo capacity,
5. Load chips available at the supply city,

…the planner MUST emit a route that picks up the additional load and delivers along the corridor. The trip-planning system prompt already calls this out as rule #1 of TRIP RULES (`COMBINE CORRIDORS: Two deliveries on one route beat two separate routes`, `WORKED EXAMPLE — Cardiff×2 Hops → Holland + Ruhr`). The deterministic candidate generator must enforce the same heuristic in code.

What must NOT happen: a single-delivery route is selected over a two-delivery same-corridor route when the corridor delivery is geometrically free or cheap.

## Acceptance

- **AC1** — Replicate T45/T46 snapshot: bot at Oslo, `loads = ['Fish']`, demand hand contains `Fish → Zurich (supplyCity=null)` and `Fish → Milano (supplyCity=null)`, Fish available at Oslo, capacity ≥ 2 free slots. Invoke trip planner. Assert: returned route includes a stop sequence equivalent to `[pickup(Fish@Oslo), deliver(Fish@Zurich), deliver(Fish@Milano)]` OR provides a per-stop reasoning that explains why the Zurich detour was rejected (e.g. specific build cost > corridor savings).
- **AC2** — Same fixture, but Zurich is NOT on the Oslo→Milano corridor (e.g. swap Zurich for an arbitrary off-path city). Assert: planner is free to choose either single-delivery or two-delivery; no constraint violation.
- **AC3** — Same fixture, but capacity = 1 (Slow Freight). Assert: planner correctly chooses one delivery, with reasoning citing capacity.
- **AC4** — Same fixture, but Fish chip count at Oslo is exhausted (no more Fish available). Assert: planner correctly chooses one delivery and notes the load-chip exhaustion in reasoning.
- **AC5** — Demand-card matching invariant: when two demand cards reference the same load type and the bot carries one matching load, the planner must NOT treat the carried load as satisfying both demands. Each delivery requires its own load chip.

## Not in scope

- Re-tuning corridor detection thresholds (separate ticket if the heuristic needs sharpening).
- Multi-corridor optimization (3+ loads sharing partial paths) — this ticket is about the simpler 2-load case where the second delivery is *on* the first's path.
- The demand-hand turnover that produced the second Fish card at T45 — orthogonal.

## Relationship to JIRA-248

JIRA-248 describes a similar pattern: the planner drops a carried-load delivery from its route. JIRA-250 is a sibling case where the carried Fish satisfies one demand, but a second matching demand card sits in the hand and the planner doesn't trigger the same-supply-corridor pickup. The fix sites likely overlap: both call out the candidate generator's failure to account for available carried loads + matching demands. If JIRA-248's fix correctly enumerates carried-deliverable corridors, this ticket may be partially closed by it. Verify in regression.
