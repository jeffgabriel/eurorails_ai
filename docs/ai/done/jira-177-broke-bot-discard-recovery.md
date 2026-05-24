# Technical Specification: JIRA-177 — Fix Broke Bot Death Spiral

## What's Changing

### One-line Summary
Broke bots stuck in infinite PassTurn loops will now discard their hand until they draw a deliverable demand.

### Context
When a bot runs out of money and its active route requires building track it can't afford, it enters a death spiral: every turn it attempts the same infeasible route, the movement planner fails with `stop_city_not_on_network`, and the turn collapses to PassTurn. This repeats indefinitely — in today's games, 121 out of 319 bot turns (38%) were wasted this way. One bot sat at Berlin with 96M ECU and still couldn't escape because the guardrail stuck detector is bypassed when an active route exists.

### The Change
When a bot is broke and none of its demand cards can be fulfilled on its existing track network (no new building required), the bot will discard its entire hand for 3 fresh demand cards. If the new cards are also unplayable on the existing network, it discards again. This continues until the bot draws at least one demand it can fulfill using only its existing track — at which point it clears its stale route and plans a new one around that deliverable demand.

### Who's Affected
- **AI bots (all skill levels)**: Bots that go broke mid-game will recover instead of passing forever
- **Human players**: Games with AI opponents will no longer stall when a bot hits $0

### Why This Matters
This eliminates the single largest source of wasted bot turns. Bots that over-invest in track will recover by pivoting to demands matching their existing network, keeping the game moving.

## Implementation Context

**Project Maturity**: Brownfield

- **Repository & Structure**: Single TypeScript project (client + server)
- **Package Management**: npm with package.json
- **Testing Framework**: Jest with ts-jest, `__tests__/` directories
- **Build**: `npm run build` (client + server)
- **Development**: `npm run dev` (concurrent client + server)

## Discovered from Codebase (Via Semantic Search)

- [x] **EXISTS**: `GuardrailEnforcer.checkPlan(plan, context, snapshot, noProgressTurns, hasActiveRoute)` - Enforces hard guardrails on turn plans
  * **Location**: `src/server/services/ai/GuardrailEnforcer.ts:36-131`
  * **Relevance**: The stuck detector at line 67 has `!hasActiveRoute` gate that prevents firing when an active route exists

- [x] **EXISTS**: `AIStrategyEngine.takeTurn(gameId, botPlayerId)` - Main bot turn pipeline, manages route state and memory
  * **Location**: `src/server/services/ai/AIStrategyEngine.ts:181-1040`
  * **Relevance**: Passes `activeRoute != null` as `hasActiveRoute` to guardrail (line 832); manages `noProgressTurns` and `consecutiveDiscards` in memory

- [x] **EXISTS**: `noProgressTurns` tracking in memory patch
  * **Location**: `src/server/services/ai/AIStrategyEngine.ts:871-898`
  * **Relevance**: JIRA-166 correctly increments noProgressTurns when broke + off-network next stop, but the guardrail never reads it because hasActiveRoute blocks

- [x] **EXISTS**: `consecutiveDiscards` in BotMemory
  * **Location**: `src/server/services/ai/BotMemory.ts:24`
  * **Relevance**: Tracked but never read by any logic — available for use as a discard loop counter

- [x] **EXISTS**: `heuristicFallback` dead-hand check
  * **Location**: `src/server/services/ai/ActionResolver.ts:1228-1247`
  * **Relevance**: Checks `hasAchievable` (supply on network + delivery on network) and `cheapestCost > money` — correct detection logic but only runs on the routeless LLM fallback path

- [x] **EXISTS**: JIRA-61 route invalidation after discard
  * **Location**: `src/server/services/ai/AIStrategyEngine.ts:962-981`
  * **Relevance**: After DiscardHand, checks if active route references cards no longer in hand and clears it — this existing mechanism will naturally clear stale routes after forced discard

- [x] **EXISTS**: `TurnExecutorPlanner.execute()` Phase A movement loop
  * **Location**: `src/server/services/ai/TurnExecutorPlanner.ts:126-662`
  * **Relevance**: When `stop_city_not_on_network`, breaks to Phase B. If Phase B also fails, `plans.length === 0` produces PassTurn at line 645-647

- [x] **EXISTS**: `context.demands` with `isSupplyOnNetwork`, `isDeliveryOnNetwork`, `isLoadOnTrain` flags
  * **Location**: Built by `ContextBuilder.build()` / `ContextBuilder.rebuildDemands()`
  * **Relevance**: These flags are the exact data needed to determine if any demand is achievable on the existing network

## Required Implementation (Code Gaps)

- [ ] **MISSING**: Broke-and-stuck detection in GuardrailEnforcer
  * **Purpose**: Detect when bot is broke, has an active route, and no demand is achievable on existing network without building
  * **Parameters**: `context.demands`, `snapshot.bot.money`, `snapshot.bot.loads`, `hasActiveRoute`, `noProgressTurns`
  * **Return**: `GuardrailPlanResult` with `DiscardHand` plan when conditions met

