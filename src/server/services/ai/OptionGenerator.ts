/**
 * OptionGenerator — Produces feasible action options for the AI bot.
 *
 * Given a WorldSnapshot, generates BuildTrack, MoveTrain and PassTurn options
 * for the Scorer to evaluate.
 */

import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  TrackSegment,
  TerrainType,
  TrainType,
  TRAIN_PROPERTIES,
  TRACK_USAGE_FEE,
} from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import { computeBuildSegments } from './computeBuildSegments';
import { loadGridPoints, GridCoord } from './MapTopology';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import {
  buildUnionTrackGraph,
} from '../../../shared/services/trackUsageFees';
import { DemandDeckService } from '../demandDeckService';

const TURN_BUILD_BUDGET = 20; // ECU 20M per turn

function makeFeasible(
  action: AIActionType,
  reason: string,
  extra?: Partial<FeasibleOption>,
): FeasibleOption {
  return { action, feasible: true, reason, ...extra };
}

function makeInfeasible(
  action: AIActionType,
  reason: string,
): FeasibleOption {
  return { action, feasible: false, reason };
}

export class OptionGenerator {
  /**
   * Generate all feasible options for this bot's turn.
   * During initialBuild phase, only BuildTrack and PassTurn are offered.
   */
  static generate(snapshot: WorldSnapshot): FeasibleOption[] {
    const options: FeasibleOption[] = [];

    // MoveTrain options (only when active and bot has a position)
    if (snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const moveOptions = OptionGenerator.generateMoveOptions(snapshot);
      options.push(...moveOptions);
    }

    // PickupLoad options (only when active and bot has a position)
    if (snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const pickupOptions = OptionGenerator.generatePickupOptions(snapshot);
      options.push(...pickupOptions);
    }

    // DeliverLoad options (only when active and bot has a position)
    if (snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const deliveryOptions = OptionGenerator.generateDeliveryOptions(snapshot);
      options.push(...deliveryOptions);
    }

    // BuildTrack options
    const buildOptions = OptionGenerator.generateBuildTrackOptions(snapshot);
    options.push(...buildOptions);

    // PassTurn is always available
    options.push(OptionGenerator.generatePassTurnOption());

    return options;
  }

  /**
   * Generate movement options for the bot.
   * Finds demand card cities reachable via the union track graph,
   * creates a FeasibleOption for each one with estimated track usage fees.
   */
  private static generateMoveOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    if (!snapshot.bot.position) {
      return [makeInfeasible(AIActionType.MoveTrain, 'No position')];
    }
    if (snapshot.bot.demandCards.length === 0) {
      return [makeInfeasible(AIActionType.MoveTrain, 'No demand cards')];
    }

    // Get train speed from TRAIN_PROPERTIES (halved after ferry crossing)
    const trainType = snapshot.bot.trainType as TrainType;
    const rawSpeed = TRAIN_PROPERTIES[trainType]?.speed ?? 9;
    const speed = snapshot.bot.ferryHalfSpeed ? Math.ceil(rawSpeed / 2) : rawSpeed;

    // Build union track graph from all players' segments
    const allTracks = snapshot.allPlayerTracks.map(pt => ({
      playerId: pt.playerId,
      gameId: snapshot.gameId,
      segments: pt.segments,
      totalCost: 0,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    }));
    const { adjacency, edgeOwners } = buildUnionTrackGraph({ allTracks });

    const startKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    const tag = `[MoveGen ${snapshot.gameId.slice(0, 8)}]`;
    console.log(`${tag} demandCards=${JSON.stringify(snapshot.bot.demandCards)}, startKey=${startKey}, adjacencySize=${adjacency.size}, startNeighbors=${adjacency.get(startKey)?.size ?? 0}`);

    // Collect target positions from the grid: delivery targets, pickup sources, and demand cities.
    // Priority order: delivery cities > pickup source cities > general demand cities.
    const grid = loadGridPoints();
    const demandDeck = DemandDeckService.getInstance();
    const targetCities = new Map<string, { row: number; col: number; cityName: string; payoff: number }>();

    // Determine the city the bot is currently at (if any) to exclude it from targets
    const currentPoint = grid.get(startKey);
    const currentCityName = currentPoint?.name ?? null;

