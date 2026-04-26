/**
 * AreaOfEffectService — Spatial computation and entity identification for event card effects.
 *
 * This service focuses on identification (which mileposts, players, track segments fall inside
 * a zone), NOT state mutation. All mutations happen in EventCardService and TrackService.
 */

import { db } from '../db/index';
import {
  loadGridPoints,
  getHexNeighbors,
  hexDistance,
  isWater,
  makeKey,
} from './MapTopology';
import { TrackService, getRiverEdgeKeys, segmentCrossesRiver } from './trackService';
import { TerrainType, Player, TrackSegment, TrainType } from '../../shared/types/GameTypes';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlayerInZone {
  playerId: string;
  gameId: string;
  name: string;
  money: number;
  loads: string[];
  trainType: TrainType;
  positionRow: number | null;
  positionCol: number | null;
  turnNumber: number;
}

// ── AreaOfEffectService ───────────────────────────────────────────────────────

export class AreaOfEffectService {
  /**
   * Compute the set of milepost keys ("row,col") within `radius` hex steps of
   * the given center, using BFS over the grid. Water tiles are never included.
   *
   * @param centerRow  Grid row of the center milepost
   * @param centerCol  Grid col of the center milepost
   * @param radius     Maximum hex distance (inclusive) from center
   * @param terrainFilter  If provided, only include mileposts with these terrain types
   * @returns Set of "row,col" strings for all matching mileposts within radius
   */
  static computeAffectedZone(
    centerRow: number,
    centerCol: number,
    radius: number,
    terrainFilter?: TerrainType[],
  ): Set<string> {
    const grid = loadGridPoints();
    const visited = new Set<string>();
    const result = new Set<string>();
    const queue: Array<{ row: number; col: number }> = [];

    const centerKey = makeKey(centerRow, centerCol);
    const centerPoint = grid.get(centerKey);

    // Include center if it exists and passes terrain filter
    if (centerPoint) {
      if (!terrainFilter || terrainFilter.includes(centerPoint.terrain)) {
        result.add(centerKey);
      }
      visited.add(centerKey);
      queue.push({ row: centerRow, col: centerCol });
    }

    // BFS — expand outward up to radius steps
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = getHexNeighbors(current.row, current.col);

      for (const nb of neighbors) {
        const nbKey = makeKey(nb.row, nb.col);
        if (visited.has(nbKey)) continue;
        visited.add(nbKey);

        const dist = hexDistance(centerRow, centerCol, nb.row, nb.col);
        if (dist > radius) continue;

        const nbPoint = grid.get(nbKey);
        if (!nbPoint) continue;

        // Add to result if it passes terrain filter
        if (!terrainFilter || terrainFilter.includes(nbPoint.terrain)) {
          result.add(nbKey);
        }

        // Continue BFS even if terrain-filtered — neighbors may have valid terrain
        queue.push({ row: nb.row, col: nb.col });
      }
    }

