/**
 * Server-side track build rules (issue #308).
 *
 * `planTrackBuild` is the single place that decides whether new track is legal
 * and what it costs. It is pure: the caller reads the board from the database
 * and passes it in. Both the human route (`POST /api/tracks/build`) and the
 * bots (`PlayerService.buildTrackForPlayer`) go through it, so neither can
 * submit a cost, skip a rule, or misreport the track that already exists.
 *
 * Out of scope here: city entry limits (medium 3 players, small 2) and
 * ferry-line limits.
 */

import { TURN_BUILD_BUDGET } from "../../shared/constants/gameRules";
import { getFerryEdges, getMajorCityLookup, isIntraCityEdge } from "../../shared/services/majorCityGroups";
import {
  computeSegmentBuildCost,
  createConfigSegmentCostContext,
  FerryChargeMode,
  SegmentCostContext,
  TrackCostCoord,
  TrackCostPoint,
  TrackCostSegment,
} from "../../shared/services/trackBuildCost";
import { TerrainType, TrackSegment } from "../../shared/types/GameTypes";
import { getHexNeighbors, GridPointData, gridToPixel, loadGridPoints, makeKey } from "./MapTopology";

/** Why a track build or a track undo was refused. */
export enum TrackBuildErrorCode {
  /** The request is not an ordered list of at least two milepost coordinates. */
  InvalidPath = 0,
  /** A coordinate is not a milepost on the map, or is water. */
  UnknownMilepost = 1,
  /** Two consecutive mileposts are not neighbours on the hex grid. */
  NotAdjacent = 2,
  /** Both mileposts belong to the same major city: no track inside the red area. */
  MajorCityRedArea = 3,
  /** Every section of the path is already the player's own track. */
  NothingToBuild = 4,
  /** A section touches neither the player's network nor a major city milepost. */
  NotConnected = 5,
  /** Track (the player's own or another player's) already joins the two mileposts. */
  RightOfWay = 6,
  /** More than two sections out of the same major city milepost in one turn. */
  MajorCityTurnLimit = 7,
  /** The turn's total would exceed the per-turn build budget. */
  TurnBudgetExceeded = 8,
  /** The player cannot pay for the track. */
  InsufficientFunds = 9,
  /** The player's last action this turn is not a track build. */
  NoSegmentToUndo = 10,
  /** A train was upgraded or crossgraded this turn; a purchase replaces building. */
  TrainPurchasedThisTurn = 11,
}

const MALFORMED_REQUEST_CODES: ReadonlySet<TrackBuildErrorCode> = new Set([
  TrackBuildErrorCode.InvalidPath,
  TrackBuildErrorCode.UnknownMilepost,
  TrackBuildErrorCode.NotAdjacent,
  TrackBuildErrorCode.MajorCityRedArea,
]);

/**
 * Thrown when track may not be built or undone. Requests that could never be
 * legal on this map (bad shape, unknown milepost, not adjacent, red area) map
 * to HTTP 400; requests the current game state refuses map to 409.
 */
export class TrackBuildError extends Error {
  public readonly httpStatus: number;

  constructor(
    public readonly code: TrackBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrackBuildError";
    this.httpStatus = MALFORMED_REQUEST_CODES.has(code) ? 400 : 409;
  }

  /** JSON body for an HTTP response, in the shape the player routes already use. */
  toResponseBody(): { error: string; code: string; details: string } {
    return {
      error: this.httpStatus === 400 ? "Validation error" : "Conflict",
      code: TrackBuildErrorCode[this.code],
      details: this.message,
    };
  }
}

/** Most mileposts one build request may name (a 20M turn builds at most 20 sections). */
export const MAX_BUILD_PATH_POINTS = 64;

/** The most sections a player may build out of one major city milepost per turn. */
export const MAJOR_CITY_SECTIONS_PER_TURN = 2;

/** One candidate track section: an undirected edge between two mileposts. */
export interface TrackBuildEdge {
  from: TrackCostCoord;
  to: TrackCostCoord;
}

