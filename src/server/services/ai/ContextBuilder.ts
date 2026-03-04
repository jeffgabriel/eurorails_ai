/**
 * ContextBuilder — Computes decision-relevant game context for the LLM prompt.
 *
 * Computes reachability, demand feasibility, and
 * opponent context, then serializes into a structured prompt string.
 *
 * All methods are private static (matching AI service conventions).
 */

import {
  WorldSnapshot,
  GameContext,
  DemandContext,
  DeliveryOpportunity,
  PickupOpportunity,
  OpponentContext,
  BotSkillLevel,
  TrackSegment,
  TRAIN_PROPERTIES,
  TrainType,
  GridPoint,
  TerrainType,
  RouteStop,
} from '../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { hexDistance } from './MapTopology';

/** Major cities in the cheap, dense core of the map */
const CORE_CITIES = new Set(['Paris', 'Ruhr', 'Holland', 'Berlin', 'Wien']);

/** Corridor of demands sharing pickup/delivery routes */
interface Corridor {
  demandIndices: number[];
  sharedDeliveryArea: string;
  combinedPayout: number;
  combinedTrackCost: number;
  onTheWayDemands: number[];
}

export class ContextBuilder {
  // Corridor detection thresholds (hex distance)
  private static readonly CORRIDOR_DELIVERY_THRESHOLD = 8;
  private static readonly CORRIDOR_SUPPLY_THRESHOLD = 12;
  private static readonly ON_THE_WAY_THRESHOLD = 5;

  /**
   * Build a GameContext from the WorldSnapshot for LLM prompt generation.
   * Orchestrates all sub-computations using existing shared services.
   */
  static async build(
    snapshot: WorldSnapshot,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
  ): Promise<GameContext> {
    const botPosition = snapshot.bot.position;
    const trainType = snapshot.bot.trainType as TrainType;
    const trainProps = TRAIN_PROPERTIES[trainType];
    const speed = snapshot.bot.ferryHalfSpeed
      ? Math.ceil(trainProps.speed / 2)
      : trainProps.speed;

    // Build the track network from bot's segments
    const network = snapshot.bot.existingSegments.length > 0
      ? buildTrackNetwork(snapshot.bot.existingSegments)
      : null;

    // Compute reachable cities within speed limit
    const reachableCities = botPosition && network
      ? ContextBuilder.computeReachableCities(botPosition, speed, network, gridPoints)
      : [];

    // Compute all cities on the track network (not speed-limited)
    const citiesOnNetwork = network
      ? ContextBuilder.computeCitiesOnNetwork(network, gridPoints)
      : [];

    // Compute connected major cities
    const connectedMajorCities = ContextBuilder.computeConnectedMajorCities(
      snapshot.bot.existingSegments, gridPoints,
    );

    // Compute demand context for each demand card
    const demands = ContextBuilder.computeAllDemandContexts(
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );

    // Compute immediate delivery opportunities
    const canDeliver = ContextBuilder.computeCanDeliver(snapshot, gridPoints);

    // Compute pickup opportunities at current position
    const canPickup = ContextBuilder.computeCanPickup(snapshot, gridPoints);

    // Determine if the bot can upgrade
    const canUpgrade = ContextBuilder.checkCanUpgrade(snapshot);

    // turnBuildCost is not yet on WorldSnapshot — will be added in BE-021.
    // Default to 0 since ContextBuilder runs at the start of the bot's turn.
    const turnBuildCost = (snapshot.bot as { turnBuildCost?: number }).turnBuildCost ?? 0;

    // Determine if the bot can build
    const canBuild = (20 - turnBuildCost) > 0 && snapshot.bot.money > 0;

    // Determine game phase
    const isInitialBuild = snapshot.gameStatus === 'initialBuild';
    const phase = ContextBuilder.computePhase(snapshot, connectedMajorCities);

    // Build opponent context based on skill level
    const opponents = ContextBuilder.buildOpponentContext(
      snapshot.opponents ?? [], skillLevel,
    );

    // Compute track summary
    const trackSummary = ContextBuilder.computeTrackSummary(
      snapshot.bot.existingSegments, gridPoints,
    );

    // Compute unconnected major cities with estimated track costs
    const unconnectedMajorCities = ContextBuilder.computeUnconnectedMajorCities(
      connectedMajorCities,
      snapshot.bot.existingSegments,
      gridPoints,
    );

    return {
      position: botPosition
        ? {
          row: botPosition.row,
          col: botPosition.col,
          city: ContextBuilder.getCityNameAtPosition(botPosition, gridPoints),
        }
        : null,
      money: snapshot.bot.money,
      trainType: snapshot.bot.trainType,
      speed,
      capacity: trainProps.capacity,
      loads: snapshot.bot.loads,
      connectedMajorCities,
      unconnectedMajorCities,
      totalMajorCities: 8,
      trackSummary,
      turnBuildCost,
      demands,
      canDeliver,
      canPickup,
      reachableCities,
      citiesOnNetwork,
      canUpgrade,
      canBuild,
      isInitialBuild,
      opponents,
      phase,
      turnNumber: snapshot.turnNumber,
    };
  }

  // ── Reachable cities (BE-003) ───────────────────────────────────────────

  /**
   * BFS from bot position with depth limit of `speed` mileposts.
   * Returns city names reachable within the speed limit on the existing track network.
   * Halves remaining depth when a ferry node is encountered.
   */
  static computeReachableCities(
    position: { row: number; col: number },
    speed: number,
    network: ReturnType<typeof buildTrackNetwork>,
    gridPoints: GridPoint[],
  ): string[] {
    const startKey = `${position.row},${position.col}`;
    if (!network.nodes.has(startKey)) {
      // Bot position is not on the track network (e.g., at a major city center
      // adjacent to but not directly on own track). Snap to nearest network node.
      let bestKey: string | null = null;
      let bestDist = Infinity;
      for (const nodeKey of Array.from(network.nodes)) {
        const [r, c] = nodeKey.split(',').map(Number);
        const dist = hexDistance(position.row, position.col, r, c);
        if (dist < bestDist) {
          bestDist = dist;
          bestKey = nodeKey;
        }
      }
      // Only snap if the nearest node is within 3 hexes (otherwise bot is truly disconnected)
      if (!bestKey || bestDist > 3) return [];
      const [snapRow, snapCol] = bestKey.split(',').map(Number);
      const adjustedSpeed = Math.max(0, speed - bestDist);
      if (adjustedSpeed <= 0) return [];
      return ContextBuilder.computeReachableCities(
        { row: snapRow, col: snapCol }, adjustedSpeed, network, gridPoints,
      );
    }

    // Build a lookup for grid points by "row,col" key
    const gridLookup = new Map<string, GridPoint>();
    for (const gp of gridPoints) {
      gridLookup.set(`${gp.row},${gp.col}`, gp);
    }

    // BFS with depth tracking — track best remaining speed per node
    const bestRemaining = new Map<string, number>();
    bestRemaining.set(startKey, speed);
    const queue: Array<{ key: string; remaining: number }> = [
      { key: startKey, remaining: speed },
    ];

    const reachableCities: string[] = [];

    // Check if starting position is a city
    const startPoint = gridLookup.get(startKey);
    if (startPoint?.city?.name) {
      reachableCities.push(startPoint.city.name);
    }

    while (queue.length > 0) {
      const { key, remaining } = queue.shift()!;

      const neighbors = network.edges.get(key);
      if (!neighbors) continue;

      for (const neighborKey of Array.from(neighbors)) {
        // Each edge costs 1 milepost of movement
        const neighborPoint = gridLookup.get(neighborKey);
        const isFerry = neighborPoint?.terrain === TerrainType.FerryPort;

        // Ferry halves remaining movement after consuming 1 milepost
        let newRemaining: number;
        if (isFerry) {
          newRemaining = Math.floor((remaining - 1) / 2);
        } else {
          newRemaining = remaining - 1;
        }

        if (newRemaining < 0) continue;

        // Only visit if we arrive with more remaining speed than previously
        const prev = bestRemaining.get(neighborKey);
        if (prev !== undefined && prev >= newRemaining) continue;

        bestRemaining.set(neighborKey, newRemaining);
        queue.push({ key: neighborKey, remaining: newRemaining });

        // Collect city name if this is a city
        if (neighborPoint?.city?.name) {
          reachableCities.push(neighborPoint.city.name);
        }
      }
    }

    // Deduplicate (major cities may have multiple mileposts with the same name)
    return Array.from(new Set(reachableCities));
  }

  // ── Cities on network (not speed-limited) ──────────────────────────────

  /**
   * Compute all city names that have at least one milepost on the bot's track network.
   * Unlike computeReachableCities, this is NOT limited by speed — it shows all cities
   * the bot can eventually reach by moving along its track (multi-turn destinations).
   */
  static computeCitiesOnNetwork(
    network: ReturnType<typeof buildTrackNetwork>,
    gridPoints: GridPoint[],
  ): string[] {
    const cityNames = new Set<string>();
    for (const nodeKey of Array.from(network.nodes)) {
      const point = gridPoints.find(gp => `${gp.row},${gp.col}` === nodeKey);
      if (point?.city?.name) {
        cityNames.add(point.city.name);
      }
    }
    return Array.from(cityNames);
  }

  // ── Load runtime availability (BE-004) ──────────────────────────────────

  /**
   * Count how many copies of a load type are currently carried by any player.
   * Used by both isLoadRuntimeAvailable() and computeDemandContext() for scarcity data.
   */
  private static countCarriedLoads(
    loadType: string,
    snapshot: WorldSnapshot,
  ): number {
    let carriedCount = 0;

    // Count bot's loads
    for (const load of snapshot.bot.loads) {
      if (load === loadType) carriedCount++;
    }

    // Count opponent loads (available for Medium/Hard skill)
    if (snapshot.opponents) {
      for (const opp of snapshot.opponents) {
        for (const load of opp.loads) {
          if (load === loadType) carriedCount++;
        }
      }
    }

    return carriedCount;
  }

