/**
 * AIStrategyEngine — top-level orchestrator for the bot AI pipeline.
 *
 * Coordinates: WorldSnapshotService → OptionGenerator → Scorer →
 * PlanValidator → TurnExecutor, with retry logic and PassTurn fallback.
 *
 * Each bot turn runs through the full pipeline. If any stage fails,
 * the engine retries with the next-best option (up to 3 times).
 * After all retries are exhausted, it executes a PassTurn to ensure
 * the game always progresses.
 */

import { createHash } from 'crypto';
import { WorldSnapshotService } from './WorldSnapshotService';
import { OptionGenerator } from './OptionGenerator';
import { Scorer } from './Scorer';
import { PlanValidator } from './PlanValidator';
import { TurnExecutor } from './TurnExecutor';
import { BotLogger } from './BotLogger';
import { getSkillProfile } from './config/skillProfiles';
import { getArchetypeProfile } from './config/archetypeProfiles';
import { BotAuditService } from '../services/botAuditService';
import { emitToGame } from '../services/socketService';
import { TrainType } from '../../shared/types/GameTypes';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';
import {
  BotConfig,
  TurnPlan,
  TurnResult,
  StrategyAudit,
  ExecutionResult,
  AIActionType,
  FeasibleOption,
  ScoredOption,
  InfeasibleOption,
  WorldSnapshot,
} from './types';

const MAX_RETRIES = 3;
const logger = new BotLogger('AIStrategyEngine');

/**
 * Compute a short hash from snapshot key fields for audit correlation.
 */
function computeSnapshotHash(snapshot: WorldSnapshot): string {
  const data = JSON.stringify({
    g: snapshot.gameId,
    b: snapshot.botPlayerId,
    m: snapshot.money,
    p: snapshot.position,
    l: snapshot.carriedLoads,
    t: snapshot.trackSegments.length,
  });
  return createHash('md5').update(data).digest('hex').slice(0, 8);
}

/**
 * Reorder scored options based on skill-level randomization.
 *
 * - randomChoicePercent: chance of picking a random option first
 * - suboptimalityPercent: chance of skipping the best option
 */
function selectCandidateOrder(
  scored: ScoredOption[],
  randomChoicePercent: number,
  suboptimalityPercent: number,
): ScoredOption[] {
  if (scored.length <= 1) return [...scored];

  const roll = Math.random() * 100;

  // Random choice: move a random option to the front
  if (roll < randomChoicePercent) {
    const result = [...scored];
    const randomIdx = Math.floor(Math.random() * result.length);
    const [picked] = result.splice(randomIdx, 1);
    result.unshift(picked);
    return result;
  }

  // Suboptimality: swap top two options so the second-best is tried first
  if (roll < randomChoicePercent + suboptimalityPercent) {
    const [best, second, ...rest] = scored;
    return [second, best, ...rest];
  }

  // Optimal: keep scored order (best first)
  return [...scored];
}

/**
 * Build a StrategyAudit record from turn results.
 */
function buildAudit(params: {
  turnNumber: number;
  config: BotConfig;
  snapshotHash: string;
  scored: ScoredOption[];
  infeasible: InfeasibleOption[];
  selectedPlan: FeasibleOption[];
  executionResult: ExecutionResult;
  snapshot: WorldSnapshot | null;
  durationMs: number;
}): StrategyAudit {
  const archetype = getArchetypeProfile(params.config.archetype);

  return {
    turnNumber: params.turnNumber,
    archetypeName: archetype.name,
    skillLevel: params.config.skillLevel,
    snapshotHash: params.snapshotHash,
    currentPlan:
      params.selectedPlan.map((a) => a.description).join('; ') ||
      'PassTurn (no actions)',
    archetypeRationale: `${archetype.name}: ${archetype.description}`,
    feasibleOptions: params.scored,
    rejectedOptions: params.infeasible,
    selectedPlan: params.selectedPlan,
    executionResult: params.executionResult,
    botStatus: params.snapshot
      ? {
          cash: params.snapshot.money,
          trainType: params.snapshot.trainType,
          loads: [...params.snapshot.carriedLoads],
          majorCitiesConnected: params.snapshot.connectedMajorCities,
        }
      : {
          cash: 0,
          trainType: TrainType.Freight,
          loads: [],
          majorCitiesConnected: 0,
        },
    durationMs: params.durationMs,
  };
}

/**
 * Save audit to database, logging any errors without throwing.
 */
