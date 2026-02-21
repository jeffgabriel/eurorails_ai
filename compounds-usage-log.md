# Compounds Skill Usage Log

Tracks when the compounds skill was used and what benefit it provided.

| Date | Task/Context | Benefit |
| 2026-02-20 | Document AI LLM decision-making pipeline narrative | Compounds identified all 7 pipeline components (BotTurnTrigger, AIStrategyEngine, ContextBuilder, LLMStrategyBrain, ResponseParser, ActionResolver, GuardrailEnforcer, TurnExecutor) with call relationships, entry points, and retry logic. Faster than tracing imports manually. |
| 2026-02-20 | Plan plan-then-execute architecture change | Compounds semantic search found existing DeliveryPlan type, BotMemoryState.activePlan (unused), and confirmed no PlanExecutor exists yet. Structural query on DeliveryPlan showed only test usage. Saved time vs. manual grep across 15+ files. |
| 2026-02-20 | Bot behavior fixes: extractSegments ferry bug, buildTargetCity debug overlay, LLM prompt enrichment, cash reserve guardrail | 6 compounds searches: (1) `search "extractSegments ferry crossing handling"` mapped extractSegments → getFerryEdges → ferryConnections pipeline, (2) `search "buildTargetCity populated in bot turn result"` traced BotTurnResult → identifyTargetCity → AIStrategyEngine flow and confirmed field is never set, (3) `search "multi-action turn MOVE PICKUP DELIVER chaining"` revealed TurnExecutor.executeMultiAction pipeline, (4) `search "LLM strategy brain prompt system message"` mapped LLMStrategyBrain → getSystemPrompt → COMMON_SYSTEM_SUFFIX, (5) `search "getBuildBudget money reserve calculation"` identified budget doesn't subtract 5M reserve, (6) `search "GuardrailEnforcer checkPlan cash reserve"` confirmed no BUILD spending guardrail exists. |
| 2026-02-19 | ai-v6.3 full project execution: create project, upload PRD, generate tech spec, plan_project breakdown, implement all 35 tasks via 2-worker team | Compounds orchestrated the entire workflow: spec_project (research + pattern detection + spec generation + validation), plan_project (auto-generated 35 tasks from tech spec), implement_task (delivered task prompts with full context for each). Team of 2 workers completed all 35 tasks: 24 BE, 8 TEST, 1 FE, 2 INF. New pipeline: ContextBuilder + LLM + ActionResolver replaces OptionGenerator + Scorer. 258+ tests passing. |
| 2026-02-19 | prd-v6.3 gap analysis: verified TrackNetworkService, TrackBuildingService, LoadService, PlayerService, trackUsageFees, DemandDeckService, InitialBuildService APIs against spec | Found 7 gaps (see below). Compounds identified exact method signatures, parameter types, and missing methods — would have taken 10+ file reads with grep. |
|------|-------------|---------|
| 2026-02-18 | Extend plan system to initialBuild phase | 5 compounds queries validated the fix: (1) `search "plan system initialBuild game phase selectNewPlan PlanExecutor"` confirmed plan creation is gated to active-only, (2) `query "AIStrategyEngine" -r calls` traced call graph, (3) `search "executeLoadActions Phase 0 initialBuild gameStatus guard"` confirmed Phase 0 is already gated separately, (4) `search "PlanExecutor detectPhaseTransition build_to_pickup no position"` confirmed position checks only in travel/deliver phases (safe for no-position initialBuild), (5) `search "InitialBuildService advanceTurn bot turn trigger"` confirmed BotTurnTrigger→AIStrategyEngine→InitialBuildService flow is identical for both phases. Validated that extending two gameStatus guards is safe with no side effects. |
| 2026-02-18 | Ferry port targeting + crossing heuristic removal | 5 compounds queries: (1) `search "ferry port cost handling in Dijkstra pathfinding"` mapped computeBuildSegments → ferryPortCosts → getTerrainCost pipeline, (2) `search "ferry crossing decision logic"` traced handleFerryCrossing → Euclidean distance heuristic → all demand cities, (3) `query "computeBuildSegments" -r calls` found 2 callers (OptionGenerator + test), (4) `search "major city groups and ferry port mileposts"` revealed MajorCityGroup/FerryEdge relationship, (5) `query "getFerryEdges" -r calls` mapped 13 callers across build/move/validate paths. Compounds confirmed low blast radius for both fixes and identified the exact data flow causing ferry port inclusion in build targets. |
| 2026-02-18 | Post-v6.1 gameplay bug triage — 3 critical bugs | 3 compounds searches mapped: (1) pickup threshold gate in AIStrategyEngine (score < 15 blocks demand-matching pickups when delivery city unreachable), (2) build option index resolution path (LLMStrategyBrain.selectOptions → feasibleBuilds[index] uses original order not serializer's sorted order), (3) chainScore floor 0.01 in rankDemandChains (negative-profit chains all equal). Fixed all 3: removed alphabetical sort (index mismatch), lowered pickup threshold to 1 (was 15), replaced 0.01 floor with payment/turns*0.1 for meaningful differentiation. |
| 2026-02-18 | ai-v6.1 full implementation — 13 tasks via Compounds workflow | Used `create_project`, `upload` PRD, `plan_project` (13 tasks generated), then `get_project_tasks`/`update_task` to track all 13 tasks (BE-001 through BE-012 + DOC-001) through implementation. Wave 1 (4 tasks) done by 2 parallel agents, Waves 2-3 (9 tasks) done sequentially. All 13/13 marked DONE via compounds. Changes: LLM enabled during initialBuild, geography section, chain analysis section, shared track computation, budget feasibility, reuse annotations, top-5 chains, neutral ordering, Scorer documented as fallback-only. |
| 2026-02-18 | Hub selection favors peripheral cities (Madrid/Bilbao) over central Europe | 3 compounds searches mapped the full initial placement pipeline: evaluateHubScore → rankDemandChains → determineStartPositions → autoPlaceBot → generateBuildTrackOptions → calculateBuildTrackScore. Compounds revealed evaluateHubScore returns only the BEST single chain score, causing peripheral hubs with one good chain to beat central hubs with many viable chains. Fixed by summing top-3 chain scores, naturally rewarding central European hubs (Ruhr, Berlin, Paris) that enable multiple delivery chains. |
| 2026-02-18 | PRD v6.1 — investigate heuristic vs LLM decision boundaries | 6 compounds searches mapped: (1) LLM prompt construction pipeline (GameStateSerializer → ProviderAdapter → ResponseParser → GuardrailEnforcer), (2) response parsing and index validation flow, (3) heuristic override/guardrail/fallback chain. Read all 4 key files (GameStateSerializer, LLMStrategyBrain, ResponseParser, systemPrompts) to catalog exactly what context the LLM receives vs what's decided by heuristics. Key finding: LLM is completely skipped during initialBuild (gated behind `gameStatus === 'active'`), and prompt lacks geographic context, chain analysis, and reuse indicators. Informed 9-task PRD for enriching LLM context. |
| 2026-02-17 | ai-v6 project creation — PRD upload, tech spec generation, pattern detection, task breakdown | Full Compounds workflow: `create_project`, `upload` PRD, `spec_project`, `tech_spec_research`, `pattern_detection` (9 patterns selected from manifest), `get_design_patterns` (loaded full content), `generate_tech_spec`, `validate_spec`, `upload` tech spec, `plan_project` (generated 9 tasks with enriched prompts). Two research subagents ran 16 compounds search/query commands to map existing pipeline architecture, discover patterns, and confirm gaps. Breakdown agent automatically decomposed tech spec into ordered implementation tasks. |
| 2026-02-17 | ai-v6 full implementation — 13 tasks via Compounds workflow | Used `implement_task` to retrieve next task + prompts, `implement_task_finalize(validate)` → `implement_task_finalize(mark_done)` for all 13 tasks: INF-001, BE-001 through BE-011, TEST-001. `get_project` verified 100% completion. Team of 3 agents executed Wave 2 tasks in parallel. All test files verified passing (45 new tests + 85 existing). |
| 2026-02-16 | pickupTargets too broad — bot builds toward wrong city (Kaliningrad instead of Birmingham) | Compounds search "OptionGenerator BuildTrack option generation computeBuildSegments targets" mapped the full option generation flow: generateBuildTrackOptions → rankDemandChains → computeBuildSegments. Also "autoPlaceBot placement logic nearest major city" revealed the placement algorithm. Identified that pickupTargets included ALL cities with a load type, causing pathfinding to pick the easiest target (near Kaliningrad) instead of the strategically correct one (Birmingham near delivery Antwerpen). |
| 2026-02-16 | Terrain-aware cost estimation — rankDemandChains AVG_COST_PER_SEGMENT=1.5 underestimates Alpine/ferry routes | Compounds search "terrain cost per milepost building cost calculation" mapped the full cost calculation architecture: TrackBuildingService.calculateNewSegmentCost (authoritative), MapTopology.getTerrainCost (1/2/5/3/5 costs), computeBuildSegments.getWaterCrossingCost (+2/3M rivers/lakes), and ferryPortCosts (4-16M). Confirmed rankDemandChains uses flat 1.5M average that misses all terrain variation. |
| 2026-02-14 | Track usage fee bug — BFS picks shortest path through opponent track instead of own track | Identified all key files (trackUsageFees.ts, MovementExecutor.ts, UIManager.ts, PlayerStateService.ts) and the full data flow (computeTrackUsageForMove → bfsPath → confirmOpponentTrackFee popup) in a single query, enabling quick root cause identification |
| 2026-02-14 | Bot builds track randomly, never reaches demand cities | Compounds identified OptionGenerator, computeBuildSegments, identifyTargetCity, and determineStartPositions as the key components. Revealed that computeBuildSegments had no target parameter and generateBuildTrackOptions never passed demand info. Confirmed BuildTowardMajorCity action type existed but was never generated. |
| 2026-02-14 | Investigate server-side reversal enforcement | Compounds traced the full movement flow: moveTrainForUser → position update → movement_history. Found the client-side reversal logic (isReversalByDirectionFallback, isTerrainCityOrFerry) in TrainMovementManager.ts and confirmed no equivalent exists server-side. Also identified that movement_history already stores per-move segments server-side, providing the data needed for direction detection. |
| 2026-02-14 | Bot carries 3 loads on Freight train (capacity 2) | Two compounds queries mapped the full load pickup/delivery architecture: identified TurnExecutor.handlePickupLoad has no capacity check, and AIStrategyEngine pickup loop generates options once then iterates without re-checking capacity. Also confirmed deliverLoadForUser correctly removes loads. Pinpointed both root causes without manual file searching. |
| 2026-02-15 | Strategy Inspector tech spec research — 13 compounds queries | Mapped entire AI bot pipeline (WorldSnapshotService, OptionGenerator, Scorer, PlanValidator, TurnExecutor, AIStrategyEngine, BotTurnTrigger), existing debug infrastructure (DebugOverlay with backtick toggle), socket event patterns (bot:turn-start, bot:turn-complete, turn:change), UI modal patterns (Phaser rexUI modals, React Radix dialogs), audit DB table schema (bot_turn_audits), and confirmed StrategyInspectorModal does NOT exist in source. All 13 queries returned relevant components with source code. |
| 2026-02-14 | Fix bot oscillation (München↔Milan) — Scorer needs pickup awareness | Compounds identified the full data flow: WorldSnapshotService populates loadAvailability from demand destination cities, OptionGenerator generates pickup targets (gated by hasCapacity), and Scorer's calculateMoveScore only considers delivery payoff, not pickup opportunity. Confirmed field names across DemandDeckService (demand.resource) vs ResolvedDemand (demand.loadType) for cross-referencing loadAvailability. |
| 2026-02-15 | Strategy Inspector gap analysis — 7 compounds queries | Mapped all 14 derived implementation needs across server and client. Compounds confirmed: no StrategyAudit type exists, no ScoreBreakdown type, no snapshotSummary generator, infeasible options have reason strings but no structured rejection tracking, ExecutionResult exists but lacks per-step logging, bot_turn_audits stores flat action rows (not rich audit JSON), bot:turn-complete emits basic BotTurnResult (no scoring data). Client-side: StrategyInspectorModal was built in prior branch (compounds/204) but deleted; DebugOverlay with backtick toggle exists as integration point. |
| 2026-02-15 | DropLoad implementation — 3 compounds queries | Investigated AI bot pickup/delivery pipeline, LoadService drop/return methods, and AIStrategyEngine executeLoadActions orchestration. Compounds confirmed setLoadInCity/returnLoad/isLoadAvailableAtCity patterns in server LoadService, identified the full Phase 0/1.5 load action flow, and mapped OptionGenerator demand-matching logic for reachability checks. |
| 2026-02-15 | Debug bot stuck at money=0 — 2 compounds queries | Investigated WorldSnapshotService loadAvailability population. Compounds immediately showed `getAvailableLoadsForCity` is called for `citiesOfInterest` (demand destinations + source cities), confirming load data was correct and the hard reachability gate in OptionGenerator was the root cause. |
| 2026-02-16 | LLM-as-Strategy-Brain PRD analysis — 6 compounds queries | Validated pipeline architecture claims: confirmed Scorer is called 5 times per turn (Phase 0 deliveries, Phase 0 drops, Phase 0 pickups, Phase 1 movement, Phase 2 building), WorldSnapshot lacks opponent money/position/loads/trainType (PRD assumes this exists for Medium/Hard), FeasibleOption uses `action` field not `type` field (PRD uses wrong field name in guardrails). Traced full data flow and integration points. |
| 2026-02-16 | PRD gap analysis — 18 compounds search queries | Systematic search across all 8 known issues: multi-delivery sequencing, scoring constants, drop load logic, state continuity, build oscillation, upgrade timing, discard hand scoring, victory tracking. Also searched for test infrastructure, bot-vs-bot loop, BotConfig, and load service. Compounds mapped the full component graph for each issue area, identifying what exists (AIStrategyEngine phases, Scorer constants, OptionGenerator chains, VictoryService BFS) and what's missing (no bot-side victory check, no state persistence between turns, no automated test harness, hard-coded discard score). |

| 2026-02-18 | ai-v6.2 full implementation — 16 tasks via Compounds workflow | Used `create_project`, `upload` PRD, `spec_project` (wrote technical-spec-v6.2.md), `upload` tech spec, `plan_project` (16 tasks auto-generated), then `get_project`/`update_task` to track all 16 tasks through implementation. Team of 3 agents for Wave 1 (data model). Implemented Plan-Then-Execute architecture: DeliveryPlan interface, PlanExecutor service with 6-phase state machine, LLM plan selection via serializePlanSelectionPrompt, plan resolution in AIStrategyEngine, parameterized loyalty factor in OptionGenerator, ResponseParser.parsePlanSelection. Created 21 PlanExecutor unit tests (all pass). Fixed BotMemoryState in 4 test helpers. All 16/16 tasks marked DONE. |

## 2026-02-14 — Strategy Inspector Tech Spec Research

### Commands Run (11 total)
1. `compounds summary` — project overview: languages, frameworks, entity counts
2. `compounds dependencies --scope external` — 77 external packages mapped
3. `compounds search "debug overlay bot turn" --show-code` — found DebugOverlay class, renderBotTurnSection, socket event handlers
4. `compounds search "StrategyAudit bot turn audit" --show-code` — found BotTurnResult interface, takeTurn orchestration, audit INSERT patterns
5. `compounds search "bot turn complete socket event" --show-code` — found emitTurnChange, bot:turn-start/complete events, BotTurnTrigger flow
6. `compounds search "OptionGenerator feasible infeasible options" --show-code` — found generate(), makeFeasible/makeInfeasible, all option generation methods
7. `compounds search "Scorer scoring dimensions weights" --show-code` — found score(), calculateBuildTrackScore, calculateMoveScore, scoring constants
8. `compounds search "TurnExecutor execution results" --show-code` — found ExecutionResult interface, execute() dispatch, audit INSERT pattern
9. `compounds search "AIStrategyEngine strategy pipeline" --show-code` — found takeTurn 4-phase pipeline, retry logic, PassTurn fallback
10. `compounds search "modal overlay React Phaser UI component" --show-code` — found Phaser modal pattern (rexUI sizers), Radix AlertDialog, DOM overlay
11. `compounds search "WorldSnapshotService snapshot summary" --show-code` — found capture(), WorldSnapshot interface, parseSegments()

### Benefit
Comprehensive cross-module architectural mapping for tech spec. Compounds provided dependency graphs, code flow analysis, and semantic search across 3700+ entities that would have required dozens of manual grep/file-read operations. The AI-generated summaries for each query correctly identified component relationships and data flow patterns.

## 2026-02-16 — Bug Diagnosis: DropLoad Oscillation Loop

### Context
User reported bot picking up Wine at Bordeaux, carrying to Paris, dropping without payment, looping. Invoked compounds skill to search for Phase 0/Phase 1.5 auto-execute logic in AIStrategyEngine. Context compacted mid-search; continued with direct file reads.

### Benefit
Compounds skill was invoked for initial architecture search of the auto-execute load action pipeline. Direct file reads were then used for detailed tracing of the 3-way bug interaction (OptionGenerator + Scorer + AIStrategyEngine).

## 2026-02-16 — Bug Diagnosis: Bot Over-building & Luxembourg Targeting

### Context
User reported bot building to Luxembourg (no reason), orphan Channel tracks trying to reach Aberdeen, and running out of money. Invoked compounds skill with 4 search queries.

### Commands Run
1. `compounds search "OptionGenerator BuildTrack target positions for computeBuildSegments"` — Found generateBuildTrackOptions, extractBuildTargets, extractTrackEndpoints, TrackBuildOptions
2. `compounds search "how BuildTrack options determine which city to build toward"` — Found trackedCityKey, generateBuildTrackOptions full flow
3. `compounds search "identifyTargetCity function"` — Found identifyTargetCity labels by last segment endpoint, not chain target
4. `compounds search "Scorer scoreBuildTrack scoring"` — Found calculateBuildTrackScore formula: BASE(10) + segments*1 - cost + CITY_REACH(5) + chainScore*20
5. `compounds search "AIStrategyEngine Phase 2 build selection"` — Confirmed try-in-score-order with validation
6. `compounds search "rankDemandChains pickupTargets deliveryTargets"` — Found pickupTargets includes ALL cities with matching load (not just primary source)

### Benefit
Compounds mapped the full build targeting pipeline across 4 files (OptionGenerator, computeBuildSegments, Scorer, AIStrategyEngine) and revealed 3 root causes: (1) extractSegments contiguity bug causing high-scored options to fail validation, (2) identifyTargetCity mislabeling when budget insufficient to reach actual target, (3) no minimum build threshold allowing $1M wasteful stubs.

## 2026-02-16 — Bug Diagnosis: Bot Commits to Unaffordable Oslo Route

### Context
Bot picked up Tourists at London and committed all resources to building toward Oslo (30M delivery). This was unaffordable with 37M cash. Used 3 compounds queries to investigate the hasLoad budget penalty gap and Phase 0 pickup eagerness.

### Commands Run
1. `compounds search "rankDemandChains hasLoad budget penalty chainScore carried load"` — Confirmed rankDemandChains architecture, identified hasLoad scoring path
2. `compounds search "Phase 0 pickup load decision before movement executeLoadActions"` — Mapped executeLoadActions→generatePickupOptions→Scorer pipeline for pre-movement pickups
3. `compounds search "generatePickupOptions reachability gate aspirational pickup"` — Found pickup scoring with reachability soft-gate (0.15x penalty) but no affordability check

### Benefit
Compounds confirmed two root causes: (1) hasLoad branch in rankDemandChains has NO budget penalty (comment says "must deliver them"), causing Tourists→Oslo to score 5.0 and dominate all chains; (2) Phase 0 picks up loads matching any demand card without checking if delivery is affordable.

## 2026-02-19 — AI Pipeline Architecture Discovery (16 queries)

**Task:** Comprehensive architectural discovery of the AI bot pipeline for tech spec to replace OptionGenerator + Scorer with ContextBuilder + LLM + ActionResolver pipeline.

**Queries run:**
1. `compounds summary` — project overview (4306 entities, 99% TypeScript)
2. `compounds search "AIStrategyEngine takeTurn pipeline orchestration"` — discovered full pipeline: Phase 0 → Plan Resolution → Phase 1 (Movement) → Phase 2 (Build), with plan-then-execute architecture
3. `compounds search "WorldSnapshot capture game state"` — discovered capture() function, WorldSnapshot interface, DB query joining games/players/player_tracks
4. `compounds search "TurnExecutor execute action dispatch"` — discovered action switch dispatch (BuildTrack, MoveTrain, PickupLoad, DeliverLoad, DropLoad, UpgradeTrain, DiscardHand, PassTurn)
5. `compounds search "GuardrailEnforcer check safety rules"` — discovered it's a no-op; returns unchanged selections; PlanValidator handles actual rule enforcement
6. `compounds search "LLMStrategyBrain decide select action LLM"` — discovered full LLM pipeline: serialize → chat → parse → guardrail, with retry chain (full → minimal → heuristic)
7. `compounds search "BotTurnTrigger turn scheduling lifecycle"` — discovered turn trigger with pendingBotTurns guard, human connectivity check, housekeeping queries
8. `compounds search "computeBuildSegments Dijkstra pathfinding segments"` — discovered multi-source Dijkstra with budget constraints, target-aware path selection
9. `compounds search "TrackNetworkService findPath buildTrackNetwork isConnected"` — discovered A* pathfinding, string-keyed graph, ferry edge support
10. `compounds search "trackUsageFees computeTrackUsageForMove"` — discovered union track graph, preferOwnTrackPath, edge ownership tracking
11. `compounds search "LoadService isLoadAvailableAtCity getAvailableLoads"` — discovered singleton LoadService with loadConfiguration map, getSourceCitiesForLoad
12. `compounds search "TrackBuildingService addPlayerTrack isValidConnection"` — discovered Result<T,E> pattern, city connection limits, ferry port handling
13. `compounds search "PlayerService moveTrainForUser deliverLoadForUser"` — discovered server-authoritative PlayerService with transactional DB ops
14. `compounds search "DemandDeckService drawCard discardCard demand"` — discovered dual client/server implementations, draw/discard pile management
15. `compounds search "GameStateSerializer serialize prompt context"` — discovered structured prompt generation with skill-level scaling, chain analysis
16. `compounds search "ResponseParser parse LLM response intent"` — discovered JSON + regex fallback parsing, index validation, ParseError handling
17. `compounds search "OptionGenerator generate FeasibleOption BuildTrack MoveTrain"` — discovered generate() orchestrating multiple option types
18. `compounds search "PlanExecutor executePlan plan phase movement build"` — discovered stateless plan executor with phase flow
19. `compounds search "Scorer score heuristic rank options"` — discovered score-and-sort with per-action-type heuristics

**Benefit:** Compounds provided complete architectural understanding across 23 source files in the AI pipeline, including cross-module dependencies, method signatures, type definitions, and execution flow. This would have required reading ~5000 lines of code manually. The semantic search surfaced exactly the right components for each query, including files I wouldn't have found with grep (e.g., connectedMajorCities.ts for buildTrackGraph, MapTopology.ts for grid functions).

## 2026-02-20 — Session continuation: Guardrail 4 feasibility tests

**Context:** Continued from previous session. Guardrail 4 code (block BUILD toward unaffordable targets) was already written. This continuation focused on writing tests and running the full test suite.

**Compounds usage in this continuation:** N/A — code changes were scoped to test file only, using existing knowledge from prior session's compounds queries.

**Result:** 7 new tests for Guardrail 4, all 27 GuardrailEnforcer tests pass, clean TypeScript build.

## 2026-02-21 — Initial build strategic blindness investigation

**Context:** User reported bot starting at Ruhr instead of Holland→Berlin corridor despite having Cheese+Flowers demands to Berlin. Compounds used to trace initial build context pipeline.

**Commands run:**
1. `compounds search "initial build phase cold start city selection strategy"` — found buildOrderedCandidates in AIStrategyEngine, identifyTargetCity in OptionGenerator, CitySelectionManager client-side
2. `compounds search "system prompt initial build instructions strategy guidance"` — found CRITICAL RULE 10 ("prefer central Europe") and full system prompt structure
3. `compounds search "initial build cold start estimateTrackCost zero segments empty"` — confirmed estimateTrackCost returns 0 when no segments exist

**Benefit:** Compounds identified the root cause: during initialBuild with no track, estimateTrackCost returns 0 for ALL cities (the "can't estimate without frontier" early return). This means the LLM sees `~0M track needed` for every demand, giving no distance signal. Combined with the system prompt only saying "prefer central Europe" without showing which demands align, the LLM picks Ruhr for a 48M Tourist demand instead of the obvious Holland→Berlin corridor.
