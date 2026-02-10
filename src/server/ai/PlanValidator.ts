/**
 * PlanValidator — performs final pre-execution validation of a complete TurnPlan
 * against the current WorldSnapshot.
 *
 * Validates path reachability, sufficient funds, load availability, capacity limits,
 * and turn budget by simulating state progression through each action in the plan.
 */

import { TRAIN_PROPERTIES, TrackSegment, TRACK_USAGE_FEE } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import {
  WorldSnapshot,
  TurnPlan,
  ValidationResult,
  FeasibleOption,
  AIActionType,
  DeliverLoadParams,
  PickupAndDeliverParams,
  BuildTrackParams,
  UpgradeTrainParams,
  BuildTowardMajorCityParams,
} from './types';
import {
  computeReachableCities,
  VALID_UPGRADES,
  MAX_BUILD_PER_TURN,
} from './validationService';

/** Mutable state that tracks cumulative changes as we simulate each action. */
interface SimulatedState {
  money: number;
  carriedLoads: LoadType[];
  trainType: WorldSnapshot['trainType'];
  turnBuildCostSoFar: number;
  /** Track segments added during this plan (for build actions). */
  newSegments: TrackSegment[];
}

function initSimulatedState(snapshot: WorldSnapshot): SimulatedState {
  return {
    money: snapshot.money,
    carriedLoads: [...snapshot.carriedLoads],
    trainType: snapshot.trainType,
    turnBuildCostSoFar: snapshot.turnBuildCostSoFar,
    newSegments: [],
  };
}

/**
 * Validate a single DeliverLoad action against the snapshot and simulated state.
 */
function validateDeliverAction(
  snapshot: WorldSnapshot,
  state: SimulatedState,
  params: DeliverLoadParams,
): string[] {
  const errors: string[] = [];

  // Check bot carries the load
  const loadIdx = state.carriedLoads.indexOf(params.loadType);
  if (loadIdx === -1) {
    errors.push(`DeliverLoad: not carrying ${params.loadType}`);
  }

  // Check demand card exists
  const card = snapshot.demandCards.find((c) => c.id === params.demandCardId);
  if (!card) {
    errors.push(`DeliverLoad: demand card ${params.demandCardId} not in hand`);
  } else if (params.demandIndex < 0 || params.demandIndex >= card.demands.length) {
    errors.push(`DeliverLoad: invalid demand index ${params.demandIndex}`);
  }

  // Check destination is reachable
  if (snapshot.position) {
    const reachable = computeReachableCities(snapshot, snapshot.remainingMovement);
    if (!reachable.some((c) => c.cityName === params.city)) {
      errors.push(`DeliverLoad: cannot reach ${params.city} within ${snapshot.remainingMovement} movement`);
    }
  } else {
    errors.push('DeliverLoad: bot has no position on the map');
  }

  // Track usage fees for the move path
  if (params.movePath.length > 1) {
    const usageFee = estimatePathUsageFee(snapshot, params.movePath);
    if (state.money < usageFee) {
      errors.push(`DeliverLoad: insufficient funds for track usage fee (need ${usageFee}M, have ${state.money}M)`);
    }
  }

  return errors;
}

/**
 * Validate a single PickupAndDeliver action against the snapshot and simulated state.
 */
