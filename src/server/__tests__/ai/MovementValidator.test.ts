/**
 * Unit tests for MovementValidator service.
 * Tests path validation including adjacency, reversal, ferry, budget, and city movement.
 */

import { MovementValidator, isHexAdjacent } from '../../../shared/services/MovementValidator';
import { makeSnapshot, makeGridPoint, makeSegment } from './helpers/testFixtures';
import { TerrainType, TrainType } from '../../../shared/types/GameTypes';
import type { GridPoint, PlayerTrackState } from '../../../shared/types/GameTypes';

// Mock majorCityGroups
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    {
      cityName: 'Berlin',
      center: { row: 10, col: 10 },
      outposts: [{ row: 10, col: 9 }, { row: 10, col: 11 }, { row: 9, col: 10 }],
    },
    {
      cityName: 'Paris',
      center: { row: 20, col: 20 },
      outposts: [{ row: 20, col: 19 }],
    },
  ],
  getFerryEdges: () => [
    {
      name: 'Channel Ferry',
      pointA: { row: 5, col: 5 },
      pointB: { row: 5, col: 8 },
    },
  ],
}));

// --- Helpers ---

function gp(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return makeGridPoint(row, col, terrain, cityName);
}

function makeMapPoints(): GridPoint[] {
  return [
    // Berlin major city
    gp(10, 10, TerrainType.MajorCity, 'Berlin'),
    gp(10, 9, TerrainType.MajorCity, 'Berlin'),
    gp(10, 11, TerrainType.MajorCity, 'Berlin'),
    gp(9, 10, TerrainType.MajorCity, 'Berlin'),
    // Clear terrain around Berlin
    gp(10, 8, TerrainType.Clear),
    gp(10, 12, TerrainType.Clear),
    gp(11, 10, TerrainType.Clear),
    gp(11, 11, TerrainType.Clear),
    gp(9, 9, TerrainType.Clear),
    gp(9, 11, TerrainType.Clear),
    // Paris major city
    gp(20, 20, TerrainType.MajorCity, 'Paris'),
    gp(20, 19, TerrainType.MajorCity, 'Paris'),
    // Ferry ports
    gp(5, 5, TerrainType.FerryPort),
    gp(5, 8, TerrainType.FerryPort),
    // Small city
    gp(15, 15, TerrainType.SmallCity, 'SmallTown'),
    // Mountain
    gp(12, 12, TerrainType.Mountain),
    // More clear for path tests
    gp(10, 7, TerrainType.Clear),
    gp(10, 6, TerrainType.Clear),
  ];
}

function makeTracks(botId: string): PlayerTrackState[] {
  return [
    {
      playerId: botId,
      gameId: 'game-1',
      segments: [
        // Berlin outpost (10,9) to clear (10,8)
        makeSegment(10, 9, TerrainType.MajorCity, 10, 8, TerrainType.Clear, 1),
        // Clear chain: (10,8) -> (10,7) -> (10,6)
        makeSegment(10, 8, TerrainType.Clear, 10, 7, TerrainType.Clear, 1),
        makeSegment(10, 7, TerrainType.Clear, 10, 6, TerrainType.Clear, 1),
      ],
      totalCost: 3,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    },
  ];
}

// --- Tests ---

