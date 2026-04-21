/**
 * computeTrackUsageFees — Shared utility for capacity-aware delivery fee estimation.
 *
 * Computes the expected total $4M/turn track-use fee cost to complete a delivery
 * when the destination city is capacity-capped by opponents and the bot has no
 * own track into that city.
 *
 * Used by:
 *  - Layer 1 (TripPlanner.scoreCandidates): demand scoring via effectivePayout
 *  - Layer 2 (TurnExecutorPlanner.resolveCappedCityDelivery): 2a/2b/2c decision tree
 */

import { DemandOption, TerrainType, TrainType, TRAIN_PROPERTIES, WorldSnapshot } from '../types/GameTypes';
import { buildUnionTrackGraph } from './trackUsageFees';
import { loadGridPoints, makeKey } from '../../server/services/ai/MapTopology';

/** Capacity caps by city type. */
const SMALL_CITY_CAP = 2;
const MEDIUM_CITY_CAP = 3;

/** Track-use fee per turn spent on opponent-owned track. */
const FEE_PER_OPPONENT_TURN = 4;

/**
 * Compute the expected total track-use fee (in ECU millions) for a delivery
 * when the destination city is capacity-capped and the bot has no own track there.
 *
 * Fast-path returns 0 when:
 *  1. Delivery city is not a small/medium city (no cap applies)
 *  2. Fewer opponents have track there than the cap (city is not yet full)
 *  3. Bot already has a segment touching the delivery city
 *  4. No path exists from the bot's network frontier to the delivery city
 *
 * @param demand  The demand card being evaluated.
 * @param snapshot  Full game snapshot including all track segments and bot identity.
 * @returns Total fee in ECU millions; 0 if not applicable.
 */
