# Bot-Fixes Branch — Summary for Jeff

**Branch:** `compounds/guardrail-updates`
**Diverged from main:** 2026-03-12 (commit `44d38ce` — JIRA-106 server-side victory check)
**Last bot-fixes commit:** 2026-05-19
**Main integration merged:** 2026-05-20 (commit `86ca166`)
**Scale:** 517 commits · ~683 files changed · +127K / -28K lines
**PR:** #244

---

## TL;DR

Two months of work on the bot, almost entirely concentrated under `src/server/services/ai/`. Decomposes cleanly into ~9 capability areas, most of it living in new self-contained modules with low coupling to anything you've touched on main.

The original plan was a phased selective re-apply onto main. **It was instead executed as a single integration merge** — main's last 89 commits pulled into `compounds/guardrail-updates`, conflicts resolved in place. All conflicts landed; the build is green; smoke test passes for non-event-card play.

Three things are still open after the merge:
1. **Phase 4 (event-card awareness)** is explicitly deferred. The bot doesn't yet consult `ActiveEffectManager`, gets silently rejected by `ActionRestrictionEnforcement`, and has no `activeEffects` in its `WorldSnapshot`. First concrete symptom filed as **JIRA-251** (Rail Strike).
2. **Three pre-existing planner bugs** surfaced during smoke test — **JIRA-248/249/250** — all in the same family: deterministic candidate generator mishandles `carriedLoads + matching demand cards`.
3. **Six places where our work and your work overlap** (Kaliningrad cap hack vs. your geometric fix, PlayerService method consolidation, etc.) are catalogued in **[`docs/main-merge-overlap-checklist.md`](main-merge-overlap-checklist.md)** with per-row verdicts and open questions for you.

Capability summary first so you can decide what's worth bringing back. Merge facts and resolution details after.

---

## What's in it (themed)

### 1. Context engineering — decomposed (JIRA-195 series)

The old `ContextBuilder.ts` was a 4K+ line god object. Split into focused sub-modules under `services/ai/context/`:

- `DemandEngine.ts` (947 LOC) — demand scoring, supply→demand context, corridor value, network proximity. Key entities: `computeBestDemandContext`, `scoreDemand`, `computeCorridorValue`, `isCityOnNetwork`, `estimateTrackCost`.
- `NetworkContext.ts` (335 LOC) — reachable cities, connected/unconnected majors, phase. Wrapper over `MapTopology` + `TrackNetworkService`.
- `BuildContext.ts` (101), `DemandContext.ts` (160), `UpgradeContext.ts` (92), `UpgradeGatingConstants.ts` (32).

`ContextBuilder` still exists, but is now a façade over these. The merge **kept the refactor entirely** — any small additions you made to monolithic `ContextBuilder.ts` for event-card context serialization will need to be re-applied to the split sub-modules during Phase 4.

### 2. Deterministic Trip Planner

`DeterministicTripPlanner.ts` — production port of `scripts/ai/spatial-prune-analysis.ts`. Algorithm:

1. Enumerate all single / pair / triple demand-fulfillment candidates.
2. Cheap-prune by optimistic turn / build-cost estimates.
3. Simulate survivors via `simulateTrip` in `RouteDetourEstimator`.
4. Score by aggregate two-trip income velocity (`computeAggregateScore`).
5. Return top-1 as the `StrategicRoute`.

Replaces the prior reactive "best-demand-right-now" heuristic. Recent extensions: `applyEndStateScoring` (JIRA-241 Task 2) — once cash latches into End phase, scoring penalises routes that don't help close the remaining major-city gap.

**Known weaknesses surfaced by smoke testing** (filed as JIRA-248/249/250 — see below) — the candidate generator does not robustly handle the carried-load + matching-demand case. These are pre-existing and unrelated to the merge.

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

Single source of truth for: `isStopComplete`, `resolveBuildTarget`, `getNetworkFrontier`. Replaces duplicate logic previously scattered across PlanExecutor / TurnComposer / AIStrategyEngine (both deleted on our side — `PlanExecutor.ts` and `TurnComposer.ts` no longer exist; the merge handled the modify/delete conflicts cleanly). Contains the `VICTORY_BUILD_TRIGGER_M = 230` threshold — bot starts pacing toward the 7-city goal at 230M cash, accumulating the final 20M during the city-build sprint (recovered ~8 wasted turns in game `38e92b14`).

### 9. Prompts, schemas, diagnostics

- `prompts/ContextSerializer.ts` (818 LOC) + `prompts/systemPrompts.ts` (791 LOC) — heavily engineered prompt construction. Per-section truncation, structured output instructions.
- `schemas.ts` (+442) — Zod schemas for LLM-extracted actions.
- `services/logParser.ts` (+183) — NDJSON game-log parser for offline analysis.
- `CompositionTrace` instrumentation — turn-by-turn decision provenance, route-execution timing.

---

## JIRA scope

