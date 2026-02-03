/**
 * AI Service - Main Orchestrator
 * Coordinates AI turn execution by integrating AI planning with game services
 */

import { Player, AIDifficulty, AIPersonality } from '../../../shared/types/GameTypes';
import {
  AIAction,
  TurnSummary,
  AIStrategy,
  AIDebugInfo,
  AIThinkingPayload,
  AITurnCompletePayload,
} from '../../../shared/types/AITypes';
import { AITurnResult, AIGameState, AIConfig, AITurnPlan, AIDecision } from './types';
import { getAIPlanner } from './aiPlanner';
import { getAICommentary } from './aiCommentary';
import { getAIConfig, AI_DIFFICULTY_CONFIG, AI_TURN_TIMEOUT_MS } from './aiConfig';
import { emitToGame, emitStatePatch } from '../socketService';
import { db } from '../../db';
import { demandDeckService } from '../demandDeckService';
import { getMajorCityGroups, getCityCoordinates } from '../../../shared/services/majorCityGroups';
import { getAITrackBuilder } from './aiTrackBuilder';
import { TrackService } from '../trackService';
import { PlayerTrackState } from '../../../shared/types/TrackTypes';

/**
 * AI Service class - orchestrates AI turn execution
 */
export class AIService {
  /**
   * Execute an AI player's turn
   * @param gameId - The game ID
   * @param playerId - The AI player's ID
   * @returns Result of the AI turn execution
   */
  async executeAITurn(gameId: string, playerId: string): Promise<AITurnResult> {
    const startTime = Date.now();
    console.log(`\n========== AI TURN START ==========`);
    console.log(`Game: ${gameId}`);
    console.log(`Player: ${playerId}`);

    // 1. Emit ai:thinking event to notify clients
    this.emitThinking(gameId, playerId);

    try {
      // 2. Retrieve game state and AI player data
      const { gameState, player } = await this.getGameStateAndPlayer(gameId, playerId);
      console.log(`AI Player: ${player.name} (${player.aiDifficulty}/${player.aiPersonality})`);
      console.log(`Money: ${player.money}M`);
      console.log(`Train position: ${JSON.stringify(player.trainState.position)}`);
      console.log(`Loads: ${JSON.stringify(player.trainState.loads)}`);
      console.log(`Hand (card IDs): ${JSON.stringify(player.hand)}`);
      console.log(`Available loads cities: ${gameState.availableLoads.size}`);

      if (!player.isAI) {
        throw new Error('Player is not an AI');
      }

      // 2b. If AI has no train position and we're past initial building phase, place at a starting city
      // According to game rules, trains cannot be placed or moved until turn 3 (after initial building)
      const turnNumber = player.turnNumber || 1;
      if (!player.trainState.position && turnNumber > 2) {
        console.log(`No train position and turn ${turnNumber} - placing at starting city...`);
        await this.placeAITrainAtStartingCity(gameId, playerId, player);
      } else if (!player.trainState.position) {
        console.log(`AI ${player.name} is in initial building phase (turn ${turnNumber}) - no train placement yet`);
      }

      // 3. Load AI configuration
      const difficulty = player.aiDifficulty || 'easy';
      const personality = player.aiPersonality || 'optimizer';
      const config = getAIConfig(difficulty, personality);

      // 4. Add thinking delay based on difficulty
      await this.applyThinkingDelay(config);

      // 5. Plan the turn using AIPlanner
      console.log(`Planning turn...`);
      const planner = getAIPlanner();
      const plan = planner.planTurn(gameState, player, config);
      console.log(`Plan generated: ${plan.actions.length} actions`);
      console.log(`Plan reasoning: ${plan.reasoning}`);
      for (const action of plan.actions) {
        console.log(`  - ${action.type}: ${action.description}`);
      }

      // 6. Execute the planned actions
      const executedActions = await this.executeActions(gameId, playerId, plan, player);

      // 7. Generate turn summary and strategy
      const turnSummary = this.generateTurnSummary(executedActions, personality, plan);
      const strategy = this.generateStrategy(player, plan, gameState);
      const debugInfo = this.generateDebugInfo(plan, startTime, difficulty);

      // 8. Emit ai:turn-complete event
      this.emitTurnComplete(gameId, playerId, turnSummary, strategy, debugInfo);

      console.log(`AI turn completed in ${Date.now() - startTime}ms`);
      console.log(`Executed ${executedActions.length} actions`);
      console.log(`========== AI TURN END ==========\n`);

      return {
        success: true,
        actions: executedActions,
        turnSummary,
        strategy,
        debugInfo,
      };
    } catch (error) {
      console.error(`========== AI TURN FAILED ==========`);
      console.error(`AI turn execution failed for player ${playerId}:`, error);

      // Return failed result
      return {
        success: false,
        actions: [],
        turnSummary: {
          actions: [],
          cashChange: 0,
          commentary: 'AI turn failed due to an error.',
        },
        strategy: {
          phase: 'error',
          currentGoal: 'Recovery',
          nextGoal: 'Continue playing',
          majorCityProgress: '0/7',
          cashToWin: 250,
        },
        debugInfo: {
          routesEvaluated: 0,
          selectedRouteScore: 0,
          decisionTimeMs: Date.now() - startTime,
          variablesConsidered: [],
        },
      };
    }
  }

