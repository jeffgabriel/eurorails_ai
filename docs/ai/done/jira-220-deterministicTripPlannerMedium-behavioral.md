# JIRA-220 — Replace medium-skill TripPlanner LLM call with deterministic spatial-prune top-1 (behavioral)

## Source

Surfaced via offline analysis on 2026-05-09. Replayed every `decisionSource === 'trip-planner'` entry across 156 game logs (299 trip-planner turns) through a deterministic spatial-prune + top-1 algorithm and compared against the LLM's actual choice. The deterministic algorithm strictly dominates the LLM under accurate simulator-truthful scoring. Analysis script and dump are in `scripts/ai/spatial-prune-analysis.ts`; results table in `scripts/ai/spatial-prune-results.md`.

## Scope

**Medium skill (Sonnet) only.** Easy and Hard skills are explicitly out of scope for this ticket:

- **Easy (Haiku)**: continues to use its candidate-menu LLM design (`docs/trip-candidate-menu-easy-design.md`). The deterministic algorithm could subsume that spec, but Easy is intentionally not touched here.
- **Hard (Opus)**: untouched. Hard remains on the legacy `TRIP_PLANNING_SYSTEM_SUFFIX` LLM composition.

This ticket also **supersedes the existing medium-skill design** (`docs/strategic-trip-planning-medium-design.md`). That spec injects strategic context blocks into the Sonnet prompt; this ticket removes the Sonnet call entirely for medium. The strategic-context blocks may still be useful for Hard if/when that skill level is rebuilt — they are not deleted, just unused for medium.

## Current behavior

When a medium-skill bot reaches `TripPlanner.planTrip`:

1. Strategic context is built (per the existing medium spec).
2. The system+user prompt is constructed.
3. The Sonnet model is invoked via `adapter.chat(...)` with `temperature=0.4`, `maxTokens=12288`, `outputSchema=TRIP_PLAN_SCHEMA_MEDIUM`. Latency is typically 30–60s (memory note: avg ~45s; in some games 70s with adaptive thinking enabled).
4. The model returns a JSON `LLMTripPlanResponse`. Up to 2 retries on parse/validation errors. On total failure, falls back to `LLMStrategyBrain.planRoute`.
5. The chosen plan is run through scoring/validation/affordability/upgrade-normalization and emitted as a `StrategicRoute`.

## Expected behavior

When a medium-skill bot reaches `TripPlanner.planTrip`, the LLM call is replaced with a deterministic algorithm:

1. Detect carried loads (combine canonical `supplyCity === null` rows with implicit carries detected by reconciling `activeRoute` against `demandCards`).
2. Enumerate all single, pair, and triple demand-fulfillment candidates respecting train capacity and the same-card rule.
3. Cheap-prune candidates whose optimistic turn count exceeds a threshold or whose optimistic build cost exceeds a threshold.
4. Run the surviving candidates through the existing `RouteDetourEstimator.simulateTrip` for accurate `(turns, build cost, feasibility)`.
5. Score each survivor: `score = (payout − buildCost) − OCPT × turns`.
6. Take the top-scoring candidate. Emit the same `TripPlanResult` shape the LLM path emits today (`route`, `reasoning`, `outcome`, `llmLog`).
7. The pre-LLM short-circuits (`no_actionable_options`, `keep_current_plan`, `single_option_shortcircuit`) remain in place and continue to fire before the deterministic algorithm runs.
8. The downstream pipeline (`scoreCandidates`, `RouteValidator`, affordability check, upgrade-label normalization, `RouteEnrichmentAdvisor`, `LlmAttempt` logging) remains unchanged. The only field that changes shape is `llmLog` — for medium it will record a synthetic entry rather than a real LLM call (so dashboards continue to work).
9. The existing `LLMStrategyBrain.planRoute` fallback path is retained — if the deterministic algorithm produces zero feasible candidates (e.g., everything pruned, none simulator-feasible), fall back to `planRoute` as today.

## Empirical evidence

Over 299 trip-planner decisions (Sonnet-driven medium-skill bots in real games), with simulator-truthful scoring:

