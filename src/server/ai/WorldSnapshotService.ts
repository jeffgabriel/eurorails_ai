/**
 * WorldSnapshotService — captures an immutable, deep-frozen snapshot
 * of the entire game state for AI decision-making.
 */

import { GameService } from '../services/gameService';
import { TrackService } from '../services/trackService';
import { LoadService } from '../services/loadService';
import { countConnectedMajorCities } from './validationService';
import type { WorldSnapshot, OpponentData } from './types';
import type {
  GridPoint,
  TrackSegment,
  PlayerTrackState,
  Point,
  FerryPoint,
  FerryConnection,
} from '../../shared/types/GameTypes';
import { TerrainType, TrainType } from '../../shared/types/GameTypes';
import type { LoadType } from '../../shared/types/LoadTypes';
import type { DemandCard } from '../../shared/types/DemandCard';
import mileposts from '../../../configuration/gridPoints.json';
import ferryData from '../../../configuration/ferryPoints.json';

// --- Lazy-cached map points (built once from gridPoints.json) ---

let cachedMapPoints: GridPoint[] | null = null;

const HORIZONTAL_SPACING = 50;
const VERTICAL_SPACING = 45;
const GRID_MARGIN = 120;

function mapTypeToTerrain(type: string): TerrainType {
  switch (type) {
    case 'Clear':
    case 'Milepost':
      return TerrainType.Clear;
    case 'Mountain':
      return TerrainType.Mountain;
    case 'Alpine':
      return TerrainType.Alpine;
    case 'Small City':
      return TerrainType.SmallCity;
    case 'Medium City':
      return TerrainType.MediumCity;
    case 'Major City':
    case 'Major City Outpost':
      return TerrainType.MajorCity;
    case 'Ferry Port':
      return TerrainType.FerryPort;
    case 'Water':
      return TerrainType.Water;
    default:
      return TerrainType.Clear;
  }
}

function getMapPoints(): GridPoint[] {
  if (cachedMapPoints) return cachedMapPoints;

  const points: GridPoint[] = [];
  for (const raw of mileposts as any[]) {
    if (typeof raw.GridX !== 'number' || typeof raw.GridY !== 'number') continue;
    const col = raw.GridX;
    const row = raw.GridY;
    const terrain = mapTypeToTerrain(raw.Type);
    const isOffsetRow = row % 2 === 1;
    const x = col * HORIZONTAL_SPACING + GRID_MARGIN + (isOffsetRow ? HORIZONTAL_SPACING / 2 : 0);
    const y = row * VERTICAL_SPACING + GRID_MARGIN;

    let cityData: GridPoint['city'] = undefined;
    const name = raw.Name ? String(raw.Name) : undefined;
    if (
      (raw.Type === 'Small City' || raw.Type === 'Medium City') &&
      name
    ) {
      cityData = { type: terrain, name, availableLoads: [] };
    } else if (raw.Type === 'Major City Outpost' && name) {
      cityData = { type: TerrainType.MajorCity, name, availableLoads: [] };
    } else if (raw.Type === 'Major City' && name) {
      cityData = { type: TerrainType.MajorCity, name, availableLoads: [] };
    }

    points.push({
      id: raw.Id,
      x,
      y,
      row,
      col,
      terrain,
      city: cityData,
    });
  }

  // Attach ferry connections to grid points (mirrors client mapConfig.ts logic)
  const idLookup = new Map<string, GridPoint>();
  for (const p of points) {
    idLookup.set(p.id, p);
  }
  for (const ferry of (ferryData as any).ferryPoints) {
    const p1 = idLookup.get(ferry.connections[0]);
    const p2 = idLookup.get(ferry.connections[1]);
    if (!p1 || !p2) continue;

    const fp1: FerryPoint = { row: p1.row, col: p1.col, x: p1.x, y: p1.y, id: p1.id, terrain: TerrainType.FerryPort };
    const fp2: FerryPoint = { row: p2.row, col: p2.col, x: p2.x, y: p2.y, id: p2.id, terrain: TerrainType.FerryPort };
    const conn: FerryConnection = { Name: ferry.Name, connections: [fp1, fp2], cost: ferry.cost };
    p1.ferryConnection = conn;
    p2.ferryConnection = conn;
  }

  cachedMapPoints = points;
  return points;
}

// --- Deep freeze utility ---

