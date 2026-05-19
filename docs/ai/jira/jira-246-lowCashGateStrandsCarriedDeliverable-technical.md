# JIRA-246 — Low-cash deliver-first gate strands carried deliverable (technical)

Companion to `jira-246-lowCashGateStrandsCarriedDeliverable-behavioral.md`.

## Defect locus

`src/server/services/ai/routeHelpers.ts:202-217` (the JIRA-165 Fix 2 capital-allocation gate inside `resolveBuildTarget`):

```ts
// JIRA-165 Fix 2: Capital allocation gate — if the bot is carrying a load
// that can be delivered on-network, AND is broke (<5M), skip building now
// so the executor advances to the deliverable stop for income first.
if (routeTarget && !routeTarget.isVictoryBuild && context.money < 5) {
  const hasDeliverableOnNetwork = context.demands.some(
    d => d.isLoadOnTrain && d.isDeliveryOnNetwork,
  );
  if (hasDeliverableOnNetwork) {
    return null;
  }
}
return routeTarget;
```

The gate returns `null`, which `MovementPhasePlanner.A3` at line 433 interprets as `no_build_target`. The caller has no further handling — A2 has already terminated with `stop_city_not_on_network`, so the executor falls through to the outer `break` on line 524 and emits `PassTurn`. There is no path in A2 or A3 that says "the gate intends a delivery — find the deliverable stop in the active route and target movement to it."

The intent in the comment ("executor advances to the deliverable stop") doesn't match the executor's behavior. A2 only inspects the route's `currentStop` (line 134), not later stops; it cannot "advance" past an off-network pickup to a later on-network deliver.

## Fix shape

Two options. **Recommended: option B (abandon).** It's narrower, well-isolated, and matches the existing replanner contract that JIRA-243's clinch gate already exercises.

### Option A (redirect — wider blast radius)

Modify A2 (`MovementPhasePlanner.ts:127-300+`) to, before consulting `currentStop`, check whether the route contains a deliverable-on-network stop earlier or later than the current stop, and if cash is below the gate threshold, advance `currentStopIndex` to that stop. Touches A2's stop-iteration order — easy to break the route invariants other code depends on.

### Option B — Replace the silent `return null` with a route-abandon signal

Change `resolveBuildTarget` to return a discriminated result instead of `null`, OR set a flag on the result that the caller propagates as `routeAbandonedByImpossibility = true` (the same path JIRA-233 uses for unreachable demands).

Concrete plan:

1. **Extend `resolveBuildTarget`'s return type** (`routeHelpers.ts:31` or wherever the type is declared) to a union:

   ```ts
   export type ResolveBuildTargetResult =
     | { kind: 'build'; targetCity: string; stopIndex: number; isVictoryBuild: boolean; secondaryTarget?: string; secondaryEstimatedCost?: number }
     | { kind: 'abandon'; reason: 'low_cash_carrying_deliverable' }
     | null;
   ```

   Most call sites currently destructure `{ targetCity, stopIndex, ... }` from the result. Update them to switch on `kind` and treat `kind: 'build'` as today's "non-null" case.

2. **Update the gate** (lines 207-214) to return `{ kind: 'abandon', reason: 'low_cash_carrying_deliverable' }` instead of `null` when the gate fires.

3. **Update `MovementPhasePlanner.A3` callsite** (`MovementPhasePlanner.ts:432-433`) to handle the new kind:

   ```ts
   const a3BuildTarget = resolveBuildTarget(activeRoute, context);
   if (!a3BuildTarget) {
     trace.a3.terminationReason = 'no_build_target';
   } else if (a3BuildTarget.kind === 'abandon') {
     // JIRA-246: low-cash gate signals "deliver carried load first" —
     // abandon the active route so the replanner produces a fresh
     // carry-deliver route on the next turn.
     trace.a3.terminationReason = 'route_abandoned_low_cash_carry';
     routeAbandonedByImpossibility = true;
     break;
   } else {
     // existing build-target flow
     const a3TargetCoord = ...; // existing logic
     ...
   }
   ```

   Existing `routeAbandonedByImpossibility` flag (declared earlier in the function, set by JIRA-233's impossibility path) already triggers the route-abandon return at lines 539-541.

4. **Update other call sites** of `resolveBuildTarget`. The grep is small — `BuildPhasePlanner.ts`, possibly `BuildAdvisor.ts`. Each call site should treat `kind: 'abandon'` as today's `null` (skip the build), but the planner-level code (MovementPhasePlanner) is the only one that needs to invoke the abandon signal.

### Why option B is better

- Single decision point (the gate) emits a single signal.
- Reuses an existing kill-switch path (`routeAbandonedByImpossibility`).
- The replanner already handles fresh re-planning when a route is abandoned — and the new plan will be a single-stop "carry → deliver Wheat@Berlin", correctly producing income before any further building.
- No changes to A2's stop-iteration logic — preserves the invariant that A2 only processes the current stop.
- No changes to the JIRA-165 gate's economic intent — the gate still suppresses building; it just signals abandon instead of silently letting A3 PassTurn.

## Tests

`src/server/__tests__/ai/routeHelpers.test.ts`:
- AC1/AC2/AC4/AC5 — direct unit tests of `resolveBuildTarget` against the new return shape. Existing tests need updates because the function's return type changes.

`src/server/__tests__/ai/MovementPhasePlanner.test.ts`:
- One integration test asserting: given fixture matching s1's T16 state, planner returns a result with `routeWasAbandoned: true` and `outputPlan` empty (no PassTurn).

## Risk

- **Type change to `resolveBuildTarget` return**: medium blast radius. Every call site needs updating. Mitigated by TypeScript catching the call-site mismatches at compile time.
- **Route-abandon side effects**: when a route is abandoned, the bot's `lastAbandonedRouteKey` memory is updated and the planner avoids re-selecting the same key for one turn. This is fine — the new route should not be the same key (it'll be a single-stop carry-deliver, not the multi-stop pickup-deliver-deliver).
- **No regression on the JIRA-165 intent**: the gate still fires in the same conditions; it just emits a more useful signal.

## Not in scope

- Option A redirect-style fix (rejected above).
- JIRA-247 `origin_is_current_position` (separate fix, separate file).
- Tuning the $5M threshold or the deliverable-on-network detection (those are tested and working in JIRA-165).
