/**
 * TurnValidator — Deterministic validation of composed turn plans against game rules.
 *
 * Sits between TurnComposer (Stage 3b) and GuardrailEnforcer (Stage 4).
 * Validates 7 hard gates. Pure synchronous logic — no LLM calls, no async.
 */

import {
  TurnPlan,
  TurnPlanMultiAction,
  TurnPlanBuildTrack,
  TurnPlanUpgradeTrain,
  TurnPlanDeliverLoad,
  TurnPlanMoveTrain,
  AIActionType,
  WorldSnapshot,
  GameContext,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';
import { getMajorCityLookup } from '../../../shared/services/majorCityGroups';

export interface HardGateResult {
  gate: string;
  passed: boolean;
  detail?: string;
}

export interface TurnValidationResult {
  valid: boolean;
  hardGates: HardGateResult[];
  violation?: string;
}

export class TurnValidator {
  /**
   * Validate a composed turn plan against all hard game-rule gates.
   * Returns the validation result with the first violation detail if any.
   */
  static validate(
    plan: TurnPlan,
    context: GameContext,
    snapshot: WorldSnapshot,
  ): TurnValidationResult {
    const steps = TurnValidator.flattenSteps(plan);

    const gates: HardGateResult[] = [
      TurnValidator.checkBuildUpgradeExclusion(steps),
      TurnValidator.checkPhaseBBudgetCap(steps),
      TurnValidator.checkMajorCityBuildLimit(steps),
      TurnValidator.checkCityEntryLimit(steps, snapshot),
      TurnValidator.checkFerryStopRule(steps, snapshot),
      TurnValidator.checkSameCardDoubleDelivery(steps),
      TurnValidator.checkCashSufficiency(steps, context, snapshot),
    ];

    const firstViolation = gates.find(g => !g.passed);

    return {
      valid: !firstViolation,
      hardGates: gates,
      violation: firstViolation?.detail,
    };
  }

  /** Flatten a plan into its component steps (handles MultiAction). */
  private static flattenSteps(plan: TurnPlan): TurnPlan[] {
    if (plan.type === 'MultiAction') {
      return (plan as TurnPlanMultiAction).steps;
    }
    return [plan];
  }

  /** Phase B cannot contain both BUILD and UPGRADE actions. */
  private static checkBuildUpgradeExclusion(steps: TurnPlan[]): HardGateResult {
    const hasBuild = steps.some(s => s.type === AIActionType.BuildTrack);
    const hasUpgrade = steps.some(s => s.type === AIActionType.UpgradeTrain);

    if (hasBuild && hasUpgrade) {
      return {
        gate: 'BUILD_UPGRADE_EXCLUSION',
        passed: false,
        detail: 'Phase B cannot contain both BUILD and UPGRADE actions — choose one',
      };
    }
    return { gate: 'BUILD_UPGRADE_EXCLUSION', passed: true };
  }

  /** Total Phase B spend must not exceed TURN_BUILD_BUDGET (20M). */
  private static checkPhaseBBudgetCap(steps: TurnPlan[]): HardGateResult {
    let totalSpend = 0;

    for (const step of steps) {
      if (step.type === AIActionType.BuildTrack) {
        const buildStep = step as TurnPlanBuildTrack;
        for (const seg of buildStep.segments) {
          totalSpend += seg.cost;
        }
      } else if (step.type === AIActionType.UpgradeTrain) {
        totalSpend += (step as TurnPlanUpgradeTrain).cost;
      }
    }

    if (totalSpend > TURN_BUILD_BUDGET) {
      return {
        gate: 'PHASE_B_BUDGET_CAP',
        passed: false,
        detail: `Phase B spend ${totalSpend}M exceeds budget cap of ${TURN_BUILD_BUDGET}M`,
      };
    }
    return { gate: 'PHASE_B_BUDGET_CAP', passed: true };
  }

  /** Max 2 track sections from a major city milepost per turn. */
  private static checkMajorCityBuildLimit(steps: TurnPlan[]): HardGateResult {
    const majorCityLookup = getMajorCityLookup();
    const buildFromCounts = new Map<string, number>();

    for (const step of steps) {
      if (step.type === AIActionType.BuildTrack) {
        const buildStep = step as TurnPlanBuildTrack;
        for (const seg of buildStep.segments) {
          const fromKey = `${seg.from.row},${seg.from.col}`;
          if (majorCityLookup.has(fromKey)) {
            const cityName = majorCityLookup.get(fromKey)!;
            buildFromCounts.set(cityName, (buildFromCounts.get(cityName) || 0) + 1);
          }
        }
      }
    }

    for (const [city, count] of Array.from(buildFromCounts.entries())) {
      if (count > 2) {
        return {
          gate: 'MAJOR_CITY_BUILD_LIMIT',
          passed: false,
          detail: `Cannot build more than 2 track sections from major city ${city} in one turn (attempted ${count})`,
        };
      }
    }
    return { gate: 'MAJOR_CITY_BUILD_LIMIT', passed: true };
  }

  /**
   * JIRA-203: Compute the set of grid keys ("row,col") for small and medium cities that are
   * at their player-entry cap for the given bot. Uses the same player-counting logic as
   * checkCityEntryLimit so the resolver and validator stay consistent.
   *
   * A small city (limit 2) is saturated when OTHER players already have track there —
   * adding the bot would push the total above the limit.
   * A medium city (limit 3) is saturated when ≥2 other players already have track there.
   *
   * This shared predicate is the single source of truth for saturation detection.
   * Call this from BuildRouteResolver/ActionResolver to pre-filter Dijkstra paths
   * before the validator ever sees them.
   */
  static computeSaturatedCityKeys(snapshot: WorldSnapshot): Set<string> {
    const saturated = new Set<string>();

    // Collect all small/medium city mileposts that other players touch
    const otherPlayersAtCity = new Map<string, Set<string>>(); // key → set of player IDs

    for (const playerTrack of snapshot.allPlayerTracks) {
      if (playerTrack.playerId === snapshot.bot.playerId) continue;
      for (const seg of playerTrack.segments) {
        for (const endKey of [`${seg.from.row},${seg.from.col}`, `${seg.to.row},${seg.to.col}`]) {
          if (!otherPlayersAtCity.has(endKey)) {
            otherPlayersAtCity.set(endKey, new Set());
          }
          otherPlayersAtCity.get(endKey)!.add(playerTrack.playerId);
        }
      }
    }

    // Now collect grid data to know which keys are small/medium cities
    // We derive terrain from the existing bot segments' terrain field as a lookup;
    // for positions not in existing track, we rely on the allPlayerTracks terrain data.
    // Build a terrain lookup from all known segment endpoints.
    const terrainLookup = new Map<string, TerrainType>();
    for (const playerTrack of snapshot.allPlayerTracks) {
      for (const seg of playerTrack.segments) {
        terrainLookup.set(`${seg.from.row},${seg.from.col}`, seg.from.terrain);
        terrainLookup.set(`${seg.to.row},${seg.to.col}`, seg.to.terrain);
      }
    }
    // Also add bot's own segments
    for (const seg of snapshot.bot.existingSegments) {
      terrainLookup.set(`${seg.from.row},${seg.from.col}`, seg.from.terrain);
      terrainLookup.set(`${seg.to.row},${seg.to.col}`, seg.to.terrain);
    }

    for (const [key, playerIds] of otherPlayersAtCity) {
      const terrain = terrainLookup.get(key);
      if (terrain === undefined) continue;

      const limit = terrain === TerrainType.SmallCity ? 2
        : terrain === TerrainType.MediumCity ? 3
        : null;
      if (limit === null) continue;

      // Adding the bot would make totalPlayers = playerIds.size + 1
      // It's saturated (for the bot) when playerIds.size + 1 > limit,
      // i.e. playerIds.size >= limit
      if (playerIds.size >= limit) {
        saturated.add(key);
      }
    }

    return saturated;
  }

  /** Medium cities: 3 players max. Small cities: 2 players max. */
  private static checkCityEntryLimit(steps: TurnPlan[], snapshot: WorldSnapshot): HardGateResult {
    for (const step of steps) {
      if (step.type === AIActionType.BuildTrack) {
        const buildStep = step as TurnPlanBuildTrack;
        for (const seg of buildStep.segments) {
          const terrain = seg.to.terrain;
          if (terrain !== TerrainType.SmallCity && terrain !== TerrainType.MediumCity) continue;

          const toKey = `${seg.to.row},${seg.to.col}`;
          const limit = terrain === TerrainType.SmallCity ? 2 : 3;
          const label = terrain === TerrainType.SmallCity ? 'small' : 'medium';

          // Count distinct players who already have track to this milepost
          const playersAtCity = new Set<string>();
          for (const playerTrack of snapshot.allPlayerTracks) {
            if (playerTrack.playerId === snapshot.bot.playerId) continue;
            for (const existingSeg of playerTrack.segments) {
              const eFromKey = `${existingSeg.from.row},${existingSeg.from.col}`;
              const eToKey = `${existingSeg.to.row},${existingSeg.to.col}`;
              if (eFromKey === toKey || eToKey === toKey) {
                playersAtCity.add(playerTrack.playerId);
                break;
              }
            }
          }

          // The bot counts as a player too if building there
          const totalPlayers = playersAtCity.size + 1;
          if (totalPlayers > limit) {
            return {
              gate: 'CITY_ENTRY_LIMIT',
              passed: false,
              detail: `Cannot build into ${label} city at (${seg.to.row},${seg.to.col}) — ${limit} player limit reached`,
            };
          }
        }
      }
    }
    return { gate: 'CITY_ENTRY_LIMIT', passed: true };
  }

  /** Must stop at ferry port; cannot move through it in the same turn. */
  private static checkFerryStopRule(steps: TurnPlan[], snapshot: WorldSnapshot): HardGateResult {
    // Build a set of ferry port coordinates from snapshot
    const ferryPorts = new Set<string>();
    if (snapshot.ferryEdges) {
      for (const edge of snapshot.ferryEdges) {
        ferryPorts.add(`${edge.pointA.row},${edge.pointA.col}`);
        ferryPorts.add(`${edge.pointB.row},${edge.pointB.col}`);
      }
    }

    if (ferryPorts.size === 0) return { gate: 'FERRY_STOP_RULE', passed: true };

    for (const step of steps) {
      if (step.type === AIActionType.MoveTrain) {
        const moveStep = step as TurnPlanMoveTrain;
        // Check if any intermediate point (not the last) is a ferry port
        for (let i = 0; i < moveStep.path.length - 1; i++) {
          const key = `${moveStep.path[i].row},${moveStep.path[i].col}`;
          if (ferryPorts.has(key)) {
            return {
              gate: 'FERRY_STOP_RULE',
              passed: false,
              detail: `Train must stop at ferry port (${moveStep.path[i].row},${moveStep.path[i].col}) — cannot pass through`,
            };
          }
        }
      }
    }
    return { gate: 'FERRY_STOP_RULE', passed: true };
  }

  /** No two deliveries from the same demandCardId in one turn. */
  private static checkSameCardDoubleDelivery(steps: TurnPlan[]): HardGateResult {
    const seenCardIds = new Set<number>();

    for (const step of steps) {
      if (step.type === AIActionType.DeliverLoad) {
        const deliverStep = step as TurnPlanDeliverLoad;
        if (seenCardIds.has(deliverStep.cardId)) {
          return {
            gate: 'SAME_CARD_DOUBLE_DELIVERY',
            passed: false,
            detail: `Two deliveries reference the same demand card ${deliverStep.cardId}`,
          };
        }
        seenCardIds.add(deliverStep.cardId);
      }
    }
    return { gate: 'SAME_CARD_DOUBLE_DELIVERY', passed: true };
  }

  /** Cannot build/upgrade without sufficient cash. */
  private static checkCashSufficiency(
    steps: TurnPlan[],
    context: GameContext,
    snapshot: WorldSnapshot,
  ): HardGateResult {
    let phaseBSpend = 0;

    for (const step of steps) {
      if (step.type === AIActionType.BuildTrack) {
        const buildStep = step as TurnPlanBuildTrack;
        for (const seg of buildStep.segments) {
          phaseBSpend += seg.cost;
        }
      } else if (step.type === AIActionType.UpgradeTrain) {
        phaseBSpend += (step as TurnPlanUpgradeTrain).cost;
      }
    }

    // Also account for movement fees in the plan
    let movementFees = 0;
    for (const step of steps) {
      if (step.type === AIActionType.MoveTrain) {
        movementFees += (step as TurnPlanMoveTrain).totalFee;
      }
    }

    // Account for delivery income that executes before builds in the same plan
    let deliveryIncome = 0;
    for (const step of steps) {
      if (step.type === AIActionType.DeliverLoad) {
        deliveryIncome += (step as TurnPlanDeliverLoad).payout;
      }
    }

    const totalCost = phaseBSpend + movementFees;
    const availableCash = snapshot.bot.money + deliveryIncome;
    if (totalCost > availableCash) {
      const incomeNote = deliveryIncome > 0 ? `, delivery income: ${deliveryIncome}M` : '';
      return {
        gate: 'CASH_SUFFICIENCY',
        passed: false,
        detail: `Plan costs ${totalCost}M (build/upgrade: ${phaseBSpend}M, fees: ${movementFees}M) but bot only has ${availableCash}M (cash: ${snapshot.bot.money}M${incomeNote})`,
      };
    }
    return { gate: 'CASH_SUFFICIENCY', passed: true };
  }
}
