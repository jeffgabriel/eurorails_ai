/**
 * GameSimulator -- Headless test harness for multi-turn AI bot simulation.
 *
 * Initializes a mock WorldSnapshot, repeatedly calls AIStrategyEngine.takeTurn(),
 * applies execution results to update mock state, and tracks key metrics.
 *
 * Designed for use in Jest integration tests to validate bot behavior over
 * multiple turns without a live database or socket connections.
 */

import {
  WorldSnapshot,
  AIActionType,
  TrackSegment,
  TerrainType,
  TrainType,
  TRAIN_PROPERTIES,
} from '../../../shared/types/GameTypes';
import { BotTurnResult } from '../../services/ai/AIStrategyEngine';

/** Metrics tracked across simulation turns */
export interface SimulationMetrics {
  deliveryCount: number;
  totalEarnings: number;
  lastAction: AIActionType | null;
  currentBuildTarget: string | null;
  consecutivePassTurns: number;
  totalSegmentsBuilt: number;
  totalTrackCost: number;
  turnCount: number;
  actionHistory: AIActionType[];
  errors: string[];
}

/** Configuration for creating a realistic initial snapshot */
export interface SimulatorConfig {
  gameId?: string;
  botPlayerId?: string;
  botUserId?: string;
  initialMoney?: number;
  trainType?: TrainType;
  initialPosition?: { row: number; col: number } | null;
  initialSegments?: TrackSegment[];
  initialLoads?: string[];
  demandCards?: number[];
  resolvedDemands?: WorldSnapshot['bot']['resolvedDemands'];
  loadAvailability?: Record<string, string[]>;
  allPlayerTracks?: WorldSnapshot['allPlayerTracks'];
  botConfig?: WorldSnapshot['bot']['botConfig'];
}

/** Callback invoked by the simulator to execute a bot turn */
export type TakeTurnFn = (gameId: string, botPlayerId: string) => Promise<BotTurnResult>;

/**
 * Create a realistic initial WorldSnapshot from a config object.
 */
