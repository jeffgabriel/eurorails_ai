# JIRA-195b Sub-slice D — Hypothetical Bypass Plan (Option B)

**Purpose:** Document the specific work I would do if we bypassed compounds task-generation and implemented NewRoutePlanner directly in the main agent context. Saved to disk so we can compare against what compounds actually produces, once its breakdown finishes and tasks are generated.

**Project:** `9666d3e8-1944-4a23-950d-310871132a3a` (JIRA-195b Sub-slice D: NewRoutePlanner extraction)
**Spec:** `.compounds/9666d3e8-1944-4a23-950d-310871132a3a/spec.md` (already uploaded; contents established the scope)
**Source:** Sub-stages D1–D7 + E inside `AIStrategyEngine.ts:361-710` (~349 LOC).
**Branch:** `compounds/guardrail-updates`.
**Authored:** before compounds breakdown completed, so the comparison is honest.

## What I'd actually do, step by step

### Step 1 — Read the source code I'm extracting (~15 min)

Read `AIStrategyEngine.ts` lines roughly 360–840 in detail. Catalogue:

- **D1 — Auto-delivery (`ts:365-405`):** loop over `context.canDeliver`; for each, call `TurnExecutor.executeMultiAction` with a single `TurnPlanDeliverLoad`; collect `autoDeliveredLoads`; if any delivered, re-`capture(snapshot.gameId, ...)` and rebuild `context = await ContextBuilder.build(...)`. JIRA-170.
- **D2 — TripPlanner (`ts:407-447`):** instantiate `new TripPlanner(brain)`, call `await tripPlanner.planTrip(snapshot, context, gridPoints, memory)`, capture the full result into `tripPlanResult`, extract route, prompts, llmLog. JIRA-126/194.
- **D3 — RouteEnrichmentAdvisor (`ts:453-460`):** if route present, `route = await RouteEnrichmentAdvisor.enrich(route, snapshot, context, brain, gridPoints)`. JIRA-165/173. Try/catch with log-and-continue on failure.
- **D4 — Upgrade consumption (`ts:462-469`):** if `route.upgradeOnRoute`, call `tryConsumeUpgrade(...)`, set `pendingUpgradeAction` or `upgradeSuppressionReason`. JIRA-105.
- **D5 — Dead-load drop (`ts:472-501`):** scan `snapshot.bot.loads` against route demand; for any not on route, push a `TurnPlanDropLoad` into `deadLoadDropActions`. JIRA-89. Sets `secondaryDeliveryLog`.
- **D6 — Cargo conflict (`ts:506-617`):** if `route.stops.filter(action==='pickup').length > capacity - currentLoads`, run JIRA-105b upgrade-before-drop LLM call (`brain.evaluateUpgradeBeforeDrop`); if upgrade rejected, run JIRA-92 cargo conflict LLM call (`brain.evaluateCargoConflict`) to pick a load to drop; push DropLoad to `deadLoadDropActions`.
- **D7 — New-route executor (`ts:619-660`):** call `await TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain, gridPoints)`; prepend `deadLoadDropActions` to the resulting plans; set `decision.plan` (single, MultiAction, or PassTurn fallback); populate `execCompositionTrace`.
- **E — LLM fallback (`ts:661-696`):** if no route from TripPlanner, call `await ActionResolver.heuristicFallback(snapshot, context, brain, gridPoints)`; on success, plan from result; on failure, JIRA-120 LLM-failure-counter increment + PassTurn. The 12 LOC no-LLM-key inline branch (`ts:698-710`) stays at the orchestrator level per ADR-2 — NOT in NewRoutePlanner.

Also read `Stage3Result` interface (committed in Sub-slice A, `schemas.ts`) and `InitialBuildRunner.ts` / `ActiveRouteContinuer.ts` as the structural references for the new file.

### Step 2 — Create `src/server/services/ai/NewRoutePlanner.ts` (~45–60 min)

Single static-method class. Signature (using actual codebase types, not spec naming):

```ts
export class NewRoutePlanner {
  static async run(
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
    memory: BotMemoryState,
    tag: string,
    botPlayerId: string,
    gameId: string,
  ): Promise<Stage3Result & {
    autoDeliveredLoads?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
    tripPlanResult?: TripPlanResult | null;
  }>
}
```

I'd add the two extra fields (`autoDeliveredLoads`, `tripPlanResult`) onto the return type because both are declared at outer scope in `AIStrategyEngine.ts:262-265` and consumed downstream in the result-construction block (~`ts:1180-1200`). Same lesson learned in Sub-slice C with `evaluatedOptions`/`evaluatedPairings` — anything declared outside the branch and read after must be returned.

Body shape: verbatim transcription of D1→D2→D3→D4→D5→D6→D7→E in order, with these adjustments:

- All the `let snapshot = ...` and `let context = ...` reassignments (JIRA-170) become local-variable reassignments. The final values are returned via `Stage3Result.snapshot` and `Stage3Result.context`. **This is the architecturally important change** — the JIRA-170 mutation becomes explicit at the type-system boundary.
- All four LLM call sites preserved verbatim, including their existing try/catch shapes. No new error handling, no consolidation.
- Internal helper methods OK if a sub-block is large (e.g., `private static async resolveCargoConflict(...)`) but I'd lean toward keeping D1-D7 inline within `run()` to make the code-motion diff easy to review.

Expected size: 350–400 LOC, comparable to the original inline branch.

Imports (predictable from the source code):

```ts
import { WorldSnapshot, GameContext, GridPoint, AIActionType,
         TurnPlan, TurnPlanDeliverLoad, TurnPlanDropLoad,
         TurnPlanUpgradeTrain, BotMemoryState, ... } from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { TripPlanner, TripPlanResult } from './TripPlanner';
import { RouteEnrichmentAdvisor } from './RouteEnrichmentAdvisor';
import { TurnExecutor } from './TurnExecutor';
import { TurnExecutorPlanner, CompositionTrace } from './TurnExecutorPlanner';
import { ActionResolver } from './ActionResolver';
import { ContextBuilder } from './ContextBuilder';
import { capture } from './WorldSnapshotService';
import { tryConsumeUpgrade } from './<wherever-it-lives>'; // grep first
import type { Stage3Result } from './schemas';
```

### Step 3 — Create `src/server/__tests__/ai/NewRoutePlanner.test.ts` (~45 min)

Mirror the structure of `ActiveRouteContinuer.test.ts` (the established style reference). Mock at the `LLMStrategyBrain`, `TripPlanner`, `RouteEnrichmentAdvisor`, `TurnExecutor`, `TurnExecutorPlanner`, `WorldSnapshotService`, `ContextBuilder`, `ActionResolver` boundaries.

