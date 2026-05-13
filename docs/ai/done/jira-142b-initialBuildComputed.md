# JIRA-142b: Initial Build Phase — Computed Opening Plan (No LLM)

## Summary

Replace the LLM call during the initial build phase (turns 1-2) with a pure computational approach. The opening decision is an optimization problem on known inputs — no opponent track, no existing network, no cargo, no ambiguity. Score all viable demand pairings, pick the best, output a starting city + route.

This eliminates LLM latency, retry loops, and prompt engineering for a phase where the LLM adds no strategic value beyond arithmetic the scorer can handle.

## Goal

A synchronous, zero-latency function that outputs:
1. A **starting major city** to build from
2. A **full route plan** — ideally a double delivery (pickup A → deliver A → pickup B → deliver B)
3. A **build direction** for the first two 20M track-building turns

The route plan persists as the bot's `activeRoute`. No LLM call until a strategic event requires one (e.g., first delivery completed + new demand card drawn). No second computation on turn 2 — BuildAdvisor/computeBuildSegments continues building toward the route.

---

## The Demand Matrix

Each player holds **3 demand cards × 3 demands per card = 9 demands**. Each demand needs a load type supplied from **2-4 cities**. The algorithm must choose:

1. Which demand to pursue from each card (only one per card can be fulfilled)
2. Which supply city to use for each chosen demand
3. Which major city to start building from
4. Whether two (or three) demands chain into a multi-delivery route

---

## Algorithm

### Step 1: Expand all options

For each of the 9 demands, enumerate every supply city. For each (demand, supply city) pair, compute against every major city:

```typescript
type DemandOption = {
  cardId: number;           // which of the 3 cards
  demandIndex: number;      // which of the 3 demands on that card
  loadType: string;
  supplyCity: string;
  deliveryCity: string;
  payout: number;
  startingCity: string;     // best major city for this option
  buildCostToSupply: number;
  buildCostSupplyToDelivery: number;
  totalBuildCost: number;
  ferryRequired: boolean;
  estimatedTurns: number;
  efficiency: number;       // (payout - totalBuildCost) / estimatedTurns
};
```

For each (demand, supply city) pair, pick the starting major city that minimizes `totalBuildCost`. Discard options where:
- `ferryRequired === true` (filtered, not scored)
- `totalBuildCost > 40` (unaffordable within 2-turn budget)
- `startingCity === 'Madrid'` (hard block)
- Load is not available at the supply city (runtime chip check)

### Step 2: Score single deliveries

Rank all surviving options by `efficiency`. Keep the top single-delivery fallback:

```
bestSingle = max(options, by: efficiency)
```

### Step 3: Score double-delivery pairings

For each cross-card pair of surviving options (card A demand × card B demand), compute a pairing score:

```typescript
type Pairing = {
  first: DemandOption;      // pickup A → deliver A
  second: DemandOption;     // pickup B → deliver B
  sharedStartingCity: string | null;
  chainDistance: number;    // hex distance from first.deliveryCity to second.supplyCity
  totalBuildCost: number;   // deduplicated — shared track segments counted once
  totalPayout: number;
  estimatedTurns: number;
  efficiency: number;       // (totalPayout - totalBuildCost) / estimatedTurns
};
```