- [ ] **MISSING**: Discard loop cap using `consecutiveDiscards`
  * **Purpose**: Prevent infinite discard loops if every possible hand is unplayable (safety valve)
  * **Parameters**: `consecutiveDiscards` from BotMemory (already tracked)
  * **Return**: After N consecutive discards (e.g., 3), stop discarding and PassTurn — let noProgressTurns accumulate for other recovery

- [ ] **MISSING**: Route clearing on forced discard
  * **Purpose**: When the guardrail forces DiscardHand due to broke-and-stuck, the stale active route must be cleared so the bot replans from scratch on the next turn
  * **Location**: AIStrategyEngine after guardrail override detection
  * **Note**: JIRA-61 logic at line 962-981 already clears routes after discard if cards change — but the active route must also be explicitly cleared in the memory patch to guarantee the bot doesn't re-enter the same stale route

## Design Patterns to Follow

| pattern_id | severity | diagnostic | evidence | file_path | reason |
|---|---|---|---|---|---|
| `anti-patterns-error-swallowing` | recommended | CONFLICT | `TurnExecutorPlanner.ts:645-647` silently converts empty plans to PassTurn with no recovery | `docs/design-patterns/anti-patterns/error-swallowing.md` | (a) Add recovery logic for the empty-plans case rather than silently passing |
| `common-code-readability` | recommended | CONSISTENT | Existing guardrail code uses clear named conditions and descriptive console.warn messages | `docs/design-patterns/common/code-readability.md` | New guardrail condition should follow same clarity pattern |
| `common-dry-principle` | advisory | CONSISTENT | `hasAchievable` check in `ActionResolver.ts:1232-1234` already computes what we need | `docs/design-patterns/common/dry-principle.md` | Extract achievability check as a shared utility or replicate the same logic consistently |
| `infrastructure-structured-logging` | recommended | CONSISTENT | All guardrails use `console.warn` with `[Guardrail N]` prefix pattern | `docs/design-patterns/infrastructure/structured-logging.md` | New guardrail should log with same prefix pattern and include diagnostic fields |
| `anti-patterns-logging-noise` | advisory | CONSISTENT | Existing guardrails log only on override, not every check | `docs/design-patterns/anti-patterns/logging-noise.md` | Only log when the broke-and-stuck guardrail actually fires, not on every turn evaluation |

## Product Decisions

1. **Question**: What is the discard loop cap — how many consecutive discards before giving up?
   - **Context**: If the bot's existing network is very small (e.g., just one corridor), it may take many discards to find a matching demand. But the deck has ~120 cards, so the odds improve quickly.
   - **Options**:
     - (A) Cap at 3 discards (9 fresh cards seen) — conservative, limits wasted turns
     - (B) Cap at 5 discards (15 fresh cards seen) — more aggressive recovery
   - **Impact**: Lower cap = bot may still get stuck occasionally but wastes fewer turns on discards. Higher cap = better recovery but more discards visible to human players.
   - **Decision**: Use 3 as the cap — matches the existing `noProgressTurns >= 3` threshold convention in the codebase.

## Part B: Solution Architecture

### B0. Architectural Decisions

**Quality Attribute Priorities:**
- Believability: CRITICAL — bot must appear to make rational recovery decisions
- Adaptability: CRITICAL — recovery must work regardless of network shape or demand deck state
- Debuggability: HIGH — death spiral recovery must be traceable in game logs

**Architectural Decisions:**

| # | Decision | Rationale | Alternatives Rejected | Tradeoffs |
|---|----------|-----------|----------------------|-----------|
| ADR-1 | Implement recovery as a new guardrail condition in GuardrailEnforcer rather than in TurnExecutorPlanner | Guardrails are the established pattern for overriding bad plans. Adding to TurnExecutorPlanner would duplicate decision logic. | Modifying TurnExecutorPlanner to detect broke-and-stuck internally | Guardrail fires after plan is composed, so one turn is still "wasted" on the PassTurn before the discard fires next turn — acceptable because the guardrail replaces the PassTurn with DiscardHand |
| ADR-2 | Clear active route when guardrail forces discard, don't wait for JIRA-61 route invalidation | JIRA-61 only clears routes when cards change. If (unlikely) the new hand still references the same load types, the stale route would persist. Explicit clearing guarantees a fresh TripPlanner call. | Relying solely on JIRA-61 | Bot loses its current route even if some stops were still valid — acceptable because the route was infeasible anyway |
| ADR-3 | Use `consecutiveDiscards` (already tracked) as the loop cap rather than a new counter | Avoids adding new memory state. The counter already exists, is incremented on discard, and resets on non-discard turns. | New `brokeDiscardCount` counter | `consecutiveDiscards` doesn't distinguish forced vs. voluntary discards, but this is fine — any 3 consecutive discards should trigger a cooldown regardless of cause |

