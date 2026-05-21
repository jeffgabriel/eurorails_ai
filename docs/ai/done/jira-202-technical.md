# JIRA-202 — Technical fix plan

Companion to `jira-202-behavioral.md`.

## Root cause

`src/server/services/ai/MovementPhasePlanner.ts:319-322` — the movement loop breaks early when the budget is exhausted:

```ts
if (remainingBudget === 0) {
  trace.a2.terminationReason = 'budget_exhausted';
  break;
}
```

The "already at the stop city → execute stop action" handler lives at the top of the next loop iteration (line 127). With the early break above, that handler never gets a chance to fire on the arrival turn. The stop action (`DeliverLoad` / `PickupLoad` / `DropLoad`) waits until next turn.

Picking up, dropping, and delivering loads do not consume mileposts per the game rules — so executing the stop action with `remainingBudget === 0` is legal.

This is independent of route phase: the bug fires for both `deliver` stops (income lost) and `pickup` stops (next leg of the route delayed by a turn).

## Fix plan

In `MovementPhasePlanner.ts`, between the move-success block and the `budget_exhausted` early exit, check whether the just-completed move brought the bot to the current stop's target city. If so, execute the stop action *before* breaking. Reuse the existing stop-execution branch at lines 127–289 rather than duplicating the executeStopAction / PostDeliveryReplanner / JIRA-165 demand-refresh / JIRA-198 upgrade-signal accumulation code paths.

Two practical shapes:

1. **Allow the loop to fall through to the next iteration even with `remainingBudget === 0`**, but tighten the exit guard so it terminates after the stop action runs. Single execution point for stop actions; cleaner.
2. **Inline a "did we just arrive?" check** right before the budget-exhausted break that calls into the same stop-action helper used at line 127. More targeted; lower-risk.

## Acceptance criteria (starting point)

- A bot whose final move of the turn lands exactly on its current stop's city executes the corresponding `DeliverLoad` / `PickupLoad` / `DropLoad` action that turn.
- Post-delivery side effects — payment, demand refresh (JIRA-165), PostDeliveryReplanner trigger, upgrade-signal forwarding (JIRA-198) — all still fire correctly when the delivery happens via the new arrival-at-budget-zero path.
- The build/upgrade phase that follows runs normally with the post-delivery cash already in `snapshot.bot.money`.
- Existing tests for the `budget_exhausted` termination path continue to pass; a new test exercises the arrival-on-last-milepost scenario.

## Out of scope

- Changing the movement budget itself or how mileposts are counted.
- Allowing the bot to take a *new* move action after the stop action runs (the budget really is exhausted; only the free stop action should fire).
- Touching the `isBotAtCity` check semantics — those are correct.
