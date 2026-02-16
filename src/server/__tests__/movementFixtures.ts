/**
 * Movement test fixtures — Adjacent hex grid points suitable for pathfinding.
 *
 * Existing fixtures use non-adjacent grid points (rows 10→20→30),
 * so Dijkstra pathfinding won't find paths between them. These fixtures
 * use adjacent hex-neighbor positions that form valid connected paths.
 *
 * Hex grid offset rules (even-q):
 *   Even rows: neighbors at [-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]
 *   Odd rows:  neighbors at [-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]
 */

import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  TrackSegment,
  TerrainType,
  TrainType,
  TRAIN_PROPERTIES,
  BotConfig,
  BotSkillLevel,
  BotArchetype,
} from '../../shared/types/GameTypes';

// ── Adjacent hex grid positions ────────────────────────────────────────
// Row 10 (even): neighbors include (9,9),(9,10),(10,9),(10,11),(11,9),(11,10)
// Row 11 (odd):  neighbors include (10,10),(10,11),(11,9),(11,11),(12,10),(12,11)
// Row 12 (even): neighbors include (11,9),(11,10),(12,9),(12,11),(13,9),(13,10)

export const POSITIONS = {
  /** Major city at (10,10) — starting point for most tests */
  majorCity: { row: 10, col: 10, terrain: TerrainType.MajorCity },
  /** Clear terrain at (11,10) — hex neighbor of (10,10) on even row */
  clear1: { row: 11, col: 10, terrain: TerrainType.Clear },
  /** Clear terrain at (12,10) — hex neighbor of (11,10) on odd row */
  clear2: { row: 12, col: 10, terrain: TerrainType.Clear },
  /** Clear terrain at (13,10) — hex neighbor of (12,10) on even row */
  clear3: { row: 13, col: 10, terrain: TerrainType.Clear },
  /** Medium city at (14,10) — hex neighbor of (13,10) on odd row, delivery target */
  mediumCity: { row: 14, col: 10, terrain: TerrainType.MediumCity },
  /** Mountain at (11,9) — hex neighbor of (10,10), alternate route */
  mountain: { row: 11, col: 9, terrain: TerrainType.Mountain },
} as const;

// ── Segment builders ───────────────────────────────────────────────────

/** Build a TrackSegment from two positions with an explicit cost */
export function makeTrackSegment(
  from: { row: number; col: number; terrain: TerrainType },
  to: { row: number; col: number; terrain: TerrainType },
  cost: number,
): TrackSegment {
  return {
    from: { x: 0, y: 0, row: from.row, col: from.col, terrain: from.terrain },
    to: { x: 0, y: 0, row: to.row, col: to.col, terrain: to.terrain },
    cost,
  };
}

// ── Pre-built segments forming a short adjacent path ───────────────────

/** (10,10) MajorCity → (11,10) Clear, cost 1 */
export const SEG_MAJOR_TO_CLEAR1 = makeTrackSegment(
  POSITIONS.majorCity,
  POSITIONS.clear1,
  1,
);

/** (11,10) Clear → (12,10) Clear, cost 1 */
export const SEG_CLEAR1_TO_CLEAR2 = makeTrackSegment(
  POSITIONS.clear1,
  POSITIONS.clear2,
  1,
);

/** (12,10) Clear → (13,10) Clear, cost 1 */
export const SEG_CLEAR2_TO_CLEAR3 = makeTrackSegment(
  POSITIONS.clear2,
  POSITIONS.clear3,
  1,
);

/** (13,10) Clear → (14,10) MediumCity, cost 3 */
export const SEG_CLEAR3_TO_MEDIUM = makeTrackSegment(
  POSITIONS.clear3,
  POSITIONS.mediumCity,
  3,
);

/** Full path: MajorCity → clear1 → clear2 → clear3 → mediumCity */
export const FULL_PATH_SEGMENTS: TrackSegment[] = [
  SEG_MAJOR_TO_CLEAR1,
  SEG_CLEAR1_TO_CLEAR2,
  SEG_CLEAR2_TO_CLEAR3,
  SEG_CLEAR3_TO_MEDIUM,
];

