# JIRA-178: Milano Starting City Bias in Single-Delivery Scoring

**Status:** TODO

## Problem

All 3 bots in a game started from Milano. The `PERIPHERAL_CITIES` penalty (30 points) only applies in double-delivery pairing scorers (`scorePairing()` and `scoreSharedPickupPairing()`), but the single-delivery path at `InitialBuildPlanner.ts:101` picks purely by `efficiency` with no peripheral penalty. Milano's geographic centrality (low build costs + short travel to dense Northern Italian supply cities) makes it consistently win the efficiency contest.

## Root Cause

`InitialBuildPlanner.expandDemandOptions()` computes `efficiency` per option at line 248:
```
efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns
```

No peripheral penalty is applied here. The penalty only exists in:
- `scorePairing()` line 489: `PERIPHERAL_CITIES.has(first.startingCity) ? 30 : 0`
- `scoreSharedPickupPairing()` line 623: `PERIPHERAL_CITIES.has(closer.startingCity) ? 30 : 0`

When `bestDouble` is null (no viable double pairing), `bestSingle` is chosen at line 101 with raw efficiency — Milano-based options rank highest because of geography.

## Contributing Changes

- JIRA-159: Changed tie-breaking from `totalBuildCost` to `estimatedTurns` — shifted balance toward Milano (shortest travel times to Italian supply cities)
- JIRA-152: Removed `HIGH_BUDGET_PENALTY` — eliminated a cost that previously penalized hub cities

## Proposed Fix

Apply peripheral penalty to `efficiency` in `expandDemandOptions()` so single-delivery scoring is consistent with double-delivery scoring. The penalty should reduce the efficiency score for options starting from peripheral cities.

## Files to Modify

| File | Change |
|------|--------|
| `src/server/services/ai/InitialBuildPlanner.ts` | Apply peripheral penalty to efficiency in `expandDemandOptions()` around line 248 |
