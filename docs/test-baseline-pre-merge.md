# Pre-Merge Test Baseline

**Captured:** 2026-05-20
**Branch tip at capture:** `fe10838` (test(ai): spread jest.requireActual across helper-module mocks)
**Purpose:** Lock in the set of tests already failing on `compounds/guardrail-updates` before starting the selective re-apply onto `main`. Any test that fails *after* the merge but is not on this list is merge-caused and needs triage. Any test on this list that starts passing after the merge is a bonus.

## Starting point vs. where we are now

| State | Failures | Suites failing |
|---|---|---|
| Original (HEAD = `f8908b4`) | 86 | 11 |
| After `9b990d5` (MapTopology mock spread, 20 files) | 81 | 10 |
| After `fe10838` (routeHelpers + majorCityGroups + connectedMajorCities spread, 39 files total) | **41** | **10** |

Reduction: **52%** — driven by fixing a single systemic issue (test mocks for helper modules omitted exports that production code calls). The remaining 41 failures are heterogeneous and case-by-case.

## How to use this baseline

After each commit during the merge, run `npm test -- --forceExit` and compare the failing test names against this list. Concretely:

```bash
npm test -- --forceExit 2>&1 | grep -E '^\s+●\s' | sed -E 's/^\s+● //' | sort -u > /tmp/current-failures.txt
diff <(sort docs/test-baseline-pre-merge.md | grep '^  - ') <(sed 's/^/  - /' /tmp/current-failures.txt)
```

If the diff shows tests *added* relative to the baseline → merge regressed something. Triage immediately.
If the diff shows tests *removed* → merge accidentally fixed something. Note and continue.

## Known-failing test names (41)

### AIStrategyEngine.takeTurn (Integration) — 20

  - AIStrategyEngine.takeTurn (Integration) › JIRA-156 P2: RouteEnrichmentAdvisor enrich() called after new route creation › should call RouteEnrichmentAdvisor.enrich() after TripPlanner creates a new route when hexGrid is populated
  - AIStrategyEngine.takeTurn (Integration) › JIRA-156 P2: RouteEnrichmentAdvisor enrich() called after new route creation › should use the enriched route (from enrich() return value) for execution
  - AIStrategyEngine.takeTurn (Integration) › LLM failure → heuristic fallback (BE-004) › should PassTurn when both LLM and heuristicFallback fail
  - AIStrategyEngine.takeTurn (Integration) › LLM failure → heuristic fallback (BE-004) › should PassTurn when heuristicFallback returns PassTurn plan
  - AIStrategyEngine.takeTurn (Integration) › LLM failure → heuristic fallback (BE-004) › should use heuristicFallback BUILD when LLM planRoute returns null
  - AIStrategyEngine.takeTurn (Integration) › decision gate — active route auto-execution › should try heuristicFallback when route planning fails, PassTurn only if both fail
  - AIStrategyEngine.takeTurn (Integration) › initial build uses LLM route planning › should use InitialBuildPlanner (not LLM) during initialBuild
  - AIStrategyEngine.takeTurn (Integration) › initial build uses LLM route planning › should use InitialBuildPlanner during initialBuild regardless of LLM key
  - AIStrategyEngine.takeTurn (Integration) › initial build — LLM route planning › should use InitialBuildPlanner (not LLM planRoute) during initialBuild gameStatus
  - AIStrategyEngine.takeTurn (Integration) › successful turn — PassTurn (no API key) › should pass turn directly when no LLM API key is available

(plus 10 more in this cluster — see /tmp/test-baseline.txt for the full list captured at fe10838)

### LLMStrategyBrain — 14

  - (per the baseline file)

### ActionResolver — 14

  - ActionResolver › resolveMultiAction › edge cases › should handle two PASS actions in a MultiAction
  - ActionResolver › resolveMultiAction › invalid action in sequence › should fail on second invalid action (step 2) after first succeeds
  - ActionResolver › resolveMultiAction › invalid action in sequence › should fail on third action in a three-step sequence
  - ActionResolver › resolveMultiAction › invalid action in sequence › should fail when unknown action type is in the sequence
  - ActionResolver › resolveMultiAction › valid multi-action sequences › should resolve PASS + BUILD as MultiAction
  - ActionResolver › resolveMultiAction › valid multi-action sequences › should resolve a single action passed as multi-action (degenerates to single)
  - ActionResolver › resolvePass › should accept "PASS" string as action alias

### JIRA-127: Build Cost Estimator Accuracy — 8

  - (8 tests in the build-cost-estimation cluster)

### Smaller clusters

  - JIRA-161: MIN_DELIVERIES_BEFORE_UPGRADE constant — 2 (constant changed from 1 to 2 in source, test not updated)
  - ContextBuilder.build — demand context computation — 4
  - ContextBuilder ferry-aware estimateTrackCost — 4
  - ContextBuilder.serializePrompt — 2
  - ContextBuilder.build — on-train travel distance in estimatedTurns — 2
  - Bot Build Track Flow (Integration) — 4
  - TurnExecutorPlanner.execute — post-delivery replan — 2
  - TurnExecutorPlanner.execute — move toward stop city — 2
  - JIRA-156 mid-turn replan: delivery triggers TripPlanner + RouteEnrichmentAdvisor stub — 2
  - BotTurnTrigger › onHumanReconnect — 2

## Failure shape categories (from grep)

| Category | Approx count | Notes |
|---|---|---|
| Assertion mismatches (Expected "BuildTrack" / "PassTurn" / true / > 0) | ~30 | Tests expect bot to choose action X but it chose Y — production behaviour drift |
| `loadSvc.setLoadInCity is not a function` | 6 | TurnExecutor calls a method that doesn't exist on the LoadService (or its mock) |
| `Cannot read properties of undefined (reading 'rows')` | 6 | DB query result handling — likely a mock not returning a `{rows:[]}` shape |
| `Cannot read properties of undefined (reading 'feeTotal')` | 2 | Null safety in MoveTrain handling |
| UUID parse errors in DB tests (`bot-1`, `bot-player-1`) | 76 log lines | Log noise from integration tests writing non-UUID identifiers — not actual failures |
| Big-object snapshot mismatches | ~6 | LLMStrategyBrain prompt/context shape changed |

## Out of scope for this baseline

- Linting / type errors — covered by `npm run build`, currently green.
- Integration tests that depend on a live PostgreSQL — environment-sensitive, may fail or pass depending on local DB state.

---

*This baseline is a snapshot. Update it if the underlying failures change before the merge starts.*
