# Technical Specification: ai-v6.3 — LLM-as-Strategy-Brain v2

**Scenario Type**: `ai_feature`
**Sections to include**: B1-B3 (Architecture), B5 (Communication Layer), B7 (Backend), B8 (Security), B10 (Performance), B11 (Integration), B13 (Testing), B14 (Migration)
**Sections to skip**: Part A (no UI changes beyond data format), B4 (no DB schema changes), B6 (frontend changes are display-only), B9 (no infrastructure changes)

---

## Discovered from Codebase (Via Semantic Search)

### AI Pipeline Orchestration
- [x] **EXISTS**: `AIStrategyEngine.takeTurn(gameId, botPlayerId)` — Top-level orchestrator with Phase 0/1/2 pipeline, retry loop, PassTurn fallback
  * **Location**: `src/server/services/ai/AIStrategyEngine.ts`
  * **Usage**: MODIFY — rewire to new pipeline: WorldSnapshot → ContextBuilder → LLM → ActionResolver → GuardrailEnforcer → TurnExecutor

- [x] **EXISTS**: `WorldSnapshotService.capture(gameId, botPlayerId): Promise<WorldSnapshot>` — Single SQL join capturing immutable game state
  * **Location**: `src/server/services/ai/WorldSnapshotService.ts`
  * **Usage**: KEEP unchanged. Add `hexGrid`, `majorCityGroups`, `ferryEdges` to captured data.

- [x] **EXISTS**: `TurnExecutor.execute(plan: FeasibleOption, snapshot): Promise<ExecutionResult>` — Action dispatch with transactional DB writes
  * **Location**: `src/server/services/ai/TurnExecutor.ts`
  * **Usage**: MODIFY input type from `FeasibleOption` to `TurnPlan`. Handler internals unchanged.

- [x] **EXISTS**: `GuardrailEnforcer.check(...)` — Currently a NO-OP (returns selections unchanged)
  * **Location**: `src/server/services/ai/GuardrailEnforcer.ts`
  * **Usage**: MODIFY signature for `TurnPlan` input. Implement actual guardrails (force delivery when possible).

- [x] **EXISTS**: `BotTurnTrigger.onTurnChange(gameId, playerIndex, playerId)` — Turn scheduling, human-connectivity gating
  * **Location**: `src/server/services/ai/BotTurnTrigger.ts`
  * **Usage**: KEEP unchanged.

### LLM Integration
- [x] **EXISTS**: `LLMStrategyBrain.selectOptions(snapshot, moveOptions, buildOptions, memory): Promise<LLMSelectionResult>` — LLM integration with retry chain
  * **Location**: `src/server/services/ai/LLMStrategyBrain.ts`
  * **Usage**: REPLACE with `decideAction(snapshot, context): Promise<LLMDecisionResult>`. Keep provider adapter, retry chain structure.

- [x] **EXISTS**: `GameStateSerializer.serialize(snapshot, moveOptions, buildOptions, memory, skillLevel): string` — Converts snapshot + options to LLM prompt
  * **Location**: `src/server/services/ai/GameStateSerializer.ts`
  * **Usage**: REPLACE with ContextBuilder + new prompt serialization. Existing sections (geography, chain analysis) can inform new prompt template.

- [x] **EXISTS**: `ResponseParser.parse(responseText, moveCount, buildCount): ParsedSelection` — Parses index-based LLM selections
  * **Location**: `src/server/services/ai/ResponseParser.ts`
  * **Usage**: REPLACE with new parser for `LLMActionIntent` (action type + details JSON, not indices).

- [x] **EXISTS**: `prompts/systemPrompts.ts` — 6 archetype system prompts + skill level configs
  * **Location**: `src/server/services/ai/prompts/systemPrompts.ts`
  * **Usage**: MODIFY — keep archetype personalities, replace common suffix with new AVAILABLE ACTIONS + RESPONSE FORMAT.

### Pathfinding & Track Services
- [x] **EXISTS**: `computeBuildSegments(args)` — Multi-source Dijkstra for build segment generation
  * **Location**: `src/server/services/ai/computeBuildSegments.ts`
  * **Usage**: KEEP — called by ActionResolver.resolveBuild(). Already standalone module.

- [x] **EXISTS**: `estimateBuildCost(fromPositions, toPositions, gridPoints)` — Cost estimation for track building
  * **Location**: `src/server/services/ai/computeBuildSegments.ts`
  * **Usage**: KEEP — called by ContextBuilder for demand cost estimates.

- [x] **EXISTS**: `buildInitialTrackSegments(majorCityPositions, demandTargets, budget, gridPoints)` — Cold-start track builder
  * **Location**: `src/server/services/ai/computeBuildSegments.ts`
  * **Usage**: KEEP — called by ActionResolver.resolveBuild() when frontier is empty.

- [x] **EXISTS**: `TrackNetworkService.findPath(network, from, to): Milepost[] | null` — A* pathfinding on track network
  * **Location**: `src/shared/services/TrackNetworkService.ts`
  * **Usage**: KEEP — called by ActionResolver.resolveMove(). Requires pre-built network.

- [x] **EXISTS**: `buildTrackNetwork(segments): StringTrackNetwork` — Converts segments to graph
  * **Location**: `src/shared/services/TrackNetworkService.ts` (standalone export)
  * **Usage**: KEEP — called before findPath/isConnected in ContextBuilder and ActionResolver.