    return result;
  }

  /**
   * Compute the affected zone around a named city.
   * Resolves the city name to its "Major City" center milepost, then calls
   * `computeAffectedZone`.
   *
   * @param cityName     City name as it appears in gridPoints.json (ASCII, e.g. "Munchen")
   * @param radius       Radius in mileposts
   * @param terrainFilter  Optional terrain filter
   * @returns Set of "row,col" keys within radius of the city center
   */
  static getZoneAroundCity(
    cityName: string,
    radius: number,
    terrainFilter?: TerrainType[],
  ): Set<string> {
    const grid = loadGridPoints();

    // Find the Major City center for this city name
    let centerRow: number | null = null;
    let centerCol: number | null = null;

    for (const [, point] of grid) {
      if (
        point.name === cityName &&
        point.terrain === TerrainType.MajorCity
      ) {
        centerRow = point.row;
        centerCol = point.col;
        break;
      }
    }

    // Fall back to any milepost with that name (SmallCity, MediumCity)
    if (centerRow === null) {
      for (const [, point] of grid) {
        if (point.name === cityName) {
          centerRow = point.row;
          centerCol = point.col;
          break;
        }
      }
    }

    if (centerRow === null || centerCol === null) {
      throw new Error(`City not found: ${cityName}`);
    }

    return AreaOfEffectService.computeAffectedZone(centerRow, centerCol, radius, terrainFilter);
  }

  /**
   * Identify all mileposts within `radius` hex steps of any coastal (ocean-adjacent)
   * milepost.
   *
   * A "coastal" milepost is any grid point with a non-null `ocean` field. The zone
   * is the union of `computeAffectedZone(coast, radius)` for each coastal point.
   *
   * @param radius  Radius in mileposts around each coast milepost
   * @returns Set of "row,col" keys for all mileposts within radius of any coast
   */
  static getCoastalMileposts(radius: number): Set<string> {
    const grid = loadGridPoints();
    const result = new Set<string>();

    for (const [, point] of grid) {
      // Seed from land mileposts adjacent to ocean — not water tiles themselves.
      // This prevents the zone from expanding inland from water centers.
      if (point.ocean && !isWater(point.terrain)) {
        const zone = AreaOfEffectService.computeAffectedZone(point.row, point.col, radius);
        for (const key of zone) {
          result.add(key);
        }
      }
    }

    return result;
  }

  /**
   * Return all players in a game whose train position falls inside the given zone.
   *
   * Players with no position (train not yet placed) are excluded.
   *
   * @param gameId  Game to query
   * @param zone    Set of "row,col" milepost keys
   * @returns Players whose train is inside the zone
   */
  static async getPlayersInZone(
    gameId: string,
    zone: Set<string>,
    client?: import('pg').PoolClient,
  ): Promise<PlayerInZone[]> {
    if (zone.size === 0) return [];

    const queryFn = client ?? db;
    const result = await queryFn.query(
      `SELECT id, name, money, loads, train_type, position_row, position_col, current_turn_number
       FROM players
       WHERE game_id = $1
         AND position_row IS NOT NULL
         AND position_col IS NOT NULL`,
      [gameId],
    );

    return result.rows
      .filter(row => {
        const key = makeKey(row.position_row as number, row.position_col as number);
        return zone.has(key);
      })
      .map(row => ({
        playerId: row.id as string,
        gameId,
        name: row.name as string,
        money: row.money as number,
        loads: (row.loads || []) as string[],
        trainType: row.train_type as TrainType,
        positionRow: row.position_row as number,
        positionCol: row.position_col as number,
        turnNumber: (row.current_turn_number as number) || 1,
      }));
  }

  /**
   * Return all track segments (across all players in the game) that have at
   * least one endpoint inside the given zone.
   *
   * @param gameId  Game to query
   * @param zone    Set of "row,col" milepost keys
   * @returns (playerId, segment) pairs for matching segments
   */
  static async getTrackSegmentsInZone(
    gameId: string,
    zone: Set<string>,
  ): Promise<Array<{ playerId: string; segment: TrackSegment }>> {
    if (zone.size === 0) return [];

    const allTracks = await TrackService.getAllTracks(gameId);
    const results: Array<{ playerId: string; segment: TrackSegment }> = [];

    for (const trackState of allTracks) {
      for (const segment of trackState.segments) {
        const fromKey = makeKey(segment.from.row, segment.from.col);
        const toKey = makeKey(segment.to.row, segment.to.col);
        if (zone.has(fromKey) || zone.has(toKey)) {
          results.push({ playerId: trackState.playerId, segment });
        }
      }
    }

    return results;
  }

  /**
   * Return all track segments that cross the named river, paired with their owning player.
   *
   * This method IDENTIFIES segments — it does NOT mutate game state.
   * Use `TrackService.removeSegmentsCrossingRiver` for the actual deletion.
   *
   * @param gameId     Game to query
   * @param riverName  River name matching an entry in configuration/rivers.json
   * @returns (playerId, segment) pairs for river-crossing segments
   */
  static async findRiverCrossingSegments(
    gameId: string,
    riverName: string,
  ): Promise<Array<{ playerId: string; segment: TrackSegment }>> {
    const riverEdgeKeys = getRiverEdgeKeys(riverName);
    if (!riverEdgeKeys) {
      throw new Error(`Unknown river: ${riverName}`);
    }

    const allTracks = await TrackService.getAllTracks(gameId);
    const results: Array<{ playerId: string; segment: TrackSegment }> = [];

    for (const trackState of allTracks) {
      for (const segment of trackState.segments) {
        if (segmentCrossesRiver(segment, riverEdgeKeys)) {
          results.push({ playerId: trackState.playerId, segment });
        }
      }
    }

    return results;
  }
}
