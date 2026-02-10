import { ArchetypeProfile, ArchetypeId, DimensionWeights } from '../types';

const NEUTRAL_MULTIPLIERS: DimensionWeights = {
  immediateIncome: 1.0,
  incomePerMilepost: 1.0,
  multiDeliveryPotential: 1.0,
  networkExpansionValue: 1.0,
  victoryProgress: 1.0,
  competitorBlocking: 1.0,
  riskExposure: 1.0,
  loadScarcity: 1.0,
  upgradeROI: 1.0,
  backboneAlignment: 1.0,
  loadCombinationScore: 1.0,
  majorCityProximity: 1.0,
};

/**
 * Backbone Builder: Focuses on building a strong interconnected track network
 * connecting major cities before worrying about deliveries.
 */
const BACKBONE_BUILDER: ArchetypeProfile = {
  id: 'backbone_builder',
  name: 'Backbone Builder',
  description: 'Builds a strong trunk network connecting major cities before focusing on deliveries.',
  multipliers: {
    ...NEUTRAL_MULTIPLIERS,
    networkExpansionValue: 1.5,
    backboneAlignment: 2.0,
    majorCityProximity: 1.5,
    victoryProgress: 1.3,
    immediateIncome: 0.7,
    loadScarcity: 0.8,
  },
};

/**
 * Freight Optimizer: Maximizes income per move by picking the most profitable
 * load combinations and shortest delivery routes.
 */
const FREIGHT_OPTIMIZER: ArchetypeProfile = {
  id: 'freight_optimizer',
  name: 'Freight Optimizer',
  description: 'Maximizes income per milepost by optimizing load combinations and delivery routes.',
  multipliers: {
    ...NEUTRAL_MULTIPLIERS,
    immediateIncome: 1.5,
    incomePerMilepost: 2.0,
    multiDeliveryPotential: 1.5,
    loadCombinationScore: 1.5,
    networkExpansionValue: 0.7,
    victoryProgress: 0.8,
  },
};

/**
 * Trunk Sprinter: Builds fast, direct routes and prioritizes train upgrades
 * for speed. Focuses on quick deliveries over network breadth.
 */
const TRUNK_SPRINTER: ArchetypeProfile = {
  id: 'trunk_sprinter',
  name: 'Trunk Sprinter',
  description: 'Builds direct routes and upgrades trains early for fast, high-value deliveries.',
  multipliers: {
    ...NEUTRAL_MULTIPLIERS,
    upgradeROI: 2.0,
    immediateIncome: 1.3,
    incomePerMilepost: 1.5,
    networkExpansionValue: 0.8,
    backboneAlignment: 0.6,
    competitorBlocking: 0.5,
  },
};

/**
 * Continental Connector: Aggressively connects major cities across the map
 * to reach the 7-city victory condition as quickly as possible.
 */
const CONTINENTAL_CONNECTOR: ArchetypeProfile = {
  id: 'continental_connector',
  name: 'Continental Connector',
  description: 'Races to connect 7 major cities for victory, prioritizing network reach over income.',
  multipliers: {
    ...NEUTRAL_MULTIPLIERS,
    victoryProgress: 2.0,
    networkExpansionValue: 1.5,
    majorCityProximity: 2.0,
    backboneAlignment: 1.3,
    immediateIncome: 0.6,
    loadCombinationScore: 0.7,
    upgradeROI: 0.8,
  },
};

/**
 * Opportunist: Adapts strategy based on current game state. Exploits
 * competitor weaknesses and takes advantage of scarce resources.
 */
const OPPORTUNIST: ArchetypeProfile = {
  id: 'opportunist',
  name: 'Opportunist',
  description: 'Adapts strategy dynamically, exploiting scarce loads and competitor weaknesses.',
  multipliers: {
    ...NEUTRAL_MULTIPLIERS,
    competitorBlocking: 1.5,
    loadScarcity: 1.5,
    riskExposure: 1.3,
    multiDeliveryPotential: 1.3,
    backboneAlignment: 0.7,
    majorCityProximity: 0.8,
  },
};

export const ARCHETYPE_PROFILES: Record<ArchetypeId, ArchetypeProfile> = {
  backbone_builder: BACKBONE_BUILDER,
  freight_optimizer: FREIGHT_OPTIMIZER,
  trunk_sprinter: TRUNK_SPRINTER,
  continental_connector: CONTINENTAL_CONNECTOR,
  opportunist: OPPORTUNIST,
};

export function getArchetypeProfile(id: ArchetypeId): ArchetypeProfile {
  return ARCHETYPE_PROFILES[id];
}

export const ALL_ARCHETYPE_IDS: ArchetypeId[] = Object.keys(ARCHETYPE_PROFILES) as ArchetypeId[];