~300 tickets, mostly shipped under `docs/ai/done/`. Four new tickets sit in `docs/ai/jira/` after the merge smoke test:

- **JIRA-248** — Replan drops carried-load delivery silently (Labor for Bern at T28→T29, game `75c6afc8`).
- **JIRA-249** — Trip planner emits `deliver(X)` without preceding `pickup(X)` when a new demand is drawn (Wine→Praha at T15, same game). Bot drives to Praha, arrives empty-handed, PassTurn, backtracks to Frankfurt.
- **JIRA-250** — Two demands of the same loadType at the same supply city; planner picks up only one (Fish at Oslo for both Milano and Zurich; Zurich is on the way). Corridor pickup missed.
- **JIRA-251** — Bot blind to active Rail Strike (first Phase 4 vertical-slice ticket).

The first three are all pre-existing weaknesses in the deterministic candidate generator's handling of `carriedLoads + matching demand cards`. The technical files cross-reference the family relationship. JIRA-251 is the first concrete Phase 4 symptom; its technical file lays out the fix-shape pattern (snapshot enrichment → planner consultation → guardrail backstop → server-rejection visibility) that the rest of Phase 4 should reuse.

Themed clusters across JIRA-1 to JIRA-251:

- **1–20:** starting-city, initial-build, demand-scoring foundations.
- **22–100:** post-delivery, ferry handling, route-stop ordering, train upgrades, double-delivery bugs.
- **100–130:** build-without-route, cost-estimation accuracy, post-delivery loops, network-aware building.
- **130–200:** holistic turn validation, network frontier, supply-aware enumeration, ContextBuilder decomposition (JIRA-195).
- **200–247:** spider-web vs corridor builds, deterministic trip planner introduction, end-state scoring + persistent phase, victory clinch + final-victory route, cash-floor removal, BuildAdvisor re-enablement experiments.
- **248–251:** post-merge smoke-test findings (planner family bugs + first Phase 4 symptom).

Most tickets follow a two-file pattern: `jira-N-*-behavioral.md` (problem-only) + `jira-N-*-technical.md` (fix plan). Cherry-pick anything you want to read in depth.

---

## How the merge actually landed

The selective-re-apply plan was replaced with a single integration merge (`86ca166`). 25 conflicts surfaced; resolution summary:

