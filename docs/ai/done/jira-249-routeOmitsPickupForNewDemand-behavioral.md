# JIRA-249 — Trip planner emits `deliver(X)` stop without a preceding `pickup(X)` when a new demand card is drawn (behavioral)

In game `75c6afc8-8d99-49b0-b878-e5e19512478d`, player Sonnet at T15 has just had its demand hand refreshed. A new `Wine → Praha (supply Frankfurt)` card is in hand. The trip planner produces an active route consisting of a **single stop**: `deliver(Wine@Praha)`. There is no preceding `pickup(Wine@Frankfurt)` stop.

The bot has no Wine on its train at T15 — Wine load is at the Frankfurt supply city. The route is therefore unexecutable as written: the bot cannot deliver a load it does not possess.

The bot follows the malformed route anyway. T16–T17: BuildTrack and MoveTrain toward Praha. T17: arrives at Praha (`positionEnd: "Praha"`). T18: bot is at Praha, route's only stop is `deliver(Wine@Praha)`, no Wine is on board, so the executor emits **PassTurn**. Bot stands at Praha for a turn doing nothing.

T19: trip planner re-runs and produces a *correct* route — `pickup(Cars@Stuttgart) → deliver(Cars@Antwerpen) → pickup(Wine@Frankfurt) → deliver(Wine@Praha)`. The Wine→Praha delivery is now properly preceded by a pickup at Frankfurt. T20–T22 the bot continues correcting course and backtracks westward toward Frankfurt to actually pick up Wine.

Net cost: ~5 wasted turns (T15 planning the bad route, T16–T17 travel toward Praha, T18 PassTurn at Praha, plus T20+ backtracking to Frankfurt).

## Source

`logs/game-75c6afc8-8d99-49b0-b878-e5e19512478d.ndjson`, player Sonnet, T14 → T15 replan boundary through T19 recovery.

## Observed trace (Sonnet T13–T19)

| Turn | Action       | Position end | Route stops                                                                          | Wine demand |
|------|--------------|--------------|--------------------------------------------------------------------------------------|-------------|
| T13  | MoveTrain    | —            | `pickup(Wine@Frankfurt), deliver(Oil@Kaliningrad), deliver(Wine@Warszawa)`           | Wine→Warszawa (carried, supplyCity=null) |
| T14  | BuildTrack   | —            | `pickup(Wine@Frankfurt), deliver(Oil@Kaliningrad), deliver(Wine@Warszawa)`           | Wine→Warszawa (carried) |
| T15  | UpgradeTrain | —            | **`deliver(Wine@Praha)`**                                                            | **Wine→Praha (supply Frankfurt)** |
| T16  | BuildTrack   | —            | `deliver(Wine@Praha)`                                                                | Wine→Praha |
| T17  | MoveTrain    | **Praha**    | `deliver(Wine@Praha)`                                                                | Wine→Praha |
| T18  | **PassTurn** | Praha        | `deliver(Wine@Praha)`                                                                | Wine→Praha |
| T19  | BuildTrack   | —            | `pickup(Cars@Stuttgart), deliver(Cars@Antwerpen), pickup(Wine@Frankfurt), deliver(Wine@Praha)` | Wine→Praha |

The hand turnover happens between T14 (Wine→Warszawa, carried) and T15 (Wine→Praha, supply=Frankfurt). The bot apparently delivered Wine→Warszawa or discarded the hand, drew the new Wine→Praha card, and the planner produced a route assuming Wine was still on the train.

## Expected behavior

When the trip planner generates a route stop sequence, every `deliver(X@city)` stop must have one of the following preconditions:
1. A preceding `pickup(X@supplyCity)` stop in the same route, OR
2. Load `X` is currently in `bot.loads` (carried).

If neither holds, the candidate is malformed and must be rejected before becoming the active route. The planner should regenerate or fall back rather than commit a route that cannot execute.

What must NOT happen: the bot drives to a delivery city, arrives without the load, emits a PassTurn, and only then re-plans. The malformed route should never have been chosen.

## Acceptance

- **AC1** — Replicate T15 snapshot: `bot.loads = []` (or whatever the actual loads are at T15 — needs log verification), demand hand contains `Wine → Praha (supply Frankfurt)`. Invoke trip planner. Assert: the returned route either (a) contains `pickup(Wine@Frankfurt)` before `deliver(Wine@Praha)`, or (b) does not include the Wine→Praha delivery at all.
- **AC2** — The planner's candidate validator rejects any candidate whose deliver stop has no matching prior pickup AND whose load is not in `bot.loads`. The action-grammar validator already enforces this in the LLM action prompt (`TRIP_PLANNING_SYSTEM_SUFFIX` lines 183-186) — the deterministic candidate generator must enforce the same constraint.
- **AC3** — Full-game regression on the T14 → T19 segment. Replay T14 snapshot, simulate the demand-hand turnover at T15 boundary. Assert: bot's T15 route contains a Wine pickup stop OR doesn't reference Wine at all. Bot does not arrive at Praha empty-handed.
- **AC4** — Snapshot synchronization check. If the root cause is `bot.loads` being stale at the planner invocation point (`snapshot.bot.loads` still contains Wine from the carried state, even after Wine→Warszawa delivered), the snapshot mirror logic must be audited. (See `TurnExecutor.handleDeliverLoad` post-delivery `snapshot.bot.loads = ...filter(...)` — same site as the JIRA-220 follow-up.)

## Not in scope

- The T18 PassTurn-when-route-malformed behavior is a separate concern (could be useful to log a `malformed_route_arrived_empty_handed` reason). Outside this ticket.
- Whether the bot should *cancel* the active route and re-plan immediately upon detecting a missing-pickup error (deferred — JIRA-249 just asserts the malformed route is never produced in the first place).
- Demand-hand turnover policy / what triggers the T14→T15 hand change (orthogonal).
