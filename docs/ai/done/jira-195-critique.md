# JIRA-195 Critique — Gaps and Misunderstandings in the Turn Orchestration Refactor Plan

**Status:** REVIEW NOTES on `docs/jira/jira-195-turnOrchestrationRefactor.md`.
**Scope:** Verified surface facts against the current tree, then checked the architectural claims Slice-by-Slice.

## Verified facts (plan is right on these)

- File sizes: `ContextBuilder.ts` 3063 LOC, `TurnExecutorPlanner.ts` 2002 LOC, `AIStrategyEngine.ts` 1531 LOC, `ActionResolver.ts` 1664 LOC.
- The 6-stage pipeline is real and labeled with `// ── Stage N` comments in `AIStrategyEngine.ts` (stages 1, 2, 3, 3b, 3c, 3e, 4, 5).
- The `upgradeAdvice` recomputation patch exists (`AIStrategyEngine.ts:228`, plus a second site at `ts:421`).
- `lastMoveTargetCity` is a local at `TurnExecutorPlanner.ts:222`, written at `ts:499`, consumed at `ts:770` — the Phase A → Phase B coupling the plan calls out.
- JIRA-170 auto-deliver + re-snapshot block is real (`AIStrategyEngine.ts:382-436`).

## Major gaps

### 1. `RouteOptimizer` is not in `TurnExecutorPlanner`. Slice 2's premise is wrong.

Plan (lines 46-49, 51-56) says `TurnExecutorPlanner.execute()` invokes `BuildAdvisor`, `RouteEnrichmentAdvisor`, *and* `RouteOptimizer`, and that JIRA-184 untangled their ordering there. It did not.

- `TurnExecutorPlanner.ts` imports and calls only `BuildAdvisor` (`ts:871`, `ts:906`) and `RouteEnrichmentAdvisor` (`ts:470`). It never touches `RouteOptimizer`.
- `RouteOptimizer` is called from `TripPlanner.ts:332`.
- `RouteEnrichmentAdvisor.enrich` is also called from `AIStrategyEngine.ts:459` during initial trip creation, not only from `TurnExecutorPlanner`.

Consequences for Slice 2:
- The "optimize → enrich → build-advise" rule spans **three files** (`TripPlanner`, `AIStrategyEngine`, `TurnExecutorPlanner`), not one. An `AdvisorCoordinator` living only between `TurnExecutorPlanner` and the advisors covers two of three call sites.
- "JIRA-184 had to patch advisor ordering" is retold as a `TurnExecutorPlanner` bug. It was a `TripPlanner` bug (validator vs. optimizer separation) — a different axis.

### 2. ContextBuilder's second responsibility is missing from Slice 1.

The four slices (Demand / Network / Build / Upgrade) only cover *context computation*. But `ContextBuilder.ts` also hosts five prompt serializers, roughly 750 LOC:

- `serializePrompt` (`ts:837`)
- `serializeRoutePlanningPrompt` (`ts:1024`)
- `serializeSecondaryDeliveryPrompt` (`ts:1600`)
- `serializeCargoConflictPrompt` (`ts:1654`)
- `serializeUpgradeBeforeDropPrompt` (`ts:1720`)

Plus supporting helpers (`formatDemandView`, `formatReachabilityNote`, `formatDemandVictoryNote`, etc.). These are prompt construction, not context computation. They belong in a separate module (`ContextSerializer` or alongside `prompts/`), but the plan never names them.

The "~400 LOC facade" exit criterion is not reachable if those serializers stay. Either the plan needs a fifth slice (serialization), or it needs to acknowledge where the ~750 LOC lands.

### 3. Slice 1's stated motivation doesn't match the code it cites.

Plan line 35 says the `upgradeAdvice` patch at `AIStrategyEngine.ts:228-237` "becomes a one-line call to `UpgradeContext.compute()`" after Slice 1. But line 228 **already is** a one-line call: `context.upgradeAdvice = ContextBuilder.computeUpgradeAdvice(...)`. The code is not reaching into a god-object and patching a field — it's calling a named static method that already exists.

The real smell is *ordering*: `ContextBuilder.build()` runs at `ts:220` *before* memory is loaded, so `deliveryCount` isn't known yet, and line 228 re-runs one signal to fix that. Slice 1 preserves `ContextBuilder.build()` as a facade — it doesn't fix the stage-ordering problem. The patch moves from "one line calling ContextBuilder" to "one line calling UpgradeContext." That's not a meaningful improvement.

## Medium issues

### 4. There are at least two re-snapshot sites, not one.