  /**
   * Check if any copies of loadType are available (not currently carried by any player).
   * Supplements LoadService.isLoadAvailableAtCity which only checks static config.
   */
  static isLoadRuntimeAvailable(
    loadType: string,
    snapshot: WorldSnapshot,
  ): boolean {
    const carriedCount = ContextBuilder.countCarriedLoads(loadType, snapshot);

    // If no opponent data available (Easy), we can only check the bot's own loads.
    // Optimistically assume at least one copy is available if bot isn't carrying all of them.
    // Load chip counts are typically 3-4 copies per type.
    if (!snapshot.opponents) {
      // Without opponent data, assume available unless the bot alone holds 3+ copies
      return carriedCount < 3;
    }

    // With full opponent data, check against the known total copies.
    // Most loads have 3 copies; loads with 4+ source cities have 4 copies.
    // We use a conservative default of 3 if we can't determine the exact count.
    const totalCopies = ContextBuilder.getLoadTotalCopies(loadType);
    return carriedCount < totalCopies;
  }

  /** Get total load chip count for a load type from configuration defaults */
  private static getLoadTotalCopies(loadType: string): number {
    // Hard-coded defaults from load_cities.json configuration.
    // Loads with 4+ source cities: Beer(4), Cheese(4), Machinery(4), Oil(4), Wine(4).
    // All others: 3 copies.
    const fourCopyLoads = ['Beer', 'Cheese', 'Machinery', 'Oil', 'Wine'];
    return fourCopyLoads.includes(loadType) ? 4 : 3;
  }

  // ── Build affordability (BE-001) ────────────────────────────────────────

  /**
   * Check if a build target is achievable with current cash plus projected
   * delivery income from carried loads. Also flags negative ROI builds
   * where track cost exceeds payout.
   */
  static isBuildAffordable(
    estimatedTrackCost: number,
    botMoney: number,
    carriedLoads: string[],
    resolvedDemands: WorldSnapshot['bot']['resolvedDemands'],
    payout: number,
  ): { affordable: boolean; projectedFunds: number } {
    // Calculate projected income from currently carried loads
    let projectedIncome = 0;
    for (const loadType of carriedLoads) {
      // Find matching demand for this carried load
      for (const resolved of resolvedDemands) {
        for (const demand of resolved.demands) {
          if (demand.loadType === loadType) {
            projectedIncome += demand.payment;
            break; // Only count one demand per carried load instance
          }
        }
      }
    }
    const projectedFunds = botMoney + projectedIncome;

    // Negative ROI check: track cost exceeds payout
    if (estimatedTrackCost > payout) {
      return { affordable: false, projectedFunds };
    }

    // Affordability check: can bot afford the build with projected funds?
    const affordable = estimatedTrackCost <= projectedFunds;
    return { affordable, projectedFunds };
  }

  // ── Demand context (BE-005) ─────────────────────────────────────────────

  /**
   * Pre-compute reachability and cost estimates for a single demand.
   * Uses the string-based track network and gridPoints for all lookups.
   */
  private static computeDemandContext(
    cardIndex: number,
    demand: { city: string; loadType: string; payment: number },
    snapshot: WorldSnapshot,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    reachableCities: string[],
    citiesOnNetwork: string[],
    connectedMajorCities: string[],
  ): DemandContext {
    const deliveryCity = demand.city;
    const loadType = demand.loadType;

    // 1. Find the best supply city for this load type from gridPoints
    const supplyCity = ContextBuilder.findBestSupplyCity(
      loadType, network, gridPoints, snapshot.bot.existingSegments,
    );

    // 2. Check if the load is already on the bot's train
    const isLoadOnTrain = snapshot.bot.loads.includes(loadType);

    // 3. Check reachability — is the city in the reachable cities list?
    const isSupplyReachable = supplyCity ? reachableCities.includes(supplyCity) : false;
    const isDeliveryReachable = reachableCities.includes(deliveryCity);

    // 4. Check if the city is on the network at all (connected but maybe not
    //    reachable this turn due to speed). Used for cost estimation.
    const isSupplyOnNetwork = supplyCity
      ? ContextBuilder.isCityOnNetwork(supplyCity, network, gridPoints)
      : false;
    const isDeliveryOnNetwork = ContextBuilder.isCityOnNetwork(
      deliveryCity, network, gridPoints,
    );

    // 5. Estimate track cost to reach cities not on the network
    const estimatedTrackCostToSupply = isSupplyOnNetwork || !supplyCity || isLoadOnTrain
      ? 0
      : ContextBuilder.estimateTrackCost(supplyCity, snapshot.bot.existingSegments, gridPoints);
    // For cold-start (no track), estimate delivery cost from supply city to delivery city
    // (not from "nearest major city" to delivery, which can be misleading).
    const estimatedTrackCostToDelivery = isDeliveryOnNetwork
      ? 0
      : ContextBuilder.estimateTrackCost(
          deliveryCity, snapshot.bot.existingSegments, gridPoints,
          snapshot.bot.existingSegments.length === 0 ? supplyCity ?? undefined : undefined,
        );

    // 6. Check runtime load availability
    const isLoadAvailable = ContextBuilder.isLoadRuntimeAvailable(loadType, snapshot);

    // 7. Check if a ferry is required to reach supply or delivery
    const ferryRequired = ContextBuilder.isFerryOnRoute(
      supplyCity, deliveryCity, gridPoints,
    );

    // 8. Load chip scarcity data
    const totalCopies = ContextBuilder.getLoadTotalCopies(loadType);
    const carriedCount = ContextBuilder.countCarriedLoads(loadType, snapshot);

    // 9. Turn estimate: build turns + travel turns + 1 (for pickup/deliver)
    const totalTrackCost = estimatedTrackCostToSupply + estimatedTrackCostToDelivery;
    const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType].speed;
    const buildTurns = totalTrackCost > 0 ? Math.ceil(totalTrackCost / 20) : 0;

    // Travel distance: hex distance from supply city to delivery city
    let travelTurns = 0;
    if (supplyCity) {
      const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
      const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
      if (supplyPoints.length > 0 && deliveryPoints.length > 0) {
        let minDist = Infinity;
        for (const sp of supplyPoints) {
          for (const dp of deliveryPoints) {
            const dist = hexDistance(sp.row, sp.col, dp.row, dp.col);
            minDist = Math.min(minDist, dist);
          }
        }
        if (minDist < Infinity) {
          travelTurns = Math.ceil(minDist / speed);
        }
      }
    }
    const estimatedTurns = buildTurns + travelTurns + 1;

    // 10. Compute corridor value and demand score (JIRA-13)
    const corridorValue = ContextBuilder.computeCorridorValue(
      supplyCity, deliveryCity,
      snapshot.bot.existingSegments, gridPoints, connectedMajorCities,
    );
    const demandScore = ContextBuilder.scoreDemand(
      demand.payment, totalTrackCost,
      corridorValue.networkCities, corridorValue.victoryMajorCities,
      estimatedTurns,
    );
    const efficiencyPerTurn = (demand.payment - totalTrackCost) / estimatedTurns;

    // 11. Build affordability check (BE-001)
    const affordability = ContextBuilder.isBuildAffordable(
      totalTrackCost, snapshot.bot.money,
      snapshot.bot.loads, snapshot.bot.resolvedDemands,
      demand.payment,
    );

