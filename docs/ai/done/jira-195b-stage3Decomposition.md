# JIRA-195b: Stage 3 Decomposition Scoping Spike

**Status:** SPIKE — output of JIRA-195 Slice 4. No code change.
**Related:** JIRA-195 (parent), JIRA-105, JIRA-105b, JIRA-89, JIRA-92, JIRA-126, JIRA-129, JIRA-165, JIRA-170, JIRA-173, JIRA-185.
**Boundary note:** This spike covers `AIStrategyEngine.ts:237-838`. The spec scoped Stage 3 as `ts:259-727` but the sub-stages 3b (validation, `ts:724-781`), 3c (route state tracking, `ts:782-803`), and 3e (continuation, `ts:804-833`) are direct continuations of the same decision locals and cannot be extracted without also handling the Stage 4 handoff at `ts:835`. This document treats the whole block `ts:237-838` as the extraction scope.

## Why now

JIRA-195 Slices 1–3 cleaned up `ContextBuilder` and `TurnExecutorPlanner`. Stage 3 of `AIStrategyEngine.takeTurn` is the largest remaining inline block: approximately 600 LOC of decision-gate logic, route consultation, post-route enrichment, upgrade consumption, dead-load handling, cargo-conflict resolution, plan composition, validation, and continuation. Every new strategic fix (JIRA-89, JIRA-92, JIRA-105, JIRA-105b, JIRA-126, JIRA-129, JIRA-170, JIRA-185, and so on) landed here as a conditional inside an already-large if/else/else chain. This spike exists to ask: can we split it, and if so, how?

## Current behaviour (plain English)

When the bot enters Stage 3, it has a snapshot, a context, a brain, and a (possibly null) active route. From there, it does one of four things:

1. **Initial build.** If `context.isInitialBuild` is set and there is no `activeRoute` in the `build` phase, `InitialBuildPlanner` computes the first route heuristically. No LLM call. The result is stored into `activeRoute` and immediately handed to `TurnExecutorPlanner` for Phase B (build segments). JIRA-148 added demand-score injection here.

2. **Active-route continuation.** If the bot already has a route from a prior turn, call `TurnExecutorPlanner.execute` and accept whatever it produces. The result is a plan + updated route state, which is stored back into `execResult`. JIRA-129 scoped the brain here; JIRA-185 tracked replan LLM data for the debug overlay.

3. **No route — LLM consultation.** The large branch. In order:
   - **JIRA-170 auto-delivery** (`ts:365-405`): if the bot can deliver immediately, execute deliveries against the DB, then re-capture the snapshot and rebuild context so TripPlanner sees fresh demand cards.
   - **TripPlanner** (`ts:407-447`): call LLM for a new multi-stop route. JIRA-126 introduced this planner; JIRA-194 added the full-result capture for the selection diagnostic.
   - **RouteEnrichmentAdvisor** (`ts:453-460`): enrich the freshly planned route with corridor context. JIRA-165 added this call.
   - **Upgrade consumption** (`ts:462-469`): if the new route carries an `upgradeOnRoute` signal from the LLM, call `tryConsumeUpgrade` and stash a `pendingUpgradeAction`. JIRA-105 added this.
   - **Dead-load drop** (`ts:472-501`): if the bot is carrying loads with no demand on the new route, produce drop actions now. JIRA-89 added this.
   - **Cargo conflict** (`ts:506-617`): if the route's pickup count exceeds free slots, first check whether upgrading the train gives enough capacity (JIRA-105b's upgrade-before-drop LLM call), then if not, ask the LLM to pick a load to drop (JIRA-92).
   - **TurnExecutorPlanner** (`ts:620-660`): execute the first step of the new route. Prepend dead-load drops into the plan.
   - **LLM fallback** (`ts:662-710`): if TripPlanner returned no route, try `ActionResolver.heuristicFallback`; if that fails too, pass the turn.

4. **No LLM key** (`ts:698-710`): pass turn immediately.

