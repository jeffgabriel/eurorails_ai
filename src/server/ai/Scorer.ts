/**
 * Scorer — evaluates and ranks FeasibleOptions using configurable
 * skill profiles and archetype multipliers.
 *
 * Scoring formula per option:
 *   score = sum( baseWeight[d] * archetypeMultiplier[d] * dimensionValue[d] )
 *   for each ScoringDimension d.
 */

import { TRAIN_PROPERTIES, TrainType } from '../../shared/types/GameTypes';
import { getSkillProfile } from './config/skillProfiles';
import { getArchetypeProfile } from './config/archetypeProfiles';
import {
  AIActionType,
  BotConfig,
  DimensionWeights,
  FeasibleOption,
  ScoredOption,
  ScoringDimension,
  WorldSnapshot,
  DeliverLoadParams,
  PickupAndDeliverParams,
  BuildTrackParams,
  BuildTowardMajorCityParams,
  UpgradeTrainParams,
} from './types';

const ALL_DIMENSIONS: ScoringDimension[] = [
  'immediateIncome',
  'incomePerMilepost',
  'multiDeliveryPotential',
  'networkExpansionValue',
  'victoryProgress',
  'competitorBlocking',
  'riskExposure',
  'loadScarcity',
  'upgradeROI',
  'backboneAlignment',
  'loadCombinationScore',
  'majorCityProximity',
];

// Victory requires 7 major cities and 250M cash
const VICTORY_CITIES = 7;
const VICTORY_CASH = 250;

// Upgrade costs for ROI calculation
const UPGRADE_COST = 20;
const CROSSGRADE_COST = 5;