/**
 * `turn_actions` entry for one track section built through the validated path.
 * One entry per section, so undo removes exactly the last section built.
 */
export interface TurnActionBuild {
  kind: "build";
  /** The section as stored in `player_tracks`, with the server-computed cost. */
  segment: TrackSegment;
  /**
   * Key ("row,col") of the major city milepost this section was built out
   * from, when it counts toward that milepost's two-per-turn limit.
   */
  majorCityStart?: string;
}

/** A validated, server-priced section. */
export interface PlannedTrackSegment {
  segment: TrackSegment;
  majorCityStart?: string;
}

export interface TrackBuildPlan {
  segments: PlannedTrackSegment[];
  /** Sum of the planned sections' costs, in ECU millions. */
  cost: number;
}

export interface TrackBuildPlanInput {
  /** Sections to build, in build order. */
  edges: readonly TrackBuildEdge[];
  /** The builder's track, read from the database. */
  ownSegments: readonly TrackCostSegment[];
  /** Every other player's track in the game, read from the database. */
  otherPlayersSegments: readonly TrackCostSegment[];
  /** What the player has already spent on track this turn. */
  turnSpent: number;
  /** Track spend not yet deducted from `money` (`player_tracks.turn_build_cost`). */
  unsettledCost: number;
  /** The player's cash. */
  money: number;
  /** `majorCityStart` keys of sections already built this turn. */
  majorCityStartsThisTurn: readonly string[];
}

function coordKey(coord: TrackCostCoord): string {
  return makeKey(coord.row, coord.col);
}

/** Order-independent key for the edge between two mileposts. */
function edgeKey(a: TrackCostCoord, b: TrackCostCoord): string {
  const aFirst = a.row < b.row || (a.row === b.row && a.col <= b.col);
  return aFirst ? `${coordKey(a)}|${coordKey(b)}` : `${coordKey(b)}|${coordKey(a)}`;
}

let ferryPartnerCache: Map<string, string[]> | null = null;

/** Ferry port key -> keys of the port(s) at the other end of its ferry line(s). */
function getFerryPartners(): Map<string, string[]> {
  if (ferryPartnerCache) return ferryPartnerCache;
  const partners = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = partners.get(from) ?? [];
    list.push(to);
    partners.set(from, list);
  };
  for (const ferry of getFerryEdges()) {
    const a = coordKey(ferry.pointA);
    const b = coordKey(ferry.pointB);
    link(a, b);
    link(b, a);
  }
  ferryPartnerCache = partners;
  return partners;
}

function isCoord(value: unknown): value is TrackCostCoord {
  if (typeof value !== "object" || value === null) return false;
  const { row, col } = value as { row?: unknown; col?: unknown };
  return Number.isInteger(row) && Number.isInteger(col);
}

/**
 * Check the shape of a request body's `path` and reduce it to coordinates.
 *
 * @throws TrackBuildError InvalidPath when the shape is wrong.
 */
export function parseBuildPath(path: unknown): TrackCostCoord[] {
  if (!Array.isArray(path) || path.length < 2 || path.length > MAX_BUILD_PATH_POINTS || !path.every(isCoord)) {
    throw new TrackBuildError(
      TrackBuildErrorCode.InvalidPath,
      `path must be a list of 2 to ${MAX_BUILD_PATH_POINTS} mileposts, each with an integer row and col`,
    );
  }
  return (path as TrackCostCoord[]).map(
    (point: TrackCostCoord): TrackCostCoord => ({ row: point.row, col: point.col }),
  );
}

/**
 * Turn a path into the sections to build.
 *
 * The path is an ordered list of mileposts, as the client's drawing preview
 * produces it: it may run along the player's existing track before branching
 * off, so consecutive pairs that are already the player's own track are
 * skipped rather than rejected.
 */
