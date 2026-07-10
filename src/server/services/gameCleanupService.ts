import { DemandDeckService } from './demandDeckService';
import { clearGameMemory } from './ai/BotMemory';
import { cleanupBotTurnState } from './ai/BotTurnTrigger';

/**
 * Release all per-game in-memory state when a game reaches a terminal state
 * (completed or abandoned). Consolidates every per-game cleanup routine so
 * game-end call sites have a single hook and no cleanup step is forgotten.
 *
 * Idempotent: each underlying cleanup is a no-op for an unknown game, so calling
 * this multiple times for the same `gameId` is safe. Best-effort: a failure in
 * one cleanup is logged and does not prevent the others from running.
 *
 * Note: `LoadService` is intentionally NOT cleaned up here. Unlike the demand
 * deck and bot state, its per-game state is DB-backed (rows keyed by
 * `game_id`), not an in-memory per-game instance — there is nothing in memory
 * to destroy. See the "Fix Multi-Game Shared State" scope decision.
 */
export async function cleanupGameState(gameId: string): Promise<void> {
  if (!gameId) {
    return;
  }

  try {
    DemandDeckService.destroyInstance(gameId);
  } catch (err) {
    console.error(`[gameCleanup] Failed to destroy demand deck for game ${gameId}:`, err);
  }

  try {
    cleanupBotTurnState(gameId);
  } catch (err) {
    console.error(`[gameCleanup] Failed to clean bot turn state for game ${gameId}:`, err);
  }

  try {
    await clearGameMemory(gameId);
  } catch (err) {
    console.error(`[gameCleanup] Failed to clear bot memory for game ${gameId}:`, err);
  }
}