**Pairing rules:**
- `first.cardId !== second.cardId` (can't pick two demands from the same card)
- Prefer `first.startingCity === second.startingCity` (shared hub)
- If starting cities differ, the pairing is still valid but penalized
- `totalBuildCost` must account for shared track: if first's route overlaps second's, don't double-count. Use segment deduplication or estimate overlap from hex proximity
- `chainDistance` measures how well delivery A flows into pickup B — lower is better
- Ferry filter: discard pairings where either leg requires ferry, UNLESS both legs are non-ferry and only the starting city access requires ferry (London/Milano double-delivery exception)
- `totalBuildCost <= 40` (hard budget cap)

**Scoring formula:**

```
pairingScore = efficiency * 100
             + chainBonus                    // +20 if chainDistance <= 3 hexes
             + hubBonus                      // +15 if shared starting city
             - ferryPenalty                  // -50 if any ferry involved
             - peripheralPenalty             // -30 if starting city is London/Milano
```

### Step 4: Score triple-delivery pairings (optional)

For each combination of 3 options (one per card), check if they chain within 40M budget. Same scoring as Step 3 but extended. Triples are rare — most won't fit within 40M. Skip this step if no triples are found within budget.

### Step 5: Pick the winner

Compare the best double (or triple) against the best single:

```
if bestDouble.efficiency >= bestSingle.efficiency * 0.7:
    pick bestDouble    // double delivery unless dramatically worse per-turn
else:
    pick bestSingle    // single delivery is much more efficient
```

The 0.7 threshold favors doubles — a double at 70% the per-turn efficiency of a single is still better because it earns two payouts and builds more useful track.

### Step 6: Output

```typescript
type InitialBuildPlan = {
  startingCity: string;
  route: RouteStop[];       // same format as existing StrategicRoute.stops
  buildPriority: string;    // "toward <first supply city>"
  totalBuildCost: number;
  totalPayout: number;
  estimatedTurns: number;
};
```

This gets stored as the bot's `activeRoute` in `BotMemory`, and `startingCity` is stored for `autoPlaceBot` on turn 3.

---

## Build cost deduplication for pairings

The trickiest part of scoring pairings is avoiding double-counting shared track. Two approaches:

**Approach A: Segment-level dedup (accurate, expensive)**
Run `computeBuildSegments` for both legs, merge segment sets, sum unique costs. Accurate but requires pathfinding for every pairing candidate.

**Approach B: Hub-based estimation (fast, good enough)**
If both demands share a starting city, estimate overlap as:
```
sharedTrack = max(0, (first.buildCostToSupply + second.buildCostToSupply) - hexDistance(first.supplyCity, second.supplyCity) * avgCostPerHex)
totalBuildCost = first.totalBuildCost + second.totalBuildCost - sharedTrack
```
This is a rough approximation but avoids pathfinding during candidate scoring. The exact cost is validated after selection.

**Recommendation:** Use Approach B for candidate ranking (fast), then validate the winner with Approach A (accurate). If the winner exceeds 40M after accurate costing, fall back to the next-best candidate.

---

## Edge cases

1. **All 9 demands require ferry**: Pick the cheapest single delivery. The ferry filter is a preference, not a hard block — if nothing else exists, use a ferry route.

2. **All 9 demands exceed 40M budget**: Pick the cheapest single delivery even if it exceeds budget — the bot will build what it can in 2 turns and continue building on subsequent turns. Flag this in logs.

3. **Multiple candidates with identical scores**: Tiebreak by lower `totalBuildCost` (conserve cash for post-build movement turns).

4. **Load unavailable at all supply cities for a demand**: That demand is dead — exclude it from all candidates. If an entire card has no available demands, the bot effectively has 2 cards to work with.

---

## What changes at a high level

| Component | Change |
|-----------|--------|
| New file: `InitialBuildPlanner.ts` | Pure computational planner — no LLM dependency |
| `ContextBuilder.ts` | New `expandAllDemandOptions()` — enumerates all 9 demands × supply cities with costs per starting city |
| `AIStrategyEngine.ts` | When `isInitialBuild`, call `InitialBuildPlanner` instead of TripPlanner/LLMStrategyBrain |
| `BotMemory` | Store `startingCity` from the plan for `autoPlaceBot` on turn 3 |
| `estimateInitialBuildCost()` | Modify to accept a specific supply city and return which major city it computed from |

---

## Advantages over JIRA-142 (LLM approach)

- **Zero latency** — no API call, no retry loop, no prompt engineering
- **Deterministic** — same hand always produces the same plan (easier to test and debug)
- **No token cost** — saves an LLM call per game
- **No prompt drift** — computational logic doesn't degrade when model versions change
- **Testable** — unit tests can cover every edge case with known inputs/outputs
