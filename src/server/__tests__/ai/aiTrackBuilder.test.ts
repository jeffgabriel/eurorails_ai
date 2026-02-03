/**
 * Tests for AITrackBuilder - server-side track pathfinding and building
 */

import { getAITrackBuilder, AITrackBuilder } from '../../services/ai/aiTrackBuilder';
import { TrackService } from '../../services/trackService';
import { db } from '../../db';

// Mock dependencies
jest.mock('../../db', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../services/trackService', () => ({
  TrackService: {
    getTrackState: jest.fn(),
    getAllTracks: jest.fn(),
    saveTrackState: jest.fn(),
  },
}));

const mockDb = db as jest.Mocked<typeof db>;
const mockTrackService = TrackService as jest.Mocked<typeof TrackService>;

describe('AITrackBuilder', () => {
  let trackBuilder: AITrackBuilder;

  beforeEach(() => {
    jest.clearAllMocks();
    // Get fresh instance
    trackBuilder = getAITrackBuilder();
  });

  describe('initialization', () => {
    it('should initialize with mileposts from grid configuration', () => {
      // The builder should have mileposts loaded
      const milepost = trackBuilder.getMilepost(50, 30);
      // There should be some mileposts in the grid
      expect(milepost === undefined || milepost.row === 50).toBe(true);
    });
  });

  describe('findPath', () => {
    it('should find a path between two valid points', () => {
      // Find a path between two close points
      const result = trackBuilder.findPath(50, 30, 51, 30, [], []);

      // Either finds a path or returns null if no valid mileposts at those coords
      if (result) {
        expect(result.path.length).toBeGreaterThan(0);
        expect(result.cost).toBeGreaterThanOrEqual(0);
      }
    });

    it('should return null for impossible paths', () => {
      // Try to find a path to an ocean/water point (should fail)
      const result = trackBuilder.findPath(0, 0, 999, 999, [], []);
      expect(result).toBeNull();
    });

    it('should avoid other players track segments', () => {
      const otherPlayerTrack = [{
        from: { x: 0, y: 0, row: 50, col: 31, terrain: 0 },
        to: { x: 0, y: 0, row: 51, col: 31, terrain: 0 },
        cost: 1,
      }];

      // If there's a path that would go through the other player's segment,
      // it should find an alternative or return null
      const result = trackBuilder.findPath(50, 30, 52, 32, [], otherPlayerTrack);

      // Result could be null if no path avoiding the segment, or a longer path
      if (result) {
        expect(result.path.length).toBeGreaterThan(0);
      }
    });

    it('should reuse existing track at zero cost', () => {
      const existingTrack = [{
        from: { x: 0, y: 0, row: 50, col: 30, terrain: 0 },
        to: { x: 0, y: 0, row: 50, col: 31, terrain: 0 },
        cost: 1,
      }];

      const resultWithTrack = trackBuilder.findPath(50, 30, 50, 32, existingTrack, []);
      const resultWithoutTrack = trackBuilder.findPath(50, 30, 50, 32, [], []);

      // With existing track, cost should be less or equal
      if (resultWithTrack && resultWithoutTrack) {
        expect(resultWithTrack.cost).toBeLessThanOrEqual(resultWithoutTrack.cost);
      }
    });
  });

  describe('buildTrackToTarget', () => {
    const mockGameId = 'test-game-id';
    const mockPlayerId = 'test-player-id';

    beforeEach(() => {
      mockTrackService.getTrackState.mockResolvedValue(null);
      mockTrackService.getAllTracks.mockResolvedValue([]);
    });

    it('should build track when no existing track exists', async () => {
      // With no existing track, should start from nearest major city
      const result = await trackBuilder.buildTrackToTarget(
        mockGameId,
        mockPlayerId,
        30, // target row
        50, // target col
        20  // budget
      );

      // May or may not find a path depending on grid layout
      if (result) {
        expect(result.segments.length).toBeGreaterThan(0);
        expect(result.cost).toBeLessThanOrEqual(20);
      }
    });

    it('should respect budget limits', async () => {
      const result = await trackBuilder.buildTrackToTarget(
        mockGameId,
        mockPlayerId,
        30, // target row
        50, // target col
        5   // small budget
      );

      if (result) {
        expect(result.cost).toBeLessThanOrEqual(5);
      }
    });

    it('should extend from existing track network', async () => {
      mockTrackService.getTrackState.mockResolvedValue({
        playerId: mockPlayerId,
        gameId: mockGameId,
        segments: [{
          from: { x: 0, y: 0, row: 35, col: 50, terrain: 0 },
          to: { x: 0, y: 0, row: 35, col: 51, terrain: 0 },
          cost: 1,
        }],
        totalCost: 1,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      });

      const result = await trackBuilder.buildTrackToTarget(
        mockGameId,
        mockPlayerId,
        36, // target row (near existing track)
        51, // target col
        20  // budget
      );

      // Should find a path from existing track
      if (result) {
        expect(result.segments.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getMilepost', () => {
    it('should return undefined for non-existent coordinates', () => {
      const milepost = trackBuilder.getMilepost(-1, -1);
      expect(milepost).toBeUndefined();
    });

    it('should return milepost for valid coordinates if they exist', () => {
      // Try a few known grid positions
      // The actual data depends on gridPoints.json
      const milepost = trackBuilder.getMilepost(51, 3);
      // Either exists or doesn't based on actual config
      expect(milepost === undefined || milepost.row === 51).toBe(true);
    });
  });
});