After all four branches converge:
- **Upgrade injection** (`ts:714-722`): if `pendingUpgradeAction` is set, append it to the plan.
- **Stage 3b — Validation** (`ts:724-780`): `TurnValidator.validate` checks hard gates; if violated, strip Phase B actions (build/upgrade) and re-validate.
- **Stage 3c — Route state tracking** (`ts:782-803`): detect deliveries in the composed plan; preserve remaining route stops for LLM context continuity.
- **Stage 3e — Continuation** (`ts:804-833`): if the route just completed, simulate plan effects on a cloned snapshot and call `ActionResolver.heuristicFallback` to fill remaining budget. JIRA-89 adds dead-load drops as a prefix.

## Shared state that constrains extraction

These locals are declared before Stage 3, written across multiple branches, and read in later sub-stages or in Stage 4+:

| Variable | Where declared | Written by | Read by | Nature |
|---|---|---|---|---|
| `activeRoute` | `ts:247` | All four branches + 3c | 3b validation, 3c, 3e, Stage 4+, memory update | Mutable cross-branch state — the key handoff to memory |
| `decision` | `ts:242` | All four branches | 3b (re-validates), 3c, 3e (continuation appended), Stage 4 | Mutable result; re-assigned after validation strip |
| `pendingUpgradeAction` | `ts:256` | JIRA-105 upgrade consumption + JIRA-105b upgrade-before-drop | Upgrade injection block at `ts:718` | Written mid-branch, consumed at block end |
| `execCompositionTrace` | `ts:252` | Active-route and new-route branches | Stage 3b compositionTrace initialization | Nullable result from TurnExecutorPlanner |
| `routeWasCompleted` | `ts:249` | TurnExecutorPlanner result propagation | Stage 3c, Stage 3e | Boolean flag |
| `routeWasAbandoned` | `ts:250` | TurnExecutorPlanner result propagation | Stage 3c | Boolean flag |
| `hasDelivery` | `ts:251` | TurnExecutorPlanner result + Stage 3c scan | Stage 3c, memory update downstream | Boolean flag |
| `previousRouteStops` | `ts:253` | Stage 3c | Memory update downstream | Preserved for LLM context |
| `secondaryDeliveryLog` | `ts:254` | JIRA-89 dead-load drop | Game log downstream | Diagnostic only |
| `deadLoadDropActions` | `ts:255` | JIRA-89 dead-load drop | Stage 3e plan prefix | Actions array |
| `upgradeSuppressionReason` | `ts:257` | JIRA-105b, JIRA-161 | Game log downstream | Diagnostic only |
| `snapshot` | outer | JIRA-170 re-captures snapshot | All subsequent code | Reassigned — the mutation is intentional |
| `context` | outer | JIRA-170 rebuilds context | All subsequent code | Reassigned after auto-delivery |
| `brain` | `ts:244` | Created once at outer scope (JIRA-129) | TripPlanner, enrichment, upgrade-before-drop, cargo conflict, TurnExecutorPlanner | Passed to every LLM call; null if no key |
| `memory` | outer | Read-only in Stage 3 | TripPlanner, dead-load count gate, upgrade gates | Pure input |
| `gridPoints` | outer | Read-only | TripPlanner, enrichment, TurnExecutorPlanner | Pure input |

The most extraction-hostile variables are `activeRoute` (cross-branch mutable result that feeds everything downstream), `decision` (assembled piecemeal and then post-processed by validation and continuation), `pendingUpgradeAction` (written in one branch, consumed at the end of the whole block), and the `snapshot`/`context` mutation in JIRA-170. Any extracted service must either receive all of these as in/out parameters on a typed result, or the caller must re-assign them from the result. This is manageable but non-trivial.

## Natural sub-stages

### Sub-stage A: Decision gate (`ts:237-264`)

Declares all shared locals. Checks `context.isInitialBuild` and reads `memory.activeRoute` to determine which of the four branches to enter. This is 27 lines of variable declarations and a comment; it has no obvious extraction target by itself, but it represents the inputs to a hypothetical `Stage3Input` record.

### Sub-stage B: Initial build planner (`ts:265-318`)

