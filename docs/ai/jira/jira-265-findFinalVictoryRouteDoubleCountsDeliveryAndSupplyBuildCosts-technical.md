# JIRA-265 — De-duplicate per-candidate build cost in `findFinalVictoryRoute`: subtract overlapping connector cost when delivery city is in the connector set; subtract shared supply cost when two/three demands in a pair/triple use the same supply city (technical)

Companion to `jira-265-findFinalVictoryRouteDoubleCountsDeliveryAndSupplyBuildCosts-behavioral.md`.

## Defect locus

`src/server/services/ai/victoryRules.ts` — the three candidate-feasibility blocks at:

- Single: `:371-389` (the `for (const d of feasibleDemands)` loop)
- Pair: `:392-419` (the nested `i, j` loop)
- Triple: `:422-457` (the nested `i, j, k` loop)

Each computes `buildCost = sum(demandBuildCost) + connectorCost` and tests `payout − buildCost ≥ cashGap`. The bug: shared build segments (delivery city == connector city; same supply city across demands) are summed multiple times, overstating buildCost and rejecting feasible candidates.

## Fix shape

Replace the three direct-sum lines with a helper that computes the **unique** build cost for the candidate's combined cities.

### Step 1 — Add helper

```ts
// victoryRules.ts (new helper)

interface CandidateBuildBreakdown {
  /** Total unique build cost (supply + delivery + connector) with overlaps removed. */
  totalBuildCost: number;
  /** Supply cities built (each counted once). */
  uniqueSupplyCities: string[];
  /** Delivery cities built (each counted once). */
  uniqueDeliveryCities: string[];
  /** Connector cities NOT already covered by a delivery in this candidate. */
  remainingConnectorCities: string[];
}

function computeCandidateBuildCost(
  demands: import('../../../shared/types/GameTypes').DemandContext[],
  connectorCityNames: string[],
  connectorCostByCity: Map<string, number>,  // city → estimatedCost
): CandidateBuildBreakdown {
  const uniqueSupplyCities = new Set<string>();
  const uniqueDeliveryCities = new Set<string>();
  let totalSupplyCost = 0;
  let totalDeliveryCost = 0;

  for (const d of demands) {
    // Supply: skip if carried, on-network, or already counted (shared with another demand in this candidate).
    if (!d.isLoadOnTrain && !d.isSupplyOnNetwork && d.supplyCity && !uniqueSupplyCities.has(d.supplyCity)) {
      uniqueSupplyCities.add(d.supplyCity);
      totalSupplyCost += d.estimatedTrackCostToSupply;
    }
    // Delivery: skip if on-network or already counted (rare; two demands to same city).
    if (!d.isDeliveryOnNetwork && !uniqueDeliveryCities.has(d.deliveryCity)) {
      uniqueDeliveryCities.add(d.deliveryCity);
      totalDeliveryCost += d.estimatedTrackCostToDelivery;
    }
  }

  // Connectors: only sum connector cities NOT already built as deliveries.
  const remainingConnectorCities: string[] = [];
  let remainingConnectorCost = 0;
  for (const city of connectorCityNames) {
    if (!uniqueDeliveryCities.has(city)) {
      remainingConnectorCities.push(city);
      remainingConnectorCost += connectorCostByCity.get(city) ?? 0;
    }
  }

  return {
    totalBuildCost: totalSupplyCost + totalDeliveryCost + remainingConnectorCost,
    uniqueSupplyCities: [...uniqueSupplyCities],
    uniqueDeliveryCities: [...uniqueDeliveryCities],
    remainingConnectorCities,
  };
}
```

### Step 2 — Use helper in the three candidate loops

Replace the buildCost line in each block:

```ts
// Single (was line 372)
const breakdown = computeCandidateBuildCost([d], connectorCityNames, connectorCostByCity);
const buildCost = breakdown.totalBuildCost;

// Pair (was line 398)
const breakdown = computeCandidateBuildCost([d1, d2], connectorCityNames, connectorCostByCity);
const buildCost = breakdown.totalBuildCost;

// Triple (was line 430)
const breakdown = computeCandidateBuildCost([d1, d2, d3], connectorCityNames, connectorCostByCity);
const buildCost = breakdown.totalBuildCost;
```

