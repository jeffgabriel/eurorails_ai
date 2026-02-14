/**
 * PlanValidator — Validates a chosen AI plan against game rules before execution.
 *
 * Uses standalone functions with simulated state for cumulative validation.
 * Returns a ValidationResult indicating whether the plan is legal.
 */

import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  TerrainType,
  TrainType,
  TRAIN_PROPERTIES,
} from '../../../shared/types/GameTypes';
import { loadGridPoints } from './MapTopology';

const TURN_BUILD_BUDGET = 20; // ECU 20M max per turn

export interface ValidationResult {
  valid: boolean;
  reason: string;
}

/** Simulated game state used for cumulative validation without DB writes. */
export interface SimulatedState {
  money: number;
  segmentCount: number;
}

/**
 * Validate a chosen option against game rules.
 */
export function validate(option: FeasibleOption, snapshot: WorldSnapshot): ValidationResult {
  switch (option.action) {
    case AIActionType.BuildTrack:
      return validateBuildTrack(option, snapshot);
    case AIActionType.MoveTrain:
      return validateMovement(option, snapshot);
    case AIActionType.PickupLoad:
      return validatePickup(option, snapshot);
    case AIActionType.DeliverLoad:
      return validateDelivery(option, snapshot);
    case AIActionType.PassTurn:
      return { valid: true, reason: 'PassTurn is always valid' };
    default:
      return { valid: true, reason: 'No validation rules for this action' };
  }
}

function validateMovement(option: FeasibleOption, snapshot: WorldSnapshot): ValidationResult {
  // 1. Must have a movement path
  if (!option.movementPath || option.movementPath.length === 0) {
    return { valid: false, reason: 'MoveTrain requires a movement path' };
  }

  // 2. Mileposts must not exceed train speed limit
  const trainType = snapshot.bot.trainType as TrainType;
  const speed = TRAIN_PROPERTIES[trainType]?.speed ?? 9;
  const mileposts = option.mileposts ?? (option.movementPath.length - 1);
  if (mileposts > speed) {
    return {
      valid: false,
      reason: `Movement ${mileposts} mileposts exceeds speed limit of ${speed}`,
    };
  }

  // 3. Bot must have enough money for estimated track usage fees
  const estimatedFee = option.estimatedCost ?? 0;
  if (estimatedFee > 0 && snapshot.bot.money < estimatedFee) {
    return {
      valid: false,
      reason: `Insufficient funds for track usage: need ${estimatedFee}M, have ${snapshot.bot.money}M`,
    };
  }

  // 4. Bot must have a current position
  if (!snapshot.bot.position) {
    return { valid: false, reason: 'Bot has no position to move from' };
  }

  return { valid: true, reason: 'Movement validation passed' };
}

function validateBuildTrack(option: FeasibleOption, snapshot: WorldSnapshot): ValidationResult {
  // 1. Must have segments
  if (!option.segments || option.segments.length === 0) {
    return { valid: false, reason: 'BuildTrack requires segments' };
  }

  const totalCost = option.estimatedCost ?? option.segments.reduce((s, seg) => s + seg.cost, 0);

  // 2. Total cost must not exceed per-turn budget
  if (totalCost > TURN_BUILD_BUDGET) {
    return { valid: false, reason: `Cost ${totalCost}M exceeds ${TURN_BUILD_BUDGET}M turn limit` };
  }

  // 3. Bot must have sufficient money
  if (snapshot.bot.money < totalCost) {
    return {
      valid: false,
      reason: `Insufficient funds: need ${totalCost}M, have ${snapshot.bot.money}M`,
    };
  }

  // 4. First segment must start from a major city if bot has no existing track
  if (snapshot.bot.existingSegments.length === 0) {
    const firstSeg = option.segments[0];
    if (firstSeg.from.terrain !== TerrainType.MajorCity) {
      return {
        valid: false,
        reason: 'First track must start from a major city',
      };
    }
  }

  // 5. Segments must be contiguous (each segment's from must match previous segment's to)
  for (let i = 1; i < option.segments.length; i++) {
    const prev = option.segments[i - 1].to;
    const curr = option.segments[i].from;
    if (prev.row !== curr.row || prev.col !== curr.col) {
      return {
        valid: false,
        reason: `Segment ${i} is not adjacent to segment ${i - 1}`,
      };
    }
  }

  // 6. No segment may overlap another player's track (Right of Way rule)
  const otherEdges = new Set<string>();
  for (const pt of snapshot.allPlayerTracks) {
    if (pt.playerId === snapshot.bot.playerId) continue;
    for (const seg of pt.segments) {
      const a = `${seg.from.row},${seg.from.col}`;
      const b = `${seg.to.row},${seg.to.col}`;
      otherEdges.add(`${a}-${b}`);
      otherEdges.add(`${b}-${a}`);
    }
  }
  for (const seg of option.segments) {
    const fwd = `${seg.from.row},${seg.from.col}-${seg.to.row},${seg.to.col}`;
    if (otherEdges.has(fwd)) {
      return {
        valid: false,
        reason: `Segment (${seg.from.row},${seg.from.col})→(${seg.to.row},${seg.to.col}) is owned by another player`,
      };
    }
  }

  return { valid: true, reason: 'All validations passed' };
}

