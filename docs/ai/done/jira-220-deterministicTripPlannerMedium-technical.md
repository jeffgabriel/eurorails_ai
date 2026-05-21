# JIRA-220 — Deterministic medium-skill TripPlanner (technical)

Companion to `jira-220-deterministicTripPlannerMedium-behavioral.md`. Read that first for scope, evidence, and rollout questions.

## Current implementation

**`src/server/services/ai/TripPlanner.ts`** — `planTrip` (lines 124–450, roughly):

- Lines 134–197: pre-LLM short-circuits (`no_actionable_options`, `keep_current_plan`, `single_option_shortcircuit`). These remain unchanged.
- Lines 200–204: `strategicContext` built only for Medium (existing medium spec).
- Line 205: `getTripPlanningPrompt(skillLevel, context, memory, strategicContext)` composes the prompt.
- Lines 211–319: retry loop calling `adapter.chat(...)` with skill-tiered effort/temperature/maxTokens, parsing the response, scoring candidates.
- Lines 421–445: total-failure fallback to `LLMStrategyBrain.planRoute`.

**`src/server/services/ai/RouteDetourEstimator.ts`** — `simulateTrip(startPos, stopsInOrder, snapshot)` returns `{ turnsToComplete, totalBuildCost, feasible }`. Already used elsewhere in the bot. This is the truthful scorer the deterministic algorithm consumes.

**`src/server/services/ai/MapTopology.ts`** — `hexDistance(r1, c1, r2, c2)` returns Chebyshev hex distance. Used by the cheap prune.

## Fix plan

### 1. New module: `src/server/services/ai/DeterministicTripPlanner.ts`

Extract the algorithm validated by `scripts/ai/spatial-prune-analysis.ts` into a production module. Public surface:

```ts
export interface DeterministicTripPlannerOptions {
  ocpt?: number;                    // default 8
  pruneMaxTurns?: number;           // default 12
  pruneMaxBuildM?: number;          // default 130
  hopAvgCostM?: number;             // default 1.3 — used only by the cheap prune estimator
}

export function planTripDeterministic(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
  options?: DeterministicTripPlannerOptions,
): { route: StrategicRoute | null; reasoning: string; outcome: 'success' | 'no_feasible_candidates' };
```

Internals (each a private helper):

- `detectCarriedLoads(activeRoute, demands)` — return `Set<loadType>`. Combines two signals:
  1. `demand.isLoadOnTrain === true` (canonical flag — present in `GameContext.demands` already; analysis script approximated this via `supplyCity === null`).
  2. `activeRoute.stops` reconciliation: any `deliver` stop that appears with no preceding `pickup` stop for the same loadType in the current plan implies an implicit carry.
- `enumerateCandidates(rows, cap)` → `Candidate[]`. Generates singles, pairs, triples per the `scripts/ai/spatial-prune-analysis.ts` rules:
  - Singles: 1 per demand row (carry rows produce a deliver-only stop sequence).
  - Pairs: `C(N, 2)` minus same-cardIndex pairs. For each, generate 2–4 stop-ordering variants based on whether 0/1/2 of the demands are carries.
  - Triples: `C(N, 3)` minus same-cardIndex collisions. Variants gated on capacity:
    - 3 carries → cap≥3 only
    - 2 carries + 1 fresh → any cap (deliver one carry to free a slot before pickup)
    - 1 carry + 2 fresh → any cap (deliver carry first, then fresh-pair)
    - 0 carries + 3 fresh → cap≥3 only
