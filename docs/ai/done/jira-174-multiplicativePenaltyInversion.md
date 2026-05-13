# JIRA-174: Scoring Formula Simplification — Remove Corridor Multiplier

**Status:** In Progress

## Background

JIRA-173 fixed the corridor multiplier inversion (Bug #4) by dividing instead of multiplying when baseROI < 0. This revealed Bug #5: the build cost ceiling and affordability penalties also invert for negative scores (same root cause — multiplicative penalties on negative values).

Commit `73972d0` fixed Bug #5 with sign-aware division. However, further analysis shows the corridor multiplier adds no ranking value — with or without it, the demand rankings are identical because cost and turn estimates already capture geographic advantage.

## Problem: Corridor multiplier adds complexity without value

**Verified by simulation:** Running the same demand set with and without the corridor multiplier produces identical rankings. The corridor was the root cause of Bugs #2 and #4, and its removal eliminates all sign-handling complexity from the formula.

With corridor:
```
#1   4.80  Wine Frankfurt→Szczecin
#2  -0.74  Iron Kaliningrad→Munchen
#3  -2.71  Ham Warszawa→Praha
#4  -3.20  Flowers Holland→Wien
```

Without corridor (same order, simpler math):
```
#1   4.00  Wine Frankfurt→Szczecin
#2  -0.97  Iron Kaliningrad→Munchen
#3  -3.52  Ham Warszawa→Praha
#4  -4.48  Flowers Holland→Wien
```

Supply city selection also works correctly without corridor:
- Beer→Antwerpen: Frankfurt (-4.40) beats Dublin (-9.39) — correct
- Cattle→Berlin: Bern (-1.33) beats Nantes (-6.67) — correct

## Change: Remove corridor multiplier from scoreDemand

**File:** `src/server/services/ai/ContextBuilder.ts`

Remove the `corridorMultiplier` computation and sign-aware branching from `scoreDemand()`. The formula simplifies to:

```
rawScore = (payout - totalTrackCost) / estimatedTurns
```

With cost ceiling and affordability penalties still applied (using sign-aware division from Bug #5 fix).

Also remove:
- `networkCities` parameter from `scoreDemand()` (no longer consumed)
- `computeCorridorValue()` call in `computeSingleSupplyDemandContext()` can be simplified (still needed for `networkCitiesUnlocked` and `victoryMajorCitiesEnRoute` on the DemandContext interface, but no longer feeds into scoring)

**Test changes:**
- Update test replica `scoreDemand()` in `integrationTestSetup.ts` to remove corridor
- Update `test_multi_supply.test.ts` — remove corridor-specific tests, keep supply city selection tests
- Update `test_corridor_rebalance.test.ts` — remove or rewrite corridor multiplier tests

## Benefits
- Eliminates root cause of Bugs #2 and #4 entirely (no corridor = no inversion possible)
- Removes sign-handling branching from formula (simpler, fewer bug surfaces)
- Reduces Wien convergence bias (corridor density no longer inflates scores)
- Formula is auditable: `(payout - cost) / turns` with clear penalty layers
