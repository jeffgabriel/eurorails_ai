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

      // 2b. If AI has no train position, auto-place at a starting major city
      if (!player.trainState.position) {
        console.log(`No train position - placing at starting city...`);
        await this.placeAITrainAtStartingCity(gameId, playerId, player);
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
   * Place AI train at a starting major city
   * According to game rules, each player chooses any city to start their train
   * For AI, we'll choose a strategic major city based on their demand cards
   */
  private async placeAITrainAtStartingCity(
    gameId: string,
    playerId: string,
    player: Player
  ): Promise<void> {
    // Major cities in EuroRails - good starting positions
    const majorCities = [
      { name: 'London', row: 10, col: 5 },
      { name: 'Paris', row: 16, col: 9 },
      { name: 'Berlin', row: 12, col: 18 },
      { name: 'Roma', row: 24, col: 18 },
      { name: 'Madrid', row: 24, col: 3 },
      { name: 'Wien', row: 18, col: 21 },
      { name: 'Warszawa', row: 10, col: 24 },
    ];

    // Pick a random major city to start (could be made smarter based on demand cards)
    const startCity = majorCities[Math.floor(Math.random() * majorCities.length)];

    // Update the player's train position in the database using individual columns
    await db.query(
      `UPDATE players
       SET position_row = $1, position_col = $2, position_x = $3, position_y = $4
       WHERE id = $5 AND game_id = $6`,
      [startCity.row, startCity.col, 0, 0, playerId, gameId]
    );

    // Update the player object in memory
    player.trainState.position = { row: startCity.row, col: startCity.col, x: 0, y: 0 };

    console.log(`AI player ${player.name} placed train at ${startCity.name} (${startCity.row}, ${startCity.col})`);

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
   */
  private async executeActions(
    gameId: string,
    playerId: string,
    plan: AITurnPlan,
    player: Player
  ): Promise<AIAction[]> {
    const executedActions: AIAction[] = [];
    let cashChange = 0;

    for (const action of plan.actions) {
      try {
        switch (action.type) {
          case 'build':
            await this.executeBuildAction(gameId, playerId, action, player);
            cashChange -= (action.details.cost as number) || 0;
            break;

          case 'move':
            await this.executeMoveAction(gameId, playerId, action);
            break;

          case 'pickup':
            await this.executePickupAction(gameId, playerId, action);
            break;

          case 'deliver':
            await this.executeDeliverAction(gameId, playerId, action);
            cashChange += (action.details.payout as number) || 0;
            break;

          case 'drop':
            await this.executeDropAction(gameId, playerId, action);
            break;

          case 'upgrade':
            await this.executeUpgradeAction(gameId, playerId, action);
            cashChange -= 20; // Upgrade cost is always 20M
            break;

          default:
            // Pass or unknown action - do nothing
            break;
        }

        executedActions.push(action);
      } catch (error) {
        console.error(`Failed to execute AI action ${action.type}:`, error);
        // Continue with other actions even if one fails
      }
    }

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
   * NOTE: This is simplified movement that teleports to destination.
   * Full implementation would need pathfinding and track validation.
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

    // NOTE: This is simplified - it teleports the train without validating track connectivity
    // Full implementation would need to:
    // 1. Check if there's a valid path on player's track
    // 2. Calculate movement cost
    // 3. Pay track usage fees for other players' track
    // For now, we just update position (useful for initial placement)

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

    // Get current loads
    const playerResult = await db.query(
      `SELECT loads, train_type FROM players WHERE id = $1`,
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      console.log(`AI ${playerId} pickup failed - player not found`);
      return;
    }

    const currentLoads: string[] = playerResult.rows[0].loads || [];
    const trainType = playerResult.rows[0].train_type;

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

    // Get current player state
    const playerResult = await db.query(
      `SELECT money, loads, hand, debt_owed FROM players WHERE id = $1`,
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      console.log(`AI ${playerId} delivery failed - player not found`);
      return;
    }

    const currentMoney = playerResult.rows[0].money || 0;
    const currentLoads: string[] = playerResult.rows[0].loads || [];
    const currentHand: number[] = playerResult.rows[0].hand || [];
    const currentDebt = playerResult.rows[0].debt_owed || 0;

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