- [x] **EXISTS**: `TrackNetworkService.isConnected(network, from, to): boolean` — BFS connectivity check
  * **Location**: `src/shared/services/TrackNetworkService.ts`
  * **Usage**: KEEP — called by ContextBuilder for major city connectivity count.

- [x] **EXISTS**: `TrackNetworkService.getReachableMileposts(network): Set<Milepost>` — Returns ALL network nodes
  * **Location**: `src/shared/services/TrackNetworkService.ts`
  * **Usage**: NOT directly usable for "reachable this turn." Returns ALL nodes, not speed-limited.

- [x] **EXISTS**: `TrackBuildingService.isValidConnection(from, to): boolean` — Adjacency + water crossing validation
  * **Location**: `src/shared/services/TrackBuildingService.ts`
  * **Usage**: KEEP — called by ActionResolver for BUILD segment validation. No dryRun exists.

- [x] **EXISTS**: `TrackBuildingService.addPlayerTrack(playerId, gameId, from, to, options?): Result<TrackNetwork, TrackBuildError>` — Mutating track builder
  * **Location**: `src/shared/services/TrackBuildingService.ts`
  * **Usage**: TurnExecutor only (execution, not validation). Options: `{ turnBudget?: number }`.

### Track Usage & Fees
- [x] **EXISTS**: `computeTrackUsageForMove({ allTracks, from, to, currentPlayerId, majorCityGroups?, ferryEdges? }): TrackUsageComputation`
  * **Location**: `src/shared/services/trackUsageFees.ts`
  * **Usage**: KEEP — called by ActionResolver.resolveMove(). Returns `{ isValid, path, ownersUsed: Set<string> }`. Fee = `4 * ownersUsed.size`.

### Load & Demand Services
- [x] **EXISTS**: `LoadService.isLoadAvailableAtCity(loadType, city): boolean` — Static config check only
  * **Location**: `src/server/services/loadService.ts`
  * **Usage**: KEEP — but only checks if city *produces* that load type. Does NOT check runtime availability. Must supplement with load chip count check.

- [x] **EXISTS**: `LoadService.getAvailableLoadsForCity(city): string[]` — All load types a city produces
  * **Location**: `src/server/services/loadService.ts`
  * **Usage**: KEEP — called by ContextBuilder for pickup opportunity detection.

- [x] **EXISTS**: `DemandDeckService.drawCard() / discardCard(cardId)` — Demand card management
  * **Location**: `src/server/services/demandDeckService.ts`
  * **Usage**: TurnExecutor only (unchanged).

### Player Services
- [x] **EXISTS**: `PlayerService.moveTrainForUser(gameId, userId, to, movementCost?)` — Server-authoritative movement with fee calculation
  * **Location**: `src/server/services/playerService.ts`
  * **Usage**: TurnExecutor only (unchanged).

- [x] **EXISTS**: `PlayerService.deliverLoadForUser(gameId, userId, city, loadType, cardId)` — Delivery with payment
  * **Location**: `src/server/services/playerService.ts`
  * **Usage**: TurnExecutor only (unchanged).

- [x] **EXISTS**: No `pickupLoadForUser`. TurnExecutor.handlePickupLoad does raw SQL.
  * **Usage**: TurnExecutor pickup path unchanged.

### Existing Types
- [x] **EXISTS**: `FeasibleOption` interface with `action: AIActionType` discriminator
  * **Location**: `src/shared/types/GameTypes.ts`
  * **Usage**: KEEP for backwards compatibility but new pipeline uses `TurnPlan` instead.

- [x] **EXISTS**: `AIActionType` enum — BuildTrack, MoveTrain, PickupLoad, DeliverLoad, DropLoad, UpgradeTrain, DiscardHand, PassTurn, FerryCrossing
  * **Location**: `src/shared/types/GameTypes.ts`
  * **Usage**: KEEP — reused in TurnPlan type discriminator.

- [x] **EXISTS**: `WorldSnapshot` interface with bot state, allPlayerTracks, loadAvailability, opponents
  * **Location**: `src/shared/types/GameTypes.ts`
  * **Usage**: KEEP — ContextBuilder reads this, ActionResolver reads this.

### Modules Being Removed (stop calling)
- [x] **EXISTS**: `OptionGenerator.generate(snapshot, allowedActions): FeasibleOption[]` — Enumeration + feasibility (source of most defects)
  * **Location**: `src/server/services/ai/OptionGenerator.ts`
  * **Usage**: REMOVE from pipeline. Keep file for now; delete in Phase 3.

- [x] **EXISTS**: `Scorer.score(options, snapshot, botConfig, memory): FeasibleOption[]` — Heuristic scoring
  * **Location**: `src/server/services/ai/Scorer.ts`
  * **Usage**: REMOVE from pipeline. Keep file for now; delete in Phase 3.

- [x] **EXISTS**: `PlanValidator` — Standalone validation functions
  * **Location**: `src/server/services/ai/PlanValidator.ts`
  * **Usage**: REMOVE from pipeline. Validation logic absorbed into ActionResolver.

- [x] **EXISTS**: `PlanExecutor.executePlan(plan, snapshot, moves, builds, memory)` — Multi-turn plan phase machine
  * **Location**: `src/server/services/ai/PlanExecutor.ts`
  * **Usage**: REMOVE from pipeline. LLM handles multi-turn strategy via planHorizon reasoning.