`context.isInitialBuild && no build-phase activeRoute`. Calls `InitialBuildPlanner.planInitialBuild`, builds `activeRoute`, and immediately calls `TurnExecutorPlanner.execute` for Phase B segments. Produces: `activeRoute`, `decision`, `execCompositionTrace`. JIRA-148 demand-score injection lives here.

### Sub-stage C: Active-route continuation (`ts:319-360`)

`activeRoute` already set. Calls `TurnExecutorPlanner.execute` and propagates the result into `decision`, `execCompositionTrace`, `routeWasCompleted`, `routeWasAbandoned`, `activeRoute`, `hasDelivery`. JIRA-185 replan LLM data propagation lives here.

### Sub-stage D: Auto-delivery + TripPlanner consultation (`ts:361-660`)

Largest sub-stage, entered when there is no active route and a brain is available. Contains:
- **D1 (JIRA-170 auto-delivery):** `ts:364-405`. Delivers immediately-deliverable loads, re-captures snapshot and context.
- **D2 (TripPlanner):** `ts:407-447`. LLM route call. JIRA-126, JIRA-194.
- **D3 (RouteEnrichmentAdvisor):** `ts:453-460`. Corridor enrichment on new route. JIRA-165, JIRA-173.
- **D4 (upgrade consumption):** `ts:462-469`. Consume `upgradeOnRoute`. JIRA-105.
- **D5 (dead-load drop):** `ts:472-501`. Detect and stage dead-load drops. JIRA-89.
- **D6 (cargo conflict):** `ts:506-617`. Upgrade-before-drop (JIRA-105b) and cargo conflict resolution (JIRA-92).
- **D7 (new-route executor):** `ts:619-660`. Call `TurnExecutorPlanner` for first step; prepend dead-load drops.

### Sub-stage E: LLM fallback (`ts:661-710`)

When D2 returns no route, run `ActionResolver.heuristicFallback`. JIRA-120 LLM failure counter injection lives here. Falls through to pass-turn if heuristic also fails. The no-API-key branch (`ts:698-710`) also lives here logically.

### Sub-stage F: Upgrade injection, validation, route state, continuation (`ts:712-833`)

Post-branch convergence. Four sequential operations:
- **F1 (upgrade injection):** `ts:714-722`. Appends `pendingUpgradeAction` if set. JIRA-105, JIRA-161.
- **F2 (Stage 3b validation):** `ts:724-780`. `TurnValidator.validate`; Phase B strip on violation. JIRA-192, JIRA-195.
- **F3 (Stage 3c route state):** `ts:782-803`. Delivery detection; `previousRouteStops` preservation.
- **F4 (Stage 3e continuation):** `ts:804-833`. Route-completion heuristic fill; dead-load prefix. JIRA-97, JIRA-89.

## Proposed extraction shape

The mutable-locals problem is real but solvable with a typed result record passed back to the caller. The shape below mirrors what Slice 3b did for `PhaseAResult`.

### `interface Stage3Result`

```typescript
interface Stage3Result {
  decision: LLMDecisionResult;
  activeRoute: StrategicRoute | null;
  routeWasCompleted: boolean;
  routeWasAbandoned: boolean;
  hasDelivery: boolean;
  previousRouteStops: RouteStop[] | null;
  secondaryDeliveryLog?: { action: string; reasoning: string; /* ... */ };
  deadLoadDropActions: TurnPlanDropLoad[];
  pendingUpgradeAction: TurnPlanUpgradeTrain | null;
  upgradeSuppressionReason: string | null;
  execCompositionTrace: CompositionTrace | null;
  // JIRA-170: refreshed snapshot/context if auto-delivery ran
  snapshot: WorldSnapshot;
  context: BotContext;
}
```

This record makes `AIStrategyEngine` a thin caller: invoke Stage 3, unpack `Stage3Result` into the outer locals, continue to Stage 4.

### Service 1: `InitialBuildRunner`

```typescript
class InitialBuildRunner {
  static async run(
    snapshot: WorldSnapshot,
    context: BotContext,
    brain: LLMStrategyBrain | null,
    gridPoints: GridPointData[],
    memory: BotMemoryState,
    tag: string,
  ): Promise<Pick<Stage3Result, 'activeRoute' | 'decision' | 'execCompositionTrace'>>
}
```

