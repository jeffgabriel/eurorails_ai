/**
 * WorldSnapshotService — Captures a frozen game state for AI bot evaluation.
 *
 * Performs an optimized SQL query joining games, players, and player_tracks
 * to build a WorldSnapshot that the AI pipeline uses for decision-making.
 */

import { db } from '../../db/index';
import { WorldSnapshot, TrackSegment, GameStatus, ResolvedDemand, OpponentSnapshot, BotSkillLevel, GridPoint, TerrainType, CityData } from '../../../shared/types/GameTypes';
import { DemandDeckService } from '../demandDeckService';
import { LoadService } from '../loadService';
import { getConnectedMajorCityCount } from './connectedMajorCities';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { loadGridPoints, gridToPixel } from './MapTopology';

/**
 * Capture a frozen snapshot of the game world for AI evaluation.
 *
 * @param gameId - The game to snapshot
 * @param botPlayerId - The bot player making a decision
 * @returns A WorldSnapshot with all data needed for the AI pipeline
 */
export async function capture(gameId: string, botPlayerId: string): Promise<WorldSnapshot> {
  // Single query joining games, players, and player_tracks
  const result = await db.query(
    `
    SELECT
      g.status        AS game_status,
      p.id            AS player_id,
      p.user_id,
      p.money,
      p.position_row,
      p.position_col,
      p.train_type,
      p.hand,
      p.loads,
      p.is_bot,
      p.bot_config,
      p.current_turn_number,
      COALESCE(pt.segments, '[]'::jsonb) AS segments
    FROM games g
    JOIN players p ON p.game_id = g.id
    LEFT JOIN player_tracks pt ON pt.game_id = g.id AND pt.player_id = p.id
    WHERE g.id = $1
    ORDER BY p.created_at ASC
    `,
    [gameId],
  );

  if (result.rows.length === 0) {
    throw new Error(`No game found with id ${gameId}`);
  }

  const gameStatus = result.rows[0].game_status as GameStatus;

  // Find the bot player row
  const botRow = result.rows.find((r) => r.player_id === botPlayerId);
  if (!botRow) {
    throw new Error(`Bot player ${botPlayerId} not found in game ${gameId}`);
  }

  // Parse bot segments
  const botSegments = parseSegments(botRow.segments);

  // Parse bot config
  const rawConfig = typeof botRow.bot_config === 'string'
    ? JSON.parse(botRow.bot_config)
    : botRow.bot_config;

  const botConfig = rawConfig
    ? {
        skillLevel: rawConfig.skillLevel ?? 'medium',
        archetype: rawConfig.archetype ?? 'balanced',
        name: rawConfig.name,
        provider: rawConfig.provider,
        model: rawConfig.model,
      }
    : null;

  // Build all player tracks
  const allPlayerTracks = result.rows.map((row) => ({
    playerId: row.player_id as string,
    segments: parseSegments(row.segments),
  }));

  // Resolve demand cards from DemandDeckService
  const demandCardIds: number[] = Array.isArray(botRow.hand) ? botRow.hand : [];
  const demandDeck = DemandDeckService.getInstance();
  const resolvedDemands: ResolvedDemand[] = [];
  for (const cardId of demandCardIds) {
    const card = demandDeck.getCard(cardId);
    if (!card) continue;
    resolvedDemands.push({
      cardId: card.id,
      demands: card.demands.map((d) => ({
        city: d.city,
        loadType: d.resource,
        payment: d.payment,
      })),
    });
  }

  // Build opponent snapshots for Medium/Hard skill levels
  const skillLevel = botConfig?.skillLevel?.toLowerCase();
  let opponents: OpponentSnapshot[] | undefined;
  if (skillLevel === BotSkillLevel.Medium || skillLevel === BotSkillLevel.Hard) {
    opponents = result.rows
      .filter((row) => row.player_id !== botPlayerId)
      .map((row) => ({
        playerId: row.player_id as string,
        money: row.money ?? 0,
        position:
          row.position_row != null && row.position_col != null
            ? { row: row.position_row, col: row.position_col }
            : null,
        trainType: row.train_type ?? 'Freight',
        loads: Array.isArray(row.loads) ? row.loads : [],
      }));
  }

  // Build load availability for cities relevant to the bot's demands
  const loadSvc = LoadService.getInstance();
  const loadAvailability: Record<string, string[]> = {};
  const citiesOfInterest = new Set<string>();
  for (const rd of resolvedDemands) {
    for (const d of rd.demands) {
      citiesOfInterest.add(d.city);
    }
  }
  // Also add SOURCE cities for load types the bot's demands need.
  // Without this, the bot can't discover where to pick up loads.
  for (const rd of resolvedDemands) {
    for (const d of rd.demands) {
      const sourceCities = loadSvc.getSourceCitiesForLoad(d.loadType);
      for (const city of sourceCities) {
        citiesOfInterest.add(city);
      }
    }
  }
  for (const city of citiesOfInterest) {
    const loads = loadSvc.getAvailableLoadsForCity(city);
    if (loads.length > 0) {
      loadAvailability[city] = loads;
    }
  }

  // Build static map data for v6.3 pipeline
  const hexGrid = buildHexGrid(loadSvc);
  const majorCityGroupsData = getMajorCityGroups();
  const ferryEdgesData = getFerryEdges();

  return {
    gameId,
    gameStatus,
    turnNumber: botRow.current_turn_number ?? 0,
    bot: {
      playerId: botPlayerId,
      userId: botRow.user_id ?? '',
      money: botRow.money ?? 50,
      position:
        botRow.position_row != null && botRow.position_col != null
          ? { row: botRow.position_row, col: botRow.position_col }
          : null,
      existingSegments: botSegments,
      demandCards: demandCardIds,
      resolvedDemands,
      trainType: botRow.train_type ?? 'Freight',
      loads: Array.isArray(botRow.loads) ? botRow.loads : [],
      botConfig,
      connectedMajorCityCount: getConnectedMajorCityCount(botSegments),
    },
    allPlayerTracks,
    loadAvailability,
    opponents,
    hexGrid,
    majorCityGroups: majorCityGroupsData,
    ferryEdges: ferryEdgesData,
  };
}

