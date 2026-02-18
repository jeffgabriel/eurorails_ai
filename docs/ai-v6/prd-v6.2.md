# PRD v6.2: Plan-Then-Execute AI Bot Architecture

## Goal
Replace the current "consult LLM every turn" approach with a "plan-then-execute" model where the LLM picks a delivery chain once, then the bot executes mechanically until that delivery is complete (or the plan becomes invalid).

## Problem
The current architecture calls LLMStrategyBrain every turn, causing:
- **Vacillation**: LLM changes its mind about where to build/move, wasting track
- **Wasted resources**: Bot builds toward one city, then switches targets next turn
- **No follow-through**: Bot built track to Ruhr but never picked up Steel because the LLM kept reconsidering

Human beginner players play "payload to payload" — pick a delivery, execute it, repeat. The bot should do the same.

## Architecture Changes

### 1. New `DeliveryPlan` Interface (GameTypes.ts)

Add to `BotMemoryState`:

```typescript
export interface DeliveryPlan {
  demandCardId: number;       // Which demand card we're fulfilling
  loadType: string;           // e.g., "Steel"
  pickupCity: string;         // e.g., "Ruhr"
  deliveryCity: string;       // e.g., "Bruxelles"
  payment: number;            // ECU payoff
  phase: 'build_to_pickup' | 'travel_to_pickup' | 'pickup' | 'build_to_delivery' | 'travel_to_delivery' | 'deliver';
  createdAtTurn: number;
  reasoning: string;          // LLM's reasoning for choosing this chain
}
```

Extend `BotMemoryState` with:
- `activePlan: DeliveryPlan | null`
- `turnsOnPlan: number`
- `planHistory: Array<{ plan: DeliveryPlan; outcome: 'delivered' | 'abandoned'; turns: number }>`

### 2. Plan Resolution in AIStrategyEngine (AIStrategyEngine.ts)

Insert a **plan resolution step** before the LLM Decision Point (~line 119):

```
Phase 0: Heuristic load actions (unchanged)
NEW → Plan Check: Does bot have a valid activePlan?
  YES → Skip LLM, execute plan with heuristic Scorer (amplified loyalty)
  NO  → Consult LLM to pick a delivery chain → create new DeliveryPlan
Phase 1: Movement (from plan or LLM selection)
Phase 1.5: Post-move load actions (unchanged)
Phase 2: Building (from plan or LLM selection)
```

**Plan validity checks** (all must pass):
- Demand card still in hand
- Load still available at pickup city (if not yet picked up)
- Bot has enough money to build remaining track (rough estimate)
- Not stuck: `turnsOnPlan < 15` AND `consecutivePassTurns < 3`

### 3. Plan Execution Logic (new: PlanExecutor.ts)

New file `src/server/services/ai/PlanExecutor.ts` with a single class:

```typescript
export class PlanExecutor {
  static executePlan(
    plan: DeliveryPlan,
    snapshot: WorldSnapshot,
    feasibleMoves: FeasibleOption[],
    feasibleBuilds: FeasibleOption[],
    memory: BotMemoryState
  ): { moveChoice: FeasibleOption | null; buildChoice: FeasibleOption | null; updatedPlan: DeliveryPlan }
}
```

Logic by plan phase:
- **build_to_pickup**: Score builds by proximity to pickupCity (use existing Scorer with target override). Transition to `travel_to_pickup` when track reaches pickup city.
- **travel_to_pickup**: Score moves toward pickupCity. Transition to `pickup` when at pickup city.
- **pickup**: Pick up load (Phase 0/1.5 handles this). Transition to `build_to_delivery`.
- **build_to_delivery**: Score builds by proximity to deliveryCity. Transition to `travel_to_delivery` when track reaches delivery city.
- **travel_to_delivery**: Score moves toward deliveryCity. Transition to `deliver` when at delivery city.
- **deliver**: Deliver load (Phase 0/1.5 handles this). Mark plan complete.

