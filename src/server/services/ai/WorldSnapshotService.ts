import crypto from 'crypto';
import { PlayerService } from '../playerService';
import { TrackService } from '../trackService';
import { LoadService } from '../loadService';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';
import type { WorldSnapshot, OtherPlayerSnapshot } from '../../../shared/types/AITypes';
import type { Player, PlayerTrackState, TrackSegment, GridPoint } from '../../../shared/types/GameTypes';
import { TerrainType } from '../../../shared/types/GameTypes';
import type { LoadType } from '../../../shared/types/LoadTypes';
import mileposts from '../../../../configuration/gridPoints.json';

function nodeKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * Recursively deep-freezes an object and all its properties.
 * Handles Map, Set, arrays, and plain objects.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (Object.isFrozen(obj)) {
    return obj;
  }
  if (obj instanceof Map) {
    for (const [key, val] of obj) {
      deepFreeze(val);
    }
    Object.freeze(obj);
    return obj;
  }
  if (obj instanceof Set) {
    Object.freeze(obj);
    return obj;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item);
    }
    Object.freeze(obj);
    return obj;
  }
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const value = (obj as Record<string, unknown>)[name];
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }
  Object.freeze(obj);
  return obj;
}

/**
 * Builds a minimal GridPoint from raw gridPoints.json data for AI planning.
 * Strips client-only fields (sprite, tracks).
 */
function buildMapTopology(): GridPoint[] {
  const points: GridPoint[] = [];
  for (const raw of mileposts as any[]) {
    if (typeof raw.GridX !== 'number' || typeof raw.GridY !== 'number') continue;
    const col = raw.GridX;
    const row = raw.GridY;
    const type = String(raw.Type ?? '');
    let terrain: TerrainType;
    switch (type) {
      case 'Clear':
      case 'Milepost':
        terrain = TerrainType.Clear;
        break;
      case 'Mountain':
        terrain = TerrainType.Mountain;
        break;
      case 'Alpine':
        terrain = TerrainType.Alpine;
        break;
      case 'Small City':
        terrain = TerrainType.SmallCity;
        break;
      case 'Medium City':
        terrain = TerrainType.MediumCity;
        break;
      case 'Major City':
      case 'Major City Outpost':
        terrain = TerrainType.MajorCity;
        break;
      case 'Ferry Port':
        terrain = TerrainType.FerryPort;
        break;
      case 'Water':
        terrain = TerrainType.Water;
        break;
      default:
        terrain = TerrainType.Clear;
        break;
    }
    const name = raw.Name ? String(raw.Name) : undefined;
    const ocean = raw.Ocean ? String(raw.Ocean) : undefined;
    // Use 0 for x/y since AI doesn't need screen coordinates
    const point: GridPoint = {
      id: raw.Id || `${col},${row}`,
      x: 0,
      y: 0,
      row,
      col,
      terrain,
      ocean,
      ...(name && terrain >= TerrainType.SmallCity && terrain <= TerrainType.MajorCity
        ? {
            city: {
              type: terrain,
              name,
              availableLoads: [],
            },
          }
        : {}),
      ...(name && (terrain === TerrainType.FerryPort || terrain < TerrainType.SmallCity)
        ? { name }
        : {}),
    };
    points.push(point);
  }
  return points;
}

/** Cached static map topology (loaded once, reused across snapshots). */
let cachedMapTopology: readonly GridPoint[] | null = null;

function getMapTopology(): readonly GridPoint[] {
  if (!cachedMapTopology) {
    cachedMapTopology = Object.freeze(buildMapTopology());
  }
  return cachedMapTopology;
}

/**
 * Build an adjacency list from a player's track segments.
 * Keys are "row,col" strings; values are sets of connected "row,col" strings.
 */
function buildTrackGraph(segments: TrackSegment[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const seg of segments) {
    const fromId = nodeKey(seg.from.row, seg.from.col);
    const toId = nodeKey(seg.to.row, seg.to.col);
    if (!graph.has(fromId)) graph.set(fromId, new Set());
    if (!graph.has(toId)) graph.set(toId, new Set());
    graph.get(fromId)!.add(toId);
    graph.get(toId)!.add(fromId);
  }
  return graph;
}

/**
 * Count how many major cities a player's track connects (in the largest component).
 * Uses the same major city group data as victory validation.
 */
function countConnectedMajorCities(segments: TrackSegment[]): number {
  if (segments.length === 0) return 0;

  const graph = buildTrackGraph(segments);
  const majorCityGroups = getMajorCityGroups();

  // Find all connected components
  const allNodes = new Set(graph.keys());
  const visited = new Set<string>();
  const components: Set<string>[] = [];

  for (const startKey of allNodes) {
    if (visited.has(startKey)) continue;
    const component = new Set<string>();
    const queue = [startKey];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (component.has(node)) continue;
      component.add(node);
      visited.add(node);
      const neighbors = graph.get(node);
      if (neighbors) {
        for (const n of neighbors) {
          if (!component.has(n)) queue.push(n);
        }
      }
    }
    components.push(component);
  }

  // For each component, count major cities
  let bestCount = 0;
  for (const component of components) {
    let cityCount = 0;
    for (const group of majorCityGroups) {
      const centerKey = nodeKey(group.center.row, group.center.col);
      if (component.has(centerKey)) {
        cityCount++;
        continue;
      }
      for (const outpost of group.outposts) {
        if (component.has(nodeKey(outpost.row, outpost.col))) {
          cityCount++;
          break;
        }
      }
    }
    if (cityCount > bestCount) bestCount = cityCount;
  }
  return bestCount;
}