    // 1. Delivery targets: cities where the bot can deliver a load it's carrying
    //    These get the highest payoff boost since delivery = immediate income.
    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        if (currentCityName && demand.city === currentCityName) continue;
        if (!snapshot.bot.loads.includes(demand.loadType)) continue;
        for (const [key, point] of grid) {
          if (point.name === demand.city) {
            const existing = targetCities.get(key);
            // Delivery payoff is boosted to ensure it outranks pickup/general targets
            const boostedPayoff = demand.payment * 2;
            if (!existing || boostedPayoff > existing.payoff) {
              targetCities.set(key, {
                row: point.row,
                col: point.col,
                cityName: demand.city,
                payoff: boostedPayoff,
              });
            }
          }
        }
      }
    }

    // 2. Pickup source cities: cities where a load matching a demand card can be picked up
    const trainType2 = snapshot.bot.trainType as TrainType;
    const hasCapacity = snapshot.bot.loads.length < (TRAIN_PROPERTIES[trainType2]?.capacity ?? 2);
    if (hasCapacity) {
      for (const [cityName, availableLoads] of Object.entries(snapshot.loadAvailability)) {
        if (currentCityName && cityName === currentCityName) continue;
        for (const loadTypeStr of availableLoads) {
          // Check if any demand card wants this load type
          for (const rd of snapshot.bot.resolvedDemands) {
            for (const demand of rd.demands) {
              if (demand.loadType === loadTypeStr) {
                for (const [key, point] of grid) {
                  if (point.name === cityName) {
                    const existing = targetCities.get(key);
                    // Pickup payoff is the eventual demand payment (unboosted)
                    if (!existing || demand.payment > existing.payoff) {
                      targetCities.set(key, {
                        row: point.row,
                        col: point.col,
                        cityName,
                        payoff: demand.payment,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. General demand city targets (original behavior)
    for (const cardId of snapshot.bot.demandCards) {
      const card = demandDeck.getCard(cardId);
      if (!card) { console.log(`${tag} card ${cardId} not found in DemandDeckService`); continue; }
      for (const demand of card.demands) {
        if (currentCityName && demand.city === currentCityName) continue;
        for (const [key, point] of grid) {
          if (point.name === demand.city && !targetCities.has(key)) {
            targetCities.set(key, {
              row: point.row,
              col: point.col,
              cityName: demand.city,
              payoff: demand.payment,
            });
          }
        }
      }
    }

    console.log(`${tag} targetCities=${targetCities.size}: ${Array.from(targetCities.values()).map(t => `${t.cityName}@${t.row},${t.col}`).join(', ')}`);

    if (targetCities.size === 0) {
      return [makeInfeasible(AIActionType.MoveTrain, 'No demand city positions found')];
    }

    // Build set of ferry edge keys — used to truncate movement paths at ferry
    // ports (game rule: movement ends on arrival at ferry port, cross next turn
    // at half speed).  BFS freely traverses ferry edges to discover targets.
    const ferryEdgeList = getFerryEdges();
    const ferryEdgeKeySet = new Set<string>();
    for (const ferry of ferryEdgeList) {
      const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
      const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
      ferryEdgeKeySet.add(`${aKey}|${bKey}`);
      ferryEdgeKeySet.add(`${bKey}|${aKey}`);
    }

    /** Truncate a movement path at the first ferry edge — movement ends at the port. */
    const truncateAtFerryPort = (path: { row: number; col: number }[]): { row: number; col: number }[] => {
      for (let i = 0; i < path.length - 1; i++) {
        const aK = `${path[i].row},${path[i].col}`;
        const bK = `${path[i + 1].row},${path[i + 1].col}`;
        if (ferryEdgeKeySet.has(`${aK}|${bK}`)) {
          return path.slice(0, i + 1); // stop AT the ferry port
        }
      }
      return path;
    };

    // BFS from bot position to find paths to demand cities.
    // Search the full reachable graph (no depth limit) — the bot moves toward
    // a city over multiple turns, so we need to find cities at ANY distance,
    // then truncate the movement path to the train's speed for this turn.
    const options: FeasibleOption[] = [];
    const targetKeys = new Set(targetCities.keys());

    const visited = new Map<string, string | null>(); // key -> parent key
    visited.set(startKey, null);
    let frontier = [startKey];

    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const neighbors = adjacency.get(current);
        if (!neighbors) continue;
        for (const next of neighbors) {
          if (visited.has(next)) continue;
          visited.set(next, current);
          nextFrontier.push(next);

          // Check if this is a demand city
          if (targetKeys.has(next)) {
            const target = targetCities.get(next)!;
            // Reconstruct full path from start to demand city
            const fullPath: { row: number; col: number }[] = [];
            let step: string | null = next;
            while (step !== null) {
              const [r, c] = step.split(',').map(Number);
              fullPath.unshift({ row: r, col: c });
              step = visited.get(step) ?? null;
            }

            // Truncate to train speed, then further truncate at any ferry port
            const speedPath = fullPath.slice(0, speed + 1); // +1 because path includes start
            const movePath = truncateAtFerryPort(speedPath);
            const mileposts = movePath.length - 1;
            if (mileposts === 0) continue; // at ferry port already — handled by handleFerryCrossing

            // Estimate track usage fees on the truncated move path
            const opponentsUsed = new Set<string>();
            for (let i = 0; i < movePath.length - 1; i++) {
              const aKey = `${movePath[i].row},${movePath[i].col}`;
              const bKey = `${movePath[i + 1].row},${movePath[i + 1].col}`;
              const eKey = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
              const owners = edgeOwners.get(eKey);
              if (owners) {
                for (const ownerId of owners) {
                  if (ownerId !== snapshot.bot.playerId) opponentsUsed.add(ownerId);
                }
              }
            }
            const estimatedFee = opponentsUsed.size * TRACK_USAGE_FEE;

            options.push(makeFeasible(AIActionType.MoveTrain, `Move toward ${target.cityName}`, {
              movementPath: movePath,
              targetPosition: { row: target.row, col: target.col },
              mileposts,
              estimatedCost: estimatedFee,
              targetCity: target.cityName,
            }));
          }
        }
      }
      frontier = nextFrontier;
    }

    console.log(`${tag} BFS explored ${visited.size} nodes, found ${options.length} reachable demand cities`);

    // ── Frontier fallback: generate options for UNREACHED targets ────────
    // For any target city NOT directly found by BFS, move to the edge of the
    // reachable network closest to it.  This lets the bot advance toward
    // targets while its track is still being built, and provides alternative
    // options when the only reached city requires unaffordable track fees.
    const reachedTargetKeys = new Set(
      options
        .filter(o => o.targetPosition)
        .map(o => `${o.targetPosition!.row},${o.targetPosition!.col}`),
    );
    const unreachedTargets = [...targetCities.entries()]
      .filter(([key]) => !reachedTargetKeys.has(key));

    if (unreachedTargets.length > 0 && visited.size > 1) {
      const startR = snapshot.bot.position!.row;
      const startC = snapshot.bot.position!.col;
      const seenEndpoints = new Set<string>();
      const frontierOptions: FeasibleOption[] = [];

      for (const [, target] of unreachedTargets) {
        const startDist = (startR - target.row) ** 2 + (startC - target.col) ** 2;
        let bestNodeKey: string | null = null;
        let bestDist = startDist; // must improve on starting distance

        for (const [nodeKey] of visited) {
          if (nodeKey === startKey) continue;
          const [nr, nc] = nodeKey.split(',').map(Number);
          const dist = (nr - target.row) ** 2 + (nc - target.col) ** 2;
          if (dist < bestDist) {
            bestDist = dist;
            bestNodeKey = nodeKey;
          }
        }

        if (!bestNodeKey) continue;

        // Reconstruct path start → bestNode, truncate to speed
        const fullPath: { row: number; col: number }[] = [];
        let step: string | null = bestNodeKey;
        while (step !== null) {
          const [r, c] = step.split(',').map(Number);
          fullPath.unshift({ row: r, col: c });
          step = visited.get(step) ?? null;
        }

        const speedPath = fullPath.slice(0, speed + 1);
        const movePath = truncateAtFerryPort(speedPath);
        const mileposts = movePath.length - 1;
        if (mileposts === 0) continue;

        // Deduplicate: skip if another target already produces same endpoint
        const endKey = `${movePath[mileposts].row},${movePath[mileposts].col}`;
        if (seenEndpoints.has(endKey)) continue;
        seenEndpoints.add(endKey);

        // Track usage fee estimate
        const opponentsUsed = new Set<string>();
        for (let i = 0; i < movePath.length - 1; i++) {
          const aKey = `${movePath[i].row},${movePath[i].col}`;
          const bKey = `${movePath[i + 1].row},${movePath[i + 1].col}`;
          const eKey = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
          const owners = edgeOwners.get(eKey);
          if (owners) {
            for (const ownerId of owners) {
              if (ownerId !== snapshot.bot.playerId) opponentsUsed.add(ownerId);
            }
          }
        }
        const estimatedFee = opponentsUsed.size * TRACK_USAGE_FEE;

        frontierOptions.push(makeFeasible(AIActionType.MoveTrain, `Move toward ${target.cityName} (frontier)`, {
          movementPath: movePath,
          targetPosition: { row: target.row, col: target.col },
          mileposts,
          estimatedCost: estimatedFee,
          targetCity: target.cityName,
        }));
      }

      if (frontierOptions.length > 0) {
        console.log(`${tag} Frontier fallback for ${unreachedTargets.length} unreached targets: ${frontierOptions.map(o => `${o.targetCity}(${o.mileposts}mi, fee=${o.estimatedCost})`).join(', ')}`);
        options.push(...frontierOptions);
      }
    }

    if (options.length === 0) {
      return [makeInfeasible(AIActionType.MoveTrain, 'No demand cities reachable via track network')];
    }

    return options;
  }

  /**
   * Generate pickup options for loads available at the bot's current city.
   * Checks train capacity and matches against resolved demand cards.
   */
  private static generatePickupOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    if (snapshot.gameStatus !== 'active') {
      return [];
    }
    if (!snapshot.bot.position) {
      return [makeInfeasible(AIActionType.PickupLoad, 'No position')];
    }

    const trainType = snapshot.bot.trainType as TrainType;
    const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
    if (snapshot.bot.loads.length >= capacity) {
      return [makeInfeasible(AIActionType.PickupLoad, 'Train at full capacity')];
    }

    // Find what city the bot is currently at
    const grid = loadGridPoints();
    const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    const currentPoint = grid.get(posKey);
    const currentCityName = currentPoint?.name ?? null;

    if (!currentCityName) {
      return [makeInfeasible(AIActionType.PickupLoad, 'Not at a city')];
    }

    // Check load availability at this city
    const availableLoads = snapshot.loadAvailability[currentCityName] ?? [];
    if (availableLoads.length === 0) {
      return [makeInfeasible(AIActionType.PickupLoad, 'No loads available at this city')];
    }

    const options: FeasibleOption[] = [];

    for (const loadTypeStr of availableLoads) {
      const loadType = loadTypeStr as LoadType;

      // Find matching demand cards for this load type
      let bestPayment = 0;
      let bestCity: string | undefined;
      let bestCardId: number | undefined;

      for (const rd of snapshot.bot.resolvedDemands) {
        for (const demand of rd.demands) {
          if (demand.loadType === loadTypeStr && demand.payment > bestPayment) {
            bestPayment = demand.payment;
            bestCity = demand.city;
            bestCardId = rd.cardId;
          }
        }
      }

      if (bestCardId !== undefined) {
        // Load matches a demand card — high-value pickup
        options.push(makeFeasible(AIActionType.PickupLoad, `Pick up ${loadTypeStr} for delivery to ${bestCity}`, {
          loadType,
          targetCity: bestCity,
          cardId: bestCardId,
          payment: bestPayment,
        }));
      } else {
        // Load available but no matching demand — speculative pickup
        options.push(makeFeasible(AIActionType.PickupLoad, `Pick up ${loadTypeStr} (no matching demand)`, {
          loadType,
          targetCity: currentCityName,
        }));
      }
    }

    return options;
  }

  /**
   * Generate delivery options for loads the bot is carrying that match a demand at the current city.
   * Only one option per demand card (highest payment if multiple match).
   */
  private static generateDeliveryOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    if (snapshot.gameStatus !== 'active') {
      return [];
    }
    if (!snapshot.bot.position) {
      return [makeInfeasible(AIActionType.DeliverLoad, 'No position')];
    }
    if (snapshot.bot.loads.length === 0) {
      return [makeInfeasible(AIActionType.DeliverLoad, 'No loads carried')];
    }

    // Find what city the bot is currently at
    const grid = loadGridPoints();
    const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    const currentPoint = grid.get(posKey);
    const currentCityName = currentPoint?.name ?? null;

    if (!currentCityName) {
      return [makeInfeasible(AIActionType.DeliverLoad, 'Not at a city')];
    }

    const options: FeasibleOption[] = [];
    const usedCardIds = new Set<number>();

    // For each demand card, find the best matching load the bot is carrying at this city
    for (const rd of snapshot.bot.resolvedDemands) {
      let bestPayment = 0;
      let bestLoadType: string | undefined;

      for (const demand of rd.demands) {
        if (demand.city !== currentCityName) continue;
        // Check if bot is carrying this load type
        if (!snapshot.bot.loads.includes(demand.loadType)) continue;
        if (demand.payment > bestPayment) {
          bestPayment = demand.payment;
          bestLoadType = demand.loadType;
        }
      }

      if (bestLoadType && !usedCardIds.has(rd.cardId)) {
        usedCardIds.add(rd.cardId);
        options.push(makeFeasible(AIActionType.DeliverLoad, `Deliver ${bestLoadType} to ${currentCityName}`, {
          loadType: bestLoadType as LoadType,
          targetCity: currentCityName,
          cardId: rd.cardId,
          payment: bestPayment,
        }));
      }
    }

    if (options.length === 0) {
      return [makeInfeasible(AIActionType.DeliverLoad, 'No deliverable loads at this city')];
    }

    return options;
  }

  private static generateBuildTrackOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    const budget = Math.min(TURN_BUILD_BUDGET, snapshot.bot.money);
    if (budget <= 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No money to build')];
    }

    const startPositions = OptionGenerator.determineStartPositions(snapshot);
    if (startPositions.length === 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No valid start positions')];
    }

    // Build set of edges owned by other players (Right of Way rule)
    const occupiedEdges = new Set<string>();
    for (const pt of snapshot.allPlayerTracks) {
      if (pt.playerId === snapshot.bot.playerId) continue;
      for (const seg of pt.segments) {
        const a = `${seg.from.row},${seg.from.col}`;
        const b = `${seg.to.row},${seg.to.col}`;
        occupiedEdges.add(`${a}-${b}`);
        occupiedEdges.add(`${b}-${a}`);
      }
    }

    const segments = computeBuildSegments(
      startPositions,
      snapshot.bot.existingSegments,
      budget,
      undefined, // maxSegments default
      occupiedEdges,
    );

    if (segments.length === 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No buildable segments found')];
    }

    const totalCost = segments.reduce((sum, s) => sum + s.cost, 0);
    const targetCity = OptionGenerator.identifyTargetCity(segments);

    return [
      makeFeasible(AIActionType.BuildTrack, 'Build track segments', {
        segments,
        estimatedCost: totalCost,
        targetCity: targetCity ?? undefined,
      }),
    ];
  }

  private static generatePassTurnOption(): FeasibleOption {
    return makeFeasible(AIActionType.PassTurn, 'Always an option');
  }

  /**
   * Determine where the bot can start building from.
   * - If bot has existing track, use all unique positions from those segments.
   * - If no track, use major city center positions.
   */
  private static determineStartPositions(snapshot: WorldSnapshot): GridCoord[] {
    if (snapshot.bot.existingSegments.length > 0) {
      // Extract unique positions from existing track
      const seen = new Set<string>();
      const positions: GridCoord[] = [];
      for (const seg of snapshot.bot.existingSegments) {
        for (const end of [seg.from, seg.to]) {
          const key = `${end.row},${end.col}`;
          if (!seen.has(key)) {
            seen.add(key);
            positions.push({ row: end.row, col: end.col });
          }
        }
      }
      return positions;
    }

    // No track yet — start from major city outposts (centers are fully
    // surrounded by outposts and have no exits to non-city hexes)
    const groups = getMajorCityGroups();
    const positions: GridCoord[] = [];
    for (const g of groups) {
      for (const o of g.outposts) {
        positions.push({ row: o.row, col: o.col });
      }
    }
    return positions;
  }

  /**
   * Check if any segment endpoint is a named city.
   */
  private static identifyTargetCity(segments: TrackSegment[]): string | null {
    const grid = loadGridPoints();
    // Check the last segment's destination first (most likely the target)
    for (let i = segments.length - 1; i >= 0; i--) {
      const to = segments[i].to;
      const point = grid.get(`${to.row},${to.col}`);
      if (point?.name) return point.name;
    }
    return null;
  }
}