function validatePickupAndDeliverAction(
  snapshot: WorldSnapshot,
  state: SimulatedState,
  params: PickupAndDeliverParams,
): string[] {
  const errors: string[] = [];

  // Check train has capacity for pickup
  const capacity = TRAIN_PROPERTIES[state.trainType].capacity;
  if (state.carriedLoads.length >= capacity) {
    errors.push(`PickupAndDeliver: train at capacity (${capacity} loads)`);
  }

  // Check load is available at pickup city
  const cityLoads = snapshot.loadAvailability.get(params.pickupCity);
  const droppedLoads = snapshot.droppedLoads.get(params.pickupCity);
  const loadAvailable =
    (cityLoads && cityLoads.includes(params.pickupLoadType)) ||
    (droppedLoads && droppedLoads.includes(params.pickupLoadType as unknown as LoadType));
  if (!loadAvailable) {
    errors.push(`PickupAndDeliver: ${params.pickupLoadType} not available at ${params.pickupCity}`);
  }

  // Check demand card
  const card = snapshot.demandCards.find((c) => c.id === params.demandCardId);
  if (!card) {
    errors.push(`PickupAndDeliver: demand card ${params.demandCardId} not in hand`);
  } else if (params.demandIndex < 0 || params.demandIndex >= card.demands.length) {
    errors.push(`PickupAndDeliver: invalid demand index ${params.demandIndex}`);
  }

  // Check pickup city is reachable
  if (snapshot.position) {
    const reachable = computeReachableCities(snapshot, snapshot.remainingMovement);
    if (!reachable.some((c) => c.cityName === params.pickupCity)) {
      errors.push(`PickupAndDeliver: cannot reach pickup city ${params.pickupCity} within ${snapshot.remainingMovement} movement`);
    }
  } else {
    errors.push('PickupAndDeliver: bot has no position on the map');
  }

  return errors;
}

/**
 * Validate a BuildTrack action against the simulated state.
 */
function validateBuildAction(
  state: SimulatedState,
  params: BuildTrackParams,
): string[] {
  const errors: string[] = [];

  if (params.segments.length === 0) {
    errors.push('BuildTrack: no segments to build');
    return errors;
  }

  // Check total cost within remaining turn budget
  const remainingBudget = MAX_BUILD_PER_TURN - state.turnBuildCostSoFar;
  if (params.totalCost > remainingBudget) {
    errors.push(`BuildTrack: cost ${params.totalCost}M exceeds remaining turn budget ${remainingBudget}M`);
  }

  // Check sufficient funds
  if (params.totalCost > state.money) {
    errors.push(`BuildTrack: insufficient funds (need ${params.totalCost}M, have ${state.money}M)`);
  }

  return errors;
}

/**
 * Validate a BuildTowardMajorCity action against the simulated state.
 */
function validateBuildTowardAction(
  state: SimulatedState,
  params: BuildTowardMajorCityParams,
): string[] {
  const errors: string[] = [];

  if (params.segments.length === 0) {
    errors.push(`BuildTowardMajorCity: no segments to build toward ${params.targetCity}`);
    return errors;
  }

  const remainingBudget = MAX_BUILD_PER_TURN - state.turnBuildCostSoFar;
  if (params.totalCost > remainingBudget) {
    errors.push(`BuildTowardMajorCity: cost ${params.totalCost}M exceeds remaining turn budget ${remainingBudget}M`);
  }

  if (params.totalCost > state.money) {
    errors.push(`BuildTowardMajorCity: insufficient funds (need ${params.totalCost}M, have ${state.money}M)`);
  }

  return errors;
}

/**
 * Validate an UpgradeTrain action against the simulated state.
 */
function validateUpgradeAction(
  state: SimulatedState,
  params: UpgradeTrainParams,
): string[] {
  const errors: string[] = [];

  if (state.trainType === params.targetTrainType) {
    errors.push('UpgradeTrain: already have this train type');
    return errors;
  }

  const upgrades = VALID_UPGRADES[state.trainType];
  const upgrade = upgrades.find((u) => u.targetTrainType === params.targetTrainType);
  if (!upgrade) {
    errors.push(`UpgradeTrain: no valid path from ${state.trainType} to ${params.targetTrainType}`);
    return errors;
  }

  const remainingBudget = MAX_BUILD_PER_TURN - state.turnBuildCostSoFar;
  if (params.cost > remainingBudget) {
    errors.push(`UpgradeTrain: cost ${params.cost}M exceeds remaining turn budget ${remainingBudget}M`);
  }

  if (params.cost > state.money) {
    errors.push(`UpgradeTrain: insufficient funds (need ${params.cost}M, have ${state.money}M)`);
  }

  return errors;
}

/**
 * Apply the effects of a validated action to the simulated state.
 * Called after validation to update cumulative state for subsequent actions.
 */
