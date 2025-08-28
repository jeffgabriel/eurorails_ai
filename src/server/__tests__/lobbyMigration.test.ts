import { db } from '../db';

describe('Lobby Migration (Phase 1)', () => {
  let testGameId: string;
  let testPlayerId: string;

  beforeAll(async () => {
    // Create a test player first
    const playerResult = await db.query(
      'INSERT INTO players (name, color) VALUES ($1, $2) RETURNING id',
      ['Test Player', '#FF0000']
    );
    testPlayerId = playerResult.rows[0].id;

    // Create a test game
    const gameResult = await db.query(
      'INSERT INTO games (join_code, created_by, is_public, lobby_status) VALUES (generate_unique_join_code(), $1, $2, $3) RETURNING id, join_code',
      [testPlayerId, true, 'IN_SETUP']
    );
    testGameId = gameResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await db.query('DELETE FROM games WHERE id = $1', [testGameId]);
    await db.query('DELETE FROM players WHERE id = $1', [testPlayerId]);
  });

  describe('Games table new fields', () => {
    it('should have join_code field', async () => {
      const result = await db.query(
        'SELECT join_code FROM games WHERE id = $1',
        [testGameId]
      );
      expect(result.rows[0].join_code).toBeDefined();
      expect(result.rows[0].join_code).toHaveLength(8);
    });

    it('should have created_by field', async () => {
      const result = await db.query(
        'SELECT created_by FROM games WHERE id = $1',
        [testGameId]
      );
      expect(result.rows[0].created_by).toBe(testPlayerId);
    });

    it('should have is_public field', async () => {
      const result = await db.query(
        'SELECT is_public FROM games WHERE id = $1',
        [testGameId]
      );
      expect(result.rows[0].is_public).toBe(true);
    });

    it('should have lobby_status field', async () => {
      const result = await db.query(
        'SELECT lobby_status FROM games WHERE id = $1',
        [testGameId]
      );
      expect(result.rows[0].lobby_status).toBe('IN_SETUP');
    });
  });

  describe('Players table new fields', () => {
    it('should have user_id field', async () => {
      const result = await db.query(
        'SELECT user_id FROM players WHERE id = $1',
        [testPlayerId]
      );
      expect(result.rows[0].user_id).toBeNull(); // Should be null by default
    });

    it('should have is_online field', async () => {
      const result = await db.query(
        'SELECT is_online FROM players WHERE id = $1',
        [testPlayerId]
      );
      expect(result.rows[0].is_online).toBe(true); // Should be true by default
    });
  });

  describe('generate_unique_join_code function', () => {
    it('should generate unique join codes', async () => {
      const codes = new Set<string>();
      
      // Generate multiple codes to ensure uniqueness
      for (let i = 0; i < 5; i++) {
        const result = await db.query('SELECT generate_unique_join_code() as code');
        const code = result.rows[0].code;
        
        expect(code).toHaveLength(8);
        expect(codes.has(code)).toBe(false);
        codes.add(code);
      }
    });

    it('should generate alphanumeric codes', async () => {
      const result = await db.query('SELECT generate_unique_join_code() as code');
      const code = result.rows[0].code;
      
      expect(code).toMatch(/^[A-F0-9]{8}$/);
    });
  });

  describe('Indexes', () => {
    it('should have games table indexes', async () => {
      const result = await db.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'games' 
        AND indexname LIKE 'idx_games_%'
        ORDER BY indexname
      `);
      
      const expectedIndexes = [
        'idx_games_created_by',
        'idx_games_is_public', 
        'idx_games_join_code',
        'idx_games_lobby_status',
        'idx_games_status'
      ];
      
      expect(result.rows.map(row => row.indexname)).toEqual(expectedIndexes);
    });

    it('should have players table indexes', async () => {
      const result = await db.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'players' 
        AND indexname LIKE 'idx_players_%'
        ORDER BY indexname
      `);
      
      const expectedIndexes = [
        'idx_players_is_online',
        'idx_players_user_id'
      ];
      
      expect(result.rows.map(row => row.indexname)).toEqual(expectedIndexes);
    });
  });

  describe('Constraints', () => {
    it('should enforce lobby_status check constraint', async () => {
      // This should fail
      await expect(
        db.query(
          'UPDATE games SET lobby_status = $1 WHERE id = $2',
          ['INVALID_STATUS', testGameId]
        )
      ).rejects.toThrow();
    });

    it('should enforce unique join_code constraint', async () => {
      // Get the existing join code
      const existingResult = await db.query(
        'SELECT join_code FROM games WHERE id = $1',
        [testGameId]
      );
      const existingCode = existingResult.rows[0].join_code;

      // Try to create another game with the same join code
      await expect(
        db.query(
          'INSERT INTO games (join_code, is_public, lobby_status) VALUES ($1, $2, $3)',
          [existingCode, false, 'IN_SETUP']
        )
      ).rejects.toThrow();
    });
  });

  describe('End-to-end functionality', () => {
    it('should allow creating a game with all new fields', async () => {
      const newPlayerResult = await db.query(
        'INSERT INTO players (name, color) VALUES ($1, $2) RETURNING id',
        ['Another Player', '#00FF00']
      );
      const newPlayerId = newPlayerResult.rows[0].id;

      const newGameResult = await db.query(
        'INSERT INTO games (join_code, created_by, is_public, lobby_status) VALUES (generate_unique_join_code(), $1, $2, $3) RETURNING *',
        [newPlayerId, false, 'IN_SETUP']
      );

      expect(newGameResult.rows[0].join_code).toBeDefined();
      expect(newGameResult.rows[0].created_by).toBe(newPlayerId);
      expect(newGameResult.rows[0].is_public).toBe(false);
      expect(newGameResult.rows[0].lobby_status).toBe('IN_SETUP');

      // Clean up
      await db.query('DELETE FROM games WHERE id = $1', [newGameResult.rows[0].id]);
      await db.query('DELETE FROM players WHERE id = $1', [newPlayerId]);
    });
  });
});