---

## Required Implementation (Derived from PRD)

### New Modules

- [ ] **MISSING**: `ContextBuilder.build(snapshot, skillLevel): Promise<GameContext>`
  * **Purpose**: Compute decision-relevant context from WorldSnapshot using existing shared services
  * **Why Needed**: PRD Section 3 — replaces OptionGenerator's useful context computation
  * **Location**: `src/server/services/ai/ContextBuilder.ts`

- [ ] **MISSING**: `ActionResolver.resolve(intent: LLMActionIntent): Promise<ResolvedAction>`
  * **Purpose**: Translate LLM strategic intent into validated, executable TurnPlan
  * **Why Needed**: PRD Section 5 — replaces OptionGenerator enumeration + PlanValidator
  * **Location**: `src/server/services/ai/ActionResolver.ts`

### New Interfaces

- [ ] **MISSING**: `GameContext` — ContextBuilder output for LLM prompt serialization
  * **Purpose**: Structured game state with pre-computed reachability, demands, opportunities
  * **Why Needed**: PRD Section 3.1
  * **Fields**: position, money, trainType, speed, capacity, loads, connectedMajorCities, trackSummary, turnBuildCost, demands[], canDeliver[], reachableCities, canUpgrade, canBuild, isInitialBuild, opponents[], phase, turnNumber

- [ ] **MISSING**: `DemandContext` — Per-demand reachability metadata
  * **Purpose**: Pre-computed supply/delivery reachability and cost estimates
  * **Why Needed**: PRD Section 3.1
  * **Fields**: cardIndex, loadType, supplyCity, deliveryCity, payout, isSupplyReachable, isDeliveryReachable, estimatedTrackCostToSupply, estimatedTrackCostToDelivery, isLoadAvailable, isLoadOnTrain, ferryRequired

- [ ] **MISSING**: `LLMActionIntent` — LLM response format (single or multi-action)
  * **Purpose**: Parsed LLM output expressing strategic intent
  * **Why Needed**: PRD Section 4.2
  * **Fields**: action?, actions?, details, reasoning, planHorizon

- [ ] **MISSING**: `TurnPlan` — Discriminated union of executable action plans
  * **Purpose**: Replaces FeasibleOption as pipeline currency from ActionResolver to TurnExecutor
  * **Why Needed**: PRD Section 5.1
  * **Variants**: BuildTrack{segments}, MoveTrain{path, fees, totalFee}, DeliverLoad{load, city, cardId, payout}, PickupLoad{load, city}, UpgradeTrain{targetTrain, cost}, DiscardHand, PassTurn, MultiAction{steps}
  * **Excluded from TurnPlan**: `DropLoad` and `FerryCrossing` are AIActionType enum values but intentionally omitted as TurnPlan variants:
    - **DropLoad**: Subsumed by PickupLoad/DeliverLoad — load drops happen as part of MoveTrain when the LLM decides to release cargo mid-route. No separate resolver needed; TurnExecutor handles drop as a side effect.
    - **FerryCrossing**: Transparent in pathfinding — ferry traversal is encoded in MoveTrain.path by TrackNetworkService.findPath(). The bot treats ferries as regular track segments with implicit stop-and-continue semantics.

- [ ] **MISSING**: `ResolvedAction` — ActionResolver output
  * **Purpose**: Success/failure wrapper with error message for LLM retry
  * **Why Needed**: PRD Section 5.1
  * **Fields**: success, plan?, error?

### New Validation Methods

- [ ] **MISSING**: `ContextBuilder.computeReachableCities(position, speed, network): Set<string>`
  * **Purpose**: BFS from bot position with depth limit of speed mileposts
  * **Why Needed**: PRD Section 3.2 — `getReachableMileposts()` returns ALL nodes, not distance-limited
  * **Parameters**: Bot position (GridCoord), speed (number), pre-built TrackNetwork
  * **Return**: Set of city names reachable within speed mileposts

- [ ] **MISSING**: `ContextBuilder.isLoadRuntimeAvailable(loadType, snapshot): boolean`
  * **Purpose**: Check if any copies of load type are available (not carried by any player)
  * **Why Needed**: PRD Section 3.2 — `isLoadAvailableAtCity()` only checks static config
  * **Parameters**: Load type string, WorldSnapshot (for all player loads)
  * **Return**: true if >= 1 copy not on any train

- [ ] **MISSING**: `ActionResolver.resolveMultiAction(actions): Promise<ResolvedAction>`
  * **Purpose**: Resolve sequence of actions with cumulative state simulation
  * **Why Needed**: PRD Section 5.7
  * **Validates**: UPGRADE(20M)+BUILD forbidden, DISCARD_HAND exclusive

### Modified Methods

- [ ] **MISSING**: `LLMStrategyBrain.decideAction(snapshot, context): Promise<LLMDecisionResult>`
  * **Purpose**: Open-ended LLM intent + retry loop (replaces selectOptions)
  * **Why Needed**: PRD Section 4, 5.8
  * **Flow**: serialize context → callLLM → parse intent → resolve → retry on error → heuristic fallback

- [ ] **MISSING**: New `ResponseParser.parseActionIntent(responseText): LLMActionIntent`
  * **Purpose**: Parse action+details JSON (replaces index-based parse)
  * **Why Needed**: PRD Section 4.2 response format change

