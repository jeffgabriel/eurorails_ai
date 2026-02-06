import type { AIArchetype } from '../../../../shared/types/AITypes';

/**
 * Archetype multipliers applied on top of skill-level base weights.
 * Final score = sum(base_weight[skill] * archetype_multiplier * dimension_value).
 */
export interface ArchetypeProfile {
  readonly archetype: AIArchetype;
  readonly multipliers: ArchetypeMultipliers;
}

export interface ArchetypeMultipliers {
  // Base scoring dimensions (multiplied against skill weights)
  readonly immediateIncome: number;
  readonly incomePerMilepost: number;
  readonly multiDeliveryPotential: number;
  readonly networkExpansionValue: number;
  readonly victoryProgress: number;
  readonly competitorBlocking: number;
  readonly riskEventExposure: number;
  readonly loadScarcity: number;
  // Archetype-specific dimensions
  readonly upgradeRoi: number;
  readonly backboneAlignment: number;
  readonly loadCombinationScore: number;
  readonly majorCityProximity: number;
}

const BACKBONE_BUILDER: ArchetypeProfile = {
  archetype: 'backbone_builder',
  multipliers: {
    immediateIncome: 0.8,
    incomePerMilepost: 1.0,
    multiDeliveryPotential: 1.2,
    networkExpansionValue: 1.5,
    victoryProgress: 1.2,
    competitorBlocking: 0.8,
    riskEventExposure: 1.0,
    loadScarcity: 0.7,
    upgradeRoi: 1.2,
    backboneAlignment: 2.0,
    loadCombinationScore: 0.8,
    majorCityProximity: 1.0,
  },
};

const FREIGHT_OPTIMIZER: ArchetypeProfile = {
  archetype: 'freight_optimizer',
  multipliers: {
    immediateIncome: 1.0,
    incomePerMilepost: 1.5,
    multiDeliveryPotential: 1.5,
    networkExpansionValue: 0.7,
    victoryProgress: 0.6,
    competitorBlocking: 0.8,
    riskEventExposure: 1.0,
    loadScarcity: 1.2,
    upgradeRoi: 0.8,
    backboneAlignment: 0.5,
    loadCombinationScore: 2.0,
    majorCityProximity: 0.5,
  },
};

const TRUNK_SPRINTER: ArchetypeProfile = {
  archetype: 'trunk_sprinter',
  multipliers: {
    immediateIncome: 0.9,
    incomePerMilepost: 0.8,
    multiDeliveryPotential: 0.8,
    networkExpansionValue: 1.0,
    victoryProgress: 0.8,
    competitorBlocking: 0.5,
    riskEventExposure: 0.7,
    loadScarcity: 0.8,
    upgradeRoi: 1.8,
    backboneAlignment: 1.0,
    loadCombinationScore: 0.6,
    majorCityProximity: 0.7,
  },
};

const CONTINENTAL_CONNECTOR: ArchetypeProfile = {
  archetype: 'continental_connector',
  multipliers: {
    immediateIncome: 0.7,
    incomePerMilepost: 0.8,
    multiDeliveryPotential: 1.0,
    networkExpansionValue: 1.5,
    victoryProgress: 2.0,
    competitorBlocking: 0.5,
    riskEventExposure: 1.0,
    loadScarcity: 0.5,
    upgradeRoi: 0.9,
    backboneAlignment: 0.8,
    loadCombinationScore: 0.7,
    majorCityProximity: 2.0,
  },
};

const OPPORTUNIST: ArchetypeProfile = {
  archetype: 'opportunist',
  multipliers: {
    immediateIncome: 1.3,
    incomePerMilepost: 1.2,
    multiDeliveryPotential: 0.6,
    networkExpansionValue: 0.5,
    victoryProgress: 0.7,
    competitorBlocking: 1.3,
    riskEventExposure: 1.2,
    loadScarcity: 1.5,
    upgradeRoi: 0.7,
    backboneAlignment: 0.3,
    loadCombinationScore: 1.0,
    majorCityProximity: 0.5,
  },
};

export const ARCHETYPE_PROFILES: Record<AIArchetype, ArchetypeProfile> = {
  backbone_builder: BACKBONE_BUILDER,
  freight_optimizer: FREIGHT_OPTIMIZER,
  trunk_sprinter: TRUNK_SPRINTER,
  continental_connector: CONTINENTAL_CONNECTOR,
  opportunist: OPPORTUNIST,
};

export function getArchetypeProfile(archetype: AIArchetype): ArchetypeProfile {
  return ARCHETYPE_PROFILES[archetype];
}
