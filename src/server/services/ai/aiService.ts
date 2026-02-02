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

    // 1. Emit ai:thinking event to notify clients
    this.emitThinking(gameId, playerId);

    try {
      // 2. Retrieve game state and AI player data
      const { gameState, player } = await this.getGameStateAndPlayer(gameId, playerId);

      if (!player.isAI) {
        throw new Error('Player is not an AI');
      }

      // 3. Load AI configuration
      const difficulty = player.aiDifficulty || 'easy';
      const personality = player.aiPersonality || 'optimizer';
      const config = getAIConfig(difficulty, personality);

      // 4. Add thinking delay based on difficulty
      await this.applyThinkingDelay(config);

      // 5. Plan the turn using AIPlanner
      const planner = getAIPlanner();
      const plan = planner.planTurn(gameState, player, config);

      // 6. Execute the planned actions
      const executedActions = await this.executeActions(gameId, playerId, plan, player);

      // 7. Generate turn summary and strategy
      const turnSummary = this.generateTurnSummary(executedActions, personality, plan);
      const strategy = this.generateStrategy(player, plan, gameState);
      const debugInfo = this.generateDebugInfo(plan, startTime, difficulty);

      // 8. Emit ai:turn-complete event
      this.emitTurnComplete(gameId, playerId, turnSummary, strategy, debugInfo);

      return {
        success: true,
        actions: executedActions,
        turnSummary,
        strategy,
        debugInfo,
      };
    } catch (error) {
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
    // Get all players in the game
    const playersResult = await db.query(
      `SELECT
        id, name, color, money, train_type, train_state, hand,
        user_id, is_ai, ai_difficulty, ai_personality, turn_number
       FROM players
       WHERE game_id = $1
       ORDER BY created_at ASC`,
      [gameId]
    );

    if (playersResult.rows.length === 0) {
      throw new Error('No players found in game');
    }

    const players: Player[] = playersResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      money: row.money,
      trainType: row.train_type,
      trainState: row.train_state || { position: null, remainingMovement: 0, movementHistory: [], loads: [] },
      hand: row.hand || [],
      userId: row.user_id,
      isAI: row.is_ai,
      aiDifficulty: row.ai_difficulty,
      aiPersonality: row.ai_personality,
      turnNumber: row.turn_number,
    }));

    const player = players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error('AI player not found');
    }

    // Get game state
    const gameResult = await db.query(
      `SELECT current_player_index, turn_number FROM games WHERE id = $1`,
      [gameId]
    );

    if (gameResult.rows.length === 0) {
      throw new Error('Game not found');
    }

    const turnNumber = gameResult.rows[0].turn_number || 1;

    // Get all track segments
    const trackResult = await db.query(
      `SELECT player_id, segments FROM player_tracks WHERE game_id = $1`,
      [gameId]
    );

    const allTrack = new Map<string, any[]>();
    for (const row of trackResult.rows) {
      allTrack.set(row.player_id, row.segments || []);
    }

    // Build available loads map (simplified - would need proper load management)
    const availableLoads = new Map<string, string[]>();

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
   */
  private async executeBuildAction(
    gameId: string,
    playerId: string,
    action: AIAction,
    player: Player
  ): Promise<void> {
    const cost = (action.details.cost as number) || 0;

    // Update player money
    await db.query(
      `UPDATE players SET money = money - $1 WHERE id = $2`,
      [cost, playerId]
    );

    // Emit state patch for money change
    await emitStatePatch(gameId, {
      players: [{ id: playerId, money: player.money - cost } as any],
    });

    // Note: Actual track building would require integration with TrackService
    // For now, we just deduct the money
  }

  /**
   * Execute a movement action
   */
  private async executeMoveAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    // Movement would be handled by TrainMovementService
    // For now, this is a placeholder
    console.log(`AI ${playerId} moving to ${action.details.destination}`);
  }

  /**
   * Execute a load pickup action
   */
  private async executePickupAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    // Pickup would be handled by LoadService
    // For now, this is a placeholder
    console.log(`AI ${playerId} picking up ${action.details.loadType} at ${action.details.sourceCity}`);
  }

  /**
   * Execute a delivery action
   */
  private async executeDeliverAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    const payout = (action.details.payout as number) || 0;

    // Update player money
    await db.query(
      `UPDATE players SET money = money + $1 WHERE id = $2`,
      [payout, playerId]
    );

    // Emit state patch
    const result = await db.query(`SELECT money FROM players WHERE id = $1`, [playerId]);
    const newMoney = result.rows[0]?.money || 0;

    await emitStatePatch(gameId, {
      players: [{ id: playerId, money: newMoney } as any],
    });
  }

  /**
   * Execute a load drop action
   */
  private async executeDropAction(
    gameId: string,
    playerId: string,
    action: AIAction
  ): Promise<void> {
    // Drop would be handled by LoadService
    // For now, this is a placeholder
    console.log(`AI ${playerId} dropping ${action.details.loadType} at ${action.details.city}`);
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
    const cost = 20; // Upgrade always costs 20M

    // Update player train type and money
    await db.query(
      `UPDATE players SET train_type = $1, money = money - $2 WHERE id = $3`,
      [toTrain, cost, playerId]
    );

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