Owns sub-stage B (`ts:265-318`). Reads `context.isInitialBuild`, calls `InitialBuildPlanner`, calls `TurnExecutorPlanner`. Pure extraction — no shared mutable state beyond what it returns. Straightforward.

### Service 2: `NewRoutePlanner`

```typescript
class NewRoutePlanner {
  static async run(
    snapshot: WorldSnapshot,
    context: BotContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPointData[],
    memory: BotMemoryState,
    tag: string,
  ): Promise<Stage3Result>
}
```

Owns sub-stages D1–D7 and E (`ts:361-710`). This is the genuinely complex extraction. It contains the JIRA-170 snapshot/context mutation, which means `snapshot` and `context` must be fields on the result record (see `Stage3Result` above), not just parameters. The `pendingUpgradeAction` and `deadLoadDropActions` are computed mid-run and must be returned. All four LLM calls (TripPlanner, RouteEnrichmentAdvisor, upgrade-before-drop, cargo conflict) are self-contained behind try/catch blocks and can move verbatim. The LLM fallback (`ts:661-696`) is a natural internal fallback path, not a separate method.

Feasibility note: the JIRA-170 `snapshot` reassignment is the single messiest part. After auto-delivery, the local `snapshot` and `context` are replaced. Inside `NewRoutePlanner`, that is just a local variable reassignment. The result carries the final `snapshot` and `context` back to the caller. This is clean once you have the result record.

### Service 3: `ActiveRouteContinuer`

```typescript
class ActiveRouteContinuer {
  static async run(
    activeRoute: StrategicRoute,
    snapshot: WorldSnapshot,
    context: BotContext,
    brain: LLMStrategyBrain | null,
    gridPoints: GridPointData[],
    tag: string,
  ): Promise<Pick<Stage3Result, 'decision' | 'activeRoute' | 'routeWasCompleted' | 'routeWasAbandoned' | 'hasDelivery' | 'execCompositionTrace'>>
}
```

