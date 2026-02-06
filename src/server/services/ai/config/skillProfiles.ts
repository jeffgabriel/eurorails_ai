import type { AIDifficulty } from '../../../../shared/types/AITypes';

/** Base scoring dimension weights per skill level. */
export interface SkillProfile {
  readonly difficulty: AIDifficulty;
  readonly weights: ScoringWeights;
  readonly behavior: SkillBehavior;
}

export interface ScoringWeights {
  readonly immediateIncome: number;
  readonly incomePerMilepost: number;
  readonly multiDeliveryPotential: number;
  readonly networkExpansionValue: number;
  readonly victoryProgress: number;
  readonly competitorBlocking: number;
  readonly riskEventExposure: number;
  readonly loadScarcity: number;
}

export interface SkillBehavior {
  readonly planningHorizonTurns: number;
  readonly randomChoiceProbability: number;
  readonly missedOptionProbability: number;
}

const EASY_PROFILE: SkillProfile = {
  difficulty: 'easy',
  weights: {
    immediateIncome: 0.8,
    incomePerMilepost: 0.2,
    multiDeliveryPotential: 0,
    networkExpansionValue: 0,
    victoryProgress: 0,
    competitorBlocking: 0,
    riskEventExposure: 0,
    loadScarcity: 0,
  },
  behavior: {
    planningHorizonTurns: 1,
    randomChoiceProbability: 0.2,
    missedOptionProbability: 0.3,
  },
};

const MEDIUM_PROFILE: SkillProfile = {
  difficulty: 'medium',
  weights: {
    immediateIncome: 0.5,
    incomePerMilepost: 0.7,
    multiDeliveryPotential: 0.3,
    networkExpansionValue: 0.5,
    victoryProgress: 0.3,
    competitorBlocking: 0,
    riskEventExposure: 0.3,
    loadScarcity: 0,
  },
  behavior: {
    planningHorizonTurns: 3,
    randomChoiceProbability: 0.05,
    missedOptionProbability: 0.1,
  },
};

const HARD_PROFILE: SkillProfile = {
  difficulty: 'hard',
  weights: {
    immediateIncome: 0.5,
    incomePerMilepost: 0.7,
    multiDeliveryPotential: 0.7,
    networkExpansionValue: 0.7,
    victoryProgress: 0.7,
    competitorBlocking: 0.5,
    riskEventExposure: 0.5,
    loadScarcity: 0.5,
  },
  behavior: {
    planningHorizonTurns: 5,
    randomChoiceProbability: 0,
    missedOptionProbability: 0,
  },
};

export const SKILL_PROFILES: Record<AIDifficulty, SkillProfile> = {
  easy: EASY_PROFILE,
  medium: MEDIUM_PROFILE,
  hard: HARD_PROFILE,
};

export function getSkillProfile(difficulty: AIDifficulty): SkillProfile {
  return SKILL_PROFILES[difficulty];
}
