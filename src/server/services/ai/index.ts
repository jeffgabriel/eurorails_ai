/**
 * AI Services
 * Exports all AI-related services for use in game logic
 */

// Types
export * from './types';

// Configuration
export {
  AI_DIFFICULTY_CONFIG,
  AI_PERSONALITY_CONFIG,
  AI_NAMES,
  AI_TURN_TIMEOUT_MS,
  AI_BUILD_BUDGET_PER_TURN,
  getAIConfig
} from './aiConfig';

// Services
export { AIPlanner, getAIPlanner } from './aiPlanner';
export { AIPathfinder, getAIPathfinder } from './aiPathfinder';
export { AIEvaluator, getAIEvaluator } from './aiEvaluator';
export { AICommentary, getAICommentary } from './aiCommentary';
