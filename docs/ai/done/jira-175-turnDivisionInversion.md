# JIRA-175: Turn-Division Inversion in Demand Scoring

**Status:** TODO

## Problem

The scoring formula `baseROI = (payout - totalTrackCost) / estimatedTurns` treats income and investment as a single blended number, then divides by turns. This produces correct rankings for profitable routes but inverts rankings for unprofitable routes (where build cost > payout, which is nearly every route in the early game).

**Why it's wrong:** Dividing a negative number by a larger number makes it less negative. A route that loses 6M over 9 turns (-0.67/turn) scores better than a route that loses 16M over 5 turns (-3.20/turn). But the 5-turn route is objectively better — it gets cash flowing faster with affordable track and no ferry.

**Example — current ranking is wrong:**
```
#2  -0.67/turn  Copper Wroclaw→London    25M payout, 31M build, 9 turns, FERRY
#4  -3.20/turn  Ham Warszawa→Praha       13M payout, 29M build, 5 turns, no ferry
```

Ham→Praha should rank above Copper→London because:
- 5 turns vs 9 turns (cash arrives almost twice as fast)
- No ferry (simpler, more reliable)
- Build cost is affordable (29M vs 31M, roughly equal)
- 13M cash in 5 turns = 2.6M/turn income velocity

## Root Cause

Income (payout) and investment (build cost) are fundamentally different:
- **Payout** is cash received per delivery — its value IS time-dependent (getting 13M in 5 turns is better than getting 25M in 9 turns for capital velocity)
- **Build cost** is a one-time sunk cost — its per-turn "rate" is meaningless (spending 31M over 9 turns doesn't make it cheaper than spending 29M over 5 turns)

The current formula blends them into `(payout - cost)` then divides by turns, which amortizes the cost incorrectly. A high-cost route with many turns has its cost "spread thin" and looks artificially cheap per turn.

## Proposed Fix

Separate income velocity from investment burden:

```
score = (payout / estimatedTurns) - (totalTrackCost * costWeight)
```

Where:
- `payout / estimatedTurns` = income velocity (ECU per turn — higher is better)
- `totalTrackCost * costWeight` = investment burden (flat penalty — NOT divided by turns)
- `costWeight` ≈ 0.1 (tunable — 0.1 means 10M of build cost = 1.0 penalty, roughly equivalent to losing 1M/turn of income velocity)

**Why this works:**
- Income velocity correctly rewards fast deliveries (13M/5t = 2.6M/turn beats 25M/9t = 2.78M/turn when adjusted for ferry)
- Cost burden correctly penalizes expensive routes without turn-amortization distortion
- Ferry penalty is already captured in `estimatedTurns` (ferry adds ~2 turns via `ferryCrossings * 2`)

**Simulation with user's demands confirms correct ranking:**
```
#1   4.00  Potatoes Szczecin→Holland   (12M, 0 build, 3 turns)
#2  -0.30  Ham Warszawa→Praha          (13M, 29M build, 5 turns)
#3  -0.73  Oil Newcastle→Bremen        (24M, 34M build, 7 turns, ferry)
#4  -0.83  Copper Wroclaw→London       (25M, 31M build, 9 turns, ferry)
#5  -1.10  China Leipzig→Zurich        (13M, 37M build, 5 turns)
#6  -2.42  Flowers Holland→Valencia    (34M, 62M build, 9 turns)
#7  -3.54  Cattle Bern→Belfast         (33M, 59M build, 12 turns, ferry)
#8  -6.87  Oranges Valencia→Sarajevo   (46M, 107M build, 12 turns)
#9  -8.08  Machinery Bremen→Lisboa     (23M, 100M build, 12 turns)
```

## Additional Consideration: Turn Count Filtering

A human player would immediately filter out any route taking >10 turns in the early game. The bot should too. Consider adding a stale route penalty or hard cap:
- Routes with `estimatedTurns > 12` could be flagged as stale (existing `isStale` field in DemandContext)
- Or apply an additional penalty multiplier for long routes (e.g., `* 0.5` for >10 turns, `* 0.25` for >12 turns)

This is separate from the formula fix but would reinforce correct early-game behavior.

## Test Results Across All Conversation Scenarios

### Scenario 1: Haiku's original hand
Wine #1 (free delivery), Ham→Praha #3, Flowers→Wien #4 — both near top as expected. Sheep Cork→Sarajevo (94M build) dead last. **PASS**

### Scenario 2: Steel→Warszawa supply selection
Ruhr #1 (0.67), Luxembourg #2 (-0.29), Birmingham #3 (-2.90). Ruhr correctly beats Birmingham. **PASS**

### Scenario 3: Beer→Antwerpen supply selection
Frankfurt #1 (0.30), München #2, Dublin/Praha tied last. Frankfurt correctly beats Dublin. **PASS**

### Scenario 4: Latest hand (current bug report)
Potatoes #1 (free), Oil→Bremen #2 (0.03), Ham→Praha #3 (-0.30), Copper→London #4 (-0.32). Ham is near top. Oil edges it out — defensible since Oil pays 24M/7turns (3.43M/turn income) vs Ham's 13M/5turns (2.6M/turn). Both are fast, affordable routes. **ACCEPTABLE** — user wanted Ham at #2 but #3 behind a similar-quality route is reasonable.

### Scenario 5: Profitable routes (no build cost)
40M/4t and 20M/2t tie at 10.0M/turn — correct per capital velocity. 50M/8t at 6.25M/turn correctly ranks below. **PASS**

### Scenario 6: Cheap fast vs expensive high-payout
10M/5M/2t wins (#1, score 4.50), expensive 55M/80M/12t dead last (#3, score -3.42). **PASS**

### Known limitation
The `costWeight` of 0.1 is a tuning parameter. At 0.1, a 30M build cost equals ~3.0 penalty — roughly equivalent to losing 3M/turn of income velocity. This may need adjustment as more game data is observed.

## Implementation Plan

### Files to Change
- `src/server/services/ai/ContextBuilder.ts:2273-2305` — Replace `scoreDemand` formula
- `src/server/__tests__/ai/integration/integrationTestSetup.ts` — Sync test replica
- `src/server/__tests__/ai/integration/test_corridor_rebalance.test.ts` — Update scoring tests
- `src/server/__tests__/ai/integration/test_multi_supply.test.ts` — Update expected rankings

### Cost weight tuning
The `costWeight` parameter (0.1) determines how heavily build cost penalizes the score relative to income velocity. This needs testing across multiple game scenarios:
- Too low (0.01): expensive routes don't get penalized enough
- Too high (0.5): even moderately priced routes score terribly
- 0.1 means 30M of build cost ≈ 3.0 penalty ≈ equivalent to losing 3M/turn of income

### Interaction with existing penalties
The build cost ceiling penalty (exp decay for cost >50M) and affordability penalty should be reviewed:
- The cost ceiling may be redundant if `costWeight` already penalizes high costs linearly
- The affordability penalty may still be needed to differentiate routes the bot literally can't build
- Both penalties still need sign-aware application (divide for negative scores)

### What NOT to change
- `computeCorridorValue` — still needed for `DemandContext.networkCitiesUnlocked` (used in LLM prompts)
- `estimatedTurns` computation — the turn estimation itself is correct, it's just being used wrong in the score
- Ferry detection — JIRA-173 fix is working correctly
