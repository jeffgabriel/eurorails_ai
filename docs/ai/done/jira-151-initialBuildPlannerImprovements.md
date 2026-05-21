# JIRA-151: InitialBuildPlanner — Double Delivery & Scoring Fixes

## Problem

Game 31566b20 revealed that the InitialBuildPlanner missed an obvious double delivery: Cheese Holland→Berlin (ECU 10M) + Potatoes Szczecin→Ruhr (ECU 11M). A human would immediately see this chain — deliver at Berlin, pick up Potatoes at nearby Szczecin, deliver to Ruhr back toward Holland. Instead the bot chose single-delivery Cheese only, wasted T4 sitting in Berlin with no built track to the obvious next pickup - potatoes in Szczecin.

Root cause analysis revealed 5 defects in the planner, one outright bug and four scoring/estimation issues that make the algorithm miss viable pairings or misjudge their value.

### Important context: why NOT to over-engineer this

The bot holds 3 demand cards (9 demands). After two deliveries, 2 of those 3 cards are discarded and replaced. The 9 demands are **not** a strategic foundation for the future of the game — they're ephemeral. The initial build phase should focus on:
- **Solvency** — generate cash quickly to fund the Fast Freight upgrade (ECU 20M)
- **Efficiency** — maximize payout per turn of invested capital
- **Leveraging deployed capital** — track built for delivery A should serve delivery B when possible

It is **not** the right time to score victory city connectivity or network value for future undrawn cards. Starting at the supply city (as Holland→Berlin in this game) is often correct — proximity to the load matters more than hub centrality at this stage.

---

## Fix 1: Different-hub cost overestimation (BUG)

**File:** `src/server/services/ai/InitialBuildPlanner.ts` — `scorePairing()` line 343-345

**Current behavior:** When two options have different starting cities, `totalBuildCost = first.totalBuildCost + second.totalBuildCost`. This naively sums both full costs, ignoring that chaining through `first.deliveryCity → second.supplyCity` can replace the second option's `startingCity → supplyCity` leg.

**Game evidence:**
- Cheese Holland→Berlin: totalBuildCost=19 (start=Holland)
- Potatoes Szczecin→Ruhr: totalBuildCost=23 (start=Berlin)
- Naive sum: 19+23=42 > MAX_BUILD_BUDGET(40) → **filtered out**
- Correct: 19 + min(23, chainCost(Berlin→Szczecin) + 6) ≈ 32 → within budget

**Fix:** In the different-hub branch, compute the chain leg cost from `first.deliveryCity` to `second.supplyCity` using `costBetween()`. Use `min(second.totalBuildCost, chainLegCost + second.buildCostSupplyToDelivery)` for the second leg.

```typescript
// Different hubs: check if chaining through first.deliveryCity is cheaper
const chainLegCost = /* min costBetween over firstDeliveryPoints × secondSupplyPoints */;
const chainedSecondCost = chainLegCost + second.buildCostSupplyToDelivery;
totalBuildCost = first.totalBuildCost + Math.min(second.totalBuildCost, chainedSecondCost);
```

---

## Fix 2: Always prefer double delivery if within budget (SCORING)

**File:** `src/server/services/ai/InitialBuildPlanner.ts` — `scorePairing()` line 356 and `planInitialBuild()` line 91

**Current behavior:** `chainDistance <= 3 ? 20 : 0` — binary cliff. Separately, `planInitialBuild` requires the double to be >= 70% as efficient per-turn as the single (line 91). Both are arbitrary filters that reject viable doubles.

**Why this is wrong:** A second delivery in the opening is not a nice-to-have. After delivery 1, the player has less cash than at game start. The second delivery generates income, turns over a demand card for a better hand, and the detour track serves future turns. Negative per-delivery ROI is normal when laying initial network. The only constraint that matters is the one that already exists: `totalBuildCost <= MAX_BUILD_BUDGET (40M)`.

**Fix:** Remove the chain bonus cliff and the 70% efficiency gate. Replace both with a single rule: **prefer the best double delivery that fits within the build budget. Fall back to single only if no within-budget double exists.** The budget cap already filters out unaffordable plans — no additional gates needed.

```typescript
// Best double that fits in budget (already filtered by MAX_BUILD_BUDGET in computeDoubleDeliveryPairings)
const bestDouble = pairings.length > 0
  ? pairings.reduce((a, b) => a.pairingScore > b.pairingScore ? a : b)
  : null;

// Double always wins if one exists within budget — single is fallback
if (bestDouble) {
  // use bestDouble
} else {
  // use bestSingle
}
```