  /**
   * Emit the ai:thinking socket event
   */
  private emitThinking(gameId: string, playerId: string): void {
    const payload: AIThinkingPayload = { playerId };
    emitToGame(gameId, 'ai:thinking', payload);
  }

  /**
   * Emit the ai:turn-complete socket event
   */
  private emitTurnComplete(
    gameId: string,
    playerId: string,
    turnSummary: TurnSummary,
    currentStrategy: AIStrategy,
    debug: AIDebugInfo
  ): void {
    const payload: AITurnCompletePayload = {
      playerId,
      turnSummary,
      currentStrategy,
      debug,
    };
    emitToGame(gameId, 'ai:turn-complete', payload);
  }

  /**
   * Retrieve game state and player data from the database
   */
  private async getGameStateAndPlayer(
    gameId: string,
    playerId: string
  ): Promise<{ gameState: AIGameState; player: Player }> {
    // Get all players in the game using correct column names
    const playersResult = await db.query(
      `SELECT
        id, name, color, money, train_type as "trainType",
        position_x, position_y, position_row, position_col,
        loads, hand, user_id, is_ai, ai_difficulty, ai_personality,
        current_turn_number as "turnNumber"
       FROM players
       WHERE game_id = $1
       ORDER BY created_at ASC`,
      [gameId]
    );

    if (playersResult.rows.length === 0) {
      throw new Error('No players found in game');
    }

    const players: Player[] = playersResult.rows.map((row) => {
      // Build trainState from individual position columns
      const hasPosition = row.position_row !== null && row.position_col !== null;
      const trainState = {
        position: hasPosition ? {
          row: row.position_row,
          col: row.position_col,
          x: row.position_x || 0,
          y: row.position_y || 0,
        } : null,
        remainingMovement: 0,
        movementHistory: [],
        loads: row.loads || [],
      };

      // Convert card IDs to full DemandCard objects for AI planning
      const cardIds: number[] = row.hand || [];
      const handCards = cardIds
        .map((cardId: number) => demandDeckService.getCard(cardId))
        .filter((card): card is NonNullable<typeof card> => card !== undefined);

      return {
        id: row.id,
        name: row.name,
        color: row.color,
        money: row.money,
        trainType: row.trainType,
        trainState,
        hand: handCards,
        userId: row.user_id,
        isAI: row.is_ai,
        aiDifficulty: row.ai_difficulty,
        aiPersonality: row.ai_personality,
        turnNumber: row.turnNumber || 1,
      };
    });

    const player = players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error('AI player not found');
    }

    // Get game state
    const gameResult = await db.query(
      `SELECT current_player_index FROM games WHERE id = $1`,
      [gameId]
    );

    if (gameResult.rows.length === 0) {
      throw new Error('Game not found');
    }