- `cheapPrune(candidate, startPos, speed, opts)` → `{ keep, estTurns, estBuild }`. Computes `totalHops = Σ hexDistance(stop_i, stop_{i+1})`, then `estTurns = ceil(totalHops / speed)`, `estBuild = totalHops × hopAvgCostM`. Filters by the two thresholds.
- `scoreCandidate(candidate, startPos, snapshot)` → `{ buildCost, turns, net, score, feasible }`. Calls `simulateTrip` from the existing `RouteDetourEstimator`. `score = (payout − buildCost) − ocpt × turns`.
- `pickTop1(scored)` — sort by score desc, return scored[0] or null.
- `synthesizeReasoning(top1, top3, candidateStats)` — produce a verbose human-readable string for the `route.reasoning` field. The string must be sufficient for a human reading a game log to understand *why* this trip won, without re-running the algorithm. Format:

  ```
  [deterministic-top-1] <id> chosen.
    Picked: <pattern label> — payout <m>M, build <m>M, <n> turns, NET <m>M, score <s>
    Stops: 1) <action> <load> at <city>; 2) <action> <load> at <city>; ...
    Rationale: <pattern explanation>
      e.g. "carries Marble (delivers at Wien) + fresh Cork pickup (Sevilla→Napoli);
            same-supply not available; carry-deliver-first chosen because cap=2 and
            holding both would exceed train capacity"
    Runner-up #2: <id>, score <s2>, NET <m>M, <n> turns. Lost by <Δ> because <reason>.
      e.g. "fewer turns but lower NET — OCPT favored the chosen plan"
    Runner-up #3: <id>, score <s3>, NET <m>M, <n> turns. Lost by <Δ>.
    Survivors after spatial prune: <k> of <total candidates> raw.
    Discarded by prune: <m> (turns > <PR_T>) | <n> (build > <PR_B>M).
  ```

  Pattern labels covered: `single-fresh`, `single-carry`, `pair-shared-supply` (P2), `pair-shared-delivery` (P3), `pair-co-regional` (P4), `pair-transit` (P6), `pair-two-carry`, `pair-carry+fresh`, `triple-3carry`, `triple-2carry+fresh`, `triple-1carry+pair`, `triple-3fresh`. The labels are diagnostic only — they do not affect ranking.

- `synthesizeLlmAttempt(top1, latencyMs)` — produce a synthetic `LlmAttempt` so `LlmAttempt[]` logging stays well-formed downstream. Mark `model = 'deterministic'`, `tokens = 0`, `latencyMs = elapsed`.

The algorithm uses only data already present in `WorldSnapshot` and `GameContext`. No new context-building required.

### 2. Branch in `TripPlanner.planTrip`

Replace the LLM call block (lines 200–319, roughly) with a skill-conditional fork:

```ts
if (skillLevel === BotSkillLevel.Medium) {
  const detResult = planTripDeterministic(snapshot, context, memory);
  if (detResult.route) {
    // Route synthesized — proceed to existing post-LLM pipeline (scoring, validation,
    // affordability, upgrade normalization, RouteEnrichmentAdvisor) using detResult.route.
    return await this.applyPostPlanPipeline(detResult.route, detResult.reasoning, snapshot, context, memory, gridPoints);
  }
  // No feasible candidates — fall through to LLMStrategyBrain.planRoute heuristic
  // (same fallback the LLM path uses on total failure).
} else {
  // Existing LLM path — Easy and Hard go through here.
  // ... existing code unchanged ...
}
```

The post-plan pipeline (`scoreCandidates`, `RouteValidator.validate`, affordability gate, upgrade label normalization, `RouteEnrichmentAdvisor`) is already factored as a sequence of method calls. The main refactor is extracting that sequence into a helper `applyPostPlanPipeline(route, reasoning, ...)` so both the LLM path and the deterministic path can share it. This is the only structural change to `TripPlanner` — everything else is additive.

### 3. Constants in `DeterministicTripPlanner.ts`

