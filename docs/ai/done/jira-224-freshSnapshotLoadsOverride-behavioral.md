# JIRA-224 — `freshSnapshot.bot.loads` override after DB capture is suspect (behavioral)

## Source

Surfaced 2026-05-10 while wrapping up JIRA-223. The line was already present before the JIRA-118 mutation-ownership fixes (commit `116346f` — "handlers own snapshot.bot.loads mutation") landed, and it has not been audited since. The intent of the override no longer matches its current effect.

## Observed behavior

In `src/server/services/ai/MovementPhasePlanner.ts:290-294`, the post-delivery branch captures a fresh snapshot from the database and then immediately overwrites the DB-loaded `bot.loads` field with the LOCAL `context.loads` array:

```ts
const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
freshSnapshot.bot.loads = [...context.loads];
context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
```

The `freshSnapshot` is captured specifically to get an authoritative DB view of the bot's state after the just-committed delivery. Overwriting one of its fields with the local `context.loads` array — which is the planner's own bookkeeping — defeats part of the purpose of the capture.

## Why this is a bug-shaped concern, not yet a confirmed bug

After commit `116346f`, handlers (TurnExecutor, action handlers) own the mutation of `snapshot.bot.loads` on the local snapshot. In the happy path, `context.loads` and the DB-captured `freshSnapshot.bot.loads` should agree. But:

1. If the local `context.loads` ever drifts from the DB (a handler missed a mutation, an early-exec failure left the local state mid-update, an Event card flow), the override silently re-introduces local truth into a struct meant to carry DB truth.
2. The rebuild calls (`rebuildDemands`, `rebuildCanDeliver`) on the next two lines now operate on a `freshSnapshot` whose `bot.loads` came from local, whose `resolvedDemands` came from the DB. The two fields are no longer guaranteed to be from the same point in time.
3. The downstream assignment `snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands` propagates DB-derived demands without re-aligning local loads against them.

## What's NOT being claimed

- This is NOT confirmed as causing any existing observed bug. The current happy-path behavior may be correct.
- The override predates the load-mutation-ownership fix and was likely a workaround when `snapshot.bot.loads` was the only mutated array.

## What's needed

An audit + decision: is the override (a) load-bearing for some flow we still need, or (b) dead weight from a pre-`116346f` era?

## Acceptance criteria

- **AC1** Audit the call path leading into `MovementPhasePlanner.ts:290-294`. Identify every flow that reaches this block (delivery success post-commit; any other?).
- **AC2** For each identified flow, verify whether `context.loads` and the DB-captured `freshSnapshot.bot.loads` would agree. If they always agree → the override is dead weight; remove it. If a flow exists where they diverge → document the flow and either fix the upstream divergence OR document why the override is the right reconciliation point.
- **AC3** If the override is removed, no existing tests regress and no observed behavior change in game logs (the post-delivery rebuild still operates against authoritative state).
- **AC4** If the override is retained, add a comment explaining the specific flow it's compensating for and a guard that fails fast when `context.loads` and `freshSnapshot.bot.loads` diverge in any other case.

## Out of scope

- Modifications to JIRA-173 early-exec, JIRA-165 demand refresh, or any other pre-commit early-execution path.
- Deeper refactor of `context` vs `snapshot` ownership boundaries — that's a separate, larger ticket.