### Step 3 — Thread `connectorCostByCity` from `cheapestNUnconnectedMajorConnectorCost`

The existing helper returns `{ cost, cityNames }` — it should also return a `Map<string, number>` (city → cost) so the de-dup helper can look up individual connector costs. Two options:

- **3a (preferred)**: change return shape to `{ cost, cityNames, costByCity }`. Update all callers (`cheapestUnconnectedMajorConnectorCost` at `:127` and `findFinalVictoryRoute` itself).
- **3b**: pass `context.unconnectedMajorCities` (the underlying array of `{cityName, estimatedCost}`) directly into `computeCandidateBuildCost` and build the map inside. Less coupling but recomputes the map per candidate.

Recommend 3a — single map construction outside the candidate loops is cheaper for triple-candidate enumeration over large feasibleDemand sets.

### Step 4 — Preserve diagnostic logging (JIRA-264 cross-ref)

The four `[final-victory] skip: ...` lines remain useful. After JIRA-264 lands, the `no_route_covers_gap` skip should also include `cashGap`, `connectorCost`, and the per-candidate breakdown sample so the operator can see the de-dup math. Out of scope for THIS ticket — note for JIRA-264 implementation.

## Acceptance criteria

- **AC1** Unit test: single-demand candidate where `d.deliveryCity` is in `unconnectedMajorCities` and matches one of the cheapest-N. Assert `buildCost = d.estimatedTrackCostToSupply + connectorCost − connectorCostByCity.get(d.deliveryCity)`. With the de-dup the delivery is counted once via the connector, not separately.
- **AC2** Unit test: pair candidate where `d1.supplyCity === d2.supplyCity` and both have `isSupplyOnNetwork=false, estimatedTrackCostToSupply=20`. Assert the supply cost contributes `20`, not `40`, to `buildCost`.
- **AC3** Unit test: pair candidate where `d1.deliveryCity` and `d2.deliveryCity` are both in the connector set. Assert both deliveries are counted via the connector, not via `demandBuildCost.deliveryCost`. Total connector contribution: only the connector cities NOT covered by these two deliveries.
- **AC4** Unit test: triple candidate sharing supply AND with one delivery in the connector set. Assert all three de-dups compose.
- **AC5** Regression: existing JIRA-245 + JIRA-261 tests pass unchanged. The de-dup should never INCREASE buildCost — only decrease or leave it equal.
- **AC6** Diagnostic replay of test cases 1 + 3 from this ticket's behavioral doc (the deleted JIRA-265 investigation test):
  - Case 1 (single Oil→Holland with cashGap=$30M, connector=$20M, payout=$60M, deliveryCost=$20M) → fix must return a route, not null.
  - Case 3 (pair Marble@Firenze→{Milano, Paris} with cashGap=$30M, payouts=$55M+$46M=$101M) → fix must return a route, not null.

## Diagnostic confirmation (already run, do not re-add)

A one-shot diagnostic test at `src/server/__tests__/ai/victoryRules.jira265-double-count-investigation.test.ts` confirmed both bugs (single-delivery overlap + pair-supply overlap). The test file was deleted after capturing output; the captured math is preserved in the behavioral doc's "Diagnostic output" section. AC6 above re-creates the same scenarios as proper unit tests.

## Not in scope

- DeterministicTripPlanner (non-End-state planner). Its pair/triple enumeration likely has the same shared-supply double-count pattern; separate ticket if the user wants to address that.
- Path-overlap modeling (e.g., the spur from network to Firenze is shared by both Marbles' trips to Stockholm and Goteborg). `estimateTrackCost` is point-to-network only; corridor-level overlap modeling is out of scope.
- Triple+ delivery aggregation beyond what `estimateTrackCost` provides. The helper does pairwise/triplewise city-level de-dup, not topological route-cost optimization.
- Backfill or replay of past games. Going-forward only.

## Cross-references

- JIRA-245 — original `findFinalVictoryRoute` introduction.
- JIRA-261 — idempotency check on the override (orthogonal bug; doesn't interact with this one).
- JIRA-264 — observability gap; without that fix, this bug was unobservable from the NDJSON. Recommend landing JIRA-264 first or alongside so future regressions are visible.
