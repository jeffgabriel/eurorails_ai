# JIRA-258 — Turn-log `loadsDelivered` and `actionTimeline` show a delivery that didn't actually happen when the underlying action was rejected by an event-card restriction (behavioral)

In game `182bfd36-3d3d-46ef-9c1d-0c87373b983f`, several turn entries for Haiku and s1 have a `rejectionReason` populated (the action was rejected by an active Strike), `success: false`, an `error` describing the rejection, AND `cash` unchanged across turns — clearly indicating no delivery payment was received. Yet the same turn entries also populate `loadsDelivered` and `actionTimeline` with the rejected delivery as though it had succeeded. This makes the NDJSON log misleading to anyone reading it (human or downstream tool) and breaks any aggregation that totals "loads delivered this game" from log data.

## Source

`logs/game-182bfd36-3d3d-46ef-9c1d-0c87373b983f.ndjson`, Haiku turn 31, fields below excerpted from a single line:

```json
{
  "turn": 31,
  "playerName": "Haiku",
  "success": false,
  "error": "Delivery blocked by active event (Strike): city London is within the coastal strike zone",
  "rejectionReason": {
    "code": "COASTAL_STRIKE_BLOCKED",
    "message": "Delivery blocked by active event (Strike): city London is within the coastal strike zone"
  },
  "loadsDelivered": [
    { "loadType": "Marble", "city": "London", "payment": 31, "cardId": 43 }
  ],
  "actionTimeline": [
    { "type": "deliver", "loadType": "Marble", "city": "London", "payment": 31, "cardId": 43 }
  ],
  "cash": 31,
  "victoryCheck": { "outcome": "insufficient-funds", "netWorth": 31, "threshold": 250 }
}
```

`cash` stays at 31 across turns 31, 32, and 33 — confirming the 31M Marble delivery never paid out. The matching s1 entries at Antwerpen show the same pattern (`loadsDelivered: [{Cars, Antwerpen, 12, 110}]` with `success: false` and `cash: 20` unchanged).

## Expected behavior

The per-turn log fields `loadsDelivered` and `actionTimeline` should reflect what was actually executed and accepted by the game-rule layer — not what the plan intended to execute. When `TurnExecutor.handleDeliverLoad` (or its sibling handlers) returns `success: false` with a `rejectionReason`, the corresponding action should NOT appear in `loadsDelivered` (delivery didn't happen) and should EITHER be excluded from `actionTimeline` OR be marked with an outcome field (e.g. `outcome: 'rejected', code: 'COASTAL_STRIKE_BLOCKED'`) so downstream consumers can tell apart "executed" from "attempted-and-rejected".

The exact serialization (exclude vs. annotate) is a design call — see the technical ticket for the recommended option.

## Acceptance

- **AC1** — Replicate Haiku T31 snapshot. Run the turn through `AIStrategyEngine.takeTurn` with the BE-006 PICKUP_DELIVERY restriction active. Assert: the resulting turn-log entry has `success: false`, `rejectionReason.code = 'COASTAL_STRIKE_BLOCKED'`, AND `loadsDelivered` is either absent or empty.
- **AC2** — Same fixture, no Strike active. Assert: turn-log entry has `success: true`, `loadsDelivered = [{ loadType: 'Marble', city: 'London', payment: 31, cardId: 43 }]`. Regression guard.
- **AC3** — `actionTimeline` policy decision (decided in technical ticket): assert the chosen behavior — either the rejected step is excluded, or it's present with an `outcome: 'rejected'` annotation. One option must be chosen and tested; both are acceptable, but the chosen one must be consistent across pickup, delivery, build, and move handlers.
- **AC4** — Integration: replay Haiku T31 of game `182bfd36-3d3d-46ef-9c1d-0c87373b983f`. Assert: the turn entry's `loadsDelivered` is absent/empty.

## Not in scope

- The root-cause behavior that produced the rejected deliveries in the first place — that's JIRA-257.
- Other field inconsistencies in the turn log (e.g., `actionBreakdown`, `compositionTrace.deliveries`). If those have the same plan-vs-outcome divergence under rejection, file follow-ups; this ticket scopes to `loadsDelivered` and `actionTimeline` because those are the two fields demonstrably misleading in the observed game.
- Backfilling old logs. Apply the fix going forward only; historical NDJSON files can stay as-is.

## User-facing impact

Per turn where a delivery is rejected by an event-card restriction: one fake `loadsDelivered` entry. Across two players in this single game's 3-turn Strike window: 5 fake entries (3 Haiku, 2 s1). At scale, any analyst running "deliveries per game" or "income per player" queries off the NDJSON gets the wrong number whenever an event card rejected a delivery.

## Relationship to existing JIRAs

- **JIRA-256 / BE-008**: BE-008 added `rejectionReason` plumbing in `TurnExecutor` (the per-action handlers) and `ExecutionResult`. That part is correct — the handlers DO return clean `success: false` results. The bug is upstream of that, in `AIStrategyEngine.takeTurn`'s log-building loop which walks plan steps, not execution outcomes.
- **JIRA-257**: closely related — the rejected deliveries that surface this log bug were caused by the guardrail bypass. Fixing 257 reduces (but doesn't eliminate) the symptom; this ticket fixes the log fidelity independently so future event-card rejections from any cause also produce accurate logs.