- [ ] **MISSING**: Updated system prompt common suffix with AVAILABLE ACTIONS + RESPONSE FORMAT
  * **Purpose**: Tell LLM about new action types and JSON response schema
  * **Why Needed**: PRD Section 4.2

- [ ] **MISSING**: Prompt serialization function for GameContext → user prompt string
  * **Purpose**: Render GameContext into structured text matching PRD Section 4.3 template
  * **Why Needed**: PRD Sections 4.3-4.6

---

## Design Patterns to Follow

#### RECOMMENDED

| pattern_id | severity | diagnostic | evidence | file_path | reason |
|---|---|---|---|---|---|
| `common-code-readability` | recommended | CONSISTENT | `src/server/services/ai/computeBuildSegments.ts:32` — `getWaterCrossingCost()` is 6 lines with guard clause; `makeKey()` at `:48` is 3 lines. Functions use clear verb+noun naming. | `docs/design-patterns/common/code-readability.md` | New ContextBuilder and ActionResolver must follow same clarity standard |
| `anti-patterns-god-service` | recommended | CONFLICT | `src/server/services/ai/OptionGenerator.ts:145` — ~1576 lines with 16 static methods mixing enumeration (`:315`), validation (`:624`), pathfinding (`:1001`), and scoring (`:1438`) | `docs/design-patterns/anti-patterns/god-service.md` | (a) OptionGenerator IS the god service being decomposed — new modules are the fix |
| `anti-patterns-error-swallowing` | recommended | CONSISTENT | `src/server/services/ai/TurnExecutor.ts:121` — best-effort audit INSERT outside transaction with try-catch logging; pattern repeats at `:206`, `:342`, `:441`, `:560`, `:634`, `:696`, `:737` | `docs/design-patterns/anti-patterns/error-swallowing.md` | ActionResolver retry loop must log errors before retrying, not swallow them |

#### ADVISORY

| pattern_id | severity | diagnostic | evidence | file_path | reason |
|---|---|---|---|---|---|
| `common-dry-principle` | advisory | NEW CODE | Searched `src/server/services/ai/` — no ActionResolver or ContextBuilder exists yet | `docs/design-patterns/common/dry-principle.md` | 7 action resolvers share validation patterns (position check, budget check) — extract helpers |
| `anti-patterns-over-abstraction` | advisory | CONFLICT | `src/server/services/ai/OptionGenerator.ts:145` — single class abstracts enumeration (`:315`), validation (`:624`), and pathfinding (`:1001`) into one module | `docs/design-patterns/anti-patterns/over-abstraction.md` | (a) ActionResolver resolves ONE action per call — no multi-target abstraction |
| `anti-patterns-enterprise-patterns` | advisory | CONSISTENT | `src/server/services/ai/OptionGenerator.ts:153` — `static generate()`, no DI; `AIStrategyEngine.ts` uses direct static calls to all AI services | `docs/design-patterns/anti-patterns/enterprise-patterns.md` | New modules follow same static pattern — no DI framework needed |
| `anti-patterns-premature-generalization` | advisory | NEW CODE | Searched `src/server/services/ai/` — no generic action resolver exists | `docs/design-patterns/anti-patterns/premature-generalization.md` | Build concrete resolvers per action type, not a plugin system |
| `anti-patterns-stringly-typed` | advisory | CONSISTENT | `src/shared/types/GameTypes.ts:367` — `AIActionType` enum with explicit values; `FeasibleOption` at `:303` uses `AIActionType` discriminator | `docs/design-patterns/anti-patterns/stringly-typed.md` | LLM returns string action types — must validate against enum before processing |

---

## Product Decisions

No product questions — PRD fully specifies bot behavior, action types, response format, skill levels, and fallback strategy. The changes are entirely backend AI pipeline with no user-facing UX decisions needed.

---

## Part A: UX & Design Specification

**Skipped** — `ai_feature` scenario type. Strategy Inspector UI changes are display-only format updates (show action + reasoning instead of ranked options). No new screens, no new interactions, no UX decisions.

---

## Part B: Solution Architecture

### B1. Architecture Overview

Replace 4-stage pipeline (WorldSnapshot → OptionGenerator → Scorer → TurnExecutor) with 6-stage pipeline:

```
AIStrategyEngine.takeTurn()
  1. WorldSnapshot.capture()          — KEEP: immutable game state
  2. ContextBuilder.build()           — NEW: compute LLM context from shared services
  3. LLMStrategyBrain.decideAction()  — MODIFIED: open-ended intent, not menu selection
  4. ActionResolver.resolve()         — NEW: translate intent → validated TurnPlan
  5. GuardrailEnforcer.check()        — MODIFIED: TurnPlan input, implement real guardrails
  6. TurnExecutor.execute()           — MODIFIED: TurnPlan input instead of FeasibleOption
```

Key architectural change: **ActionResolver pathfinds to ONE target per call**, not all possible targets simultaneously. This structurally eliminates the multi-target Dijkstra bugs (P3, P3.1) that plagued OptionGenerator.

### B2. Discovered Technology Stack

