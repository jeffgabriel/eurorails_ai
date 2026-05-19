# Bot-Fixes Branch — Summary for Jeff

**Branch:** `compounds/guardrail-updates`
**Diverged from main:** 2026-03-12 (commit `44d38ce` — JIRA-106 server-side victory check)
**Last commit on our side:** 2026-05-19
**Scale:** 423 commits · ~610 files changed · +108K / -26K lines

---

## TL;DR

Two months of work on the bot, almost entirely concentrated under `src/server/services/ai/`. Decomposes cleanly into ~7 capability areas, most of it living in new self-contained modules with low coupling to anything you've touched on main. The hard merge surface is small — TurnExecutor + ActionResolver + AIStrategyEngine — where our bot loop overlaps with your PlayerService consolidation and action-restriction enforcement.

Recommendation at the end. Capability summary first so you can decide what's worth bringing back.

---

## What's in it (themed)

### 1. Context engineering — decomposed (JIRA-195 series)

The old `ContextBuilder.ts` was a 4K+ line god object. Split into focused sub-modules under `services/ai/context/`:

- `DemandEngine.ts` (947 LOC) — demand scoring, supply→demand context, corridor value, network proximity. Key entities: `computeBestDemandContext`, `scoreDemand`, `computeCorridorValue`, `isCityOnNetwork`, `estimateTrackCost`.
- `NetworkContext.ts` (335 LOC) — reachable cities, connected/unconnected majors, phase. Wrapper over `MapTopology` + `TrackNetworkService`.
- `BuildContext.ts` (101), `DemandContext.ts` (160), `UpgradeContext.ts` (92), `UpgradeGatingConstants.ts` (32).

`ContextBuilder` still exists, but is now a façade over these.

### 2. Deterministic Trip Planner

`DeterministicTripPlanner.ts` — production port of `scripts/ai/spatial-prune-analysis.ts`. Algorithm:

1. Enumerate all single / pair / triple demand-fulfillment candidates.
2. Cheap-prune by optimistic turn / build-cost estimates.
3. Simulate survivors via `simulateTrip` in `RouteDetourEstimator`.
4. Score by aggregate two-trip income velocity (`computeAggregateScore`).
5. Return top-1 as the `StrategicRoute`.

Replaces the prior reactive "best-demand-right-now" heuristic. Recent extension: `applyEndStateScoring` (JIRA-241 Task 2) — once cash latches into End phase, scoring penalises routes that don't help close the remaining major-city gap.

### 3. Build Advisor — currently flag-gated OFF

`BuildAdvisor.ts` (JIRA-129) — LLM-driven track-building strategy with a Dijkstra fallback. **Disabled by default** (`ENABLE_BUILD_ADVISOR=false`) after a 7-day A/B showed 41.6% LLM success rate and no measurable delivery uplift over the heuristic. Still there, fully instrumented (`BuildAdvisor.lastDiagnostics`), and re-enable-able if prompt quality improves.

### 4. Guardrails & route validation

`GuardrailEnforcer.ts` — hard rules applied to every TurnPlan before execution. Priority order:

- G1: Force `DELIVER` when `canDeliver` is non-empty (JIRA-47).
- Force `DiscardHand` when unaffordable-and-stuck or broke-and-stuck (JIRA-68, 177, 183, 199).
- G3: Block `UPGRADE` during `initialBuild` phase.
- G8: Movement-budget enforcement (silent truncation).

`RouteValidator.ts` — step-by-step route feasibility + stop-completion detection. Result types: `RouteValidationResult`, `StopValidation`.

**Policy note (JIRA-246):** The bot is allowed to spend to zero — there is no cash-floor / reserve gate at trip selection or route validation. JIRA-246 removed the last vestige of the cash-floor and added A3 carry-deliver abandon paths so the bot can drop a route mid-execution when carry-delivery becomes irrational rather than refusing to commit because of an affordability buffer.

### 5. Victory rules & end-game (`victoryRules.ts`)

Persistent `GameState` enum: `Initial` → `Early` → `Mid` → `End`. **End is latched** — once cash crosses `END_GAME_ENTRY_CASH` (200M), the bot stays in End for the rest of the game even if cash dips. JIRA-241.

