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
} from '../../../shared/types/GameTypes';

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
    case AIActionType.PassTurn:
      return { valid: true, reason: 'PassTurn is always valid' };
    default:
      return { valid: true, reason: 'No validation rules for this action' };
  }
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

  return { valid: true, reason: 'All validations passed' };
}
