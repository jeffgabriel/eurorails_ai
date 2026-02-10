/**
 * BotTurnTrigger — initiates bot turns automatically when the game
 * advances to a bot player.
 *
 * Hooks into emitTurnChange so that every turn change is checked.
 * When the current player is a bot:
 *   - If at least one human is connected, invoke AIStrategyEngine after a delay.
 *   - If no humans are connected, queue the bot's turn until a human reconnects.
 *
 * After the bot turn completes, advances the game to the next player,
 * which may chain into another bot turn.
 */

import { db } from '../db/index';
import { AIStrategyEngine } from './AIStrategyEngine';
import { BotLogger } from './BotLogger';
import type { BotConfig, ArchetypeId, SkillLevel } from './types';

/** Delay before executing a bot turn, for UX pacing (ms). */
const BOT_TURN_DELAY_MS = 1500;

const logger = new BotLogger('BotTurnTrigger');

/**
 * Games with a bot turn currently in progress (prevents double-triggering).
 */
const pendingBotTurns = new Set<string>();

/**
 * Queued bot turns for games with no connected human players.
 */
const queuedBotTurns = new Map<
  string,
  { gameId: string; playerId: string; playerIndex: number }
>();

export class BotTurnTrigger {
  /**
   * Initialize the bot turn trigger.
   * Called once during server startup.
   */
  static init(): void {
    logger.info('BotTurnTrigger initialized');
  }

  /**
   * Called whenever the current player changes.
   * If the new current player is a bot, triggers their turn after a delay.
   *
   * @param gameId - The game ID
   * @param currentPlayerIndex - The new current player index (0-based)
   * @param currentPlayerId - Optional player ID (avoids an extra query)
   */
  static async onTurnChange(
    gameId: string,
    currentPlayerIndex: number,
    currentPlayerId?: string,
  ): Promise<void> {
    // Prevent double-triggering for the same game
    if (pendingBotTurns.has(gameId)) return;

    try {
      // Look up the player at the current index
      const player = await getPlayerAtIndex(gameId, currentPlayerIndex);
      if (!player || !player.is_bot) return;

      const playerId = currentPlayerId || player.id;
      const log = logger.withContext(gameId, playerId);

      // Check if at least one human is connected
      const humanConnected = await hasConnectedHuman(gameId);

      if (!humanConnected) {
        queuedBotTurns.set(gameId, {
          gameId,
          playerId,
          playerIndex: currentPlayerIndex,
        });
        log.info('Bot turn queued — no human players connected');
        return;
      }

      // Mark game as having a pending bot turn and schedule execution
      pendingBotTurns.add(gameId);

      setTimeout(() => {
        executeBotTurn(gameId, player, currentPlayerIndex)
          .catch((err) => {
            log.error('Bot turn execution failed', { error: String(err) });
          })
          .finally(() => {
            pendingBotTurns.delete(gameId);
          });
      }, BOT_TURN_DELAY_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`onTurnChange error: ${message}`);
    }
  }

  /**
   * Called when a human player reconnects to a game.
   * Resumes any queued bot turns for that game.
   *
   * @param gameId - The game the human reconnected to
   */
  static async onHumanReconnect(gameId: string): Promise<void> {
    const queued = queuedBotTurns.get(gameId);
    if (!queued) return;

    queuedBotTurns.delete(gameId);
    logger.info('Resuming queued bot turn after human reconnect', { gameId });

    // Re-trigger the turn change (will go through normal flow with delay)
    await BotTurnTrigger.onTurnChange(
      gameId,
      queued.playerIndex,
      queued.playerId,
    );
  }

  // --- Test helpers (not part of public API) ---

  /** @internal */
  static _getPendingGames(): Set<string> {
    return pendingBotTurns;
  }

  /** @internal */
  static _getQueuedTurns(): Map<
    string,
    { gameId: string; playerId: string; playerIndex: number }
  > {
    return queuedBotTurns;
  }

  /** @internal */
  static _clearState(): void {
    pendingBotTurns.clear();
    queuedBotTurns.clear();
  }
}

// --- Internal helpers ---

interface BotPlayerRow {
  id: string;
  user_id: string | null;
  is_bot: boolean;
  bot_config: { archetype?: string; skillLevel?: string } | null;
  name: string;
  current_turn_number: number | null;
}

/**
 * Retrieve the player at a given turn-order index.
 * Player order is determined by created_at ASC (same as PlayerService).
 */
async function getPlayerAtIndex(
  gameId: string,
  index: number,
): Promise<BotPlayerRow | null> {
  const result = await db.query(
    `SELECT id, user_id, is_bot, bot_config, name, current_turn_number
     FROM players
     WHERE game_id = $1
     ORDER BY created_at ASC
     LIMIT 1 OFFSET $2`,
    [gameId, index],
  );
  return (result.rows[0] as BotPlayerRow) || null;
}

/**
 * Check whether at least one human player is currently connected
 * (is_online = true AND is_bot = false).
 */
async function hasConnectedHuman(gameId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM players
     WHERE game_id = $1
       AND is_bot = false
       AND is_online = true
     LIMIT 1`,
    [gameId],
  );
  return result.rows.length > 0;
}

/**
 * Execute a bot turn via AIStrategyEngine, then advance the game.
 */
async function executeBotTurn(
  gameId: string,
  player: BotPlayerRow,
  playerIndex: number,
): Promise<void> {
  const log = logger.withContext(gameId, player.id);

  // Build BotConfig from the DB bot_config JSONB
  const raw = player.bot_config || {};
  const config: BotConfig = {
    skillLevel: (raw.skillLevel || 'medium') as SkillLevel,
    archetype: (raw.archetype || 'opportunist') as ArchetypeId,
    botId: player.id,
    botName: player.name,
  };

  const turnNumber = player.current_turn_number || 1;
  log.info(`Executing bot turn ${turnNumber}`);

  // The bot's user_id may be null; WorldSnapshotService passes it
  // to GameService.getGame which no longer filters on userId.
  const botUserId = player.user_id || player.id;

  const result = await AIStrategyEngine.takeTurn(
    gameId,
    player.id,
    botUserId,
    config,
    turnNumber,
  );

  log.info('Bot turn complete', {
    success: result.success,
    retriesUsed: result.retriesUsed,
    fellBackToPass: result.fellBackToPass,
  });

  // Advance to the next player
  await advanceTurnAfterBot(gameId, player.id, playerIndex);
}

/**
 * Increment the bot's per-player turn number and advance
 * the game's current_player_index to the next player.
 *
 * Uses PlayerService.updateCurrentPlayerIndex which will emit
 * turn:change — triggering onTurnChange again (chaining if next is a bot).
 */
async function advanceTurnAfterBot(
  gameId: string,
  botPlayerId: string,
  currentIndex: number,
): Promise<void> {
  // Increment bot's per-player turn number
  await db.query(
    `UPDATE players
     SET current_turn_number = COALESCE(current_turn_number, 1) + 1
     WHERE game_id = $1 AND id = $2`,
    [gameId, botPlayerId],
  );

  // Calculate next index
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM players WHERE game_id = $1`,
    [gameId],
  );
  const playerCount = countResult.rows[0].count;
  const nextIndex = (currentIndex + 1) % playerCount;

  // Advance game turn — this emits turn:change which may chain into
  // another bot turn via onTurnChange.
  const { PlayerService } = await import('../services/playerService');
  await PlayerService.updateCurrentPlayerIndex(gameId, nextIndex);
}