function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }

  // Handle Map
  if (obj instanceof Map) {
    Object.freeze(obj);
    for (const [key, val] of obj) {
      deepFreeze(key);
      deepFreeze(val);
    }
    return obj;
  }

  // Handle Set
  if (obj instanceof Set) {
    Object.freeze(obj);
    for (const val of obj) {
      deepFreeze(val);
    }
    return obj;
  }

  // Handle Array and plain objects
  Object.freeze(obj);
  for (const prop of Object.getOwnPropertyNames(obj)) {
    const value = (obj as any)[prop];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// --- WorldSnapshotService ---

export class WorldSnapshotService {
  /**
   * Capture an immutable snapshot of the game state for AI decision-making.
   *
   * @param gameId - The game to snapshot
   * @param botPlayerId - The bot's player ID within the game
   * @param botUserId - The bot's user ID (needed for GameService.getGame)
   */
  static async capture(
    gameId: string,
    botPlayerId: string,
    botUserId: string,
  ): Promise<WorldSnapshot> {
    // Fetch game state and all tracks in parallel
    const [gameState, allTracks] = await Promise.all([
      GameService.getGame(gameId, botUserId),
      TrackService.getAllTracks(gameId),
    ]);

    if (!gameState) {
      throw new Error(`Game not found: ${gameId}`);
    }

    // Find the bot player
    const botPlayer = gameState.players.find((p) => p.id === botPlayerId);
    if (!botPlayer) {
      throw new Error(`Bot player not found: ${botPlayerId} in game ${gameId}`);
    }

    // Bot's track state
    const botTrack = allTracks.find((t) => t.playerId === botPlayerId);
    const botSegments: TrackSegment[] = botTrack?.segments ?? [];
    const turnBuildCostSoFar = botTrack?.turnBuildCost ?? 0;

    // Bot position and movement
    const position: Point | null = botPlayer.trainState?.position ?? null;
    const remainingMovement = botPlayer.trainState?.remainingMovement ?? 0;
    const carriedLoads = (botPlayer.trainState?.loads ?? []) as LoadType[];
    const demandCards: DemandCard[] = botPlayer.hand ?? [];

    // Build opponent data
    const opponents: OpponentData[] = gameState.players
      .filter((p) => p.id !== botPlayerId)
      .map((p) => {
        const oppTrack = allTracks.find((t) => t.playerId === p.id);
        const oppSegments = oppTrack?.segments ?? [];
        // Count opponent's connected major cities using a temporary partial snapshot
        const oppCityCount = countConnectedMajorCities({
          trackSegments: oppSegments,
        } as WorldSnapshot);
        return {
          playerId: p.id,
          name: p.name,
          money: p.money,
          trainType: p.trainType,
          position: p.trainState?.position ?? null,
          loads: (p.trainState?.loads ?? []) as LoadType[],
          trackSegmentCount: oppSegments.length,
          majorCitiesConnected: oppCityCount,
        };
      });

    // Load availability: city -> available load types
    const loadService = LoadService.getInstance();
    const mapPoints = getMapPoints();
    const loadAvailability = new Map<string, string[]>();

    // Collect all city names from the map
    for (const point of mapPoints) {
      if (point.city?.name) {
        const cityName = point.city.name;
        if (!loadAvailability.has(cityName)) {
          const loads = loadService.getAvailableLoadsForCity(cityName);
          if (loads.length > 0) {
            loadAvailability.set(cityName, loads);
          }
        }
      }
    }

    // Dropped loads: city -> dropped load types
    const droppedLoadsRaw = await loadService.getDroppedLoads(gameId);
    const droppedLoads = new Map<string, LoadType[]>();
    for (const { city_name, type } of droppedLoadsRaw) {
      if (!droppedLoads.has(city_name)) {
        droppedLoads.set(city_name, []);
      }
      droppedLoads.get(city_name)!.push(type);
    }

    // Game phase — DB allows 'initialBuild' but GameStatus type is narrower
    const gamePhase: 'initialBuild' | 'active' =
      (gameState.status as string) === 'initialBuild' ? 'initialBuild' : 'active';

    // Count connected major cities for bot
    const tempSnapshot = { trackSegments: botSegments } as WorldSnapshot;
    const connectedMajorCities = countConnectedMajorCities(tempSnapshot);

    // Assemble the snapshot
    const snapshot: WorldSnapshot = {
      gameId,
      botPlayerId,
      botUserId,
      gamePhase,
      turnBuildCostSoFar,

      // Bot state
      position,
      money: botPlayer.money,
      debtOwed: botPlayer.debtOwed ?? 0,
      trainType: botPlayer.trainType,
      remainingMovement,
      carriedLoads,
      demandCards,

      // Track network
      trackSegments: botSegments,
      connectedMajorCities,

      // Opponents
      opponents,

      // All tracks
      allPlayerTracks: allTracks,

      // Global state
      loadAvailability,
      droppedLoads,
      mapPoints,

      // Events placeholder
      activeEvents: [],
    };

    // Deep-freeze the snapshot for immutability
    return deepFreeze(snapshot);
  }
}