/** Short path: MajorCity → clear1 → clear2 (3 mileposts) */
export const SHORT_PATH_SEGMENTS: TrackSegment[] = [
  SEG_MAJOR_TO_CLEAR1,
  SEG_CLEAR1_TO_CLEAR2,
];

// ── Movement path (grid coordinates for train movement) ────────────────

/** Grid coordinate path for the full track: majorCity → mediumCity */
export const FULL_MOVEMENT_PATH = [
  { row: POSITIONS.majorCity.row, col: POSITIONS.majorCity.col },
  { row: POSITIONS.clear1.row, col: POSITIONS.clear1.col },
  { row: POSITIONS.clear2.row, col: POSITIONS.clear2.col },
  { row: POSITIONS.clear3.row, col: POSITIONS.clear3.col },
  { row: POSITIONS.mediumCity.row, col: POSITIONS.mediumCity.col },
];

/** Grid coordinate path: majorCity → clear2 (truncated for speed limit tests) */
export const SHORT_MOVEMENT_PATH = [
  { row: POSITIONS.majorCity.row, col: POSITIONS.majorCity.col },
  { row: POSITIONS.clear1.row, col: POSITIONS.clear1.col },
  { row: POSITIONS.clear2.row, col: POSITIONS.clear2.col },
];

// ── Mock demand cards ──────────────────────────────────────────────────

/** Demand card IDs that reference the medium city as a delivery destination */
export const DEMAND_CARD_IDS = [42, 73, 108];

// ── Snapshot builders ──────────────────────────────────────────────────

export function makeMovementSnapshot(
  overrides?: Partial<WorldSnapshot['bot']>,
  topOverrides?: Partial<WorldSnapshot>,
): WorldSnapshot {
  return {
    gameId: 'game-move-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: POSITIONS.majorCity.row, col: POSITIONS.majorCity.col },
      existingSegments: FULL_PATH_SEGMENTS,
      demandCards: DEMAND_CARD_IDS,
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [
      {
        playerId: 'bot-1',
        segments: FULL_PATH_SEGMENTS,
      },
    ],
    loadAvailability: {},
    ...topOverrides,
  };
}

/** Snapshot where bot is on active game but has no position */
export function makeNoPositionSnapshot(
  overrides?: Partial<WorldSnapshot['bot']>,
): WorldSnapshot {
  return makeMovementSnapshot({
    position: null,
    ...overrides,
  });
}

/** Snapshot during initialBuild phase — movement should be disabled */
export function makeInitialBuildSnapshot(
  overrides?: Partial<WorldSnapshot['bot']>,
): WorldSnapshot {
  return makeMovementSnapshot(overrides, {
    gameStatus: 'initialBuild' as any,
  });
}

// ── FeasibleOption builders ────────────────────────────────────────────

export function makeMoveOption(
  movementPath: { row: number; col: number }[],
  mileposts: number,
  overrides?: Partial<FeasibleOption>,
): FeasibleOption {
  const target = movementPath[movementPath.length - 1];
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move toward demand city',
    movementPath,
    targetPosition: target,
    mileposts,
    ...overrides,
  };
}

export function makeInfeasibleMoveOption(reason: string): FeasibleOption {
  return {
    action: AIActionType.MoveTrain,
    feasible: false,
    reason,
  };
}

// ── BotConfig builders ─────────────────────────────────────────────────

export function makeBotConfig(
  archetype: BotArchetype = BotArchetype.Balanced,
): BotConfig {
  return { skillLevel: BotSkillLevel.Medium, archetype };
}

// ── Speed helpers ──────────────────────────────────────────────────────

/** Get the speed limit for a given train type */
export function getSpeedLimit(trainType: string): number {
  const props = TRAIN_PROPERTIES[trainType as TrainType];
  return props?.speed ?? 9;
}

// ── All-player track fixtures (for track usage fee tests) ──────────────

/** Tracks owned by another player that overlap with the bot's path */
export function makeOtherPlayerTracks(): WorldSnapshot['allPlayerTracks'] {
  return [
    {
      playerId: 'bot-1',
      segments: FULL_PATH_SEGMENTS,
    },
    {
      playerId: 'player-2',
      segments: [
        SEG_CLEAR1_TO_CLEAR2, // player-2 owns clear1→clear2
      ],
    },
  ];
}