async function saveAuditSafe(
  gameId: string,
  playerId: string,
  audit: StrategyAudit,
  log: BotLogger,
): Promise<void> {
  try {
    await BotAuditService.saveTurnAudit(gameId, playerId, audit);
  } catch (err) {
    log.error('Failed to save turn audit', { error: String(err) });
  }
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn through the AI pipeline:
   * Snapshot → Generate → Score → Validate → Execute
   *
   * Retries up to 3 times on validation/execution failure,
   * then falls back to PassTurn.
   *
   * @param gameId - The game ID
   * @param botPlayerId - The bot's player record ID
   * @param botUserId - The bot's user ID
   * @param config - The bot's skill and archetype configuration
   * @param turnNumber - The current turn number (for audit logging)
   */
  static async takeTurn(
    gameId: string,
    botPlayerId: string,
    botUserId: string,
    config: BotConfig,
    turnNumber: number,
  ): Promise<TurnResult> {
    const startTime = Date.now();
    const log = logger.withContext(gameId, botPlayerId);

    // Notify clients that bot turn is starting
    emitToGame(gameId, 'bot:turn-start', { botPlayerId, turnNumber });
    log.info(`Turn ${turnNumber} starting`, {
      skillLevel: config.skillLevel,
      archetype: config.archetype,
    });

    // --- Stage 1: Capture snapshot ---
    let snapshot: WorldSnapshot;
    try {
      snapshot = await WorldSnapshotService.capture(
        gameId,
        botPlayerId,
        botUserId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to capture snapshot: ${message}`);

      const failedExec: ExecutionResult = {
        success: false,
        actionsExecuted: 0,
        error: message,
        durationMs: Date.now() - startTime,
      };
      const audit = buildAudit({
        turnNumber,
        config,
        snapshotHash: '',
        scored: [],
        infeasible: [],
        selectedPlan: [],
        executionResult: failedExec,
        snapshot: null,
        durationMs: Date.now() - startTime,
      });

      await saveAuditSafe(gameId, botPlayerId, audit, log);
      emitToGame(gameId, 'bot:turn-complete', { botPlayerId, audit });
      return { success: false, audit, retriesUsed: 0, fellBackToPass: true };
    }

    const snapshotHash = computeSnapshotHash(snapshot);
    log.debug('Snapshot captured', {
      hash: snapshotHash,
      money: snapshot.money,
      position: snapshot.position,
      loads: snapshot.carriedLoads.length,
    });

    // --- Stage 2: Generate options ---
    const { feasible, infeasible } = OptionGenerator.generate(snapshot);
    log.debug('Options generated', {
      feasible: feasible.length,
      infeasible: infeasible.length,
    });
    if (infeasible.length > 0) {
      log.warn('Infeasible options rejected', {
        reasons: infeasible.map((o) => `${o.type}: ${o.reason}`),
      });
    }

    // --- Stage 3: Score options ---
    const scored = Scorer.score(feasible, snapshot, config);
    log.debug('Options scored', {
      top3: scored
        .slice(0, 3)
        .map((o) => `${o.type}(${o.score.toFixed(1)})`),
    });

    // Apply skill-level randomization to candidate ordering
    const skillProfile = getSkillProfile(config.skillLevel);
    const candidates = selectCandidateOrder(
      scored,
      skillProfile.randomChoicePercent,
      skillProfile.suboptimalityPercent,
    );

    // --- Stages 4 & 5: Validate and Execute with retries ---
    let retriesUsed = 0;

    for (
      let attempt = 0;
      attempt < MAX_RETRIES && attempt < candidates.length;
      attempt++
    ) {
      const selected = candidates[attempt];
      const plan: TurnPlan = { actions: [selected] };

      // Validate the plan against the snapshot
      const validation = PlanValidator.validate(plan, snapshot);
      if (!validation.valid) {
        log.warn(
          `Validation failed (attempt ${attempt + 1}/${MAX_RETRIES})`,
          {
            action: selected.type,
            errors: validation.errors,
          },
        );
        retriesUsed++;
        continue;
      }

      // Execute the plan
      const execResult = await TurnExecutor.execute(plan, snapshot);
      if (execResult.success) {
        log.info(`Turn ${turnNumber} complete`, {
          action: selected.type,
          score: selected.score,
          duration: execResult.durationMs,
          retriesUsed,
        });

        const audit = buildAudit({
          turnNumber,
          config,
          snapshotHash,
          scored,
          infeasible,
          selectedPlan: [selected],
          executionResult: execResult,
          snapshot,
          durationMs: Date.now() - startTime,
        });

        await saveAuditSafe(gameId, botPlayerId, audit, log);
        emitToGame(gameId, 'bot:turn-complete', { botPlayerId, audit });
        return { success: true, audit, retriesUsed, fellBackToPass: false };
      }

      log.warn(`Execution failed (attempt ${attempt + 1}/${MAX_RETRIES})`, {
        action: selected.type,
        error: execResult.error,
      });
      retriesUsed++;
    }

    // --- Fallback: PassTurn ---
    log.error(
      `All retries exhausted (${retriesUsed}), executing PassTurn fallback`,
    );

    const passAction: FeasibleOption = {
      type: AIActionType.PassTurn,
      description: 'PassTurn (fallback — all retries exhausted)',
      feasible: true,
      params: { type: AIActionType.PassTurn },
    };
    const passPlan: TurnPlan = { actions: [passAction] };
    const passResult = await TurnExecutor.execute(passPlan, snapshot);

    const audit = buildAudit({
      turnNumber,
      config,
      snapshotHash,
      scored,
      infeasible,
      selectedPlan: [passAction],
      executionResult: passResult,
      snapshot,
      durationMs: Date.now() - startTime,
    });

    await saveAuditSafe(gameId, botPlayerId, audit, log);
    emitToGame(gameId, 'bot:turn-complete', { botPlayerId, audit });
    return {
      success: passResult.success,
      audit,
      retriesUsed,
      fellBackToPass: true,
    };
  }

  /**
   * Place a bot's train at the best major city based on its demand cards.
   *
   * Called when a bot has no position (first turn or after game start).
   * Evaluates all major cities and picks the one closest to the most
   * demand-card cities (both supply and delivery).
   *
   * @param gameId - The game ID
   * @param botPlayerId - The bot's player record ID
   * @param botUserId - The bot's user ID
   */
  static async placeInitialTrain(
    gameId: string,
    botPlayerId: string,
    botUserId: string,
  ): Promise<{ row: number; col: number; cityName: string }> {
    const log = logger.withContext(gameId, botPlayerId);
    log.info('Placing initial train');

    // Capture snapshot to get demand cards and map data
    const snapshot = await WorldSnapshotService.capture(
      gameId,
      botPlayerId,
      botUserId,
    );

    // Collect all demand cities from bot's cards
    const demandCities = new Set<string>();
    for (const card of snapshot.demandCards) {
      for (const demand of card.demands) {
        demandCities.add(demand.city);
      }
    }

    // Get all major city groups
    const majorCities = getMajorCityGroups();

    // Build a city → position map from map data (all named cities)
    const cityPositions = new Map<string, { row: number; col: number }>();
    for (const mp of snapshot.mapPoints) {
      const cityName = mp.city?.name || mp.name;
      if (cityName && !cityPositions.has(cityName)) {
        cityPositions.set(cityName, { row: mp.row, col: mp.col });
      }
    }

    // Score each major city by proximity to demand cities
    let bestCity = majorCities[0];
    let bestScore = -Infinity;

    for (const mc of majorCities) {
      let score = 0;
      for (const demandCity of demandCities) {
        const pos = cityPositions.get(demandCity);
        if (!pos) continue;
        // Use Manhattan-ish hex distance (rough approximation)
        const dr = Math.abs(mc.center.row - pos.row);
        const dc = Math.abs(mc.center.col - pos.col);
        const distance = dr + dc;
        // Closer is better: inverse distance scoring
        score += 1 / (1 + distance);
      }
      if (score > bestScore) {
        bestScore = score;
        bestCity = mc;
      }
    }

    log.info(`Selected ${bestCity.cityName} for initial placement`, {
      score: bestScore.toFixed(2),
    });

    // Find the grid point to get pixel coordinates (x, y)
    const centerPoint = snapshot.mapPoints.find(
      (p) => p.row === bestCity.center.row && p.col === bestCity.center.col,
    );
    const posX = centerPoint?.x ?? 0;
    const posY = centerPoint?.y ?? 0;

    // Update the player's position in the database (all 4 position columns required)
    const { db } = await import('../db/index');
    await db.query(
      `UPDATE players
       SET position_row = $1, position_col = $2, position_x = $3, position_y = $4
       WHERE game_id = $5 AND id = $6`,
      [bestCity.center.row, bestCity.center.col, posX, posY, gameId, botPlayerId],
    );

    return {
      row: bestCity.center.row,
      col: bestCity.center.col,
      cityName: bestCity.cityName,
    };
  }
}
