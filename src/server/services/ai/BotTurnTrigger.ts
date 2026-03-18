/**
 * BotTurnTrigger — Detects bot turns and orchestrates execution.
 *
 * Stateless module with exported functions (not a class).
 * Called from emitTurnChange() as a side effect after turn:change emission.
 */

import { db } from '../../db/index';
import { emitToGame, getSocketIO, emitVictoryTriggered, emitGameOver, emitTieExtended } from '../socketService';
import { PlayerService } from '../playerService';
import { InitialBuildService } from '../InitialBuildService';
import { AIStrategyEngine } from './AIStrategyEngine';
import { clearMemory } from './BotMemory';
import { appendTurn } from './GameLogger';
import { VictoryService } from '../victoryService';
import { TrackService } from '../trackService';
import { getConnectedMajorCities } from './connectedMajorCities';
import { VICTORY_INITIAL_THRESHOLD } from '../../../shared/types/GameTypes';

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

  // Query player: is_bot + name for logging
  const playerResult = await db.query(
    'SELECT is_bot, name FROM players WHERE id = $1',
    [currentPlayerId],
  );
  if (!playerResult.rows[0]?.is_bot) return;
  const playerName: string | undefined = playerResult.rows[0]?.name;

  // Check game status
  const gameResult = await db.query(
    'SELECT status FROM games WHERE id = $1',
    [gameId],
  );
  const status = gameResult.rows[0]?.status;
  if (status === 'completed' || status === 'abandoned') {
    clearMemory(gameId, currentPlayerId);
    return;
  }

  // Double execution guard — queue the turn instead of dropping it
  if (pendingBotTurns.has(gameId)) {
    queuedBotTurns.set(gameId, { gameId, currentPlayerIndex, currentPlayerId });
    console.log(`[BotTurnTrigger] Queued bot turn for game ${gameId} (another bot turn in progress)`);
    return;
  }

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

    // Emit bot:turn-start (best-effort housekeeping — don't let missing columns abort the turn)
    let turnNumber = 0;
    try {
      const turnResult = await db.query(
        'SELECT current_turn_number FROM players WHERE id = $1',
        [currentPlayerId],
      );
      turnNumber = turnResult.rows[0]?.current_turn_number || 0;
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
    } catch (housekeepingError) {
      console.error(`[BotTurnTrigger] Housekeeping failed for game ${gameId} (continuing):`, housekeepingError instanceof Error ? housekeepingError.message : housekeepingError);
    }

    // Execute bot strategy pipeline
    console.log(`[BotTurnTrigger] Executing AI pipeline for game ${gameId}, player ${currentPlayerId}`);
    const result = await AIStrategyEngine.takeTurn(gameId, currentPlayerId);
    console.log(`[BotTurnTrigger] Pipeline result: action=${result.action}, built=${result.segmentsBuilt}, cost=${result.cost}, success=${result.success}${result.error ? `, error=${result.error}` : ''}`);

    // JIRA-19: Best-effort persist LLM decision metadata to bot_turn_audits
    try {
      const details = {
        reasoning: result.reasoning ?? null,
        planHorizon: result.planHorizon ?? null,
        model: result.model ?? null,
        llmLatencyMs: result.llmLatencyMs ?? null,
        tokenUsage: result.tokenUsage ?? null,
        retried: result.retried ?? false,
        guardrailOverride: result.guardrailOverride ?? false,
        guardrailReason: result.guardrailReason ?? null,
        handQuality: result.handQuality ?? null,
        llmLog: result.llmLog ?? null,
      };
      await db.query(
        'UPDATE bot_turn_audits SET details = $1 WHERE game_id = $2 AND player_id = $3 AND turn_number = $4',
        [JSON.stringify(details), gameId, currentPlayerId, turnNumber + 1],
      );
    } catch (auditError) {
      console.error(`[BotTurnTrigger] details UPDATE failed for game ${gameId} player ${currentPlayerId} turn ${turnNumber + 1}:`, auditError instanceof Error ? auditError.message : auditError);
    }

    // Emit bot:turn-complete with audit data + strategy reasoning
    emitToGame(gameId, 'bot:turn-complete', {
      botPlayerId: currentPlayerId,
      turnNumber: turnNumber + 1,
      action: result.action,
      segmentsBuilt: result.segmentsBuilt,
      cost: result.cost,
      durationMs: result.durationMs,
      loadsPickedUp: result.loadsPickedUp,
      loadsDelivered: result.loadsDelivered,
      buildTargetCity: result.buildTargetCity,
      movementData: result.movedTo ? {
        from: result.movedTo, // approximate — we don't track original position
        to: result.movedTo,
        mileposts: result.milepostsMoved,
        trackUsageFee: result.trackUsageFee,
      } : undefined,
      reasoning: result.reasoning,
      planHorizon: result.planHorizon,
      guardrailOverride: result.guardrailOverride,
      guardrailReason: result.guardrailReason,
      demandRanking: result.demandRanking,
      upgradeAdvice: result.upgradeAdvice,
      handQuality: result.handQuality,
      // JIRA-19: LLM decision metadata
      model: result.model,
      llmLatencyMs: result.llmLatencyMs,
      tokenUsage: result.tokenUsage,
      retried: result.retried,
      // JIRA-31: LLM attempt log for debug overlay
      llmLog: result.llmLog,
      // JIRA-36: Movement path for animated bot train movement
      movementPath: result.movementPath,
      // Structured action timeline for animated partial turn movements
      actionTimeline: result.actionTimeline,
      // JIRA-126: Trip planning data for debug overlay
      tripPlanning: result.tripPlanning,
      // Debug overlay: active route snapshot (or null if cleared)
      activeRoute: result.activeRoute ?? null,
    });

    // JIRA-32: Append structured turn log to NDJSON game file
    try {
      appendTurn(gameId, {
        turn: turnNumber + 1,
        playerId: currentPlayerId,
        playerName,
        timestamp: new Date().toISOString(),
        positionStart: result.positionStart,
        positionEnd: result.positionEnd,
        carriedLoads: result.carriedLoads,
        movementPath: result.movementPath,
        trainSpeed: result.trainSpeed,
        trainCapacity: result.trainCapacity,
        connectedMajorCities: result.connectedMajorCities,
        activeRoute: result.activeRoute ? { stops: result.activeRoute.stops.map(s => ({ action: s.action, loadType: s.loadType, city: s.city })), currentStopIndex: result.activeRoute.currentStopIndex } : undefined,
        demandCards: result.demandCards,
        action: result.action,
        reasoning: result.reasoning,
        planHorizon: result.planHorizon,
        model: result.model,
        llmLatencyMs: result.llmLatencyMs,
        tokenUsage: result.tokenUsage,
        llmLog: result.llmLog,
        composition: result.compositionTrace,
        demandRanking: result.demandRanking,
        handQuality: result.handQuality,
        gamePhase: result.gamePhase,
        cash: result.cash,
        train: result.trainType,
        upgradeAdvice: result.upgradeAdvice,
        guardrailOverride: result.guardrailOverride,
        guardrailReason: result.guardrailReason,
        success: result.success ?? true,
        error: result.error,
        segmentsBuilt: result.segmentsBuilt,
        cost: result.cost,
        durationMs: result.durationMs,
        buildTargetCity: result.buildTargetCity,
        loadsPickedUp: result.loadsPickedUp,
        loadsDelivered: result.loadsDelivered,
        milepostsMoved: result.milepostsMoved,
        trackUsageFee: result.trackUsageFee,
        secondaryDelivery: result.secondaryDelivery,
        systemPrompt: result.systemPrompt,
        userPrompt: result.userPrompt,
        turnValidation: result.turnValidation,
      });
    } catch (logError) {
      console.error(`[BotTurnTrigger] NDJSON log failed for game ${gameId}:`, logError instanceof Error ? logError.message : logError);
    }

    // JIRA-106: Check victory conditions for bot after turn completes
    const victoryDeclared = await checkBotVictory(gameId, currentPlayerId);
    if (victoryDeclared) {
      // Victory declared — game enters final-turn mode, but turn still advances
      console.log(`[BotTurnTrigger] Bot ${currentPlayerId} declared victory in game ${gameId}`);
    }

    // Advance to next player
    await advanceTurnAfterBot(gameId);

    // JIRA-106: Check if this was the final turn and resolve victory
    await checkAndResolveFinalTurn(gameId);
  } catch (error) {
    console.error(`[BotTurnTrigger] Error executing bot turn for game ${gameId}:`, error);
  } finally {
    pendingBotTurns.delete(gameId);

    // Dequeue and execute any chained bot turn that was queued while this one was running
    const queued = queuedBotTurns.get(gameId);
    if (queued) {
      queuedBotTurns.delete(gameId);
      console.log(`[BotTurnTrigger] Dequeuing chained bot turn for game ${gameId}`);
      onTurnChange(queued.gameId, queued.currentPlayerIndex, queued.currentPlayerId).catch(err => {
        console.error(`[BotTurnTrigger] Chained bot turn error for game ${gameId}:`, err);
      });
    }
  }
}

