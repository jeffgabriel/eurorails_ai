/**
 * ActionResolver — Translates LLM strategic intent into validated, executable TurnPlan.
 *
 * Resolves LLM action intents into validated TurnPlans.
 * Each resolver pathfinds to ONE target per call (not all targets simultaneously).
 * Uses existing shared services for pathfinding, validation, and fee calculation.
 */

import {
  LLMActionIntent,
  LLMAction,
  WorldSnapshot,
  GameContext,
  ResolvedAction,
  TurnPlan,
  TurnPlanBuildTrack,
  TurnPlanMoveTrain,
  TurnPlanDeliverLoad,
  TurnPlanPickupLoad,
  TurnPlanDropLoad,
  TurnPlanUpgradeTrain,
  TurnPlanDiscardHand,
  TurnPlanPassTurn,
  AIActionType,
  TerrainType,
  TrackSegment,
  TrainType,
  TRACK_USAGE_FEE,
  PlayerTrackState,
} from '../../../shared/types/GameTypes';
import { loadGridPoints, GridCoord, GridPointData, hexDistance } from './MapTopology';
import { getMajorCityGroups, getMajorCityLookup, computeEffectivePathLength } from '../../../shared/services/majorCityGroups';
import { computeBuildSegments } from './computeBuildSegments';
import { computeTrackUsageForMove } from '../../../shared/services/trackUsageFees';
import { getTrainSpeed, getTrainCapacity } from '../../../shared/services/trainProperties';

export class ActionResolver {
  /**
   * Resolve an LLM intent into a validated TurnPlan.
   * Dispatches to specific resolveX methods based on the action type.
   */
  static async resolve(
    intent: LLMActionIntent,
    snapshot: WorldSnapshot,
    context: GameContext,
    startingCity?: string,
  ): Promise<ResolvedAction> {
    if (intent.actions && intent.actions.length > 0) {
      return ActionResolver.resolveMultiAction(intent.actions, snapshot, context, startingCity);
    }

    if (!intent.action) {
      return { success: false, error: "LLM intent must specify 'action' or 'actions'." };
    }

    return ActionResolver.resolveSingleAction(intent.action, intent.details ?? {}, snapshot, context, startingCity);
  }

  /**
   * Dispatch a single action to the appropriate resolver.
   */
  private static async resolveSingleAction(
    action: string,
    details: Record<string, string>,
    snapshot: WorldSnapshot,
    context: GameContext,
    startingCity?: string,
  ): Promise<ResolvedAction> {
    switch (action) {
      case AIActionType.BuildTrack:
      case 'BUILD':
        return ActionResolver.resolveBuild(details, snapshot, context, startingCity);
      case AIActionType.MoveTrain:
      case 'MOVE':
        return ActionResolver.resolveMove(details, snapshot);
      case AIActionType.DeliverLoad:
      case 'DELIVER':
        return ActionResolver.resolveDeliver(details, snapshot);
      case AIActionType.PickupLoad:
      case 'PICKUP':
        return ActionResolver.resolvePickup(details, snapshot, context);
      case AIActionType.UpgradeTrain:
      case 'UPGRADE':
        return ActionResolver.resolveUpgrade(details, snapshot);
      case AIActionType.DropLoad:
      case 'DROP':
        return ActionResolver.resolveDropLoad(details, snapshot);
      case AIActionType.DiscardHand:
      case 'DISCARD_HAND':
        return ActionResolver.resolveDiscard(snapshot);
      case AIActionType.PassTurn:
      case 'PASS':
        return ActionResolver.resolvePass();
      default:
        return { success: false, error: `Unknown action type: "${action}". Valid actions: BUILD, MOVE, DELIVER, PICKUP, DROP, UPGRADE, DISCARD_HAND, PASS.` };
    }
  }

  // ─── Individual Resolvers (stubs, implemented in BE-010 through BE-013) ───

