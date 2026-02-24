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
} from '../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';

export class ContextBuilder {
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
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork,
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
        const dist = ContextBuilder.hexDistance(position.row, position.col, r, c);
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
   * Check if any copies of loadType are available (not currently carried by any player).
   * Supplements LoadService.isLoadAvailableAtCity which only checks static config.
   */
  static isLoadRuntimeAvailable(
    loadType: string,
    snapshot: WorldSnapshot,
  ): boolean {
    // Count how many copies of this load are currently on trains
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
    const estimatedTrackCostToDelivery = isDeliveryOnNetwork
      ? 0
      : ContextBuilder.estimateTrackCost(deliveryCity, snapshot.bot.existingSegments, gridPoints);

    // 6. Check runtime load availability
    const isLoadAvailable = ContextBuilder.isLoadRuntimeAvailable(loadType, snapshot);

    // 7. Check if a ferry is required to reach supply or delivery
    const ferryRequired = ContextBuilder.isFerryOnRoute(
      supplyCity, deliveryCity, gridPoints,
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
          lines.push(`  ${label}) ${d.loadType} from ${d.supplyCity} \u2192 ${d.deliveryCity} (${d.payout}M) \u2014 ${note}`);
        }
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
      lines.push('INITIAL BUILD STRATEGY: Pick the demand with the CHEAPEST, SHORTEST route — not the highest payout.');
      lines.push('  Prefer supply at/near a major city (zero or minimal track to reach goods).');
      lines.push('  Prefer delivery at/near a major city (short route, useful track for future).');
      lines.push('  Avoid ferry crossings (costly and burn a full turn).');
      lines.push('  Start from central Europe (Ruhr, Paris, Holland, Berlin) for best expansion options.');
      lines.push('  A 6M delivery on turn 4 beats a 73M delivery on turn 15.');
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

    const ferry = d.ferryRequired ? ' Requires ferry crossing (movement penalty).' : '';

    // Helper: flag costs that exceed what bot can spend per turn (20M) as multi-turn,
    // and costs that far exceed payout as poor ROI
    const affordabilityTag = (cost: number): string => {
      if (cost <= 0) return '';
      const turnsNeeded = Math.ceil(cost / 20);
      if (cost > d.payout) {
        return ` ⚠️ UNAFFORDABLE: ~${cost}M track needed (${turnsNeeded} build turns), exceeds ${d.payout}M payout. DO NOT pursue this chain.`;
      }
      if (turnsNeeded > 1) {
        return ` (~${cost}M track needed, ${turnsNeeded} build turns)`;
      }
      return ` (~${cost}M track needed)`;
    };

    // Load is on train
    if (d.isLoadOnTrain) {
      if (d.isDeliveryReachable) {
        return `DELIVERABLE NOW for ${d.payout}M${ferry}`;
      }
      if (d.isDeliveryOnNetwork) {
        return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} ON YOUR TRACK — MOVE toward it!${ferry}`;
      }
      if (skillLevel === BotSkillLevel.Easy) {
        return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} not reachable.${ferry}`;
      }
      return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} needs track${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}`;
    }

    // Supply + delivery reachability
    if (d.isSupplyReachable && d.isDeliveryReachable) {
      return `Supply at ${d.supplyCity} (reachable). Delivery reachable.${ferry}`;
    }
    if (d.isSupplyReachable && !d.isDeliveryReachable) {
      if (d.isDeliveryOnNetwork) {
        return `Supply at ${d.supplyCity} (reachable). Delivery at ${d.deliveryCity} ON YOUR TRACK (multi-turn MOVE).${ferry}`;
      }
      if (skillLevel === BotSkillLevel.Easy) {
        return `Supply at ${d.supplyCity} (reachable). Delivery not reachable.${ferry}`;
      }
      return `Supply at ${d.supplyCity} (reachable). Delivery needs${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}`;
    }

    // Supply on network but not reachable this turn
    if (d.isSupplyOnNetwork) {
      const deliveryNote = d.isDeliveryOnNetwork
        ? `Delivery at ${d.deliveryCity} also on track.`
        : `Delivery needs track.`;
      return `Supply at ${d.supplyCity} ON YOUR TRACK — MOVE toward it! ${deliveryNote}${ferry}`;
    }

    // Supply not reachable
    if (skillLevel === BotSkillLevel.Easy) {
      return `Supply not reachable.${ferry}`;
    }
    const totalCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
    return `Supply not reachable${affordabilityTag(totalCost)}.${ferry}`;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Compute all demand contexts from the snapshot's resolved demands */
  private static computeAllDemandContexts(
    snapshot: WorldSnapshot,
    network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    reachableCities: string[],
    citiesOnNetwork: string[],
  ): DemandContext[] {
    const contexts: DemandContext[] = [];
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        contexts.push(
          ContextBuilder.computeDemandContext(
            resolved.cardId, demand, snapshot, network, gridPoints, reachableCities, citiesOnNetwork,
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
    if (connectedMajorCities.length >= 5 && snapshot.bot.money >= 150) return 'Late Game';
    if (connectedMajorCities.length >= 3 || snapshot.bot.money >= 80) return 'Mid Game';
    return 'Early Game';
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
          const dist = ContextBuilder.hexDistance(
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
        const dist = ContextBuilder.hexDistance(
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
  ): number {
    // Find ALL mileposts for this city (major cities have multiple)
    const cityPoints = gridPoints.filter(gp => gp.city?.name === cityName);
    if (cityPoints.length === 0) return 0;

    // Average terrain cost is ~1.5M per milepost (mix of clear=1, mountain=2, city=3-5)
    const AVG_COST_PER_MILEPOST = 1.5;

    if (segments.length === 0) {
      // Cold-start: estimate distance from nearest major city center
      // (bot can start building from any major city per game rules)
      const majorCityGroups = getMajorCityGroups();
      let minDist = Infinity;
      for (const cityPoint of cityPoints) {
        for (const group of majorCityGroups) {
          const dist = ContextBuilder.hexDistance(
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
        const distFrom = ContextBuilder.hexDistance(
          cityPoint.row, cityPoint.col, seg.from.row, seg.from.col,
        );
        const distTo = ContextBuilder.hexDistance(
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
    for (const gp of gridPoints) {
      if (gp.terrain === TerrainType.FerryPort || gp.isFerryCity) {
        const cityName = gp.city?.name;
        if (cityName === supplyCity || cityName === deliveryCity) {
          return true;
        }
      }
    }
    return false;
  }

  /** Approximate hex grid distance between two positions */
  private static hexDistance(
    r1: number, c1: number, r2: number, c2: number,
  ): number {
    // Offset hex coordinates: convert to cube coordinates for distance
    const x1 = c1 - Math.floor(r1 / 2);
    const z1 = r1;
    const y1 = -x1 - z1;
    const x2 = c2 - Math.floor(r2 / 2);
    const z2 = r2;
    const y2 = -x2 - z2;
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
  }
}
