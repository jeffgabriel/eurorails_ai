/**
 * BotMemory — Tracks persistent state across bot turns for smarter decision-making.
 *
 * Simple module-level Map keyed by `${gameId}:${playerId}`.
 * Stores strategic state (build target, delivery count, etc.) so the bot
 * can make informed multi-turn decisions instead of re-evaluating from scratch.
 */

import { BotMemoryState } from '../../../shared/types/GameTypes';

const memoryStore = new Map<string, BotMemoryState>();

function memoryKey(gameId: string, playerId: string): string {
  return `${gameId}:${playerId}`;
}

function defaultState(): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutivePassTurns: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
  };
}

/**
 * Retrieve the current memory state for a bot in a specific game.
 * Returns a default state if no entry exists.
 */
export function getMemory(gameId: string, playerId: string): BotMemoryState {
  return memoryStore.get(memoryKey(gameId, playerId)) ?? defaultState();
}

/**
 * Update the memory state for a bot (shallow merge).
 */
export function updateMemory(gameId: string, playerId: string, patch: Partial<BotMemoryState>): void {
  const current = getMemory(gameId, playerId);
  memoryStore.set(memoryKey(gameId, playerId), { ...current, ...patch });
}

/**
 * Clear all memory for a bot in a specific game.
 */
export function clearMemory(gameId: string, playerId: string): void {
  memoryStore.delete(memoryKey(gameId, playerId));
}
