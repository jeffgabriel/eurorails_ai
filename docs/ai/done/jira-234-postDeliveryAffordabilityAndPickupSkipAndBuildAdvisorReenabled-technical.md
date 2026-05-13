# JIRA-234 — Three regressions: technical baseline

Companion to `jira-234-postDeliveryAffordabilityAndPickupSkipAndBuildAdvisorReenabled-behavioral.md`. Read that first for evidence and acceptance criteria.

This document captures the candidate implementation plan as a baseline to compare with compounds' output.

---

## Defect A — Stuck mid-route bot, replan bypasses affordability gate

### Defect A1 + A2 — in-turn replan must use the affordability gate

**Locating the replan path** (verify via grep before editing):

- `src/server/services/ai/PostDeliveryReplanner.ts` — primary suspect. Owns "after a delivery completes, replan the next leg" logic.
- `src/server/services/ai/TurnExecutorPlanner.ts` — multi-action executor; may dispatch the replan when a `DeliverLoad` step completes mid-MultiAction.
- `src/server/services/ai/AIStrategyEngine.ts` — around the `composedSteps.some(s => s.type === AIActionType.DeliverLoad)` block (where JIRA-233 fixes were applied).
- `src/server/services/ai/RouteEnrichmentAdvisor.ts` — adds opportunistic stops; may construct new routes that bypass the gate.

In s3's game, every record has `decisionSource: route-executor` and there are zero `[JIRA-232][predict]` log lines. This rules out `DeterministicTripPlanner.planTripDeterministic` as the entry point. Confirm by adding a temporary `console.log('[A2-trace] replan path=', new Error().stack)` at the site that mutates `memory.activeRoute` after a delivery, then re-run.

**Where the affordability gate lives**:
- `src/server/services/ai/DeterministicTripPlanner.ts:696` — `scoreCandidate(candidate, startPos, snapshot, opts, affordabilityOptions, memory)`.
- `DeterministicTripPlanner.ts:787-805` — the JIRA-232 upgrade-aware re-simulation with `pendingUpgradeCost: UPGRADE_COST_M`.
- `DeterministicTripPlanner.ts` — `AFFORDABILITY_FLOOR_M` constant + the per-candidate cash-floor check.

**Fix plan**:

1. Extract a `passesAffordabilityGate(candidate, startPos, snapshot, memory, opts): { ok: boolean; reason?: string }` function from `scoreCandidate`. Move the simulate-trip + upgrade-aware re-simulation + cash-floor check into it. `scoreCandidate` calls it; new replan path also calls it.
2. In the in-turn replan path identified above, before mutating `memory.activeRoute` with the new route, call `passesAffordabilityGate` with the same snapshot used to construct the route. On failure: do not set the new route; surface the rejection reason; let the bot's no-route fallback (discard hand, etc.) handle it.
3. The "snapshot" used must reflect post-delivery state (loads decremented, cash incremented) — this is the same correctness condition JIRA-233 already addressed for the cargo set; verify cash is similarly post-payout at the replan site.

### Defect A3 — stuck-bot guardrail must cover carry-load + non-zero-cash case

**Locating existing guardrails**:

- `src/server/services/ai/TurnExecutor.ts` — search for `isActivelyTraveling`, `broke-and-stuck`, `Unaffordable-and-stuck`.
- `src/server/services/ai/BotMemory.ts` — search for `passTurnCount`, `consecutivePassTurns`, `stuckTurns`, `lastBuildProgressTurn`.
- Likely guards in `AIStrategyEngine.ts` or a dedicated `GuardrailCoordinator.ts`.

**Current trigger conditions (verify):** existing guards appear to require `carry == 0` and/or `cash == 0`. s3's case (`carry=[China], cash=$7M, 16 consecutive PassTurns, build cost=$0/turn`) trips none of them.

**Fix plan**:

1. Add a new "stuck-build-progress" guardrail with these conditions:
   - `composition.build.cost === 0` for `N` consecutive turns (start with N=4), AND
   - `composition.a2.terminationReason === 'stop_city_not_on_network'` for those same turns, AND
   - `memory.activeRoute != null` and the active stop is a delivery whose city is not reachable from the current network within available cash.
2. Action on fire: clear `memory.activeRoute`; drop carried loads at the current city (no-payoff drop is legal); flag for next-turn full replan via the normal trip planner.
3. New `consecutiveZeroProgressBuilds` counter on `BotMemory` to track condition 1.

**Test plan**:
- Unit test: reconstruct s3 t17 snapshot (cash=7, superfreight, carry=[China], route=Leipzig→Oslo→…, position=Leipzig, network does not reach Oslo within $7M); after 4 such snapshots the guard fires and clears the route.
- Negative: bot with carry=0 and cash=0 (existing broke-and-stuck case) still fires the older guard, not the new one.

---

## Defect B — Trip enumeration misses extended-pickup variants

### Where enumeration happens