export function pathToBuildEdges(
  points: readonly TrackCostCoord[],
  ownSegments: readonly TrackCostSegment[],
): TrackBuildEdge[] {
  const ownEdges = new Set<string>(
    ownSegments.map((segment: TrackCostSegment): string => edgeKey(segment.from, segment.to)),
  );
  const edges: TrackBuildEdge[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    if (!ownEdges.has(edgeKey(points[i], points[i + 1]))) {
      edges.push({ from: points[i], to: points[i + 1] });
    }
  }
  return edges;
}

function toSegmentEnd(point: GridPointData): TrackSegment["from"] {
  const pixel = gridToPixel(point.row, point.col);
  return { x: pixel.x, y: pixel.y, row: point.row, col: point.col, terrain: point.terrain };
}

/**
 * Validate and price new track.
 *
 * Sections are checked in order, each against the board as it stands after
 * the sections before it. For every section:
 * 1. both ends are mileposts on the map and not water;
 * 2. the ends are neighbours on the hex grid;
 * 3. the ends are not in the same major city (no track in the red area);
 * 4. no track, of any player, already joins them (right of way);
 * 5. the section starts (`from`) on the player's network, at the far port of
 *    a ferry line the player has reached, or at a major city milepost; `to`
 *    is the milepost being built to and paid for;
 * 6. at most {@link MAJOR_CITY_SECTIONS_PER_TURN} sections leave one major
 *    city milepost per turn;
 * 7. the cost comes from the shared cost module; a ferry line is paid for
 *    once, on the player's first connection to either of its ports.
 * Then the turn total must fit the build budget and the player's cash.
 *
 * @throws TrackBuildError naming the first rule broken.
 */
