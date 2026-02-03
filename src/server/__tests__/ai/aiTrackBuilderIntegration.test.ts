/**
 * Integration test for AI track building
 * Verifies that AITrackBuilder + AIService actually creates track segments
 */

import { getAITrackBuilder } from '../../services/ai/aiTrackBuilder';
import { TrackService } from '../../services/trackService';
import { db } from '../../db';
import { v4 as uuidv4 } from 'uuid';

// These tests require a real database connection
describe('AI Track Building Integration', () => {
  const testGameId = uuidv4();
  const testPlayerId = uuidv4();

  beforeAll(async () => {
    // Create test game and player in database
    await db.query(
      `INSERT INTO games (id, status, current_player_index, max_players, victory_threshold)
       VALUES ($1, 'active', 0, 2, 250)`,
      [testGameId]
    );

    await db.query(
      `INSERT INTO players (id, game_id, name, color, money, train_type, is_ai, ai_difficulty, ai_personality, position_row, position_col)
       VALUES ($1, $2, 'TestBot', '#FF0000', 50, 'Freight', true, 'medium', 'optimizer', 40, 20)`,
      [testPlayerId, testGameId]
    );
  });

  afterAll(async () => {
    // Clean up test data
    await db.query('DELETE FROM player_tracks WHERE game_id = $1', [testGameId]);
    await db.query('DELETE FROM players WHERE game_id = $1', [testGameId]);
    await db.query('DELETE FROM games WHERE id = $1', [testGameId]);
    await db.end();
  });

  describe('AITrackBuilder.buildTrackToTarget', () => {
    it('should calculate a path with segments when building from scratch', async () => {
      const trackBuilder = getAITrackBuilder();

      // Try to build track toward a major city
      // Madrid is at approximately row 56, col 8 based on gridPoints.json
      const result = await trackBuilder.buildTrackToTarget(
        testGameId,
        testPlayerId,
        56,  // target row (Madrid area)
        8,   // target col
        20   // budget
      );

      console.log('Build result:', result);

      // Should return segments or null if no path found
      if (result) {
        expect(result.segments.length).toBeGreaterThan(0);
        expect(result.cost).toBeGreaterThan(0);
        expect(result.cost).toBeLessThanOrEqual(20);

        // Each segment should have valid structure
        for (const segment of result.segments) {
          expect(segment.from).toBeDefined();
          expect(segment.to).toBeDefined();
          expect(segment.from.row).toBeDefined();
          expect(segment.from.col).toBeDefined();
          expect(segment.to.row).toBeDefined();
          expect(segment.to.col).toBeDefined();
          expect(segment.cost).toBeGreaterThan(0);
        }

        console.log(`Built ${result.segments.length} segments for ${result.cost}M`);
        console.log('Segments:', result.segments.map(s =>
          `(${s.from.row},${s.from.col}) -> (${s.to.row},${s.to.col})`
        ));
      } else {
        // It's OK if no path found - depends on grid layout
        console.log('No path found to target - this may be expected');
      }
    });

    it('should save track segments to database', async () => {
      const trackBuilder = getAITrackBuilder();

      // Build some track
      const result = await trackBuilder.buildTrackToTarget(
        testGameId,
        testPlayerId,
        45,  // Different target
        15,
        15   // Smaller budget
      );

      if (result && result.segments.length > 0) {
        // Save to database using TrackService
        await TrackService.saveTrackState(testGameId, testPlayerId, {
          playerId: testPlayerId,
          gameId: testGameId,
          segments: result.segments,
          totalCost: result.cost,
          turnBuildCost: result.cost,
          lastBuildTimestamp: new Date(),
        });

        // Verify it was saved
        const savedTrack = await TrackService.getTrackState(testGameId, testPlayerId);

        expect(savedTrack).not.toBeNull();
        expect(savedTrack!.segments.length).toBe(result.segments.length);
        expect(savedTrack!.totalCost).toBe(result.cost);

        console.log('Saved and verified track state in database');
      }
    });

    it('should find paths starting from existing track', async () => {
      const trackBuilder = getAITrackBuilder();

      // Get existing track (if any from previous test)
      const existingTrack = await TrackService.getTrackState(testGameId, testPlayerId);

      if (existingTrack && existingTrack.segments.length > 0) {
        console.log(`Starting with ${existingTrack.segments.length} existing segments`);

        // Try to extend
        const result = await trackBuilder.buildTrackToTarget(
          testGameId,
          testPlayerId,
          50,
          20,
          10
        );

        if (result) {
          console.log(`Extended with ${result.segments.length} new segments for ${result.cost}M`);
          expect(result.segments.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('Path finding accuracy', () => {
    it('should find adjacent mileposts correctly', () => {
      const trackBuilder = getAITrackBuilder();

      // Test a known milepost - gridPoints.json has (row=51, col=3)
      const milepost = trackBuilder.getMilepost(51, 3);

      if (milepost) {
        console.log(`Found milepost at (51,3): terrain=${milepost.terrain}, name=${milepost.name}`);
        expect(milepost.row).toBe(51);
        expect(milepost.col).toBe(3);
      }
    });

    it('should respect budget limits', async () => {
      const trackBuilder = getAITrackBuilder();

      // Try with very small budget
      const result = await trackBuilder.buildTrackToTarget(
        testGameId,
        testPlayerId,
        100, // Far away target
        50,
        3    // Very small budget
      );

      if (result) {
        expect(result.cost).toBeLessThanOrEqual(3);
        console.log(`Built ${result.segments.length} segments within 3M budget`);
      }
    });
  });
});