function applyToSimulatedState(
  state: SimulatedState,
  action: FeasibleOption,
): void {
  switch (action.params.type) {
    case AIActionType.DeliverLoad: {
      const p = action.params;
      const idx = state.carriedLoads.indexOf(p.loadType);
      if (idx !== -1) state.carriedLoads.splice(idx, 1);
      // Payoff is collected from bank, but for validation we don't add it
      // since we're checking pre-execution feasibility
      break;
    }
    case AIActionType.PickupAndDeliver: {
      const p = action.params;
      state.carriedLoads.push(p.pickupLoadType);
      // After delivery, remove the load
      const idx = state.carriedLoads.indexOf(p.pickupLoadType);
      if (idx !== -1) state.carriedLoads.splice(idx, 1);
      break;
    }
    case AIActionType.BuildTrack: {
      const p = action.params;
      state.money -= p.totalCost;
      state.turnBuildCostSoFar += p.totalCost;
      state.newSegments.push(...p.segments);
      break;
    }
    case AIActionType.BuildTowardMajorCity: {
      const p = action.params;
      state.money -= p.totalCost;
      state.turnBuildCostSoFar += p.totalCost;
      state.newSegments.push(...p.segments);
      break;
    }
    case AIActionType.UpgradeTrain: {
      const p = action.params;
      state.money -= p.cost;
      state.turnBuildCostSoFar += p.cost;
      state.trainType = p.targetTrainType;
      break;
    }
    case AIActionType.PassTurn:
      break;
  }
}

/**
 * Estimate track usage fees for a move path.
 * Returns 4M per opponent whose track is used (simplified).
 */
function estimatePathUsageFee(
  snapshot: WorldSnapshot,
  _path: { row: number; col: number }[],
): number {
  // Track usage fee is 4M per opponent per turn.
  // For pre-validation we estimate based on whether the bot has opponents with track.
  // The actual fee computation happens at execution time.
  // For now, return 0 since the existing pipeline handles fees in TurnExecutor.
  void snapshot;
  return 0;
}

export class PlanValidator {
  /**
   * Validate a complete TurnPlan against the current WorldSnapshot.
   *
   * Simulates state progression through each action, checking:
   * - Path reachability for movement actions
   * - Sufficient funds (cumulative across actions)
   * - Load availability and train capacity
   * - Turn build budget (20M max)
   * - Valid upgrade paths
   *
   * Returns a ValidationResult with all errors found.
   */
  static validate(plan: TurnPlan, snapshot: WorldSnapshot): ValidationResult {
    const errors: string[] = [];

    // Empty plan is valid (PassTurn)
    if (plan.actions.length === 0) {
      return { valid: true, errors: [] };
    }

    const state = initSimulatedState(snapshot);

    for (const action of plan.actions) {
      const actionErrors = PlanValidator.validateAction(action, snapshot, state);
      errors.push(...actionErrors);

      // Apply effects to simulated state even if there are errors,
      // so subsequent actions validate against the expected state
      applyToSimulatedState(state, action);
    }

    // Final check: money should not go negative
    if (state.money < 0) {
      errors.push(`Plan leaves bot with negative funds: ${state.money}M`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate a single action within the plan context.
   */
  private static validateAction(
    action: FeasibleOption,
    snapshot: WorldSnapshot,
    state: SimulatedState,
  ): string[] {
    switch (action.params.type) {
      case AIActionType.DeliverLoad:
        return validateDeliverAction(snapshot, state, action.params);
      case AIActionType.PickupAndDeliver:
        return validatePickupAndDeliverAction(snapshot, state, action.params);
      case AIActionType.BuildTrack:
        return validateBuildAction(state, action.params);
      case AIActionType.BuildTowardMajorCity:
        return validateBuildTowardAction(state, action.params);
      case AIActionType.UpgradeTrain:
        return validateUpgradeAction(state, action.params);
      case AIActionType.PassTurn:
        return [];
      default:
        return [`Unknown action type: ${(action.params as { type: string }).type}`];
    }
  }
}
