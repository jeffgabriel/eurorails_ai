# JIRA-252 — Mid-turn ordering: deliver → replan → move (not deliver → move → replan) (technical)

Companion to `jira-252-postDeliveryMovementBeforeReplan-behavioral.md`.

## Defect locus (provisional — needs log validation)

The bot's turn executor processes a turn as a sequence of stop-actions and movement segments composed by `MovementPhasePlanner` (Phase A) and `TurnExecutorPlanner` (Phase B). When a `deliver` stop fires mid-turn, the replan (post-delivery `TripPlanner.planTrip` invocation) needs to slot in between the delivery and any remaining-budget movement.

Likely sites to inspect:

1. **`src/server/services/ai/MovementPhasePlanner.ts`** — Phase A1/A2/A3 composition. Where does the deliver stop get processed? Is `TripPlanner.planTrip` invoked immediately after the deliver step within the same composition pass, or does it wait until the next turn's `AIStrategyEngine.takeTurn`?
2. **`src/server/services/ai/TurnExecutorPlanner.ts`** — the `executeStopAction` / `execute` orchestration. The post-delivery replan trigger from JIRA-129 lives somewhere here (search for `replan` / `PostDeliveryReplanner`).
3. **`src/server/services/ai/PostDeliveryReplanner.ts`** (if it exists) — the dedicated post-delivery replan invocation. May exist as a separate module per JIRA-156 / JIRA-129 work.
4. **`src/server/services/ai/AIStrategyEngine.ts`** — the per-turn orchestrator. If the post-delivery replan happens here (i.e., at turn-end), that's the bug. The fix is to push it earlier into the per-action loop inside Phase A.

## Suspect: post-delivery replan currently fires at end-of-turn, not mid-turn

The JIRA-129 / JIRA-156 implementation may have wired the replan as a "between turns" event (i.e., the next turn's TripPlanner call picks up the new demand hand). If so, T42 in this game is the symptom of exactly that design: the bot's T41 delivery triggers a "next turn will replan" — but T42 still operates against the stale route in the meantime.

The fix is to make the replan invocation **synchronous within the same turn's executor**, immediately after the deliver step's success record:

```
for each stop in activeRoute.stops:
  if stop is deliver:
    execute deliver(stop)
    if delivery succeeded:
      draw new demand card
      if route is now complete:
        clear activeRoute
        # ── new: synchronous replan ──
        newRoute = TripPlanner.planTrip(updated snapshot, updated context, ...)
        if newRoute exists:
          activeRoute = newRoute
          # remaining movement budget continues against newRoute
        else:
          # no fresh plan — stop the train, end turn
          break
      else:
        # route has more stops — continue with old route's next stop
        ...
  elif stop is pickup:
    ...
```

## Fix shape

### Step 1 — Identify the existing post-delivery replan call site

Grep `src/server/services/ai/` for `planTrip` invocations. Locate the post-delivery one. Verify it's currently invoked at one of:
- (a) Start of next turn (in `AIStrategyEngine.takeTurn`) — the suspected current state
- (b) End of current turn (after all moves) — also a bug
- (c) Mid-turn, immediately after the deliver step — correct, but symptoms suggest this isn't happening

### Step 2 — Move (or add) the invocation to the per-action loop

Inside `MovementPhasePlanner` (or `TurnExecutorPlanner` — whichever owns the action loop), after a successful deliver step:

1. Refresh the local snapshot to reflect the delivery (`snapshot.bot.loads.filter(...)` already happens; ensure the new demand card is also reflected by re-querying `context.demands` or by accepting a refreshed context from `ContextBuilder.rebuildDemands`).
2. Invoke `TripPlanner.planTrip(refreshedSnapshot, refreshedContext, gridPoints, memory)`.
3. If the new route's first stop is on-network and the bot has remaining movement budget, push the new route's `move-toward-stop` segments into the composition trace and continue execution.
4. If the new route requires building (off-network first stop), the bot's current turn ends in movement terms — Phase B will compose a build next turn. Mark the trace with `terminationReason = 'post_delivery_replan_off_network'`.
5. If the planner returns no route at all (e.g., the new demand hand has no actionable demands), mark `terminationReason = 'post_delivery_no_actionable_plan'` and end movement.

### Step 3 — Add structured logging

Per `infrastructure-structured-logging` and `anti-patterns-error-swallowing`: every post-delivery replan invocation must produce a `CompositionTrace.postDeliveryReplan` entry with:

```ts
interface PostDeliveryReplanRecord {
  triggeredAfterStopIndex: number;
  deliveryLoadType: string;
  deliveryCity: string;
  newDemandsCount: number;
  carriedLoadsAtReplan: string[];
  newRoute: StrategicRoute | null;
  remainingMovementBudget: number;
  outcome: 'continued_with_new_route' | 'off_network_break' | 'no_actionable_plan';
}
```

This makes the ordering visible in log forensics.

## Acceptance from behavioral

- **AC1 / AC2** — Unit test on `MovementPhasePlanner` (or equivalent owner): fixture with bot mid-route, deliver step executes successfully, remaining movement budget > 0, new demand hand has at least one actionable demand. Assert: `TripPlanner.planTrip` is called BEFORE any further `MoveTrain` segment is emitted. The composed segments after the deliver reference the new route's stops.
- **AC3** — Unit test: same fixture, deliver completes the entire route. Assert: `activeRoute` is replaced by the new route, remaining movement budget is consumed by the new route's `move-toward-stop`.
- **AC4** — Unit test: same fixture, new route's first stop is off-network. Assert: no movement after the deliver; turn ends with the build to be composed next turn.
- **AC5** — Integration regression: replay T40 snapshot of game `3da56057`; assert post-delivery T41 (the missing-from-log turn — synthesize from before/after state) shows the new route active by end of turn, not T43.
- **AC6** — `CompositionTrace.postDeliveryReplan` is populated with the structured record above.

## Not in scope

- Detecting and recovering from a `route abandoned` state due to inability to plan post-delivery (separate failure path; covered by existing guardrails).
- The LLM (Hard skill) post-delivery flow — may already be correct via the LLM's planning prompts; verify in regression but don't change unless broken.
- Generalized "interrupt the turn's action sequence mid-execution" abstraction — keep the fix to the specific post-delivery replan slot.

## Validation hooks to inspect during fix

- `CompositionTrace.replanCount` at T42 of game `3da56057` — should be ≥1 after the fix (currently 0).
- `MovementPhasePlanner` Phase A trace — should show a `replan_at_stop_index_N` event in the per-step record, where N is the index of the deliver stop.
- The fixed bot's per-turn log entry for the post-delivery turn should reference `[route-replanned-post-delivery]` in `reasoning`, similar to T43's `[route-planned]` marker.

## Relationship to existing JIRAs

- **JIRA-129** wired the post-delivery TripPlanner replan but possibly at the wrong moment (turn-boundary vs. mid-turn). JIRA-252 corrects the timing.
- **JIRA-156** added RouteEnrichmentAdvisor mid-turn replan support. Verify whether the existing infrastructure supports synchronous in-turn replan invocation, or whether new hooks are needed.
- **JIRA-248/249/250** (just shipped on `fix/jira-248-249-250-carried-load-planner`) ensure the replan produces correct candidate sets. With those fixes plus JIRA-252's ordering correction, post-delivery turns should behave correctly end-to-end.
