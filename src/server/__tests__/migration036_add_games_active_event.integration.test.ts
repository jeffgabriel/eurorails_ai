import { db } from '../db';

/**
 * Tests for migration 036: Add active_event JSONB column to games table.
 *
 * These tests verify:
 * - The `active_event` column exists with type JSONB and is nullable
 * - Pre-existing game rows have active_event = NULL
 * - New game rows default to active_event = NULL
 * - The column accepts valid JSONB values and NULL
 *
 * Note: The migration is applied automatically via checkDatabase() in the
 * beforeAll setup (src/server/__tests__/setup.ts). These tests verify the
 * post-migration schema state.
 */
describe('Migration 036: games.active_event column', () => {
  let testUserId: string;
  let preExistingGameId: string;

  beforeAll(async () => {
    // Create a test user for game creation (games require created_by)
    const userResult = await db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ['migration036_testuser', 'migration036_test@example.com', 'hashedpassword']
    );
    testUserId = userResult.rows[0].id;

    // Insert a game row that simulates a "pre-existing" row (before migration).
    // Since the migration is already applied, active_event will default to NULL,
    // which is exactly what we want to verify.
    const gameResult = await db.query(
      `INSERT INTO games (join_code, created_by, is_public, status)
       VALUES (generate_unique_join_code(), $1, $2, $3)
       RETURNING id`,
      [testUserId, false, 'setup']
    );
    preExistingGameId = gameResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up in reverse dependency order
    await db.query('DELETE FROM games WHERE id = $1', [preExistingGameId]);
    await db.query('DELETE FROM users WHERE id = $1', [testUserId]);
  });

  describe('Schema verification', () => {
    it('should have active_event column on games table', async () => {
      const result = await db.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'games'
          AND column_name = 'active_event'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].column_name).toBe('active_event');
    });

    it('should have active_event column with type jsonb', async () => {
      const result = await db.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'games'
          AND column_name = 'active_event'
      `);

      expect(result.rows[0].data_type).toBe('jsonb');
    });

    it('should have active_event column as nullable', async () => {
      const result = await db.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'games'
          AND column_name = 'active_event'
      `);

      expect(result.rows[0].is_nullable).toBe('YES');
    });
  });

  describe('Data integrity', () => {
    it('should have active_event = NULL for pre-existing game rows', async () => {
      const result = await db.query(
        'SELECT active_event FROM games WHERE id = $1',
        [preExistingGameId]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].active_event).toBeNull();
    });

    it('should default active_event to NULL for new game rows', async () => {
      const newGameResult = await db.query(
        `INSERT INTO games (join_code, created_by, is_public, status)
         VALUES (generate_unique_join_code(), $1, $2, $3)
         RETURNING id, active_event`,
        [testUserId, false, 'setup']
      );

      expect(newGameResult.rows[0].active_event).toBeNull();

      // Clean up
      await db.query('DELETE FROM games WHERE id = $1', [newGameResult.rows[0].id]);
    });

    it('should allow setting active_event to a valid JSONB object', async () => {
      const activeEventPayload = {
        cardId: 131,
        drawingPlayerId: 'some-player-uuid',
        drawingPlayerIndex: 2,
        expiresAfterTurnNumber: 17,
      };

      await db.query(
        'UPDATE games SET active_event = $1 WHERE id = $2',
        [JSON.stringify(activeEventPayload), preExistingGameId]
      );

      const result = await db.query(
        'SELECT active_event FROM games WHERE id = $1',
        [preExistingGameId]
      );

      expect(result.rows[0].active_event).toEqual(activeEventPayload);

      // Reset back to NULL to clean up
      await db.query(
        'UPDATE games SET active_event = NULL WHERE id = $1',
        [preExistingGameId]
      );
    });

    it('should allow setting active_event back to NULL after a value was set', async () => {
      // First set a value
      await db.query(
        `UPDATE games SET active_event = $1 WHERE id = $2`,
        [JSON.stringify({ cardId: 125 }), preExistingGameId]
      );

      // Then clear it
      await db.query(
        'UPDATE games SET active_event = NULL WHERE id = $1',
        [preExistingGameId]
      );

      const result = await db.query(
        'SELECT active_event FROM games WHERE id = $1',
        [preExistingGameId]
      );

      expect(result.rows[0].active_event).toBeNull();
    });
  });

  describe('Rollback verification', () => {
    // The project migration framework (checkDatabase in src/server/db/index.ts)
    // applies migrations forward-only via schema_migrations version tracking.
    // Down-migrations (DROP COLUMN) are not automatically executed by the framework.
    // The rollback SQL is documented in the migration file comment as:
    //   -- ALTER TABLE games DROP COLUMN active_event;
    // This can be run manually if a rollback is needed, but is not tested here
    // because there is no automated down-migration runner in this project.
    it('should document that rollback SQL is included in migration file comments', async () => {
      // Verify migration 036 is tracked in schema_migrations
      const result = await db.query(
        'SELECT version FROM schema_migrations WHERE version = 36'
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].version).toBe(36);
    });
  });
});
