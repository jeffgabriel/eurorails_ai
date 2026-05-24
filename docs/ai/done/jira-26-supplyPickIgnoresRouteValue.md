# JIRA-26: Bot Picks Cheapest Supply City, Ignores Route Value

Game: `64db2f6d-4c7c-43c4-bcac-cbe628a5df32` (bot: Haiku)

---

## What Happened

Haiku holds card 132: Cars→Nantes for 51M — the highest payout on any of its 9 demands. Cars are available at Manchester, Munchen, Stuttgart, and Torino. The bot chose Chocolate@Bruxelles→Newcastle for 21M instead.

The 51M payout is obvious. The Nantes delivery city is cheap to reach. Stuttgart as a supply city creates a corridor through Paris, Lyon, Frankfurt, and Luxembourg — the heart of the European rail network. Starting at Paris, building east to Stuttgart, then delivering west to Nantes connects core infrastructure the bot needs for the rest of the game.

Instead, the bot picked a 21M delivery that loses money on track cost (ROI: -11M) because the Bruxelles→Newcastle corridor happens to pass near more cities.

---

## Why It Happened

The scoring pipeline has two steps that don't talk to each other:

**Step 1 — Pick the supply city.** For each demand, `findBestSupplyCity` selects the supply city closest to the bot's track (or closest to any major city at cold start). For Cars, it picks **Manchester** (4 hexes from London) over **Stuttgart** (8 hexes from Wien). Manchester is cheaper to reach. Done.

**Step 2 — Score the route.** `computeCorridorValue` measures how many cities the supply→delivery corridor passes through, then `scoreDemand` combines ROI, corridor cities, and victory major cities into a final score. But the corridor depends entirely on which supply city was chosen in step 1.

The result:

| Route | Supply cost | Delivery cost | ROI | Corridor cities | Victory majors | Score |
|-------|-----------|-------------|-----|----------------|---------------|-------|
| Cars: Manchester→Nantes | 6M | 27M | +18M | 4 | 1 | **25.6** |
| Cars: Stuttgart→Nantes | 12M | 28M | +11M | 8 | 2 | **45.8** |
| Chocolate: Bruxelles→Newcastle | 8M | 24M | -11M | 7 | 2 | **38.8** |

Stuttgart costs 6M more to reach than Manchester. But the Stuttgart→Nantes corridor passes through 8 cities including 2 victory majors (Paris, Wien), scoring **45.8** — the best of any demand. The Manchester→Nantes corridor misses most of central Europe, scoring only **25.6**. The bot never sees the Stuttgart option because `findBestSupplyCity` already locked in Manchester.

Chocolate→Newcastle wins at **38.8** despite negative ROI because its corridor bonus (+41 from 7×3 + 2×10) overwhelms the -11M loss. The bot chooses a money-losing delivery over a 51M delivery because the scoring rewards geography over economics when the supply city is wrong.

---

## Bug 1 (High): Supply city selection ignores route value

`findBestSupplyCity` optimizes for one thing: minimizing distance from the bot's track to the supply city. It doesn't consider:
- The delivery city (where the load is going)
- The corridor value (what cities the route passes through)
- The payout (whether the savings justify a worse route)

At cold start, it picks the supply city closest to any major city. That's Manchester (4 from London) over Stuttgart (8 from Wien). This decision is locked in before the corridor is even computed.

**What should happen:** Evaluate all supply cities for a given demand, compute the full score (ROI + corridor + victory) for each, and pick the supply city that maximizes the final demand score. The 6M extra cost of Stuttgart is trivially repaid by the 20-point score improvement.

---

## Bug 2 (Medium): Corridor bonus overwhelms economics

The score formula is: `(ROI / estimatedTurns) + networkCities × 3 + victoryMajorCities × 10`

Two victory cities add +20. Seven network cities add +21. A route with -11M ROI and a good corridor beats a route with +18M ROI and a mediocre corridor. The corridor bonus is an absolute number, not scaled to the payout or turn count.

In the early game, corridor value matters — building toward major cities is strategically important. But the current weights let a 21M money-losing delivery beat a 51M profitable delivery. The magnitude is off.

**What should happen:** Either scale the corridor bonus relative to the payout (so a 51M delivery's corridor is weighted more than a 21M delivery's), or cap the corridor bonus so it can't flip the sign of a clearly better economic option. A 30M payout advantage should not be overcome by 3 extra corridor cities.

---

## Suggested Fix

### Fix for Bug 1: Evaluate all supply cities per demand

In `computeDemandContext`, instead of calling `findBestSupplyCity` once and locking in the result:

1. Get all supply cities for the load type
2. For each supply city, compute the full demand context (track cost, corridor value, score)
3. Return the demand context with the highest final `demandScore`

This is a loop around the existing logic — the per-supply-city computation already exists, it just needs to run for each candidate instead of one.

```
// Pseudocode change in computeDemandContext:
const allSupplyCities = getSupplyCitiesForLoad(loadType);
let bestContext = null;
for (const supplyCity of allSupplyCities) {
  const context = computeContextForSupply(supplyCity, deliveryCity, ...);
  if (!bestContext || context.demandScore > bestContext.demandScore) {
    bestContext = context;
  }
}
return bestContext;
```

### Fix for Bug 2: Scale corridor bonus by payout

Replace the absolute corridor bonus with a payout-relative one:

```
// Current:
score = (ROI / estimatedTurns) + networkCities * 3 + victoryMajorCities * 10

// Proposed:
corridorMultiplier = 1 + (networkCities * 0.05) + (victoryMajorCities * 0.15)
score = (ROI / estimatedTurns) * corridorMultiplier
```

This way, a route with good corridor value gets a percentage boost, not a flat bonus. A 51M delivery with 2 victory cities gets a bigger absolute bonus than a 21M delivery with the same corridor. The economics remain the primary driver, with corridor value as a tiebreaker/multiplier.

---

## Summary

| # | Severity | Bug | Impact |
|---|----------|-----|--------|
| 1 | High | Supply city selection ignores route value — picks cheapest, not best | Best demand (51M) scored with wrong supply city |
| 2 | Medium | Corridor bonus is absolute, not relative to payout — geography overwhelms economics | 21M money-losing delivery beats 51M profitable delivery |
