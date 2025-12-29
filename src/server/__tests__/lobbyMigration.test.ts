import { db } from '../db';

describe('Lobby Migration (Phase 1)', () => {
  let testGameId: string;
  let testPlayerId: string;
  let testUserId: string;

  beforeAll(async () => {
    // Create a test user first
    const userResult = await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      ['testuser', 'test@example.com', 'hashedpassword']
    );
    testUserId = userResult.rows[0].id;

    // Create a test player
    const playerResult = await db.query(
      'INSERT INTO players (name, color, user_id) VALUES ($1, $2, $3) RETURNING id',
      ['Test Player', '#FF0000', testUserId]
    );
    testPlayerId = playerResult.rows[0].id;

    // Create a test game
    const gameResult = await db.query(
      'INSERT INTO games (join_code, created_by, is_public, status) VALUES (generate_unique_join_code(), $1, $2, $3) RETURNING id, join_code',
      [testUserId, true, 'setup']
    );
    testGameId = gameResult.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await db.query('DELETE FROM turn_actions WHERE game_id = $1', [testGameId]);
    await db.query('DELETE FROM games WHERE id = $1', [testGameId]);
    await db.query('DELETE FROM players WHERE id = $1', [testPlayerId]);
    // Clean up test user (this will cascade delete the player due to foreign key)
    await db.query('DELETE FROM users WHERE username = $1', ['testuser']);
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
      expect(result.rows[0].created_by).toBe(testUserId);
    });

    it('should have is_public field', async () => {
      const result = await db.query(
        'SELECT is_public FROM games WHERE id = $1',
        [testGameId]
      );
      expect(result.rows[0].is_public).toBe(true);
    });

    it('should use games.status as lifecycle source of truth', async () => {
      const result = await db.query(
        'SELECT status FROM games WHERE id = $1',
        [testGameId]
      );
      expect(result.rows[0].status).toBe('setup');
    });
  });

  describe('Players table new fields', () => {
    it('should have user_id field', async () => {
      const result = await db.query(
        'SELECT user_id FROM players WHERE id = $1',
        [testPlayerId]
      );
      expect(result.rows[0].user_id).toBe(testUserId); // Should reference the user
    });

    it('should have is_online field', async () => {
      const result = await db.query(
        'SELECT is_online FROM players WHERE id = $1',
        [testPlayerId]
      );
      expect(result.rows[0].is_online).toBe(true); // Should be true by default
    });

    it('should have is_deleted field', async () => {
      const result = await db.query(
        'SELECT is_deleted FROM players WHERE id = $1',
        [testPlayerId]
      );
      expect(result.rows[0].is_deleted).toBe(false); // Should be false by default
    });

    it('should have last_seen_at field', async () => {
      const result = await db.query(
        'SELECT last_seen_at FROM players WHERE id = $1',
        [testPlayerId]
      );
      expect(result.rows[0].last_seen_at).toBeDefined();
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
      
      const actualIndexes = result.rows.map(row => row.indexname);
      const expectedIndexes = [
        'idx_games_created_by',
        'idx_games_is_public',
        'idx_games_join_code',
        'idx_games_status'
      ];

      expectedIndexes.forEach(idx => {
        expect(actualIndexes).toContain(idx);
      });
    });

    it('should have players table indexes', async () => {
      const result = await db.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'players' 
        AND indexname LIKE 'idx_players_%'
        ORDER BY indexname
      `);
      
      // Expected indexes from lobby migration (migration 011)
      const expectedLobbyIndexes = [
        'idx_players_is_online',
        'idx_players_user_id',
        'idx_players_last_seen_at',
        'idx_players_user_game_visible'
      ];
      
      const actualIndexes = result.rows.map(row => row.indexname);
      
      // Verify that all expected lobby migration indexes exist
      // (additional indexes from later migrations like idx_players_game_id_created_at may also exist)
      expectedLobbyIndexes.forEach(expectedIndex => {
        expect(actualIndexes).toContain(expectedIndex);
      });
    });
  });

  describe('Constraints', () => {
    it('should enforce games.status check constraint', async () => {
      await expect(
        db.query(
          'UPDATE games SET status = $1 WHERE id = $2',
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
          'INSERT INTO games (join_code, is_public, status) VALUES ($1, $2, $3)',
          [existingCode, false, 'setup']
        )
      ).rejects.toThrow();
    });
  });

  describe('End-to-end functionality', () => {
    it('should allow creating a game with all new fields', async () => {
      const newUserResult = await db.query(
        'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['Another User', 'another@example.com', 'hashedpassword']
      );
      const newUserId = newUserResult.rows[0].id;

      const newGameResult = await db.query(
        'INSERT INTO games (join_code, created_by, is_public, status) VALUES (generate_unique_join_code(), $1, $2, $3) RETURNING *',
        [newUserId, false, 'setup']
      );

      expect(newGameResult.rows[0].join_code).toBeDefined();
      expect(newGameResult.rows[0].created_by).toBe(newUserId);
      expect(newGameResult.rows[0].is_public).toBe(false);
      expect(newGameResult.rows[0].status).toBe('setup');

      // Clean up
      await db.query('DELETE FROM games WHERE id = $1', [newGameResult.rows[0].id]);
      await db.query('DELETE FROM users WHERE id = $1', [newUserId]);
    });
  });
});