#### B2.1 Backend
- **Language/Runtime**: TypeScript on Node.js
- **Framework**: Fastify (HTTP server), Socket.IO (real-time)
- **ORM/Data Access**: Raw SQL via `pg` (PostgreSQL driver), no ORM
- **Key Libraries**: `@anthropic-ai/sdk` (Claude API), `@google/generative-ai` (Gemini API)
- **Testing**: Jest with `ts-jest`, server tests in `src/server/__tests__/`

#### B2.2 Frontend
- **Framework**: Phaser 3 (game engine) + React (UI overlays)
- **Language**: TypeScript
- **Build Tool**: Webpack
- **State Management**: Phaser scene state + React component state
- **Styling**: CSS modules
- **Testing**: Jest with jsdom environment

#### B2.3 Database
- **Primary**: PostgreSQL
- **Migrations**: Manual SQL scripts
- **Caching**: None detected

#### B2.4 Infrastructure
- N/A — no infrastructure changes in this feature

### B3. System Architecture

#### B3.1 New Pipeline Data Flow

```
WorldSnapshot (immutable)
    │
    ▼
ContextBuilder
    ├── TrackNetworkService.isConnected()  → connectedMajorCities
    ├── BFS with speed limit               → reachableCities
    ├── estimateBuildCost()                 → demand cost estimates
    ├── LoadService.isLoadAvailableAtCity() → static availability
    ├── Runtime load chip check             → actual availability
    ├── Simple array logic                  → canDeliver opportunities
    └── Skill-level filtering              → opponent context
    │
    ▼
GameContext (structured)
    │
    ▼
LLMStrategyBrain.decideAction()
    ├── Serialize GameContext → user prompt text
    ├── callLLM(systemPrompt, userPrompt)
    ├── Parse response → LLMActionIntent
    └── Return intent + metadata
    │
    ▼
ActionResolver.resolve()
    ├── BUILD:   computeBuildSegments() → segments → isValidConnection() per seg
    ├── MOVE:    buildTrackNetwork() → findPath() → computeTrackUsageForMove()
    ├── DELIVER: position check + load check + demand match
    ├── PICKUP:  position check + capacity check + static + runtime availability
    ├── UPGRADE: train type validation + cost check + phase check
    ├── DISCARD: phase check
    └── PASS:    always succeeds
    │
    ▼
ResolvedAction { success: boolean, plan?: TurnPlan, error?: string }
    │
    ├── If !success → LLM retry with error → if still fails → heuristicFallback
    │
    ▼
GuardrailEnforcer.check()
    ├── Force DELIVER when load+demand+position match
    ├── Prevent PASS when delivery possible
    └── Block UPGRADE during initialBuild
    │
    ▼
TurnExecutor.execute()
    ├── BuildTrack  → TrackBuildingService.addPlayerTrack() (in transaction)
    ├── MoveTrain   → PlayerService.moveTrainForUser()
    ├── DeliverLoad → PlayerService.deliverLoadForUser()
    ├── PickupLoad  → raw SQL (array_append)
    ├── UpgradeTrain→ PlayerService.purchaseTrainType()
    ├── DiscardHand → DemandDeckService operations
    └── PassTurn    → no-op with audit
```

#### B3.2 Retry and Fallback Chain

```
1. LLM call → ActionResolver.resolve()
   ├── Success → proceed to GuardrailEnforcer
   └── Failure → retry with error context
       ├── Success → proceed to GuardrailEnforcer
       └── Failure → heuristicFallback(context)
           ├── canDeliver? → deliver highest payout
           ├── canBuild? → build toward best demand
           └── else → PassTurn
```

Following `anti-patterns-error-swallowing`: every failure in the retry chain must be logged with context (intent, error message, attempt number) before proceeding to next step.

#### B3.3 Module Boundaries

Following `anti-patterns-god-service` decomposition:

| Module | Responsibility | Lines (target) | Methods |
|---|---|---|---|
| `ContextBuilder` | Compute game context from snapshot | ~200 | `build()`, `computeReachableCities()`, `isLoadRuntimeAvailable()`, `serializePrompt()` |
| `ActionResolver` | Translate intent → validated plan | ~300 | `resolve()`, `resolveBuild()`, `resolveMove()`, `resolveDeliver()`, `resolvePickup()`, `resolveUpgrade()`, `resolveDiscard()`, `resolvePass()`, `resolveMultiAction()`, `heuristicFallback()` |
| `LLMStrategyBrain` | LLM communication + retry | ~150 | `decideAction()`, `retryWithError()`, `callLLM()` |
| `ResponseParser` | Parse LLM JSON response | ~80 | `parseActionIntent()`, `validateActionType()` |

Each module is independently testable. No module exceeds 400 lines. Following `anti-patterns-premature-generalization`: each resolver is concrete, not generic.

### B5. Communication Layer (LLM API)

#### B5.1 LLM Provider Interface

Existing `ProviderAdapter` interface unchanged:
```typescript
interface ProviderAdapter {
  chat(params: { model, maxTokens, temperature, systemPrompt, userPrompt }): Promise<{ text: string; usage?: TokenUsage }>
}
```

Providers: `AnthropicAdapter` (Claude), `GoogleAdapter` (Gemini). Both at `src/server/services/ai/providers/`.

#### B5.2 Prompt Caching (Anthropic)

PRD Section 8: System prompt (~800 tokens) cached via Anthropic's `cache_control: { type: 'ephemeral' }`. Reduces per-turn input cost ~40%.