```ts
/**
 * Opportunity cost per turn (ECU-equivalent score points).
 *
 * Empirically tuned to 8 from a parameter sweep over 299 historical Sonnet
 * trip-planner decisions (scripts/ai/sweep-spatial-prune.py). At OCPT=8 the
 * deterministic algorithm makes ZERO strict-loss decisions vs the Sonnet
 * baseline; at OCPT=5 it makes 1 strict loss out of 299. OCPT=8 is the knee
 * of the win-rate curve.
 *
 * IMPORTANT — calibration note:
 * OCPT=8 is higher than the bot's per-turn income upper bound (~5M, per
 * CLAUDE.md "income velocity" principle). The discrepancy is NOT a strategic
 * choice — it is a compensation for a simulator quirk:
 *
 *   RouteDetourEstimator.simulateTrip uses strict per-leg sequencing:
 *   "build all of this leg's new track, THEN move next turn." This inflates
 *   turn count vs real play (where bots interleave build and move within a
 *   leg). To rank candidates correctly under inflated turn counts, OCPT
 *   must be inflated proportionally.
 *
 * IF THE SIMULATOR'S SEQUENCING IS EVER FIXED (e.g., a future ticket lets
 * RouteDetourEstimator interleave build+move within a leg), OCPT MUST be
 * re-tuned. The expected new value is ~5, matching the income upper bound.
 * Re-run scripts/ai/sweep-spatial-prune.py against fresh log dumps to
 * confirm before changing.
 *
 * Do not change OCPT without re-running the sweep.
 */
export const OCPT = 8;

/**
 * Cheap-prune turn cap. Computed as ceil(totalHops / trainSpeed) — does not
 * include build-phase turns. Loose enough to admit every competitive candidate;
 * tighter values do not change top-1 outcomes in the historical dataset.
 */
export const PRUNE_MAX_TURNS = 12;

/**
 * Cheap-prune build-cost cap. Computed as totalHops × HOP_AVG_COST_M. Loose
 * enough to admit every competitive candidate.
 */
export const PRUNE_MAX_BUILD_M = 130;

/** Empirical average milepost cost (clear=1, mountain=2, cities=3, average ≈ 1.3). */
export const HOP_AVG_COST_M = 1.3;
```

### 4. No changes to `RouteDetourEstimator`

`simulateTrip` is consumed as-is.

### 5. No changes to `MapTopology`

`hexDistance` is consumed as-is.

### 6. Demand-row carry handling

`GameContext.demands` already exposes `isLoadOnTrain` per demand (verify in `BotContext.ts` — if not, surface it). The analysis script approximated this via `supplyCity === null`, which is unreliable. Production code must use the canonical flag. Implicit-carry detection from `activeRoute` is a belt-and-suspenders fallback; if `isLoadOnTrain` is reliable, the activeRoute reconciliation can be a sanity-check only.

### 7. Reasoning trace and observability

The bot's NDJSON logger emits `reasoning`, `composition`, `decisionSource`, and `llmCallIds` per turn. After this change, medium-skill trip-planner turns will emit:

- `decisionSource: 'trip-planner-deterministic'` (new value — preserves analytics distinguishability).
- `reasoning: <synthesizeReasoning output>` (verbose multi-line string per §1).
- `llmCallIds: []` (no LLM call).
- `composition` unchanged.

No live dashboard. Medium-skill bots no longer call the LLM, so there is no per-turn signal to compare against. The offline replay tooling at `scripts/ai/spatial-prune-analysis.ts` is retained for one-off audits if scoring or pruning constants are tuned later.

## Test plan

### Unit tests in `DeterministicTripPlanner.test.ts`

1. **Carry detection — canonical flag.** Demand with `isLoadOnTrain: true` produces a deliver-only single candidate.
2. **Carry detection — implicit via activeRoute.** Demand with `isLoadOnTrain: false` but where `activeRoute.stops[0]` is a deliver of that loadType with no preceding pickup → also classified as carry.
3. **Same-card pair blocked.** Two demands with the same `cardIndex` do not produce a pair candidate.
4. **Capacity enforcement on triples.** With cap=2: 0-carry triple variants are skipped; 1-carry + 2-fresh variants that pickup both fresh before delivering carry (cap=3 only) are skipped.
5. **Top-1 selection deterministic.** Given a fixed snapshot, two calls return the same `route`.
6. **Empty candidate set.** When all candidates are pruned or infeasible, returns `outcome: 'no_feasible_candidates'`.
7. **Score formula.** `score = (payout − buildCost) − OCPT × turns` — verify with hand-computed values on a small fixture.
8. **Cheap prune correctness.** A trivially long candidate (totalHops > pruneMaxTurns × speed) is pruned without invoking the simulator.

### Integration tests

1. **Fixture replay.** For each of N fixed `WorldSnapshot` fixtures (extract from `src/server/__tests__/ai/fixtures/contextEquivalence/`), assert the deterministic algorithm produces a non-null route with a positive simulator-feasible score. Hard-asserts `outcome === 'success'`.
2. **Skill-fork wiring.** With `skillLevel = Medium`, no `adapter.chat` call is issued. With `skillLevel = Easy` or `Hard`, `adapter.chat` is invoked exactly once per attempt.
3. **Fallback path.** Force `planTripDeterministic` to return `outcome: 'no_feasible_candidates'`; assert `LLMStrategyBrain.planRoute` fallback fires.
4. **Pre-LLM short-circuit precedence.** With a hand where `single_option_shortcircuit` would fire, the deterministic algorithm is not invoked.

