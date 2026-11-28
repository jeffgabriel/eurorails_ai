/**
 * WorldSnapshotService — ferryHalfSpeed flag tests (TEST-004)
 *
 * JIRA-108: Restored terrain-based ferry detection in capture().
 * When bot is at a FerryPort milepost, ferryHalfSpeed = true (half speed this turn).
 */

import { TerrainType } from '../../../shared/types/GameTypes';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: { query: jest.fn() },
}));

jest.mock('../../services/MapTopology', () => ({
  ...jest.requireActual<typeof import('../../services/MapTopology')>('../../services/MapTopology'),
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  ...jest.requireActual<typeof import('../../../shared/services/majorCityGroups')>('../../../shared/services/majorCityGroups'),
  getMajorCityGroups: jest.fn(() => []),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  ...jest.requireActual<typeof import('../../services/ai/connectedMajorCities')>('../../services/ai/connectedMajorCities'),
  getConnectedMajorCityCount: jest.fn(() => 0),
}));

jest.mock('../../services/demandDeckService', () => ({
  DemandDeckService: {
    getCard: jest.fn(() => undefined),
  },
}));

jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getAvailableLoadsForCity: jest.fn(() => []),
      getSourceCitiesForLoad: jest.fn(() => []),
    })),
  },
}));

import { capture } from '../../services/ai/WorldSnapshotService';
import { db } from '../../db/index';
import { loadGridPoints } from '../../services/MapTopology';
import { getFerryEdges } from '../../../shared/services/majorCityGroups';

const mockQuery = db.query as jest.Mock;
const mockLoadGridPoints = loadGridPoints as jest.Mock;
const mockGetFerryEdges = getFerryEdges as jest.Mock;

describe('WorldSnapshotService.capture — ferryHalfSpeed', () => {
  const GAME_ID = 'game-001';
  const BOT_ID = 'bot-001';

  const makeBotRow = (row: number | null, col: number | null) => ({
    game_status: 'active',
    player_id: BOT_ID,
    user_id: 'user-001',
    money: 50,
    position_row: row,
    position_col: col,
    train_type: 'Freight',
    hand: [],
    loads: [],
    is_bot: true,
    bot_config: { skillLevel: 'easy', name: 'TestBot' },
    current_turn_number: 5,
    segments: [],
  });

  afterEach(() => jest.clearAllMocks());

  beforeEach(() => {
    // ActiveEffectManager.getActiveEffects (added by JIRA-256) makes a second
    // db.query for `active_event_effects`. Default to empty rows so per-test
    // mockResolvedValueOnce for the bot row is consumed first.
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('should set ferryHalfSpeed=true when bot is at a FerryPort (JIRA-108)', async () => {
    const botRow = makeBotRow(10, 20);
    mockQuery.mockResolvedValueOnce({ rows: [botRow] });

    const grid = new Map();
    grid.set('10,20', { row: 10, col: 20, terrain: TerrainType.FerryPort, name: 'Dover' });
    mockLoadGridPoints.mockReturnValue(grid);

    const snapshot = await capture(GAME_ID, BOT_ID);
    expect(snapshot.bot.ferryHalfSpeed).toBe(true);
  });

  it('should set ferryHalfSpeed=false when bot is at Clear terrain', async () => {
    const botRow = makeBotRow(10, 20);
    mockQuery.mockResolvedValueOnce({ rows: [botRow] });

    const grid = new Map();
    grid.set('10,20', { row: 10, col: 20, terrain: TerrainType.Clear });
    mockLoadGridPoints.mockReturnValue(grid);

    const snapshot = await capture(GAME_ID, BOT_ID);
    expect(snapshot.bot.ferryHalfSpeed).toBe(false);
  });

  it('should set ferryHalfSpeed=false when bot has no position', async () => {
    const botRow = makeBotRow(null, null);
    mockQuery.mockResolvedValueOnce({ rows: [botRow] });

    mockLoadGridPoints.mockReturnValue(new Map());

    const snapshot = await capture(GAME_ID, BOT_ID);
    expect(snapshot.bot.ferryHalfSpeed).toBe(false);
  });

  it('should set ferryHalfSpeed=true on a ferry line end with city terrain (Dublin, Belfast) (#314)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeBotRow(10, 20)] });
    const grid = new Map();
    grid.set('10,20', { row: 10, col: 20, terrain: TerrainType.SmallCity, name: 'Dublin' });
    mockLoadGridPoints.mockReturnValue(grid);
    mockGetFerryEdges.mockReturnValue([
      { name: 'Dublin_Liverpool', pointA: { row: 10, col: 20 }, pointB: { row: 10, col: 25 }, cost: 8 },
    ]);

    const snapshot = await capture(GAME_ID, BOT_ID);
    mockGetFerryEdges.mockReturnValue([]);

    expect(snapshot.bot.ferryHalfSpeed).toBe(true);
  });

  it('should report the moves recorded this turn and the direction the bot may not reverse (#314)', async () => {
    const arrival = { from: { row: 10, col: 17 }, to: { row: 10, col: 20 }, arrivedFrom: { row: 10, col: 19 } };
    const grid = new Map();
    grid.set('10,20', { row: 10, col: 20, terrain: TerrainType.Clear });
    mockLoadGridPoints.mockReturnValue(grid);

    // moved last turn, not yet this turn
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...makeBotRow(10, 20), movement_this_turn: null, movement_previous_turn: [arrival] }],
    });
    const before = await capture(GAME_ID, BOT_ID);
    expect(before.bot.movedThisTurn).toBe(false);
    expect(before.bot.reversalBlockedTo).toEqual({ row: 10, col: 19 });

    // moved this turn
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...makeBotRow(10, 20), movement_this_turn: [arrival], movement_previous_turn: null }],
    });
    const during = await capture(GAME_ID, BOT_ID);
    expect(during.bot.movedThisTurn).toBe(true);
    expect(during.bot.reversalBlockedTo).toEqual({ row: 10, col: 19 });

    // stood still for a whole turn
    mockQuery.mockResolvedValueOnce({ rows: [makeBotRow(10, 20)] });
    const rested = await capture(GAME_ID, BOT_ID);
    expect(rested.bot.movedThisTurn).toBe(false);
    expect(rested.bot.reversalBlockedTo).toBeNull();
  });
});