  /**
   * Resolve a BUILD intent into a TurnPlanBuildTrack.
   *
   * Steps:
   *   1. Validate the target city from details.toward.
   *   2. Determine start positions (track frontier or major city centers for cold-start).
   *   3. Compute build budget, occupied edges.
   *   4. Call computeBuildSegments with target positions.
   *   5. Return the resulting segments or a descriptive error.
   */
  private static async resolveBuild(
    details: Record<string, string>,
    snapshot: WorldSnapshot,
    context: GameContext,
    startingCity?: string,
  ): Promise<ResolvedAction> {
    const targetCity = details.toward ?? details.target ?? details.city;
    if (!targetCity) {
      return { success: false, error: 'BUILD requires details.toward specifying the target city name.' };
    }

    // Find target mileposts for the named city (exclude unbuildable major city centers)
    const targetPositions = ActionResolver.findCityMilepost(targetCity, snapshot, true);
    if (targetPositions.length === 0) {
      return { success: false, error: `Target city "${targetCity}" not found on the map.` };
    }

    const budget = ActionResolver.getBuildBudget(snapshot, context.turnBuildCost);
    if (budget <= 0) {
      return { success: false, error: `No budget available to build (money=${snapshot.bot.money}, turnBuildCost=${context.turnBuildCost}).` };
    }

    // Determine start positions: track frontier for regular build,
    // major city centers for cold-start (no existing track).
    const hasTrack = snapshot.bot.existingSegments.length > 0;
    let startPositions: GridCoord[];
    if (hasTrack) {
      startPositions = ActionResolver.getTrackFrontier(snapshot);
    } else {
      // Cold-start: constrain to startingCity if provided and valid
      const groups = getMajorCityGroups();
      if (startingCity) {
        const match = groups.find(
          g => g.cityName.toLowerCase() === startingCity.toLowerCase(),
        );
        if (match) {
          startPositions = [
            { row: match.center.row, col: match.center.col },
            ...match.outposts.map(o => ({ row: o.row, col: o.col })),
          ];
        } else {
          // JIRA-80: startingCity may be a Small/Medium city — look up in gridPoints
          const gridPoints = loadGridPoints();
          const cityPositions: GridCoord[] = [];
          for (const [, gp] of gridPoints) {
            if (gp.name && gp.name.toLowerCase() === startingCity.toLowerCase()) {
              cityPositions.push({ row: gp.row, col: gp.col });
            }
          }
          if (cityPositions.length > 0) {
            console.log(`[ActionResolver] startingCity "${startingCity}" is non-major — using grid coordinates (${cityPositions.length} positions)`);
            startPositions = cityPositions;
          } else {
            console.warn(`[ActionResolver] startingCity "${startingCity}" not found in gridPoints — falling back to all major cities.`);
            startPositions = groups.map(g => ({ row: g.center.row, col: g.center.col }));
          }
        }
      } else {
        startPositions = groups.map(g => ({ row: g.center.row, col: g.center.col }));
      }
    }

    if (startPositions.length === 0) {
      return { success: false, error: 'No valid start positions for building track.' };
    }

    // Sort target positions by proximity to track frontier (or start positions for cold-start).
    // This biases Dijkstra path selection toward the closest connection point.
    const referencePoints = hasTrack
      ? ActionResolver.getTrackFrontier(snapshot)
      : startPositions;
    targetPositions.sort((a, b) => {
      const distA = Math.min(...referencePoints.map(rp => hexDistance(a.row, a.col, rp.row, rp.col)));
      const distB = Math.min(...referencePoints.map(rp => hexDistance(b.row, b.col, rp.row, rp.col)));
      return distA - distB;
    });

    const occupiedEdges = ActionResolver.getOccupiedEdges(snapshot);

    const segments = computeBuildSegments(
      startPositions,
      snapshot.bot.existingSegments,
      budget,
      budget, // maxSegments = budget (cheapest segment costs 1M)
      occupiedEdges,
      targetPositions,
    );

    if (segments.length === 0) {
      return {
        success: false,
        error: `Could not find a path to build toward "${targetCity}" within budget (${budget}M).`,
      };
    }

    const plan: TurnPlanBuildTrack = {
      type: AIActionType.BuildTrack,
      segments,
      targetCity,
    };

    return { success: true, plan };
  }