`detectVictoryClinch()` — short-circuits trip planning when the bot is already carrying a load whose delivery completes both victory conditions. Came from JIRA-243 forensic analysis (game `c990fa47`) where the bot missed a 7th-city + delivery clinch at T74 and continued executing a 15-turn Wroclaw → Antwerpen detour.

`findFinalVictoryRoute()` (JIRA-245) — end-game speed-to-win route search. Uses the new `cheapestNUnconnectedMajorConnectorCost(context, N)` to price connecting *N* remaining major cities (the prior helper was single-city only). Wired into `AIStrategyEngine` as a strict-subset fast-path that fires before the clinch check during End phase.

Phase brackets themselves are now landed end-to-end (JIRA-242: early-game phase + multi-delivery expansion bonus).

### 6. Multi-provider LLM adapter layer (`services/ai/providers/`)

Pluggable backend behind a `ProviderAdapter` interface. Concrete adapters: Anthropic API, Google (Gemini), OpenAI, and the Claude Agent SDK (the SDK path is needed because `api.anthropic.com` rejects Pro/Max OAuth tokens — see `ClaudeAgentSdkAdapter.ts`). `jsonExtraction.ts` handles malformed-JSON recovery from streaming responses; `errors.ts` carries typed provider errors.

### 7. Pathfinding consolidation

`pathfinding/findBuildPath.ts` — pure Dijkstra utility (no logging, no `Date.now`, no side effects). Single source of truth for path cost, used by both `simulateTrip` (planner-side prediction) and `computeBuildSegments` (in-game build execution). Previously these two implementations drifted in subtle ways — JIRA-238 closed that. Embeds the parallel-build cost multiplier.

### 8. Route helpers (`routeHelpers.ts`)

Single source of truth for: `isStopComplete`, `resolveBuildTarget`, `getNetworkFrontier`. Replaces duplicate logic previously scattered across PlanExecutor / TurnComposer / AIStrategyEngine. Contains the `VICTORY_BUILD_TRIGGER_M = 230` threshold — bot starts pacing toward the 7-city goal at 230M cash, accumulating the final 20M during the city-build sprint (recovered ~8 wasted turns in game `38e92b14`).

### 9. Prompts, schemas, diagnostics

- `prompts/ContextSerializer.ts` (818 LOC) + `prompts/systemPrompts.ts` (791 LOC) — heavily engineered prompt construction. Per-section truncation, structured output instructions.
- `schemas.ts` (+442) — Zod schemas for LLM-extracted actions.
- `services/logParser.ts` (+183) — NDJSON game-log parser for offline analysis.
- `CompositionTrace` instrumentation — turn-by-turn decision provenance, route-execution timing.

---

## JIRA scope

~300 tickets, all shipped, filed under `docs/ai/done/` (canonical location — no in-progress dir at the moment). Most recent landings: JIRA-241 (persistent gameState), 242 (early-phase brackets), 243 (victory clinch), 244 (ferry-aware citiesOnNetwork), 245 (findFinalVictoryRoute), 246 (cash-floor removal), 247 (origin-is-current-position fix).

Themed clusters across the JIRA-1 to JIRA-247 range:

- **1–20:** starting-city, initial-build, demand-scoring foundations.
- **22–100:** post-delivery, ferry handling, route-stop ordering, train upgrades, double-delivery bugs.
- **100–130:** build-without-route, cost-estimation accuracy, post-delivery loops, network-aware building.
- **130–200:** holistic turn validation, network frontier, supply-aware enumeration, ContextBuilder decomposition (JIRA-195).
- **200–247:** spider-web vs corridor builds, deterministic trip planner introduction, end-state scoring + persistent phase, victory clinch + final-victory route, cash-floor removal, BuildAdvisor re-enablement experiments.

Most tickets follow a two-file pattern: `jira-N-*-behavioral.md` (problem-only) + `jira-N-*-technical.md` (fix plan). Cherry-pick anything you want to read in depth.

---

## How this lands on current main (Compounds-backed)

Ran `compounds impact` at depth-2 on hot-zone files and representative leaf entities. Numbers:

