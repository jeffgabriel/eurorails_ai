# JIRA-170: InitialBuildPlanner misses shared-pickup double delivery

## Summary

When two demand cards require the **same load type from the same supply city** but deliver to different (nearby) cities, the InitialBuildPlanner fails to recognise the shared-pickup opportunity. Instead of picking up 2 loads simultaneously and delivering sequentially, the pairing code models a serial chain that returns to the supply city between deliveries, inflating cost beyond the 40M budget cap and filtering the pairing out entirely.

## Observed behaviour

Game `c4382499-67a3-4096-8ad0-8cbff35a5737`, player Haiku, turn 2:

| Card | Load | Supply | Delivery | Payout |
|------|------|--------|----------|--------|
| 139 | Potatoes | Lodz | Beograd | 20M |
| 40 | Potatoes | Lodz | Sarajevo | 22M |

- `initialBuildPairings: []` — no pairings evaluated.
- Bot chose single delivery: Potatoes Lodz→Beograd (20M, efficiency -0.73).
- The 22M Sarajevo delivery was left on the table despite sharing the exact same pickup city.

## Root cause

`computeDoubleDeliveryPairings()` always generates routes as:

```
pickup(first@supply) → deliver(first) → pickup(second@supply) → deliver(second)
```

For shared-supply pairs this produces: Lodz→Beograd→**Lodz**→Sarajevo — a round-trip back to the supply city that:
1. Adds ~15+ hex chain distance (Beograd→Lodz)
2. Adds ~15M+ chain leg build cost
3. Pushes `totalBuildCost` well above `MAX_BUILD_BUDGET` (40M)
4. The pairing is filtered out at line 294

The code never considers that a Freight train (capacity 2) can pick up **both loads in a single stop** and deliver them sequentially without returning.

## Expected behaviour

When two options share the same `supplyCity` and `loadType` (but different `cardId`), the planner should generate a **shared-pickup route**:

```
pickup(both@Lodz) → deliver(closer, e.g. Beograd) → deliver(farther, e.g. Sarajevo)
```

This eliminates the chain leg entirely. The estimated route for this game:
- Build: Wien→Lodz (14M) + Lodz→Beograd (15M) + Beograd→Sarajevo (~5-8M) ≈ 34-37M
- Payout: 42M combined
- Efficiency: significantly better than the single 20M delivery chosen

## Proposed fix

In `InitialBuildPlanner.computeDoubleDeliveryPairings()`:

1. **Detect shared-pickup pairs**: when `a.supplyCity === b.supplyCity && a.loadType === b.loadType`, branch into a shared-pickup scoring path.

2. **Generate shared-pickup route shape**:
   - Single pickup stop at the shared supply city (both loads)
   - Two delivery stops ordered by proximity (closer first, farther second)
   - Route: `pickup(both) → deliver(closer) → deliver(farther)`

3. **Cost calculation** for shared-pickup:
   - `totalBuildCost = first.buildCostToSupply + first.buildCostSupplyToDelivery + deliveryChainCost`
   - Where `deliveryChainCost` = costBetween(firstDelivery, secondDelivery)
   - No chain-back-to-supply leg needed

4. **Travel time** for shared-pickup:
   - `travelTurns = ceil(startToSupply + supplyToFirstDelivery + firstToSecondDelivery) / speed`
   - No double-counting the supply visit

5. **Capacity gate**: only allow shared-pickup when `trainCapacity >= 2` (always true for Freight, but guard for future train types).

6. **Delivery ordering heuristic**: try both orderings (A then B, B then A) and pick whichever minimises total distance from supply through both deliveries.

## Files to modify

- `src/server/services/ai/InitialBuildPlanner.ts`
  - `computeDoubleDeliveryPairings()` — add shared-pickup detection branch
  - `scorePairing()` or new `scoreSharedPickupPairing()` — cost/travel model without chain leg
  - `planInitialBuild()` — route shape for shared-pickup (single pickup stop, two deliver stops)

## Test plan

- [ ] Unit test: two demands with same loadType + same supplyCity produce a shared-pickup pairing
- [ ] Unit test: shared-pickup pairing has lower totalBuildCost than serial chain equivalent
- [ ] Unit test: delivery ordering picks closer city first
- [ ] Unit test: capacity gate prevents shared-pickup when train is already carrying a load (edge case for future)
- [ ] Unit test: shared-pickup with one remote delivery city still respects REMOTE_DELIVERY_CITIES filter
- [ ] Integration: replay game c4382499 scenario — Haiku should select Potatoes double delivery to Beograd+Sarajevo
- [ ] Regression: existing serial-chain pairings (different supply cities) still work correctly

## Severity

Medium — missed income opportunity of 22M on the second delivery, plus the track built toward Beograd would have been partially reusable for Sarajevo. Compounds to multi-turn efficiency loss.