/** Parse JSONB segments — handles both string and object forms from pg */
function parseSegments(raw: unknown): TrackSegment[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as TrackSegment[];
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw as TrackSegment[];
  return [];
}

/** City terrain types that should have CityData attached */
const CITY_TERRAINS = new Set([
  TerrainType.SmallCity,
  TerrainType.MediumCity,
  TerrainType.MajorCity,
]);

/**
 * Convert MapTopology grid data into GridPoint[] for the v6.3 pipeline.
 * Enriches city points with CityData (name + availableLoads from LoadService).
 * Result is cached — grid data is static for the lifetime of the server.
 */
let hexGridCache: GridPoint[] | null = null;

function buildHexGrid(loadSvc: LoadService): GridPoint[] {
  if (hexGridCache) return hexGridCache;

  const gridMap = loadGridPoints();
  const points: GridPoint[] = [];

  for (const [key, data] of gridMap) {
    const { x, y } = gridToPixel(data.row, data.col);
    const isCityTerrain = CITY_TERRAINS.has(data.terrain);
    const hasName = !!data.name;

    let city: CityData | undefined;
    if (isCityTerrain && hasName) {
      city = {
        type: data.terrain,
        name: data.name!,
        availableLoads: loadSvc.getAvailableLoadsForCity(data.name!),
      };
    }

    points.push({
      id: key,
      x,
      y,
      row: data.row,
      col: data.col,
      terrain: data.terrain,
      city,
      ocean: data.ocean,
      name: data.name,
    });
  }

  hexGridCache = points;
  return points;
}