| Conflict class | Count | Resolution |
|---|---|---|
| Modify/delete (we deleted; main improved) | 4 | `git rm` — `PlanExecutor.ts`, `TurnComposer.ts`, and their tests. Our migration into `TurnExecutorPlanner` is complete; all references are comments. |
| Modify/delete (we modified; main deleted) | 1 | `BotTurnTrigger.test.ts` moved from top-level to `__tests__/ai/` (main's commit `b9bd535`). Took main's delete. |
| Config / lockfile | 3 | `.mcp.json` (your URL), `gridPoints.json` (took yours — Kaliningrad geometric move), `package-lock.json` regenerated. |
| Add/add | 1 | `.mcp.json` (URL choice). |
| Test files | 8 | Mostly took ours — our `jest.requireActual` spread pattern + bot-specific test scaffolding. |
| Source files | 8 | Per-file judgment (see overlap checklist for the big ones). |

Specific source-file resolutions worth your attention:

- **`MapTopology.ts`** — your relocation (`edda820`) and ours (`1ad22c7`) landed in the same place. Took your `getTerrainBuildCost` import from the terrain-cost consolidation.
- **`TurnExecutor.ts`** — took your `PlayerService.{pickupLoad,dropLoad,buildTrack,discardHand}ForPlayer` migration entirely. Removed our inline DB `FOR UPDATE` blocks; the JIRA-196 capacity-gate tests that exercised that path are `it.skip`'d as obsolete. Snapshot-mirror logic preserved.
- **`ActionResolver.ts`** — union of imports + `NetworkBuildAnalyzer` and `BuildRouteResolver` from our side, `getTrainSpeed`/`getTrainCapacity`/`isPositionAtCity` from your shared-services consolidations.
- **`AIStrategyEngine.ts`** — took our `NewRoutePlanner` extraction (JIRA-195b sub-slice D). The "old planning code" main still had at the same site references the deleted `PlanExecutor` and would not compile against our codebase.
- **`ContextBuilder.ts`** — took our refactored version entirely (534 lines vs. main's 2864). Any small additions you made to monolithic `ContextBuilder.ts` for event-card serialization were not preserved — they'll need to be re-applied to the split sub-modules in Phase 4.
- **`socketService.ts`** — union of both sides' imports (Whisper from us, event-card broadcasting from you).
- **`computeBuildSegments.ts`** — adopted your `getWaterCrossingExtraCost` shared util everywhere, dropped our local `getWaterCrossingCost` + `_waterCrossingCosts` map.
- **`jest.config.js`** — kept our `claude-agent-sdk` module mapper AND added your `uuid` v14 ESM passthrough.

One source-side bug surfaced during the merge that we fixed in place:

- **`ActionResolver.resolve()` — `case 'PASS':` restored.** The merge auto-resolved the action-dispatch switch in a way that lost the string case for `PASS` (only the `AIActionType.PassTurn` enum case remained). Tests caught it; one-line fix in commit `86ca166`.

And one DB-side bug that required a follow-up commit:

- **Migration number collision (commit `0250e5f`).** Both branches numbered their migration 036. The runner skipped both (version 36 was already in `schema_migrations`), leaving `games.active_event` missing. Renumbered yours to 038. Without this, the bot crashes mid-game on `column active_event does not exist`.

Full per-file rationale plus the open-questions-for-you list lives in [`docs/main-merge-overlap-checklist.md`](main-merge-overlap-checklist.md).

---

## Phase 4 — event-card awareness (deferred)

The merge kept all your event-card infrastructure intact (`EventCardService`, `ActiveEffectManager`, `AreaOfEffectService`, `ActionRestrictionEnforcement`, `TrackService.removeSegmentsCrossingRiver`, migration 038). The bot is wired into none of it.

Specifically, the bot is currently blind to:

- **Event card draws.** The deck has 20 event cards mixed in. The bot draws them but ignores their effects.
- **Active effects in its snapshot.** `WorldSnapshot.activeEffects` is `null`. The planner has no input signal.
- **`ActionRestrictionEnforcement` rejections.** When an action is rejected server-side, the bot's per-turn log records `success: false` with no rejection reason. The bot re-emits the same failing action next turn.
- **`TrackService.removeSegmentsCrossingRiver`** under Flood events. The bot's `existingSegments` would go stale.

**JIRA-251** is the first concrete repro (Rail Strike). Its technical file proposes the pattern:

```
snapshot enrichment → planner consultation → guardrail backstop → server-rejection visibility
```

The hard work is the snapshot wiring + the guardrail gate registry. Per-event-type logic is small. Scope is its own project after #244 merges.

---

## Test baseline

- **Pre-merge baseline:** 41 known-failing tests — `docs/test-baseline-pre-merge.failing-tests.txt`.
- **Post-merge baseline:** 59 known-failing tests — `docs/test-baseline-post-merge.failing-tests.txt`.
- **Delta breakdown:**
  - 24 new failures are your new tests that require a test DB with the new migrations applied (Event card lifecycle, Migration 038, PlayerService Integration). They go green automatically with test-DB setup.
  - 3 new failures reference the old Kaliningrad coords (`19,63`). Resolution depends on whether the `MaxConnections` mechanism stays (see overlap checklist row 1).
  - 3 new failures in `AIStrategyEngine.takeTurn` integration tests (JIRA-170, JIRA-97). Pass in isolation, fail in full-suite — test-isolation / mock-leak issues. Not gameplay regressions.
  - Offset by 12 pre-merge baseline tests now passing (cleanup from your refactor + targeted test fixes during the merge).

Verification command:
```
diff <(sort docs/test-baseline-post-merge.failing-tests.txt) <(npm test -- --forceExit 2>&1 | grep -E '^\s+●\s' | sed -E 's/^\s+● //' | sort -u)
```

---

## Smoke test status

Played a live game with a Medium-skill Sonnet bot against the merged branch. Bot:

- ✅ Picks up loads (via `PlayerService.pickupLoadForPlayer`).
- ✅ Delivers and gets paid.
- ✅ Builds track (`buildTrackForPlayer`).
- ✅ Discards hand when stuck.
- ✅ Server-side action restriction enforcement runs (cleanly when no events active).
- ⚠️ Three planner bugs observed and filed (JIRA-248/249/250).
- ❌ Rail Strike event → bot blind, MoveTrain fails silently across 6+ turns (JIRA-251).

Non-event play is stable. Event-card-active play is broken in the way Phase 4 is supposed to fix.

---

## What I'd like from you

1. **Verdicts on the overlap checklist.** [`docs/main-merge-overlap-checklist.md`](main-merge-overlap-checklist.md) — 7 rows with "Open question for Jeff" lines. The biggest ones:
   - Row 1 (Kaliningrad): keep the `MaxConnections` mechanism in code (latent / future-use), or rip it out?
   - Row 4 (JIRA-196 capacity check): confirm `PlayerService.pickupLoadForPlayer`'s gate has equivalent coverage; otherwise the obsolete `it.skip`'d tests need re-homing.
   - Row 6 (InitialBuildService race): verify your FOR UPDATE fix is still in the critical path after our `InitialBuildRunner` extract.
2. **Phase 4 appetite + scoping.** When you're ready to scope it, JIRA-251 is the worked example. The pattern reuses for all other event types.
3. **JIRA-248/249/250 priority.** These three are pre-existing bot-planner bugs (not merge-induced). Useful to know if you want them fixed inside this PR (small) or as a follow-on.

---

*Updated 2026-05-21 after the integration merge landed.*
