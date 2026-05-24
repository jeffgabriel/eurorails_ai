# JIRA-184: RouteEnrichmentAdvisor's Proximity Reorder Can Produce Backwards Routes

## Problem

In game `25d8059e-ea12-4d22-9e7d-b35a9844a7df`, Haiku's turn 5 failed with a pipeline error, forcing a `PassTurn`:

```
[TurnExecutorPlanner] INVARIANT VIOLATION: build direction disagrees with move direction.
Build target "Wroclaw" is at route stop 0 but move target "Praha" is at route stop 1.
Bot cannot build backwards along the route.
```

The invariant itself is correct — it guards against the bot building toward an earlier route stop while moving toward a later one. The bug is upstream: something produced a route whose stop order contradicts the bot's direction of travel.

## Root Cause

`RouteValidator.validate` (`src/server/services/ai/RouteValidator.ts:75`) does two unrelated jobs in one call:

1. **Feasibility check** — can the route be walked given bot state, cash, loads, topology?
2. **Stop-order optimization** — `reorderStopsByProximity` greedily reorders stops by nearest-neighbor from the bot's position.

These are orthogonal operations fused into a single method. Callers that want only feasibility have no way to opt out of the reorder — and the reorder is destructive.

`RouteEnrichmentAdvisor.attemptEnrich` (`src/server/services/ai/RouteEnrichmentAdvisor.ts:121`) re-runs `validate` on the enriched route purely to feasibility-check it. The reorder runs anyway and can produce an order where later-intended stops come first (because they're geographically closer), triggering the downstream invariant.

### Turn 5 trace (from `logs/game-25d8059e-ea12-4d22-9e7d-b35a9844a7df.ndjson` + `logs/llm-...`)

1. Turn 4 end: Haiku on route `[P-Praha, P-Praha, D-Szczecin, D-Bruxelles]` (idx=2), carrying 2 Beer, cash 19M, position (28,54).
2. Turn 5: post-delivery replan fires.
3. `TripPlanner.planTrip` returns fresh route `[P-Beer@Praha, D-Beer@Bruxelles]`.
4. `RouteEnrichmentAdvisor.enrich`:
   - LLM advisor returns `decision: "insert"` with `afterStopIndex:0 Holland`, `afterStopIndex:1 Wroclaw`.
   - `applyDecision` produces `[P-Praha(0), P-Holland(1), D-Bruxelles(2), P-Wroclaw(3)]`.
   - **`RouteValidator.validate` reorders this by proximity from the bot's position**, producing an order where Wroclaw precedes Praha.
5. Movement loop advances the bot toward Praha (the reordered stop 1). `lastMoveTargetCity = "Praha"`.
6. Phase B: `resolveBuildTarget` returns the first off-network stop in the reordered route → Wroclaw (now at stop 0).
7. `assertBuildDirectionAgreesWithMove` detects: `buildStopIndex(Wroclaw)=0 < moveStopIndex(Praha)=1` → throws.
8. Pipeline error bubbles up; turn ends as `PassTurn`.

The invariant did its job. The reorder — silently triggered from inside a method named `validate` — is the latent bug.

## Why a flag is the wrong fix

The obvious patch is to add `options.reorderByProximity` to `validate` and have `RouteEnrichmentAdvisor` pass `false`. That was the original proposal. It's a mistake for three reasons:

1. **The name lies.** `validate` is a predicate — "is this route valid?" — but the method also transforms the route. A method that both validates AND reorders is already two methods welded together. A flag to disable half of it just admits the welding.
2. **Default-on is a landmine.** Every future caller that doesn't read the flag docs gets a route they didn't ask for. Silent reorder on by default is the bug we're fixing.
3. **CQS violation.** `validate` answers a question about the route AND modifies the thing being asked about. Fixing that structurally removes an entire category of "why did my route change after I just checked it?" bugs.

The architectural problem is conflation, not configuration. Separate the operations.

## Proposed Fix — split the operations

Extract the reorder into its own class/method. `validate` becomes pure feasibility. Callers compose explicitly.

```ts
// RouteValidator.ts — pure predicate, no mutation
static validate(
  route: StrategicRoute,
  context: GameContext,
  snapshot: WorldSnapshot,
): RouteValidationResult {
  // feasibility checks only; no reorder
}
```

```ts
// RouteOptimizer.ts (new file) — pure transformation
static orderStopsByProximity(
  route: StrategicRoute,
  snapshot: WorldSnapshot,
): StrategicRoute {
  // current contents of reorderStopsByProximity, extracted
}
```

**Callsite updates:**

- `TripPlanner.scoreCandidates` — explicitly compose: call `orderStopsByProximity` on the candidate, then `validate` the result.
- `RouteEnrichmentAdvisor.attemptEnrich` — call `validate` only. The enrichment already decided the stop order; the validator's job is only to say whether it works.

Any other current caller of `validate` that relied on the reorder must be updated to call `orderStopsByProximity` first. Auditing those callers is part of the work.

### Why this is better than a flag

- **Names reflect truth.** `validate` is a predicate. `orderStopsByProximity` names what it does. Neither hides behavior inside the other.
- **No default landmine.** A future caller can't accidentally reorder — they have to explicitly call the optimizer.
- **Composable.** Callers can validate-only, optimize-only, or optimize-then-validate depending on what they need.
- **Testable in isolation.** Feasibility logic and optimization logic each get their own unit tests without fixture contamination.
- **Downstream invariants become stable.** `assertBuildDirectionAgreesWithMove` assumes routes reflect travel intent. That's only true when reorder is explicit at the callsite.

## Files to Modify

| File | Change |
|------|--------|
| `src/server/services/ai/RouteValidator.ts` | Remove `reorderStopsByProximity` block from `validate`. `validate` becomes pure feasibility. |
| `src/server/services/ai/RouteOptimizer.ts` (new) | New class with `orderStopsByProximity(route, snapshot): StrategicRoute`. Move the logic verbatim from `RouteValidator`. |
| `src/server/services/ai/TripPlanner.ts` | In `scoreCandidates`, explicitly call `RouteOptimizer.orderStopsByProximity` before `RouteValidator.validate`. |
| `src/server/services/ai/RouteEnrichmentAdvisor.ts` | Line 121 `validate` call unchanged semantically (it already wanted feasibility-only). No new flag needed — the reorder is simply gone from `validate`. |
| Any other `RouteValidator.validate` caller | Audit: if the caller depended on the reorder, add an explicit `orderStopsByProximity` call. |
| `src/server/__tests__/ai/RouteValidator.test.ts` | Update: `validate` no longer mutates order. Tests that asserted post-validate order must either move to RouteOptimizer tests or be rewritten. |
| `src/server/__tests__/ai/RouteOptimizer.test.ts` (new) | Unit tests for `orderStopsByProximity`: nearest-neighbor behavior, edge cases (single stop, ties, unreachable stops). |
| `src/server/__tests__/ai/RouteEnrichmentAdvisor.test.ts` | Regression test: replay Haiku turn 5. Bot at (28,54), enriched route `[P-Praha, P-Holland, D-Bruxelles, P-Wroclaw]`, post-enrichment `validate` leaves the order intact. Must be a scenario where proximity reorder *would* change the order (e.g., Wroclaw closer to bot than Praha) — otherwise the test passes trivially and catches nothing. |

## Acceptance Criteria

- `RouteValidator.validate` is pure: given the same inputs, returns the same `ValidationResult` and does not mutate the route.
- `RouteOptimizer.orderStopsByProximity` exists as a standalone transformation and is covered by unit tests.
- `TripPlanner.scoreCandidates` continues to produce proximity-ordered candidates (now via an explicit composition), and its existing tests pass.
- `RouteEnrichmentAdvisor.attemptEnrich` does NOT reorder the enriched route. Post-enrichment stop order matches what `applyDecision` produced.
- Regression test replays Haiku's turn 5 scenario with a deliberate proximity-vs-intended-order mismatch and confirms the invariant does NOT fire.
- `assertBuildDirectionAgreesWithMove` remains unchanged.
- No surviving `reorderByProximity` boolean flag, option bag, or conditional inside `RouteValidator`.

## Out of Scope

- Changes to `assertBuildDirectionAgreesWithMove` itself — the invariant is correct.
- Changes to the nearest-neighbor algorithm inside `orderStopsByProximity` — we're relocating, not rewriting, the logic.
- Decision about whether `RouteEnrichmentAdvisor` should ever optimize the enriched route. For now it doesn't; if future analysis shows enriched routes are frequently travel-inefficient, that's a separate ticket with its own design.
- **Prerequisite / blocker:** See **JIRA-185** (post-delivery replan receives a stale snapshot — `cash` and `carriedLoads` frozen at pre-delivery values). JIRA-185 is the triggering bug for this specific Haiku turn-5 failure; this ticket (JIRA-184) addresses a contributing architectural smell that amplifies the failure into an invariant violation. Land JIRA-185 first; the regression test here depends on TripPlanner receiving an honest snapshot so the reorder-vs-intended-order scenario can be constructed deterministically.