  /**
   * Resolve a MOVE intent into a TurnPlanMoveTrain.
   *
   * Uses computeTrackUsageForMove which finds the optimal path through the
   * union track graph (all players' tracks + major city red areas + ferries),
   * preferring own track to minimize fees.
   *
   * If the full path exceeds the speed limit, the path is truncated to the
   * maximum distance the bot can travel this turn (partial move toward destination).
   */
  static async resolveMove(
    details: Record<string, string>,
    snapshot: WorldSnapshot,
    remainingSpeed?: number,
  ): Promise<ResolvedAction> {
    const targetCity = details.to ?? details.toward ?? details.city;
    if (!targetCity) {
      return { success: false, error: 'MOVE requires details.to specifying the destination city name.' };
    }

    if (!snapshot.bot.position) {
      return { success: false, error: 'Bot has no position on the map. Cannot move.' };
    }

    const targetPositions = ActionResolver.findCityMilepost(targetCity, snapshot);
    if (targetPositions.length === 0) {
      return { success: false, error: `Destination city "${targetCity}" not found on the map.` };
    }

    // Check if already at the target city
    if (ActionResolver.isBotAtCity(snapshot, targetCity)) {
      return { success: false, error: `Bot is already at "${targetCity}".` };
    }

    // Ferry crossing: if bot is at a ferry port, teleport to paired port
    // and apply half speed for this turn (game rule).
    let fromPosition = snapshot.bot.position;
    let speed = ActionResolver.getBotSpeed(snapshot);
    let skipFerryPortKey: string | null = null;

    const ferryCrossing = ActionResolver.resolveFerryCrossing(fromPosition, snapshot);
    if (ferryCrossing) {
      skipFerryPortKey = `${fromPosition.row},${fromPosition.col}`;
      fromPosition = ferryCrossing.pairedPort;
      const rawSpeed = getTrainSpeed(snapshot.bot.trainType as TrainType);
      speed = Math.ceil(rawSpeed / 2);
      console.log(`[Ferry] Crossing ${ferryCrossing.ferryName}: (${skipFerryPortKey}) → (${fromPosition.row},${fromPosition.col}) — half speed (${speed})`);

      // After ferry teleportation, check if the bot landed at the target city.
      // Dublin is both a Small City and a ferry endpoint — when the target IS the
      // paired port, pathfinding from (24,10) to (24,10) returns an empty path
      // which gets rejected. Instead, return a successful zero-length move.
      const atTargetAfterFerry = targetPositions.some(
        tp => tp.row === fromPosition.row && tp.col === fromPosition.col,
      );
      if (atTargetAfterFerry) {
        console.log(`[Ferry] Bot arrived at ${targetCity} via ferry crossing — zero movement`);
        const plan: TurnPlanMoveTrain = {
          type: AIActionType.MoveTrain,
          path: [fromPosition],
          fees: new Set<string>(),
          totalFee: 0,
        };
        return { success: true, plan };
      }
    }

    // Try each target milepost (major cities have multiple), pick the shortest valid path
    let bestResult: { path: { row: number; col: number }[]; fees: Set<string>; totalFee: number } | null = null;

    for (const target of targetPositions) {
      const usage = computeTrackUsageForMove({
        allTracks: snapshot.allPlayerTracks as PlayerTrackState[],
        from: fromPosition,
        to: target,
        currentPlayerId: snapshot.bot.playerId,
      });

      if (!usage.isValid) continue;
      if (usage.path.length === 0) continue;

      // Reconstruct the full path as {row, col}[] from PathEdge[]
      const fullPath: { row: number; col: number }[] = [
        { row: usage.path[0].from.row, col: usage.path[0].from.col },
      ];
      for (const edge of usage.path) {
        fullPath.push({ row: edge.to.row, col: edge.to.col });
      }

      // Truncate to speed limit if the path is too long (partial move toward destination).
      // Use effective path length (discounting intra-city hops) for movement budget.
      const effectiveSpeed = remainingSpeed ?? speed;
      const majorCityLookup = getMajorCityLookup();
      const rawPathLength = usage.path.length;
      const effectivePathLen = computeEffectivePathLength(fullPath, majorCityLookup);

      // Find the raw truncation index where effective mileposts reach the speed limit
      let pathLength = rawPathLength;
      if (effectivePathLen > effectiveSpeed) {
        let effectiveCount = 0;
        for (let idx = 0; idx < fullPath.length - 1; idx++) {
          const fromKey = `${fullPath[idx].row},${fullPath[idx].col}`;
          const toKey = `${fullPath[idx + 1].row},${fullPath[idx + 1].col}`;
          const fromCity = majorCityLookup.get(fromKey);
          const toCity = majorCityLookup.get(toKey);
          if (!(fromCity && fromCity === toCity)) {
            effectiveCount++;
          }
          if (effectiveCount >= effectiveSpeed) {
            pathLength = idx + 1; // raw index for truncation
            break;
          }
        }
        console.warn(
          `[Movement Budget] MOVE truncated: raw ${rawPathLength} edges, effective ${effectivePathLen}mp, budget ${effectiveSpeed}mp remaining`,
        );
      } else if (effectivePathLen !== rawPathLength) {
        console.warn(
          `[Movement Budget] Path: raw ${rawPathLength} edges, effective ${effectivePathLen}mp (intra-city hops discounted)`,
        );
      }
      let truncatedPath = fullPath.slice(0, pathLength + 1); // +1 for the start node

      // Ferry detection: if path passes through a FerryPort, truncate at the port.
      // The bot must stop at the ferry port for this turn (game rule).
      // Skip index 0 (the starting position — bot is already there).
      // Also skip the departure port when the bot just crossed a ferry (skipFerryPortKey).
      const grid = loadGridPoints();
      for (let i = 1; i < truncatedPath.length; i++) {
        const pointKey = `${truncatedPath[i].row},${truncatedPath[i].col}`;
        if (pointKey === skipFerryPortKey) continue; // departure port from ferry crossing
        const pointData = grid.get(pointKey);
        if (pointData && pointData.terrain === TerrainType.FerryPort) {
          console.warn(`[Ferry] Path truncated at ferry port ${pointData.name ?? pointKey} (step ${i}/${truncatedPath.length - 1})`);
          pathLength = i;
          truncatedPath = fullPath.slice(0, i + 1);
          break;
        }
      }

      // Recalculate fees for the truncated path only
      const truncatedEdges = usage.path.slice(0, pathLength);
      const truncatedOwners = new Set<string>();
      for (const edge of truncatedEdges) {
        const owners = edge.ownerPlayerIds ?? [];
        for (const ownerId of owners) {
          if (ownerId !== snapshot.bot.playerId) {
            truncatedOwners.add(ownerId);
          }
        }
      }
      const totalFee = truncatedOwners.size * TRACK_USAGE_FEE;

      // Pick the shortest path, then least expensive
      if (
        !bestResult ||
        pathLength < bestResult.path.length - 1 ||
        (pathLength === bestResult.path.length - 1 && totalFee < bestResult.totalFee)
      ) {
        bestResult = {
          path: truncatedPath,
          fees: truncatedOwners,
          totalFee,
        };
      }
    }

    if (!bestResult) {
      return {
        success: false,
        error: `No valid path to "${targetCity}" on existing track network.`,
      };
    }

    // Check funds: need totalFee + MONEY_RESERVE
    if (bestResult.totalFee > 0 && snapshot.bot.money < bestResult.totalFee + ActionResolver.MONEY_RESERVE) {
      return {
        success: false,
        error: `Insufficient funds for track usage fees. Need ${bestResult.totalFee}M + ${ActionResolver.MONEY_RESERVE}M reserve, have ${snapshot.bot.money}M.`,
      };
    }

    const plan: TurnPlanMoveTrain = {
      type: AIActionType.MoveTrain,
      path: bestResult.path,
      fees: bestResult.fees,
      totalFee: bestResult.totalFee,
    };

    return { success: true, plan };
  }

  /**
   * Resolve a DELIVER intent into a TurnPlanDeliverLoad.
   *
   * Checks: bot is at the delivery city, bot carries the load,
   * and a matching demand card exists.
   */
  private static async resolveDeliver(
    details: Record<string, string>,
    snapshot: WorldSnapshot,
  ): Promise<ResolvedAction> {
    const loadType = details.load;
    const cityName = details.at ?? details.city ?? details.to;
    if (!loadType || !cityName) {
      return { success: false, error: 'DELIVER requires details.load and details.at specifying the load type and delivery city.' };
    }

    // Bot must be at the delivery city
    if (!ActionResolver.isBotAtCity(snapshot, cityName)) {
      return { success: false, error: `Bot is not at "${cityName}". Move there before delivering.` };
    }

    // Bot must be carrying the load
    if (!snapshot.bot.loads.includes(loadType)) {
      return { success: false, error: `Bot is not carrying "${loadType}". Current loads: [${snapshot.bot.loads.join(', ')}].` };
    }

    // Must have a matching demand card
    const match = ActionResolver.findMatchingDemand(loadType, cityName, snapshot);
    if (!match) {
      return { success: false, error: `No demand card for "${loadType}" at "${cityName}".` };
    }

    const plan: TurnPlanDeliverLoad = {
      type: AIActionType.DeliverLoad,
      load: loadType,
      city: cityName,
      cardId: match.cardId,
      payout: match.payout,
    };

    return { success: true, plan };
  }