The `pairingScore` still ranks doubles by efficiency + hub bonus for tie-breaking — but no double is rejected for being "not efficient enough." If it fits in the 2-turn build budget, it's a go.

---

## Fix 3: Inconsistent cost model between branches (SCORING)

**File:** `src/server/services/ai/InitialBuildPlanner.ts` — `scorePairing()` line 341

**Current behavior:** The shared-hub branch estimates chain cost as `chainDistance * 1.5` (hex distance × rough multiplier), while `expandDemandOptions` and `estimateBuildCostFromCity` use `costBetween()` which calls `estimatePathCost()` for terrain-aware estimates. The two branches of `scorePairing` use incomparable cost models.

**Fix:** Replace `chainDistance * 1.5` in the shared-hub branch with a proper `costBetween()` loop over `firstDeliveryPoints × secondSupplyPoints`, identical to the approach used in Fix 1. Both branches should use the same cost model.

```typescript
// Compute chain leg cost using costBetween (same as different-hub branch after Fix 1)
let minChainCost = Infinity;
for (const dp of firstDeliveryPoints) {
  for (const sp of secondSupplyPoints) {
    const cost = InitialBuildPlanner.costBetween(dp.row, dp.col, sp.row, sp.col);
    if (cost < minChainCost) minChainCost = cost;
  }
}
const chainCost = minChainCost === Infinity ? chainDistance * 1.5 : minChainCost;
```

This code is shared by both branches — extract it above the `if (sharedStartingCity)` block.

---

## Fix 4: estimatedTurns conflates build cost with travel distance (ESTIMATION)

**File:** `src/server/services/ai/InitialBuildPlanner.ts` — lines 173-175 and 350-352

**Current behavior:**
- Single: `travelTurns = Math.ceil(costs.totalBuildCost / speed) + 1`
- Double: `travelTurns = Math.ceil(totalBuildCost / speed) + 2`

This uses ECU build cost as a proxy for mileposts traveled. But terrain costs vary wildly: alpine = 5M/milepost, clear = 1M/milepost, major city = 5M/milepost. A 20M build through mountains could be 6 mileposts of actual travel, while a 20M build across clear terrain is 20 mileposts.

**Fix:** Use hex distance (which approximates milepost count) instead of build cost for travel estimation. The `hexDistance` between points is already computed for chain distance — extend this to the full route.

For single deliveries in `expandDemandOptions`:
```typescript
// Travel distance in mileposts (hex distance), not build cost
const travelDistance = hexDistance(startPt, supplyPt) + hexDistance(supplyPt, deliveryPt);
const travelTurns = Math.ceil(travelDistance / speed);
const estimatedTurns = Math.max(buildTurns + travelTurns, 1);
```

For pairings in `scorePairing`:
```typescript
// Sum hex distances for full route: start→supply1→delivery1→supply2→delivery2
const firstLegDistance = /* hex distance start→supply1 + supply1→delivery1 */;
const chainLegDistance = chainDistance; // already computed
const secondLegDistance = /* hex distance supply2→delivery2 */;
const totalTravelDistance = firstLegDistance + chainLegDistance + secondLegDistance;
const travelTurns = Math.ceil(totalTravelDistance / speed);
```

Note: the DemandOption type may need a `travelDistance` field, or the hex distances can be passed into `scorePairing`. The hex distance lookups already happen for chain distance — extend the same pattern.

---

## Acceptance Criteria

- [ ] Pairing Cheese(Holland→Berlin) + Potatoes(Szczecin→Ruhr) from game 31566b20 is selected as a double delivery
- [ ] Double delivery is preferred over single whenever it fits within MAX_BUILD_BUDGET
- [ ] Both scorePairing branches use `costBetween()` for chain leg cost estimation
- [ ] estimatedTurns uses hex distance (milepost proxy), not build cost, for travel time
- [ ] The 70% efficiency threshold and chain distance cliff are removed
- [ ] All existing InitialBuildPlanner tests pass
- [ ] New tests cover: chain-through-delivery-city cost, double-preferred-over-single within budget, turn estimation with hex distance

## Files Affected

- `src/server/services/ai/InitialBuildPlanner.ts` — all 4 fixes
- `src/server/__tests__/ai/InitialBuildPlanner.test.ts` — new test cases
- `src/shared/types/GameTypes.ts` — possibly extend DemandOption with `travelDistance` field

## Estimated Scope

Standard tier. Single service file + tests. No API, UI, or schema changes.
