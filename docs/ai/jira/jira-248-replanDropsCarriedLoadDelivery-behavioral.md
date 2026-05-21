# JIRA-248 — Replan drops the delivery stop for a load the bot is still carrying (behavioral)

In game `75c6afc8-8d99-49b0-b878-e5e19512478d`, player Sonnet (Medium skill) carries a Labor load whose only matching demand card is `Labor → Bern`. At T28 the active route's stop list ends with a `deliver(Labor@Bern)` stop, consistent with the carried load. At T29 the trip planner is re-invoked and produces a brand-new route — `pickup(Tourists@Ruhr) → deliver(Tourists@Napoli)` — that **omits the Labor→Bern delivery entirely**. The `Labor → Bern` demand card stays in the hand. The Labor load stays on the train.

The bot then executes this new Tourists trip across multiple turns without ever revisiting the carried Labor delivery. Across T29–T35 the route never re-includes a Bern stop; the user observed the bot physically passing Bern multiple times while still carrying the Labor load.

## Source

`logs/game-75c6afc8-8d99-49b0-b878-e5e19512478d.ndjson`, player Sonnet, T28 → T29 replan boundary.

Second confirming observation: `logs/game-3da56057-cf04-49c0-a194-b43fd0010bd4.ndjson`, player Sonnet, T62 → T64 replan boundary. Different game, different game state, same pattern — see "Second observation" section below.

## Observed trace (Sonnet T28–T32 abbreviated)

| Turn | Action       | Route stops                                                                                                     | Labor→Bern in demands? |
|------|--------------|------------------------------------------------------------------------------------------------------------------|------------------------|
| T28  | MoveTrain    | `pickup(Labor@Beograd), pickup(Wood@Sarajevo), deliver(Wood@Bremen), deliver(Labor@Bern)`                       | Yes (supplyCity=null = carried) |
| T29  | BuildTrack   | `pickup(Tourists@Ruhr), deliver(Tourists@Napoli)`                                                               | Yes (still in hand, still null) |
| T30  | BuildTrack   | `pickup(Tourists@Ruhr), deliver(Tourists@Napoli)`                                                               | Yes |
| T31  | MoveTrain    | `pickup(Tourists@Ruhr), deliver(Tourists@Napoli)`                                                               | Yes |
| T32  | UpgradeTrain | `pickup(Tobacco@Napoli), deliver(Tobacco@Hamburg)`                                                              | Yes |

`supplyCity = null` on a Labor demand means the load is already on the bot's train. The T28 route's `pickup(Labor@Beograd)` step is itself suspect (the load is not at Beograd; the bot is carrying it), but the bigger issue is the T29 replan: a load that is in the bot's possession and has a matching demand card disappears from the route.

## Expected behavior

When the trip planner is re-invoked, any demand card whose load type is already on the bot's train (i.e. `supplyCity = null` for a `loadOnTrain` reason) MUST be considered for inclusion as a `deliver` stop in the new route. The planner may legitimately decide that visiting the delivery city right now is more expensive than the alternative routes — but the decision must be visible in the planner's reasoning, not implicit by omission. Dropping a carried-load delivery silently is never correct: the load occupies a cargo slot, and the demand card stays in the hand, so the bot is paying a strategic cost (reduced capacity + a wasted demand card slot) for an outcome the planner did not consider.

What must NOT happen: the trip planner produces a route that fully ignores carried loads — neither delivering them nor explicitly choosing to defer them. The user observed the bot passing Bern multiple times across T29–T35 with a Labor load still on board.

## Acceptance