- `src/server/services/ai/DeterministicTripPlanner.ts:1182-1294` — `planTripDeterministic`. Filters infeasible demands (JIRA-231), then enumerates candidates.
- The candidate enumerator (called from line ~1230, exact function name to confirm — possibly `enumerateCandidates` or inline) produces routes of shape `pickup+pickup+deliver+deliver`, `pickup+deliver+pickup+deliver`, etc., based on a fixed set of stop-shape templates.

### Hypothesis for the bug

For superfreight (cap=3) the enumerator likely produces 2-pickup + 2-delivery candidates and 3-pickup + 3-delivery candidates, but does not produce "2-pickup-on-the-pair + 1-detour-pickup + 2-delivery-on-the-pair + 1-detour-delivery" variants. So Newcastle Oil (which is not part of the chosen Cardiff/Aberdeen pair but is geographically adjacent) never appears in any candidate route.

### Fix plan

1. Confirm hypothesis: grep for the enumerator and inspect the stop-shape templates. Specifically check whether a 3-pickup variant is enumerated for cap=3 trains.
2. If yes, the bug is in the pair-selection logic (the chosen pair excludes the Newcastle/Warszawa demand even though it's geographically attractive).
3. If no, add a "capacity-aware extended-pickup" enumeration pass: for each chosen base pair, for each additional demand `d_extra` in hand, compute the detour cost to insert `pic:d_extra@supplyCity` at the cheapest insertion point in the base pair's stop sequence, plus the detour cost to insert `del:d_extra@deliveryCity` after all base deliveries. Add the variant if `d_extra.payout > detour_cost_estimate * cost_per_milepost_threshold`.
4. Score the new variants through `scoreCandidate` (so they pass the affordability gate from Defect A) and let `pickTop1` rank.

### Test plan

- Reconstruct s1 t32 snapshot (superfreight cap=3, carry=0, demands as listed in behavioral doc). Run `planTripDeterministic`. Expect a route that includes `pic:Oil@Newcastle` somewhere between Cardiff and the European deliveries.
- Negative: cap=2 freight with the same demands — no Newcastle insertion (capacity is the constraint).
- Negative: same demands but Newcastle replaced with a far-flung supply city (e.g., a Greek city) — no insertion (detour too expensive).

---

## Defect C — Restore the BuildAdvisor feature flag from dropped stash

### Restore from stash

Since `d7e1798` is still recoverable as a dangling commit (will be GC'd after 30 days), the simplest restore is:

```bash
git checkout d7e1798 -- src/server/services/ai/BuildAdvisor.ts src/server/services/ai/TurnExecutorPlanner.ts
```

But that brings ALL the stash's BuildAdvisor changes (including the +37 line test file) and ALL of TurnExecutorPlanner. Safer: cherry-pick just the diff blocks for the feature flag.

### Manual application

**1. `src/server/services/ai/BuildAdvisor.ts`** — add after the existing imports / type declarations:

```ts
/**
 * When true, the BuildAdvisor LLM is consulted before falling back to the heuristic.
 * Default false based on 7-day log analysis showing 41.6% LLM success rate with
 * no measurable delivery uplift over the heuristic Dijkstra-only path. Flip
 * `ENABLE_BUILD_ADVISOR=true` for A/B comparison.
 */
export function isBuildAdvisorEnabled(): boolean {
  const value = process.env.ENABLE_BUILD_ADVISOR;
  if (value === undefined || value === '') return false;
  return value.toLowerCase() === 'true';
}

console.log(`[BuildAdvisor] ENABLE_BUILD_ADVISOR=${isBuildAdvisorEnabled() ? 'true' : 'false'}`);
```

**2. `src/server/services/ai/TurnExecutorPlanner.ts`** — add import:

```ts
import { isBuildAdvisorEnabled } from './BuildAdvisor';
```

And gate the existing call site (line 305-307):

```ts
// before
if (useAdvisor && brain != null && gridPoints != null) {
  const advisorBuildResult = await AdvisorCoordinator.adviseBuild(...)
}

// after
if (useAdvisor && brain != null && gridPoints != null && isBuildAdvisorEnabled()) {
  const advisorBuildResult = await AdvisorCoordinator.adviseBuild(...)
}
```

### Test plan

- Run an autoplay game with default env. Confirm zero BuildAdvisor LLM calls in the resulting `llm-*.ndjson` (grep `BuildAdvisor` should match only existing comment / metadata fields, not call entries).
- Run an autoplay game with `ENABLE_BUILD_ADVISOR=true`. Confirm BuildAdvisor LLM calls reappear at the same frequency as in `cccbc7e1`.
- Server startup log shows `[BuildAdvisor] ENABLE_BUILD_ADVISOR=false` (or `true`) once.

---

## Ordering / dependency

- C is independent — can land first, smallest patch.
- A1+A2 require finding the in-turn replan site; A3 piggybacks on A1+A2's snapshot wiring.
- B is independent of A in implementation but A's affordability gate must run on B's new candidate variants, so A should land first to avoid producing unaffordable extended-pickup routes.

Recommended sequence: C → A → B.
