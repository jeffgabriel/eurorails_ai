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
import { loadGridPoints, getHexNeighbors } from '../MapTopology';

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
      TurnValidator.checkCityEntryReservation(steps, snapshot),
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
   * Returns the maximum number of players allowed to build track into the city at (row, col).
   * Consults the gridpoint's maxConnections override first; falls back to terrain-based default.
   * Returns null for terrain types that have no entry cap (Major City, Clear, Mountain, etc.).
   */
  private static cityEntryLimit(row: number, col: number, terrain: TerrainType): number | null {
    if (terrain !== TerrainType.SmallCity && terrain !== TerrainType.MediumCity) return null;

    const grid = loadGridPoints();
    const gridPoint = grid?.get(`${row},${col}`);
    if (gridPoint?.maxConnections !== undefined) return gridPoint.maxConnections;

    return terrain === TerrainType.SmallCity ? 2 : 3;
  }

  /**
   * JIRA-203: Compute the set of grid keys ("row,col") for small and medium cities that are
   * at their player-entry cap for the given bot. Uses the same player-counting logic as
   * checkCityEntryLimit so the resolver and validator stay consistent.
   *
   * A small city (limit 2) is saturated when OTHER players already have track there —
   * adding the bot would push the total above the limit.
   * A medium city (limit 3) is saturated when ≥2 other players already have track there.
   * Cities with a per-city maxConnections override of 1 are saturated when ≥1 other player
   * already has track there.
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

    // Collect cities the bot already touches
    const botTouchedCities = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      botTouchedCities.add(`${seg.from.row},${seg.from.col}`);
      botTouchedCities.add(`${seg.to.row},${seg.to.col}`);
    }

    for (const [key, playerIds] of otherPlayersAtCity) {
      const terrain = terrainLookup.get(key);
      if (terrain === undefined) continue;

      const [rowStr, colStr] = key.split(',');
      const limit = TurnValidator.cityEntryLimit(Number(rowStr), Number(colStr), terrain);
      if (limit === null) continue;

      // Adding the bot would make totalPlayers = playerIds.size + 1
      // It's saturated (for the bot) when playerIds.size + 1 > limit,
      // i.e. playerIds.size >= limit
      if (playerIds.size >= limit) {
        saturated.add(key);
      }
    }

    // R4: Also mark cities saturated when the bot adding one more entry edge would violate
    // the reservation — even if the bot is not yet touching the city.
    // R5: Cities the bot already touches retain player-count semantics only (skip here).
    for (const [key, terrain] of terrainLookup) {
      if (saturated.has(key)) continue; // already saturated by player-count
      if (botTouchedCities.has(key)) continue; // R5: bot already touches — player-count semantics govern

      const [rowStr, colStr] = key.split(',');
      const row = Number(rowStr);
      const col = Number(colStr);
      const limit = TurnValidator.cityEntryLimit(row, col, terrain);
      if (limit === null) continue;

      const otherPlayers = otherPlayersAtCity.get(key);
      const otherCount = otherPlayers ? otherPlayers.size : 0;

      // If bot were to build one entry edge, playersAfter = otherCount + 1
      const playersAfter = otherCount + 1;
      const reservedFor = Math.max(0, limit - playersAfter);

      // How many entry edges remain right now?
      const remaining = TurnValidator.entryEdgesRemaining(row, col, snapshot);

      // Skip cities that have no real entry edges on the map (synthetic/nonexistent cities)
      // or are already fully occupied — bot can't build there regardless.
      if (remaining <= 0) continue;

      // After bot builds one entry, remainingAfterBotEntry = remaining - 1
      const remainingAfterBotEntry = remaining - 1;

      // If the remaining after bot entry is less than what must be reserved, mark saturated
      if (remainingAfterBotEntry < reservedFor) {
        saturated.add(key);
      }
    }

    return saturated;
  }

  /** Medium cities: 3 players max. Small cities: 2 players max. Per-city override applies. */
  private static checkCityEntryLimit(steps: TurnPlan[], snapshot: WorldSnapshot): HardGateResult {
    for (const step of steps) {
      if (step.type === AIActionType.BuildTrack) {
        const buildStep = step as TurnPlanBuildTrack;
        for (const seg of buildStep.segments) {
          const terrain = seg.to.terrain;
          const limit = TurnValidator.cityEntryLimit(seg.to.row, seg.to.col, terrain);
          if (limit === null) continue;

          const toKey = `${seg.to.row},${seg.to.col}`;
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

  /**
   * Count the physical entry edges to the city at (row, col) that no player has yet built.
   * Iterates getHexNeighbors(row, col) and counts neighbors n such that no segment
   * (row,col)↔n exists across snapshot.allPlayerTracks or snapshot.bot.existingSegments.
   */
  private static entryEdgesRemaining(
    row: number,
    col: number,
    snapshot: WorldSnapshot,
    additionalOccupiedEdges?: Set<string>,
  ): number {
    const neighbors = getHexNeighbors(row, col);
    const cityKey = `${row},${col}`;

    // Build a set of occupied edge keys (canonical unordered pair: smaller first)
    const occupiedEdges = new Set<string>();

    const addEdge = (r1: number, c1: number, r2: number, c2: number): void => {
      const k1 = `${r1},${c1}`;
      const k2 = `${r2},${c2}`;
      const edgeKey = k1 <= k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      occupiedEdges.add(edgeKey);
    };

    for (const playerTrack of snapshot.allPlayerTracks) {
      for (const seg of playerTrack.segments) {
        const fromKey = `${seg.from.row},${seg.from.col}`;
        const toKey = `${seg.to.row},${seg.to.col}`;
        if (fromKey === cityKey || toKey === cityKey) {
          addEdge(seg.from.row, seg.from.col, seg.to.row, seg.to.col);
        }
      }
    }

    for (const seg of snapshot.bot.existingSegments) {
      const fromKey = `${seg.from.row},${seg.from.col}`;
      const toKey = `${seg.to.row},${seg.to.col}`;
      if (fromKey === cityKey || toKey === cityKey) {
        addEdge(seg.from.row, seg.from.col, seg.to.row, seg.to.col);
      }
    }

    // Also include edges accumulated during this plan's earlier segments
    if (additionalOccupiedEdges) {
      for (const ek of additionalOccupiedEdges) {
        occupiedEdges.add(ek);
      }
    }

    let remaining = 0;
    for (const nb of neighbors) {
      const k1 = `${row},${col}`;
      const k2 = `${nb.row},${nb.col}`;
      const edgeKey = k1 <= k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (!occupiedEdges.has(edgeKey)) {
        remaining++;
      }
    }
    return remaining;
  }

  /**
   * JIRA-219: Reject a BuildTrack segment into a small/medium city if completing the build
   * would leave fewer remaining entry edges than the number of additional players still
   * allowed to enter that city (the "reservation" for future players).
   *
   * Multi-segment plans are evaluated cumulatively: later segments see the post-earlier-segment
   * edge state.
   */
  private static checkCityEntryReservation(
    steps: TurnPlan[],
    snapshot: WorldSnapshot,
  ): HardGateResult {
    // Track edges consumed within this plan (canonical key → count not needed, just presence)
    const planConsumedEdges = new Set<string>();
    // Track which cities the bot will touch as a result of earlier segments in this plan
    const botWillTouchCity = new Set<string>();

    // Pre-populate botWillTouchCity from existing segments
    for (const seg of snapshot.bot.existingSegments) {
      const fromKey = `${seg.from.row},${seg.from.col}`;
      const toKey = `${seg.to.row},${seg.to.col}`;
      botWillTouchCity.add(fromKey);
      botWillTouchCity.add(toKey);
    }

    for (const step of steps) {
      if (step.type !== AIActionType.BuildTrack) continue;
      const buildStep = step as TurnPlanBuildTrack;

      for (const seg of buildStep.segments) {
        const terrain = seg.to.terrain;
        const limit = TurnValidator.cityEntryLimit(seg.to.row, seg.to.col, terrain);
        if (limit === null) {
          // Not a small/medium city — record the edge and move on
          const k1 = `${seg.from.row},${seg.from.col}`;
          const k2 = `${seg.to.row},${seg.to.col}`;
          const edgeKey = k1 <= k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
          planConsumedEdges.add(edgeKey);
          botWillTouchCity.add(`${seg.to.row},${seg.to.col}`);
          continue;
        }

        const toKey = `${seg.to.row},${seg.to.col}`;

        // Count distinct other players currently at this city
        const otherPlayersAtCity = new Set<string>();
        for (const playerTrack of snapshot.allPlayerTracks) {
          if (playerTrack.playerId === snapshot.bot.playerId) continue;
          for (const existingSeg of playerTrack.segments) {
            const eFromKey = `${existingSeg.from.row},${existingSeg.from.col}`;
            const eToKey = `${existingSeg.to.row},${existingSeg.to.col}`;
            if (eFromKey === toKey || eToKey === toKey) {
              otherPlayersAtCity.add(playerTrack.playerId);
              break;
            }
          }
        }

        // Will the bot touch this city after this segment?
        const botTouchesAfter = true; // the bot is building to it right now

        // How many distinct players will be at the city after this build?
        const playersAfter = otherPlayersAtCity.size + (botTouchesAfter ? 1 : 0);
        // How many more players are still allowed? (reservation for future players)
        const reservedFor = Math.max(0, limit - playersAfter);

        // How many entry edges remain BEFORE this segment is built?
        const remainingBeforeBuild = TurnValidator.entryEdgesRemaining(
          seg.to.row,
          seg.to.col,
          snapshot,
          planConsumedEdges,
        );

        // After we build this segment, one more edge becomes occupied
        const remainingAfterBuild = remainingBeforeBuild - 1;

        if (remainingAfterBuild < reservedFor) {
          return {
            gate: 'CITY_ENTRY_RESERVATION',
            passed: false,
            detail: `Cannot build into ${terrain === TerrainType.SmallCity ? 'small' : 'medium'} city at (${seg.to.row},${seg.to.col}) — would leave ${remainingAfterBuild} entry edge(s) but ${reservedFor} must be reserved for future player(s)`,
          };
        }

        // Record this edge as consumed for later segments in this plan
        const k1 = `${seg.from.row},${seg.from.col}`;
        const k2 = `${seg.to.row},${seg.to.col}`;
        const edgeKey = k1 <= k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        planConsumedEdges.add(edgeKey);
        botWillTouchCity.add(toKey);
      }
    }

    return { gate: 'CITY_ENTRY_RESERVATION', passed: true };
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