  /**
   * Resolve a PICKUP intent into a TurnPlanPickupLoad.
   *
   * Checks: bot is at the pickup city, bot has capacity,
   * city produces the load (static), and load chip is available (runtime).
   */
  private static async resolvePickup(
    details: Record<string, string>,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<ResolvedAction> {
    const loadType = details.load;
    const cityName = details.at ?? details.city ?? details.from;
    if (!loadType || !cityName) {
      return { success: false, error: 'PICKUP requires details.load and details.at specifying the load type and pickup city.' };
    }

    // Bot must be at the pickup city
    if (!ActionResolver.isBotAtCity(snapshot, cityName)) {
      return { success: false, error: `Bot is not at "${cityName}". Move there before picking up.` };
    }

    // Bot must have capacity
    const capacity = ActionResolver.getBotCapacity(snapshot);
    if (snapshot.bot.loads.length >= capacity) {
      return { success: false, error: `Train is full (${snapshot.bot.loads.length}/${capacity}). Drop a load first.` };
    }

    // Bot must hold a demand card matching this load type (no speculative pickups)
    const hasDemandMatch = snapshot.bot.resolvedDemands.some(
      rd => rd.demands.some(d => d.loadType === loadType),
    );
    if (!hasDemandMatch) {
      console.warn(`[Pickup] Rejected speculative pickup: "${loadType}" at "${cityName}" — no matching demand card`);
      return { success: false, error: `No demand card matches "${loadType}". Only pick up loads you have a demand for.` };
    }

    // Advisory: warn when no matching demand has a feasible delivery route.
    // Does NOT block the pickup — the LLM may be executing a multi-turn build plan.
    // Hard blocking is handled upstream by GuardrailEnforcer.bestPickups (G2 feasibility filter).
    const matchingDemands = context.demands.filter(d => d.loadType === loadType && !d.isLoadOnTrain);
    if (matchingDemands.length > 0) {
      const hasFeasibleDelivery = matchingDemands.some(
        d => d.isDeliveryOnNetwork || d.estimatedTrackCostToDelivery <= snapshot.bot.money,
      );
      if (!hasFeasibleDelivery) {
        const bestDemand = matchingDemands[0];
        console.warn(
          `[Pickup Advisory] No immediately feasible delivery for "${loadType}" at "${cityName}" — ` +
          `delivery to "${bestDemand.deliveryCity}" costs ~${bestDemand.estimatedTrackCostToDelivery}M, ` +
          `bot has ${snapshot.bot.money}M. LLM may have a multi-turn build plan.`,
        );
      }
    }

    // City must produce this load (static availability)
    const cityLoads = snapshot.loadAvailability[cityName];
    if (!cityLoads || !cityLoads.includes(loadType)) {
      return { success: false, error: `"${cityName}" does not produce "${loadType}".` };
    }

    // Load chip must be available at runtime
    if (!ActionResolver.isLoadRuntimeAvailable(loadType, snapshot)) {
      return { success: false, error: `No "${loadType}" chips are currently available (all carried by players).` };
    }

    const plan: TurnPlanPickupLoad = {
      type: AIActionType.PickupLoad,
      load: loadType,
      city: cityName,
    };

    return { success: true, plan };
  }

  /**
   * Resolve a DROP intent into a TurnPlanDropLoad.
   *
   * Checks: bot is at a city and bot carries the specified load.
   */
  private static async resolveDropLoad(
    details: Record<string, string>,
    snapshot: WorldSnapshot,
  ): Promise<ResolvedAction> {
    const loadType = details.load;
    const cityName = details.at ?? details.city;
    if (!loadType) {
      return { success: false, error: 'DROP requires details.load specifying the load type to drop.' };
    }

    // Bot must be carrying the load
    if (!snapshot.bot.loads.includes(loadType)) {
      return { success: false, error: `Bot is not carrying "${loadType}". Current loads: [${snapshot.bot.loads.join(', ')}].` };
    }

    // Resolve city from bot position if not specified
    let resolvedCity = cityName;
    if (!resolvedCity) {
      const grid = loadGridPoints();
      const posKey = snapshot.bot.position
        ? `${snapshot.bot.position.row},${snapshot.bot.position.col}`
        : '';
      const point = posKey ? grid.get(posKey) : undefined;
      resolvedCity = point?.name ?? '';
    }

    if (!resolvedCity) {
      return { success: false, error: 'Bot is not at a named city. Loads can only be dropped at cities.' };
    }

    // Verify bot is actually at the city (if explicitly specified)
    if (cityName && !ActionResolver.isBotAtCity(snapshot, cityName)) {
      return { success: false, error: `Bot is not at "${cityName}". Move there before dropping.` };
    }

    const plan: TurnPlanDropLoad = {
      type: AIActionType.DropLoad,
      load: loadType,
      city: resolvedCity,
    };

    return { success: true, plan };
  }

  /** Valid upgrade paths: source -> { target -> cost } */
  private static readonly UPGRADE_PATHS: Record<string, Record<string, number>> = {
    [TrainType.Freight]: {
      [TrainType.FastFreight]: 20,
      [TrainType.HeavyFreight]: 20,
    },
    [TrainType.FastFreight]: {
      [TrainType.Superfreight]: 20,
      [TrainType.HeavyFreight]: 5, // crossgrade
    },
    [TrainType.HeavyFreight]: {
      [TrainType.Superfreight]: 20,
      [TrainType.FastFreight]: 5, // crossgrade
    },
  };

  /**
   * Resolve an UPGRADE intent into a TurnPlanUpgradeTrain.
   *
   * Validates the upgrade path, cost, and that the bot is not in initialBuild phase.
   */
  private static async resolveUpgrade(
    details: Record<string, string>,
    snapshot: WorldSnapshot,
  ): Promise<ResolvedAction> {
    const targetTrain = details.to ?? details.train ?? details.target;
    if (!targetTrain) {
      return { success: false, error: 'UPGRADE requires details.to specifying the target train type.' };
    }

    // Validate the upgrade path
    const currentTrain = snapshot.bot.trainType;
    const paths = ActionResolver.UPGRADE_PATHS[currentTrain];
    if (!paths || !(targetTrain in paths)) {
      const validTargets = paths ? Object.keys(paths).join(', ') : 'none';
      return {
        success: false,
        error: `Cannot upgrade from "${currentTrain}" to "${targetTrain}". Valid targets: ${validTargets}.`,
      };
    }

    const cost = paths[targetTrain];

    // Check funds
    if (snapshot.bot.money < cost) {
      return {
        success: false,
        error: `Insufficient funds for upgrade. Need ${cost}M, have ${snapshot.bot.money}M.`,
      };
    }

    const plan: TurnPlanUpgradeTrain = {
      type: AIActionType.UpgradeTrain,
      targetTrain,
      cost,
    };

    return { success: true, plan };
  }

  /**
   * Resolve a DISCARD_HAND intent into a TurnPlanDiscardHand.
   *
   * Per game rules, a player may discard their entire hand and draw 3 new cards
   * instead of taking a normal turn. Always succeeds (the GuardrailEnforcer handles
   * any situational blocks like consecutive discards).
   */
  private static async resolveDiscard(
    _snapshot: WorldSnapshot,
  ): Promise<ResolvedAction> {
    const plan: TurnPlanDiscardHand = {
      type: AIActionType.DiscardHand,
    };
    return { success: true, plan };
  }

  /**
   * Resolve a PASS intent into a TurnPlanPassTurn.
   * Always succeeds — passing is always valid.
   */
  private static async resolvePass(): Promise<ResolvedAction> {
    const plan: TurnPlanPassTurn = {
      type: AIActionType.PassTurn,
    };
    return { success: true, plan };
  }

  /**
   * Resolve a multi-action intent into a TurnPlanMultiAction.
   *
   * Validates combination legality upfront (DISCARD_HAND exclusivity,
   * UPGRADE(20M)+BUILD forbidden), then resolves each action sequentially
   * with cumulative state simulation between steps.
   * If any individual action fails, the entire multi-action fails.
   */
  private static async resolveMultiAction(
    actions: LLMAction[],
    snapshot: WorldSnapshot,
    context: GameContext,
    startingCity?: string,
  ): Promise<ResolvedAction> {
    if (actions.length === 0) {
      return { success: false, error: 'Multi-action must contain at least one action.' };
    }

    // Single action passed as multi-action: resolve as single
    if (actions.length === 1) {
      const a = actions[0];
      return ActionResolver.resolveSingleAction(a.action, a.details ?? {}, snapshot, context, startingCity);
    }

    const actionTypes = actions.map(a => a.action);

    // Upfront combination legality: DISCARD_HAND is exclusive
    const hasDiscard = actionTypes.some(
      t => t === AIActionType.DiscardHand || t === 'DISCARD_HAND',
    );
    if (hasDiscard) {
      return {
        success: false,
        error: 'Discard Hand ends the turn immediately. Cannot combine with other actions.',
      };
    }

    // Upfront combination legality: UPGRADE(20M) + BUILD forbidden
    const hasUpgrade = actionTypes.some(
      t => t === AIActionType.UpgradeTrain || t === 'UPGRADE',
    );
    const hasBuild = actionTypes.some(
      t => t === AIActionType.BuildTrack || t === 'BUILD',
    );
    if (hasUpgrade && hasBuild) {
      return {
        success: false,
        error: 'Cannot upgrade and build track in the same turn.',
      };
    }

    // Resolve each action sequentially with cumulative state simulation
    const plans: TurnPlan[] = [];
    let currentSnapshot = ActionResolver.cloneSnapshot(snapshot);
    let currentContext = { ...context };
    let movementUsed = 0;
    const maxMovement = context.speed;

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const isMove = a.action === AIActionType.MoveTrain || a.action === 'MOVE';
      const budgetRemaining = maxMovement - movementUsed;

      let result: ResolvedAction;
      if (isMove) {
        if (budgetRemaining <= 0) {
          console.warn(
            `[Movement Budget] Step ${i + 1} MOVE skipped: 0mp remaining (${movementUsed}mp used of ${maxMovement}mp)`,
          );
          continue;
        }
        result = await ActionResolver.resolveMove(
          a.details ?? {},
          currentSnapshot,
          budgetRemaining,
        );
      } else {
        result = await ActionResolver.resolveSingleAction(
          a.action,
          a.details ?? {},
          currentSnapshot,
          currentContext,
          startingCity,
        );
      }

      if (!result.success) {
        return {
          success: false,
          error: `Step ${i + 1} (${a.action}) failed: ${result.error}`,
        };
      }
      plans.push(result.plan!);

      // Track cumulative movement from MOVE plans (effective mileposts, discounting intra-city hops)
      if (isMove && result.plan) {
        const movePlan = result.plan as TurnPlanMoveTrain;
        const stepsUsed = computeEffectivePathLength(movePlan.path, getMajorCityLookup());
        movementUsed += stepsUsed;
      }

      // Simulate state changes for subsequent steps
      ActionResolver.applyPlanToState(result.plan!, currentSnapshot, currentContext);
    }

    return {
      success: true,
      plan: { type: 'MultiAction' as const, steps: plans },
    };
  }

