# JIRA-69: TurnComposer A2 Chain Wastes Movement After Mid-Turn Delivery

## Bug Description

After the bot delivers a load mid-turn (via `splitMoveForOpportunities`), the A2 continuation chain terminates with "no valid target" and the remaining movement budget is wasted. The bot arrives at a city, delivers, then sits idle with 6-8 mileposts unused instead of continuing toward its next objective.

## Evidence

### Game `668c1ab3`, Haiku bot:

**T8**: Bot moves 1mp to Wien, delivers Chocolate, then stops. **8/9 mileposts wasted.**
```
composition.inputPlan: ["MoveTrain"]
composition.outputPlan: ["MoveTrain", "DeliverLoad"]
composition.moveBudget: { total: 9, used: 1, wasted: 8 }
composition.a2.terminationReason: "no valid target"
deliveries: [{ load: "Chocolate", city: "Wien" }]
```

**T14**: Bot moves 3mp to Frankfurt, delivers Oil, then stops. **6/9 mileposts wasted.**
```
composition.inputPlan: ["MoveTrain"]
composition.outputPlan: ["MoveTrain", "DeliverLoad"]
composition.moveBudget: { total: 9, used: 3, wasted: 6 }
composition.a2.terminationReason: "no valid target"
deliveries: [{ load: "Oil", city: "Frankfurt" }]
```

**T4**: Bot picks up Flowers at Holland, moves 3mp, builds track. **6/9 mileposts wasted.**
```
composition.inputPlan: ["PickupLoad"]
composition.outputPlan: ["PickupLoad", "MoveTrain", "BuildTrack"]
composition.moveBudget: { total: 9, used: 3, wasted: 6 }
```

Total: 20 mileposts wasted across 3 delivery/pickup turns (out of 27 possible = 74% waste on those turns).

## Root Cause

**Two stale-data problems in TurnComposer's A2 continuation chain after mid-turn delivery:**

### Problem 1: `activeRoute.currentStopIndex` not advanced after delivery

When `splitMoveForOpportunities` (TurnComposer.ts:530-649) delivers a load mid-move, it calls `ActionResolver.applyPlanToState()` (line 553) which updates `snapshot.bot.loads` and `context.loads`. But **it does not advance `activeRoute.currentStopIndex`** past the completed delivery stop.

When the A2 loop re-enters and calls `findMoveTargets(simContext, activeRoute)` at line 336, Priority 1 (route stops) still points at the just-completed delivery stop. Line 744 checks:
```typescript
if (stop.action === 'deliver' && !context.loads.includes(stop.loadType)) {
  continue; // Skip — bot doesn't have the load (already delivered)
}
```
The delivered load was removed from `context.loads`, so the stop is skipped. If there are no subsequent route stops, **no route-based targets are found**.

Compare: the same-city chain logic at TurnComposer.ts:311 correctly advances the index:
```typescript
activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
```
But `splitMoveForOpportunities` has no equivalent advancement.

### Problem 2: `context.demands` not refreshed after delivery

`applyPlanToState` (ActionResolver.ts:795-806) removes the demand card from `snapshot.bot.resolvedDemands` but **never rebuilds `context.demands`**. The A2 chain's `findMoveTargets` Priority 2 and 3 use `context.demands` to find delivery/supply city targets, but these still reference the old (now-fulfilled) demand card.

After delivery:
- Priority 2 (delivery cities): `context.loads.includes(demand.loadType)` is false (load removed), so no match
- Priority 3 (supply cities): May still match the fulfilled demand's supply city — misleading
- **New demand card drawn after delivery is not reflected** in `context.demands` at all

The JIRA-64 context refresh (`rebuildDemands`) happens in AIStrategyEngine **after** TurnComposer has already returned — too late for the A2 chain.

## Fix

### Part 1: Advance `activeRoute.currentStopIndex` after delivery in `splitMoveForOpportunities`

In `TurnComposer.splitMoveForOpportunities`, after a delivery is resolved at a city, advance the route index if the delivery matches the current route stop:

```typescript
// After line 553 (applyPlanToState for delivery)
if (activeRoute && activeRoute.currentStopIndex < activeRoute.stops.length) {
  const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
  if (currentStop.action === 'deliver' && currentStop.loadType === demand.loadType && currentStop.city === cityName) {
    activeRoute = { ...activeRoute, currentStopIndex: activeRoute.currentStopIndex + 1 };
  }
}
```

Similarly for pickups in the same function.

### Part 2: Refresh `context.demands` after delivery inside TurnComposer

This is more expensive (requires calling `rebuildDemands` from ContextBuilder), but necessary for the A2 chain to find valid targets from newly-drawn demand cards. A lighter approach: after delivery, remove the fulfilled demand from `context.demands` so Priorities 2-3 aren't polluted by stale data:

```typescript
// After delivery in applyPlanToState or in TurnComposer after calling applyPlanToState:
context.demands = context.demands.filter(d => d.cardIndex !== deliverPlan.cardId);
```

This doesn't add new demands (the drawn replacement card), but at least clears stale ones. A full `rebuildDemands` would be ideal but may be too expensive for mid-turn use.

## Affected Files

- `src/server/services/ai/TurnComposer.ts:530-649` — `splitMoveForOpportunities` needs to advance route index after delivery/pickup
- `src/server/services/ai/TurnComposer.ts:336` — `findMoveTargets` call site in A2 loop
- `src/server/services/ai/ActionResolver.ts:795-806` — `applyPlanToState` DeliverLoad case could also clean `context.demands`
- `src/server/__tests__/ai/TurnComposer.test.ts` — test A2 continuation after mid-move delivery

## Impact

Every delivery that happens mid-move (via `splitMoveForOpportunities`) wastes the remaining movement budget. In game 668c1ab3, 20 mileposts were wasted across 3 turns — equivalent to losing ~2 full turns of movement. Over a full game, this accumulates significantly: any time the bot delivers at a city it reaches partway through its movement allowance, the rest of the turn is thrown away.