/**
 * Calculate which major cities the bot's track network reaches.
 * Returns a Map of city name -> boolean (connected or not).
 */
function calculateMajorCityConnections(
  segments: TrackSegment[],
): Map<string, boolean> {
  const majorCityGroups = getMajorCityGroups();
  const status = new Map<string, boolean>();

  if (segments.length === 0) {
    for (const group of majorCityGroups) {
      status.set(group.cityName, false);
    }
    return status;
  }

  const graph = buildTrackGraph(segments);

  for (const group of majorCityGroups) {
    const centerKey = nodeKey(group.center.row, group.center.col);
    let connected = graph.has(centerKey);
    if (!connected) {
      for (const outpost of group.outposts) {
        if (graph.has(nodeKey(outpost.row, outpost.col))) {
          connected = true;
          break;
        }
      }
    }
    status.set(group.cityName, connected);
  }
  return status;
}

function generateSnapshotHash(gameId: string, botPlayerId: string, turnNumber: number): string {
  return crypto
    .createHash('sha256')
    .update(`${gameId}:${botPlayerId}:${turnNumber}:${Date.now()}`)
    .digest('hex')
    .substring(0, 16);
}

export class WorldSnapshotService {
  /**
   * Capture the current game state into an immutable WorldSnapshot for AI planning.
   *
   * @param gameId - The game to snapshot
   * @param botPlayerId - The AI player's ID
   * @returns A deep-frozen WorldSnapshot
   */
  static async capture(gameId: string, botPlayerId: string): Promise<WorldSnapshot> {
    // Fetch all players (passing botPlayerId as requesting user — AI is server-side)
    const players = await PlayerService.getPlayers(gameId, botPlayerId);
    const bot = players.find(p => p.id === botPlayerId);
    if (!bot) {
      throw new Error(`Bot player ${botPlayerId} not found in game ${gameId}`);
    }

    // Fetch all track networks
    const allTracks = await TrackService.getAllTracks(gameId);
    const botTrack = allTracks.find(t => t.playerId === botPlayerId);
    const botSegments = botTrack?.segments || [];

    // Build bot's track network graph as adjacency list
    const trackGraph = buildTrackGraph(botSegments);
    const trackNetworkGraph: Map<string, ReadonlySet<string>> = new Map();
    for (const [key, neighbors] of trackGraph) {
      trackNetworkGraph.set(key, new Set(neighbors));
    }

    // Fetch global load availability
    const loadService = LoadService.getInstance();
    const loadStates = await loadService.getAllLoadStates();

    // Adjust availability by subtracting loads currently carried by all players
    const carriedCounts = new Map<string, number>();
    for (const player of players) {
      for (const load of player.trainState.loads || []) {
        carriedCounts.set(load, (carriedCounts.get(load) || 0) + 1);
      }
    }
    const adjustedLoadStates = loadStates.map(state => ({
      ...state,
      availableCount: Math.max(0, state.availableCount - (carriedCounts.get(state.loadType) || 0)),
    }));

    // Build other player snapshots
    const otherPlayers: OtherPlayerSnapshot[] = players
      .filter(p => p.id !== botPlayerId)
      .map(p => {
        const pTrack = allTracks.find(t => t.playerId === p.id);
        return {
          playerId: p.id,
          position: p.trainState.position || null,
          carriedLoads: (p.trainState.loads || []) as readonly LoadType[],
          trainType: p.trainType,
          cash: p.money,
          connectedMajorCities: countConnectedMajorCities(pTrack?.segments || []),
        };
      });

    // Calculate major city connection status for the bot
    const majorCityConnectionStatus = calculateMajorCityConnections(botSegments);

    const snapshot: WorldSnapshot = {
      botPlayerId,
      botPosition: bot.trainState.position || null,
      trackNetworkGraph: trackNetworkGraph as ReadonlyMap<string, ReadonlySet<string>>,
      cash: bot.money,
      demandCards: bot.hand,
      carriedLoads: (bot.trainState.loads || []) as readonly LoadType[],
      trainType: bot.trainType,
      otherPlayers,
      globalLoadAvailability: adjustedLoadStates,
      activeEvents: [], // Events will be integrated when event tracking service is available
      mapTopology: getMapTopology(),
      majorCityConnectionStatus: majorCityConnectionStatus as ReadonlyMap<string, boolean>,
      turnNumber: bot.turnNumber,
      snapshotHash: generateSnapshotHash(gameId, botPlayerId, bot.turnNumber),
    };

    return deepFreeze(snapshot);
  }
}
