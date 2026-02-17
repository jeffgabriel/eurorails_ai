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
  ResolvedDemand,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import { computeBuildSegments } from './computeBuildSegments';
import { loadGridPoints, GridCoord, getTerrainCost, GridPointData } from './MapTopology';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import {
  buildUnionTrackGraph,
} from '../../../shared/services/trackUsageFees';
import { DemandDeckService } from '../demandDeckService';

const TURN_BUILD_BUDGET = 20; // ECU 20M per turn

/** Hex grid path overhead vs Euclidean distance (paths are longer due to hex grid) */
const SEGMENTS_PER_EUCLIDEAN_UNIT = 1.2;

/** Fallback average cost per track segment when terrain sampling unavailable */
const AVG_COST_PER_SEGMENT = 2.0;

/** Representative ferry port build cost (ECU M) for terrain sampling */
const FERRY_PORT_REPRESENTATIVE_COST = 8;

/** Loyalty bonus multiplier for chains matching the current build target */
const LOYALTY_BONUS_FACTOR = 1.5;

/** Turns on the same target before it's considered stale (loyalty bonus removed) */
const STALE_TARGET_THRESHOLD = 5;

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

/** Compute minimum Euclidean distance between two sets of grid coordinates */
function minEuclidean(from: GridCoord[], to: GridCoord[]): number {
  let min = Infinity;
  for (const f of from) {
    for (const t of to) {
      const dist = Math.sqrt((f.row - t.row) ** 2 + (f.col - t.col) ** 2);
      if (dist < min) min = dist;
    }
  }
  return min === Infinity ? 999 : min;
}

/** Find the closest pair of points between two coordinate sets */
function closestPair(from: GridCoord[], to: GridCoord[]): [GridCoord, GridCoord] | null {
  let minDist = Infinity;
  let best: [GridCoord, GridCoord] | null = null;
  for (const f of from) {
    for (const t of to) {
      const dist = (f.row - t.row) ** 2 + (f.col - t.col) ** 2; // squared is fine for comparison
      if (dist < minDist) {
        minDist = dist;
        best = [f, t];
      }
    }
  }
  return best;
}

/**
 * Sample terrain along the straight line between two grid points and return
 * the average build cost per segment. Catches expensive corridors (Alps at 5M,
 * mountains at 2M, cities at 3-5M, ferry ports at 4-16M) that a flat constant misses.
 */
function sampleAvgTerrainCost(
  from: GridCoord,
  to: GridCoord,
  grid: Map<string, GridPointData>,
): number {
  const dr = to.row - from.row;
  const dc = to.col - from.col;
  const dist = Math.sqrt(dr * dr + dc * dc);
  if (dist < 1) return AVG_COST_PER_SEGMENT;

  // Sample at ~1 hex intervals along the straight line
  const numSamples = Math.max(Math.ceil(dist), 3);
  let totalCost = 0;
  let validSamples = 0;

  for (let i = 1; i <= numSamples; i++) {
    const t = i / numSamples;
    const row = Math.round(from.row + t * dr);
    const col = Math.round(from.col + t * dc);
    const data = grid.get(`${row},${col}`);
    if (!data) continue;
    const cost = getTerrainCost(data.terrain);
    if (cost === Infinity) continue; // skip water hexes
    // Ferry ports return 0 from getTerrainCost; use representative cost
    totalCost += cost === 0 ? FERRY_PORT_REPRESENTATIVE_COST : cost;
    validSamples++;
  }

  return validSamples > 0 ? totalCost / validSamples : AVG_COST_PER_SEGMENT;
}

/** A demand chain: pickup_city → delivery_city for a specific load/card */
interface DemandChain {
  cardId: number;
  loadType: string;
  pickupCity: string;
  deliveryCity: string;
  payment: number;
  pickupTargets: GridCoord[];
  deliveryTargets: GridCoord[];
  chainScore: number;
  hasLoad: boolean;
}