export class Scorer {
  /**
   * Score and rank feasible options based on skill level and archetype.
   * Returns options sorted descending by score.
   */
  static score(
    options: FeasibleOption[],
    snapshot: WorldSnapshot,
    config: BotConfig,
  ): ScoredOption[] {
    const skillProfile = getSkillProfile(config.skillLevel);
    const archetypeProfile = getArchetypeProfile(config.archetype);

    const finalWeights: DimensionWeights = {} as DimensionWeights;
    for (const dim of ALL_DIMENSIONS) {
      finalWeights[dim] = skillProfile.baseWeights[dim] * archetypeProfile.multipliers[dim];
    }

    const scored: ScoredOption[] = options.map((option) => {
      const dimensionValues = Scorer.evaluateDimensions(option, snapshot);
      let score = 0;
      const contributions: string[] = [];

      for (const dim of ALL_DIMENSIONS) {
        const value = dimensionValues[dim];
        const weight = finalWeights[dim];
        const contrib = weight * value;
        if (contrib > 0.01) {
          contributions.push(`${dim}:${contrib.toFixed(2)}`);
        }
        score += contrib;
      }

      const rationale = contributions.length > 0
        ? contributions.slice(0, 3).join(', ')
        : 'minimal scoring signal';

      return { ...option, score, rationale };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Evaluate all 12 scoring dimensions for a single option.
   * Returns a value between 0 and 1 for each dimension.
   */
  private static evaluateDimensions(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): DimensionWeights {
    const values: DimensionWeights = {
      immediateIncome: 0,
      incomePerMilepost: 0,
      multiDeliveryPotential: 0,
      networkExpansionValue: 0,
      victoryProgress: 0,
      competitorBlocking: 0,
      riskExposure: 0,
      loadScarcity: 0,
      upgradeROI: 0,
      backboneAlignment: 0,
      loadCombinationScore: 0,
      majorCityProximity: 0,
    };

    switch (option.params.type) {
      case AIActionType.DeliverLoad:
        Scorer.evalDeliverLoad(option.params, snapshot, values);
        break;
      case AIActionType.PickupAndDeliver:
        Scorer.evalPickupAndDeliver(option.params, snapshot, values);
        break;
      case AIActionType.BuildTrack:
        Scorer.evalBuildTrack(option.params, snapshot, values);
        break;
      case AIActionType.BuildTowardMajorCity:
        Scorer.evalBuildTowardMajorCity(option.params, snapshot, values);
        break;
      case AIActionType.UpgradeTrain:
        Scorer.evalUpgradeTrain(option.params, snapshot, values);
        break;
      case AIActionType.PassTurn:
        Scorer.evalPassTurn(values);
        break;
    }

    return values;
  }

  // --- Dimension evaluators per action type ---

  private static evalDeliverLoad(
    params: DeliverLoadParams,
    snapshot: WorldSnapshot,
    values: DimensionWeights,
  ): void {
    const card = snapshot.demandCards.find((c) => c.id === params.demandCardId);
    const demand = card?.demands[params.demandIndex];
    const payment = demand?.payment ?? 0;

    // immediateIncome: normalized payment (most deliveries 5-25M)
    values.immediateIncome = clamp(payment / 25);

    // incomePerMilepost: payment relative to movement cost
    const pathLen = Math.max(params.movePath.length - 1, 1);
    values.incomePerMilepost = clamp(payment / (pathLen * 5));

    // multiDeliveryPotential: can we deliver more loads this turn?
    const otherDeliverable = snapshot.carriedLoads.filter(
      (l) => l !== params.loadType,
    ).length;
    values.multiDeliveryPotential = clamp(otherDeliverable / 2);

    // riskExposure: delivering reduces risk (fewer carried loads)
    values.riskExposure = clamp(0.8 - (snapshot.carriedLoads.length - 1) * 0.2);

    // victoryProgress: cash progress toward 250M goal
    const cashAfter = snapshot.money + payment;
    values.victoryProgress = clamp(cashAfter / VICTORY_CASH);

    // loadScarcity: delivering a scarce load is more valuable
    const loadCount = countLoadAvailability(snapshot, params.loadType);
    values.loadScarcity = clamp(1.0 - loadCount / 5);
  }

  private static evalPickupAndDeliver(
    params: PickupAndDeliverParams,
    snapshot: WorldSnapshot,
    values: DimensionWeights,
  ): void {
    const card = snapshot.demandCards.find((c) => c.id === params.demandCardId);
    const demand = card?.demands[params.demandIndex];
    const payment = demand?.payment ?? 0;

    // immediateIncome: lower than direct delivery since pickup-then-deliver takes longer
    values.immediateIncome = clamp(payment / 25 * 0.6);

    // incomePerMilepost: payment relative to estimated total distance
    const pickupLen = Math.max(params.pickupPath.length - 1, 1);
    const totalEstDistance = pickupLen + 5; // estimate delivery distance
    values.incomePerMilepost = clamp(payment / (totalEstDistance * 3));

    // multiDeliveryPotential: less potential since we're picking up a new load
    const capacity = TRAIN_PROPERTIES[snapshot.trainType].capacity;
    const slotsAfter = capacity - snapshot.carriedLoads.length - 1;
    values.multiDeliveryPotential = clamp(slotsAfter / 2);

    // loadCombinationScore: picking up a load matching another demand is good
    const matchingDemands = snapshot.demandCards.reduce((count, c) => {
      return count + c.demands.filter((d) => d.resource === params.pickupLoadType).length;
    }, 0);
    values.loadCombinationScore = clamp(matchingDemands / 3);

    // loadScarcity: scarce loads are worth picking up early
    const loadCount = countLoadAvailability(snapshot, params.pickupLoadType);
    values.loadScarcity = clamp(1.0 - loadCount / 5);

    // riskExposure: more loads = more risk from derailment events
    values.riskExposure = clamp(0.5 - snapshot.carriedLoads.length * 0.15);
  }

  private static evalBuildTrack(
    params: BuildTrackParams,
    snapshot: WorldSnapshot,
    values: DimensionWeights,
  ): void {
    const segCount = params.segments.length;

    // networkExpansionValue: more segments = more expansion
    values.networkExpansionValue = clamp(segCount / 8);

    // backboneAlignment: cost efficiency of the build
    const avgCost = segCount > 0 ? params.totalCost / segCount : 0;
    values.backboneAlignment = clamp(1.0 - avgCost / 5);

    // riskExposure: spending money increases risk if cash is low
    const cashAfter = snapshot.money - params.totalCost;
    values.riskExposure = clamp(cashAfter / 50);

    // victoryProgress: building track is indirect progress
    values.victoryProgress = clamp(snapshot.connectedMajorCities / VICTORY_CITIES * 0.3);
  }

  private static evalBuildTowardMajorCity(
    params: BuildTowardMajorCityParams,
    snapshot: WorldSnapshot,
    values: DimensionWeights,
  ): void {
    const segCount = params.segments.length;

    // networkExpansionValue: high - building toward a major city
    values.networkExpansionValue = clamp(segCount / 8 + 0.2);

    // majorCityProximity: high value - connecting cities is the goal
    values.majorCityProximity = clamp(0.8);

    // victoryProgress: direct progress toward 7-city goal
    const citiesAfterBuild = snapshot.connectedMajorCities + 1;
    values.victoryProgress = clamp(citiesAfterBuild / VICTORY_CITIES);

    // backboneAlignment: building toward major cities aligns with backbone strategy
    values.backboneAlignment = clamp(0.7 + segCount / 20);

    // riskExposure: cash consideration
    const cashAfter = snapshot.money - params.totalCost;
    values.riskExposure = clamp(cashAfter / 50);
  }

  private static evalUpgradeTrain(
    params: UpgradeTrainParams,
    snapshot: WorldSnapshot,
    values: DimensionWeights,
  ): void {
    const targetProps = TRAIN_PROPERTIES[params.targetTrainType];
    const currentProps = TRAIN_PROPERTIES[snapshot.trainType];

    // upgradeROI: value of the upgrade relative to cost
    const speedGain = targetProps.speed - currentProps.speed;
    const capacityGain = targetProps.capacity - currentProps.capacity;
    const totalGain = speedGain / 3 + capacityGain; // normalize speed to ~same scale
    const cost = params.kind === 'crossgrade' ? CROSSGRADE_COST : UPGRADE_COST;
    values.upgradeROI = clamp(totalGain / (cost / 10));

    // multiDeliveryPotential: capacity gains enable multi-delivery
    values.multiDeliveryPotential = clamp(capacityGain > 0 ? 0.8 : 0.2);

    // incomePerMilepost: speed gains mean more income per turn
    values.incomePerMilepost = clamp(speedGain > 0 ? 0.6 : 0.1);

    // riskExposure: spending on upgrades reduces cash buffer
    const cashAfter = snapshot.money - cost;
    values.riskExposure = clamp(cashAfter / 50);
  }

  private static evalPassTurn(values: DimensionWeights): void {
    // PassTurn gets minimal scores - it's the fallback
    values.riskExposure = 0.1; // at least it doesn't spend money
  }
}

// --- Utility functions ---

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function countLoadAvailability(snapshot: WorldSnapshot, loadType: string): number {
  let count = 0;
  for (const [, loads] of snapshot.loadAvailability) {
    count += loads.filter((l) => l === loadType).length;
  }
  return count;
}