This uses the **existing Scorer** with a target city override — no new scoring logic needed. The Scorer's `CHAIN_SCORE_FACTOR` and `LOYALTY_BONUS_FACTOR` already favor the `currentBuildTarget`; we amplify this from 1.5x to 3.0x when executing a plan.

### 4. LLM Prompt for Plan Selection (GameStateSerializer.ts)

New method `serializePlanSelectionPrompt()` that shows:
- Current position and carried loads
- Top 5 ranked demand chains (from `getRankedChains()`)
- Each chain shows: pickup city, delivery city, payment, estimated build cost, estimated turns, budget feasibility, shared track count
- Current track network summary
- Ask LLM to pick ONE chain and explain why

This is simpler than the current full-options prompt — LLM picks a strategy, not individual move/build indices.

### 5. LLM Response for Plans (ResponseParser.ts)

New parsing for plan selection response:
```typescript
interface PlanSelectionResponse {
  chainIndex: number;        // Which ranked chain to pursue
  reasoning: string;         // Why this chain
}
```

### 6. Re-plan Triggers

The bot creates a new plan (consults LLM) when:
1. **Delivery complete** — activePlan delivered successfully
2. **Card discarded** — demand card no longer in hand (event card or discard-hand action)
3. **Load unavailable** — load type no longer available at pickup city
4. **Stuck** — `turnsOnPlan >= 15` (plan is taking too long)
5. **Repeated passes** — `consecutivePassTurns >= 3` (can't make progress)
6. **No plan exists** — first turn or after plan completion

### 7. InitialBuild Phase

**No LLM, no plan** during initialBuild. Use pure heuristic:
- `rankDemandChains()` picks best chain
- Build toward the best chain's pickup city
- After initialBuild completes, first active turn creates the first plan via LLM

### 8. Scorer Loyalty Amplification (Scorer.ts + OptionGenerator.ts)

When executing an active plan:
- `LOYALTY_BONUS_FACTOR`: 1.5x → 3.0x (in `rankDemandChains`)
- `currentBuildTarget` in memory always set to plan's current target city
- This makes the Scorer strongly prefer options aligned with the active plan

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/shared/types/GameTypes.ts` | Modify | Add `DeliveryPlan` interface, extend `BotMemoryState` |
| `src/server/services/ai/PlanExecutor.ts` | **Create** | Plan execution logic — maps plan phase to move/build choices |
| `src/server/services/ai/AIStrategyEngine.ts` | Modify | Add plan resolution step, plan validity checks, re-plan triggers |
| `src/server/services/ai/GameStateSerializer.ts` | Modify | Add `serializePlanSelectionPrompt()` method |
| `src/server/services/ai/ResponseParser.ts` | Modify | Add plan selection response parsing |
| `src/server/services/ai/BotMemory.ts` | Modify | Update default state for new fields |
| `src/server/services/ai/OptionGenerator.ts` | Modify | Amplified loyalty bonus when plan active (parameterize factor) |
| `src/server/services/ai/Scorer.ts` | Modify | Accept loyalty factor parameter instead of hardcoded 1.5x |
| `src/server/services/ai/prompts/systemPrompts.ts` | Modify | New plan-selection system prompt |
| `src/server/__tests__/PlanExecutor.test.ts` | **Create** | Tests for plan execution and phase transitions |

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
8. Parameterize loyalty bonus in OptionGenerator.ts and Scorer.ts (accept factor from caller)

### Wave 4: Testing
9. Create PlanExecutor.test.ts
10. Update existing AIStrategyEngine tests for plan-aware behavior

## Key Design Decisions

- **PlanExecutor is stateless** — takes plan + snapshot, returns choices. State lives in BotMemoryState via BotMemory.
- **Scorer is reused, not replaced** — PlanExecutor uses existing Scorer with target overrides and amplified loyalty.
- **LLM picks chains, not options** — simpler prompt, clearer decision boundary.
- **Phase transitions are deterministic** — based on track connectivity and bot position, not LLM judgment.
- **InitialBuild stays heuristic** — no LLM overhead for the opening build turns.
