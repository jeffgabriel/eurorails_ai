# Technical Specification: AI v6.2 Plan-Then-Execute Architecture

## Part A: UX Specification

### A.1 User-Facing Behavior Changes

The bot's behavior changes from "consult LLM every turn" to "plan-then-execute":
- Bot selects a delivery chain via LLM once, then executes it mechanically over multiple turns
- LLM is only consulted when: no plan exists, plan completes, plan becomes invalid, or bot is stuck
- Reduces LLM API calls by ~70-80% (1 call per delivery chain instead of 1 per turn)
- Bot behavior becomes more consistent and focused (no vacillation between targets)

### A.2 Observable Impact

- **StrategyInspector modal**: Will show plan state in bot memory (activePlan, turnsOnPlan, planHistory)
- **Console logs**: New log lines for plan creation, phase transitions, and re-plan triggers
- **Bot behavior**: More deterministic — builds toward one city until complete, then switches
- **No UI changes required**: All changes are server-side in the AI pipeline

## Part B: Architecture Specification

### B.1 Data Model Changes

#### GameTypes.ts — New Interface and BotMemoryState Extension

```typescript
// New interface
export interface DeliveryPlan {
  demandCardId: number;
  loadType: string;
  pickupCity: string;
  deliveryCity: string;
  payment: number;
  phase: 'build_to_pickup' | 'travel_to_pickup' | 'pickup' | 'build_to_delivery' | 'travel_to_delivery' | 'deliver';
  createdAtTurn: number;
  reasoning: string;
}

// Extend existing BotMemoryState with:
// activePlan: DeliveryPlan | null
// turnsOnPlan: number
// planHistory: Array<{ plan: DeliveryPlan; outcome: 'delivered' | 'abandoned'; turns: number }>
```

#### BotMemory.ts — Default State Update

Add to `defaultState()`:
- `activePlan: null`
- `turnsOnPlan: 0`
- `planHistory: []`

### B.2 New File: PlanExecutor.ts

Location: `src/server/services/ai/PlanExecutor.ts`

**Responsibility**: Given an active DeliveryPlan + WorldSnapshot + feasible options, select the best move and build choices aligned with the plan, and advance the plan phase when milestones are reached.

**Design**: Stateless static class. Takes plan + snapshot, returns choices + updated plan. All state lives in BotMemoryState via BotMemory.

```typescript
export class PlanExecutor {
  /**
   * Execute one turn of an active delivery plan.
   * Returns move/build choices aligned with the plan phase, plus the updated plan
   * (phase may advance if a milestone is reached).
   */
  static executePlan(
    plan: DeliveryPlan,
    snapshot: WorldSnapshot,
    feasibleMoves: FeasibleOption[],
    feasibleBuilds: FeasibleOption[],
    memory: BotMemoryState
  ): { moveChoice: FeasibleOption | null; buildChoice: FeasibleOption | null; updatedPlan: DeliveryPlan }
}
```

**Phase logic**:

1. `build_to_pickup`: Score builds toward pickupCity using existing Scorer with target override. Transition to `travel_to_pickup` when any track endpoint reaches a pickup city grid point.

2. `travel_to_pickup`: Score moves toward pickupCity. Transition to `pickup` when bot position is at the pickup city.

3. `pickup`: Phase 0/1.5 handles the actual pickup. Transition to `build_to_delivery` immediately (PlanExecutor detects load was picked up).

4. `build_to_delivery`: Score builds toward deliveryCity. Transition to `travel_to_delivery` when track reaches delivery city.

5. `travel_to_delivery`: Score moves toward deliveryCity. Transition to `deliver` when bot position is at delivery city.

6. `deliver`: Phase 0/1.5 handles delivery. Mark plan complete.

**Scoring approach**: Use existing `Scorer.score()` with the plan's target city set as `currentBuildTarget` in memory, and amplified loyalty factor (3.0x instead of 1.5x). Filter move options to prefer those heading toward the plan's current target city.

**Phase transition detection**:
- Track connectivity: check if any bot track endpoint matches a target city's grid positions (using `loadGridPoints()` and city name matching)
- Position check: compare `snapshot.bot.position` against city grid positions
- Load check: verify `snapshot.bot.loads.includes(plan.loadType)` for pickup transition

### B.3 Plan Validity and Re-plan Triggers (AIStrategyEngine.ts)

Insert plan resolution before the LLM Decision Point (after Phase 0, before Phase 1):

```
Phase 0: Immediate deliver/pickup (unchanged)
NEW → Plan Resolution:
  1. Get memory.activePlan
  2. If plan exists, validate:
     a. Demand card still in hand (demandCardId in snapshot.bot.demandCards)
     b. Load still available at pickup city (if phase is before pickup)
     c. Bot has enough money (rough estimate: money > 8M or plan doesn't need building)
     d. Not stuck: turnsOnPlan < 15 AND consecutivePassTurns < 3
  3. If valid: PlanExecutor.executePlan() → get move/build choices, skip LLM
  4. If invalid or no plan: consult LLM for plan selection → create new DeliveryPlan
Phase 1: Movement (from plan or LLM)
Phase 1.5: Post-move load actions (unchanged)
Phase 2: Building (from plan or LLM)
```

