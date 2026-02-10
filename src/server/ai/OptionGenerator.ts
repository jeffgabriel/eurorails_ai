/**
 * OptionGenerator — produces all candidate bot actions (feasible and infeasible)
 * for a given WorldSnapshot.  Used by the AI pipeline to enumerate what the bot
 * could do this turn before scoring and plan selection.
 */

import { TrainType, TRAIN_PROPERTIES, TrackSegment, TerrainType } from '../../shared/types/GameTypes';
import type { GridPoint, Point } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';
import {
  computeReachableCities,
  computeBuildSegments,
  validateDeliveryFeasibility,
  validatePickupFeasibility,
  validateBuildTrackFeasibility,
  validateUpgradeFeasibility,
  VALID_UPGRADES,
  MAX_BUILD_PER_TURN,
} from './validationService';
import type { ReachableCity } from './validationService';
import {
  AIActionType,
  FeasibleOption,
  InfeasibleOption,
  WorldSnapshot,
} from './types';

// --- Result type ---

export interface GenerationResult {
  feasible: FeasibleOption[];
  infeasible: InfeasibleOption[];
}

// --- Helpers ---

function makeFeasible(
  type: AIActionType,
  description: string,
  params: FeasibleOption['params'],
): FeasibleOption {
  return { type, description, feasible: true, params };
}

function makeInfeasible(
  type: AIActionType,
  description: string,
  reason: string,
): InfeasibleOption {
  return { type, description, feasible: false, reason };
}

function nodeKey(n: { row: number; col: number }): string {
  return `${n.row},${n.col}`;
}

// --- Main generator ---

export class OptionGenerator {
  /**
   * Generate all candidate options for the bot's current turn.
   * Returns both feasible and infeasible options (infeasible tagged with reasons for audit).
   */
  static generate(snapshot: WorldSnapshot): GenerationResult {
    const feasible: FeasibleOption[] = [];
    const infeasible: InfeasibleOption[] = [];

    // Pre-compute reachable cities for movement-based options
    const reachableCities = snapshot.position
      ? computeReachableCities(snapshot, snapshot.remainingMovement)
      : [];

    // Generate all option types
    OptionGenerator.generateDeliveryOptions(snapshot, reachableCities, feasible, infeasible);
    OptionGenerator.generatePickupAndDeliverOptions(snapshot, reachableCities, feasible, infeasible);
    OptionGenerator.generateBuildTrackOptions(snapshot, feasible, infeasible);
    OptionGenerator.generateBuildTowardMajorCityOptions(snapshot, feasible, infeasible);
    OptionGenerator.generateUpgradeTrainOptions(snapshot, feasible, infeasible);
    OptionGenerator.generatePassTurnOption(feasible);

    return { feasible, infeasible };
  }

  // --- Delivery Options ---

  private static generateDeliveryOptions(
    snapshot: WorldSnapshot,
    reachableCities: ReachableCity[],
    feasible: FeasibleOption[],
    infeasible: InfeasibleOption[],
  ): void {
    // Early exit: no loads or no demand cards means no deliveries
    if (snapshot.carriedLoads.length === 0 || snapshot.demandCards.length === 0) return;

    for (const card of snapshot.demandCards) {
      for (let dIdx = 0; dIdx < card.demands.length; dIdx++) {
        const demand = card.demands[dIdx];
        const description = `Deliver ${demand.resource} to ${demand.city} for ${demand.payment}M`;

        const result = validateDeliveryFeasibility(snapshot, card.id, dIdx);
        if (result.feasible) {
          // Find the reachable city point for the move path
          const cityPoint = reachableCities.find((c) => c.cityName === demand.city);
          const movePath: Point[] = cityPoint
            ? [snapshot.position!, { x: 0, y: 0, row: cityPoint.row, col: cityPoint.col }]
            : [snapshot.position!];

          feasible.push(makeFeasible(AIActionType.DeliverLoad, description, {
            type: AIActionType.DeliverLoad,
            movePath,
            demandCardId: card.id,
            demandIndex: dIdx,
            loadType: demand.resource,
            city: demand.city,
          }));
        } else {
          infeasible.push(makeInfeasible(AIActionType.DeliverLoad, description, result.reason!));
        }
      }
    }
  }

  // --- Pickup and Deliver Options ---

  private static generatePickupAndDeliverOptions(
    snapshot: WorldSnapshot,
    reachableCities: ReachableCity[],
    feasible: FeasibleOption[],
    infeasible: InfeasibleOption[],
  ): void {
    if (!snapshot.position) return;

    const capacity = TRAIN_PROPERTIES[snapshot.trainType].capacity;
    if (snapshot.carriedLoads.length >= capacity) return;

    // For each demand card demand, check if the required load can be picked up
    for (const card of snapshot.demandCards) {
      for (let dIdx = 0; dIdx < card.demands.length; dIdx++) {
        const demand = card.demands[dIdx];

        // Skip if already carrying this load (delivery option will handle it)
        if (snapshot.carriedLoads.includes(demand.resource)) continue;

        // Find cities where this load is available
        const pickupCities: string[] = [];
        for (const [city, loads] of snapshot.loadAvailability) {
          if (loads.includes(demand.resource)) {
            pickupCities.push(city);
          }
        }
        // Also check dropped loads
        for (const [city, loads] of snapshot.droppedLoads) {
          if (loads.includes(demand.resource) && !pickupCities.includes(city)) {
            pickupCities.push(city);
          }
        }

        for (const pickupCity of pickupCities) {
          const description = `Pick up ${demand.resource} at ${pickupCity}, deliver to ${demand.city} for ${demand.payment}M`;

          const pickupResult = validatePickupFeasibility(snapshot, demand.resource, pickupCity);
          if (!pickupResult.feasible) {
            infeasible.push(makeInfeasible(AIActionType.PickupAndDeliver, description, pickupResult.reason!));
            continue;
          }

          // For the pickup path, find the reachable city
          const pickupCityPoint = reachableCities.find((c) => c.cityName === pickupCity);
          const pickupPath: Point[] = pickupCityPoint
            ? [snapshot.position!, { x: 0, y: 0, row: pickupCityPoint.row, col: pickupCityPoint.col }]
            : [snapshot.position!];

          feasible.push(makeFeasible(AIActionType.PickupAndDeliver, description, {
            type: AIActionType.PickupAndDeliver,
            pickupPath,
            pickupCity,
            pickupLoadType: demand.resource,
            deliverPath: [],  // Delivery path computed in later turns
            deliverCity: demand.city,
            demandCardId: card.id,
            demandIndex: dIdx,
          }));
        }
      }
    }
  }

