/**
 * AI Configuration Constants
 * Defines difficulty and personality parameters for AI players
 */

import { AIDifficulty, AIPersonality } from '../../../shared/types/GameTypes';
import { DifficultyParams, PersonalityParams } from './types';

/**
 * Configuration for each AI difficulty level
 * Determines how well the bot plays - the sophistication of its analysis
 */
export const AI_DIFFICULTY_CONFIG: Record<AIDifficulty, DifficultyParams> = {
  easy: {
    planningHorizon: 1,           // Current turn only
    variablesConsidered: 4,
    evaluationDepth: 'satisfice', // First good option
    thinkingDelayMs: 1500,
  },
  medium: {
    planningHorizon: 3,           // 2-3 turns ahead
    variablesConsidered: 8,
    evaluationDepth: 'good',      // Top 3 options
    thinkingDelayMs: 1000,
  },
  hard: {
    planningHorizon: 5,           // 4-5 turns ahead
    variablesConsidered: 12,
    evaluationDepth: 'optimal',   // Exhaustive
    thinkingDelayMs: 800,
  }
};

/**
 * Configuration for each AI personality
 * Determines how the bot approaches the game - independent of skill level
 */
export const AI_PERSONALITY_CONFIG: Record<AIPersonality, PersonalityParams> = {
  optimizer: {
    priorityWeights: { roi: 1.5, efficiency: 1.3, speed: 1.0 },
    riskTolerance: 0.2,
    commentaryStyle: 'analytical',
  },
  network_builder: {
    priorityWeights: { connectivity: 1.5, futureValue: 1.3, majorCities: 1.2 },
    riskTolerance: 0.5,
    commentaryStyle: 'strategic',
  },
  opportunist: {
    priorityWeights: { immediatePayout: 1.5, flexibility: 1.2 },
    riskTolerance: 0.8,
    commentaryStyle: 'reactive',
  },
  blocker: {
    priorityWeights: { opponentDenial: 1.4, chokepoints: 1.3, scarcity: 1.2 },
    riskTolerance: 0.5,
    commentaryStyle: 'competitive',
  },
  steady_hand: {
    priorityWeights: { consistency: 1.5, lowRisk: 1.4, terrain: 0.7 },
    riskTolerance: 0.1,
    commentaryStyle: 'methodical',
  },
  chaos_agent: {
    priorityWeights: { unpredictability: 1.3, entertainment: 1.2 },
    riskTolerance: 0.9,
    commentaryStyle: 'humorous',
  }
};

/**
 * Get the combined AI configuration for a player
 */
export function getAIConfig(difficulty: AIDifficulty, personality: AIPersonality) {
  return {
    difficulty: AI_DIFFICULTY_CONFIG[difficulty],
    personality: AI_PERSONALITY_CONFIG[personality],
  };
}

/**
 * AI names pool for generating AI player names
 */
export const AI_NAMES: Record<AIPersonality, string[]> = {
  optimizer: ['Otto', 'Olga', 'Oscar', 'Olivia'],
  network_builder: ['Nadine', 'Norbert', 'Natasha', 'Nelson'],
  opportunist: ['Oliver', 'Ophelia', 'Orlando', 'Octavia'],
  blocker: ['Boris', 'Beatrix', 'Bruno', 'Bridget'],
  steady_hand: ['Stefan', 'Sylvia', 'Samuel', 'Sophie'],
  chaos_agent: ['Chaos Carl', 'Crazy Clara', 'Wild Werner', 'Zany Zelda'],
};

/**
 * Maximum time (ms) allowed for AI turn before timeout
 */
export const AI_TURN_TIMEOUT_MS = 30000;

/**
 * Track building budget per turn
 */
export const AI_BUILD_BUDGET_PER_TURN = 20; // ECU 20 million
