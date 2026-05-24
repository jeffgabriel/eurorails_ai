# JIRA-159: InitialBuildPlanner Starting City Biased Toward Delivery City

**Game:** `96e792c8`
**Bot:** Nano
**Branch:** `compounds/guardrail-updates`

---

## Bug: Starting city selection prefers delivery city over supply-proximate cities

**Severity:** Medium — suboptimal starting position wastes turns and ECU in early game
**Observed:** Nano turn 2

**Symptom:** Nano starts at Paris to deliver Potatoes there, but the supply city (Szczecin) is near Berlin. Starting at Paris means building 32M of track across the entire map to reach Szczecin, then delivering back to Paris for free. Starting at Berlin would cost ~10M to reach Szczecin and ~22M to reach Paris — same total but with a far better network position.

From NDJSON pairing data:

| Rank | Route | Start City | Build Cost | Turns | Efficiency |
|------|-------|-----------|-----------|-------|-----------|
| 1 | Potatoes Szczecin→Paris | **Paris** | 32M | 9 | -0.60 |
| 3 | Oil Beograd→München | Wien | 28M | 7 | -0.94 |
| 4 | China Leipzig→Kaliningrad | Berlin | 25M | 6 | -0.94 |
| 6 | Machinery Bremen→Praha | Berlin | 21M | 6 | -1.00 |

Potatoes ranks #1 despite being the most expensive option with the most turns. Options starting at Berlin (closer to supply cities) rank worse despite better economics.

**Root cause:** `InitialBuildPlanner.expandDemandOptions()` evaluates each major city as a starting point and picks the one with the lowest `totalBuildCost` (line 255). When the delivery city IS a major city (Paris), starting there makes `buildCostSupplyToDelivery = 0` (you're already at the delivery destination). The `totalBuildCost` becomes just `buildCostToSupply` (Paris→Szczecin = 32M).

Starting at Berlin would compute:
- `buildCostToSupply` = Berlin→Szczecin ≈ 10M
- `buildCostSupplyToDelivery` = Szczecin→Paris ≈ 22M (or Berlin→Paris via hub routing ≈ 22M)
- `totalBuildCost` = 32M (same total)

But the winner selection at line 255 picks `bestForPair` by lowest `totalBuildCost`. Both Berlin and Paris give ~32M total, but Paris wins ties because it's evaluated first (or due to minor cost estimation differences).

The real problem is that **total build cost alone is the wrong metric for selecting starting city.** Two options with the same build cost are NOT equivalent — starting at Berlin gives a central network position for future deliveries, while starting at Paris gives a peripheral position. The efficiency formula (`contextScore` path) then amplifies Paris because it's a victory-required major city.

**What should happen:** Nano should start at Berlin (or Ruhr):
- Berlin→Szczecin: ~10M build, pick up Potatoes
- Then build toward Paris: ~22M over multiple turns
- Network runs through central Europe — useful for future deliveries
- Berlin is a major city too, so victory progress is equivalent

**Fix considerations:**
1. When selecting `bestForPair` starting city, prefer supply-proximate starting cities over delivery-proximate ones — the bot needs to reach the supply city first
2. Add a tie-breaker that favors central network positions (Berlin, Ruhr, Wien) over peripheral ones (Paris, London, Madrid)
3. Consider penalizing starting cities where the bot must traverse the entire route before earning any payout (Paris start means 32M spent before any revenue)
