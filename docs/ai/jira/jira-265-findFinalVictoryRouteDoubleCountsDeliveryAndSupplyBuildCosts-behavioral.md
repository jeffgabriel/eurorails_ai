# JIRA-265 — `findFinalVictoryRoute` double-counts (a) delivery-build cost when a candidate's delivery city is also in the cheapest-N unconnected majors connector set, and (b) supply-build cost when two demands in a pair/triple share a supply city; both cause genuinely-feasible victory routes to be rejected as infeasible (behavioral)

Static code reading + a one-shot diagnostic test (`src/server/__tests__/ai/victoryRules.jira265-double-count-investigation.test.ts`, since deleted) confirm two independent double-counting bugs in `findFinalVictoryRoute`'s candidate-feasibility math at `src/server/services/ai/victoryRules.ts:372` (single), `:398` (pair), and `:430` (triple):

```ts
// Single-delivery candidate (line 372)
const buildCost = demandBuildCost(d) + connectorCost;

// Pair-delivery candidate (line 398)
const buildCost = demandBuildCost(d1) + demandBuildCost(d2) + connectorCost;

// Triple-delivery candidate (line 430)
const buildCost = demandBuildCost(d1) + demandBuildCost(d2) + demandBuildCost(d3) + connectorCost;
```

Where:

- `demandBuildCost(d) = supplyCost + deliveryCost` (function at `:290`), each computed by `estimateTrackCost(cityName, segments, gridPoints, ...)` in `DemandEngine` at lines 527-528.
- `connectorCost` = sum of `unconnectedMajorCities[0..N].estimatedCost`, each ALSO computed by `estimateTrackCost(cityName, segments, gridPoints)` in `ContextBuilder.computeUnconnectedMajorCities` at line 556.

Both fields are computed by the same `estimateTrackCost` function over the same `segments` and `gridPoints`. When a candidate's `deliveryCity` is in the cheapest-N unconnected-majors set, OR when two demands in a pair share a `supplyCity`, the same build is summed twice.

## Source

Diagnostic-test reproduction (one-shot, deleted after capture). Initial signal: game `8e176094-a679-490f-9406-d6faa7b55723` player s3 in End state T77–T92 with zero `[final-victory]` lines. Discovered 2026-05-24.

## Diagnostic output (verbatim, from deleted test)

### Test 1 — single-demand, delivery city is an unconnected major

Setup: `cashGap=$30M`, 1 unconnected major (Holland, estimatedCost=$20M), 1 demand (Oil→Holland payout=$60M, deliveryCost=$20M, supply on-network).

```
[final-victory] skip: no route covers cashGap=30M + connectorCost=20M
Result: NULL (double-count suppression)
```

Math:

| Path | buildCost | net | cashGap met? |
|------|-----------|-----|--------------|
| Buggy (current code) | `demandBuildCost($20)` + `connectorCost($20)` = **$40** | $60 − $40 = $20 | $20 < $30 — **NO**, returns null |
| De-duplicated | $20 (Holland build counted once) | $60 − $20 = $40 | $40 ≥ $30 — **yes**, route returned |

The Oil→Holland demand IS a feasible single-load victory in this scenario; the bug suppresses it.

### Test 2 — pair-supply double-count (Firenze for both Marbles)

Setup: `cashGap=$30M`, 2 unconnected majors (Milano + Paris, estimatedCost=$12M each), 2 demands (Marble@Firenze → Milano, Marble@Firenze → Paris, payouts $55M + $46M, both with `isSupplyOnNetwork=false, estimatedTrackCostToSupply=$20M, estimatedTrackCostToDelivery=$12M`).

```
[final-victory] skip: no route covers cashGap=30M + connectorCost=24M
Result: NULL (buggy: $88M buildCost > $77 effective payout)
```

Math:

| Path | Components | buildCost | net | cashGap met? |
|------|-----------|-----------|-----|--------------|
| Buggy | `demandBuildCost(d1)=$32` + `demandBuildCost(d2)=$32` + `connectorCost=$24` (Firenze twice, Milano twice, Paris twice) | **$88** | $101 − $88 = $13 | $13 < $30 — **NO**, returns null |
| De-duplicated | $20 (Firenze once) + $12 (Milano once, via connectorCost) + $12 (Paris once, via connectorCost) = $44 | $44 | $101 − $44 = $57 | $57 ≥ $30 — **yes**, route returned |

A Marble + Marble pair from Firenze IS a feasible 2-load victory in this scenario; the bug suppresses it by overstating buildCost by $44M.

### Test 3 — s3 T77 approximation (9 demands, 5 unconnected majors)

Setup: reconstructed from `logs/game-8e176094-a679-490f-9406-d6faa7b55723.ndjson` with plausible track-cost estimates (Milano=$12, Paris=$12, Wien=$18, London=$25, Holland=$25 — sum 4 cheapest = $67M connector).

```
[final-victory] skip: no route covers cashGap=40M + connectorCost=67M
Result: NULL
```

For s3 T77 specifically, the math is genuinely tight even after de-dup (no single demand pays > $55M; best pair Marble+Marble nets ~$57M after $44M de-dup buildCost which is < $40M cashGap + $67M connector). So in THIS particular game, the de-dup fix would not have made findFinalVictoryRoute return a route — s3's demand hand was insufficient regardless. The bug is observable but not the explanation for s3 T77's specific null outcome.

The bug WILL bite in any game where:
- A bot's high-payout demand delivery city happens to be one of the cheapest-N unconnected majors (Holland, London, Milano, Paris, Wien in this game; Hamburg, Marseille, Roma in other Eurorails configurations), OR
- A bot has two/three demands sharing a single off-network supply city (Firenze for Marbles, Cardiff for Hops, etc.).

## Code locations

- Single-candidate buildCost: `src/server/services/ai/victoryRules.ts:372`
- Pair-candidate buildCost: `src/server/services/ai/victoryRules.ts:398`
- Triple-candidate buildCost: `src/server/services/ai/victoryRules.ts:430`
- demandBuildCost helper: `src/server/services/ai/victoryRules.ts:290` (supplyCost + deliveryCost)
- Connector cost source: `src/server/services/ai/ContextBuilder.ts:556` (`estimateTrackCost(cityName, segments, gridPoints)`)
- Demand cost source: `src/server/services/ai/context/DemandEngine.ts:527-528` (same `estimateTrackCost`)

## Expected behavior

A candidate's `buildCost` should reflect the total *unique* track-build investment needed to execute the route AND satisfy the connector requirement:

- If a candidate's delivery city is in the cheapest-N unconnected-majors connector set, its delivery-build is part of the connector spend — count it once via `connectorCost`, not again via `demandBuildCost.deliveryCost`.
- If two/three demands in a pair/triple share a supply city, build the spur to that city ONCE — count the supply-build once, not per-demand.
- If a demand's delivery city is one of the connector cities AND the same delivery is also via a shared supply, both de-dups apply.

The de-dup should not eliminate legitimate costs — only count each unique track segment once.

## Not in scope

- The non-End-state planner (DeterministicTripPlanner) has the same `demandBuildCost` pattern in its pair/triple enumeration. Whether that planner also double-counts shared supply costs is a separate question; this ticket is scoped to `findFinalVictoryRoute` only.
- Path-overlap de-dup (e.g., Firenze→Milano and Firenze→Paris share their first N hops out of Firenze). Out of scope — `estimateTrackCost` does not currently model corridor sharing; this ticket only de-dups exact city-build duplicates.
- Backfill of past games. Going-forward only.
