# JIRA-222 — RouteValidator carried-load gate reads stale snapshot.bot.loads (technical)

Companion to `jira-222-validatorCarriedLoadStaleSnapshot-behavioral.md`. Read that first for the observed call sequence and acceptance criteria.

## Current implementation

### The gate

**`src/server/services/ai/RouteValidator.ts:83-96`** — the JIRA-181 unified DELIVER feasibility check:

```ts
for (let i = 0; i < validations.length; i++) {
  const v = validations[i];
  if (!v.feasible || v.stop.action !== 'deliver') continue;

  const isCarried = snapshot.bot.loads.includes(v.stop.loadType);   // ← reads snapshot
  const hasFeasiblePriorPickup = validations
    .slice(0, i)
    .some(pv => pv.feasible && pv.stop.action === 'pickup' && pv.stop.loadType === v.stop.loadType);

  if (!isCarried && !hasFeasiblePriorPickup) {
    v.feasible = false;
    v.error = `DELIVER ${v.stop.loadType} @ ${v.stop.city} is infeasible: bot does not carry ${v.stop.loadType} and no feasible PICKUP appears earlier in this candidate.`;
  }
}
```

`validate()` already accepts `context: GameContext` as its second parameter, so the data needed for the alternative is in scope. The signature does not need to change.

### Why `snapshot.bot.loads` is stale here but `context.loads` is not

The relevant T5 sequence in `MovementPhasePlanner.executePhaseA`:

1. **Line 158** `applyStopEffectToLocalState(currentStop, context)` — mutates `context.loads` only (post-JIRA-196 contract — see `routeHelpers.ts:247-260`).
2. **Lines 173, 261** `TurnExecutor.executePlan(plan, snapshot)` early-execs the pickup and the delivery. Per the post-`116346f` contract, the handlers (`handlePickupLoad` line 550, `handleDeliverLoad` lines 727-733) reassign `snapshot.bot.loads` to a new array via immutable slice/concat.
3. **Lines 287-309** JIRA-165 refresh:
    ```ts
    const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
    freshSnapshot.bot.loads = [...snapshot.bot.loads];                        // ← line 291
    context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
    context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
    snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
    ```
    `rebuildDemands` reads `freshSnapshot.bot.loads` to set the `isLoadOnTrain` flag on every demand (`DemandEngine.ts:499` — `const isLoadOnTrain = snapshot.bot.loads.includes(loadType);`). Whatever value was assigned at line 291 propagates into the next prompt's `isLoadOnTrain` flags.
4. **Line 322** `PostDeliveryReplanner.replan(activeRoute, snapshot, context, ...)` is called with the same `snapshot` reference.
5. Inside `TripPlanner.planTrip` → `scoreCandidates` → `RouteValidator.validate(tempRoute, context, snapshot)` (`TripPlanner.ts:636`), the validator hits the gate above with `snapshot.bot.loads`.

In game `1a10d393` T5, between step 2 (where the handlers should have left `snapshot.bot.loads = ['China']`) and step 5 (validator), `snapshot.bot.loads` no longer contained `'China'`. The behavioral evidence pins this down: the prompt's `(demand card unresolved)` line is emitted by `systemPrompts.ts:334` exactly when `context.demands.find(d => d.loadType === 'China' && d.isLoadOnTrain)` returns undefined — and `isLoadOnTrain` was set from the same `freshSnapshot.bot.loads = [...snapshot.bot.loads]` that fed the validator.

`context.loads`, in the same execution, was `['China']` — `Carried loads: China` rendered correctly from `context.loads.join(', ')` at `systemPrompts.ts:303`.

This is the JIRA-196 / JIRA-197 contract drift that JIRA-197's commit message describes:

> "Completes the JIRA-196 snapshot/context contract migration on the READ side. JIRA-196 fixed the WRITE side ... but ActionResolver's deliver/pickup/drop guards still read snapshot.bot.loads"

ActionResolver was migrated. `RouteValidator` was not. The JIRA-181 carried-load gate was authored before the contract split and never picked up the migration.

## Fix plan

### Primary fix — RouteValidator reads `context.loads`

**`src/server/services/ai/RouteValidator.ts`** line 87:

```ts
// before
const isCarried = snapshot.bot.loads.includes(v.stop.loadType);

// after
const isCarried = context.loads.includes(v.stop.loadType);
```

