# JIRA-233 — In-turn replan stale cargo + dead-route detection (technical)

Companion to `jira-233-replanAfterDeliveryUsesStaleCargo-behavioral.md`. Read that first for evidence and acceptance.

## Current implementation — locating each defect

### Defect A: where the stale-state replan happens

The post-delivery replan is most likely in one of these locations (verify via grep before editing):

- `src/server/services/ai/AIStrategyEngine.ts` — around line 470-480, `composedSteps.some(s => s.type === AIActionType.DeliverLoad)` sets `hasDelivery`. Around line 475-485, `if (hasDelivery && activeRoute && !routeWasCompleted && !routeWasAbandoned)` block preserves `previousRouteStops`.
- `src/server/services/ai/PostDeliveryReplanner.ts` — likely owns the explicit "after delivery, ask planner for a new route" path. The snapshot is constructed here or passed in.
- `src/server/services/ai/TurnExecutorPlanner.ts` — multi-action turn execution. May dispatch the replan when a DeliverLoad step completes mid-MultiAction.

The planner consumes cargo state at two specific read points:

1. **`DeterministicTripPlanner.ts:903-905`** (search `detectCarriedLoads`) — produces the `isCarry` flag for each demand row by checking `snapshot.bot.loads` against the demand's loadType.
2. **`DeterministicTripPlanner.ts:898`** — `cap = TRAIN_CAP[trainTypeRaw] ?? 2;` derives the cap; not directly affected, but route variant generation downstream uses `carryCount` which depends on `isCarry`.

The bug is between the delivery's effect on `bot.loads` and the read at point 1. The mutation site for `bot.loads` is in `TurnExecutor.ts` — search for `snapshot.bot.loads = [...snapshot.bot.loads, loadType]` (pickup) and the matching delete-by-index for delivery (around line 727-731).

### Defect B: route advancement check

Search for "currentStopIndex" increments in:
- `src/server/services/ai/NewRoutePlanner.ts` — D-block sequence that processes deliveries and advances stops
- `src/server/services/ai/TurnExecutorPlanner.ts` — if multi-action handles stop advancement directly

The pattern that needs the new check:
- After a delivery (whether opportunistic or route-driven), evaluate whether the **next** stop on the active route is still feasible. If not, signal route-abandonment.

### Defect C: route impossibility check

There's no existing impossibility check. It's a new code path. Place it adjacent to the stop-advancement logic, after any in-turn action that could leave the route's next stop unsatisfiable:
- DeliverLoad (load no longer on board)
- DropLoad (load no longer on board)
- (theoretically PickupLoad changing the cargo set, but pickups only add)

## Fix plan

Three changes, ordered by dependency: A must land first; B and C build on A.

### 1. Defect A — apply delivery to local snapshot before replan

Two viable implementations:

**Option A1 (recommended): mutate a local copy of `snapshot.bot.loads` before calling the replanner.**

Wherever the post-delivery replan is invoked (locate in `AIStrategyEngine.ts` or `PostDeliveryReplanner.ts`), construct a fresh snapshot view:

```ts
// At the post-delivery replan site, after `delivered` is known:
const replanSnapshot: WorldSnapshot = {
  ...snapshot,
  bot: {
    ...snapshot.bot,
    loads: snapshot.bot.loads.filter(load => {
      // Remove one instance per delivered load (handle multiplicity)
      const idx = deliveredLoadsThisTurn.indexOf(load);
      if (idx !== -1) {
        deliveredLoadsThisTurn.splice(idx, 1);
        return false;
      }
      return true;
    }),
  },
};
planTripDeterministic(replanSnapshot, context, memory);
```

`deliveredLoadsThisTurn` is the list of load types delivered in this turn's action sequence — obtainable from `composedSteps.filter(s => s.type === DeliverLoad).map(s => s.loadType)` (matching the existing `hasDelivery` detection at AIStrategyEngine.ts:474).

