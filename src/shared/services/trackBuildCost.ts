/**
 * Shared track-segment build cost — the single source of truth for what one
 * new track section costs (ECU millions).
 *
 * Used by:
 * - the server (`planTrackBuild`, #308), which prices every section built by a
 *   human or a bot and ignores any cost the caller sends
 * - the client (`TrackDrawingManager.calculateTrackCost`)
 * - the bots (`computeBuildSegments`, `findBuildPath`)
 *
 * The function depends only on plain data (row/col/terrain plus a few lookups
 * supplied through {@link SegmentCostContext}), never on Phaser objects, so it
 * can run on the server.
 */

import { getTerrainBuildCost } from '../config/terrainCosts';
import { getWaterCrossingExtraCost } from '../config/waterCrossings';
import { getFerryEdges, getMajorCityLookup } from './majorCityGroups';
import { TerrainType } from '../types/GameTypes';

/** Cost of the first connection into a major city milepost (center or outpost). */
export const MAJOR_CITY_ENTRY_COST = 5;

/** Minimal milepost data needed to price a segment. */
export interface TrackCostPoint {
  row: number;
  col: number;
  terrain: TerrainType;
}

/** Grid coordinate of a milepost. */
export interface TrackCostCoord {
  row: number;
  col: number;
}

/** A ferry line as seen by the cost function. */
export interface SegmentCostFerry {
  /** Build cost of the ferry line in ECU millions (4–16M). */
  cost: number;
  /** Both ferry port mileposts of the line. */
  ports: readonly [TrackCostCoord, TrackCostCoord];
}

/**
 * How a segment that ends on a ferry port is charged. Callers choose a mode
 * explicitly.
 */
export enum FerryChargeMode {
  /**
   * The rule, and what the server charges everyone (#308): the builder pays
   * the ferry cost only when none of the line's two ports is on their track
   * yet; any later segment into either port costs 0 (before water-crossing
   * surcharge). Also used by the client and by the bots' segment builder.
   */
  FirstConnectionOnly = 0,
  /**
   * Every segment that ends on a ferry port pays the ferry cost, regardless of
   * the builder's existing track. Not a price anyone is charged: it is the
   * upper-bound estimate the bots' path search (`findBuildPath`) ranks paths
   * with, matching its Dijkstra edge weights.
   */
  EveryConnection = 1,
}

/**
 * Lookups the cost function needs about the map and the builder's track.
 * Generic over the point type so callers can answer from their own
 * representation (client `GridPoint`, server `GridPointData`, ...).
 */
export interface SegmentCostContext<P extends TrackCostPoint = TrackCostPoint> {
  /** True when the milepost is a major-city center or one of its outposts. */
  isMajorCityPoint(point: P): boolean;
  /** The ferry line whose port is at this milepost, if any. */
  getFerryAt(point: P): SegmentCostFerry | undefined;
  /**
   * True when the builder already has track (committed or pending this turn)
   * touching this milepost.
   */
  hasBuilderTrackAt(coord: TrackCostCoord): boolean;
  /** How segments ending on a ferry port are charged. */
  ferryChargeMode: FerryChargeMode;
}

/**
 * Cost in ECU millions of building one new track section from `from` to `to`.
 *
 * Rules, in order:
 * 1. Base cost is the terrain cost of the destination milepost.
 * 2. Major-city entry: the builder's first connection into a major-city
 *    milepost from outside any major city costs exactly
 *    {@link MAJOR_CITY_ENTRY_COST}.
 * 3. Ferry: a destination that is a ferry port replaces the cost so far with
 *    the ferry cost (or 0), per {@link FerryChargeMode}.
 * 4. Water crossing: river (+2) or lake/ocean inlet (+3) is added on top,
 *    at most one surcharge per segment.
 *
 * Does not validate legality (adjacency, water, right of way, city limits).
 */
export function computeSegmentBuildCost<P extends TrackCostPoint>(
  from: P,
  to: P,
  context: SegmentCostContext<P>,
): number {
  let cost = getTerrainBuildCost(to.terrain);

  if (
    context.isMajorCityPoint(to) &&
    !context.isMajorCityPoint(from) &&
    !context.hasBuilderTrackAt(to)
  ) {
    cost = MAJOR_CITY_ENTRY_COST;
  }

  const ferry = context.getFerryAt(to);
  if (ferry) {
    if (context.ferryChargeMode === FerryChargeMode.EveryConnection) {
      cost = ferry.cost;
    } else {
      const alreadyConnected = ferry.ports.some(
        (port: TrackCostCoord): boolean => context.hasBuilderTrackAt(port),
      );
      cost = alreadyConnected ? 0 : ferry.cost;
    }
  }

  return cost + getWaterCrossingExtraCost(from, to);
}

/** Segment endpoints, as needed to index a builder's track. */
export interface TrackCostSegment {
  from: TrackCostCoord;
  to: TrackCostCoord;
}

function coordKey(coord: TrackCostCoord): string {
  return `${coord.row},${coord.col}`;
}

/**
 * Build a `hasBuilderTrackAt` predicate from the builder's segments
 * (committed and/or pending).
 */
export function createBuilderTrackIndex(
  segments: readonly TrackCostSegment[],
): (coord: TrackCostCoord) => boolean {
  const keys = new Set<string>();
  for (const segment of segments) {
    keys.add(coordKey(segment.from));
    keys.add(coordKey(segment.to));
  }
  return (coord: TrackCostCoord): boolean => keys.has(coordKey(coord));
}

let ferryByPortKeyCache: Map<string, SegmentCostFerry> | null = null;

function getFerryByPortKey(): Map<string, SegmentCostFerry> {
  if (ferryByPortKeyCache) return ferryByPortKeyCache;
  const lookup = new Map<string, SegmentCostFerry>();
  for (const edge of getFerryEdges()) {
    const ferry: SegmentCostFerry = { cost: edge.cost, ports: [edge.pointA, edge.pointB] };
    lookup.set(coordKey(edge.pointA), ferry);
    lookup.set(coordKey(edge.pointB), ferry);
  }
  ferryByPortKeyCache = lookup;
  return lookup;
}

/**
 * A {@link SegmentCostContext} answered entirely from the checked-in map
 * configuration (`configuration/gridPoints.json`, `ferryPoints.json`) plus the
 * builder's segments. This is all the data a server has, so it is the context
 * server-side cost checks should use.
 *
 * Ferry ports are matched by coordinate, so the Dublin and Belfast mileposts
 * (typed "Small City" in the config, ferry ports in play) are priced as ferry
 * ports, matching both the client and the bots.
 */
export function createConfigSegmentCostContext(
  builderSegments: readonly TrackCostSegment[],
  ferryChargeMode: FerryChargeMode,
): SegmentCostContext<TrackCostPoint> {
  const majorCityLookup = getMajorCityLookup();
  const ferryByPortKey = getFerryByPortKey();
  return {
    isMajorCityPoint: (point: TrackCostPoint): boolean => majorCityLookup.has(coordKey(point)),
    getFerryAt: (point: TrackCostPoint): SegmentCostFerry | undefined =>
      ferryByPortKey.get(coordKey(point)),
    hasBuilderTrackAt: createBuilderTrackIndex(builderSegments),
    ferryChargeMode,
  };
}
