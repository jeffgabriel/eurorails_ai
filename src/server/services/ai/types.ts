/**
 * AI Service Types
 * Internal types for AI decision-making services
 */

import { AIDifficulty, AIPersonality, Player, TrainType, Point, TrackSegment } from '../../../shared/types/GameTypes';
import { DemandCard } from '../../../shared/types/DemandCard';
import { AIAction, TurnSummary, AIStrategy, AIDebugInfo } from '../../../shared/types/AITypes';

/**
 * Configuration parameters for AI difficulty levels
 */
export interface DifficultyParams {
  planningHorizon: number;
  variablesConsidered: number;
  evaluationDepth: 'satisfice' | 'good' | 'optimal';
  thinkingDelayMs: number;
}

/**
 * Configuration parameters for AI personalities
 */
export interface PersonalityParams {
  priorityWeights: Record<string, number>;
  riskTolerance: number;
  commentaryStyle: 'analytical' | 'strategic' | 'reactive' | 'competitive' | 'methodical' | 'humorous';
}

/**
 * Combined AI configuration
 */
export interface AIConfig {
  difficulty: DifficultyParams;
  personality: PersonalityParams;
}

/**
 * Represents a route between two points
 */
export interface Route {
  from: Point;
  to: Point;
  segments: TrackSegment[];
  totalCost: number;
  distance: number;
}

/**
 * A potential option for building track
 */
export interface BuildOption {
  targetPoint: Point;
  segments: TrackSegment[];
  cost: number;
  strategicValue: number;
  connectsMajorCity: boolean;
}

/**
 * A possible action the AI can take during its turn
 */
export interface TurnOption {
  type: 'build' | 'move' | 'pickup' | 'deliver' | 'drop' | 'upgrade' | 'pass';
  priority: number;
  expectedValue: number;
  details: Record<string, unknown>;
}

/**
 * Ranked option with score
 */
export interface RankedOption extends TurnOption {
  score: number;
  reasoning: string;
}

/**
 * The AI's plan for the current turn
 */
export interface AITurnPlan {
  actions: AIAction[];
  expectedCashChange: number;
  reasoning: string;
  alternativesConsidered: number;
}

/**
 * Position evaluation score
 */
export interface PositionScore {
  overall: number;
  cashPosition: number;
  networkValue: number;
  deliveryPotential: number;
  progressToVictory: number;
}

/**
 * Assessment of threats from opponents
 */
export interface ThreatAssessment {
  overallThreat: number;
  blockingThreats: Array<{
    playerId: string;
    cityBlocked: string;
    impact: number;
  }>;
  competitionForLoads: Array<{
    loadType: string;
    competitorCount: number;
    urgency: number;
  }>;
}

/**
 * Result of executing an AI turn
 */
export interface AITurnResult {
  success: boolean;
  actions: AIAction[];
  turnSummary: TurnSummary;
  strategy: AIStrategy;
  debugInfo: AIDebugInfo;
}

/**
 * Full game state needed for AI decision-making
 */
export interface AIGameState {
  players: Player[];
  currentPlayerId: string;
  turnNumber: number;
  availableLoads: Map<string, string[]>;  // cityName -> loadTypes
  droppedLoads: Array<{ city: string; loadType: string }>;
  allTrack: Map<string, TrackSegment[]>;  // playerId -> track segments
}

/**
 * AI decision context for logging/debugging
 */
export interface AIDecision {
  timestamp: number;
  playerId: string;
  turnNumber: number;
  optionsConsidered: TurnOption[];
  selectedOption: RankedOption;
  evaluationTimeMs: number;
}
