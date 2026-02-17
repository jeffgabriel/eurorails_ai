# Compounds Skill Usage Log

Tracks when the compounds skill was used and what benefit it provided.

| Date | Task/Context | Benefit |
|------|-------------|---------|
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