export function planTrackBuild(input: TrackBuildPlanInput): TrackBuildPlan {
  if (input.edges.length === 0) {
    throw new TrackBuildError(
      TrackBuildErrorCode.NothingToBuild,
      "Nothing to build: every section of the path is already your track",
    );
  }

  const grid = loadGridPoints();
  const majorCityLookup = getMajorCityLookup();
  const ferryPartners = getFerryPartners();

  const ownNodes = new Set<string>();
  const occupiedEdges = new Set<string>();
  for (const segment of input.ownSegments) {
    ownNodes.add(coordKey(segment.from));
    ownNodes.add(coordKey(segment.to));
    occupiedEdges.add(edgeKey(segment.from, segment.to));
  }
  for (const segment of input.otherPlayersSegments) {
    occupiedEdges.add(edgeKey(segment.from, segment.to));
  }

  const costContext: SegmentCostContext<TrackCostPoint> = {
    ...createConfigSegmentCostContext([], FerryChargeMode.FirstConnectionOnly),
    // Live view of the network, so sections planned earlier in this build count.
    hasBuilderTrackAt: (coord: TrackCostCoord): boolean => ownNodes.has(coordKey(coord)),
  };

  /** On the player's track, or across a ferry line from it. */
  const isOnNetwork = (key: string): boolean =>
    ownNodes.has(key) ||
    (ferryPartners.get(key) ?? []).some((partner: string): boolean => ownNodes.has(partner));

  const majorCityStartCounts = new Map<string, number>();
  for (const key of input.majorCityStartsThisTurn) {
    majorCityStartCounts.set(key, (majorCityStartCounts.get(key) ?? 0) + 1);
  }

  const segments: PlannedTrackSegment[] = [];
  let cost = 0;

  for (const edge of input.edges) {
    const fromKey = coordKey(edge.from);
    const toKey = coordKey(edge.to);
    const fromPoint = grid.get(fromKey);
    const toPoint = grid.get(toKey);
    for (const [key, point] of [[fromKey, fromPoint], [toKey, toPoint]] as const) {
      if (!point || point.terrain === TerrainType.Water) {
        throw new TrackBuildError(
          TrackBuildErrorCode.UnknownMilepost,
          `(${key}) is not a milepost track can be built on`,
        );
      }
    }
    if (!fromPoint || !toPoint) continue; // unreachable; narrows the types

    const adjacent = getHexNeighbors(fromPoint.row, fromPoint.col).some(
      (neighbor: TrackCostCoord): boolean => neighbor.row === toPoint.row && neighbor.col === toPoint.col,
    );
    if (!adjacent) {
      throw new TrackBuildError(
        TrackBuildErrorCode.NotAdjacent,
        `Mileposts (${fromKey}) and (${toKey}) are not adjacent`,
      );
    }

    if (isIntraCityEdge(fromKey, toKey, majorCityLookup)) {
      throw new TrackBuildError(
        TrackBuildErrorCode.MajorCityRedArea,
        `No track may be built inside ${majorCityLookup.get(fromKey)} between (${fromKey}) and (${toKey})`,
      );
    }

    const key = edgeKey(edge.from, edge.to);
    if (occupiedEdges.has(key)) {
      throw new TrackBuildError(
        TrackBuildErrorCode.RightOfWay,
        `Track already runs between (${fromKey}) and (${toKey})`,
      );
    }

    // The request fixes the direction: track is built from `from` to `to`, and
    // `to` is the milepost paid for. `from` must therefore be a legal start,
    // or a caller could send a section backwards to pay for the cheap end.
    const fromIsMajorCity = majorCityLookup.has(fromKey);
    if (!isOnNetwork(fromKey) && !fromIsMajorCity) {
      throw new TrackBuildError(
        TrackBuildErrorCode.NotConnected,
        `Track from (${fromKey}) to (${toKey}) must start on your track, at the far port of a ferry line you have reached, or at a major city`,
      );
    }

    // A section leaves a major city milepost when it starts there and its far
    // end is not yet on the player's network.
    const majorCityStart: string | undefined =
      fromIsMajorCity && !isOnNetwork(toKey) ? fromKey : undefined;
    if (majorCityStart !== undefined) {
      const count = (majorCityStartCounts.get(majorCityStart) ?? 0) + 1;
      if (count > MAJOR_CITY_SECTIONS_PER_TURN) {
        throw new TrackBuildError(
          TrackBuildErrorCode.MajorCityTurnLimit,
          `No more than ${MAJOR_CITY_SECTIONS_PER_TURN} track sections may be built from major city milepost (${majorCityStart}) in one turn`,
        );
      }
      majorCityStartCounts.set(majorCityStart, count);
    }

    const segmentCost = computeSegmentBuildCost(fromPoint, toPoint, costContext);
    cost += segmentCost;
    segments.push({
      segment: { from: toSegmentEnd(fromPoint), to: toSegmentEnd(toPoint), cost: segmentCost },
      ...(majorCityStart !== undefined ? { majorCityStart } : {}),
    });

    ownNodes.add(fromKey);
    ownNodes.add(toKey);
    occupiedEdges.add(key);
  }

  if (input.turnSpent + cost > TURN_BUILD_BUDGET) {
    throw new TrackBuildError(
      TrackBuildErrorCode.TurnBudgetExceeded,
      `Build costs ${cost}M; ${input.turnSpent}M of this turn's ${TURN_BUILD_BUDGET}M is already spent`,
    );
  }
  if (input.unsettledCost + cost > input.money) {
    throw new TrackBuildError(
      TrackBuildErrorCode.InsufficientFunds,
      `Insufficient funds: need ${input.unsettledCost + cost}, have ${input.money}`,
    );
  }

  return { segments, cost };
}

/** The build entries among a turn's actions. Tolerates malformed rows. */
export function buildActionsOf(actions: unknown): TurnActionBuild[] {
  if (!Array.isArray(actions)) return [];
  return actions.filter(
    (action: unknown): action is TurnActionBuild =>
      typeof action === "object" &&
      action !== null &&
      (action as { kind?: unknown }).kind === "build" &&
      typeof (action as { segment?: { cost?: unknown } }).segment?.cost === "number",
  );
}
