# JIRA-226 — `InitialBuildPlanner` cost estimator undercounts true build cost; allows over-budget routes through MAX_BUILD_BUDGET filter (behavioral)

## Source

Surfaced 2026-05-10 while diagnosing game `b1dd75b7-fb22-428a-91f3-552ed0b7ea0c`. The bot's initial-build plan committed a Fish round-trip (Oslo → Bern + Zurich) that consumed ~43M of the bot's 50M starting cash JUST to reach Oslo, then needed another 30M+ to deliver — effectively a 70M+ trip selected by an algorithm with `MAX_BUILD_BUDGET = 40`.

The JIRA-223 affordability gate doesn't help here because `InitialBuildPlanner` runs its own scoring before `DeterministicTripPlanner` is ever invoked.

## Observed behavior

`src/server/services/ai/InitialBuildPlanner.ts:213` filters candidate routes via:

```ts
if (costs.totalBuildCost > MAX_BUILD_BUDGET) continue;
```

where `MAX_BUILD_BUDGET = 40` (line 41) and `costs.totalBuildCost` comes from `estimateBuildCostFromCity` (line 363+) which uses `costBetween` (line 684+).

For the game-`b1dd75b7` candidate (Cardiff/Brussels start → Oslo supply → Bern + Zurich delivery), the estimator returned a total well within the 40M budget, the filter passed, the route was selected. The actual build cost incurred turned out to be ~70M+, and the bot was bankrupted before the second delivery.

## Two confirmed root causes

### Root cause 1 — Region-based ferry filter misses intra-continent ferries

`isFerryBetween` (line 698-708) returns `true` only when the two cities are in different regions among `{britain, ireland, continent}`. Sweden and Italy ferry crossings are intra-continent and are NOT flagged. So a continent-to-continent path that requires a real ferry crossing (e.g., København → Sweden via the Øresund ferry, or any Italian island ferry) is treated as ferry-free.

```ts
return InitialBuildPlanner.getCityRegion(cityA) !== InitialBuildPlanner.getCityRegion(cityB);
```

### Root cause 2 — `costBetween` heuristic fallback undercounts terrain

`costBetween` (line 684-693):

```ts
const pathCost = estimatePathCost(fromRow, fromCol, toRow, toCol);
if (pathCost > 0) return pathCost;
const dist = hexDistance(fromRow, fromCol, toRow, toCol);
return dist <= 1 ? 0 : Math.round(dist * 2.0);
```

The fallback (`dist * 2.0`) charges 2 ECU per hex regardless of terrain. Real costs are: clear=1, mountain=2, alpine=5, river crossing=+2, ocean inlet=+3, ferry=variable. A long path with mountains, alpine, and river crossings can easily cost 4-6 ECU per hex on average — 2-3× the heuristic.

Even when `estimatePathCost > 0` succeeds, it's worth verifying that THAT pathfinder includes ferry/river/ocean-inlet surcharges and doesn't just sum milepost terrain costs.

## Why this matters

`InitialBuildPlanner` is the first decision a Medium-skill bot makes — it picks the route the bot commits to before any other planner runs. A bad initial pick means the bot is destined to fail before the first turn ends. The `MAX_BUILD_BUDGET = 40M` cap is the algorithm's primary safety against ruinous initial commitments, and it's leaking.

The JIRA-223 affordability gate doesn't run here because:
1. `InitialBuildPlanner` uses its own `estimateBuildCostFromCity`, not `simulateTrip`.
2. By the time `DeterministicTripPlanner.scoreCandidate` runs (post-replan), the bot has already spent the cash building TO the supply city per the InitialBuildPlanner choice — the affordability check would now reject continuing, but the irrecoverable spend is already on the board.

## Acceptance criteria

- **AC1** `isFerryBetween` correctly identifies intra-continent ferry crossings (Sweden ↔ continental Europe via København, Italy island ferries, Denmark/Sweden bridges-as-ferries, Greek island ferries if present in the map). Use the actual map's ferry ports and crossings as the source of truth, not the region heuristic alone.
- **AC2** `costBetween`'s heuristic fallback is replaced with — or augmented by — terrain-accurate path cost. Either: (a) ensure `estimatePathCost` is the single authoritative source and never returns 0 erroneously, or (b) replace the `dist * 2.0` fallback with a per-hex average that better matches real terrain (a quick grep through the map's terrain distribution should yield a more honest average ~3.0-4.0 ECU/hex).
- **AC3** Replay of game `b1dd75b7`'s initial-build candidate (start → Oslo → Bern + Zurich) reports a `totalBuildCost > 40M` and is filtered out by `MAX_BUILD_BUDGET`.
- **AC4** No regression in existing initial-build tests; existing routes that should be selected still are.

## Severity

**High** — leaks an unfundable route past the algorithm's primary safety filter. Even with JIRA-223 in place, this is the upstream gate; fixing here prevents the cascade entirely.

## Out of scope

- Refactoring the entire cost-estimation pipeline. The fix is a targeted accuracy improvement to two functions.
- Replacing `MAX_BUILD_BUDGET = 40` with a dynamic value (separate tuning question — first make the existing budget enforced honestly).
- Modifying `DeterministicTripPlanner` or `simulateTrip` (those are correct given accurate inputs).

## Verification done before filing

Read of `src/server/services/ai/InitialBuildPlanner.ts:41,213,363-430,684-708` confirms both root causes are present in current code. The ferry filter and the `costBetween` heuristic are both demonstrably under-estimating for the b1dd75b7 case. No need for additional log-mining before scheduling — the code is the proof.