`context` is already in scope (parameter on `validate`). No signature change.

Rationale: `context.loads` is the planner's working state for the in-flight turn (per JIRA-196 contract). When the validator is invoked for a route the planner is about to commit to, "is this load on the train mid-turn?" is a question about working state, not DB-committed state. The legacy reads of `snapshot.bot.loads` were correct only when the two were in sync, which is not guaranteed across the post-delivery replan path.

### Secondary fix — JIRA-165 refresh seeds from `context.loads`

**`src/server/services/ai/MovementPhasePlanner.ts`** line 291:

```ts
// before
freshSnapshot.bot.loads = [...snapshot.bot.loads];

// after
freshSnapshot.bot.loads = [...context.loads];
```

This guarantees the next prompt's `isLoadOnTrain` flags match the carried state the validator now uses, and removes the "demand card unresolved" symptom in the prompt. Same JIRA-196/197 reasoning — the planner-working state is `context.loads`, and the rebuild is for planner consumption.

### What does NOT change

- `RouteValidator.validate`'s signature, return type, or any other branch.
- `TurnExecutor` handler mutations (the `116346f` fix stays — `snapshot.bot.loads` continues to track DB-committed state).
- `applyStopEffectToLocalState` (the `f8563ea` fix stays — context-only mutation).
- `LLMStrategyBrain.planRoute` and `ResponseParser.parseStrategicRoute` (the heuristic-fallback path is not part of this fix).
- The retry feedback string format produced by `TripPlanner.classifyValidationError`.

## Tests

### New regression test (RouteValidator)

`src/server/__tests__/ai/RouteValidator.carriedLoadFromContext.test.ts`:

Build a `WorldSnapshot` with `bot.loads = []` and a matching `GameContext` with `loads = ['China']` and a `China → Kaliningrad` demand. Call `RouteValidator.validate` on a single-stop route `[deliver China @ Kaliningrad]`. Assert: `valid === true`, no `errors` referencing "does not carry".

This test fails on `main` and passes after the line-87 change. It locks the contract: the validator uses `context.loads`.

### New regression test (post-delivery replan)

`src/server/__tests__/ai/MovementPhasePlanner.postDeliveryReplanCarriedLoad.test.ts`:

Drive `MovementPhasePlanner.executePhaseA` through the T5 shape from game `1a10d393` — `[pickup China Leipzig, pickup China Leipzig, deliver China Wien, deliver China Kaliningrad]`, bot at Leipzig with `bot.loads = ['China']`, `context.loads = ['China']`. Mock `TurnExecutor.executePlan` to mutate `snapshot.bot.loads` correctly per handler contract; verify that the post-delivery replan calls TripPlanner with `context.loads = ['China']` and the validator accepts a single-stop `DELIVER China @ Kaliningrad` route on the first attempt.

### Existing tests to keep green

- `RouteValidator.test.ts` — JIRA-181 carried-load tests (AC1–AC9). They construct snapshot+context with consistent loads, so the line-87 read switch is silent. Confirm green.
- `TripPlanner.test.ts`, `MovementPhasePlanner.test.ts`, `PostDeliveryReplanner.test.ts` — no expected behavior change.
- `ContextBuilder.test.ts` JIRA-196 tests — line-291 secondary fix uses `context.loads`, which `[...snapshot.bot.loads]` aliased on the initial build. Confirm green.

## Risk

Small. `context.loads` is the documented planner-working state and is set on every `ContextBuilder.build` (line 185 — `loads: [...snapshot.bot.loads]`) and kept in sync via `applyStopEffectToLocalState`. Every existing call site that built consistent test fixtures will be unaffected. The only behavior that changes is the one this ticket targets: post-delivery replans where the live snapshot diverges from working state.

If `context.loads` ever ends up emptier than `snapshot.bot.loads` (the inverse drift), the validator would falsely reject a DELIVER. This direction is not observed and would imply a separate bug in `applyStopEffectToLocalState` — a future ticket if it happens.

## Confirmation

The behavioral document's acceptance hinges on a single regression test reproducing the divergent state and showing the validator accepts the DELIVER-only route on the first call. After the secondary fix, the prompt rendered for the same scenario shows `Carried load: China (card 30 → deliver to Kaliningrad for 17M)` instead of `(demand card unresolved)`.