Plan cites the JIRA-170 re-snapshot at `AIStrategyEngine.ts:382-440` as the symptom. Actual file has partial-context rebuilds at **both** `ts:228` (pre-turn upgrade fix) and `ts:417-436` (post auto-delivery). Each does `ContextBuilder.build()` followed by manual field fix-ups (`deliveryCount`, `upgradeAdvice`, `enRoutePickups`, `previousTurnSummary`).

Slice 1's "caching per slice" benefit assumes rebuilds are expensive; the code already does partial rebuilds because they're cheap. The win from caching is smaller than the plan implies.

### 5. Slice 2 silently introduces a behaviour change the plan forbids.

Plan line 19: "No behaviour change is intended in any slice."
Plan line 54: the coordinator will "count LLM calls against a per-turn budget and short-circuit when exhausted."

There is no per-turn LLM budget in the codebase today — neither `TurnExecutorPlanner` nor `TripPlanner` tracks or caps call counts. Adding a budget is new behaviour. Either drop the budget from Slice 2's scope, or acknowledge Slice 2 as a behaviour change and defer budget to a later ticket.

### 6. `BotContext` shape promise is under-specified.

Plan line 38: "every existing field of `BotContext` is still present with the same name and shape."

But the slice types (`DemandContext`, `NetworkContext`, `BuildContext`, `UpgradeContext`) are new. If they're exposed, call sites will start reading `ctx.demand.foo` and scope creeps across the codebase. If they're internal-only and `BotContext` stays flat, the facade has to flatten four typed slices back into one bag on every build — negating the "future signals land in one slice" benefit. The plan needs to pick one and say so.

### 7. Slice 3 ignores the nested `TripPlanner` call inside `TurnExecutorPlanner`.

`TurnExecutorPlanner.ts:454-457` instantiates a new `TripPlanner` and runs a full post-delivery replan *inside* Phase A. The replan then calls `RouteEnrichmentAdvisor.enrich` at `ts:470`.

Plan's Slice 3 splits `TurnExecutorPlanner` into `MovementPhasePlanner` and `BuildPhasePlanner`, but doesn't say which one owns this nested trip-planning call. Phase A calling `TripPlanner` calling `RouteEnrichmentAdvisor` is the actual coupling JIRA-194 landed in — and the split as described doesn't untangle it.

### 8. `AIStrategyEngine.takeTurn()` is defended as "correct" but is 1531 LOC.

Plan line 76: "Not touching the 6-stage pipeline in `AIStrategyEngine.takeTurn()`. That abstraction is correct."

The *abstraction* may be correct, but Stage 3 alone spans `ts:259-838` and is where the JIRA-170 auto-deliver, context-refresh, `TripPlanner` consult, and route-state tracking all live inline. If the goal is "future fixes have an obvious home," this file has the same problem `TurnExecutorPlanner` does. Worth naming as a known-unaddressed scope, not declared out of bounds.

## Minor

### 9. Line-range imprecision.
Plan cites `ts:459-490` for the Phase A post-delivery replan block. The block actually runs ~440-490 (stop-index advance through fallback branches). Not wrong, just imprecise in a plan that relies on line-range extractions.

### 10. Slice 3 size estimates hand-wave shared state.
"~200-550," "~700-1100" don't acknowledge shared state (`deliveriesThisTurn`, accumulated plan steps, route mutation) that crosses the A/B boundary. That shared state is exactly what made JIRA-194 a cross-phase bug. The split needs a named seam — Phase A returns a handoff object (`activeRoute`, `lastMoveTargetCity`, `deliveriesThisTurn`) to Phase B — rather than "lines ~200-550."

## Recommended edits before shipping the plan

1. Rewrite Slice 2 around the two advisors actually in `TurnExecutorPlanner`, or broaden the coordinator's scope to include `TripPlanner`'s `RouteOptimizer` + `RouteValidator` chain. Don't describe it as a single-file cleanup.
2. Add a fifth concern (prompt serialization) to Slice 1, or explicitly keep serializers out of the 400 LOC facade target.
3. Replace the "one-line `UpgradeContext` call" motivation with the real motivation: fixing stage-order coupling between memory load and context build.
4. Drop the LLM budget from Slice 2 scope, or move it to a separately-scoped Slice 2b that owns the behaviour change.
5. State explicitly whether `BotContext` becomes a typed composition (new access patterns) or stays flat (internal slices, public facade unchanged).
6. Name the Phase A ↔ Phase B handoff object for Slice 3.
7. Acknowledge `AIStrategyEngine.takeTurn()` Stage 3 as a known-future-slice rather than declaring it out of scope.