| Class | Files (rough) | Effort | Risk |
|---|---|---|---|
| **Lift new modules** (DemandEngine, DeterministicTripPlanner, BuildAdvisor, GuardrailEnforcer, NetworkContext, findBuildPath, victoryRules, routeHelpers, providers/\*, prompts/\*) | ~30–40 | Low — drop in, run tests | Low |
| **Fix MapTopology import paths** (you moved it to `services/`) | **89 sites** | Mechanical — sed-style | Trivial |
| **Re-apply read-only layer** (ContextBuilder façade, WorldSnapshotService, schemas) | ~5–10 | Import fixes + spot-merge — *does not touch your PlayerService internals* | Low–medium |
| **Re-apply integration layer** (TurnExecutor, ActionResolver, AIStrategyEngine, BotTurnTrigger) against your new PlayerService surface + action-restriction enforcement | ~5–10 | Real merge work | Medium–high |

Concrete signal from the impact queries:

- `scoreDemand`: **5** affected entities at depth 2 → DemandEngine is a leaf.
- `applyEndStateScoring`: **11** affected → DeterministicTripPlanner is a leaf.
- `GuardrailEnforcer`: **20** affected → leaf.
- `ContextBuilder` downstream: **111** affected, but **zero reach into the PlayerService methods you rewrote**. Reaches into MapTopology, majorCityGroups, shared utilities only.
- `TurnExecutor` downstream: **82** affected, and it *does* call `getPlayers`, `deliverLoadForUser`, `moveTrainForUser`, `drawCard` directly. **It does not call your new wrapper methods** (`pickupLoadForPlayer`, `buildTrackForPlayer`, `dropLoadForPlayer`, `discardHandForPlayer`, `purchaseTrainType`) from PRs #229 / #230 / #231. **This is the real reconciliation surface.**

---

## Known gaps where our bot is now ignorant of your main

1. **Event cards.** The bot was built under the assumption that the deck is demand-only. Your PRs #234–#238 unified demand + event cards into a single `GameDeck` draw pile and added `EventCardService`, `ActiveEffectManager`, `AreaOfEffectService`. Our `WorldSnapshot`, `GameContext`, prompts, and guardrails have **no event-card awareness**. Closing this is design work, not just plumbing.
2. **Action restriction enforcement** (PR #240). The bot's TurnExecutor builds plans assuming any well-formed action succeeds; your PlayerService now rejects actions that violate active-effect restrictions (Snow blocked terrain, Rail Strike scope, etc.). The bot has no read path for "what restrictions are active" yet.
3. **Initial-build race fix** (PR #232) lands cleanly — no overlap with us.
4. **Kaliningrad fix** (PR #243) lands cleanly — no overlap.

---

## Recommended path

**Selective re-apply via a Compounds Standard-tier `plan_change`, not a full merge.** Four phases:

- **Phase 1 — Mechanical:** MapTopology import rewrites + drop in the leaf modules. Low risk, fast.
- **Phase 2 — Read-only port:** ContextBuilder façade, WorldSnapshotService, schemas, prompts. Import fixes + spot-merge.
- **Phase 3 — Integration layer:** re-apply TurnExecutor / ActionResolver / AIStrategyEngine against your new PlayerService surface. Update direct-method calls to your new wrappers where appropriate. **This is where the real reconciliation cost lives.**
- **Phase 4 — Gap closing:** make the bot event-card-aware and action-restriction-aware. Bigger, design-first, probably worth scoping separately so it doesn't gate Phases 1–3.

Phases 1–3 are a tractable Standard-tier project. Phase 4 needs its own scoping pass.

---

## What I'd like from you

1. **Veto power on themes.** Anything in the capability list above you'd prefer we drop on the floor — especially BuildAdvisor (currently OFF after the A/B) or anything in the prompt-engineering layer?
2. **Event-card integration appetite.** Phase 4 as part of this merge, or as a separate follow-on? I'd lean separate to keep the merge bounded.
3. **Demo first?** Happy to record a local game showing bot behavior at the end of bot-fixes vs. behavior at the divergence point, if that helps you decide what's worth bringing back.

---

*Draft — let me know if the depth or framing is wrong and I'll re-cut.*
