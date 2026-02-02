/**
 * AI Player Types
 * Types for AI turn summaries, strategies, and socket events
 */

import { AIDifficulty, AIPersonality } from './GameTypes';

/** Action types that an AI can take during a turn */
export type AIActionType = 'build' | 'move' | 'pickup' | 'deliver' | 'drop' | 'upgrade';

/** A single action taken by an AI during its turn */
export interface AIAction {
  type: AIActionType;
  description: string;
  details: Record<string, unknown>;
}

/** Summary of an AI player's turn */
export interface TurnSummary {
  actions: AIAction[];
  cashChange: number;
  commentary: string;
}

/** Current strategy information for an AI player */
export interface AIStrategy {
  phase: string;
  currentGoal: string;
  nextGoal: string;
  majorCityProgress: string;
  cashToWin: number;
}

/** Debug information about AI decision-making */
export interface AIDebugInfo {
  routesEvaluated: number;
  selectedRouteScore: number;
  decisionTimeMs: number;
  variablesConsidered: string[];
}

/** Payload for the ai:thinking socket event */
export interface AIThinkingPayload {
  playerId: string;
}

/** Payload for the ai:turn-complete socket event */
export interface AITurnCompletePayload {
  playerId: string;
  turnSummary: TurnSummary;
  currentStrategy: AIStrategy;
  debug?: AIDebugInfo;
}

/** Props for AI-related UI components */
export interface AIPlayerDisplayInfo {
  playerId: string;
  playerName: string;
  difficulty: AIDifficulty;
  personality: AIPersonality;
}

/** Get display name for AI personality */
export function getPersonalityDisplayName(personality: AIPersonality): string {
  const names: Record<AIPersonality, string> = {
    optimizer: 'Optimizer',
    network_builder: 'Network Builder',
    opportunist: 'Opportunist',
    blocker: 'Blocker',
    steady_hand: 'Steady Hand',
    chaos_agent: 'Chaos Agent',
  };
  return names[personality];
}

/** Get display name for AI difficulty */
export function getDifficultyDisplayName(difficulty: AIDifficulty): string {
  const names: Record<AIDifficulty, string> = {
    easy: 'Easy',
    medium: 'Medium',
    hard: 'Hard',
  };
  return names[difficulty];
}