Owns sub-stage C (`ts:319-360`). Straightforward: calls `TurnExecutorPlanner.execute` and propagates results. No LLM calls. No shared state mutations. Could reasonably stay inline in `AIStrategyEngine` given its simplicity (it's 41 lines), but extracting it makes the decision gate symmetric.

### Stage 3 orchestrator (stays in `AIStrategyEngine`)

After extraction, Stage 3 in `AIStrategyEngine` becomes:

```typescript
let stage3: Stage3Result;
if (context.isInitialBuild && (!activeRoute || activeRoute.phase !== 'build')) {
  stage3 = await InitialBuildRunner.run(snapshot, context, brain, gridPoints, memory, tag);
} else if (activeRoute) {
  stage3 = await ActiveRouteContinuer.run(activeRoute, snapshot, context, brain, gridPoints, tag);
} else if (brain) {
  stage3 = await NewRoutePlanner.run(snapshot, context, brain, gridPoints, memory, tag);
} else {
  stage3 = buildNoKeyResult(tag); // pass turn
}
// Unpack Stage3Result into locals
({ decision, activeRoute, routeWasCompleted, ... } = stage3);
snapshot = stage3.snapshot; // JIRA-170 re-capture propagated
context = stage3.context;
// Sub-stages F1–F4 remain inline or become a separate PostCompositionRefiner
```

Sub-stages F1–F4 (upgrade injection, validation, route state, continuation) are 120 LOC of sequential post-processing that read `decision`, `activeRoute`, and several flags. They are good candidates for a `PostCompositionRefiner` service but are lower risk than the LLM-heavy branches. The upgrade injection and continuation blocks are each under 15 LOC; validation is the only sizeable one (~57 LOC). Extracting them is optional and can be a separate micro-slice.

## Feasibility assessment

**Feasible with prerequisites.** The main prerequisites are:

1. **`Stage3Result` typed record.** The extraction cannot happen without it. Introducing it is one PR, zero behaviour change.

2. **JIRA-170 snapshot reassignment must return to caller.** This is the highest-friction point. If `NewRoutePlanner` is extracted naively without returning `snapshot` and `context`, the caller's snapshot becomes stale. With the result record, it becomes a named field and the problem is solved structurally.

3. **Slices 1–3 should be settled first.** `NewRoutePlanner` calls `TurnExecutorPlanner`, `ContextBuilder`, and all three advisors. If `TurnExecutorPlanner` is still a 2000-LOC god file during extraction, the call-site dependencies are messier than they need to be. Slices 1–3 clearing first means `NewRoutePlanner` can call the already-cleaned versions.

The extraction is not a simple code-motion. The `pendingUpgradeAction` written in D4 and consumed in F1 crosses the sub-stage boundary; with `Stage3Result` it becomes a returned field and the consumer reads it explicitly. The `deadLoadDropActions` array (JIRA-89) is similarly written in D5 and prefixed to the plan in F4; the result record carries it across. These are papercuts, not blockers.

What would make it genuinely difficult: if sub-stage F (validation, continuation) is extracted at the same time. Sub-stage F reads `decision` after it has been potentially re-assembled by F1 (upgrade injection), and Stage 3c uses `activeRoute` after it may have been updated by F3. Extracting F atomically with the decision branches would require a two-phase call or a shared result record mutated in-place. The recommendation is to leave F inline for the first extraction and only tackle it once the decision branches are stable services.

## Sequencing

**Sub-slice A — Define `Stage3Result` and gate sub-stage F1 (upgrade injection).** Low-risk. One new type, one minor refactor of the upgrade injection block to read from a record rather than a bare local. Establishes the result record as the migration vehicle. Acceptance bar: `npm run build` clean, existing tests pass, zero behaviour change on pinned-seed game log.

**Sub-slice B — Extract `ActiveRouteContinuer`.** The smallest and lowest-risk branch (41 LOC, no LLM calls, no snapshot mutations). Confirms the pattern works before touching the LLM paths. Acceptance bar: same.

**Sub-slice C — Extract `InitialBuildRunner`.** Second-simplest branch. No LLM calls. One TurnExecutorPlanner call. Acceptance bar: pinned-seed initial-build turns produce identical plans.

**Sub-slice D — Extract `NewRoutePlanner`.** The large branch. Requires the JIRA-170 snapshot/context return in `Stage3Result`. Requires Slices 1–3 settled (or at least Slice 1, so ContextBuilder.build signature is stable). This is the highest-effort sub-slice. Acceptance bar: full pinned-seed game-log diff review for Haiku and Sonnet; no new bot mistakes; JIRA-170 auto-delivery turns produce identical deliveries.

**Sub-slice E (optional) — Extract sub-stage F into `PostCompositionRefiner`.** Only if there is an ongoing pattern of fixes landing in validation/continuation. Not a blocker for sub-slices A–D.

## Non-goals

- Changing the four-branch decision structure. The branching logic is correct; what changes is where each branch lives.
- Changing the 6-stage pipeline shape in `AIStrategyEngine.takeTurn`. Stage 3 extraction keeps the pipeline intact.
- Fixing the upgrade-consistency bug (upgrade decision at route creation only). That is JIRA-195 TD-3 — a separate post-refactor ticket.
- Extracting `GuardrailEnforcer` (Stage 4) or `BotMemory.update` (Stage 6). Out of scope.
- Combining `NewRoutePlanner` with `TripPlanner`. `TripPlanner` owns the LLM call; `NewRoutePlanner` owns the Stage 3 orchestration around it. They are different abstractions.

## Expected outcome

`AIStrategyEngine.takeTurn` Stage 3 shrinks from ~600 LOC to ~80 LOC (the decision gate + sub-stage F). Each of the four decision branches lives in a focused, testable service. The JIRA-170 snapshot mutation becomes explicit in the type system. New strategic fixes in the no-active-route path have an obvious home in `NewRoutePlanner` rather than landing as conditionals inside a 600-LOC if chain. The upgrade injection block (JIRA-105/161) and the validation block (Stage 3b) each have a named owner. Stage 3 debt stops accruing by default.