### B1. Architecture Overview

This is an LLM game agent architecture (ref: `gaming-llm-game-agent`). The bot decision pipeline flows: WorldSnapshot → ContextBuilder → TripPlanner/TurnExecutorPlanner → GuardrailEnforcer → TurnExecutor. The fix targets GuardrailEnforcer (adding a new guardrail) and AIStrategyEngine (route clearing after guardrail override).

### B7. Backend Architecture

#### B7.1 Service Layer

**GuardrailEnforcer changes** (`src/server/services/ai/GuardrailEnforcer.ts`):

Add a new guardrail between the existing stuck detector (line 63-74) and G3 (line 76-84). The new guardrail fires when ALL of these conditions are true:

1. `snapshot.bot.money < 5` (broke — same threshold as JIRA-165/166)
2. `hasActiveRoute === true` (has a stale route blocking the existing stuck detector)
3. `noProgressTurns >= 2` (has been stuck for at least 2 turns — gives the build phase a chance first)
4. No demand is achievable on the existing network: `!context.demands.some(d => (d.isSupplyOnNetwork || d.isLoadOnTrain) && d.isDeliveryOnNetwork)`
5. `planType !== AIActionType.DiscardHand` (not already discarding)
6. `consecutiveDiscards < 3` (hasn't hit the discard cap)

When fired: return `{ plan: { type: AIActionType.DiscardHand }, overridden: true, reason: "Broke-and-stuck: no achievable demand on existing network..." }`.

**Signature change**: `checkPlan()` needs `consecutiveDiscards` passed in. Add it as an optional parameter with default 0.

**AIStrategyEngine changes** (`src/server/services/ai/AIStrategyEngine.ts`):

1. Pass `memory.consecutiveDiscards` to `GuardrailEnforcer.checkPlan()` (line 832)
2. After guardrail override detection (line 836-840): if the guardrail forced DiscardHand AND the bot had an active route, set `activeRoute = null` and mark it for clearing in the memory patch. This ensures the bot falls to TripPlanner on the next turn for a fresh route.

#### B7.2 Data Access Layer
N/A — no database changes.

#### B7.3 Validation & Error Handling

The `consecutiveDiscards` counter naturally prevents infinite loops:
- Incremented at `AIStrategyEngine.ts:899-900` when action is DiscardHand
- Reset to 0 when action is anything else
- New guardrail checks `consecutiveDiscards < 3` before firing
- After 3 consecutive discards, the guardrail stops firing, PassTurn resumes, and `noProgressTurns` continues incrementing. If the existing stuck detector eventually fires (when the route is cleared by other means), recovery can continue through that path.

### B13. Testing Context

#### B13.0 Testing Patterns and Frameworks

Using Jest with ts-jest (existing framework). Unit tests in `src/server/__tests__/`.

#### B13.1 App Type Detection

| Signal | Present | Test Layer Needed |
|--------|---------|-------------------|
| API endpoints | yes | not for this change |
| Frontend pages/components | yes | not for this change |
| Service layer / business logic | yes | `unit` |
| Database models / queries | no | N/A |

#### B13.2 Verification Scenarios

- [Unit] GuardrailEnforcer: broke bot ($0) with active route + no achievable demands + noProgressTurns >= 2 + consecutiveDiscards < 3 → forces DiscardHand
- [Unit] GuardrailEnforcer: broke bot with active route + HAS achievable demand on network → does NOT force discard (lets route-executor handle it)
- [Unit] GuardrailEnforcer: broke bot + no active route → falls through to existing stuck detector (no regression)
- [Unit] GuardrailEnforcer: broke bot with active route + consecutiveDiscards >= 3 → does NOT force discard (cap reached)
- [Unit] GuardrailEnforcer: bot has money ($50M) with active route + no achievable demands → does NOT force discard (not broke)
- [Unit] GuardrailEnforcer: broke bot + noProgressTurns < 2 → does NOT force discard (too early)
- [Unit] GuardrailEnforcer: G1 (force deliver) still takes priority over broke-and-stuck guardrail
- [Unit] AIStrategyEngine: after guardrail forces DiscardHand, activeRoute is set to null in memory patch
- [Unit] AIStrategyEngine: consecutiveDiscards is passed to GuardrailEnforcer.checkPlan()

#### B13.3 Test Commands

| Layer | Command |
|-------|---------|
| Unit | `npm test -- src/server/__tests__/GuardrailEnforcer.test.ts` |
| All | `npm test` |

#### B13.4 Test Infrastructure Requirements

| Layer | Requires |
|-------|----------|
| Unit | No external dependencies — mock context, snapshot, and memory |

#### B13.5 Service Operations

| Operation | Command |
|-----------|---------|
| start | `npm run dev` |
| stop | `Ctrl+C` |
| rebuild | `npm run build` |
| lint | N/A |
| test | `npm test` |
