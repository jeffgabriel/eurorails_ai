# JIRA-150: victoryBonus Inflates Cross-Water Demand Scores

## Source
Game `d11d47a8` T21 — Haiku demand ranking shows Beer(Dublin)→Lisboa as #5 (score -0.374) above Wine(Wien)→Paris at #6 (score -0.484), despite Dublin→Lisboa costing 144M/23 turns vs Wien→Paris costing 20M/6 turns.

## Problem

`scoreDemand()` (ContextBuilder.ts:2327) adds a `victoryBonus` term computed from `victoryMajorCities` — the count of unconnected major cities within 5 hexes of the supply→delivery corridor. The corridor is computed by `computeCorridorValue()` using straight-line `hexDistance` (Chebyshev) which ignores water barriers.

### How the corridor inflates cross-water routes

For Beer(Dublin→Lisboa) with bot at (28,62):
1. `computeCorridorValue` draws checkpoints: `trackEndpoint(~26,40) → Dublin(10,24) → Lisboa(44,15)` plus midpoints between each pair
2. The midpoint between continental track and Dublin (~18,32) lands in the Netherlands/Belgium area — near Amsterdam, Bruxelles, Köln
3. Dublin itself sweeps Edinburgh, Glasgow, Belfast within radius 5
4. The midpoint Dublin→Lisboa (~27,19) lands in Atlantic France
5. With CORRIDOR_RADIUS=5, ~15-20 unconnected major cities fall within this diagonal arc

The `victoryBonus = (victoryMajorCities * max(payout * 0.15, 5)) / estimatedTurns`:
- With ~20 major cities, payout=46M: `(20 * 6.9) / 23 ≈ +6.0`
- This overwhelms the terrible baseROI of -4.26, producing score -0.374

### Why Wine(Wien→Paris) scores worse

Wine has baseROI = (11-20)/6 = -1.5 — much better economics. But its corridor from Ruhr area → Wien → Paris is a compact band through central Europe with only ~2 unconnected major cities. The victoryBonus adds ~1.0, giving final score -0.484. Without victoryBonus, Wine would rank above Beer.

### Actual T21 ranking data

```
#1 Steel:     Ruhr→Venezia         0M    score= 6.42  eff= 3.17M/turn   6T
#2 Coal:      Wroclaw→Luxembourg  14M    score= 2.35  eff= 1.00M/turn   5T
#3 Cattle:    Bern→Beograd        25M    score= 0.87  eff= 0.22M/turn   9T
#4 Copper:    Wroclaw→Birmingham  37M    score=-0.17  eff=-0.89M/turn   9T  ferry
#5 Beer:      Dublin→Lisboa      144M    score=-0.37  eff=-4.26M/turn  23T  ferry  ← BUG
#6 Wine:      Wien→Paris          20M    score=-0.48  eff=-1.50M/turn   6T  ← should rank above Beer
#7 Cheese:    Holland→Madrid      83M    score=-0.51  eff=-3.79M/turn  14T
#8 Chocolate: Bruxelles→Torino    28M    score=-0.52  eff=-2.22M/turn   9T
#9 Iron:      Kaliningrad→Nantes  42M    score=-0.58  eff=-2.09M/turn  11T
```

### Root cause

`computeCorridorValue` uses `hexDistance` (Chebyshev) which is straight-line and water-unaware. Any route with endpoints far apart geographically (especially cross-water) sweeps a huge arc across the map, counting dozens of unconnected major cities that the route will never actually pass through. The `victoryBonus` then inflates these routes' scores.

The same bug also causes Dublin to be selected as the Beer supply city over Frankfurt, Praha, or München — the Dublin corridor's inflated victoryBonus produces a higher demandScore even though those continental cities are far cheaper to reach.

## Fix

Remove `victoryBonus` from `scoreDemand()`. The formula becomes:
```typescript
rawScore = baseROI * (1 + corridorMultiplier)
```

The `corridorMultiplier` (based on `networkCities * 0.05`, capped at 0.5) still rewards routes that open up new city access, and it scales with baseROI — so it only amplifies positive-ROI routes, not terrible ones.

Also remove the endgame amplification block (~lines 749-752) that triples `victoryMajorCitiesForScoring` when cash≥250 and cities<7, since it feeds only the removed victoryBonus parameter.

## Files

- `src/server/services/ai/ContextBuilder.ts:2327-2349` — `scoreDemand()`: remove `victoryMajorCities` parameter, `victoryBonus` variable, and its addition to `rawScore`
- `src/server/services/ai/ContextBuilder.ts:749-752` — endgame amplification block: remove (dead code after fix)
- `src/server/services/ai/ContextBuilder.ts:753-758` — `scoreDemand()` call site: remove `victoryMajorCitiesForScoring` argument
- `src/server/__tests__/ai/ContextBuilder.*.test.ts` — update any tests asserting on victoryBonus behavior

## Compounds Project

Project: `Remove victoryBonus from scoreDemand()` — `1ba35091-5f7c-46c0-8464-b4040dc886f7`