```typescript
system: [{
  type: 'text',
  text: systemPrompt,
  cache_control: { type: 'ephemeral' }
}]
```

#### B5.3 LLM Request/Response Contract

**Input** (user prompt): Structured text from ContextBuilder.serializePrompt(). Sections: TURN/PHASE, YOUR STATUS, YOUR DEMAND CARDS, IMMEDIATE OPPORTUNITIES, CITIES REACHABLE, UPGRADE OPTIONS, BUILD CONSTRAINTS, OPPONENTS.

**Output** (LLM response): JSON matching `LLMActionIntent`:

Single action:
```json
{
  "action": "BUILD",
  "details": { "toward": "Zurich", "purpose": "Extend backbone east" },
  "reasoning": "...",
  "planHorizon": "..."
}
```

Multi-action:
```json
{
  "actions": [
    { "action": "MOVE", "details": { "to": "Vienna" } },
    { "action": "DELIVER", "details": { "load": "Wine", "at": "Vienna" } }
  ],
  "reasoning": "...",
  "planHorizon": "..."
}
```

Following `anti-patterns-stringly-typed`: `action` string must be validated against `AIActionType` enum values before processing. Unknown action types → error → retry.

### B7. Backend Architecture

#### B7.1 Service Layer

All AI services use **static methods** (no DI). Following `anti-patterns-enterprise-patterns`: no DI containers, no abstract factories. Direct function calls.

**New module: ContextBuilder**

```typescript
// src/server/services/ai/ContextBuilder.ts
class ContextBuilder {
  static async build(snapshot: WorldSnapshot, skillLevel: SkillLevel): Promise<GameContext>

  // BFS from bot position, depth-limited by speed
  private static computeReachableCities(
    position: GridCoord, speed: number, network: TrackNetwork, gridPoints: GridPoint[]
  ): string[]

  // Check if any copies of load type are not on trains
  private static isLoadRuntimeAvailable(loadType: string, snapshot: WorldSnapshot): boolean

  // Pre-compute demand reachability using findPath + estimateBuildCost
  private static computeDemandContext(
    demand: ResolvedDemand, snapshot: WorldSnapshot, network: TrackNetwork
  ): DemandContext

  // Filter opponent info by skill level
  private static buildOpponentContext(
    opponents: OpponentSnapshot[], skillLevel: SkillLevel
  ): OpponentContext[]

  // Render GameContext into user prompt text per PRD Section 4.3 template
  static serializePrompt(context: GameContext, skillLevel: SkillLevel): string
}
```

Key implementation notes:
- `computeReachableCities`: BFS from position through track network, counting mileposts. Stop at `speed` depth. Collect city-named nodes. Ferry nodes: if encountered, remaining depth halved.
- `isLoadRuntimeAvailable`: Count total copies of loadType (from static config), subtract copies on all players' trains (from `snapshot.allPlayerTracks` + `snapshot.bot.loads`). Available if count > 0.
- `computeDemandContext`: For each demand, check `isLoadOnTrain` (load in bot.loads), `isSupplyReachable` (findPath from bot position to supply city), `isDeliveryReachable` (findPath to delivery city), `estimatedTrackCost` via `estimateBuildCost()` when not reachable.
- `buildOpponentContext`: Easy=[], Medium=name+money+trainType+position, Hard=full+loads+trackCoverage+recentBuildDirection.

**New module: ActionResolver**

```typescript
// src/server/services/ai/ActionResolver.ts
class ActionResolver {
  // Resolve LLM intent into validated TurnPlan
  static async resolve(
    intent: LLMActionIntent, snapshot: WorldSnapshot, context: GameContext
  ): Promise<ResolvedAction>

  private static resolveBuild(details: { toward: string }, snapshot, context): Promise<ResolvedAction>
  private static resolveMove(details: { to: string }, snapshot): Promise<ResolvedAction>
  private static resolveDeliver(details: { load: string; at: string }, snapshot): Promise<ResolvedAction>
  private static resolvePickup(details: { load: string; at: string }, snapshot): Promise<ResolvedAction>
  private static resolveUpgrade(details: { to: string }, snapshot): Promise<ResolvedAction>
  private static resolveDiscard(snapshot): Promise<ResolvedAction>
  private static resolvePass(): Promise<ResolvedAction>
  private static resolveMultiAction(actions: LLMAction[], snapshot, context): Promise<ResolvedAction>

  // Fallback when LLM fails twice
  static heuristicFallback(context: GameContext, snapshot: WorldSnapshot): Promise<ResolvedAction>
}
```

Key implementation notes per resolver:
- **BUILD**: Find target milepost by city name → compute track frontier → `computeBuildSegments(frontier, target, budget)` → validate each segment with `isValidConnection()` → return `{ type: 'BuildTrack', segments }`. Cold-start: `buildInitialTrackSegments()`.
- **MOVE**: `buildTrackNetwork(botSegments)` → `findPath(network, position, target)` → check path length vs remaining movement → `computeTrackUsageForMove()` → check fee vs money (5M reserve) → return `{ type: 'MoveTrain', path, totalFee }`.
- **DELIVER**: Check bot at city, load on train, matching demand card → return `{ type: 'DeliverLoad', load, city, cardId, payout }`.
- **PICKUP**: Check bot at city, capacity, `isLoadAvailableAtCity(loadType, city)` + `isLoadRuntimeAvailable()` → return `{ type: 'PickupLoad', load, city }`.
- **UPGRADE**: Validate train upgrade path, cost, not initialBuild → return `{ type: 'UpgradeTrain', targetTrain, cost }`.
- **MULTI-ACTION**: Clone snapshot, resolve each action sequentially updating clone, validate combination legality (UPGRADE 20M + BUILD forbidden, DISCARD exclusive) → return `{ type: 'MultiAction', steps }`.