    // Calculate global turn number from player turn numbers (use max across all players)
    const turnNumber = Math.max(...players.map(p => p.turnNumber || 1), 1);

    // Get all track segments
    const trackResult = await db.query(
      `SELECT player_id, segments FROM player_tracks WHERE game_id = $1`,
      [gameId]
    );

    const allTrack = new Map<string, any[]>();
    for (const row of trackResult.rows) {
      allTrack.set(row.player_id, row.segments || []);
    }

    // Build available loads map from LoadService configuration
    const { LoadService } = await import('../loadService');
    const loadService = LoadService.getInstance();
    const allLoadStates = await loadService.getAllLoadStates();

    const availableLoads = new Map<string, string[]>();
    for (const loadState of allLoadStates) {
      // For each city that has this load type, add it to the map
      for (const city of loadState.cities) {
        const existing = availableLoads.get(city) || [];
        existing.push(loadState.loadType);
        availableLoads.set(city, existing);
      }
    }

    const gameState: AIGameState = {
      players,
      currentPlayerId: playerId,
      turnNumber,
      availableLoads,
      droppedLoads: [],
      allTrack,
    };

    return { gameState, player };
  }

  /**
   * Apply thinking delay based on difficulty configuration
   */
  private async applyThinkingDelay(config: AIConfig): Promise<void> {
    const delay = config.difficulty.thinkingDelayMs;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Check if a player has track connected to a specific location
   * Returns true if the player's track network reaches the given row/col
   */
  private async hasTrackConnectionTo(
    gameId: string,
    playerId: string,
    targetRow: number,
    targetCol: number
  ): Promise<boolean> {
    // Get player's track
    const trackState = await TrackService.getTrackState(gameId, playerId);
    if (!trackState || !trackState.segments || trackState.segments.length === 0) {
      return false;
    }

    // Check if any segment endpoint touches the target location
    for (const segment of trackState.segments) {
      // Check if either endpoint of the segment is at or near the target
      if (
        (segment.from.row === targetRow && segment.from.col === targetCol) ||
        (segment.to.row === targetRow && segment.to.col === targetCol)
      ) {
        return true;
      }
    }

    // Also check if target is within a major city - major cities have a red area
    // For now, check if any segment connects to a milepost within 1 hex of target
    for (const segment of trackState.segments) {
      const fromDist = Math.abs(segment.from.row - targetRow) + Math.abs(segment.from.col - targetCol);
      const toDist = Math.abs(segment.to.row - targetRow) + Math.abs(segment.to.col - targetCol);
      if (fromDist <= 1 || toDist <= 1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Place AI train at a starting location connected to their track network
   * According to game rules, each player chooses any city to start their train
   * The train MUST be placed at a location connected to the player's track
   */
  private async placeAITrainAtStartingCity(
    gameId: string,
    playerId: string,
    player: Player
  ): Promise<void> {
    // Get player's track to find a connected location
    const trackState = await TrackService.getTrackState(gameId, playerId);

    if (!trackState || !trackState.segments || trackState.segments.length === 0) {
      console.log(`AI ${player.name} cannot place train - no track built yet`);
      return; // Cannot place train without track
    }

    // Find a valid starting point from the track network
    // Prefer major cities if connected, otherwise use any track endpoint
    const majorCities = [
      { name: 'London', row: 10, col: 5 },
      { name: 'Paris', row: 16, col: 9 },
      { name: 'Berlin', row: 12, col: 18 },
      { name: 'Roma', row: 24, col: 18 },
      { name: 'Madrid', row: 24, col: 3 },
      { name: 'Wien', row: 18, col: 21 },
      { name: 'Warszawa', row: 10, col: 24 },
    ];

    // Check if any major city is connected
    let startPosition: { name: string; row: number; col: number } | null = null;

    for (const city of majorCities) {
      if (await this.hasTrackConnectionTo(gameId, playerId, city.row, city.col)) {
        startPosition = city;
        break;
      }
    }

    // If no major city is connected, use the first track segment endpoint
    if (!startPosition && trackState.segments.length > 0) {
      const firstSegment = trackState.segments[0];
      startPosition = {
        name: 'track endpoint',
        row: firstSegment.from.row,
        col: firstSegment.from.col,
      };
    }

    if (!startPosition) {
      console.log(`AI ${player.name} cannot find valid starting position`);
      return;
    }

    // Update the player's train position in the database
    await db.query(
      `UPDATE players
       SET position_row = $1, position_col = $2, position_x = $3, position_y = $4
       WHERE id = $5 AND game_id = $6`,
      [startPosition.row, startPosition.col, 0, 0, playerId, gameId]
    );

    // Update the player object in memory
    player.trainState.position = { row: startPosition.row, col: startPosition.col, x: 0, y: 0 };

    console.log(`AI player ${player.name} placed train at ${startPosition.name} (${startPosition.row}, ${startPosition.col})`);

    // Emit state patch to update clients
    await emitStatePatch(gameId, {
      players: [{
        id: playerId,
        trainState: player.trainState,
      } as any],
    });
  }

  /**
   * Execute the planned actions using game services
   * Validates that actions are legal according to game rules
   */
  private async executeActions(
    gameId: string,
    playerId: string,
    plan: AITurnPlan,
    player: Player
  ): Promise<AIAction[]> {
    const executedActions: AIAction[] = [];
    let cashChange = 0;

    // Check if we're in the initial building phase (turns 1-2)
    const turnNumber = player.turnNumber || 1;
    const isInitialBuildingPhase = turnNumber <= 2;

    console.log(`[executeActions] Starting execution of ${plan.actions.length} planned actions for AI ${playerId}`);
    console.log(`[executeActions] Turn ${turnNumber}, isInitialBuildingPhase: ${isInitialBuildingPhase}`);

    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      console.log(`[executeActions] Action ${i + 1}/${plan.actions.length}: ${action.type} - ${action.description}`);
      console.log(`[executeActions] Action details:`, JSON.stringify(action.details));

      try {
        // During initial building phase, only 'build' and 'pass' actions are allowed
        if (isInitialBuildingPhase && !['build', 'pass'].includes(action.type)) {
          console.log(`[executeActions] Action '${action.type}' BLOCKED - initial building phase (turn ${turnNumber})`);
          continue;
        }

        // During initial building phase, upgrades are not allowed either
        if (isInitialBuildingPhase && action.type === 'upgrade') {
          console.log(`[executeActions] Upgrade BLOCKED - initial building phase (turn ${turnNumber})`);
          continue;
        }

        switch (action.type) {
          case 'build':
            console.log(`[executeActions] Executing BUILD action...`);
            await this.executeBuildAction(gameId, playerId, action, player);
            cashChange -= (action.details.cost as number) || 0;
            console.log(`[executeActions] BUILD completed, cashChange: ${cashChange}`);
            break;

          case 'move':
            console.log(`[executeActions] Executing MOVE action...`);
            await this.executeMoveAction(gameId, playerId, action);
            console.log(`[executeActions] MOVE completed`);
            break;

          case 'pickup':
            console.log(`[executeActions] Executing PICKUP action...`);
            await this.executePickupAction(gameId, playerId, action);
            console.log(`[executeActions] PICKUP completed`);
            break;

          case 'deliver':
            console.log(`[executeActions] Executing DELIVER action...`);
            await this.executeDeliverAction(gameId, playerId, action);
            cashChange += (action.details.payout as number) || 0;
            console.log(`[executeActions] DELIVER completed, cashChange: ${cashChange}`);
            break;

          case 'drop':
            console.log(`[executeActions] Executing DROP action...`);
            await this.executeDropAction(gameId, playerId, action);
            console.log(`[executeActions] DROP completed`);
            break;

          case 'upgrade':
            console.log(`[executeActions] Executing UPGRADE action...`);
            await this.executeUpgradeAction(gameId, playerId, action);
            cashChange -= 20; // Upgrade cost is always 20M
            console.log(`[executeActions] UPGRADE completed, cashChange: ${cashChange}`);
            break;

          default:
            console.log(`[executeActions] Action type '${action.type}' - no execution (pass/unknown)`);
            break;
        }

        executedActions.push(action);
        console.log(`[executeActions] Action ${i + 1} completed successfully`);
      } catch (error) {
        console.error(`[executeActions] FAILED to execute action ${action.type}:`, error);
        // Continue with other actions even if one fails
      }
    }

    console.log(`[executeActions] Finished executing ${executedActions.length}/${plan.actions.length} actions`);

    return executedActions;
  }

  /**
   * Execute a track building action
   * Uses AITrackBuilder to calculate path and build track segments
   */
  private async executeBuildAction(
    gameId: string,
    playerId: string,
    action: AIAction,
    player: Player
  ): Promise<void> {
    const targetRow = action.details.targetRow as number;
    const targetCol = action.details.targetCol as number;

    if (targetRow === undefined || targetCol === undefined) {
      console.log(`AI ${playerId} build skipped - no target coordinates`);
      return;
    }

    console.log(`AI ${playerId} building track towards (${targetRow}, ${targetCol})`);

    // Get current player money
    const moneyResult = await db.query(
      `SELECT money FROM players WHERE id = $1`,
      [playerId]
    );
    const currentMoney = moneyResult.rows[0]?.money || 0;

    // Calculate available budget (max 20M per turn, limited by money)
    const turnBudget = Math.min(20, currentMoney);

    if (turnBudget <= 0) {
      console.log(`AI ${playerId} build skipped - no money (${currentMoney}M)`);
      return;
    }

    // Use AITrackBuilder to calculate path and segments
    const trackBuilder = getAITrackBuilder();
    const result = await trackBuilder.buildTrackToTarget(
      gameId,
      playerId,
      targetRow,
      targetCol,
      turnBudget
    );

    if (!result || result.segments.length === 0) {
      console.log(`AI ${playerId} build skipped - no valid path to (${targetRow}, ${targetCol})`);
      return;
    }

    console.log(`AI ${playerId} building ${result.segments.length} segments for ${result.cost}M`);

    // Get existing track state or create empty one
    let trackState = await TrackService.getTrackState(gameId, playerId);
    if (!trackState) {
      trackState = {
        playerId,
        gameId,
        segments: [],
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      };
    }

    // Add new segments
    trackState.segments.push(...result.segments);
    trackState.totalCost += result.cost;
    trackState.turnBuildCost += result.cost;
    trackState.lastBuildTimestamp = new Date();

    // Save track state
    await TrackService.saveTrackState(gameId, playerId, trackState);

    // Deduct money from player
    const newMoney = currentMoney - result.cost;
    await db.query(
      `UPDATE players SET money = $1 WHERE id = $2`,
      [newMoney, playerId]
    );

    console.log(`AI ${playerId} built track: ${result.cost}M spent, ${newMoney}M remaining`);

    // Emit state patch for money update
    await emitStatePatch(gameId, {
      players: [{
        id: playerId,
        money: newMoney,
      } as any],
    });

    // Emit track:updated event (same as trackRoutes.ts)
    emitToGame(gameId, 'track:updated', {
      gameId,
      playerId,
      timestamp: Date.now(),
    });
  }

  /**
   * Execute a movement action - update train position in database
   * Validates that the AI has track connecting to the destination
   */
  private async executeMoveAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    const destination = action.details.destination as { row: number; col: number } | string;

    // Parse destination - could be object or string like "Budapest"
    let targetRow: number | null = null;
    let targetCol: number | null = null;

    if (typeof destination === 'object' && destination !== null) {
      targetRow = destination.row;
      targetCol = destination.col;
    } else if (typeof destination === 'string') {
      // Look up city coordinates (includes Major, Medium, and Small cities)
      const cityCoords = getCityCoordinates(destination);

      if (cityCoords) {
        targetRow = cityCoords.row;
        targetCol = cityCoords.col;
        console.log(`AI ${playerId} looked up ${destination} (${cityCoords.cityType}) -> row ${targetRow}, col ${targetCol}`);
      } else {
        console.log(`AI ${playerId} move skipped - city "${destination}" not found`);
        return;
      }
    }

    if (targetRow === null || targetCol === null) {
      console.log(`AI ${playerId} move skipped - invalid destination`);
      return;
    }

    // Validate track connectivity - AI must have track to this location
    const hasConnection = await this.hasTrackConnectionTo(gameId, playerId, targetRow, targetCol);
    if (!hasConnection) {
      console.log(`AI ${playerId} move blocked - no track connection to (${targetRow}, ${targetCol})`);
      return;
    }

    // Update position in database
    await db.query(
      `UPDATE players
       SET position_row = $1, position_col = $2
       WHERE id = $3 AND game_id = $4`,
      [targetRow, targetCol, playerId, gameId]
    );

    console.log(`AI ${playerId} moved to row ${targetRow}, col ${targetCol}`);

    // Emit state patch
    await emitStatePatch(gameId, {
      players: [{
        id: playerId,
        trainState: {
          position: { row: targetRow, col: targetCol, x: 0, y: 0 },
        },
      } as any],
    });
  }

  /**
   * Execute a load pickup action - add load to player's train
   * Validates that the AI has track to the source city and their train is there
   */
  private async executePickupAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    const loadType = action.details.loadType as string;
    const sourceCity = action.details.sourceCity as string;

    if (!loadType) {
      console.log(`AI ${playerId} pickup skipped - no load type specified`);
      return;
    }

    // Get current player state including position
    const playerResult = await db.query(
      `SELECT loads, train_type, position_row, position_col FROM players WHERE id = $1`,
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      console.log(`AI ${playerId} pickup failed - player not found`);
      return;
    }

    const row = playerResult.rows[0];
    const currentLoads: string[] = row.loads || [];
    const trainType = row.train_type;
    const trainRow = row.position_row;
    const trainCol = row.position_col;

    // Validate train is positioned (can't pickup without a placed train)
    if (trainRow === null || trainCol === null) {
      console.log(`AI ${playerId} pickup blocked - train not placed yet`);
      return;
    }

    // Validate pickup location matches source city
    if (sourceCity) {
      const cityCoords = getCityCoordinates(sourceCity);
      if (cityCoords) {
        // Check if train is at or near the source city (within 1 hex for city centers)
        const distance = Math.abs(trainRow - cityCoords.row) + Math.abs(trainCol - cityCoords.col);
        if (distance > 1) {
          console.log(`AI ${playerId} pickup blocked - train at (${trainRow},${trainCol}) not at ${sourceCity} (${cityCoords.row},${cityCoords.col})`);
          return;
        }
      }
    }

    // Validate track connection to current position
    const hasConnection = await this.hasTrackConnectionTo(gameId, playerId, trainRow, trainCol);
    if (!hasConnection) {
      console.log(`AI ${playerId} pickup blocked - no track connection to current position (${trainRow}, ${trainCol})`);
      return;
    }

    // Check capacity (Freight/FastFreight = 2, Heavy/Super = 3)
    const capacity = (trainType === 'HeavyFreight' || trainType === 'Superfreight') ? 3 : 2;

    if (currentLoads.length >= capacity) {
      console.log(`AI ${playerId} pickup skipped - train at capacity (${currentLoads.length}/${capacity})`);
      return;
    }

    // Add load to player
    const newLoads = [...currentLoads, loadType];
    await db.query(
      `UPDATE players SET loads = $1 WHERE id = $2`,
      [newLoads, playerId]
    );

    console.log(`AI ${playerId} picked up ${loadType} at ${sourceCity}`);

    // Emit state patch
    await emitStatePatch(gameId, {
      players: [{
        id: playerId,
        trainState: { loads: newLoads },
      } as any],
    });
  }

  /**
   * Execute a delivery action - deliver load, get paid, draw new card
   * Validates that the AI has track to the destination and their train is there
   */
  private async executeDeliverAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    const loadType = action.details.loadType as string;
    const destinationCity = action.details.destinationCity as string;
    const payout = (action.details.payout as number) || 0;
    const cardId = action.details.cardId as number;

    if (!loadType || !payout) {
      console.log(`AI ${playerId} delivery skipped - missing load type or payout`);
      return;
    }

    // Get current player state including position
    const playerResult = await db.query(
      `SELECT money, loads, hand, debt_owed, position_row, position_col FROM players WHERE id = $1`,
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      console.log(`AI ${playerId} delivery failed - player not found`);
      return;
    }

    const row = playerResult.rows[0];
    const currentMoney = row.money || 0;
    const currentLoads: string[] = row.loads || [];
    const currentHand: number[] = row.hand || [];
    const currentDebt = row.debt_owed || 0;
    const trainRow = row.position_row;
    const trainCol = row.position_col;

    // Validate train is positioned (can't deliver without a placed train)
    if (trainRow === null || trainCol === null) {
      console.log(`AI ${playerId} delivery blocked - train not placed yet`);
      return;
    }

    // Validate delivery location matches destination city
    if (destinationCity) {
      const cityCoords = getCityCoordinates(destinationCity);
      if (cityCoords) {
        // Check if train is at or near the destination city (within 1 hex for city centers)
        const distance = Math.abs(trainRow - cityCoords.row) + Math.abs(trainCol - cityCoords.col);
        if (distance > 1) {
          console.log(`AI ${playerId} delivery blocked - train at (${trainRow},${trainCol}) not at ${destinationCity} (${cityCoords.row},${cityCoords.col})`);
          return;
        }
      }
    }

    // Validate track connection to current position
    const hasConnection = await this.hasTrackConnectionTo(gameId, playerId, trainRow, trainCol);
    if (!hasConnection) {
      console.log(`AI ${playerId} delivery blocked - no track connection to current position (${trainRow}, ${trainCol})`);
      return;
    }

    // Check if player has the load
    const loadIndex = currentLoads.indexOf(loadType);
    if (loadIndex === -1) {
      console.log(`AI ${playerId} delivery skipped - doesn't have ${loadType}`);
      return;
    }

    // Remove load from train
    const newLoads = [...currentLoads];
    newLoads.splice(loadIndex, 1);

    // Handle debt repayment (Mercy Rule)
    const repayment = Math.min(payout, currentDebt);
    const netPayment = payout - repayment;
    const newMoney = currentMoney + netPayment;
    const newDebt = currentDebt - repayment;

    // Draw new card if we have a card to replace
    let newHand = currentHand;
    if (cardId && currentHand.includes(cardId)) {
      const newCard = demandDeckService.drawCard();
      if (newCard) {
        newHand = currentHand.map(id => id === cardId ? newCard.id : id);
        demandDeckService.discardCard(cardId);
      }
    }

    // Update database
    await db.query(
      `UPDATE players SET money = $1, loads = $2, hand = $3, debt_owed = $4 WHERE id = $5`,
      [newMoney, newLoads, newHand, newDebt, playerId]
    );

    console.log(`AI ${playerId} delivered ${loadType} to ${destinationCity} for ${payout}M (net: ${netPayment}M after ${repayment}M debt repayment)`);

    // Emit state patch
    await emitStatePatch(gameId, {
      players: [{
        id: playerId,
        money: newMoney,
        trainState: { loads: newLoads },
      } as any],
    });
  }

  /**
   * Execute a load drop action - remove load from train, optionally leave at city
   */
  private async executeDropAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    const loadType = action.details.loadType as string;
    const city = action.details.city as string;

    if (!loadType) {
      console.log(`AI ${playerId} drop skipped - no load type specified`);
      return;
    }

    // Get current loads
    const playerResult = await db.query(
      `SELECT loads FROM players WHERE id = $1`,
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      console.log(`AI ${playerId} drop failed - player not found`);
      return;
    }

    const currentLoads: string[] = playerResult.rows[0].loads || [];
    const loadIndex = currentLoads.indexOf(loadType);

    if (loadIndex === -1) {
      console.log(`AI ${playerId} drop skipped - doesn't have ${loadType}`);
      return;
    }

    // Remove load
    const newLoads = [...currentLoads];
    newLoads.splice(loadIndex, 1);

    await db.query(
      `UPDATE players SET loads = $1 WHERE id = $2`,
      [newLoads, playerId]
    );

    console.log(`AI ${playerId} dropped ${loadType} at ${city || 'current location'}`);

    // Emit state patch
    await emitStatePatch(gameId, {
      players: [{
        id: playerId,
        trainState: { loads: newLoads },
      } as any],
    });
  }

  /**
   * Execute a train upgrade action
   */
  private async executeUpgradeAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    const toTrain = action.details.toTrain as string;
    const fromTrain = action.details.fromTrain as string;
    const cost = 20; // Upgrade always costs 20M

    if (!toTrain) {
      console.log(`AI ${playerId} upgrade skipped - no target train type specified`);
      return;
    }

    // Check if player has enough money
    const moneyCheck = await db.query(
      `SELECT money FROM players WHERE id = $1`,
      [playerId]
    );
    const currentMoney = moneyCheck.rows[0]?.money || 0;

    if (currentMoney < cost) {
      console.log(`AI ${playerId} upgrade skipped - insufficient funds (${currentMoney}M < ${cost}M)`);
      return;
    }

    // Update player train type and money
    await db.query(
      `UPDATE players SET train_type = $1, money = money - $2 WHERE id = $3`,
      [toTrain, cost, playerId]
    );

    console.log(`AI ${playerId} upgraded from ${fromTrain || 'unknown'} to ${toTrain} for ${cost}M`);

    // Emit state patch
    const result = await db.query(
      `SELECT money, train_type FROM players WHERE id = $1`,
      [playerId]
    );
    const row = result.rows[0];

    await emitStatePatch(gameId, {
      players: [{ id: playerId, money: row?.money, trainType: row?.train_type } as any],
    });
  }

  /**
   * Generate turn summary with personality-appropriate commentary
   */
  generateTurnSummary(
    actions: AIAction[],
    personality: AIPersonality,
    plan: AITurnPlan
  ): TurnSummary {
    const commentary = getAICommentary();
    const summaryText = commentary.generateTurnSummary(actions, personality);

    return {
      actions,
      cashChange: plan.expectedCashChange,
      commentary: summaryText,
    };
  }

  /**
   * Generate current strategy information
   */
  private generateStrategy(
    player: Player,
    plan: AITurnPlan,
    gameState: AIGameState
  ): AIStrategy {
    // Count connected major cities (simplified)
    const majorCitiesConnected = 0; // Would need actual calculation

    return {
      phase: this.determinePhase(player),
      currentGoal: plan.reasoning || 'General progress',
      nextGoal: 'Continue building network',
      majorCityProgress: `${majorCitiesConnected}/7`,
      cashToWin: Math.max(0, 250 - player.money),
    };
  }

  /**
   * Determine the current strategic phase based on player state
   */
  private determinePhase(player: Player): string {
    const turnNumber = player.turnNumber || 1;

    if (turnNumber <= 2) {
      return 'Initial Building';
    } else if (player.money < 50) {
      return 'Recovery';
    } else if (player.money >= 200) {
      return 'Victory Push';
    } else {
      return 'Development';
    }
  }

  /**
   * Generate debug information for the turn
   */
  private generateDebugInfo(
    plan: AITurnPlan,
    startTime: number,
    difficulty: AIDifficulty
  ): AIDebugInfo {
    const decisionTimeMs = Date.now() - startTime;
    const config = AI_DIFFICULTY_CONFIG[difficulty];

    // Extract variable names from action details
    const variablesConsidered = new Set<string>();
    for (const action of plan.actions) {
      for (const key of Object.keys(action.details)) {
        variablesConsidered.add(key);
      }
    }

    return {
      routesEvaluated: plan.alternativesConsidered,
      selectedRouteScore: plan.actions.length > 0 ? 1.0 : 0,
      decisionTimeMs,
      variablesConsidered: Array.from(variablesConsidered).slice(0, config.variablesConsidered),
    };
  }
}

// Singleton instance
let instance: AIService | null = null;

export function getAIService(): AIService {
  if (!instance) {
    instance = new AIService();
  }
  return instance;
}
