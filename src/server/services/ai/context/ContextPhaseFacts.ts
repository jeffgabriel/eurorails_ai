/**
 * ContextPhaseFacts — resolves the bot's phase and sticky end-game facts for a
 * single context-build pass.
 *
 * Product role: keep ContextBuilder focused on assembling the bot's decision
 * picture while this module owns the stateful phase/latch behavior.
 */

import {
  BotMemoryState,
  GameState,
  WorldSnapshot,
} from '../../../../shared/types/GameTypes';
import { updateMemory } from '../BotMemory';
import { classifyGamePhase } from '../DeterministicTripPlanner';
import { computeGameState } from '../victoryRules';
import { NetworkContext } from './NetworkContext';

export interface ContextPhaseFactsInput {
  snapshot: WorldSnapshot;
  memory: BotMemoryState | undefined;
  connectedMajorCities: string[];
}

export interface ContextPhaseFactsResult {
  memoryForPhase: BotMemoryState;
  gameState: GameState;
  phase: string;
  endGameLocked: boolean;
  persisted: {
    gameStateChanged: boolean;
    endGameLockedChanged: boolean;
  };
}

function defaultPhaseMemory(): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  };
}

export function resolveContextPhaseFacts({
  snapshot,
  memory,
  connectedMajorCities,
}: ContextPhaseFactsInput): ContextPhaseFactsResult {
  const memoryForPhase = memory ?? defaultPhaseMemory();
  const gameState = computeGameState(
    { money: snapshot.bot.money, turnNumber: snapshot.turnNumber },
    memoryForPhase,
  );

  const gameStateChanged = gameState !== memoryForPhase.gameState;
  if (gameStateChanged) {
    updateMemory(snapshot.gameId, snapshot.bot.playerId, { gameState }).catch(
      (err: unknown) => console.warn('[ContextPhaseFacts] Failed to persist gameState:', err),
    );
  }

  let endGameLockedChanged = false;
  if (!memoryForPhase.endGameLocked) {
    const phaseClass = classifyGamePhase(
      snapshot.turnNumber,
      memoryForPhase.deliveryCount ?? 0,
      connectedMajorCities.length,
    );
    if (snapshot.bot.money > 200 || phaseClass === 'late') {
      memoryForPhase.endGameLocked = true;
      endGameLockedChanged = true;
      updateMemory(snapshot.gameId, snapshot.bot.playerId, { endGameLocked: true }).catch(
        (err: unknown) => console.warn('[ContextPhaseFacts] Failed to persist endGameLocked:', err),
      );
    }
  }

  const phase = NetworkContext.computePhase(snapshot, connectedMajorCities, gameState);

  return {
    memoryForPhase,
    gameState,
    phase,
    endGameLocked: memoryForPhase.endGameLocked === true,
    persisted: {
      gameStateChanged,
      endGameLockedChanged,
    },
  };
}