function validatePickup(option: FeasibleOption, snapshot: WorldSnapshot): ValidationResult {
  // 1. Game must be active
  if (snapshot.gameStatus !== 'active') {
    return { valid: false, reason: 'Game is not active' };
  }

  // 2. Bot must have a position
  if (!snapshot.bot.position) {
    return { valid: false, reason: 'Bot has no position' };
  }

  // 3. Bot must be at a city
  const grid = loadGridPoints();
  const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
  const currentPoint = grid.get(posKey);
  const currentCityName = currentPoint?.name ?? null;
  if (!currentCityName) {
    return { valid: false, reason: 'Bot is not at a city' };
  }

  // 4. Must specify a load type
  if (!option.loadType) {
    return { valid: false, reason: 'PickupLoad requires a loadType' };
  }

  // 5. Load must be available at this city
  const availableLoads = snapshot.loadAvailability[currentCityName] ?? [];
  if (!availableLoads.includes(option.loadType)) {
    return { valid: false, reason: `${option.loadType} is not available at ${currentCityName}` };
  }

  // 6. Train must have capacity
  const trainType = snapshot.bot.trainType as TrainType;
  const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
  if (snapshot.bot.loads.length >= capacity) {
    return { valid: false, reason: 'Train is at full capacity' };
  }

  return { valid: true, reason: 'Pickup validation passed' };
}

function validateDelivery(option: FeasibleOption, snapshot: WorldSnapshot): ValidationResult {
  // 1. Game must be active
  if (snapshot.gameStatus !== 'active') {
    return { valid: false, reason: 'Game is not active' };
  }

  // 2. Bot must have a position
  if (!snapshot.bot.position) {
    return { valid: false, reason: 'Bot has no position' };
  }

  // 3. Bot must be at a city
  const grid = loadGridPoints();
  const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
  const currentPoint = grid.get(posKey);
  const currentCityName = currentPoint?.name ?? null;
  if (!currentCityName) {
    return { valid: false, reason: 'Bot is not at a city' };
  }

  // 4. Must specify a load type and card ID
  if (!option.loadType) {
    return { valid: false, reason: 'DeliverLoad requires a loadType' };
  }
  if (option.cardId == null) {
    return { valid: false, reason: 'DeliverLoad requires a cardId' };
  }

  // 5. Bot must be carrying the load
  if (!snapshot.bot.loads.includes(option.loadType)) {
    return { valid: false, reason: `Bot is not carrying ${option.loadType}` };
  }

  // 6. Card must be in bot's hand
  if (!snapshot.bot.demandCards.includes(option.cardId)) {
    return { valid: false, reason: `Card ${option.cardId} is not in bot's hand` };
  }

  // 7. Demand card must have a matching demand for this city + load
  const resolvedDemand = snapshot.bot.resolvedDemands.find((rd) => rd.cardId === option.cardId);
  if (!resolvedDemand) {
    return { valid: false, reason: `Card ${option.cardId} not found in resolved demands` };
  }
  const matchingDemand = resolvedDemand.demands.find(
    (d) => d.city === currentCityName && d.loadType === option.loadType,
  );
  if (!matchingDemand) {
    return {
      valid: false,
      reason: `Card ${option.cardId} has no demand for ${option.loadType} at ${currentCityName}`,
    };
  }

  return { valid: true, reason: 'Delivery validation passed' };
}