export function createMockSnapshot(config: SimulatorConfig = {}): WorldSnapshot {
  const gameId = config.gameId ?? 'sim-game-001';
  const botPlayerId = config.botPlayerId ?? 'sim-bot-001';

  return {
    gameId,
    gameStatus: 'active',
    turnNumber: 0,
    bot: {
      playerId: botPlayerId,
      userId: config.botUserId ?? 'sim-user-001',
      money: config.initialMoney ?? 50,
      position: config.initialPosition ?? null,
      existingSegments: config.initialSegments ?? [],
      demandCards: config.demandCards ?? [],
      resolvedDemands: config.resolvedDemands ?? [],
      trainType: config.trainType ?? TrainType.Freight,
      loads: config.initialLoads ?? [],
      botConfig: config.botConfig ?? {
        skillLevel: 'medium',
        archetype: 'balanced',
        name: 'TestBot',
      },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: config.allPlayerTracks ?? [
      { playerId: botPlayerId, segments: config.initialSegments ?? [] },
    ],
    loadAvailability: config.loadAvailability ?? {},
  };
}

/**
 * GameSimulator -- runs headless multi-turn bot simulations.
 *
 * Usage:
 *   const sim = new GameSimulator(takeTurnFn);
 *   sim.initialize(createMockSnapshot({ initialMoney: 50 }));
 *   for (let i = 0; i < 10; i++) await sim.runTurn();
 *   const metrics = sim.getMetrics();
 */
export class GameSimulator {
  private snapshot: WorldSnapshot | null = null;
  private metrics: SimulationMetrics = GameSimulator.emptyMetrics();
  private takeTurnFn: TakeTurnFn;

  constructor(takeTurnFn: TakeTurnFn) {
    this.takeTurnFn = takeTurnFn;
  }

  /** Initialize the simulator with a starting world snapshot. */
  initialize(snapshot: WorldSnapshot): void {
    // Deep clone to avoid external mutation
    this.snapshot = JSON.parse(JSON.stringify(snapshot));
    this.metrics = GameSimulator.emptyMetrics();
  }

  /** Get the current world snapshot (deep clone to prevent mutation). */
  getSnapshot(): WorldSnapshot {
    if (!this.snapshot) throw new Error('GameSimulator not initialized');
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  /** Get accumulated simulation metrics. */
  getMetrics(): SimulationMetrics {
    return { ...this.metrics, actionHistory: [...this.metrics.actionHistory], errors: [...this.metrics.errors] };
  }

  /**
   * Run a single bot turn:
   * 1. Call takeTurnFn with current snapshot context
   * 2. Apply the result to update the mock snapshot
   * 3. Track metrics
   */
  async runTurn(): Promise<BotTurnResult> {
    if (!this.snapshot) throw new Error('GameSimulator not initialized');

    const turnNumber = this.metrics.turnCount + 1;
    this.snapshot.turnNumber = turnNumber;

    const result = await this.takeTurnFn(this.snapshot.gameId, this.snapshot.bot.playerId);

    this.applyResult(result);
    this.updateMetrics(result);

    return result;
  }

  /**
   * Run multiple turns in sequence. Stops early if an error occurs.
   * Returns the number of turns successfully completed.
   */
  async runTurns(count: number): Promise<number> {
    let completed = 0;
    for (let i = 0; i < count; i++) {
      const result = await this.runTurn();
      completed++;
      if (!result.success && result.error) break;
    }
    return completed;
  }

  /** Apply a BotTurnResult to update the mock WorldSnapshot. */
  private applyResult(result: BotTurnResult): void {
    if (!this.snapshot) return;

    // Apply movement
    if (result.movedTo) {
      this.snapshot.bot.position = { row: result.movedTo.row, col: result.movedTo.col };
    }

    // Apply track usage fee or build cost deduction
    if (result.cost > 0) {
      this.snapshot.bot.money -= result.cost;
    }

    // Apply segments built
    if (result.segmentsBuilt > 0 && result.action === AIActionType.BuildTrack) {
      // We don't have the actual segments in BotTurnResult, but we track the count
      this.metrics.totalSegmentsBuilt += result.segmentsBuilt;
      this.metrics.totalTrackCost += result.cost;
    }

    // Apply deliveries
    if (result.loadsDelivered) {
      for (const delivery of result.loadsDelivered) {
        this.snapshot.bot.money += delivery.payment;
        // Remove delivered load from bot's loads
        const loadIdx = this.snapshot.bot.loads.indexOf(delivery.loadType);
        if (loadIdx >= 0) this.snapshot.bot.loads.splice(loadIdx, 1);
        // Remove demand card
        const cardIdx = this.snapshot.bot.demandCards.indexOf(delivery.cardId);
        if (cardIdx >= 0) this.snapshot.bot.demandCards.splice(cardIdx, 1);
        // Remove from resolved demands
        this.snapshot.bot.resolvedDemands = this.snapshot.bot.resolvedDemands.filter(
          rd => rd.cardId !== delivery.cardId,
        );
      }
    }

    // Apply pickups
    if (result.loadsPickedUp) {
      for (const pickup of result.loadsPickedUp) {
        const trainType = this.snapshot.bot.trainType as TrainType;
        const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
        if (this.snapshot.bot.loads.length < capacity) {
          this.snapshot.bot.loads.push(pickup.loadType);
        }
      }
    }

    // Apply upgrade (cost already deducted above via result.cost)
    if (result.action === AIActionType.UpgradeTrain) {
      // The actual new train type isn't in BotTurnResult, but cost is applied
    }

    // Ensure money doesn't go below 0 (safety)
    if (this.snapshot.bot.money < 0) this.snapshot.bot.money = 0;

    // Update allPlayerTracks to include any new segments
    const botTrack = this.snapshot.allPlayerTracks.find(pt => pt.playerId === this.snapshot!.bot.playerId);
    if (botTrack) {
      botTrack.segments = this.snapshot.bot.existingSegments;
    }
  }

  /** Update simulation metrics based on the turn result. */
  private updateMetrics(result: BotTurnResult): void {
    this.metrics.turnCount++;
    this.metrics.lastAction = result.action;
    this.metrics.actionHistory.push(result.action);

    if (result.action === AIActionType.PassTurn) {
      this.metrics.consecutivePassTurns++;
    } else {
      this.metrics.consecutivePassTurns = 0;
    }

    if (result.buildTargetCity) {
      this.metrics.currentBuildTarget = result.buildTargetCity;
    }

    if (result.loadsDelivered) {
      this.metrics.deliveryCount += result.loadsDelivered.length;
      for (const d of result.loadsDelivered) {
        this.metrics.totalEarnings += d.payment;
      }
    }

    if (!result.success && result.error) {
      this.metrics.errors.push(`Turn ${this.metrics.turnCount}: ${result.error}`);
    }
  }

  private static emptyMetrics(): SimulationMetrics {
    return {
      deliveryCount: 0,
      totalEarnings: 0,
      lastAction: null,
      currentBuildTarget: null,
      consecutivePassTurns: 0,
      totalSegmentsBuilt: 0,
      totalTrackCost: 0,
      turnCount: 0,
      actionHistory: [],
      errors: [],
    };
  }
}
