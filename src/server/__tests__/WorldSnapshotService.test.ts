import { capture } from '../services/ai/WorldSnapshotService';

// Mock the database module
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

import { db } from '../db/index';
const mockQuery = db.query as jest.Mock;

describe('WorldSnapshotService.capture', () => {
  const GAME_ID = '00000000-0000-0000-0000-000000000001';
  const BOT_ID = '00000000-0000-0000-0000-000000000010';
  const HUMAN_ID = '00000000-0000-0000-0000-000000000020';

  const baseBotRow = {
    game_status: 'active',
    player_id: BOT_ID,
    money: 35,
    position_row: 29,
    position_col: 32,
    train_type: 'Freight',
    hand: [1, 5, 12],
    loads: ['coal'],
    is_bot: true,
    bot_config: { skillLevel: 'medium', archetype: 'balanced', name: 'TestBot' },
    current_turn_number: 3,
    segments: [
      {
        from: { x: 100, y: 200, row: 29, col: 32, terrain: 2 },
        to: { x: 150, y: 200, row: 29, col: 31, terrain: 0 },
        cost: 1,
      },
    ],
  };

  const baseHumanRow = {
    game_status: 'active',
    player_id: HUMAN_ID,
    money: 50,
    position_row: 10,
    position_col: 15,
    train_type: 'FastFreight',
    hand: [2, 8, 20],
    loads: [],
    is_bot: false,
    bot_config: null,
    current_turn_number: 3,
    segments: [],
  };

  afterEach(() => jest.clearAllMocks());

  it('should return a complete WorldSnapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseBotRow, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.gameId).toBe(GAME_ID);
    expect(snapshot.gameStatus).toBe('active');
    expect(snapshot.turnNumber).toBe(3);
    expect(snapshot.bot.playerId).toBe(BOT_ID);
    expect(snapshot.bot.money).toBe(35);
    expect(snapshot.bot.position).toEqual({ row: 29, col: 32 });
    expect(snapshot.bot.existingSegments).toHaveLength(1);
    expect(snapshot.bot.demandCards).toEqual([1, 5, 12]);
    expect(snapshot.bot.trainType).toBe('Freight');
    expect(snapshot.bot.loads).toEqual(['coal']);
  });

  it('should populate bot config correctly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseBotRow, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.botConfig).toEqual({
      skillLevel: 'medium',
      archetype: 'balanced',
      name: 'TestBot',
    });
  });

  it('should include allPlayerTracks for all players', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseBotRow, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.allPlayerTracks).toHaveLength(2);
    expect(snapshot.allPlayerTracks[0].playerId).toBe(BOT_ID);
    expect(snapshot.allPlayerTracks[0].segments).toHaveLength(1);
    expect(snapshot.allPlayerTracks[1].playerId).toBe(HUMAN_ID);
    expect(snapshot.allPlayerTracks[1].segments).toEqual([]);
  });

  it('should handle null position gracefully', async () => {
    const noPositionBot = { ...baseBotRow, position_row: null, position_col: null };
    mockQuery.mockResolvedValueOnce({ rows: [noPositionBot, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.position).toBeNull();
  });

  it('should handle null bot_config', async () => {
    const noBotConfig = { ...baseBotRow, bot_config: null };
    mockQuery.mockResolvedValueOnce({ rows: [noBotConfig, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.botConfig).toBeNull();
  });

  it('should parse string bot_config (JSONB as string)', async () => {
    const stringConfig = {
      ...baseBotRow,
      bot_config: JSON.stringify({ skillLevel: 'hard', archetype: 'aggressive' }),
    };
    mockQuery.mockResolvedValueOnce({ rows: [stringConfig, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.botConfig).toEqual({
      skillLevel: 'hard',
      archetype: 'aggressive',
      name: undefined,
    });
  });

  it('should parse string segments (JSONB as string)', async () => {
    const stringSegments = {
      ...baseBotRow,
      segments: JSON.stringify(baseBotRow.segments),
    };
    mockQuery.mockResolvedValueOnce({ rows: [stringSegments, baseHumanRow] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.existingSegments).toHaveLength(1);
  });

  it('should throw when game not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(capture(GAME_ID, BOT_ID)).rejects.toThrow('No game found');
  });

  it('should throw when bot player not found in game', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseHumanRow] });

    await expect(capture(GAME_ID, BOT_ID)).rejects.toThrow('Bot player');
  });

  it('should use parameterized query for gameId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseBotRow] });

    await capture(GAME_ID, BOT_ID);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([GAME_ID]);
    expect(sql).toContain('$1');
  });

  it('should default money to 50 when null', async () => {
    const nullMoney = { ...baseBotRow, money: null };
    mockQuery.mockResolvedValueOnce({ rows: [nullMoney] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.money).toBe(50);
  });

  it('should default hand to empty array when null', async () => {
    const nullHand = { ...baseBotRow, hand: null };
    mockQuery.mockResolvedValueOnce({ rows: [nullHand] });

    const snapshot = await capture(GAME_ID, BOT_ID);

    expect(snapshot.bot.demandCards).toEqual([]);
  });
});