- **AC1** — Reproduce a fixture matching T28→T29: bot carrying one Labor load, demand hand contains `Labor → Bern` with `supplyCity = null`, and at least one alternative `pickup(X) → deliver(X)` candidate with higher per-turn score in isolation. Assert: the planner's chosen route either includes a `deliver(Labor@Bern)` stop or its reasoning explicitly cites why deferring Labor delivery beats including it.
- **AC2** — Same fixture, vary alternative count from 1 to 5. Assert: at no fixture configuration does the planner emit a route with zero references to the carried load's delivery city, without a recorded deferral rationale.
- **AC3** — Full-game regression on the Sonnet T28–T35 segment. Assert: across the segment, the bot either delivers the carried Labor → Bern OR drops it at a city (legal in Eurorails). The bot must not retain a carried load across more than N consecutive replans without addressing it (N to be defined; suggest 3).
- **AC4** — The T28 route itself is malformed (`pickup(Labor@Beograd)` for a load the bot already carries). Validate that the planner's grammar / validator rejects a `pickup` stop for a load type the bot is already carrying when the demand's `supplyCity = null`.

## Second observation — game `3da56057`, Sonnet T62-T64

Independent reproduction in a different game with a Heavy/Superfreight bot (capacity 3) and a same-supply pair pickup. Pattern is identical: post-delivery replan drops a still-carried delivery from the new route.

### Observed trace (Sonnet T62–T65, game `3da56057-cf04-49c0-a194-b43fd0010bd4`)

| Turn | Action     | `carriedLoads` | Active route stops                                                                | composition.pickups   | composition.deliveries |
|------|------------|----------------|------------------------------------------------------------------------------------|------------------------|------------------------|
| T62  | MoveTrain  | `["Oil","Oil"]` | `pickup(Oil@Newcastle), pickup(Oil@Newcastle), deliver(Oil@Antwerpen), deliver(Oil@Hamburg)` | **2× Oil@Newcastle** | — |
| T63  | BuildTrack | `["Oil","Oil"]` | (same)                                                                             | —                       | — |
| T64  | MoveTrain  | **`["Oil"]`**  | **`pickup(Machinery@Bremen), deliver(Machinery@Szczecin)`** ← Hamburg dropped     | —                       | Oil@Antwerpen |
| T65  | BuildTrack | `["Oil"]`      | (Machinery route)                                                                  | —                       | — |

The bot correctly picked up both Oil loads at Newcastle at T62 (`composition.pickups` shows two entries). It then delivered one Oil at Antwerpen at T64 (T64 `composition.deliveries: [Oil@Antwerpen]`, `carriedLoads` drops from 2 to 1). The post-delivery replan emitted a brand-new route — `pickup(Machinery@Bremen) → deliver(Machinery@Szczecin)` — that **does not include the still-carried Oil's delivery at Hamburg**. The `Oil → Hamburg` demand card stays in the hand (with `supplyCity = null` confirming the load is treated as carried) but the bot is now executing a route that takes it away from Hamburg toward Bremen.

Net cost (same shape as the original observation): the bot retains one Oil cargo slot indefinitely with a matching demand card it will never service under the current plan, until either the load times out or the planner happens to choose Hamburg in a future replan.

User initially described this as "only picks up one oil" — that was the visible *outcome* (only one Oil ever got delivered), but `carriedLoads` traces show the pickup was correct (two Oils) and the bug is post-delivery on the replan side. Same bug as the T28 → T29 Labor case.

### Why this second trace matters

1. **Train capacity is different** — Superfreight (capacity 3) vs the original observation's lower capacity. Confirms the bug isn't capacity-specific.
2. **Pair pickup** — both demands had `supplyCity = Newcastle`, so the candidate generator must have correctly emitted the same-supply corridor candidate at T61. The bug is NOT in JIRA-250's corridor enumeration (that worked). The bug is the SUBSEQUENT replan after the first delivery.
3. **Fix-branch regression target** — the T62 snapshot should be replayed in a regression fixture in addition to the T28 fixture. Two independent fixtures for the same defect raise confidence that the fix generalizes.

## Not in scope

- The "pickup Labor at Beograd" garbage stop at T28 may be a separate planner bug; address it in this ticket only if the same fix removes it, otherwise file a follow-up.
- Whether the bot should physically *drop* a carried load to free a cargo slot when no demand exists (covered by JIRA-92 cargo conflict evaluation).
- Trip scoring weight tuning (this ticket is about the inclusion guarantee, not the relative score).
