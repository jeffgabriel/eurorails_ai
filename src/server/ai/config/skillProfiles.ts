import { SkillProfile, SkillLevel, DimensionWeights } from '../types';

const BALANCED_WEIGHTS: DimensionWeights = {
  immediateIncome: 0.8,
  incomePerMilepost: 0.7,
  multiDeliveryPotential: 0.6,
  networkExpansionValue: 0.7,
  victoryProgress: 0.5,
  competitorBlocking: 0.3,
  riskExposure: 0.4,
  loadScarcity: 0.5,
  upgradeROI: 0.6,
  backboneAlignment: 0.5,
  loadCombinationScore: 0.6,
  majorCityProximity: 0.5,
};

/**
 * Easy: Prioritizes immediate income, ignores strategic dimensions.
 * 20% random choices, 30% suboptimality, no lookahead.
 */
const EASY_PROFILE: SkillProfile = {
  level: 'easy',
  baseWeights: {
    ...BALANCED_WEIGHTS,
    immediateIncome: 1.0,
    incomePerMilepost: 0.3,
    multiDeliveryPotential: 0.2,
    networkExpansionValue: 0.3,
    victoryProgress: 0.1,
    competitorBlocking: 0.0,
    riskExposure: 0.1,
    loadScarcity: 0.2,
    upgradeROI: 0.3,
    backboneAlignment: 0.1,
    loadCombinationScore: 0.2,
    majorCityProximity: 0.3,
  },
  randomChoicePercent: 20,
  suboptimalityPercent: 30,
  lookaheadDepth: 0,
  lookaheadBreadth: 1,
  lookaheadDiscount: 0.7,
};

/**
 * Medium: Balanced weights with moderate strategic awareness.
 * 5% random choices, 10% suboptimality, 2-turn lookahead.
 */
const MEDIUM_PROFILE: SkillProfile = {
  level: 'medium',
  baseWeights: {
    ...BALANCED_WEIGHTS,
  },
  randomChoicePercent: 5,
  suboptimalityPercent: 10,
  lookaheadDepth: 2,
  lookaheadBreadth: 3,
  lookaheadDiscount: 0.7,
};

/**
 * Hard: High weights on strategic dimensions. No randomness or suboptimality.
 * 4-turn lookahead with broad evaluation.
 */
const HARD_PROFILE: SkillProfile = {
  level: 'hard',
  baseWeights: {
    immediateIncome: 0.9,
    incomePerMilepost: 0.9,
    multiDeliveryPotential: 0.8,
    networkExpansionValue: 0.9,
    victoryProgress: 0.8,
    competitorBlocking: 0.6,
    riskExposure: 0.7,
    loadScarcity: 0.7,
    upgradeROI: 0.8,
    backboneAlignment: 0.7,
    loadCombinationScore: 0.8,
    majorCityProximity: 0.7,
  },
  randomChoicePercent: 0,
  suboptimalityPercent: 0,
  lookaheadDepth: 4,
  lookaheadBreadth: 3,
  lookaheadDiscount: 0.7,
};

export const SKILL_PROFILES: Record<SkillLevel, SkillProfile> = {
  easy: EASY_PROFILE,
  medium: MEDIUM_PROFILE,
  hard: HARD_PROFILE,
};

export function getSkillProfile(level: SkillLevel): SkillProfile {
  return SKILL_PROFILES[level];
}