  // --- Build Track Options ---

  private static generateBuildTrackOptions(
    snapshot: WorldSnapshot,
    feasible: FeasibleOption[],
    infeasible: InfeasibleOption[],
  ): void {
    const remainingBudget = MAX_BUILD_PER_TURN - snapshot.turnBuildCostSoFar;
    if (remainingBudget <= 0 || snapshot.money <= 0) return;

    const budget = Math.min(remainingBudget, snapshot.money);

    // Build toward demand card cities that are not yet reachable
    for (const card of snapshot.demandCards) {
      for (const demand of card.demands) {
        // Find the grid point for this demand city
        const cityPoint = snapshot.mapPoints.find(
          (p) => p.city?.name === demand.city && p.terrain === TerrainType.MajorCity,
        ) ?? snapshot.mapPoints.find(
          (p) => p.city?.name === demand.city,
        );

        if (!cityPoint) continue;

        const segments = computeBuildSegments(snapshot, cityPoint.row, cityPoint.col, budget);
        if (segments.length === 0) continue;

        const totalCost = segments.reduce((sum, seg) => sum + seg.cost, 0);
        const description = `Build track toward ${demand.city} (${totalCost}M, ${segments.length} segments)`;

        const buildResult = validateBuildTrackFeasibility(snapshot, segments);
        if (buildResult.feasible) {
          feasible.push(makeFeasible(AIActionType.BuildTrack, description, {
            type: AIActionType.BuildTrack,
            segments,
            totalCost,
          }));
        } else {
          infeasible.push(makeInfeasible(AIActionType.BuildTrack, description, buildResult.reason!));
        }
      }
    }
  }

  // --- Build Toward Major City Options ---

  private static generateBuildTowardMajorCityOptions(
    snapshot: WorldSnapshot,
    feasible: FeasibleOption[],
    infeasible: InfeasibleOption[],
  ): void {
    const remainingBudget = MAX_BUILD_PER_TURN - snapshot.turnBuildCostSoFar;
    if (remainingBudget <= 0 || snapshot.money <= 0) return;

    const budget = Math.min(remainingBudget, snapshot.money);
    const majorCityGroups = getMajorCityGroups();

    // Build set of already-connected major city names
    const networkNodes = new Set<string>();
    for (const seg of snapshot.trackSegments) {
      networkNodes.add(nodeKey(seg.from));
      networkNodes.add(nodeKey(seg.to));
    }

    for (const city of majorCityGroups) {
      // Check if already connected (center or any outpost in network)
      const allPoints = [city.center, ...city.outposts];
      const isConnected = allPoints.some((p) => networkNodes.has(nodeKey(p)));
      if (isConnected) continue;

      // Try building toward the center milepost
      const segments = computeBuildSegments(snapshot, city.center.row, city.center.col, budget);
      if (segments.length === 0) continue;

      const totalCost = segments.reduce((sum, seg) => sum + seg.cost, 0);
      const description = `Build toward ${city.cityName} (${totalCost}M, ${segments.length} segments)`;

      const buildResult = validateBuildTrackFeasibility(snapshot, segments);
      if (buildResult.feasible) {
        feasible.push(makeFeasible(AIActionType.BuildTowardMajorCity, description, {
          type: AIActionType.BuildTowardMajorCity,
          targetCity: city.cityName,
          segments,
          totalCost,
        }));
      } else {
        infeasible.push(makeInfeasible(AIActionType.BuildTowardMajorCity, description, buildResult.reason!));
      }
    }
  }

  // --- Upgrade Train Options ---

  private static generateUpgradeTrainOptions(
    snapshot: WorldSnapshot,
    feasible: FeasibleOption[],
    infeasible: InfeasibleOption[],
  ): void {
    const upgrades = VALID_UPGRADES[snapshot.trainType];
    if (!upgrades || upgrades.length === 0) return;

    for (const upgrade of upgrades) {
      const description = `${upgrade.kind === 'upgrade' ? 'Upgrade' : 'Crossgrade'} to ${upgrade.targetTrainType} (${upgrade.cost}M)`;

      const result = validateUpgradeFeasibility(snapshot, upgrade.targetTrainType);
      if (result.feasible) {
        feasible.push(makeFeasible(AIActionType.UpgradeTrain, description, {
          type: AIActionType.UpgradeTrain,
          targetTrainType: upgrade.targetTrainType,
          kind: upgrade.kind,
          cost: upgrade.cost,
        }));
      } else {
        infeasible.push(makeInfeasible(AIActionType.UpgradeTrain, description, result.reason!));
      }
    }
  }

  // --- Pass Turn ---

  private static generatePassTurnOption(
    feasible: FeasibleOption[],
  ): void {
    feasible.push(makeFeasible(AIActionType.PassTurn, 'Pass turn - no action taken', {
      type: AIActionType.PassTurn,
    }));
  }
}