Tests (8 minimum, matching the spec's R4F):

1. **TripPlanner success path** — returns route; D3 enrich runs; D7 executor runs; result has populated decision + activeRoute.
2. **TripPlanner null route → heuristic fallback** — TripPlanner returns `{ route: null, ... }`; `ActionResolver.heuristicFallback` mocked to succeed; decision built from fallback.
3. **TripPlanner null route → heuristic also fails → PassTurn** — both fail; decision is PassTurn; JIRA-120 counter incremented.
4. **JIRA-170 auto-delivery refresh** — `context.canDeliver` non-empty; mock `TurnExecutor.executeMultiAction` to succeed; mock `capture` and `ContextBuilder.build` to return updated values; assert `result.snapshot` and `result.context` are the post-refresh values; assert `result.autoDeliveredLoads` populated.
5. **JIRA-105 upgrade consumption** — TripPlanner returns route with `upgradeOnRoute`; mock `tryConsumeUpgrade` to return an upgrade action; assert `result.pendingUpgradeAction` populated; `result.upgradeSuppressionReason` null.
6. **JIRA-89 dead-load drop** — bot carries load X, route has no demand for X; assert `result.deadLoadDropActions` contains a DropLoad for X; assert `secondaryDeliveryLog` populated.
7. **JIRA-105b upgrade-before-drop** — pickups exceed capacity; mock `brain.evaluateUpgradeBeforeDrop` to suggest upgrade; assert pendingUpgradeAction set, no drop generated.
8. **JIRA-92 cargo conflict (drop path)** — pickups exceed capacity; mock upgrade-before-drop to reject upgrade; mock `brain.evaluateCargoConflict` to pick a load to drop; assert DropLoad in `deadLoadDropActions`.

The four LLM mocks are non-trivial to set up but each test only mocks the ones it exercises. Other branches mocked to no-op defaults in `beforeEach`.

Expected size: 400–600 LOC.

Run with `npx jest src/server/__tests__/ai/NewRoutePlanner.test.ts --silent` (target only).

### Step 4 — Modify `src/server/services/ai/AIStrategyEngine.ts` (~30 min)

Replace the inline sub-stages D1–D7 + E (`ts:361-710`) with a call to `NewRoutePlanner.run(...)`. The branch becomes ~12 LOC:

```ts
} else if (AIStrategyEngine.hasLLMApiKey(botConfig)) {
  // ── No active route, LLM available — delegated to NewRoutePlanner (sub-slice D) ──
  const stage3 = await NewRoutePlanner.run(
    snapshot, context, brain, gridPoints, memory, tag, botPlayerId, gameId,
  );
  ({
    decision, activeRoute, routeWasCompleted, routeWasAbandoned, hasDelivery,
    previousRouteStops, secondaryDeliveryLog, deadLoadDropActions,
    pendingUpgradeAction, upgradeSuppressionReason, execCompositionTrace,
  } = stage3);
  snapshot = stage3.snapshot;            // JIRA-170: explicit reassignment
  context = stage3.context;
  if (stage3.autoDeliveredLoads) autoDeliveredLoads.push(...stage3.autoDeliveredLoads);
  if (stage3.tripPlanResult) tripPlanResult = stage3.tripPlanResult;
}
```

Add `import { NewRoutePlanner } from './NewRoutePlanner';` next to the existing `InitialBuildRunner` and `ActiveRouteContinuer` imports.

The no-LLM-key branch (`else { ... }` at `ts:698-710`) stays inline per ADR-2.

### Step 5 — Build + test (~10 min)

- `npx tsc --noEmit` — zero new errors in the three changed files (AIStrategyEngine.ts, NewRoutePlanner.ts, NewRoutePlanner.test.ts). Pre-existing errors in TripPlanner.test.ts etc. are not my concern.
- `npx jest src/server/__tests__/ai/NewRoutePlanner.test.ts --silent` — 8/8 pass.
- `npx jest src/server/__tests__/ai/ActiveRouteContinuer.test.ts src/server/__tests__/ai/InitialBuildRunner.test.ts --silent` — regression check; should be 15/15 pass unchanged.

If TS errors surface in test files I touched (similar to Sub-slice C's nullable-activeRoute issue), tighten the test types only — don't paper over real bugs.

### Step 6 — Commit (~5 min)

Three logical commits, each pushed to `origin/compounds/guardrail-updates`:

**Commit 1 — `feat(ai): JIRA-195b sub-slice D BE-001 extract NewRoutePlanner service`** — adds `NewRoutePlanner.ts`. ~350 LOC new code. Description: pure code motion from sub-stages D1-D7 + E; full Stage3Result return because of JIRA-170 snapshot reassignment; four LLM call sites preserved verbatim with existing try/catch shapes.

**Commit 2 — `test(ai): JIRA-195b sub-slice D BE-003 unit tests for NewRoutePlanner`** — adds `NewRoutePlanner.test.ts`. 8 tests covering all sub-blocks D1-D7 + E. Uses the LLMStrategyBrain mocking boundary established by ActiveRouteContinuer.test.ts.

**Commit 3 — `refactor(ai): JIRA-195b sub-slice D BE-002 integrate NewRoutePlanner`** — modifies `AIStrategyEngine.ts`. 349-LOC inline branch reduced to 14-line call + destructure. `snapshot`/`context` reassignment becomes explicit per ADR-3 in the spec. Mark "closes JIRA-195b master plan" in the body.

### Step 7 — Mark project DONE (~30 sec)

Three options for marking the compounds project DONE without going through `implement_task_finalize`:

- If the breakdown service eventually produces tasks that approximate my commit list, retroactively `implement_task_finalize` each (with the `complete_subtasks` + `mark_done` dance, prepared to handle false-positive E2E gates per the Sub-slice C TEST-001 workaround).
- If breakdown failed or produced unusable tasks, `update_project(projectId="9666d3e8-...", status="DONE")` directly. Same workaround used for Sub-slice 3 of JIRA-195's first attempt (project `27516513-...`).

## Total time estimate

Roughly 2.5–3 hours of focused work in the main context, no subagent. Compares favorably to the 1.5–2 hour breakdown wait + 30 min implementation pattern that subsequent slices have actually shown — but the main savings come from eliminating the timeout-retry cycle that Sub-slice B and C hit.

## What this preserves vs. drops vs. compounds

| Item | Compounds workflow | Bypass plan |
|---|---|---|
| Implementation correctness | Same | Same — both work from the same spec |
| Per-task git commits | Per generated task (typically 3-5) | Three logical commits per the natural code-motion shape |
| Per-task tracking in compounds dashboard | Yes | No — single project marked DONE manually |
| `implement_task_finalize` validation prompts | Yes (with the false-positive E2E-gate friction we've seen) | No |
| Subtask tracking | Yes | No |
| Subagent delegation | Yes (and unreliable — three timeouts on this slice's predecessors) | No subagent |
| Audit trail of what was done | Compounds project DONE + commits | Commits + this document + commit messages |

The bypass loses dashboard-level granularity. It keeps git-level granularity (which is what actually matters for code review).

## What we'd actually compare

When compounds eventually produces tasks for this project, three things to compare against this document:

1. **Task count and granularity** — does compounds split into 1 implementation + 1 test + 1 integration task (matching my commit count), or into a different shape (per-sub-block, per-LLM-call, etc.)?
2. **Subtask depth** — does compounds add subtasks for each LLM call, each JIRA-tagged feature, etc., or stay coarse?
3. **Hidden requirements** — does compounds surface requirements I missed (e.g., a task for documentation, or a manual smoke test like Sub-slice C had, or pattern-conformance subtasks)?

If compounds adds genuine value beyond what's documented here (e.g., catches a constraint I missed), that's evidence in favor of the workflow. If it produces three tasks that mirror my three commits with no extra signal, it suggests the workflow's overhead isn't paying for itself on a refactor of this shape.