Following `anti-patterns-over-abstraction`: each resolver is a standalone method, not a strategy pattern or plugin. Direct code, not configuration.

**Modified module: LLMStrategyBrain**

```typescript
// src/server/services/ai/LLMStrategyBrain.ts
class LLMStrategyBrain {
  async decideAction(
    snapshot: WorldSnapshot, context: GameContext
  ): Promise<LLMDecisionResult>
  // Flow: serialize → callLLM → parse → resolve → (retry?) → (fallback?)

  // REMOVE: selectOptions, retryWithMinimalPrompt
  // KEEP: createAdapter, callLLM internals, provider config
}

interface LLMDecisionResult {
  plan: TurnPlan;
  reasoning: string;
  planHorizon: string;
  model: string;
  latencyMs: number;
  tokenUsage?: { input: number; output: number };
  retried: boolean;
  guardrailOverride?: boolean;
}
```

**Modified module: GuardrailEnforcer**

Currently a NO-OP. Implement actual guardrails:
```typescript
static check(plan: TurnPlan, context: GameContext, snapshot: WorldSnapshot): GuardrailResult {
  // 1. Force DELIVER when possible (canDeliver.length > 0 and plan isn't already DELIVER)
  // 2. Block PASS when delivery is possible
  // 3. Block UPGRADE during initialBuild
}
```

**Modified module: TurnExecutor**

Change input signature: `execute(plan: TurnPlan, snapshot)` instead of `execute(plan: FeasibleOption, snapshot)`. Map `TurnPlan.type` to existing handlers. Handler internals unchanged — they already use `plan.segments`, `plan.path`, etc.

**Modified module: ResponseParser**

Add `parseActionIntent(responseText): LLMActionIntent`:
- Strip markdown fences
- JSON.parse → validate `action` or `actions` field exists
- Validate action type string against known values (BUILD, MOVE, DELIVER, PICKUP, UPGRADE, DISCARD_HAND, PASS)
- Extract `details`, `reasoning`, `planHorizon`
- Fallback: regex extraction of key fields
- Throw `ParseError` on failure (triggers retry)

**Modified module: AIStrategyEngine**

Rewire `takeTurn()`:
```
1. capture(gameId, botPlayerId) → snapshot
2. Auto-place bot if needed (keep existing logic)
3. ContextBuilder.build(snapshot, skillLevel) → context
4. LLMStrategyBrain.decideAction(snapshot, context) → decision
   (internally: serialize → LLM → parse → ActionResolver.resolve → retry → fallback)
5. GuardrailEnforcer.check(decision.plan, context, snapshot) → guardrailResult
6. TurnExecutor.execute(finalPlan, snapshot) → executionResult
7. Emit StrategyAudit + bot:turn-complete
```

Remove all OptionGenerator, Scorer, PlanValidator, PlanExecutor calls. Remove Phase 0/1/2 phasing — LLM decides all actions in one call (or multi-action). Keep retry loop (3 attempts), PassTurn fallback, and StrategyAudit emission.

#### B7.2 Data Access Layer

No changes. TurnExecutor continues using raw SQL via `pg` pool. Transaction pattern unchanged: critical ops in BEGIN/COMMIT, audit INSERTs best-effort post-commit.

#### B7.3 Validation & Error Handling

ActionResolver performs all validation per action type. Errors returned as `{ success: false, error: "human-readable message" }` for LLM retry context. No exceptions thrown for business logic failures.

Following `anti-patterns-error-swallowing`:
- LLM API errors → log with full context → retry
- Parse errors → log raw response → retry
- ActionResolver errors → log intent + error → send to LLM for retry
- TurnExecutor errors → log → PassTurn fallback (existing pattern)

### B8. Security Context

#### B8.1 External Credentials

| Service | Credential | Storage | Usage |
|---|---|---|---|
| Anthropic Claude API | API key | Environment variable `ANTHROPIC_API_KEY` | LLM calls via AnthropicAdapter |
| Google Gemini API | API key | Environment variable `GOOGLE_AI_API_KEY` | Optional LLM provider |

No new credentials needed. Existing provider adapters handle key access.

#### B8.2 LLM Response Validation

LLM responses are untrusted input. ActionResolver validates every field:
- City names validated against known city list (from grid data)
- Action types validated against AIActionType enum
- Load types validated against known load types
- Train types validated against upgrade paths
- Numeric values (costs, payouts) derived from game state, not LLM claims

### B10. Performance Optimization

#### B10.1 Per-Turn Latency Budget

| Component | Target | Notes |
|---|---|---|
| WorldSnapshot.capture() | <50ms | Single SQL query (existing) |
| ContextBuilder.build() | <100ms | BFS + estimateBuildCost calls |
| LLM call | 500-2000ms | Model-dependent (Haiku <1s, Sonnet 1-2s) |
| ActionResolver.resolve() | <50ms | Single-target Dijkstra + validation |
| GuardrailEnforcer | <5ms | Simple conditionals |
| TurnExecutor | <100ms | DB transaction |
| **Total** | **700-2300ms** | Dominated by LLM latency |