export class OptionGenerator {
  /**
   * Generate feasible options for this bot's turn.
   * During initialBuild phase, only BuildTrack and PassTurn are offered.
   * @param snapshot Current game state snapshot
   * @param actions Optional filter — only generate options for these action types.
   * @param botMemory Optional bot memory for sticky build target logic (loyalty bonus).
   */
  static generate(snapshot: WorldSnapshot, actions?: Set<AIActionType>, botMemory?: BotMemoryState): FeasibleOption[] {
    const options: FeasibleOption[] = [];
    const shouldGen = (a: AIActionType) => !actions || actions.has(a);

    // MoveTrain options (only when active and bot has a position)
    if (shouldGen(AIActionType.MoveTrain) && snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const moveOptions = OptionGenerator.generateMoveOptions(snapshot);
      options.push(...moveOptions);
    }

    // PickupLoad options (only when active and bot has a position)
    if (shouldGen(AIActionType.PickupLoad) && snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const pickupOptions = OptionGenerator.generatePickupOptions(snapshot);
      options.push(...pickupOptions);
    }

    // DeliverLoad options (only when active and bot has a position)
    if (shouldGen(AIActionType.DeliverLoad) && snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const deliveryOptions = OptionGenerator.generateDeliveryOptions(snapshot);
      options.push(...deliveryOptions);
    }

    // DropLoad options (only when active and bot has a position)
    if (shouldGen(AIActionType.DropLoad) && snapshot.gameStatus === 'active' && snapshot.bot.position) {
      const dropOptions = OptionGenerator.generateDropLoadOptions(snapshot);
      options.push(...dropOptions);
    }

    // BuildTrack options
    if (shouldGen(AIActionType.BuildTrack)) {
      const buildOptions = OptionGenerator.generateBuildTrackOptions(snapshot, botMemory);
      options.push(...buildOptions);
    }

    // UpgradeTrain options (only when active)
    if (shouldGen(AIActionType.UpgradeTrain) && snapshot.gameStatus === 'active') {
      const upgradeOptions = OptionGenerator.generateUpgradeTrainOptions(snapshot);
      options.push(...upgradeOptions);
    }

    // DiscardHand option (only when active)
    if (shouldGen(AIActionType.DiscardHand) && snapshot.gameStatus === 'active') {
      const discardOptions = OptionGenerator.generateDiscardHandOption(snapshot);
      options.push(...discardOptions);
    }

    // PassTurn is always available
    if (shouldGen(AIActionType.PassTurn)) {
      options.push(OptionGenerator.generatePassTurnOption());
    }

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
   * Checks train capacity, matches against resolved demand cards, and
   * verifies the delivery destination is reachable on the bot's track network.
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

    // Build reachability set from bot's track network
    const onNetwork = OptionGenerator.buildNetworkSet(snapshot);

    const options: FeasibleOption[] = [];

    for (const loadTypeStr of availableLoads) {
      const loadType = loadTypeStr as LoadType;

      // B2: Don't pick up more of a load type than we have demand cards for.
      // Count demand cards that need this load type, subtract loads already carried.
      const demandCount = snapshot.bot.resolvedDemands.reduce((count, rd) => {
        return count + rd.demands.filter(d => d.loadType === loadTypeStr).length;
      }, 0);
      const carriedCount = snapshot.bot.loads.filter(l => l === loadTypeStr).length;
      if (carriedCount >= demandCount) continue;

      // Find matching demand cards for this load type, preferring reachable destinations
      let bestPayment = 0;
      let bestCity: string | undefined;
      let bestCardId: number | undefined;
      let bestReachable = false;

      for (const rd of snapshot.bot.resolvedDemands) {
        for (const demand of rd.demands) {
          if (demand.loadType !== loadTypeStr) continue;

          // Check if this demand's destination is on the bot's track network
          let reachable = false;
          for (const [key, point] of grid) {
            if (point.name === demand.city && onNetwork.has(key)) {
              reachable = true;
              break;
            }
          }

          // Prefer reachable destinations; among same reachability, prefer higher payment
          if (reachable && !bestReachable) {
            // First reachable demand beats any unreachable one
            bestPayment = demand.payment;
            bestCity = demand.city;
            bestCardId = rd.cardId;
            bestReachable = true;
          } else if (reachable === bestReachable && demand.payment > bestPayment) {
            bestPayment = demand.payment;
            bestCity = demand.city;
            bestCardId = rd.cardId;
          }
        }
      }

      // Generate pickup — reachability is a soft scoring preference, not a hard gate.
      // The bot may need to pick up loads for not-yet-reachable destinations to earn
      // money and expand its network. DropLoad provides an escape valve if stuck.
      if (bestCardId !== undefined) {
        options.push(makeFeasible(AIActionType.PickupLoad, `Pick up ${loadTypeStr} for delivery to ${bestCity}${bestReachable ? '' : ' (aspirational)'}`, {
          loadType,
          targetCity: currentCityName,  // pickup city, not delivery city
          cardId: bestCardId,
          payment: bestPayment,
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

  /**
   * Build a set of all grid positions on the bot's track network.
   * Used for reachability checks in pickup and drop decisions.
   */
  private static buildNetworkSet(snapshot: WorldSnapshot): Set<string> {
    const onNetwork = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      onNetwork.add(`${seg.from.row},${seg.from.col}`);
      onNetwork.add(`${seg.to.row},${seg.to.col}`);
    }
    return onNetwork;
  }

  /**
   * Generate drop load options when the bot is carrying loads it can't deliver.
   * Per game rules: "Any load may be dropped at any city without a payoff."
   * Only offers dropping loads that have NO matching demand card at all (orphaned
   * loads). Loads with a demand card — even if the destination isn't on the
   * network yet — should be kept so the bot can build toward delivery.
   */
  private static generateDropLoadOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    if (snapshot.gameStatus !== 'active') return [];
    if (!snapshot.bot.position) return [];
    if (snapshot.bot.loads.length === 0) return [];

    // Must be at a city to drop
    const grid = loadGridPoints();
    const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    const currentPoint = grid.get(posKey);
    const currentCityName = currentPoint?.name ?? null;
    if (!currentCityName) return [];

    const options: FeasibleOption[] = [];

    for (const loadTypeStr of snapshot.bot.loads) {
      const loadType = loadTypeStr as LoadType;

      // Check if ANY demand card wants this load type (regardless of reachability)
      let hasDemand = false;
      for (const rd of snapshot.bot.resolvedDemands) {
        for (const demand of rd.demands) {
          if (demand.loadType === loadTypeStr) {
            hasDemand = true;
            break;
          }
        }
        if (hasDemand) break;
      }

      if (!hasDemand) {
        options.push(makeFeasible(AIActionType.DropLoad, `Drop ${loadTypeStr} at ${currentCityName} (no demand card)`, {
          loadType,
          targetCity: currentCityName,
        }));
      }
    }

    return options;
  }

  /**
   * Generate BuildTrack options based on demand chain analysis.
   * Uses ranked demand chains to determine which cities to build toward,
   * then computes actual segments via Dijkstra pathfinding.
   * @param snapshot Current game state
   * @param botMemory Optional bot memory — passed to rankDemandChains for sticky target logic
   */
  private static generateBuildTrackOptions(snapshot: WorldSnapshot, botMemory?: BotMemoryState): FeasibleOption[] {
    // Reserve money for track usage fees when game is active (not initialBuild).
    // Without this, the bot spends all money on building and can't move next turn.
    const MOVEMENT_RESERVE = snapshot.gameStatus === 'active' ? 8 : 0;
    const availableMoney = Math.max(0, snapshot.bot.money - MOVEMENT_RESERVE);
    const budget = Math.min(TURN_BUILD_BUDGET, availableMoney);

    // Minimum build budget: don't waste money on micro-stubs (1-2 Clear segments).
    // 5M can build 3-5 Clear segments or 2 Mountains — meaningful progress.
    const MIN_BUILD_BUDGET = 5;
    if (budget < MIN_BUILD_BUDGET) {
      return [makeInfeasible(AIActionType.BuildTrack, `Budget ${budget}M below minimum ${MIN_BUILD_BUDGET}M`)];
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

    // Chain-based build targeting: rank demand chains by completability,
    // then build toward the top chains' pickup or delivery cities.
    const options: FeasibleOption[] = [];
    const seenFirstSegKey = new Set<string>();

    const chains = OptionGenerator.rankDemandChains(snapshot, botMemory);
    const tag = `[BuildGen ${snapshot.gameId.slice(0, 8)}]`;
    if (chains.length > 0) {
      console.log(`${tag} Ranked ${chains.length} demand chains: ${chains.slice(0, 5).map(c => `${c.loadType}@${c.pickupCity}→${c.deliveryCity} score=${c.chainScore.toFixed(2)} pay=${c.payment}`).join(', ')}`);
    }

    for (const chain of chains.slice(0, 3)) {
      // Build toward pickup city (if bot doesn't have the load)
      // Build toward delivery city (if bot already has the load)
      const targets = chain.hasLoad ? chain.deliveryTargets : chain.pickupTargets;
      const segments = computeBuildSegments(
        startPositions, snapshot.bot.existingSegments, budget,
        undefined, occupiedEdges, targets,
      );
      if (segments.length === 0) continue;

      // Dedup by first segment direction
      const dirKey = `${segments[0].to.row},${segments[0].to.col}`;
      if (seenFirstSegKey.has(dirKey)) continue;
      seenFirstSegKey.add(dirKey);

      let totalCost = segments.reduce((sum, s) => sum + s.cost, 0);
      let allSegments = segments;

      // B1: Continuation build — if primary build toward pickup city used less
      // than half the budget, spend the remainder building toward delivery city.
      // Prevents wasting budget when pickup is close (e.g., Szczecin 2 hexes away).
      // Bug A fix: start ONLY from the last primary segment endpoint. Previous
      // version passed all endpoints, so the Dijkstra could start from the FIRST
      // primary segment (nearest to delivery), producing non-contiguous combined
      // segments that PlanValidator rejected.
      if (!chain.hasLoad && totalCost < budget * 0.5 && chain.deliveryTargets.length > 0) {
        const remainingBudget = budget - totalCost;
        const lastSeg = segments[segments.length - 1];
        const contStart = [{ row: lastSeg.to.row, col: lastSeg.to.col }];
        // Pass empty existingSegments so computeBuildSegments uses our explicit
        // contStart (it ignores startPositions when existingSegments is non-empty).
        // The primary segments aren't "built" yet, so re-traversal is harmless —
        // the Dijkstra will naturally prefer forward progress toward delivery.
        const contSegments = computeBuildSegments(
          contStart, [], remainingBudget,
          undefined, occupiedEdges, chain.deliveryTargets,
        );
        if (contSegments.length > 0) {
          allSegments = [...segments, ...contSegments];
          totalCost = allSegments.reduce((sum, s) => sum + s.cost, 0);
        }
      }

      const chainTargetCity = chain.hasLoad ? chain.deliveryCity : chain.pickupCity;
      const segTargetCity = OptionGenerator.identifyTargetCity(allSegments);
      // P3: prefer chain target city for labeling and bot memory. The segment
      // endpoint city is often a random milepost when budget is insufficient to
      // reach the actual target, causing mislabeled options and wrong loyalty bonuses.
      options.push(makeFeasible(AIActionType.BuildTrack, `Build toward ${chainTargetCity ?? segTargetCity} (${chain.loadType}→${chain.deliveryCity}, ${chain.payment}M)`, {
        segments: allSegments,
        estimatedCost: totalCost,
        targetCity: chainTargetCity ?? segTargetCity ?? undefined,
        payment: chain.payment,
        chainScore: chain.chainScore,
      }));
    }

    // Also try with ALL targets combined (may find a direction not covered by individual cards,
    // or provide untargeted building when resolvedDemands is empty).
    const allTargets = OptionGenerator.extractBuildTargets(snapshot);
    const allSegments = computeBuildSegments(
      startPositions, snapshot.bot.existingSegments, budget,
      undefined, occupiedEdges, allTargets.length > 0 ? allTargets : undefined,
    );
    if (allSegments.length > 0) {
      const dirKey = `${allSegments[0].to.row},${allSegments[0].to.col}`;
      if (!seenFirstSegKey.has(dirKey)) {
        const totalCost = allSegments.reduce((sum, s) => sum + s.cost, 0);
        const targetCity = OptionGenerator.identifyTargetCity(allSegments);
        options.push(makeFeasible(AIActionType.BuildTrack, 'Build track', {
          segments: allSegments,
          estimatedCost: totalCost,
          targetCity: targetCity ?? undefined,
        }));
      }
    }

    if (options.length === 0) {
      return [makeInfeasible(AIActionType.BuildTrack, 'No buildable segments found')];
    }
    return options;
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
   * Extract demand-related city grid positions for target-aware track building.
   * Collects delivery targets, pickup source cities, and general demand cities.
   */
  private static extractBuildTargets(snapshot: WorldSnapshot): GridCoord[] {
    const grid = loadGridPoints();
    const demandDeck = DemandDeckService.getInstance();
    const seen = new Set<string>();
    const targets: GridCoord[] = [];

    const addTarget = (row: number, col: number) => {
      const key = `${row},${col}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ row, col });
    };

    // 1. Delivery targets: cities where the bot can deliver loads it's carrying
    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        if (!snapshot.bot.loads.includes(demand.loadType)) continue;
        for (const [, point] of grid) {
          if (point.name === demand.city) addTarget(point.row, point.col);
        }
      }
    }

    // 2. Pickup source cities: cities where loads matching demand cards are available
    for (const [cityName, availableLoads] of Object.entries(snapshot.loadAvailability)) {
      for (const loadTypeStr of availableLoads) {
        for (const rd of snapshot.bot.resolvedDemands) {
          for (const demand of rd.demands) {
            if (demand.loadType === loadTypeStr) {
              for (const [, point] of grid) {
                if (point.name === cityName) addTarget(point.row, point.col);
              }
            }
          }
        }
      }
    }

    // 3. General demand card destination cities
    for (const cardId of snapshot.bot.demandCards) {
      const card = demandDeck.getCard(cardId);
      if (!card) continue;
      for (const demand of card.demands) {
        for (const [, point] of grid) {
          if (point.name === demand.city) addTarget(point.row, point.col);
        }
      }
    }

    return targets;
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

  /**
   * Rank demand chains by completability (payment / total distance).
   * A chain is: pickup_city → delivery_city for a specific load/card.
   * Returns chains sorted best-first so generateBuildTrackOptions targets the top N.
   *
   * When botMemory is provided, applies a loyalty bonus (1.5x chainScore) to chains
   * matching the current build target, unless the target is stale (>= 5 turns).
   * @param snapshot Current game state
   * @param botMemory Optional bot memory for sticky build target loyalty bonus
   */
  private static rankDemandChains(snapshot: WorldSnapshot, botMemory?: BotMemoryState): DemandChain[] {
    const grid = loadGridPoints();

    // Get network positions for distance calculations
    const networkPositions: GridCoord[] = [];
    if (snapshot.bot.existingSegments.length > 0) {
      const seen = new Set<string>();
      for (const seg of snapshot.bot.existingSegments) {
        for (const end of [seg.from, seg.to]) {
          const key = `${end.row},${end.col}`;
          if (!seen.has(key)) {
            seen.add(key);
            networkPositions.push({ row: end.row, col: end.col });
          }
        }
      }
    } else {
      // No track — evaluate each major city as a starting hub.
      // Using ALL outposts makes minEuclidean return ~0 for any chain,
      // causing the highest-payment chain to win regardless of geography.
      // Instead, pick the hub that maximizes the best achievable delivery.
      const groups = getMajorCityGroups();
      let bestHub: GridCoord[] = [];
      let bestHubScore = -Infinity;

      for (const g of groups) {
        const hubPos = g.outposts.map(o => ({ row: o.row, col: o.col }));
        const hubScore = OptionGenerator.evaluateHubScore(hubPos, snapshot, grid);
        if (hubScore > bestHubScore) {
          bestHubScore = hubScore;
          bestHub = hubPos;
        }
      }

      if (bestHub.length > 0) {
        networkPositions.push(...bestHub);
      } else {
        // Fallback: all outposts (no valid chains found)
        for (const g of groups) {
          for (const o of g.outposts) {
            networkPositions.push({ row: o.row, col: o.col });
          }
        }
      }
    }

    const chains: DemandChain[] = [];

    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        const hasLoad = snapshot.bot.loads.includes(demand.loadType);

        // Find delivery city grid points
        const deliveryTargets: GridCoord[] = [];
        for (const [, point] of grid) {
          if (point.name === demand.city) {
            deliveryTargets.push({ row: point.row, col: point.col });
          }
        }
        if (deliveryTargets.length === 0) continue;

        if (hasLoad) {
          // Bot already carries the load — just need to reach delivery city
          const deliveryDist = minEuclidean(networkPositions, deliveryTargets);
          const pair = closestPair(networkPositions, deliveryTargets);
          const avgCost = pair ? sampleAvgTerrainCost(pair[0], pair[1], grid) : AVG_COST_PER_SEGMENT;
          const estimatedBuildCost = deliveryDist * SEGMENTS_PER_EUCLIDEAN_UNIT * avgCost;
          const estimatedBuildTurns = Math.ceil(estimatedBuildCost / TURN_BUILD_BUDGET);
          const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
          const estimatedMoveTurns = Math.ceil(deliveryDist / trainSpeed);
          const totalTurns = estimatedBuildTurns + estimatedMoveTurns;
          let chainScore = demand.payment / Math.max(totalTurns, 1);
          // Budget penalty: proportional — the further over budget, the harder
          // the penalty. (money/cost)² so a 50% overspend gets 0.44x, a 3x
          // overspend gets 0.11x. Prevents the bot from committing to routes
          // it can't afford (e.g., 37M cash vs 60M estimated build cost).
          if (estimatedBuildCost > snapshot.bot.money) {
            const ratio = snapshot.bot.money / estimatedBuildCost;
            chainScore *= ratio * ratio;
          }
          chains.push({
            cardId: rd.cardId,
            loadType: demand.loadType,
            pickupCity: '(carrying)',
            deliveryCity: demand.city,
            payment: demand.payment,
            pickupTargets: [],
            deliveryTargets,
            chainScore,
            hasLoad: true,
          });
        } else {
          // Find the BEST pickup city: minimize total chain distance
          // (network → pickup + pickup → delivery). Previously all cities with the
          // load were included, causing computeBuildSegments to aim at whichever
          // city was cheapest to reach (e.g., Kaliningrad) instead of the one that
          // completes the chain efficiently (e.g., Birmingham near Antwerpen).
          let pickupCityName = '';
          let pickupTargets: GridCoord[] = [];
          let bestChainDist = Infinity;

          for (const [cityName, availableLoads] of Object.entries(snapshot.loadAvailability)) {
            if (!availableLoads.includes(demand.loadType)) continue;

            const cityTargets: GridCoord[] = [];
            for (const [, point] of grid) {
              if (point.name === cityName) {
                cityTargets.push({ row: point.row, col: point.col });
              }
            }
            if (cityTargets.length === 0) continue;

            const toPickup = minEuclidean(networkPositions, cityTargets);
            const toDelivery = minEuclidean(cityTargets, deliveryTargets);
            const totalChainDist = toPickup + toDelivery;

            if (totalChainDist < bestChainDist) {
              bestChainDist = totalChainDist;
              pickupCityName = cityName;
              pickupTargets = cityTargets;
            }
          }
          if (pickupTargets.length === 0) continue;

          const pickupDist = minEuclidean(networkPositions, pickupTargets);
          const chainDist = minEuclidean(pickupTargets, deliveryTargets);
          const deliveryDist = minEuclidean(networkPositions, deliveryTargets);
          const totalDist = pickupDist + chainDist + deliveryDist;
          // Terrain-aware cost: sample terrain along the two main build legs
          const pickupPair = closestPair(networkPositions, pickupTargets);
          const chainPair = closestPair(pickupTargets, deliveryTargets);
          const pickupAvgCost = pickupPair ? sampleAvgTerrainCost(pickupPair[0], pickupPair[1], grid) : AVG_COST_PER_SEGMENT;
          const chainAvgCost = chainPair ? sampleAvgTerrainCost(chainPair[0], chainPair[1], grid) : AVG_COST_PER_SEGMENT;
          const estimatedBuildCost = (pickupDist * pickupAvgCost + (chainDist + deliveryDist) * chainAvgCost) * SEGMENTS_PER_EUCLIDEAN_UNIT;
          const estimatedBuildTurns = Math.ceil(estimatedBuildCost / TURN_BUILD_BUDGET);
          const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
          const estimatedMoveTurns = Math.ceil(totalDist / trainSpeed);
          const totalTurns = estimatedBuildTurns + estimatedMoveTurns;
          let chainScore = demand.payment / Math.max(totalTurns, 1);

          // Budget penalty: proportional — (money/cost)² so chains that are
          // slightly over budget still rank ok, but wildly unaffordable chains
          // drop to near-zero (e.g., 22M cash / 60M cost → 0.13x).
          if (estimatedBuildCost > snapshot.bot.money) {
            const ratio = snapshot.bot.money / estimatedBuildCost;
            chainScore *= ratio * ratio;
          }

          chains.push({
            cardId: rd.cardId,
            loadType: demand.loadType,
            pickupCity: pickupCityName,
            deliveryCity: demand.city,
            payment: demand.payment,
            pickupTargets,
            deliveryTargets,
            chainScore,
            hasLoad: false,
          });
        }
      }
    }

    // Sticky target: apply loyalty bonus to chains matching the current build target,
    // unless the target is stale (too many turns without progress).
    if (botMemory?.currentBuildTarget) {
      const isStale = botMemory.turnsOnTarget >= STALE_TARGET_THRESHOLD;
      if (!isStale) {
        for (const chain of chains) {
          // Match delivery city (if carrying load) or pickup city (if not)
          const targetCity = chain.hasLoad ? chain.deliveryCity : chain.pickupCity;
          if (targetCity === botMemory.currentBuildTarget || chain.deliveryCity === botMemory.currentBuildTarget) {
            chain.chainScore *= LOYALTY_BONUS_FACTOR;
          }
        }
      }
    }

    chains.sort((a, b) => b.chainScore - a.chainScore);
    return chains;
  }

  /**
   * Evaluate a major city hub for starting position quality.
   * Returns the best achievable chain score if the bot starts at this hub.
   * Used by rankDemandChains to pick the optimal starting city when no track exists.
   */
  private static evaluateHubScore(
    hubPositions: GridCoord[],
    snapshot: WorldSnapshot,
    grid: Map<string, GridPointData>,
  ): number {
    let bestScore = 0;

    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        if (snapshot.bot.loads.includes(demand.loadType)) continue;

        const deliveryTargets: GridCoord[] = [];
        for (const [, point] of grid) {
          if (point.name === demand.city) {
            deliveryTargets.push({ row: point.row, col: point.col });
          }
        }
        if (deliveryTargets.length === 0) continue;

        // Best pickup city: minimize hub → pickup + pickup → delivery
        let pickupTargets: GridCoord[] = [];
        let bestChainDist = Infinity;
        for (const [cityName, loads] of Object.entries(snapshot.loadAvailability)) {
          if (!loads.includes(demand.loadType)) continue;
          const cityTargets: GridCoord[] = [];
          for (const [, point] of grid) {
            if (point.name === cityName) {
              cityTargets.push({ row: point.row, col: point.col });
            }
          }
          if (cityTargets.length === 0) continue;
          const toPickup = minEuclidean(hubPositions, cityTargets);
          const toDelivery = minEuclidean(cityTargets, deliveryTargets);
          if (toPickup + toDelivery < bestChainDist) {
            bestChainDist = toPickup + toDelivery;
            pickupTargets = cityTargets;
          }
        }
        if (pickupTargets.length === 0) continue;

        const pickupDist = minEuclidean(hubPositions, pickupTargets);
        const chainDist = minEuclidean(pickupTargets, deliveryTargets);
        const totalDist = pickupDist + chainDist;

        const pickupPair = closestPair(hubPositions, pickupTargets);
        const chainPair = closestPair(pickupTargets, deliveryTargets);
        const pickupAvg = pickupPair ? sampleAvgTerrainCost(pickupPair[0], pickupPair[1], grid) : AVG_COST_PER_SEGMENT;
        const chainAvg = chainPair ? sampleAvgTerrainCost(chainPair[0], chainPair[1], grid) : AVG_COST_PER_SEGMENT;
        const estimatedBuildCost = (pickupDist * pickupAvg + chainDist * chainAvg) * SEGMENTS_PER_EUCLIDEAN_UNIT;

        const estimatedBuildTurns = Math.ceil(estimatedBuildCost / TURN_BUILD_BUDGET);
        const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
        const estimatedMoveTurns = Math.ceil(totalDist / trainSpeed);
        const totalTurns = estimatedBuildTurns + estimatedMoveTurns;
        let chainScore = demand.payment / Math.max(totalTurns, 1);

        if (estimatedBuildCost > snapshot.bot.money) {
          const ratio = snapshot.bot.money / estimatedBuildCost;
          chainScore *= ratio * ratio;
        }

        if (chainScore > bestScore) {
          bestScore = chainScore;
        }
      }
    }

    return bestScore;
  }

  /**
   * P3: Generate upgrade train options when the bot can afford an upgrade.
   * Per game rules, upgrades replace the build phase (costs ECU 20M or 5M for crossgrade).
   */
  private static generateUpgradeTrainOptions(snapshot: WorldSnapshot): FeasibleOption[] {
    const trainType = snapshot.bot.trainType as TrainType;
    const money = snapshot.bot.money;
    const options: FeasibleOption[] = [];

    // Upgrade options (20M, replaces build phase)
    if (money >= 20) {
      if (trainType === TrainType.Freight) {
        options.push(makeFeasible(AIActionType.UpgradeTrain, 'Upgrade to Fast Freight (speed 12)', {
          targetTrainType: TrainType.FastFreight,
          upgradeKind: 'upgrade' as const,
          estimatedCost: 20,
        }));
        options.push(makeFeasible(AIActionType.UpgradeTrain, 'Upgrade to Heavy Freight (capacity 3)', {
          targetTrainType: TrainType.HeavyFreight,
          upgradeKind: 'upgrade' as const,
          estimatedCost: 20,
        }));
      } else if (trainType === TrainType.FastFreight || trainType === TrainType.HeavyFreight) {
        options.push(makeFeasible(AIActionType.UpgradeTrain, 'Upgrade to Superfreight (speed 12, capacity 3)', {
          targetTrainType: TrainType.Superfreight,
          upgradeKind: 'upgrade' as const,
          estimatedCost: 20,
        }));
      }
    }

    // Crossgrade options (5M)
    if (money >= 5) {
      if (trainType === TrainType.FastFreight && snapshot.bot.loads.length <= 3) {
        options.push(makeFeasible(AIActionType.UpgradeTrain, 'Crossgrade to Heavy Freight (capacity 3)', {
          targetTrainType: TrainType.HeavyFreight,
          upgradeKind: 'crossgrade' as const,
          estimatedCost: 5,
        }));
      } else if (trainType === TrainType.HeavyFreight && snapshot.bot.loads.length <= 2) {
        options.push(makeFeasible(AIActionType.UpgradeTrain, 'Crossgrade to Fast Freight (speed 12)', {
          targetTrainType: TrainType.FastFreight,
          upgradeKind: 'crossgrade' as const,
          estimatedCost: 5,
        }));
      }
    }

    return options;
  }

  /**
   * P4: Generate discard hand option. Always available when game is active.
   * Scorer determines when discarding is better than other actions.
   */
  private static generateDiscardHandOption(snapshot: WorldSnapshot): FeasibleOption[] {
    if (snapshot.bot.demandCards.length === 0) return [];
    return [makeFeasible(AIActionType.DiscardHand, 'Discard hand and draw 3 new cards')];
  }
}