**Re-plan triggers** (any of these invalidates the current plan):
1. Delivery complete — plan.phase reached 'deliver' and delivery executed
2. Card discarded — plan.demandCardId no longer in snapshot.bot.demandCards
3. Load unavailable — plan.loadType not in loadAvailability[plan.pickupCity] (pre-pickup phases only)
4. Stuck — turnsOnPlan >= 15
5. Repeated passes — consecutivePassTurns >= 3
6. No plan exists — activePlan is null

### B.4 LLM Plan Selection (GameStateSerializer.ts + ResponseParser.ts)

#### New method: `serializePlanSelectionPrompt()`

Shows:
- Current position and carried loads
- Top 5 ranked demand chains (from `OptionGenerator.getRankedChains()`)
- Each chain: pickup city, delivery city, payment, estimated build cost, estimated turns, budget feasibility, shared track count
- Current track network summary
- Asks LLM to pick ONE chain by index and explain reasoning

This is simpler than the current full-options prompt. The LLM picks a strategy (which chain to pursue), not individual move/build indices.

#### New response type: PlanSelectionResponse

```typescript
interface PlanSelectionResponse {
  chainIndex: number;
  reasoning: string;
}
```

#### New parsing in ResponseParser

Add `parsePlanSelection()` method that extracts chainIndex and reasoning from LLM response, with the same JSON + regex fallback pattern as the existing `parse()` method.

### B.5 System Prompt for Plan Selection (systemPrompts.ts)

New `PLAN_SELECTION_SYSTEM_SUFFIX` that replaces the option-picking instructions with chain-picking instructions:

```
RESPONSE FORMAT:
You will see ranked delivery chains. Pick the best one to pursue.
Respond with ONLY a JSON object:
{
  "chainIndex": <integer index of the chain to pursue, 0-based>,
  "reasoning": "<1-2 sentences explaining why this chain>"
}
```

The existing archetype prompts and skill-level modifiers remain unchanged.

### B.6 Scorer Loyalty Amplification (OptionGenerator.ts + Scorer.ts)

#### OptionGenerator.ts

Parameterize `LOYALTY_BONUS_FACTOR`:
- Current: hardcoded `1.5` in `rankDemandChains()`
- New: accept optional `loyaltyFactor` parameter, default 1.5
- When PlanExecutor calls with an active plan, pass 3.0

The `rankDemandChains` method signature becomes:
```typescript
private static rankDemandChains(
  snapshot: WorldSnapshot,
  botMemory?: BotMemoryState,
  loyaltyFactor?: number
): DemandChain[]
```

#### Scorer.ts

No changes needed to Scorer itself. The loyalty amplification works through the `currentBuildTarget` in BotMemoryState, which PlanExecutor sets to the plan's current target city. The existing Scorer already uses `currentBuildTarget` for chain ranking.

### B.7 InitialBuild Phase

No changes during initialBuild:
- No LLM, no plan during initialBuild (gameStatus === 'initialBuild')
- Pure heuristic: `rankDemandChains()` picks best chain, build toward it
- After initialBuild completes, first active turn creates the first plan via LLM

### B.8 Memory Updates in AIStrategyEngine

After Phase 2 execution, update memory with plan-related fields:
- `activePlan`: set to PlanExecutor's updatedPlan (or null if completed/abandoned)
- `turnsOnPlan`: increment if plan continues, reset to 0 on new plan
- `currentBuildTarget`: set to plan's current target city (for Scorer compatibility)
- `planHistory`: append completed/abandoned plans

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/shared/types/GameTypes.ts` | Modify | Add `DeliveryPlan` interface, extend `BotMemoryState` |
| `src/server/services/ai/PlanExecutor.ts` | **Create** | Plan execution — maps plan phase to move/build choices |
| `src/server/services/ai/AIStrategyEngine.ts` | Modify | Plan resolution step, validity checks, re-plan triggers |
| `src/server/services/ai/GameStateSerializer.ts` | Modify | Add `serializePlanSelectionPrompt()` method |
| `src/server/services/ai/ResponseParser.ts` | Modify | Add `parsePlanSelection()` method |
| `src/server/services/ai/BotMemory.ts` | Modify | Update default state for new fields |
| `src/server/services/ai/OptionGenerator.ts` | Modify | Parameterize loyalty factor in `rankDemandChains()` |
| `src/server/services/ai/prompts/systemPrompts.ts` | Modify | Add plan-selection system prompt |
| `src/server/__tests__/ai/PlanExecutor.test.ts` | **Create** | Tests for plan execution and phase transitions |

## Implementation Order

### Wave 1: Data Model (no behavior change)
1. Add `DeliveryPlan` interface and extend `BotMemoryState` in GameTypes.ts
2. Update `BotMemory.ts` default state
3. Add plan selection response parsing to ResponseParser.ts

### Wave 2: Plan Execution Engine
4. Create `PlanExecutor.ts` with phase-based execution logic
5. Add `serializePlanSelectionPrompt()` to GameStateSerializer.ts
6. Add plan-selection system prompt to systemPrompts.ts

### Wave 3: Integration
7. Modify AIStrategyEngine.ts — plan resolution step, validity checks, re-plan triggers
8. Parameterize loyalty factor in OptionGenerator.ts `rankDemandChains()`

### Wave 4: Testing
9. Create PlanExecutor.test.ts
10. Update existing Scorer tests for parameterized loyalty factor