Pro: minimal change, isolated to the replan call site. Con: requires the call site to know what was delivered this turn (already does — it's the trigger condition).

**Option A2: defer the replan to next turn entirely.**

Don't replan mid-turn. Let the turn complete, let `TurnExecutor` finalize bot state, then on the next turn's `takeTurn` invocation the planner sees fully-current state. The downside is the bot wastes one turn before reacting to its new cargo state — the existing in-turn replan exists for a reason.

Recommend Option A1.

**Affected files (one of these owns the call site):** `AIStrategyEngine.ts`, `PostDeliveryReplanner.ts`, `TurnExecutorPlanner.ts`. The implementer should grep for the call to `planTripDeterministic` that fires when `hasDelivery && !routeWasCompleted`.

### 2. Defect B — opportunistic-delivery triggers impossibility check

In whatever code path advances `route.currentStopIndex` after an action:

```ts
// Existing code (paraphrased):
if (action.loadType === nextStop.loadType && action.city === nextStop.city) {
  route.currentStopIndex += 1;
} else {
  // NEW: an action fired that doesn't match the next stop.
  // This is either an opportunistic delivery, a pickup we didn't plan,
  // or a stale-route situation. Trigger impossibility check.
  if (isRouteImpossible(route, snapshot)) {
    activeRoute = null;
    routeWasAbandoned = true;
  }
}
```

`isRouteImpossible` is the new helper from Defect C.

### 3. Defect C — `isRouteImpossible` helper

New function. Place in `src/server/services/ai/RouteValidator.ts` or a new helper file alongside it:

```ts
/**
 * Check whether the active route can still complete given current cargo
 * and remaining pickup steps.
 *
 * A route is impossible when its next deliver stop requires a load that
 * is neither currently on the train nor pickup-able later in the route.
 */
export function isRouteImpossible(
  route: StrategicRoute,
  snapshot: WorldSnapshot,
): boolean {
  const remainingStops = route.stops.slice(route.currentStopIndex);
  if (remainingStops.length === 0) return false; // route done, not impossible

  const nextStop = remainingStops[0];
  if (nextStop.action !== 'deliver') return false; // only deliver stops can be cargo-impossible

  const requiredLoad = nextStop.loadType;
  const onBoard = snapshot.bot.loads.includes(requiredLoad);
  if (onBoard) return false;

  // Check whether a remaining pickup step gets the required load
  const pickupForRequired = remainingStops.some(
    s => s.action === 'pickup' && s.loadType === requiredLoad
  );
  if (pickupForRequired) return false;

  return true; // can't satisfy next deliver, no pickup available — impossible
}
```

Wire this in:
- After any in-turn action that mutates `snapshot.bot.loads` (delivery, drop)
- At the top of each new turn's `takeTurn`, before invoking the planner (defensive — catches any state where the route became impossible between turns)

When `isRouteImpossible` returns true: clear `memory.activeRoute = null`, set `routeWasAbandoned = true` so the existing memory-update logic records the abandonment in `routeHistory`.

## Test strategy

### Unit tests in `__tests__/ai/RouteValidator.test.ts` (or new `__tests__/ai/RouteImpossibility.test.ts`)

- `isRouteImpossible`:
  - Route with no remaining stops → false
  - Next stop is pickup → false
  - Next stop is deliver, load on board → false
  - Next stop is deliver, load not on board, no remaining pickup → **true**
  - Next stop is deliver, load not on board, but pickup later in route → false
  - Edge case: multiple delivery stops with same load type, but only one carried instance (e.g., `del:Copper@Nantes, del:Copper@Madrid` with 1 Copper on board) → first deliver satisfies, second doesn't have on-board load — check should fire on the second.

### Unit tests in `__tests__/ai/AIStrategyEngine.test.ts` (extend existing)

- **Defect A snapshot freshness**: mock the planner; verify that the snapshot it receives post-delivery has `bot.loads` reflecting the delivery's effect.
- **Defect B advancement on mismatch**: active route's next stop is `del:Copper@Madrid`, bot's action is `DeliverLoad Coal@Madrid`. Assert `currentStopIndex` does not advance AND `isRouteImpossible` is invoked AND `activeRoute` becomes null because Coal-not-Copper and no pickup-Copper remains.
- **Defect C dead route on next turn**: snapshot at start of a turn has `activeRoute = { stops: [del:Copper@Madrid], currentStopIndex: 0 }` and `bot.loads: []`. Assert the top-of-turn impossibility check fires, `activeRoute` is cleared, and planner is invoked fresh.

### End-to-end regression test for game `85f3bef2` t73-t80

Reconstruct s1's t68 snapshot (cargo empty, just-delivered Sheep, hand from log) and execute through t80 with the three fixes applied. Assertions:
- t73 chosen route has at most 2 deliver stops (matching post-Potatoes cargo size of 2)
- t75 chosen route does not say "Bot already carries Copper" — the reasoning must reflect post-Nantes-delivery cargo `[Coal]`
- t79 Coal delivery triggers route abandonment (Copper@Madrid impossibility)
- t80+ planner picks a new route from current hand; no PassTurn streak

## Implementation order

1. **Defect C — `isRouteImpossible` helper + unit tests.** Self-contained, no behavior change yet. Just adds the predicate.
2. **Defect A — snapshot freshness at post-delivery replan.** Behavior change: replanner sees correct cargo. Some existing tests with carefully-crafted fixtures may need updating if they assumed stale state.
3. **Defect B — wire `isRouteImpossible` into the stop-advancement non-match branch.** Behavior change: opportunistic deliveries now potentially abandon active routes. Verify the existing route-history logging in `AIStrategyEngine.ts:600-614` correctly records the abandonment.
4. **Defect C wiring (defensive)** — add the impossibility check at the top of `takeTurn` before invoking the planner.
5. **Regression test for game `85f3bef2` t73-t80.**

Each step is independently revertable. Step 1 ships alone with no risk. Steps 2-4 each have a small behavior-change blast radius bounded by existing memory-management code.

## Risk and rollback

- **False-positive route abandonment (Defect C)**: if `isRouteImpossible` returns true for routes that ARE recoverable (e.g., bot can divert to pick up the missing load via a non-route detour), we'd abandon routes the bot could still complete. Mitigation: the predicate is intentionally narrow — only fires when (a) next stop is deliver, (b) required load not on board, (c) no remaining pickup for that load in the route's stops. It does NOT consider "could the bot insert a new pickup detour" — that's the planner's job after abandonment.
- **Defect A breaking pair/triple selection for legitimate carry scenarios**: when a bot legitimately carries 3 loads and the planner picks `triple-3carry`, the snapshot freshness fix should not change behavior (cargo state is already current). Verify in regression tests.
- **Rollback**: revert step 2 alone to keep the existing strict-match advancement. Step 3 alone is harmless without step 2 wiring it. Steps 1 and 4 are additive.
- **JIRA-230 test interaction**: the t46 regression test from JIRA-230 Project 3 uses mocked `PathCostEstimator` and `LoadService`. It should be unaffected by JIRA-233 changes (no in-turn delivery in the t46 fixture). Verify it still passes.

## Definition of done

- All three defects' unit tests pass.
- t73-t80 end-to-end regression test passes (no PassTurn streak; bot makes additional deliveries past t80).
- JIRA-230, JIRA-229, JIRA-228, JIRA-227 test suites continue to pass.
- `[broke-route]` or equivalent log line emitted when `isRouteImpossible` clears a route — observability so production game logs surface the trigger if it fires.
- The original game `85f3bef2` snapshot replay (full game, not just t73-t80 slice) demonstrates s1 reaching at least one more delivery after t80, and ideally contests s2's victory.