### Regression / benchmark

Run `scripts/ai/spatial-prune-analysis.ts` against the historical log set after wiring; confirm:
- Same outcome distribution as the offline analysis (≥ 99.7% match-or-better, 0% strict losses on the same logs).
- Per-turn latency on a sample game stays under 500ms.

## Risks

- **Simulator inaccuracy.** `RouteDetourEstimator.simulateTrip` uses pessimistic per-leg sequencing. OCPT=8 compensates empirically but may need re-tuning if the simulator changes. **Mitigation**: comment in the constants file flags this; the parameter sweep script is preserved for re-tuning.
- **Carry detection drift.** If `isLoadOnTrain` is unreliable in some edge cases (e.g., post-Derailment lost-load events), implicit-carry detection from activeRoute is a fallback. **Mitigation**: log a warning when the two signals disagree; surface in dashboards.
- **Same-card restriction.** Logs show occasional bot plans that appear to chain two demands from the same `cardIndex` (likely card-replacement-after-delivery). The deterministic algorithm refuses to enumerate these. **Mitigation**: if observed in real games as a missed opportunity, file a follow-up ticket; current data shows this restriction does not produce strict losses.
- **No LLM-driven creativity.** Sonnet sometimes proposes routes outside the helper-generated options (this was a stated motivation for the existing strategic-context spec). The deterministic algorithm cannot do this. **Mitigation**: empirical evidence shows Sonnet's "creative" routes are systematically worse than the deterministic top-1, so this is not a regression in practice. If a Hard-skill rebuild wants this capability, the strategic-context blocks remain available.
- **Telemetry continuity.** Existing dashboards or analysis scripts keyed on `decisionSource === 'trip-planner'` will skip the new `'trip-planner-deterministic'` value silently. **Mitigation**: grep for that exact string across `scripts/`, `docs/`, and any internal dashboards; update consumers to accept either value (or filter on a `skillLevel` field instead) as part of this PR.

## Verification before scheduling

- Confirm `GameContext.demands[i].isLoadOnTrain` is canonical and reliable. If not, the carry-detection fallback bears more weight.
- Confirm no current consumer of `decisionSource === 'trip-planner'` distinguishes Easy/Medium/Hard via that field. If consumers need to know, add a `skillLevel` field rather than splitting `decisionSource`.
- Confirm the strategic-context block builders (`buildStrategicContext` etc.) are not consumed by Easy or Hard prompt builders. If they are, leaving them dead-code-but-still-built may be the safer option until Hard is rebuilt.

## Rollout

**Direct cutover.** No feature flag, no A/B. The medium-skill LLM path is deleted in the same PR that lands `DeterministicTripPlanner`. Justification: the offline replay shows zero strict losses across 299 historical Sonnet decisions, so there is no scenario where the deterministic algorithm produces a worse route than the LLM; gating delays a known-strict-improvement.

Concrete deletion list (all medium-only — Easy and Hard paths are preserved):

- The `strategicContext = skillLevel === BotSkillLevel.Medium ? buildStrategicContext(...) : undefined` branch in `planTrip`. Becomes always-undefined for the LLM path (Easy/Hard never read it today).
- The `TRIP_PLAN_SCHEMA_MEDIUM` selection branch. Easy/Hard go straight to `TRIP_PLAN_SCHEMA`.
- The `hasPropose` and `parsed.propose` parsing branches that currently only fire for medium.
- Medium entries in `TRIP_MAX_TOKENS`, `TRIP_EFFORT`, `TEMPERATURE_BY_SKILL` lookup tables — leave the keys present (TypeScript exhaustiveness on the `BotSkillLevel` enum) but document that medium values are never consulted at runtime.

The strategic-context block builders (`buildStrategicContext`, victory-target detector, capital projector, hand-staleness tracker, opponent race state) are NOT deleted in this PR — they remain available for any future Hard-skill rebuild. Mark them with a header comment indicating they have no current consumer.