| Outcome | Count | % |
|---|---:|---:|
| Top-1 == Sonnet's choice | 106 | 35.5% |
| Top-1 strictly better than Sonnet | 170 | 56.9% |
| Top-1 strictly worse than Sonnet | **0** | **0.0%** |
| Top-1 different but tied / unmappable bot choice | 23 | 7.7% |

- **Mean score delta (top-1 − Sonnet)**: +23.65
- **Median score delta**: +12
- **Worst-case strict loss**: none (min delta is 0)

Recommended tunables (empirically derived via parameter sweep at `scripts/ai/sweep-spatial-prune.py`):

- `OCPT = 8` (opportunity cost per turn, in ECU-equivalent score points). Higher than the spec's 5 because the simulator's "build all then move next turn" sequencing inflates turn counts; OCPT=8 compensates.
- `PRUNE_MAX_TURNS = 12`, `PRUNE_MAX_BUILD_M = 130` — sufficient to admit every candidate the simulator would later validate as competitive. Tighter or looser values give identical results.

## Why this matters

1. **Bot quality.** The deterministic algorithm is at least as good as Sonnet on every observed decision and strictly better on more than half. Sonnet's failure mode is overwhelmingly *forgetting carried loads* — the top-3 highest deltas (+212, +148, +145) are all cases where Sonnet planned a fresh expensive trip while the bot was carrying a deliverable load worth 16M+. The deterministic algorithm catches this trivially.
2. **Latency.** Sonnet trip planning costs ~45s per turn. The deterministic algorithm runs the simulator on ~30 candidates per turn at ~5–10ms each → ~50–300ms total. Per-game wall-clock for medium bots drops from ~45s/turn × dozens of turns to negligible.
3. **Cost.** Zero token spend on medium-skill trip planning.
4. **Determinism.** Same game state always produces the same plan. Easier to debug, easier to test, no LLM-temperature noise.
5. **Failure mode shift.** When Sonnet fails (parse error, schema violation, timeout), we fall through to `LLMStrategyBrain.planRoute` heuristic. With this change, the deterministic algorithm IS the heuristic; failure is now "no feasible candidates" which is recoverable via the same fallback.

## Out of scope for this ticket

- Easy-skill candidate menu (`docs/trip-candidate-menu-easy-design.md`) — referenced but not modified.
- Hard-skill (Opus) trip planning — untouched.
- Removing or refactoring the strategic-context block builders (`buildStrategicContext`, victory-target detector, capital projector, hand-staleness tracker, opponent race state). They become unreferenced for medium and continue to compile; they remain available for any future Hard-skill rebuild.
- Changing the simulator's per-leg "build all then move" sequencing. OCPT compensates for this empirically; the simulator itself is not under review.
- Changing `RouteEnrichmentAdvisor`. It still runs after the deterministic plan is produced.
- Changing the candidate-pair "same card" restriction. The analysis confirmed this restriction is correct under current rules.

## Decisions (review-confirmed 2026-05-09)

1. **Rollout: direct cutover.** No feature flag, no A/B. The medium-skill LLM trip-planner path is removed; the deterministic algorithm is the only path. Rationale: empirical evidence shows zero strict losses across 299 historical decisions, so there is no scenario where the deterministic algorithm produces a worse route than Sonnet. Gating delays a known-strict-improvement.
2. **Reasoning string: verbose.** The `route.reasoning` field explains the decision in enough detail that a human reviewing a game log can understand *why* this trip was selected. Concretely: list the top-3 ranked candidates with their (payout, build, turns, score) and call out which patterns (carry, shared supply/delivery, transit) the winner exploits. Format detail in the technical ticket.
3. **No live telemetry dashboard.** Medium-skill bots no longer call the LLM, so per-turn deterministic-vs-LLM win-rate tracking has no production signal to compare against. The offline replay tooling (`scripts/ai/spatial-prune-analysis.ts`) is retained for one-off audits if scoring or pruning constants are tuned later.
4. **OCPT calibration comment required.** The constants file must call out that OCPT=8 compensates for the `RouteDetourEstimator` simulator's pessimistic per-leg "build all then move next turn" sequencing. If that sequencing is fixed in a future ticket, OCPT must be re-tuned (likely toward 5, the bot's per-turn income upper bound). The comment is mandatory because the value otherwise looks arbitrary.
