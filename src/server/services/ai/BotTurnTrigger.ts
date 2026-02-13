/**
 * BotTurnTrigger — Detects bot turns and orchestrates execution.
 *
 * Stateless module with exported functions (not a class).
 * Called from emitTurnChange() as a side effect after turn:change emission.
 */

import { db } from '../../db/index';
import { emitToGame, getSocketIO } from '../socketService';
import { PlayerService } from '../playerService';
import { InitialBuildService } from '../InitialBuildService';
import { AIStrategyEngine } from './AIStrategyEngine';

/** Delay in ms before executing a bot turn */
export const BOT_TURN_DELAY_MS = 1500;

/** Feature flag: defaults to true if unset */
export function isAIBotsEnabled(): boolean {
  const value = process.env.ENABLE_AI_BOTS;
  if (value === undefined || value === '') return true;
  return value.toLowerCase() !== 'false';
}

// Log flag status once at module load
console.log(`[BotTurnTrigger] ENABLE_AI_BOTS=${isAIBotsEnabled() ? 'true' : 'false'}`);

/** Guard set to prevent double-execution of bot turns per game */
export const pendingBotTurns = new Set<string>();

/** Queued turns for games where no human is connected */
interface QueuedTurn {
  gameId: string;
  currentPlayerIndex: number;
  currentPlayerId: string;
}
export const queuedBotTurns = new Map<string, QueuedTurn>();

/**
 * Check whether any human player has an active socket connection to the game room.
 * Uses Socket.IO room membership — bots don't have sockets, so any connected
 * socket in the room must belong to a human player.
 */
export async function hasConnectedHuman(gameId: string): Promise<boolean> {
  const io = getSocketIO();
  if (!io) return true; // No Socket.IO = likely testing; proceed as if human present
  const room = io.sockets.adapter.rooms.get(gameId);
  return !!room && room.size > 0;
}

/**
 * Called after emitTurnChange() to detect and execute bot turns.
 * Returns immediately if ENABLE_AI_BOTS is false, player is not a bot,
 * game is completed/abandoned, or a bot turn is already in progress.
 */
export async function onTurnChange(
  gameId: string,
  currentPlayerIndex: number,
  currentPlayerId: string,
): Promise<void> {
  if (!isAIBotsEnabled()) return;

  // Query player: is_bot?
  const playerResult = await db.query(
    'SELECT is_bot FROM players WHERE id = $1',
    [currentPlayerId],
  );
  if (!playerResult.rows[0]?.is_bot) return;

  // Check game status
  const gameResult = await db.query(
    'SELECT status FROM games WHERE id = $1',
    [gameId],
  );
  const status = gameResult.rows[0]?.status;
  if (status === 'completed' || status === 'abandoned') return;

  // Double execution guard
  if (pendingBotTurns.has(gameId)) return;

  // Queue bot turn if no human is connected
  const humanConnected = await hasConnectedHuman(gameId);
  if (!humanConnected) {
    queuedBotTurns.set(gameId, { gameId, currentPlayerIndex, currentPlayerId });
    console.log(`[BotTurnTrigger] Queued bot turn for game ${gameId} (no human connected)`);
    return;
  }

  pendingBotTurns.add(gameId);
  try {
    // Delay before executing bot turn
    await new Promise(resolve => setTimeout(resolve, BOT_TURN_DELAY_MS));

    // Emit bot:turn-start
    const turnResult = await db.query(
      'SELECT current_turn_number FROM players WHERE id = $1',
      [currentPlayerId],
    );
    const turnNumber = turnResult.rows[0]?.current_turn_number || 0;
    emitToGame(gameId, 'bot:turn-start', { botPlayerId: currentPlayerId, turnNumber });

    // Bot turn housekeeping: increment turn number, reset build cost
    await db.query(
      'UPDATE players SET current_turn_number = COALESCE(current_turn_number, 1) + 1 WHERE id = $1',
      [currentPlayerId],
    );
    await db.query(
      'UPDATE player_tracks SET turn_build_cost = 0 WHERE game_id = $1 AND player_id = $2',
      [gameId, currentPlayerId],
    );

    // Execute bot strategy pipeline
    console.log(`[BotTurnTrigger] Executing AI pipeline for game ${gameId}, player ${currentPlayerId}`);
    const result = await AIStrategyEngine.takeTurn(gameId, currentPlayerId);
    console.log(`[BotTurnTrigger] Pipeline result: action=${result.action}, built=${result.segmentsBuilt}, cost=${result.cost}, success=${result.success}${result.error ? `, error=${result.error}` : ''}`);

    // Emit bot:turn-complete with audit data
    emitToGame(gameId, 'bot:turn-complete', {
      botPlayerId: currentPlayerId,
      turnNumber: turnNumber + 1,
      action: result.action,
      segmentsBuilt: result.segmentsBuilt,
      cost: result.cost,
      durationMs: result.durationMs,
    });

    // Advance to next player
    await advanceTurnAfterBot(gameId);
  } catch (error) {
    console.error(`[BotTurnTrigger] Error executing bot turn for game ${gameId}:`, error);
  } finally {
    pendingBotTurns.delete(gameId);
  }
}

/**
 * Dequeue and execute a pending bot turn when a human reconnects.
 */
export async function onHumanReconnect(gameId: string): Promise<void> {
  if (!isAIBotsEnabled()) return;

  const queued = queuedBotTurns.get(gameId);
  if (!queued) return;

  console.log(`[BotTurnTrigger] Dequeuing bot turn for game ${gameId} (human reconnected)`);
  queuedBotTurns.delete(gameId);
  await onTurnChange(queued.gameId, queued.currentPlayerIndex, queued.currentPlayerId);
}

/**
 * Phase-aware turn advancement after a bot completes its turn.
 * Routes to the correct service based on game status.
 */
export async function advanceTurnAfterBot(gameId: string): Promise<void> {
  const result = await db.query(
    'SELECT status, current_player_index FROM games WHERE id = $1',
    [gameId],
  );
  const game = result.rows[0];
  if (!game) return;

  if (game.status === 'initialBuild') {
    await InitialBuildService.advanceTurn(gameId);
  } else if (game.status === 'active') {
    const countResult = await db.query(
      'SELECT COUNT(*)::int as count FROM players WHERE game_id = $1',
      [gameId],
    );
    const playerCount = countResult.rows[0]?.count || 0;
    if (playerCount > 0) {
      const nextIndex = (game.current_player_index + 1) % playerCount;
      await PlayerService.updateCurrentPlayerIndex(gameId, nextIndex);
    }
  }
  // completed/abandoned: do nothing
}