export function computeTrackUsageFees(
  demand: DemandOption,
  snapshot: WorldSnapshot,
): number {
  try {
    const deliveryCity = demand.deliveryCity;
    const botPlayerId = snapshot.bot.playerId;

    // ── Step 1: Look up city type; bail if not a capped city type ──────────
    const grid = loadGridPoints();
    const cityGridPoints = Array.from(grid.values()).filter(
      (gp) => gp.name === deliveryCity,
    );

    if (cityGridPoints.length === 0) return 0;

    const cityTerrain = cityGridPoints[0].terrain;
    const cap =
      cityTerrain === TerrainType.SmallCity
        ? SMALL_CITY_CAP
        : cityTerrain === TerrainType.MediumCity
          ? MEDIUM_CITY_CAP
          : 0;

    if (cap === 0) return 0;

    // ── Step 2: Count distinct opponents with track into deliveryCity ──────
    // A player "has track into the city" if any of their segments has a
    // `to` or `from` endpoint that matches a grid point named deliveryCity.
    const cityCoordSet = new Set<string>(
      cityGridPoints.map((gp) => makeKey(gp.row, gp.col)),
    );

    const opponentIdsWithTrack = new Set<string>();
    let botHasTrack = false;

    for (const playerTrack of snapshot.allPlayerTracks) {
      const pid = playerTrack.playerId;
      for (const seg of playerTrack.segments || []) {
        const fromKey = makeKey(seg.from.row, seg.from.col);
        const toKey = makeKey(seg.to.row, seg.to.col);
        if (cityCoordSet.has(fromKey) || cityCoordSet.has(toKey)) {
          if (pid === botPlayerId) {
            botHasTrack = true;
          } else {
            opponentIdsWithTrack.add(pid);
          }
        }
      }
    }

    // Fast path: bot already has track there
    if (botHasTrack) return 0;

    // Fast path: city is not yet full
    if (opponentIdsWithTrack.size < cap) return 0;

    // ── Step 3: Build union graph and find path to delivery city ──────────
    const allTracks = snapshot.allPlayerTracks.map((pt) => ({
      playerId: pt.playerId,
      gameId: '',
      segments: pt.segments,
      totalCost: 0,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(0),
    }));

    const { adjacency, edgeOwners } = buildUnionTrackGraph({ allTracks });

    // Build set of bot's own network nodes (frontier)
    const botNetworkNodes = new Set<string>();
    const botTrackEntry = snapshot.allPlayerTracks.find(
      (pt) => pt.playerId === botPlayerId,
    );
    if (botTrackEntry) {
      for (const seg of botTrackEntry.segments || []) {
        botNetworkNodes.add(makeKey(seg.from.row, seg.from.col));
        botNetworkNodes.add(makeKey(seg.to.row, seg.to.col));
      }
    }
    // Also include bot's current position as a frontier node
    if (snapshot.bot.position) {
      botNetworkNodes.add(makeKey(snapshot.bot.position.row, snapshot.bot.position.col));
    }

    if (botNetworkNodes.size === 0) return 0;

    // Find shortest path from any bot network node to any city coord
    // BFS: find shortest hop-count path
    const goalKeys = cityCoordSet;
    let shortestPath: string[] | null = null;
    let shortestLength = Infinity;

    for (const startKey of botNetworkNodes) {
      if (!adjacency.has(startKey)) continue;
      // Check if startKey is already at goal
      if (goalKeys.has(startKey)) {
        shortestPath = [startKey];
        shortestLength = 1;
        break;
      }
      const path = bfsPath(adjacency, startKey, goalKeys);
      if (path && path.length < shortestLength) {
        shortestPath = path;
        shortestLength = path.length;
      }
    }

    if (!shortestPath || shortestPath.length <= 1) return 0;

    // ── Step 4: Compute turns on opponent track ────────────────────────────
    const trainSpeed =
      TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;

    // Walk the path edges and identify opponent-owned edges
    // Group path edges into "turns" (trainSpeed edges = 1 turn)
    let opponentEdgesInPath = 0;

    for (let i = 0; i < shortestPath.length - 1; i++) {
      const aKey = shortestPath[i];
      const bKey = shortestPath[i + 1];
      const [aRow, aCol] = aKey.split(',').map(Number);
      const [bRow, bCol] = bKey.split(',').map(Number);
      const eKey = edgeKeyFor(aRow, aCol, bRow, bCol);
      const owners = edgeOwners.get(eKey);
      if (owners && owners.size > 0 && !owners.has(botPlayerId)) {
        opponentEdgesInPath++;
      }
    }

    if (opponentEdgesInPath === 0) return 0;

    // Approximate: each traversal of trainSpeed edges ≈ 1 turn
    // For a short stub (< trainSpeed edges), it's still 1 turn
    const turnsOnOpponentTrack = Math.ceil(opponentEdgesInPath / trainSpeed);

    // Fee = $4M × turns × number-of-distinct-opponents-traversed
    // In practice, for a single short stub, opponentIdsWithTrack.size = 1 opponent
    // The fee is paid per-opponent per-turn-on-their-track
    const fee = FEE_PER_OPPONENT_TURN * turnsOnOpponentTrack;

    return fee;
  } catch (err) {
    // Graph construction or lookup failure: safe to return 0 (advisory function)
    const cityName = demand?.deliveryCity ?? 'unknown';
    // eslint-disable-next-line no-console
    console.warn('[computeTrackUsageFees] Error computing fees, returning 0', {
      deliveryCity: cityName,
      error: String(err),
    });
    return 0;
  }
}

/**
 * BFS from startKey to any node in goalKeys.
 * Returns the path as an array of node keys (inclusive of start and first goal hit),
 * or null if no path exists.
 */
function bfsPath(
  adjacency: Map<string, Set<string>>,
  startKey: string,
  goalKeys: Set<string>,
): string[] | null {
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [startKey];
  visited.add(startKey);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (goalKeys.has(cur)) {
      // Reconstruct path
      const path: string[] = [cur];
      let step = cur;
      while (parent.has(step)) {
        step = parent.get(step)!;
        path.unshift(step);
      }
      return path;
    }
    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, cur);
        queue.push(next);
      }
    }
  }

  return null;
}

/** Normalize edge key to match trackUsageFees.ts format. */
function edgeKeyFor(aRow: number, aCol: number, bRow: number, bCol: number): string {
  const aKey = `${aRow},${aCol}`;
  const bKey = `${bRow},${bCol}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}