describe('MovementValidator', () => {
  describe('isHexAdjacent', () => {
    it('should return true for same-row adjacent columns', () => {
      expect(isHexAdjacent({ row: 5, col: 3 }, { row: 5, col: 4 })).toBe(true);
      expect(isHexAdjacent({ row: 5, col: 4 }, { row: 5, col: 3 })).toBe(true);
    });

    it('should return false for same-row non-adjacent columns', () => {
      expect(isHexAdjacent({ row: 5, col: 3 }, { row: 5, col: 5 })).toBe(false);
    });

    it('should return true for even-row downward neighbors', () => {
      // Even row (10): down-left and down-same
      expect(isHexAdjacent({ row: 10, col: 5 }, { row: 11, col: 5 })).toBe(true);
      expect(isHexAdjacent({ row: 10, col: 5 }, { row: 11, col: 4 })).toBe(true);
    });

    it('should return true for odd-row downward neighbors', () => {
      // Odd row (11): down-same and down-right
      expect(isHexAdjacent({ row: 11, col: 5 }, { row: 12, col: 5 })).toBe(true);
      expect(isHexAdjacent({ row: 11, col: 5 }, { row: 12, col: 6 })).toBe(true);
    });

    it('should return false for non-adjacent rows', () => {
      expect(isHexAdjacent({ row: 5, col: 3 }, { row: 7, col: 3 })).toBe(false);
    });

    it('should return false for same point', () => {
      expect(isHexAdjacent({ row: 5, col: 5 }, { row: 5, col: 5 })).toBe(false);
    });
  });

  describe('validateMovePath', () => {
    it('should reject path with fewer than 2 points', () => {
      const snapshot = makeSnapshot({ mapPoints: makeMapPoints() });
      const result = MovementValidator.validateMovePath(snapshot, [gp(10, 10, TerrainType.MajorCity)]);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/at least 2 points/);
    });

    it('should validate a simple valid move on own track', () => {
      const tracks = makeTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 9,
        allPlayerTracks: tracks,
        mapPoints: makeMapPoints(),
        trackSegments: tracks[0].segments,
      });

      const path = [
        gp(10, 9, TerrainType.MajorCity, 'Berlin'),
        gp(10, 8, TerrainType.Clear),
        gp(10, 7, TerrainType.Clear),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(true);
      expect(result.movementCost).toBe(2);
    });

    it('should reject path that exceeds movement budget', () => {
      const tracks = makeTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 9 },
        remainingMovement: 1,
        allPlayerTracks: tracks,
        mapPoints: makeMapPoints(),
        trackSegments: tracks[0].segments,
      });

      const path = [
        gp(10, 9, TerrainType.MajorCity, 'Berlin'),
        gp(10, 8, TerrainType.Clear),
        gp(10, 7, TerrainType.Clear),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/movement points/);
    });

    it('should allow free movement within a major city', () => {
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 10 },
        remainingMovement: 9,
        allPlayerTracks: [],
        mapPoints: makeMapPoints(),
      });

      // Move from Berlin center to Berlin outpost — should be free (0 cost)
      const path = [
        gp(10, 10, TerrainType.MajorCity, 'Berlin'),
        gp(10, 9, TerrainType.MajorCity, 'Berlin'),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(true);
      expect(result.movementCost).toBe(0);
    });

    it('should reject path not starting at current position', () => {
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 10 },
        remainingMovement: 9,
        allPlayerTracks: [],
        mapPoints: makeMapPoints(),
      });

      const path = [
        gp(20, 20, TerrainType.MajorCity, 'Paris'),
        gp(20, 19, TerrainType.MajorCity, 'Paris'),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/current position/);
    });

    it('should reject non-adjacent points in path', () => {
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 8 },
        remainingMovement: 9,
        allPlayerTracks: makeTracks('bot-1'),
        mapPoints: makeMapPoints(),
      });

      const path = [
        gp(10, 8, TerrainType.Clear),
        gp(10, 6, TerrainType.Clear), // skips col 7
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not adjacent/);
    });

    it('should reject path with no track connection', () => {
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 8 },
        remainingMovement: 9,
        allPlayerTracks: [], // no tracks at all
        mapPoints: makeMapPoints(),
      });

      const path = [
        gp(10, 8, TerrainType.Clear),
        gp(10, 7, TerrainType.Clear),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/No track connects/);
    });

    it('should reject reversal at non-city terrain', () => {
      const tracks = makeTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 8 },
        remainingMovement: 9,
        allPlayerTracks: tracks,
        mapPoints: makeMapPoints(),
        trackSegments: tracks[0].segments,
      });

      // Move forward then reverse at a clear terrain point
      const path = [
        gp(10, 8, TerrainType.Clear),
        gp(10, 7, TerrainType.Clear),
        gp(10, 8, TerrainType.Clear), // reversal at clear terrain!
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Reversal only allowed/);
    });

    it('should allow reversal at a city', () => {
      const tracks = makeTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 8 },
        remainingMovement: 9,
        allPlayerTracks: tracks,
        mapPoints: makeMapPoints(),
        trackSegments: tracks[0].segments,
      });

      // Move to Berlin outpost (MajorCity terrain) then back
      const path = [
        gp(10, 8, TerrainType.Clear),
        gp(10, 9, TerrainType.MajorCity, 'Berlin'),
        gp(10, 8, TerrainType.Clear), // reversal at major city — allowed
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(true);
      expect(result.movementCost).toBe(2);
    });

    it('should validate initial placement at a major city', () => {
      const snapshot = makeSnapshot({
        position: null,
        remainingMovement: 0,
        allPlayerTracks: [],
        mapPoints: makeMapPoints(),
      });

      // Path starts at Berlin center (initial placement), moves to outpost
      const path = [
        gp(10, 10, TerrainType.MajorCity, 'Berlin'),
        gp(10, 9, TerrainType.MajorCity, 'Berlin'),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(true);
      expect(result.movementCost).toBe(0);
    });

    it('should reject initial placement at non-major-city', () => {
      const snapshot = makeSnapshot({
        position: null,
        remainingMovement: 0,
        allPlayerTracks: [],
        mapPoints: makeMapPoints(),
      });

      const path = [
        gp(15, 15, TerrainType.SmallCity, 'SmallTown'),
        gp(15, 16, TerrainType.Clear),
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Major City/);
    });

    it('should handle ferry connections as valid edges', () => {
      // Create tracks connecting to ferry ports
      const tracks: PlayerTrackState[] = [{
        playerId: 'bot-1',
        gameId: 'game-1',
        segments: [
          makeSegment(5, 4, TerrainType.Clear, 5, 5, TerrainType.FerryPort, 1),
        ],
        totalCost: 1,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      }];

      const mapPoints = [
        ...makeMapPoints(),
        gp(5, 4, TerrainType.Clear),
      ];

      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 5, col: 4 },
        remainingMovement: 9,
        allPlayerTracks: tracks,
        mapPoints,
        trackSegments: tracks[0].segments,
      });

      // Move to ferry port, then across ferry
      const path = [
        gp(5, 4, TerrainType.Clear),
        gp(5, 5, TerrainType.FerryPort),
        gp(5, 8, TerrainType.FerryPort), // ferry crossing
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(true);
    });

    it('should count movement cost correctly for mixed terrain path', () => {
      const tracks = makeTracks('bot-1');
      const snapshot = makeSnapshot({
        position: { x: 0, y: 0, row: 10, col: 10 },
        remainingMovement: 9,
        allPlayerTracks: tracks,
        mapPoints: makeMapPoints(),
        trackSegments: tracks[0].segments,
      });

      // Berlin center -> Berlin outpost (free) -> clear (1 cost) -> clear (1 cost)
      const path = [
        gp(10, 10, TerrainType.MajorCity, 'Berlin'),
        gp(10, 9, TerrainType.MajorCity, 'Berlin'),  // city internal: 0
        gp(10, 8, TerrainType.Clear),                  // exit city: 1
        gp(10, 7, TerrainType.Clear),                  // external: 1
      ];

      const result = MovementValidator.validateMovePath(snapshot, path);
      expect(result.valid).toBe(true);
      expect(result.movementCost).toBe(2);
    });
  });
});