    return {
      cardIndex,
      loadType,
      supplyCity: supplyCity ?? 'Unknown',
      deliveryCity,
      payout: demand.payment,
      isSupplyReachable,
      isDeliveryReachable,
      isSupplyOnNetwork: supplyCity ? citiesOnNetwork.includes(supplyCity) : false,
      isDeliveryOnNetwork: citiesOnNetwork.includes(deliveryCity),
      estimatedTrackCostToSupply,
      estimatedTrackCostToDelivery,
      isLoadAvailable,
      isLoadOnTrain,
      ferryRequired,
      loadChipTotal: totalCopies,
      loadChipCarried: carriedCount,
      estimatedTurns,
      demandScore,
      efficiencyPerTurn,
      networkCitiesUnlocked: corridorValue.networkCities,
      victoryMajorCitiesEnRoute: corridorValue.victoryMajorCities,
      isAffordable: affordability.affordable,
      projectedFundsAfterDelivery: affordability.projectedFunds,
    };
  }

  // ── Opponent context (BE-006) ───────────────────────────────────────────

  /**
   * Filter and format opponent information based on skill level.
   * Easy: no opponents. Medium: position + cash. Hard: full info.
   */
  static buildOpponentContext(
    opponents: WorldSnapshot['opponents'],
    skillLevel: BotSkillLevel,
  ): OpponentContext[] {
    // Easy bots get no opponent info
    if (skillLevel === BotSkillLevel.Easy) return [];
    if (!opponents || opponents.length === 0) return [];

    return opponents.map(opp => {
      // Format position as a readable string
      const positionStr = opp.position
        ? `(${opp.position.row},${opp.position.col})`
        : 'unknown';

      if (skillLevel === BotSkillLevel.Medium) {
        // Medium: name, money, trainType, position only
        return {
          name: opp.playerId,
          money: opp.money,
          trainType: opp.trainType,
          position: positionStr,
          loads: [],
          trackCoverage: '',
        };
      }

      // Hard: full info including loads and track coverage
      return {
        name: opp.playerId,
        money: opp.money,
        trainType: opp.trainType,
        position: positionStr,
        loads: opp.loads,
        trackCoverage: opp.trackSummary ?? '',
      };
    });
  }

  // ── Prompt serialization (BE-007) ───────────────────────────────────────

  /**
   * Render GameContext into structured text for the LLM user prompt.
   * Follows PRD Section 4.3 template with skill-level-dependent detail.
   */
  static serializePrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
  ): string {
    const lines: string[] = [];

    // ── TURN/PHASE header ──
    lines.push(`TURN ${context.turnNumber} \u2014 GAME PHASE: ${context.phase}`);
    lines.push('');

    // ── PREVIOUS TURN (context continuity) ──
    if (context.previousTurnSummary) {
      lines.push('PREVIOUS TURN:');
      lines.push(`- ${context.previousTurnSummary}`);
      lines.push('⚠️ PLAN PERSISTENCE: You MUST continue your existing plan unless:');
      lines.push('  (a) The delivery was completed, or');
      lines.push('  (b) The load is no longer available (taken by opponent), or');
      lines.push('  (c) A dramatically better opportunity appeared (2x+ payout with less track needed).');
      lines.push('  Switching plans mid-execution wastes track already built. Stay the course.');
      lines.push('');
    }

    // ── YOUR STATUS ──
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${context.money}M ECU (minimum reserve: 5M)`);
    const loadsStr = context.loads.length > 0 ? context.loads.join(', ') : 'nothing';
    lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity}, carrying ${loadsStr})`);
    const posStr = context.position
      ? (context.position.city
        ? `${context.position.city} (${context.position.row},${context.position.col})`
        : `(${context.position.row},${context.position.col})`)
      : 'Not placed';
    lines.push(`- Position: ${posStr}`);
    lines.push(`- Major cities connected: ${context.connectedMajorCities.length}/${context.totalMajorCities} (${context.connectedMajorCities.join(', ') || 'none'})`);
    lines.push(`- Track network: ${context.trackSummary}`);
    lines.push(`- Build budget remaining this turn: ${20 - context.turnBuildCost}M`);
    lines.push('');

    // ── VICTORY PROGRESS ──
    const cashRemaining = Math.max(0, 250 - context.money);
    lines.push('VICTORY PROGRESS:');
    lines.push(`- Cash: ${context.money}M / 250M needed (${cashRemaining}M remaining)`);
    lines.push(`- Cities connected: ${context.connectedMajorCities.length}/7 needed (${context.connectedMajorCities.join(', ') || 'none'})`);

    if (context.unconnectedMajorCities.length === 0) {
      lines.push('- All cities connected! Earn more cash to win.');
    } else {
      const unconnectedStr = context.unconnectedMajorCities
        .map(u => `${u.cityName} (~${u.estimatedCost}M to connect)`)
        .join(', ');
      lines.push(`- Cities NOT connected: ${unconnectedStr}`);
      const nearest = context.unconnectedMajorCities[0];
      lines.push(`- Nearest unconnected city: ${nearest.cityName} (~${nearest.estimatedCost}M from your network)`);

      const cheapestCost = nearest.estimatedCost;
      if (context.money >= 250 && context.connectedMajorCities.length < 7) {
        lines.push(`- STRATEGIC PRIORITY: You have enough cash — focus ALL building budget on connecting [${context.unconnectedMajorCities.map(u => u.cityName).join(', ')}].`);
      } else if (cheapestCost > context.money) {
        lines.push(`- STRATEGIC PRIORITY: Earn more before connecting — cheapest unconnected city costs ~${cheapestCost}M, you have ${context.money}M.`);
      } else {
        lines.push(`- STRATEGIC PRIORITY: Connect ${nearest.cityName} (cheapest) while pursuing deliveries through that corridor.`);
      }
    }

    // Phase-appropriate victory directive
    if (context.phase === 'Victory Imminent' && context.unconnectedMajorCities.length > 0) {
      const last = context.unconnectedMajorCities[0];
      const cashNeeded = Math.max(0, 250 - context.money);
      lines.push(`- LATE-GAME DIRECTIVE: VICTORY IS IMMINENT: Connect ${last.cityName} (~${last.estimatedCost}M) and earn ${cashNeeded}M more. Do NOT discard hand or take unnecessary risks.`);
    } else if (context.phase === 'Late Game' && context.unconnectedMajorCities.length > 0) {
      const citiesNeeded = 7 - context.connectedMajorCities.length;
      const cashNeeded = Math.max(0, 250 - context.money);
      const cheapest = context.unconnectedMajorCities[0];
      lines.push(`- LATE-GAME DIRECTIVE: You need ${citiesNeeded} more cities and ${cashNeeded}M more cash. Connect ${cheapest.cityName} (~${cheapest.estimatedCost}M) before chasing deliveries. Victory is within reach.`);
    } else if (context.phase === 'Mid Game' && context.unconnectedMajorCities.length > 0) {
      lines.push('- MID-GAME DIRECTIVE: Start routing deliveries through unconnected major cities when possible. Every major city you pass through counts toward victory.');
    }
    lines.push('');

    // ── YOUR DEMAND CARDS ──
    lines.push('YOUR DEMAND CARDS:');
    if (context.demands.length === 0) {
      lines.push('  No demand cards.');
    } else {
      // Group demands by cardIndex
      const cardGroups = new Map<number, typeof context.demands>();
      for (const d of context.demands) {
        if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
        cardGroups.get(d.cardIndex)!.push(d);
      }
      let cardNum = 0;
      for (const [, demands] of Array.from(cardGroups.entries())) {
        cardNum++;
        lines.push(`Card ${cardNum} (pick at most one):`);
        const labels = ['a', 'b', 'c', 'd', 'e'];
        for (let i = 0; i < demands.length; i++) {
          const d = demands[i];
          const label = labels[i] ?? `${i + 1}`;
          const note = ContextBuilder.formatReachabilityNote(d, skillLevel);
          const victoryBonus = ContextBuilder.formatVictoryBonus(d, context.unconnectedMajorCities);
          const suffix = victoryBonus ? ` \u2014 ${note} \u2014 ${victoryBonus}` : ` \u2014 ${note}`;
          lines.push(`  ${label}) ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M)${suffix}`);
        }
      }

      // Demand ranking by score (JIRA-13) — helps LLM prioritize
      const sorted = [...context.demands].sort((a, b) => b.demandScore - a.demandScore);
      lines.push('');
      lines.push('DEMAND RANKING (by investment value):');
      for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        const tag = i === 0 ? ' ← RECOMMENDED' : (d.demandScore < 0 ? ' (low priority)' : '');
        const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
        lines.push(`  #${i + 1} ${d.loadType} ${d.supplyCity}→${d.deliveryCity}: score ${d.demandScore} (payout: ${d.payout}M, build: ~${buildCost}M, ROI: ${d.payout - buildCost}M, ~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn, network: +${d.networkCitiesUnlocked} cities, victory: +${d.victoryMajorCitiesEnRoute} major)${tag}`);
      }
    }
    lines.push('');

    // ── IMMEDIATE OPPORTUNITIES ──
    lines.push('IMMEDIATE OPPORTUNITIES:');
    if (context.canDeliver.length > 0) {
      for (const opp of context.canDeliver) {
        lines.push(`- DELIVER ${opp.loadType} at ${opp.deliveryCity} for ${opp.payout}M! (DO THIS FIRST)`);
      }
    }
    if (context.canPickup.length > 0) {
      for (const opp of context.canPickup) {
        lines.push(`- PICKUP ${opp.loadType} here at ${opp.supplyCity} → deliver to ${opp.bestDeliveryCity} for ${opp.bestPayout}M`);
      }
    }
    if (context.canDeliver.length === 0 && context.canPickup.length === 0) {
      lines.push('- No deliveries or pickups available at your position.');
    }
    // Multi-action turn hints
    if (context.canPickup.length > 0) {
      // Check if any pickup's delivery city is reachable this turn (PICKUP → MOVE → DELIVER in one turn!)
      for (const opp of context.canPickup) {
        if (context.reachableCities.includes(opp.bestDeliveryCity)) {
          lines.push(`⚡ COMBO: PICKUP ${opp.loadType} here → MOVE to ${opp.bestDeliveryCity} → DELIVER for ${opp.bestPayout}M — all in ONE turn!`);
        }
      }
      if (context.canBuild) {
        lines.push('TIP: You can PICKUP then BUILD in the same turn using a multi-action sequence.');
      }
    }
    if (context.canDeliver.length > 0 && context.canBuild) {
      lines.push('TIP: After DELIVER, you can BUILD track in the same turn (up to 20M).');
    }
    lines.push('IMPORTANT: Only use DELIVER if a delivery is listed above. You must be AT the delivery city with the matching load to deliver.');
    if (context.loads.length > 0 && context.canDeliver.length === 0) {
      lines.push(`WARNING: You are carrying [${context.loads.join(', ')}] but cannot deliver here. MOVE toward a delivery city — do NOT pass your turn!`);
    }
    // Remind about using full movement
    if (context.speed > 0 && !context.isInitialBuild) {
      lines.push(`REMINDER: Use ALL ${context.speed} movement points each turn. Stopping early wastes your turn. Loading/unloading costs ZERO movement.`);
    }
    lines.push('');

    // ── CITIES REACHABLE ──
    if (context.reachableCities.length > 0) {
      lines.push(`CITIES REACHABLE THIS TURN (within speed ${context.speed} on existing track):`);
      lines.push(context.reachableCities.join(', '));
    } else {
      lines.push('CITIES REACHABLE THIS TURN: None (no track or no position).');
    }
    lines.push('');

    // ── CITIES ON YOUR TRACK NETWORK (multi-turn destinations) ──
    const networkOnlyCities = context.citiesOnNetwork.filter(
      c => !context.reachableCities.includes(c),
    );
    if (networkOnlyCities.length > 0) {
      lines.push('CITIES ON YOUR TRACK NETWORK (reachable by MOVE in multiple turns):');
      lines.push(networkOnlyCities.join(', '));
      lines.push('TIP: Use MOVE to travel along your track toward these cities for pickup/delivery.');
      lines.push('');
    }

    // ── UPGRADE OPTIONS ──
    if (context.canUpgrade) {
      lines.push('YOU CAN UPGRADE: Check available train types (20M for upgrade, 5M for crossgrade).');
    }

    // ── BUILD CONSTRAINTS ──
    if (context.isInitialBuild) {
      lines.push('PHASE: Initial Build \u2014 build track only, no train movement. 20M budget this turn, 40M total over 2 turns.');
      lines.push('Apply the GEOGRAPHIC STRATEGY and CAPITAL VELOCITY principles from your instructions to choose where to build first.');
    }
    if (!context.canBuild) {
      lines.push('BUILD: Not available this turn (budget exhausted or no funds).');
    }

    // ── OPPONENTS ──
    if (context.opponents.length > 0) {
      lines.push('');
      lines.push('OPPONENTS:');
      for (const opp of context.opponents) {
        const parts = [`${opp.name}: ${opp.money}M, ${opp.trainType}`];
        if (opp.position) parts.push(`at ${opp.position}`);
        if (opp.loads.length > 0) parts.push(`carrying ${opp.loads.join(', ')}`);
        if (opp.trackCoverage) parts.push(`Track covers ${opp.trackCoverage}`);
        if (opp.recentBuildDirection) parts.push(`building toward ${opp.recentBuildDirection}`);
        lines.push(`- ${parts.join('. ')}.`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Render a route-planning-specific prompt with corridor data and turn estimates.
   * Used by planRoute() — excludes per-turn noise (immediate opportunities, reachable cities)
   * and adds demand corridors + on-the-way signals.
   */
  static serializeRoutePlanningPrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
    segments: TrackSegment[] = [],
    lastAbandonedRouteKey?: string | null,
    previousRouteStops?: RouteStop[] | null, // BE-010
  ): string {
    const lines: string[] = [];

    // ── TURN/PHASE header ──
    lines.push(`TURN ${context.turnNumber} \u2014 GAME PHASE: ${context.phase}`);
    lines.push('');

    // ── YOUR STATUS (same as serializePrompt) ──
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${context.money}M ECU (minimum reserve: 5M)`);
    const loadsStr = context.loads.length > 0 ? context.loads.join(', ') : 'nothing';
    lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity}, carrying ${loadsStr})`);
    const posStr = context.position
      ? (context.position.city
        ? `${context.position.city} (${context.position.row},${context.position.col})`
        : `(${context.position.row},${context.position.col})`)
      : 'Not placed';
    lines.push(`- Position: ${posStr}`);
    lines.push(`- Major cities connected: ${context.connectedMajorCities.length}/${context.totalMajorCities} (${context.connectedMajorCities.join(', ') || 'none'})`);
    lines.push(`- Track network: ${context.trackSummary}`);
    lines.push('');

    // ── VICTORY PROGRESS (same as serializePrompt) ──
    const cashRemaining = Math.max(0, 250 - context.money);
    lines.push('VICTORY PROGRESS:');
    lines.push(`- Cash: ${context.money}M / 250M needed (${cashRemaining}M remaining)`);
    lines.push(`- Cities connected: ${context.connectedMajorCities.length}/7 needed (${context.connectedMajorCities.join(', ') || 'none'})`);

    if (context.unconnectedMajorCities.length === 0) {
      lines.push('- All cities connected! Earn more cash to win.');
    } else {
      const unconnectedStr = context.unconnectedMajorCities
        .map(u => `${u.cityName} (~${u.estimatedCost}M to connect)`)
        .join(', ');
      lines.push(`- Cities NOT connected: ${unconnectedStr}`);
    }
    lines.push('');

    // ── YOUR DEMAND CARDS (with turn estimates and scarcity) ──
    lines.push('YOUR DEMAND CARDS:');
    if (context.demands.length === 0) {
      lines.push('  No demand cards.');
    } else {
      const cardGroups = new Map<number, typeof context.demands>();
      for (const d of context.demands) {
        if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
        cardGroups.get(d.cardIndex)!.push(d);
      }
      let cardNum = 0;
      const cardBestSummaries: string[] = [];
      let corePlayableCount = 0;
      for (const [, demands] of Array.from(cardGroups.entries())) {
        cardNum++;
        const best = ContextBuilder.bestDemandForCard(demands);
        const bestRegion = ContextBuilder.cityRegionTag(best.deliveryCity);
        const ferryTag = best.ferryRequired ? ', ferry' : '';
        cardBestSummaries.push(
          `Card ${cardNum}: best=${best.loadType}\u2192${best.deliveryCity} ${best.payout}M (${bestRegion}${ferryTag})`,
        );
        if (bestRegion === 'core' && !best.ferryRequired) corePlayableCount++;

        lines.push(`Card ${cardNum} (pick at most one):`);
        const labels = ['a', 'b', 'c', 'd', 'e'];
        for (let i = 0; i < demands.length; i++) {
          const d = demands[i];
          const label = labels[i] ?? `${i + 1}`;
          const isBest = d === best;
          const bestTag = isBest ? ' \u2605 BEST' : '';
          const note = ContextBuilder.formatReachabilityNote(d, skillLevel);
          const turnEst = `~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn`;
          const victoryBonus = ContextBuilder.formatVictoryBonus(d, context.unconnectedMajorCities);
          let suffix = ` \u2014 ${note}, ${turnEst}`;
          if (victoryBonus) suffix += ` \u2014 ${victoryBonus}`;
          lines.push(`  ${label}) ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M)${suffix}${bestTag}`);
        }
      }

      // HAND QUALITY summary (JIRA-16)
      lines.push('');
      lines.push(`HAND QUALITY: ${cardBestSummaries.join('. ')}. Hand quality: ${corePlayableCount}/${cardNum} cards playable in core.`);

      // Demand ranking by score (JIRA-13)
      const sorted = [...context.demands].sort((a, b) => b.demandScore - a.demandScore);
      lines.push('');
      lines.push('DEMAND RANKING (by investment value):');
      for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        const tag = i === 0 ? ' ← RECOMMENDED' : (d.demandScore < 0 ? ' (low priority)' : '');
        const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
        lines.push(`  #${i + 1} ${d.loadType} ${d.supplyCity}→${d.deliveryCity}: score ${d.demandScore} (payout: ${d.payout}M, build: ~${buildCost}M, ROI: ${d.payout - buildCost}M, ~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn, network: +${d.networkCitiesUnlocked} cities, victory: +${d.victoryMajorCitiesEnRoute} major)${tag}`);
      }
    }
    lines.push('');

    // ── DEMAND CORRIDORS ──
    const corridors = ContextBuilder.computeCorridors(context.demands, gridPoints);
    ContextBuilder.detectOnTheWay(corridors, context.demands, gridPoints);

    if (corridors.length > 0) {
      lines.push('DEMAND CORRIDORS (demands sharing routes \u2014 combine for efficiency):');
      for (let ci = 0; ci < corridors.length; ci++) {
        const c = corridors[ci];
        const corridorLabel = String.fromCharCode(65 + ci); // A, B, C...
        lines.push(`  Corridor ${corridorLabel} (${c.sharedDeliveryArea}):`);
        for (const idx of c.demandIndices) {
          const d = context.demands[idx];
          lines.push(`    - ${d.loadType} ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M)`);
        }
        lines.push(`    Combined payout: ${c.combinedPayout}M, shared track: ~${c.combinedTrackCost}M`);
        if (c.onTheWayDemands.length > 0) {
          for (const otwIdx of c.onTheWayDemands) {
            const d = context.demands[otwIdx];
            lines.push(`    ON THE WAY: ${d.loadType} ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M, near-zero extra cost)`);
          }
        }
      }
      lines.push('');
    }

    // ── PROXIMITY CONTEXT (JIRA-10) ──
    // Only include proximity sections when the bot has track segments
    if (segments.length > 0) {
      // Collect route stop cities from demands (supply + delivery)
      const routeStopCities = new Set<string>();
      for (const d of context.demands) {
        routeStopCities.add(d.supplyCity);
        routeStopCities.add(d.deliveryCity);
      }

      const nearbyCities = ContextBuilder.computeNearbyCities(
        Array.from(routeStopCities), gridPoints, segments,
      );
      if (nearbyCities.length > 0) {
        lines.push('NEARBY CITIES (per route stop):');
        for (const entry of nearbyCities) {
          const citiesStr = entry.nearbyCities
            .map(c => `${c.city} (${c.estimatedCost}M, ${c.distance} hexes)`)
            .join(', ');
          lines.push(`  ${entry.routeStop}: ${citiesStr}`);
        }
        lines.push('');
      }

      const unconnected = ContextBuilder.computeUnconnectedDemandCosts(
        context.demands, segments, gridPoints,
      );
      if (unconnected.length > 0) {
        lines.push('UNCONNECTED DEMAND CITIES (build costs):');
        for (const u of unconnected) {
          const d = context.demands[u.demandIndex];
          lines.push(`  ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M payout): ${u.city} needs ~${u.estimatedCost}M track to connect`);
        }
        lines.push('');
      }

      const resourceProx = ContextBuilder.computeResourceProximity(
        context.demands, segments, gridPoints,
      );
      if (resourceProx.length > 0) {
        lines.push('RESOURCE PROXIMITY (cheap pickups near your track):');
        for (const r of resourceProx) {
          lines.push(`  ${r.loadType} available at ${r.supplyCity}, ~${r.estimatedCost}M from your network (${r.distanceFromNetwork} hexes)`);
        }
        lines.push('');
      }
    }

    // ── BUILD CONSTRAINTS ──
    if (context.isInitialBuild) {
      lines.push('PHASE: Initial Build \u2014 build track only, no train movement. 20M budget this turn, 40M total over 2 turns.');
      lines.push('Use GEOGRAPHIC STRATEGY and HAND EVALUATION from the system prompt to choose your first demand. Prioritise capital velocity.');
    }
    if (!context.canBuild) {
      lines.push('BUILD: Not available this turn (budget exhausted or no funds).');
    }

    // ── OPPONENTS ──
    if (context.opponents.length > 0) {
      lines.push('');
      lines.push('OPPONENTS:');
      for (const opp of context.opponents) {
        const parts = [`${opp.name}: ${opp.money}M, ${opp.trainType}`];
        if (opp.position) parts.push(`at ${opp.position}`);
        if (opp.loads.length > 0) parts.push(`carrying ${opp.loads.join(', ')}`);
        if (opp.trackCoverage) parts.push(`Track covers ${opp.trackCoverage}`);
        if (opp.recentBuildDirection) parts.push(`building toward ${opp.recentBuildDirection}`);
        lines.push(`- ${parts.join('. ')}.`);
      }
    }

    // ── RECENTLY ABANDONED ROUTE (BE-005) ──
    if (lastAbandonedRouteKey) {
      lines.push('');
      lines.push(`RECENTLY ABANDONED ROUTE: ${lastAbandonedRouteKey}`);
      lines.push('Avoid planning a route identical to this one — it was abandoned because it could not be completed.');
    }

    // ── PREVIOUS ROUTE CONTEXT (BE-010) ──
    if (previousRouteStops && previousRouteStops.length > 0) {
      lines.push('');
      lines.push('PREVIOUS ROUTE (remaining stops from partially completed route):');
      for (const stop of previousRouteStops) {
        const paymentStr = stop.payment ? ` for ${stop.payment}M` : '';
        lines.push(`  - ${stop.action} ${stop.loadType} at ${stop.city}${paymentStr}`);
      }
      lines.push('Consider continuing this route if the stops are still valid with your current demand cards. You may also extend, modify, or abandon it.');
    }

    return lines.join('\n');
  }

  /**
   * Format a reachability note for a demand, following PRD Section 4.4.
   * Detail level varies by skill level (Easy = simple, Medium/Hard = with costs).
   */
  private static formatReachabilityNote(
    d: DemandContext,
    skillLevel: BotSkillLevel,
  ): string {
    // Load unavailable overrides everything
    if (!d.isLoadAvailable) {
      return `UNAVAILABLE \u2014 all ${d.loadType} copies on other trains.`;
    }

    // Compute scarcity suffix (appended to all return values below)
    const scarcitySuffix = (d.loadChipCarried >= d.loadChipTotal - 1 && d.isLoadAvailable)
      ? `. SCARCE: ${d.loadChipCarried}/${d.loadChipTotal} carried`
      : '';

    const ferry = d.ferryRequired ? ' Requires ferry crossing (movement penalty).' : '';

    // Helper: flag costs — never says "DO NOT pursue" (JIRA-13 fix)
    const affordabilityTag = (cost: number): string => {
      if (cost <= 0) return '';
      const turnsNeeded = Math.ceil(cost / 20);
      if (turnsNeeded > 1) {
        return ` (~${cost}M track needed, ${turnsNeeded} build turns)`;
      }
      return ` (~${cost}M track needed)`;
    };

    // Load is on train
    if (d.isLoadOnTrain) {
      if (d.isDeliveryReachable) {
        return `DELIVERABLE NOW for ${d.payout}M${ferry}${scarcitySuffix}`;
      }
      if (d.isDeliveryOnNetwork) {
        return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} ON YOUR TRACK — MOVE toward it!${ferry}${scarcitySuffix}`;
      }
      if (skillLevel === BotSkillLevel.Easy) {
        return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} not reachable.${ferry}${scarcitySuffix}`;
      }
      return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} needs track${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
    }

    // Supply + delivery reachability
    if (d.isSupplyReachable && d.isDeliveryReachable) {
      return `Supply at ${d.supplyCity} (reachable). Delivery reachable.${ferry}${scarcitySuffix}`;
    }
    if (d.isSupplyReachable && !d.isDeliveryReachable) {
      if (d.isDeliveryOnNetwork) {
        return `Supply at ${d.supplyCity} (reachable). Delivery at ${d.deliveryCity} ON YOUR TRACK (multi-turn MOVE).${ferry}${scarcitySuffix}`;
      }
      if (skillLevel === BotSkillLevel.Easy) {
        return `Supply at ${d.supplyCity} (reachable). Delivery not reachable.${ferry}${scarcitySuffix}`;
      }
      return `Supply at ${d.supplyCity} (reachable). Delivery needs${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
    }

    // Supply on network but not reachable this turn
    if (d.isSupplyOnNetwork) {
      const deliveryNote = d.isDeliveryOnNetwork
        ? `Delivery at ${d.deliveryCity} also on track.`
        : `Delivery needs track.`;
      return `Supply at ${d.supplyCity} ON YOUR TRACK — MOVE toward it! ${deliveryNote}${ferry}${scarcitySuffix}`;
    }

    // Supply not reachable
    if (skillLevel === BotSkillLevel.Easy) {
      return `Supply not reachable.${ferry}${scarcitySuffix}`;
    }
    const totalCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
    return `Supply not reachable${affordabilityTag(totalCost)}.${ferry}${scarcitySuffix}`;
  }

  /**
   * Format VICTORY BONUS note when a demand's supply or delivery city is unconnected.
   * Encourages routing through unconnected major cities for victory progress.
   */
  private static formatVictoryBonus(
    d: DemandContext,
    unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>,
  ): string {
    const unconnected = unconnectedMajorCities.filter(
      (u) => u.cityName === d.supplyCity || u.cityName === d.deliveryCity,
    );
    if (unconnected.length === 0) return '';
    const parts = unconnected.map(
      (u) => `route passes near ${u.cityName} (unconnected, ~${u.estimatedCost}M to connect)`,
    );
    return `VICTORY BONUS: ${parts.join('; ')}`;
  }

  /**
   * Identify the "best" demand on a card — cheapest to reach in the core network.
   * Heuristic priority: (1) both supply+delivery on network, (2) lowest track cost,
   * (3) core cities over peripheral.
   */
  private static bestDemandForCard(demands: DemandContext[]): DemandContext {
    if (demands.length === 1) return demands[0];

    const scored = demands.map((d) => {
      let score = 0;
      // Highest priority: both endpoints on existing network
      if (d.isSupplyOnNetwork && d.isDeliveryOnNetwork) score += 1000;
      else if (d.isSupplyOnNetwork || d.isDeliveryOnNetwork) score += 500;
      // Penalise track cost (lower is better)
      score -= (d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery);
      // Prefer core cities
      if (CORE_CITIES.has(d.supplyCity)) score += 20;
      if (CORE_CITIES.has(d.deliveryCity)) score += 20;
      // Penalise ferry
      if (d.ferryRequired) score -= 50;
      // Prefer available loads
      if (!d.isLoadAvailable) score -= 200;
      return { d, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].d;
  }

  /**
   * Classify a city as 'core' or 'peripheral' for the hand quality summary.
   */
  private static cityRegionTag(city: string): 'core' | 'peripheral' {
    return CORE_CITIES.has(city) ? 'core' : 'peripheral';
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Compute all demand contexts from the snapshot's resolved demands */
  private static computeAllDemandContexts(
    snapshot: WorldSnapshot,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    reachableCities: string[],
    citiesOnNetwork: string[],
    connectedMajorCities: string[],
  ): DemandContext[] {
    const contexts: DemandContext[] = [];
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        contexts.push(
          ContextBuilder.computeDemandContext(
            resolved.cardId, demand, snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
          ),
        );
      }
    }
    return contexts;
  }

  /** Compute immediate delivery opportunities at current position */
  private static computeCanDeliver(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): DeliveryOpportunity[] {
    if (!snapshot.bot.position) return [];
    const cityName = ContextBuilder.getCityNameAtPosition(snapshot.bot.position, gridPoints);
    if (!cityName) return [];

    const opportunities: DeliveryOpportunity[] = [];
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        if (
          demand.city === cityName &&
          snapshot.bot.loads.includes(demand.loadType)
        ) {
          opportunities.push({
            loadType: demand.loadType,
            deliveryCity: demand.city,
            payout: demand.payment,
            cardIndex: resolved.cardId,
          });
        }
      }
    }
    return opportunities;
  }

  /**
   * Compute loads the bot can pick up at its current position.
   * Matches available loads at the city against demand cards for strategic relevance.
   * Only includes loads the bot has capacity for and that match a demand card.
   */
  private static computeCanPickup(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): PickupOpportunity[] {
    if (!snapshot.bot.position) return [];
    if (snapshot.gameStatus === 'initialBuild') return [];

    const trainType = snapshot.bot.trainType as TrainType;
    const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
    if (snapshot.bot.loads.length >= capacity) return [];

    const cityName = ContextBuilder.getCityNameAtPosition(snapshot.bot.position, gridPoints);
    if (!cityName) return [];

    // Find what loads are available at this city using the snapshot's loadAvailability
    // (populated by WorldSnapshotService from LoadService — canonical source of truth)
    const availableLoads = snapshot.loadAvailability?.[cityName] ?? [];
    if (availableLoads.length === 0) return [];

    // Match against demand cards — only suggest pickups that help fulfill demands
    const opportunities: PickupOpportunity[] = [];
    for (const loadType of availableLoads) {
      // Skip if bot is already carrying this load type
      if (snapshot.bot.loads.includes(loadType)) continue;

      // Find the best-paying demand card for this load
      let bestPayout = 0;
      let bestDeliveryCity = '';
      for (const resolved of snapshot.bot.resolvedDemands) {
        for (const demand of resolved.demands) {
          if (demand.loadType === loadType && demand.payment > bestPayout) {
            bestPayout = demand.payment;
            bestDeliveryCity = demand.city;
          }
        }
      }

      if (bestPayout > 0) {
        opportunities.push({
          loadType,
          supplyCity: cityName,
          bestPayout,
          bestDeliveryCity,
        });
      }
    }

    return opportunities;
  }

  /** Check whether the bot can afford and is eligible for a train upgrade */
  private static checkCanUpgrade(snapshot: WorldSnapshot): boolean {
    if (snapshot.gameStatus === 'initialBuild') return false;
    if (snapshot.bot.money < 5) return false;

    const trainType = snapshot.bot.trainType as TrainType;
    switch (trainType) {
      case TrainType.Freight:
        return snapshot.bot.money >= 20;
      case TrainType.FastFreight:
        return snapshot.bot.money >= 5 || snapshot.bot.money >= 20;
      case TrainType.HeavyFreight:
        return snapshot.bot.money >= 5 || snapshot.bot.money >= 20;
      case TrainType.Superfreight:
        return false;
      default:
        return false;
    }
  }

  /** Determine the current game phase string */
  private static computePhase(
    snapshot: WorldSnapshot,
    connectedMajorCities: string[],
  ): string {
    if (snapshot.gameStatus === 'initialBuild') return 'Initial Build';
    if (connectedMajorCities.length >= 6 && snapshot.bot.money >= 230) return 'Victory Imminent';
    if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 150) return 'Late Game';
    if (connectedMajorCities.length >= 3 || snapshot.bot.money >= 80) return 'Mid Game';
    return 'Early Game';
  }

  /** Compute unconnected major cities with estimated track cost from current network */
  private static computeUnconnectedMajorCities(
    connectedMajorCities: string[],
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): Array<{ cityName: string; estimatedCost: number }> {
    const allMajorCityNames = getMajorCityGroups().map(g => g.cityName);
    const connectedSet = new Set(connectedMajorCities);
    const unconnected = allMajorCityNames.filter(name => !connectedSet.has(name));

    if (unconnected.length === 0) return [];

    return unconnected
      .map(cityName => ({
        cityName,
        estimatedCost: ContextBuilder.estimateTrackCost(cityName, segments, gridPoints),
      }))
      .sort((a, b) => a.estimatedCost - b.estimatedCost);
  }

  /** Get city name at a grid position, or undefined if not a city */
  private static getCityNameAtPosition(
    position: { row: number; col: number },
    gridPoints: GridPoint[],
  ): string | undefined {
    const point = gridPoints.find(
      gp => gp.row === position.row && gp.col === position.col,
    );
    return point?.city?.name;
  }

  /** Compute connected major cities from the bot's track segments */
  private static computeConnectedMajorCities(
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): string[] {
    if (segments.length === 0) return [];

    const network = buildTrackNetwork(segments);
    const majorCityPoints = gridPoints.filter(
      gp => gp.terrain === TerrainType.MajorCity && gp.city,
    );

    // Find which major cities are on the network
    const connectedCities: string[] = [];
    for (const mc of majorCityPoints) {
      const key = `${mc.row},${mc.col}`;
      if (network.nodes.has(key)) {
        connectedCities.push(mc.city!.name);
      }
    }

    // Deduplicate (major cities may have multiple mileposts)
    return Array.from(new Set(connectedCities));
  }

  /** Summarize track as "N mileposts: City1-City2, City2-City3" */
  private static computeTrackSummary(
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): string {
    if (segments.length === 0) return 'No track built';

    const mileposts = segments.length;

    // Collect city names touched by the track
    const cityNames = new Set<string>();
    for (const seg of segments) {
      const fromPoint = gridPoints.find(
        gp => gp.row === seg.from.row && gp.col === seg.from.col,
      );
      const toPoint = gridPoints.find(
        gp => gp.row === seg.to.row && gp.col === seg.to.col,
      );
      if (fromPoint?.city?.name) cityNames.add(fromPoint.city.name);
      if (toPoint?.city?.name) cityNames.add(toPoint.city.name);
    }

    if (cityNames.size === 0) {
      return `${mileposts} mileposts (no cities connected yet)`;
    }

    const cities = Array.from(cityNames).sort();
    // Build corridor pairs from consecutive cities in the sorted list
    const corridors: string[] = [];
    for (let i = 0; i < cities.length - 1; i++) {
      corridors.push(`${cities[i]}\u2013${cities[i + 1]}`);
    }

    return corridors.length > 0
      ? `${mileposts} mileposts: ${corridors.join(', ')}`
      : `${mileposts} mileposts covering ${cities.join(', ')}`;
  }

  // ── Demand scoring (JIRA-13) ────────────────────────────────────────────

  /** Radius (hex distance) around the corridor line to count cities */
  private static readonly CORRIDOR_RADIUS = 5;

  /** Weight per city near the build corridor (network value) */
  private static readonly NETWORK_CITY_WEIGHT = 3;

  /** Weight per unconnected major city near the corridor (victory bonus) */
  private static readonly VICTORY_CITY_WEIGHT = 10;

  /**
   * Estimate how many cities lie near the proposed track corridor from
   * the bot's track frontier (or a starting major city) to the supply city.
   *
   * The corridor is defined as all grid points within CORRIDOR_RADIUS hexes
   * of either endpoint or the midpoint of the line between them.
   *
   * Returns { networkCities, victoryMajorCities } counts.
   */
  private static computeCorridorValue(
    supplyCity: string | null,
    deliveryCity: string,
    segments: TrackSegment[],
    gridPoints: GridPoint[],
    connectedMajorCities: string[],
  ): { networkCities: number; victoryMajorCities: number } {
    if (!supplyCity) return { networkCities: 0, victoryMajorCities: 0 };

    // Find supply city and delivery city coordinates (use first gridpoint for each)
    const supplyCityPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
    const deliveryCityPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
    if (supplyCityPoints.length === 0) return { networkCities: 0, victoryMajorCities: 0 };

    const supplyPt = supplyCityPoints[0];

    // Find the nearest frontier point on the bot's track to the supply city
    let corridorStart: { row: number; col: number };
    if (segments.length > 0) {
      let bestDist = Infinity;
      corridorStart = { row: segments[0].to.row, col: segments[0].to.col };
      for (const seg of segments) {
        const dist = hexDistance(supplyPt.row, supplyPt.col, seg.to.row, seg.to.col);
        if (dist < bestDist) {
          bestDist = dist;
          corridorStart = { row: seg.to.row, col: seg.to.col };
        }
      }
    } else {
      // No track: use the closest major city as corridor start
      const majorCityGroups = getMajorCityGroups();
      let bestDist = Infinity;
      corridorStart = { row: supplyPt.row, col: supplyPt.col };
      for (const group of majorCityGroups) {
        const dist = hexDistance(supplyPt.row, supplyPt.col, group.center.row, group.center.col);
        if (dist < bestDist) {
          bestDist = dist;
          corridorStart = { row: group.center.row, col: group.center.col };
        }
      }
    }

    // Corridor waypoints: start (frontier), supply, delivery (if available)
    const waypoints: Array<{ row: number; col: number }> = [corridorStart, supplyPt];
    if (deliveryCityPoints.length > 0) {
      waypoints.push(deliveryCityPoints[0]);
    }

    // Also add midpoints between consecutive waypoints for better corridor coverage
    const allCheckpoints: Array<{ row: number; col: number }> = [];
    for (let i = 0; i < waypoints.length; i++) {
      allCheckpoints.push(waypoints[i]);
      if (i < waypoints.length - 1) {
        allCheckpoints.push({
          row: Math.round((waypoints[i].row + waypoints[i + 1].row) / 2),
          col: Math.round((waypoints[i].col + waypoints[i + 1].col) / 2),
        });
      }
    }

    // Build set of cities already on the network (don't count them as "unlocked")
    const networkCitySet = new Set<string>();
    if (segments.length > 0) {
      const network = buildTrackNetwork(segments);
      for (const gp of gridPoints) {
        if (gp.city?.name) {
          const key = `${gp.row},${gp.col}`;
          if (network.nodes.has(key)) networkCitySet.add(gp.city.name);
        }
      }
    }

    // Count cities near the corridor that are NOT on the bot's network
    const connectedSet = new Set(connectedMajorCities);
    const seenCities = new Set<string>();
    let networkCities = 0;
    let victoryMajorCities = 0;

    for (const gp of gridPoints) {
      if (!gp.city?.name) continue;
      if (networkCitySet.has(gp.city.name)) continue;
      if (seenCities.has(gp.city.name)) continue;

      // Check if this city is within CORRIDOR_RADIUS of any checkpoint
      let nearCorridor = false;
      for (const cp of allCheckpoints) {
        if (hexDistance(gp.row, gp.col, cp.row, cp.col) <= ContextBuilder.CORRIDOR_RADIUS) {
          nearCorridor = true;
          break;
        }
      }
      if (!nearCorridor) continue;

      seenCities.add(gp.city.name);
      networkCities++;

      // Check if it's an unconnected major city (victory value)
      if (gp.terrain === TerrainType.MajorCity && !connectedSet.has(gp.city.name)) {
        victoryMajorCities++;
      }
    }

    return { networkCities, victoryMajorCities };
  }

  /**
   * Compute a demand score from efficiency (ROI per turn), network value, and victory bonus.
   * Higher scores mean better demand options for the bot to pursue.
   *
   * Score = (immediateROI / estimatedTurns) + networkCities * 3 + victoryMajorCities * 10
   */
  private static scoreDemand(
    payout: number,
    totalTrackCost: number,
    networkCities: number,
    victoryMajorCities: number,
    estimatedTurns: number,
  ): number {
    const immediateROI = payout - totalTrackCost;
    const networkBonus = networkCities * ContextBuilder.NETWORK_CITY_WEIGHT;
    const victoryBonus = victoryMajorCities * ContextBuilder.VICTORY_CITY_WEIGHT;
    return (immediateROI / estimatedTurns) + networkBonus + victoryBonus;
  }

  // ── Demand context helpers (BE-005) ─────────────────────────────────────

  /**
   * Find the best supply city for a load type.
   * Prefers cities that are already on the bot's track network.
   * Falls back to the first supply city found in gridPoints.
   */
  private static findBestSupplyCity(
    loadType: string,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    segments: TrackSegment[],
  ): string | null {
    // Find all cities that supply this load type
    const supplyCities: Array<{ name: string; row: number; col: number }> = [];
    for (const gp of gridPoints) {
      if (gp.city && gp.city.availableLoads.includes(loadType)) {
        supplyCities.push({ name: gp.city.name, row: gp.row, col: gp.col });
      }
    }

    if (supplyCities.length === 0) return null;

    // Prefer a supply city that's already on our network
    if (network) {
      for (const sc of supplyCities) {
        const key = `${sc.row},${sc.col}`;
        if (network.nodes.has(key)) {
          return sc.name;
        }
      }
    }

    // If no supply city is on the network, pick the one closest to the track frontier
    if (segments.length > 0) {
      let bestCity = supplyCities[0].name;
      let bestDist = Infinity;
      for (const sc of supplyCities) {
        for (const seg of segments) {
          const dist = hexDistance(
            sc.row, sc.col, seg.to.row, seg.to.col,
          );
          if (dist < bestDist) {
            bestDist = dist;
            bestCity = sc.name;
          }
        }
      }
      return bestCity;
    }

    // No track at all — pick supply city closest to any major city
    // (bot can start building from any major city per game rules)
    const majorCityGroups = getMajorCityGroups();
    let bestCity = supplyCities[0].name;
    let bestDist = Infinity;
    for (const sc of supplyCities) {
      for (const group of majorCityGroups) {
        const dist = hexDistance(
          sc.row, sc.col, group.center.row, group.center.col,
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestCity = sc.name;
        }
      }
    }
    return bestCity;
  }

  /** Check if a city name is on the track network (has at least one milepost in the network) */
  private static isCityOnNetwork(
    cityName: string,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
  ): boolean {
    if (!network) return false;
    for (const gp of gridPoints) {
      if (gp.city?.name === cityName) {
        const key = `${gp.row},${gp.col}`;
        if (network.nodes.has(key)) return true;
      }
    }
    return false;
  }

  /**
   * Estimate track building cost to reach a city from the existing track.
   * Uses hex distance with an average terrain cost multiplier (~1.5M per milepost).
   * Returns 0 if no track exists (can't estimate without a frontier).
   *
   * For cities with multiple mileposts (e.g. major cities with 5-7 gridpoints),
   * checks ALL mileposts and uses the one closest to the bot's track.
   */
  private static estimateTrackCost(
    cityName: string,
    segments: TrackSegment[],
    gridPoints: GridPoint[],
    fromCity?: string,
  ): number {
    // Find ALL mileposts for this city (major cities have multiple)
    const cityPoints = gridPoints.filter(gp => gp.city?.name === cityName);
    if (cityPoints.length === 0) return 0;

    // Average terrain cost is ~1.5M per milepost (mix of clear=1, mountain=2, city=3-5)
    const AVG_COST_PER_MILEPOST = 1.5;

    if (segments.length === 0) {
      // Cold-start: if fromCity specified, estimate distance from that city
      // (used for delivery cost estimation from the supply city)
      if (fromCity) {
        const fromPoints = gridPoints.filter(gp => gp.city?.name === fromCity);
        if (fromPoints.length > 0) {
          let minDist = Infinity;
          for (const cityPoint of cityPoints) {
            for (const fp of fromPoints) {
              const dist = hexDistance(
                cityPoint.row, cityPoint.col, fp.row, fp.col,
              );
              minDist = Math.min(minDist, dist);
            }
          }
          if (minDist === Infinity || minDist <= 1) return 0;
          return Math.round(minDist * AVG_COST_PER_MILEPOST);
        }
      }

      // Default cold-start: estimate distance from nearest major city center
      // (bot can start building from any major city per game rules)
      const majorCityGroups = getMajorCityGroups();
      let minDist = Infinity;
      for (const cityPoint of cityPoints) {
        for (const group of majorCityGroups) {
          const dist = hexDistance(
            cityPoint.row, cityPoint.col,
            group.center.row, group.center.col,
          );
          minDist = Math.min(minDist, dist);
        }
      }
      if (minDist === Infinity || minDist <= 1) return 0; // City IS a major city
      return Math.round(minDist * AVG_COST_PER_MILEPOST);
    }

    // Find the closest segment endpoint to ANY city milepost
    let minDist = Infinity;
    for (const cityPoint of cityPoints) {
      for (const seg of segments) {
        const distFrom = hexDistance(
          cityPoint.row, cityPoint.col, seg.from.row, seg.from.col,
        );
        const distTo = hexDistance(
          cityPoint.row, cityPoint.col, seg.to.row, seg.to.col,
        );
        minDist = Math.min(minDist, distFrom, distTo);
      }
    }

    if (minDist === Infinity) return 0;

    return Math.round(minDist * AVG_COST_PER_MILEPOST);
  }

  /**
   * Check if a ferry is likely required to reach supply or delivery cities.
   * Looks for ferry port terrain at any grid point named for those cities.
   */
  private static isFerryOnRoute(
    supplyCity: string | null,
    deliveryCity: string,
    gridPoints: GridPoint[],
  ): boolean {
    // Check 1: supply or delivery IS a ferry port city
    for (const gp of gridPoints) {
      if (gp.terrain === TerrainType.FerryPort || gp.isFerryCity) {
        const cityName = gp.city?.name;
        if (cityName === supplyCity || cityName === deliveryCity) {
          return true;
        }
      }
    }

    // Check 2: route crosses a water barrier (Channel or Irish Sea)
    // These ferries have NO land alternative — you MUST cross them to reach the other side.
    // Scandinavian ferries (Newcastle_Esbjerg, Kristiansand_Hirtshals, Malmo_Sassnitz)
    // are shortcuts with land alternatives, so we exclude them.
    if (!supplyCity) return false;
    const BARRIER_FERRIES = new Set([
      'Plymouth_Cherbourg', 'Portsmouth_LeHavre', 'Dover_Calais', 'Harwich_Ijmuiden',
      'Belfast_Stranraer', 'Dublin_Liverpool',
    ]);

    const ferryEdges = getFerryEdges();
    const barrierFerries = ferryEdges.filter(f => BARRIER_FERRIES.has(f.name));
    if (barrierFerries.length === 0) return false;

    // Find positions for supply and delivery cities
    const supplyPos = gridPoints.find(gp => gp.city?.name === supplyCity);
    const deliveryPos = gridPoints.find(gp => gp.city?.name === deliveryCity);
    if (!supplyPos || !deliveryPos) return false;

    // For each barrier ferry, check if supply and delivery are on opposite sides.
    // If supply is closer to port A and delivery closer to port B (or vice versa),
    // the route must cross this ferry.
    for (const ferry of barrierFerries) {
      const supplyToA = hexDistance(supplyPos.row, supplyPos.col, ferry.pointA.row, ferry.pointA.col);
      const supplyToB = hexDistance(supplyPos.row, supplyPos.col, ferry.pointB.row, ferry.pointB.col);
      const deliveryToA = hexDistance(deliveryPos.row, deliveryPos.col, ferry.pointA.row, ferry.pointA.col);
      const deliveryToB = hexDistance(deliveryPos.row, deliveryPos.col, ferry.pointB.row, ferry.pointB.col);

      const supplyCloserToA = supplyToA < supplyToB;
      const deliveryCloserToA = deliveryToA < deliveryToB;
      if (supplyCloserToA !== deliveryCloserToA) {
        return true;
      }
    }

    return false;
  }

  // ── Corridor detection (BE-002, BE-003) ─────────────────────────────────

  private static computeCorridors(
    demands: DemandContext[],
    gridPoints: GridPoint[],
  ): Corridor[] {
    if (demands.length < 2) return [];

    // Find grid positions for each demand's supply and delivery cities
    const cityPos = (cityName: string): { row: number; col: number } | null => {
      const gp = gridPoints.find(g => g.city?.name === cityName);
      return gp ? { row: gp.row, col: gp.col } : null;
    };

    // Union-find for merging corridor groups
    const parent = demands.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a: number, b: number): void => { parent[find(a)] = find(b); };

    // Check all pairs
    for (let i = 0; i < demands.length; i++) {
      for (let j = i + 1; j < demands.length; j++) {
        const di = demands[i];
        const dj = demands[j];

        const delPosI = cityPos(di.deliveryCity);
        const delPosJ = cityPos(dj.deliveryCity);
        const supPosI = cityPos(di.supplyCity);
        const supPosJ = cityPos(dj.supplyCity);

        if (!delPosI || !delPosJ || !supPosI || !supPosJ) continue;

        const deliveryDist = di.deliveryCity === dj.deliveryCity ? 0 :
          hexDistance(delPosI.row, delPosI.col, delPosJ.row, delPosJ.col);
        const supplyDist = hexDistance(supPosI.row, supPosI.col, supPosJ.row, supPosJ.col);

        if (deliveryDist <= ContextBuilder.CORRIDOR_DELIVERY_THRESHOLD &&
            supplyDist <= ContextBuilder.CORRIDOR_SUPPLY_THRESHOLD) {
          union(i, j);
        }
      }
    }

    // Group demands by their root
    const groups = new Map<number, number[]>();
    for (let i = 0; i < demands.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    }

    // Build corridors (only for groups with 2+ demands)
    const corridors: Corridor[] = [];
    for (const [, indices] of groups) {
      if (indices.length < 2) continue;

      const corridorDemands = indices.map(i => demands[i]);
      const combinedPayout = corridorDemands.reduce((sum, d) => sum + d.payout, 0);

      // Estimate combined track cost (roughly: max of individual costs, not sum,
      // because they share track)
      const maxSupplyCost = Math.max(...corridorDemands.map(d => d.estimatedTrackCostToSupply));
      const maxDeliveryCost = Math.max(...corridorDemands.map(d => d.estimatedTrackCostToDelivery));
      const combinedTrackCost = maxSupplyCost + maxDeliveryCost;

      // Label the corridor
      const deliveryCities = [...new Set(corridorDemands.map(d => d.deliveryCity))];
      const supplyCities = [...new Set(corridorDemands.map(d => d.supplyCity))];
      const deliveryLabel = deliveryCities.length === 1 ? deliveryCities[0] : deliveryCities.join('/');
      const supplyLabel = supplyCities.join('/');
      const sharedDeliveryArea = `${supplyLabel} \u2192 ${deliveryLabel}`;

      corridors.push({
        demandIndices: indices,
        sharedDeliveryArea,
        combinedPayout,
        combinedTrackCost,
        onTheWayDemands: [], // filled by detectOnTheWay
      });
    }

    return corridors;
  }

  // ── Proximity computation (BE-002, JIRA-10) ──────────────────────────────

  /** Proximity threshold: max hex distance for "nearby" cities */
  private static readonly PROXIMITY_THRESHOLD = 5;
  /** Max nearby cities to return per route stop */
  private static readonly MAX_NEARBY_PER_STOP = 5;

  /**
   * For each route stop city, find all cities within hexDistance <= 5
   * that are NOT already on the bot's track network.
   */
  private static computeNearbyCities(
    routeStopCities: string[],
    gridPoints: GridPoint[],
    segments: TrackSegment[],
  ): Array<{ routeStop: string; nearbyCities: Array<{ city: string; distance: number; estimatedCost: number }> }> {
    if (routeStopCities.length === 0 || segments.length === 0) return [];

    const network = buildTrackNetwork(segments);

    // Build a set of city names already on the network
    const networkCities = new Set<string>();
    for (const gp of gridPoints) {
      if (gp.city?.name) {
        const key = `${gp.row},${gp.col}`;
        if (network.nodes.has(key)) networkCities.add(gp.city.name);
      }
    }

    // All city grid points (small, medium, major)
    const allCityPoints = gridPoints.filter(
      gp => gp.city && (
        gp.terrain === TerrainType.SmallCity ||
        gp.terrain === TerrainType.MediumCity ||
        gp.terrain === TerrainType.MajorCity
      ),
    );

    const result: Array<{ routeStop: string; nearbyCities: Array<{ city: string; distance: number; estimatedCost: number }> }> = [];

    for (const stopCity of routeStopCities) {
      // Find the grid position(s) for this route stop
      const stopPoints = gridPoints.filter(gp => gp.city?.name === stopCity);
      if (stopPoints.length === 0) continue;

      const nearbyMap = new Map<string, { distance: number; estimatedCost: number }>();

      for (const stopPt of stopPoints) {
        for (const cityPt of allCityPoints) {
          const cityName = cityPt.city!.name;
          // Skip cities already on the network or the stop city itself
          if (networkCities.has(cityName) || cityName === stopCity) continue;

          const dist = hexDistance(stopPt.row, stopPt.col, cityPt.row, cityPt.col);
          if (dist <= ContextBuilder.PROXIMITY_THRESHOLD && dist > 0) {
            const existing = nearbyMap.get(cityName);
            if (!existing || dist < existing.distance) {
              nearbyMap.set(cityName, {
                distance: dist,
                estimatedCost: ContextBuilder.estimateTrackCost(cityName, segments, gridPoints),
              });
            }
          }
        }
      }

      if (nearbyMap.size > 0) {
        const nearbyCities = Array.from(nearbyMap.entries())
          .map(([city, data]) => ({ city, distance: data.distance, estimatedCost: data.estimatedCost }))
          .sort((a, b) => a.estimatedCost - b.estimatedCost)
          .slice(0, ContextBuilder.MAX_NEARBY_PER_STOP);

        result.push({ routeStop: stopCity, nearbyCities });
      }
    }

    return result;
  }

  /**
   * For each demand where supply OR delivery city is not on the network,
   * compute estimated build cost to connect it.
   */
  private static computeUnconnectedDemandCosts(
    demands: DemandContext[],
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): Array<{ demandIndex: number; city: string; estimatedCost: number; payout: number; isSupply: boolean }> {
    if (segments.length === 0) return [];

    const results: Array<{ demandIndex: number; city: string; estimatedCost: number; payout: number; isSupply: boolean }> = [];

    for (let i = 0; i < demands.length; i++) {
      const d = demands[i];
      // Skip if both cities already on network
      if (d.isSupplyOnNetwork && d.isDeliveryOnNetwork) continue;

      if (!d.isSupplyOnNetwork) {
        results.push({
          demandIndex: i,
          city: d.supplyCity,
          estimatedCost: ContextBuilder.estimateTrackCost(d.supplyCity, segments, gridPoints),
          payout: d.payout,
          isSupply: true,
        });
      }
      if (!d.isDeliveryOnNetwork) {
        results.push({
          demandIndex: i,
          city: d.deliveryCity,
          estimatedCost: ContextBuilder.estimateTrackCost(d.deliveryCity, segments, gridPoints),
          payout: d.payout,
          isSupply: false,
        });
      }
    }

    return results;
  }

  /**
   * For each demand, check if the supply city is near (hexDistance <= 5)
   * any milepost on the bot's network. Excludes supplies already on network.
   */
  private static computeResourceProximity(
    demands: DemandContext[],
    segments: TrackSegment[],
    gridPoints: GridPoint[],
  ): Array<{ loadType: string; supplyCity: string; distanceFromNetwork: number; estimatedCost: number }> {
    if (segments.length === 0) return [];

    const network = buildTrackNetwork(segments);
    const results: Array<{ loadType: string; supplyCity: string; distanceFromNetwork: number; estimatedCost: number }> = [];
    const seen = new Set<string>(); // deduplicate by supplyCity

    for (const d of demands) {
      if (d.isSupplyOnNetwork) continue;
      if (seen.has(d.supplyCity)) continue;

      // Find the supply city's grid position(s)
      const supplyPoints = gridPoints.filter(gp => gp.city?.name === d.supplyCity);
      if (supplyPoints.length === 0) continue;

      // Find minimum hex distance from any supply point to any network node
      let minDist = Infinity;
      for (const sp of supplyPoints) {
        for (const nodeKey of network.nodes) {
          const [nRow, nCol] = nodeKey.split(',').map(Number);
          const dist = hexDistance(sp.row, sp.col, nRow, nCol);
          if (dist < minDist) minDist = dist;
        }
      }

      if (minDist <= ContextBuilder.PROXIMITY_THRESHOLD && minDist > 0) {
        seen.add(d.supplyCity);
        results.push({
          loadType: d.loadType,
          supplyCity: d.supplyCity,
          distanceFromNetwork: minDist,
          estimatedCost: ContextBuilder.estimateTrackCost(d.supplyCity, segments, gridPoints),
        });
      }
    }

    return results;
  }

  private static detectOnTheWay(
    corridors: Corridor[],
    demands: DemandContext[],
    gridPoints: GridPoint[],
  ): void {
    // Collect all demand indices already in corridors
    const corridorIndices = new Set<number>();
    for (const c of corridors) {
      for (const idx of c.demandIndices) {
        corridorIndices.add(idx);
      }
    }

    const cityPos = (cityName: string): { row: number; col: number } | null => {
      const gp = gridPoints.find(g => g.city?.name === cityName);
      return gp ? { row: gp.row, col: gp.col } : null;
    };

    for (const corridor of corridors) {
      const corridorCityPositions: Array<{ row: number; col: number }> = [];
      for (const idx of corridor.demandIndices) {
        const d = demands[idx];
        const sp = cityPos(d.supplyCity);
        const dp = cityPos(d.deliveryCity);
        if (sp) corridorCityPositions.push(sp);
        if (dp) corridorCityPositions.push(dp);
      }

      for (let i = 0; i < demands.length; i++) {
        if (corridorIndices.has(i)) continue;
        if (corridor.onTheWayDemands.includes(i)) continue;

        const d = demands[i];
        const sp = cityPos(d.supplyCity);
        const dp = cityPos(d.deliveryCity);

        for (const cPos of corridorCityPositions) {
          let matched = false;
          if (sp) {
            const dist = hexDistance(sp.row, sp.col, cPos.row, cPos.col);
            if (dist <= ContextBuilder.ON_THE_WAY_THRESHOLD) {
              corridor.onTheWayDemands.push(i);
              matched = true;
            }
          }
          if (!matched && dp) {
            const dist = hexDistance(dp.row, dp.col, cPos.row, cPos.col);
            if (dist <= ContextBuilder.ON_THE_WAY_THRESHOLD) {
              corridor.onTheWayDemands.push(i);
              matched = true;
            }
          }
          if (matched) break;
        }
      }
    }
  }


}
