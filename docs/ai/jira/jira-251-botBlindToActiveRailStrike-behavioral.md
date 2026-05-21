# JIRA-251 — Bot continues emitting MoveTrain after Rail Strike blocks its own-track movement (behavioral)

In game `d9d2433a-641f-43c3-a6bf-26e5803b3ecd`, bot player Haiku (id `2c4d5d36-931d-460f-808c-5ee05a71d68b`) draws a Rail Strike event (card #123 per the Eurorails rulebook: "No train may move on the drawing player's rail lines. The drawing player may not build track during this event."). The event is active starting at T6.

Beginning at T6 and continuing every turn through at least T11, the bot's emitted plan is `MoveTrain` and the server-side execution returns `success: false`. The server error (as observed in chat or socket emit) reads "Movement blocked by active event (Rail Strike): player 2c4d5d36-931d-460f-808c-5ee05a71d68b cannot move on their own track this turn."

The bot's per-turn log records `success: false` but does NOT include any indication of WHY the move failed. The bot's `WorldSnapshot.activeEffects` field is `null` — the bot has no awareness that a Rail Strike is in effect. It plans a route, attempts to execute the next MoveTrain along its own track, the server rejects it, and the cycle repeats next turn.

This is a Phase 4 (event-card awareness) regression — the merge of `origin/main` brought in event-card infrastructure (`EventCardService`, `ActiveEffectManager`, `ActionRestrictionEnforcement`), but the bot's planner and snapshot do not yet consult any of it.

## Source

`logs/game-d9d2433a-641f-43c3-a6bf-26e5803b3ecd.ndjson`, player Haiku, T6–T11 (continuous).

## Observed trace (Haiku T5–T11)

| Turn | Action     | success | reasoning                                                |
|------|------------|---------|-----------------------------------------------------------|
| T5   | MoveTrain  | true    | `[route-executor] stop 1/2, phase=build`                  |
| T6   | MoveTrain  | **false** | (Rail Strike drawn at end of T5 or start of T6)         |
| T7   | MoveTrain  | false   | `[route-executor] stop 0/2, phase=build`                  |
| T8   | MoveTrain  | false   | (same)                                                    |
| T9   | MoveTrain  | false   | (same)                                                    |
| T10  | MoveTrain  | false   | (same)                                                    |
| T11  | MoveTrain  | false   | (same)                                                    |

The Rail Strike rule is supposed to expire at the end of the drawing player's next turn (T6 + 1 = T7, so the strike should resolve after T7 with the card discarded). The trace shows continuing failures through T11, which suggests either:

1. The bot keeps drawing Rail Strike (the deck has multiple Strike cards),
2. The event expiry isn't firing correctly on main's side, OR
3. The bot's invalid MoveTrain attempts are masking a different blocking condition the bot can't see.

Whichever — the bot has no diagnostic visibility into why moves fail, and no adaptive response.

## Expected behavior

When an Event card is in effect and restricts the bot's actions, the bot must:

1. **See the event in its snapshot.** `WorldSnapshot.activeEffects` must be populated by `WorldSnapshotService` from `ActiveEffectManager`.
2. **Reason about restricted moves at plan time.** The trip planner / movement planner must consult active effects before emitting an action. For Rail Strike specifically: if the drawing player is the bot AND the planned move uses the bot's own track, the action is illegal — plan something else (move on opponent's track, build elsewhere, deliver if possible, or PassTurn gracefully).
3. **Surface failure reasons in turn logs.** When the server rejects an action, the bot's per-turn log entry should record the rejection reason (`Movement blocked by active event (Rail Strike)`) so future debugging doesn't require cross-referencing socket emit logs.
4. **Adapt within the constraint.** A Rail Strike lasts one turn (the drawing player's next turn). For that turn, the bot should pick the best legal alternative: deliver an already-carried load if at the delivery city, pick up a load at the current city, or just take the lost turn cleanly (PassTurn) rather than fire-and-forget a guaranteed-failing MoveTrain.

What must NOT happen: the bot emits the same MoveTrain across multiple turns, the server rejects each one, and the bot's log shows `success: false` with no diagnostic trace. This silently burns turns and looks like a frozen bot to the human player.

## Acceptance

- **AC1** — Replicate T6 snapshot: bot has an active route, position is on its own network, `ActiveEffectManager.getActiveEffects(gameId)` returns a Rail Strike with the bot as drawing player. Invoke trip planner. Assert: planner does NOT emit a MoveTrain on the bot's own track for that turn.
- **AC2** — Same fixture, vary alternatives: bot is at a city with a deliverable load (matching `canDeliver`). Assert: planner emits DeliverLoad (legal — Rail Strike only blocks moves) instead of MoveTrain.
- **AC3** — Same fixture, no legal alternative exists (bot mid-network with carried load that can't be delivered, no opponent track adjacent). Assert: planner emits PassTurn with reasoning that cites Rail Strike, not a guaranteed-failing MoveTrain.
- **AC4** — Per-turn log must contain a `rejectionReason` field when the server rejects an action, populated from the server's `ActionRestrictionEnforcement` response. This applies to all event-card restrictions, not just Rail Strike.
- **AC5** — `WorldSnapshot` schema includes an `activeEffects` field; `WorldSnapshotService.capture` populates it from `ActiveEffectManager`.

## Not in scope

- Full Phase 4 event-card awareness for all 20 event card types — JIRA-251 is the Rail Strike repro; the larger Phase 4 project covers Snow, Derailment, Flood, Strike (coastal), Excess Profit Tax, etc.
- Strategic adaptation across multiple turns of repeated event draws (handled as part of Phase 4 strategic planning).
- ActiveEffectManager test infrastructure (already exists on main; bot just needs to consume it).

## Phase 4 relationship

This ticket is one of several deferred items called out in the `compounds/guardrail-updates → main` merge:

- Bot blindness to active event effects (THIS TICKET — Rail Strike repro)
- Bot blindness to ActionRestrictionEnforcement rejection reasons (covered by AC4)
- Bot blindness to TrackService.removeSegmentsCrossingRiver (separate Flood ticket when symptom observed)
- Bot blindness to Snow / Derailment / coastal Strike / Excess Profit Tax (separate tickets per symptom)

Treat JIRA-251 as the "vertical slice" repro for the Rail Strike case. The larger Phase 4 project should generalize the fix shape across all event types.