#### B10.2 Prompt Caching

System prompt cached via Anthropic ephemeral cache. ~800 tokens processed once per session (~60 turns). Saves ~40% input token cost.

#### B10.3 Token Budget

| Skill | Model | Input ~tokens | Output ~tokens | Cost/turn |
|---|---|---|---|---|
| Easy | claude-haiku-4-5-20251001 | 400 | 80 | ~$0.0004 |
| Medium | claude-sonnet-4-20250514 | 800 | 100 | ~$0.003 |
| Hard | claude-sonnet-4-20250514 | 1200 | 120 | ~$0.005 |

### B11. Integration Points

| Service | Integration | Direction | Notes |
|---|---|---|---|
| Anthropic Claude API | REST via SDK | Outbound | Primary LLM provider |
| Google Gemini API | REST via SDK | Outbound | Alternative provider |
| PostgreSQL | pg pool | Bidirectional | Game state read/write |
| Socket.IO | Event emission | Outbound | `bot:turn-complete`, StrategyAudit |

### B13. Testing Context

#### B13.1 Current Test Infrastructure

- **Framework**: Jest with `ts-jest` transformer
- **Server tests**: `src/server/__tests__/ai/*.test.ts`
- **Test pattern**: Static method mocking via `jest.mock()`, manual snapshot construction
- **Existing AI test files**:
  - `GuardrailEnforcer.test.ts` — guardrail override tests
  - `LLMStrategyBrain.test.ts` — LLM selection tests
  - `PlanExecutor.test.ts` — plan phase machine tests
  - `computeBuildSegments.test.ts` — Dijkstra pathfinding tests

#### B13.2 Required Test Coverage

**ContextBuilder tests** (`src/server/__tests__/ai/ContextBuilder.test.ts`):
- Build context from snapshot with various game states
- BFS reachability with speed limit
- Runtime load availability check
- Demand context computation (supply/delivery reachable, cost estimates)
- Skill-level opponent filtering
- Edge cases: null position, empty track, no demands

**ActionResolver tests** (`src/server/__tests__/ai/ActionResolver.test.ts`):
- Each resolver individually: BUILD, MOVE, DELIVER, PICKUP, UPGRADE, DISCARD, PASS
- BUILD: cold-start, budget exceeded, invalid segments, target not found
- MOVE: path not found, speed exceeded, fee exceeds budget, 5M reserve
- DELIVER: not at city, not carrying load, no matching demand
- PICKUP: full capacity, load unavailable (static), load unavailable (runtime)
- UPGRADE: invalid upgrade path, insufficient money, initialBuild restriction
- Multi-action: combination legality, cumulative state simulation
- Heuristic fallback: deliver > build > pass priority

**ResponseParser tests** (extend existing):
- Parse single action intent JSON
- Parse multi-action intent JSON
- Handle markdown fences
- Handle malformed JSON (regex fallback)
- Validate action type strings

**Integration tests** (extend AIStrategyEngine tests):
- Full pipeline: snapshot → context → LLM mock → resolve → execute
- Retry on invalid intent
- Heuristic fallback after two failures
- GuardrailEnforcer override

#### B13.3 Mocking Strategy

| Dependency | Mock Approach |
|---|---|
| LLM Provider | Mock `ProviderAdapter.chat()` with canned responses |
| PostgreSQL | Not mocked — TurnExecutor tests use snapshot stubs |
| TrackNetworkService | Real implementation with test grid data |
| computeBuildSegments | Real implementation (pure function) |
| LoadService | Mock `isLoadAvailableAtCity()` per test case |

### B14. Migration & Rollout Plan

#### Phase 1: Core Pipeline (Primary)
1. Define new interfaces in `GameTypes.ts` (GameContext, DemandContext, LLMActionIntent, TurnPlan, ResolvedAction)
2. Create `ContextBuilder.ts` with `build()` + `serializePrompt()`
3. Create `ActionResolver.ts` with all 7 single-action resolvers + heuristicFallback
4. Update `ResponseParser.ts` with `parseActionIntent()`
5. Update `LLMStrategyBrain.ts` — `decideAction()` replacing `selectOptions()`
6. Update system prompt common suffix in `systemPrompts.ts`
7. Rewire `AIStrategyEngine.takeTurn()` to new pipeline
8. Update `TurnExecutor.execute()` signature for TurnPlan
9. Update `GuardrailEnforcer.check()` signature + implement real guardrails
10. Write tests for ContextBuilder and ActionResolver
11. **Keep** OptionGenerator, Scorer, PlanValidator, PlanExecutor files (don't delete yet)

#### Phase 2: Multi-Action + Skill Levels
1. Implement `resolveMultiAction()` with cumulative state simulation
2. Implement skill-level filtering in ContextBuilder
3. Switch Easy to Haiku model
4. Add opponent direction analysis for Hard
5. Add prompt caching (Anthropic ephemeral cache)

#### Phase 3: Cleanup
1. Update Strategy Inspector for new audit format
2. Delete OptionGenerator.ts, Scorer.ts, PlanValidator.ts, PlanExecutor.ts
3. Delete GameStateSerializer.ts (replaced by ContextBuilder.serializePrompt)
4. Full playtest matrix