/**
 * Dequeue and execute a pending bot turn when a human reconnects.
 * Also detects "stuck bot" state: game says it's a bot's turn but
 * nothing is executing (not pending, not queued). This recovers from
 * lost bot turns caused by race conditions or server errors.
 */
export async function onHumanReconnect(gameId: string): Promise<void> {
  if (!isAIBotsEnabled()) return;

  // Case 1: Queued turn waiting for human
  const queued = queuedBotTurns.get(gameId);
  if (queued) {
    console.log(`[BotTurnTrigger] Dequeuing bot turn for game ${gameId} (human reconnected)`);
    queuedBotTurns.delete(gameId);
    await onTurnChange(queued.gameId, queued.currentPlayerIndex, queued.currentPlayerId);
    return;
  }

  // Case 2: Stuck bot — game state says bot's turn, but nothing is running
  if (pendingBotTurns.has(gameId)) return; // Bot turn is actively running, not stuck

  try {
    const gameResult = await db.query(
      'SELECT status, current_player_index FROM games WHERE id = $1',
      [gameId],
    );
    const game = gameResult.rows[0];
    if (!game || game.status !== 'active') return;

    // Find the current player by index (matches PlayerService ordering)
    const playerResult = await db.query(
      'SELECT id, is_bot, name FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
      [gameId, game.current_player_index],
    );
    const currentPlayer = playerResult.rows[0];
    if (!currentPlayer?.is_bot) return;

    // It's a bot's turn, nothing is pending or queued — this bot is stuck
    console.log(`[BotTurnTrigger] Stuck bot detected on reconnect: game ${gameId}, player "${currentPlayer.name}" (index ${game.current_player_index}). Re-triggering turn.`);
    onTurnChange(gameId, game.current_player_index, currentPlayer.id).catch(err => {
      console.error(`[BotTurnTrigger] Stuck bot recovery failed for game ${gameId}:`, err);
    });
  } catch (error) {
    console.error(`[BotTurnTrigger] Stuck bot check failed for game ${gameId}:`, error instanceof Error ? error.message : error);
  }
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

/**
 * JIRA-106: Check if a bot meets victory conditions after its turn.
 * Mirrors the client-side check in GameScene.checkAndDeclareVictory().
 *
 * Returns true if victory was successfully declared.
 */
export async function checkBotVictory(
  gameId: string,
  playerId: string,
): Promise<boolean> {
  try {
    // Skip if victory already triggered
    const victoryState = await VictoryService.getVictoryState(gameId);
    if (victoryState?.triggered) return false;

    // Get bot's money and debt
    const playerResult = await db.query(
      'SELECT money, debt_owed, name FROM players WHERE id = $1',
      [playerId],
    );
    if (playerResult.rows.length === 0) return false;

    const player = playerResult.rows[0];
    const threshold = victoryState?.victoryThreshold ?? VICTORY_INITIAL_THRESHOLD;
    const netWorth = player.money - (player.debt_owed || 0);

    // Quick check: enough money?
    if (netWorth < threshold) return false;

    // Get track segments and check connected cities
    const trackState = await TrackService.getTrackState(gameId, playerId);
    if (!trackState || trackState.segments.length === 0) return false;

    const connectedCities = getConnectedMajorCities(trackState.segments);
    if (connectedCities.length < 7) return false;

    // Both conditions met — declare victory
    console.log(`[BotTurnTrigger] Bot "${player.name}" meets victory conditions: ${netWorth}M ECU, ${connectedCities.length} connected cities`);
    const result = await VictoryService.declareVictory(gameId, playerId, connectedCities);

    if (!result.success) {
      console.warn(`[BotTurnTrigger] Victory declaration rejected: ${result.error}`);
      return false;
    }

    // Emit victory triggered event to all clients
    if (result.victoryState) {
      emitVictoryTriggered(
        gameId,
        result.victoryState.triggerPlayerIndex,
        player.name,
        result.victoryState.finalTurnPlayerIndex,
        result.victoryState.victoryThreshold,
      );
    }

    return true;
  } catch (error) {
    console.error(`[BotTurnTrigger] Victory check failed for game ${gameId}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * JIRA-106: After advancing the turn, check if the game is in final-turn mode
 * and the final turn just completed. If so, resolve victory.
 * Mirrors the client-side check in GameScene.resolveVictory().
 */
async function checkAndResolveFinalTurn(gameId: string): Promise<void> {
  try {
    const isFinal = await VictoryService.isFinalTurn(gameId);
    if (!isFinal) return;

    console.log(`[BotTurnTrigger] Final turn completed for game ${gameId} — resolving victory`);
    const result = await VictoryService.resolveVictory(gameId);

    if (result.gameOver && result.winnerId && result.winnerName) {
      emitGameOver(gameId, result.winnerId, result.winnerName);
    } else if (result.tieExtended && result.newThreshold) {
      emitTieExtended(gameId, result.newThreshold);
    }
  } catch (error) {
    console.error(`[BotTurnTrigger] Final turn resolution failed for game ${gameId}:`, error instanceof Error ? error.message : error);
  }
}
