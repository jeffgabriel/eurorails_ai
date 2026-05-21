# JIRA-114: Initial Build Targets Demand on Same Card as Active Delivery

## Symptom

Game `00df7daa`, Flash bot, turn 3. Flash's active route is Cattle: Bern → Ruhr (card 39, 19M payout). Both cities are already connected. During initial build, Flash spends 20M building toward Lodz for the Cheese demand (Bern → Lodz, 20M) — but that demand is **on the same card (39)** as the active Cattle delivery. When Flash delivers Cattle on T6, card 39 is discarded and the Cheese→Lodz demand disappears. The 20M of track toward Lodz is completely wasted.

## Timeline

| Turn | Phase | Action | Cash | Notes |
|------|-------|--------|------|-------|
| 1-2 | Initial Build | BuildTrack | 35 | Built Ruhr ↔ Bern corridor (both now reachable) |
| 3 | Initial Build | BuildTrack toward Lodz | 15 | 20M spent building toward Cheese demand (card 39) |
| 6 | Active | Deliver Cattle → Ruhr | 31 | Card 39 discarded — Cheese→Lodz demand gone. Track to Lodz stranded |

Card 39 demands:
- **Cattle** (Bern → Ruhr, 19M) ← active delivery
- **Cheese** (Bern → Lodz, 20M) ← used as secondary build target
- Cars (Stuttgart → Porto, 35M)

After T6, card 39 is replaced by card 30. The Cheese→Lodz demand no longer exists.

## Root Cause

`PlanExecutor.findInitialBuildTarget()` (PlanExecutor.ts:451-470) falls through to the JIRA-80 demand fallback when all route stops are already on-network. It scans `context.demands` for any demand where supply is on-network but delivery isn't:

```typescript
for (const demand of context.demands) {
  if (!demand.isDeliveryOnNetwork && demand.isSupplyOnNetwork) {
    return demand.deliveryCity;  // Returns "Lodz"
  }
}
```

This selects Cheese: Bern → Lodz because Bern is on-network and Lodz is not. **But it does not check whether the demand is on the same card as the active route's delivery.** Building toward a secondary demand is good early-game strategy (zero-profit track has reuse value), but only if that demand will survive the current delivery. Demands on the same card as the active delivery are guaranteed to be discarded.

## Impact

- 20M wasted on track toward a demand that will be discarded
- Flash left with 15M cash after T3
- Partial track toward Lodz is stranded with no demand to justify it

## Proposed Fix

Filter out demands that share a `cardIndex` with the active route's delivery demand before selecting a secondary build target. The active route's delivery card will be discarded on completion, so any demand on that card is not a viable build target.

```typescript
// In findInitialBuildTarget, before the JIRA-80 fallback:
const activeDeliveryCardIndices = new Set<number>();
for (const stop of route.stops) {
  if (stop.action === 'deliver') {
    const matchingDemand = context.demands.find(
      d => d.deliveryCity === stop.city && d.loadType === stop.loadType
    );
    if (matchingDemand) activeDeliveryCardIndices.add(matchingDemand.cardIndex);
  }
}

for (const demand of context.demands) {
  if (activeDeliveryCardIndices.has(demand.cardIndex)) continue; // Will be discarded
  if (!demand.isSupplyOnNetwork && demand.isDeliveryOnNetwork) {
    return demand.supplyCity;
  }
  if (!demand.isDeliveryOnNetwork && demand.isSupplyOnNetwork) {
    return demand.deliveryCity;
  }
}
```

This same card-awareness check should also be applied anywhere the system selects secondary/continuation build targets (e.g., `continuationBuild` in JIRA-73).

## Files

- `src/server/services/ai/PlanExecutor.ts` — `findInitialBuildTarget()` lines 451-470
- `src/server/services/ai/PlanExecutor.ts` — `continuationBuild()` lines 484-556
