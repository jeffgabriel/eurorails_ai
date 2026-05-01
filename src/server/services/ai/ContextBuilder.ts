/**
 * ContextBuilder — Thin facade for computing decision-relevant game context.
 *
 * Orchestrates calls to focused computation modules:
 *   - NetworkContext   — reachable cities, connected major cities, phase
 *   - DemandEngine     — demand scoring, en-route pickups
 *   - BuildContext     — build budget, upgrade eligibility
 *   - UpgradeContext   — upgrade advice
 *   - ContextSerializer — LLM prompt serialization
 *
 * The public API (method signatures, BotContext/GameContext shape) is unchanged.
 * All existing call sites continue to work without modification.
 *
 * JIRA-195 Slice 1: ContextBuilder stage-ordering fix and decomposition.
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
  StrategicRoute,
  EnRoutePickup,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { getConnectedMajorCities } from './connectedMajorCities';
import { hexDistance, estimatePathCost, getFerryPairPort } from './MapTopology';
import { MIN_DELIVERIES_BEFORE_UPGRADE } from './AIStrategyEngine';
import { NetworkContext } from './context/NetworkContext';
import { BuildContext } from './context/BuildContext';
import { UpgradeContext } from './context/UpgradeContext';
import {
  computeAllDemandContexts,
  computeCanDeliverFromSnapshot,
  computeCanPickupFromSnapshot,
  computeEnRoutePickupsFromRoute,
  isLoadRuntimeAvailable as _isLoadRuntimeAvailable,
  isFerryOnRoute as _isFerryOnRoute,
  countFerryCrossings as _countFerryCrossings,
  estimateTrackCost,
} from './context/DemandEngine';
import {
  ContextSerializer,
  formatDemandView as _formatDemandView,
  formatReachabilityNote as _formatReachabilityNote,
} from './prompts/ContextSerializer';

export { ContextSerializer };

export class ContextBuilder {

  /**
   * Build a GameContext from the WorldSnapshot for LLM prompt generation.
   * Orchestrates all sub-computations using the focused context modules.
   *
   * @param snapshot    Current game state.
   * @param skillLevel  Bot skill level (for opponent context detail level).
   * @param gridPoints  Full hex grid for city lookups and pathfinding.
   * @param memory      Bot memory — when provided, memory-dependent fields are
   *                    computed correctly in a single pass (JIRA-195 stage-ordering fix).
   */
  static async build(
    snapshot: WorldSnapshot,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
    /** JIRA-195: Memory passed in so memory-dependent fields are computed once, correctly.
     *  Optional for backward compatibility with existing test call sites that omit it. */
    memory?: BotMemoryState,
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
    const connectedMajorCities = getConnectedMajorCities(snapshot.bot.existingSegments).map(c => c.name);

    // Compute demand context for each demand card
    const demands = computeAllDemandContexts(
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );

    // Compute immediate delivery opportunities
    const canDeliver = computeCanDeliverFromSnapshot(snapshot, gridPoints);

    // Compute pickup opportunities at current position
    const canPickup = computeCanPickupFromSnapshot(snapshot, gridPoints);

    // Build cost tracking
    const turnBuildCost = (snapshot.bot as { turnBuildCost?: number }).turnBuildCost ?? 0;

    // Determine if the bot can build
    const canBuild = (20 - turnBuildCost) > 0 && snapshot.bot.money > 0;

    // JIRA-195: Use deliveryCount from memory when available (stage-ordering fix).
    const deliveryCount = memory?.deliveryCount ?? 0;

    // JIRA-207A: Propagate deliveriesCompleted onto snapshot.bot so that
    // BuildContext.checkCanUpgrade can apply the delivery-threshold gate.
    // This avoids changing the checkCanUpgrade signature while keeping the
    // delivery count accessible at the point of the eligibility check.
    snapshot.bot.deliveriesCompleted = deliveryCount;

    // Determine if the bot can upgrade
    const canUpgrade = BuildContext.checkCanUpgrade(snapshot);

    // Compute upgrade advice with deliveryCount gate
    const upgradeAdvice = UpgradeContext.compute(snapshot, demands, canBuild, deliveryCount);

    // Determine game phase
    const isInitialBuild = snapshot.gameStatus === 'initialBuild';
    const phase = NetworkContext.computePhase(snapshot, connectedMajorCities);

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

    // JIRA-195: Compute memory-dependent fields in a single pass when memory is provided.
    const enRoutePickups = memory?.activeRoute?.stops
      ? computeEnRoutePickupsFromRoute(snapshot, memory.activeRoute.stops, gridPoints)
      : undefined;

    let previousTurnSummary: string | undefined;
    if (memory?.lastReasoning || memory?.lastPlanHorizon) {
      const parts: string[] = [];
      if (memory.lastAction) parts.push(`Action: ${memory.lastAction}`);
      if (memory.lastReasoning) parts.push(`Reasoning: ${memory.lastReasoning}`);
      if (memory.lastPlanHorizon) parts.push(`Plan: ${memory.lastPlanHorizon}`);
      previousTurnSummary = parts.join('. ');
    }

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
      loads: [...snapshot.bot.loads],
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
      upgradeAdvice,
      deliveryCount,
      enRoutePickups,
      previousTurnSummary,
    };
  }

  // ── Rebuild helpers (used by TurnExecutorPlanner and tests) ─────────────

  /**
   * Recompute immediate delivery opportunities from a fresh snapshot (JIRA-165).
   */
  static rebuildCanDeliver(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): DeliveryOpportunity[] {
    return computeCanDeliverFromSnapshot(snapshot, gridPoints);
  }

  /**
   * Recompute demand contexts from a fresh snapshot (JIRA-56).
   * Used after DiscardHand to refresh demandRanking with new cards.
   */
  static rebuildDemands(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): DemandContext[] {
    const network = snapshot.bot.existingSegments.length > 0
      ? buildTrackNetwork(snapshot.bot.existingSegments)
      : null;
    const trainType = snapshot.bot.trainType as keyof typeof TRAIN_PROPERTIES;
    const trainProps = TRAIN_PROPERTIES[trainType];
    const speed = snapshot.bot.ferryHalfSpeed
      ? Math.ceil(trainProps.speed / 2)
      : trainProps.speed;
    const botPosition = snapshot.bot.position as { row: number; col: number } | null;
    const reachableCities = botPosition && network
      ? ContextBuilder.computeReachableCities(botPosition, speed, network, gridPoints)
      : [];
    const citiesOnNetwork = network
      ? ContextBuilder.computeCitiesOnNetwork(network, gridPoints)
      : [];
    const connectedMajorCities = getConnectedMajorCities(snapshot.bot.existingSegments).map(c => c.name);
    return computeAllDemandContexts(
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );
  }

  // ── Reachability (public — tested directly) ──────────────────────────────

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
    _visitedFerryPorts?: Set<string>,
  ): string[] {
    const startKey = `${position.row},${position.col}`;
    const visitedFerryPorts = _visitedFerryPorts ?? new Set<string>();
    const ferryStartPoint = gridPoints.find(gp => gp.row === position.row && gp.col === position.col);
    if (ferryStartPoint?.terrain === TerrainType.FerryPort && !visitedFerryPorts.has(startKey)) {
      visitedFerryPorts.add(startKey);
      const ferryEdges = getFerryEdges();
      const pairedPort = getFerryPairPort(position.row, position.col, ferryEdges);
      if (pairedPort) {
        const pairedKey = `${pairedPort.row},${pairedPort.col}`;
        if (network.nodes.has(pairedKey)) {
          console.log(`[ContextBuilder] Ferry teleport: BFS starting from paired port (${pairedPort.row},${pairedPort.col}) instead of ferry port`);
          const ferryReachable = ContextBuilder.computeReachableCities(pairedPort, speed, network, gridPoints, visitedFerryPorts);
          const pairedPoint = gridPoints.find(gp => gp.row === pairedPort.row && gp.col === pairedPort.col);
          const pairedCityName = pairedPoint?.city?.name ?? pairedPoint?.name;
          if (pairedCityName && !ferryReachable.includes(pairedCityName)) ferryReachable.push(pairedCityName);
          return Array.from(new Set(ferryReachable));
        }
      }
    }
    if (!network.nodes.has(startKey)) {
      let bestKey: string | null = null; let bestDist = Infinity;
      for (const nodeKey of Array.from(network.nodes)) {
        const [r, c] = nodeKey.split(',').map(Number);
        const dist = hexDistance(position.row, position.col, r, c);
        if (dist < bestDist) { bestDist = dist; bestKey = nodeKey; }
      }
      if (!bestKey || bestDist > 3) return [];
      const [snapRow, snapCol] = bestKey.split(',').map(Number);
      const adjustedSpeed = Math.max(0, speed - bestDist);
      if (adjustedSpeed <= 0) return [];
      return ContextBuilder.computeReachableCities({ row: snapRow, col: snapCol }, adjustedSpeed, network, gridPoints, visitedFerryPorts);
    }
    const gridLookup = new Map<string, GridPoint>();
    for (const gp of gridPoints) gridLookup.set(`${gp.row},${gp.col}`, gp);
    const bestRemaining = new Map<string, number>();
    bestRemaining.set(startKey, speed);
    const queue: Array<{ key: string; remaining: number }> = [{ key: startKey, remaining: speed }];
    const reachableCities: string[] = [];
    const startPoint = gridLookup.get(startKey);
    const startCityName = startPoint?.city?.name ?? startPoint?.name;
    if (startCityName) reachableCities.push(startCityName);
    while (queue.length > 0) {
      const { key, remaining } = queue.shift()!;
      const neighbors = network.edges.get(key);
      if (!neighbors) continue;
      for (const neighborKey of Array.from(neighbors)) {
        const neighborPoint = gridLookup.get(neighborKey);
        const isFerry = neighborPoint?.terrain === TerrainType.FerryPort;
        const newRemaining = isFerry ? Math.floor((remaining - 1) / 2) : remaining - 1;
        if (newRemaining < 0) continue;
        const prev = bestRemaining.get(neighborKey);
        if (prev !== undefined && prev >= newRemaining) continue;
        bestRemaining.set(neighborKey, newRemaining);
        queue.push({ key: neighborKey, remaining: newRemaining });
        const neighborCityName = neighborPoint?.city?.name ?? neighborPoint?.name;
        if (neighborCityName) reachableCities.push(neighborCityName);
      }
    }
    return Array.from(new Set(reachableCities));
  }

  /**
   * All city names anywhere on the bot's track network (not speed-limited).
   */
  static computeCitiesOnNetwork(
    network: ReturnType<typeof buildTrackNetwork>,
    gridPoints: GridPoint[],
  ): string[] {
    return NetworkContext.computeCitiesOnNetwork(network, gridPoints);
  }

  // ── Load availability (public — tested directly) ─────────────────────────

  /**
   * Check if any copies of loadType are available (not currently carried by any player).
   */
  static isLoadRuntimeAvailable(loadType: string, snapshot: WorldSnapshot): boolean {
    return _isLoadRuntimeAvailable(loadType, snapshot);
  }

  /**
   * Check if a demand route involves a ferry crossing.
   */
  static isFerryOnRoute(supplyCity: string | null, deliveryCity: string, gridPoints: GridPoint[]): boolean {
    return _isFerryOnRoute(supplyCity, deliveryCity, gridPoints);
  }

  /**
   * Count distinct water barrier crossings between supply and delivery.
   */
  static countFerryCrossings(supplyCity: string | null, deliveryCity: string, gridPoints: GridPoint[]): number {
    return _countFerryCrossings(supplyCity, deliveryCity, gridPoints);
  }

  /** Format a unified demand view for LLM prompts (JIRA-133). */
  static formatDemandView(demands: DemandContext[], context: { loads: string[]; unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }> }): string {
    return _formatDemandView(demands, context);
  }

  /**
   * Check build affordability given current cash + projected delivery income.
   */
  static isBuildAffordable(
    estimatedTrackCost: number,
    botMoney: number,
    carriedLoads: string[],
    resolvedDemands: WorldSnapshot['bot']['resolvedDemands'],
    _payout: number,
  ): { affordable: boolean; projectedFunds: number } {
    let projectedIncome = 0;
    for (const loadType of carriedLoads) {
      for (const resolved of resolvedDemands) {
        for (const demand of resolved.demands) {
          if (demand.loadType === loadType) { projectedIncome += demand.payment; break; }
        }
      }
    }
    const projectedFunds = botMoney + projectedIncome;
    return { affordable: estimatedTrackCost <= projectedFunds, projectedFunds };
  }

  // ── En-route pickups (public — tested directly) ──────────────────────────

  /**
   * Scan cities within 3 hex distance of the bot's route stops for loads
   * matching demand cards. Returns top 5 opportunities sorted by net value.
   */
  static computeEnRoutePickups(
    snapshot: WorldSnapshot,
    routeStops: RouteStop[],
    gridPoints: GridPoint[],
  ): EnRoutePickup[] {
    return computeEnRoutePickupsFromRoute(snapshot, routeStops, gridPoints);
  }

  // ── Upgrade advice (public — tested via ContextEquivalence) ─────────────

  /**
   * Generate dynamic upgrade advice with ROI data (JIRA-55 Part C).
   * @param deliveryCount - Current delivery count; advice is suppressed below
   *   MIN_DELIVERIES_BEFORE_UPGRADE to prevent noise (JIRA-161).
   */
  static computeUpgradeAdvice(
    snapshot: WorldSnapshot,
    demands: DemandContext[] = [],
    canBuild: boolean = true,
    deliveryCount: number = 0,
  ): string | undefined {
    return UpgradeContext.compute(snapshot, demands, canBuild, deliveryCount);
  }

  // ── Opponent context ──────────────────────────────────────────────────────

  static buildOpponentContext(
    opponents: WorldSnapshot['opponents'],
    skillLevel: BotSkillLevel,
  ): OpponentContext[] {
    if (skillLevel === BotSkillLevel.Easy) return [];
    if (!opponents || opponents.length === 0) return [];
    return opponents.map(opp => {
      const positionStr = opp.position
        ? `(${opp.position.row},${opp.position.col})`
        : 'unknown';
      if (skillLevel === BotSkillLevel.Medium) {
        return { name: opp.playerId, money: opp.money, trainType: opp.trainType, position: positionStr, loads: [], trackCoverage: '' };
      }
      return { name: opp.playerId, money: opp.money, trainType: opp.trainType, position: positionStr, loads: opp.loads, trackCoverage: opp.trackSummary ?? '' };
    });
  }

  /** Summarize track as "N mileposts. Backbone: ..." (JIRA-133). */
  static computeTrackSummary(segments: TrackSegment[], gridPoints: GridPoint[]): string {
    return NetworkContext.computeTrackSummary(segments, gridPoints);
  }

  // ── Serialize methods (re-export from ContextSerializer) ─────────────────

  static serializePrompt(context: GameContext, skillLevel: BotSkillLevel): string {
    return ContextSerializer.serializePrompt(context, skillLevel);
  }

  static serializeRoutePlanningPrompt(
    context: GameContext, skillLevel: BotSkillLevel, gridPoints: GridPoint[],
    segments: TrackSegment[] = [], lastAbandonedRouteKey?: string | null, previousRouteStops?: RouteStop[] | null,
  ): string {
    return ContextSerializer.serializeRoutePlanningPrompt(context, skillLevel, gridPoints, segments, lastAbandonedRouteKey, previousRouteStops);
  }

  static serializeSecondaryDeliveryPrompt(snapshot: WorldSnapshot, routeStops: RouteStop[], demands: DemandContext[], enRoutePickups: EnRoutePickup[]): string {
    return ContextSerializer.serializeSecondaryDeliveryPrompt(snapshot, routeStops, demands, enRoutePickups);
  }

  static serializeCargoConflictPrompt(snapshot: WorldSnapshot, plannedRoute: StrategicRoute, conflictingLoads: string[], demands: DemandContext[]): string {
    return ContextSerializer.serializeCargoConflictPrompt(snapshot, plannedRoute, conflictingLoads, demands);
  }

  static serializeUpgradeBeforeDropPrompt(snapshot: WorldSnapshot, route: StrategicRoute, upgradeOptions: { targetTrain: string; cost: number }[], totalRoutePayout: number, demands: DemandContext[]): string {
    return ContextSerializer.serializeUpgradeBeforeDropPrompt(snapshot, route, upgradeOptions, totalRoutePayout, demands);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** JIRA-127: Apply multi-turn budget penalty when estimated cost exceeds 20M. */
  private static applyBudgetPenalty(cost: number): number { return cost <= 20 ? cost : cost * (1 + 0.15 * (Math.ceil(cost / 20) - 1)); }

  /** Determine game phase. Private but accessible via `as any` in tests. */
  private static computePhase(snapshot: WorldSnapshot, connectedMajorCities: string[]): string {
    return NetworkContext.computePhase(snapshot, connectedMajorCities);
  }

  /** Format reachability note for a demand. Private but accessible via `as any` in tests. */
  private static formatReachabilityNote(d: DemandContext, skillLevel: BotSkillLevel): string {
    return _formatReachabilityNote(d, skillLevel);
  }

  private static getCityNameAtPosition(
    position: { row: number; col: number },
    gridPoints: GridPoint[],
  ): string | undefined {
    const point = gridPoints.find(gp => gp.row === position.row && gp.col === position.col);
    return point?.city?.name;
  }

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
        estimatedCost: estimateTrackCost(cityName, segments, gridPoints),
      }))
      .sort((a, b) => a.estimatedCost - b.estimatedCost);
  }

}