  /**
   * Create a shallow clone of a WorldSnapshot with a deep-cloned bot sub-object.
   * Used for cumulative state simulation in multi-action resolution.
   */
  static cloneSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
    return {
      ...snapshot,
      bot: {
        ...snapshot.bot,
        loads: [...snapshot.bot.loads],
        existingSegments: [...snapshot.bot.existingSegments],
        demandCards: [...snapshot.bot.demandCards],
        resolvedDemands: snapshot.bot.resolvedDemands.map(rd => ({
          ...rd,
          demands: [...rd.demands],
        })),
      },
      allPlayerTracks: snapshot.allPlayerTracks.map(pt => ({
        ...pt,
        segments: pt.playerId === snapshot.bot.playerId ? [...pt.segments] : pt.segments,
      })),
    };
  }

  /**
   * Apply a resolved TurnPlan's effects to the working snapshot and context.
   * Used for cumulative state simulation in multi-action resolution.
   */
  static applyPlanToState(
    plan: TurnPlan,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): void {
    switch (plan.type) {
      case AIActionType.MoveTrain: {
        const movePlan = plan as TurnPlanMoveTrain;
        const lastPos = movePlan.path[movePlan.path.length - 1];
        if (lastPos) {
          snapshot.bot.position = { row: lastPos.row, col: lastPos.col };
          context.position = { row: lastPos.row, col: lastPos.col };
        }
        if (movePlan.totalFee > 0) {
          snapshot.bot.money -= movePlan.totalFee;
          context.money -= movePlan.totalFee;
        }
        break;
      }
      case AIActionType.PickupLoad: {
        const pickupPlan = plan as TurnPlanPickupLoad;
        snapshot.bot.loads.push(pickupPlan.load);
        context.loads = [...snapshot.bot.loads];
        break;
      }
      case AIActionType.DeliverLoad: {
        const deliverPlan = plan as TurnPlanDeliverLoad;
        const loadIdx = snapshot.bot.loads.indexOf(deliverPlan.load);
        if (loadIdx >= 0) snapshot.bot.loads.splice(loadIdx, 1);
        context.loads = [...snapshot.bot.loads];
        snapshot.bot.money += deliverPlan.payout;
        context.money += deliverPlan.payout;
        // Remove the fulfilled demand card
        snapshot.bot.resolvedDemands = snapshot.bot.resolvedDemands.filter(
          rd => rd.cardId !== deliverPlan.cardId,
        );
        break;
      }
      case AIActionType.BuildTrack: {
        const buildPlan = plan as TurnPlanBuildTrack;
        const buildCost = buildPlan.segments.reduce((sum, s) => sum + s.cost, 0);
        snapshot.bot.money -= buildCost;
        context.money -= buildCost;
        snapshot.bot.existingSegments.push(...buildPlan.segments);
        // Update allPlayerTracks for the bot
        const botTracks = snapshot.allPlayerTracks.find(
          pt => pt.playerId === snapshot.bot.playerId,
        );
        if (botTracks) {
          botTracks.segments.push(...buildPlan.segments);
        }
        context.turnBuildCost += buildCost;
        break;
      }
      case AIActionType.UpgradeTrain: {
        const upgradePlan = plan as TurnPlanUpgradeTrain;
        snapshot.bot.money -= upgradePlan.cost;
        context.money -= upgradePlan.cost;
        snapshot.bot.trainType = upgradePlan.targetTrain as TrainType;
        context.trainType = upgradePlan.targetTrain as TrainType;
        context.speed = getTrainSpeed(upgradePlan.targetTrain as TrainType);
        context.capacity = getTrainCapacity(upgradePlan.targetTrain as TrainType);
        break;
      }
      // PassTurn and DiscardHand don't change state
      default:
        break;
    }
  }

  /**
   * @deprecated Use PassTurn with debug overlay logging instead.
   * All call sites removed in favor of visible LLM failure handling.
   *
   * Heuristic fallback when the LLM fails twice.
   * Priority: deliver > pickup > move to pickup/delivery > build toward best demand > pass.
   *
   * Reuses the existing resolveDeliver/resolveBuild/resolvePass methods
   * to ensure all validation is applied consistently.
   */
  static async heuristicFallback(
    context: GameContext,
    snapshot: WorldSnapshot,
  ): Promise<ResolvedAction> {
    // 1. Try to DELIVER if there are immediate opportunities
    if (context.canDeliver && context.canDeliver.length > 0) {
      // Pick the highest-payout delivery
      const best = context.canDeliver.reduce((a, b) => (a.payout > b.payout ? a : b));
      const result = await ActionResolver.resolveDeliver(
        { load: best.loadType, at: best.deliveryCity },
        snapshot,
      );
      if (result.success) return result;
    }

    // 1b. Try to PICKUP if there are available loads at current position
    // JIRA-94: Skip pickup when broke — picking up a load you can't afford to deliver
    // just creates a drop/pickup loop. Let step 1c fire to discard for new demand cards.
    const isBrokeWithNoAffordableDemands = snapshot.bot.money < 5 && context.demands.every(d => !d.isAffordable);
    if (context.canPickup && context.canPickup.length > 0 && !isBrokeWithNoAffordableDemands) {
      const best = context.canPickup.reduce((a, b) => (a.bestPayout > b.bestPayout ? a : b));
      const result = await ActionResolver.resolvePickup(
        { load: best.loadType, at: best.supplyCity },
        snapshot,
        context,
      );
      if (result.success) return result;
    }

    // 1c. JIRA-71: Broke-bot discard — if cash < 5M and no demand is affordable,
    // discard immediately instead of cycling through futile move/build/drop actions.
    // Only skip if bot can deliver right now (step 1 above would have returned).
    if (!context.isInitialBuild && snapshot.bot.money < 5 && context.demands.length > 0 &&
        context.demands.every(d => !d.isAffordable) &&
        (!context.canDeliver || context.canDeliver.length === 0)) {
      console.warn(
        `[heuristicFallback] JIRA-71: Broke bot detected — cash=${snapshot.bot.money}M, ` +
        `no affordable demands. Discarding hand immediately.`,
      );
      return ActionResolver.resolveDiscard(snapshot);
    }

    // 2. Try to MOVE toward a pickup or delivery city on the network
    if (snapshot.bot.position && !context.isInitialBuild) {
      // 2a. If carrying a load, move toward the delivery city
      for (const demand of context.demands) {
        if (demand.isLoadOnTrain && demand.isDeliveryOnNetwork && !demand.isDeliveryReachable) {
          const result = await ActionResolver.resolveMove(
            { to: demand.deliveryCity },
            snapshot,
          );
          if (result.success) return result;
        }
      }

      // 2b. If not carrying a load, move toward supply city on network
      for (const demand of [...context.demands].sort((a, b) => b.payout - a.payout)) {
        if (!demand.isLoadOnTrain && demand.isSupplyOnNetwork && !demand.isSupplyReachable) {
          const result = await ActionResolver.resolveMove(
            { to: demand.supplyCity },
            snapshot,
          );
          if (result.success) return result;
        }
      }
    }

    // 3. Try to BUILD toward the best demand
    if (context.canBuild && context.demands.length > 0) {
      // Sort demands: prefer cheapest track cost (most achievable with limited budget).
      // The heuristic fires when the LLM is unavailable, so pick safe, short builds
      // rather than chasing expensive distant demands.
      const buildCandidates = [...context.demands]
        .filter(d => d.estimatedTrackCostToDelivery > 0 || d.estimatedTrackCostToSupply > 0)
        .sort((a, b) => {
          const aCost = Math.min(a.estimatedTrackCostToSupply || Infinity, a.estimatedTrackCostToDelivery || Infinity);
          const bCost = Math.min(b.estimatedTrackCostToSupply || Infinity, b.estimatedTrackCostToDelivery || Infinity);
          return aCost - bCost;
        });

      for (const demand of buildCandidates) {
        // Try building toward supply city if load isn't on train and supply isn't reachable
        if (!demand.isLoadOnTrain && !demand.isSupplyOnNetwork && demand.supplyCity) {
          const result = await ActionResolver.resolveBuild(
            { toward: demand.supplyCity },
            snapshot,
            context,
          );
          if (result.success) return result;
        }

        // Try building toward delivery city
        if (!demand.isDeliveryOnNetwork) {
          const result = await ActionResolver.resolveBuild(
            { toward: demand.deliveryCity },
            snapshot,
            context,
          );
          if (result.success) return result;
        }
      }

      // If all demands are on network, try building toward any demand with cheapest track cost
      for (const demand of [...context.demands].sort((a, b) => {
        const aCost = Math.min(a.estimatedTrackCostToSupply || Infinity, a.estimatedTrackCostToDelivery || Infinity);
        const bCost = Math.min(b.estimatedTrackCostToSupply || Infinity, b.estimatedTrackCostToDelivery || Infinity);
        return aCost - bCost;
      })) {
        const result = await ActionResolver.resolveBuild(
          { toward: demand.deliveryCity },
          snapshot,
          context,
        );
        if (result.success) return result;
      }
    }

    // 4. Try to DROP a dead-weight load to unblock capacity (BE-004).
    // If all higher-priority actions failed and the bot is carrying loads with
    // poor delivery feasibility, dropping the worst one frees a cargo slot so
    // future turns can pick up something useful instead of passing endlessly.
    if (!context.isInitialBuild && snapshot.bot.loads.length > 0) {
      const scored = snapshot.bot.loads.map(loadType => {
        const matchingDemands = context.demands.filter(d => d.loadType === loadType);
        if (matchingDemands.length === 0) return { loadType, score: Infinity };
        const bestScore = Math.min(
          ...matchingDemands.map(d => {
            if (d.isDeliveryOnNetwork) return 0;
            return d.estimatedTrackCostToDelivery - d.payout;
          }),
        );
        return { loadType, score: bestScore };
      });
      scored.sort((a, b) => b.score - a.score);
      const worst = scored[0];
      // Only drop if the load is genuinely dead weight (no demand or net-negative delivery)
      if (worst && worst.score > 0) {
        const result = await ActionResolver.resolveDropLoad(
          { load: worst.loadType },
          snapshot,
        );
        if (result.success) return result;
      }
    }

    // 5. DISCARD dead hand — if every demand is unplayable, draw fresh cards.
    // Conditions (all must hold): not initial build, no demand achievable on
    // existing network, and cheapest demand's track cost exceeds cash (JIRA-54).
    if (!context.isInitialBuild && context.demands.length > 0) {
      const hasAchievable = context.demands.some(d =>
        (d.isSupplyOnNetwork || d.isLoadOnTrain) && d.isDeliveryOnNetwork,
      );
      if (!hasAchievable) {
        const cheapestCost = Math.min(
          ...context.demands.map(d => d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery),
        );
        if (cheapestCost > snapshot.bot.money) {
          console.warn(
            `[heuristicFallback] Dead hand detected — all demands unaffordable ` +
            `(cheapest=${cheapestCost}M, cash=${snapshot.bot.money}M). Discarding hand.`,
          );
          return ActionResolver.resolveDiscard(snapshot);
        }
      }
    }

    // 6. PASS turn — preserve current hand for future turns.
    return ActionResolver.resolvePass();
  }

  // ─── Helper Utilities ────────────────────────────────────────────────────

  private static readonly TURN_BUILD_BUDGET = 20;
  private static readonly MONEY_RESERVE = 5;

  /**
   * Find grid coordinates for a city by name.
   * Returns the closest milepost to the bot's track network (or first match if no track).
   * Excludes FerryPort-only mileposts since they are transit, not destinations.
   */
  private static findCityMilepost(
    cityName: string,
    snapshot: WorldSnapshot,
    forBuild = false,
  ): GridCoord[] {
    const grid = loadGridPoints();
    const targets: GridCoord[] = [];
    for (const [, point] of grid) {
      if (point.name === cityName && point.terrain !== 7 /* FerryPort */) {
        targets.push({ row: point.row, col: point.col });
      }
    }
    // Also check major city groups for center + outposts
    if (targets.length === 0) {
      const groups = getMajorCityGroups();
      for (const g of groups) {
        if (g.cityName === cityName) {
          targets.push({ row: g.center.row, col: g.center.col });
          for (const o of g.outposts) {
            targets.push({ row: o.row, col: o.col });
          }
          break;
        }
      }
    }

    // For BUILD actions, exclude major city centers (they are inside the
    // unbuildable red area and can never be reached by Dijkstra)
    if (forBuild && targets.length > 1) {
      const groups = getMajorCityGroups();
      const centerSet = new Set(groups.map(g => `${g.center.row},${g.center.col}`));
      const filtered = targets.filter(t => !centerSet.has(`${t.row},${t.col}`));
      if (filtered.length > 0) return filtered;
    }

    return targets;
  }

  /**
   * Check if the bot is currently at a named city.
   * Matches against any milepost that has the given city name,
   * including all major city outposts.
   */
  private static isBotAtCity(snapshot: WorldSnapshot, cityName: string): boolean {
    if (!snapshot.bot.position) return false;
    const grid = loadGridPoints();
    const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    const point = grid.get(posKey);
    if (point?.name === cityName) return true;
    // Check major city groups (center + outposts all count)
    const majorCityLookup = getMajorCityLookup();
    const botCity = majorCityLookup.get(posKey);
    return botCity === cityName;
  }

  /**
   * Get the bot's track frontier — all unique grid positions from existing segments.
   * Used as start positions for computeBuildSegments.
   */
  private static getTrackFrontier(snapshot: WorldSnapshot): GridCoord[] {
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
    // Major city red area expansion: if any endpoint is in a major city,
    // add all outposts of that city (they're connected via the red area)
    const majorCityLookup = getMajorCityLookup();
    const majorCityGroupsList = getMajorCityGroups();
    const cityGroupMap = new Map(majorCityGroupsList.map(g => [g.cityName, g]));
    for (const pos of [...positions]) {
      const cityName = majorCityLookup.get(`${pos.row},${pos.col}`);
      if (!cityName) continue;
      const group = cityGroupMap.get(cityName);
      if (!group) continue;
      for (const point of [group.center, ...group.outposts]) {
        const key = `${point.row},${point.col}`;
        if (!seen.has(key)) {
          seen.add(key);
          positions.push({ row: point.row, col: point.col });
        }
      }
    }
    return positions;
  }

  /**
   * Build a set of edges owned by other players (Right of Way rule).
   * Format: "row,col-row,col" for each direction.
   */
  private static getOccupiedEdges(snapshot: WorldSnapshot): Set<string> {
    const occupied = new Set<string>();
    for (const pt of snapshot.allPlayerTracks) {
      if (pt.playerId === snapshot.bot.playerId) continue;
      for (const seg of pt.segments) {
        const a = `${seg.from.row},${seg.from.col}`;
        const b = `${seg.to.row},${seg.to.col}`;
        occupied.add(`${a}-${b}`);
        occupied.add(`${b}-${a}`);
      }
    }
    return occupied;
  }

  /** Compute remaining build budget for this turn. */
  private static getBuildBudget(snapshot: WorldSnapshot, turnBuildCost: number = 0): number {
    return Math.min(ActionResolver.TURN_BUILD_BUDGET - turnBuildCost, snapshot.bot.money);
  }

  /**
   * Check if any copies of a load type are available (not on any player's train).
   * Uses snapshot.loadAvailability to check which cities have the load,
   * and checks all player loads to count carried copies.
   */
  private static isLoadRuntimeAvailable(loadType: string, snapshot: WorldSnapshot): boolean {
    // Count how many copies exist at supply cities
    let supplyCities = 0;
    for (const [, loads] of Object.entries(snapshot.loadAvailability)) {
      if (loads.includes(loadType)) supplyCities++;
    }
    // If no city supplies it at all, it's unavailable
    if (supplyCities === 0) return false;

    // Count carried copies across all players
    let carriedCount = 0;
    carriedCount += snapshot.bot.loads.filter(l => l === loadType).length;
    if (snapshot.opponents) {
      for (const opp of snapshot.opponents) {
        carriedCount += opp.loads.filter(l => l === loadType).length;
      }
    }
    // Heuristic: if many copies are carried, likely unavailable.
    // With limited info, assume available if at least one supply city exists
    // and not ALL known copies are being carried.
    // This is a best-effort check; exact copy counts aren't in WorldSnapshot.
    return true;
  }

  /**
   * Find a matching demand card for a load type at a specific city.
   * Returns the best-paying match, or null if none.
   */
  private static findMatchingDemand(
    loadType: string,
    cityName: string,
    snapshot: WorldSnapshot,
  ): { cardId: number; payout: number } | null {
    let bestPayout = 0;
    let bestCardId: number | null = null;
    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        if (demand.loadType === loadType && demand.city === cityName) {
          if (demand.payment > bestPayout) {
            bestPayout = demand.payment;
            bestCardId = rd.cardId;
          }
        }
      }
    }
    return bestCardId !== null ? { cardId: bestCardId, payout: bestPayout } : null;
  }

  /**
   * Detect if bot is at a ferry port and return the paired port for teleportation.
   * Per game rules, a bot at a ferry port crosses to the paired port at the start
   * of its turn, then moves from there at half speed.
   */
  static resolveFerryCrossing(
    position: { row: number; col: number },
    snapshot: WorldSnapshot,
  ): { pairedPort: { row: number; col: number }; ferryName: string } | null {
    const ferryEdges = snapshot.ferryEdges ?? [];
    for (const ferry of ferryEdges) {
      if (position.row === ferry.pointA.row && position.col === ferry.pointA.col) {
        return { pairedPort: ferry.pointB, ferryName: ferry.name };
      }
      if (position.row === ferry.pointB.row && position.col === ferry.pointB.col) {
        return { pairedPort: ferry.pointA, ferryName: ferry.name };
      }
    }
    return null;
  }

  /** Get the bot's train speed, accounting for ferry half-speed. */
  private static getBotSpeed(snapshot: WorldSnapshot): number {
    const rawSpeed = getTrainSpeed(snapshot.bot.trainType as TrainType);
    return snapshot.bot.ferryHalfSpeed ? Math.ceil(rawSpeed / 2) : rawSpeed;
  }

  /** Get the bot's train capacity. */
  private static getBotCapacity(snapshot: WorldSnapshot): number {
    return getTrainCapacity(snapshot.bot.trainType as TrainType);
  }
}
