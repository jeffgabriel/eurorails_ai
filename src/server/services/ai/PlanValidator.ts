import type { TurnPlan, TurnPlanAction, WorldSnapshot } from '../../../shared/types/AITypes';
import { AIActionType } from '../../../shared/types/AITypes';
import { TrainType, TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import type { LoadType } from '../../../shared/types/LoadTypes';

export interface ValidationResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

const TURN_BUILD_BUDGET = 20;
const UPGRADE_COST = 20;
const CROSSGRADE_COST = 5;

/**
 * Mutable simulation state that tracks cumulative effects
 * of actions within a TurnPlan.
 */
interface SimulatedState {
  cash: number;
  carriedLoads: string[];
  trainType: TrainType;
  trackBuildSpent: number;
  usedDemandCardIds: Set<number>;
  hasUpgraded: boolean;
}

function initSimulatedState(snapshot: WorldSnapshot): SimulatedState {
  return {
    cash: snapshot.cash,
    carriedLoads: [...snapshot.carriedLoads],
    trainType: snapshot.trainType,
    trackBuildSpent: 0,
    usedDemandCardIds: new Set(),
    hasUpgraded: false,
  };
}

function validateDeliverLoad(
  action: TurnPlanAction,
  state: SimulatedState,
  snapshot: WorldSnapshot,
): ValidationResult {
  const loadType = action.parameters.loadType as string;
  const cardId = action.parameters.demandCardId as number;

  // Check load is carried
  const loadIndex = state.carriedLoads.indexOf(loadType);
  if (loadIndex === -1) {
    return { ok: false, reason: `Cannot deliver ${loadType}: not currently carried` };
  }

  // Check demand card hasn't been used already in this plan
  if (state.usedDemandCardIds.has(cardId)) {
    return { ok: false, reason: `Demand card ${cardId} already used in this turn plan` };
  }

  // Check demand card exists in snapshot
  const card = snapshot.demandCards.find(c => c.id === cardId);
  if (!card) {
    return { ok: false, reason: `Demand card ${cardId} not found in player's hand` };
  }

  // Apply effects: remove load, mark card as used, add payment
  state.carriedLoads.splice(loadIndex, 1);
  state.usedDemandCardIds.add(cardId);
  const payment = (action.parameters.payment as number) || 0;
  state.cash += payment;

  return { ok: true, reason: null };
}

function validatePickupAndDeliver(
  action: TurnPlanAction,
  state: SimulatedState,
  snapshot: WorldSnapshot,
): ValidationResult {
  const loadType = action.parameters.loadType as string;

  // Check capacity
  const capacity = TRAIN_PROPERTIES[state.trainType]?.capacity ?? 2;
  if (state.carriedLoads.length >= capacity) {
    return {
      ok: false,
      reason: `Cannot pick up ${loadType}: train at capacity (${state.carriedLoads.length}/${capacity})`,
    };
  }

  // Check load availability
  const loadState = snapshot.globalLoadAvailability.find(s => s.loadType === loadType);
  if (!loadState || loadState.availableCount <= 0) {
    return { ok: false, reason: `Cannot pick up ${loadType}: none available globally` };
  }

  // Apply effects: add load
  state.carriedLoads.push(loadType);

  return { ok: true, reason: null };
}

function validateBuildTrack(
  action: TurnPlanAction,
  state: SimulatedState,
): ValidationResult {
  const estimatedCost = (action.parameters.estimatedCost as number) || 1;

  // Can't build track if upgrade was purchased this turn
  if (state.hasUpgraded) {
    return { ok: false, reason: 'Cannot build track after upgrading train this turn' };
  }

  // Check turn budget
  const remainingBudget = TURN_BUILD_BUDGET - state.trackBuildSpent;
  if (remainingBudget <= 0) {
    return { ok: false, reason: `Track build budget exhausted (spent ${state.trackBuildSpent}M of ${TURN_BUILD_BUDGET}M)` };
  }

  // Check cash (can only spend up to remaining budget or cash, whichever is lower)
  const spendable = Math.min(remainingBudget, state.cash);
  if (spendable < 1) {
    return { ok: false, reason: `Insufficient funds for track building (cash: ${state.cash}M)` };
  }

  // Apply effects: spend on track (capped at budget)
  const actualSpend = Math.min(estimatedCost, spendable);
  state.cash -= actualSpend;
  state.trackBuildSpent += actualSpend;

  return { ok: true, reason: null };
}

function validateUpgradeTrain(
  action: TurnPlanAction,
  state: SimulatedState,
): ValidationResult {
  const targetType = action.parameters.targetTrainType as TrainType;
  const kind = action.parameters.kind as string;

  if (kind === 'upgrade') {
    // Cannot upgrade if track was built this turn
    if (state.trackBuildSpent > 0) {
      return { ok: false, reason: 'Cannot upgrade train after building track this turn' };
    }

    if (state.hasUpgraded) {
      return { ok: false, reason: 'Already upgraded train this turn' };
    }

    // Check funds
    if (state.cash < UPGRADE_COST) {
      return { ok: false, reason: `Insufficient funds for upgrade: ${state.cash}M < ${UPGRADE_COST}M` };
    }

    // Check valid upgrade path
    const validUpgrades: Record<string, string[]> = {
      [TrainType.Freight]: [TrainType.FastFreight, TrainType.HeavyFreight],
      [TrainType.FastFreight]: [TrainType.Superfreight],
      [TrainType.HeavyFreight]: [TrainType.Superfreight],
    };

    const valid = validUpgrades[state.trainType] || [];
    if (!valid.includes(targetType)) {
      return { ok: false, reason: `Invalid upgrade: ${state.trainType} -> ${targetType}` };
    }

    // Check capacity won't drop loads
    const newCapacity = TRAIN_PROPERTIES[targetType]?.capacity ?? 2;
    if (state.carriedLoads.length > newCapacity) {
      return {
        ok: false,
        reason: `Cannot upgrade to ${targetType}: carrying ${state.carriedLoads.length} loads but new capacity is ${newCapacity}`,
      };
    }

    // Apply effects
    state.cash -= UPGRADE_COST;
    state.trainType = targetType;
    state.hasUpgraded = true;
  } else if (kind === 'crossgrade') {
    // Crossgrade: 5M, allowed if track build <= 15M
    if (state.trackBuildSpent > 15) {
      return { ok: false, reason: `Cannot crossgrade after spending ${state.trackBuildSpent}M on track (max 15M)` };
    }

    if (state.cash < CROSSGRADE_COST) {
      return { ok: false, reason: `Insufficient funds for crossgrade: ${state.cash}M < ${CROSSGRADE_COST}M` };
    }

    const validCrossgrades: Record<string, string[]> = {
      [TrainType.FastFreight]: [TrainType.HeavyFreight],
      [TrainType.HeavyFreight]: [TrainType.FastFreight],
    };

    const valid = validCrossgrades[state.trainType] || [];
    if (!valid.includes(targetType)) {
      return { ok: false, reason: `Invalid crossgrade: ${state.trainType} -> ${targetType}` };
    }

    // Check capacity
    const newCapacity = TRAIN_PROPERTIES[targetType]?.capacity ?? 2;
    if (state.carriedLoads.length > newCapacity) {
      return {
        ok: false,
        reason: `Cannot crossgrade to ${targetType}: carrying ${state.carriedLoads.length} loads but new capacity is ${newCapacity}`,
      };
    }

    state.cash -= CROSSGRADE_COST;
    state.trainType = targetType;
  }

  return { ok: true, reason: null };
}

function validateBuildTowardMajorCity(
  action: TurnPlanAction,
  state: SimulatedState,
): ValidationResult {
  // Same budget constraints as BuildTrack
  return validateBuildTrack(action, state);
}

function validatePassTurn(): ValidationResult {
  return { ok: true, reason: null };
}

export class PlanValidator {
  /**
   * Validate a TurnPlan against the snapshot, simulating cumulative state changes.
   * Returns ok:true if all actions are valid in sequence; ok:false with reason otherwise.
   */
  static validate(plan: TurnPlan, snapshot: WorldSnapshot): ValidationResult {
    if (!plan.actions || plan.actions.length === 0) {
      return { ok: true, reason: null };
    }

    const state = initSimulatedState(snapshot);

    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      let result: ValidationResult;

      switch (action.type) {
        case AIActionType.DeliverLoad:
          result = validateDeliverLoad(action, state, snapshot);
          break;
        case AIActionType.PickupAndDeliver:
          result = validatePickupAndDeliver(action, state, snapshot);
          break;
        case AIActionType.BuildTrack:
          result = validateBuildTrack(action, state);
          break;
        case AIActionType.UpgradeTrain:
          result = validateUpgradeTrain(action, state);
          break;
        case AIActionType.BuildTowardMajorCity:
          result = validateBuildTowardMajorCity(action, state);
          break;
        case AIActionType.PassTurn:
          result = validatePassTurn();
          break;
        default:
          result = { ok: false, reason: `Unknown action type: ${(action as any).type}` };
      }

      if (!result.ok) {
        return {
          ok: false,
          reason: `Action ${i + 1} (${action.type}) failed: ${result.reason}`,
        };
      }
    }

    return { ok: true, reason: null };
  }
}
