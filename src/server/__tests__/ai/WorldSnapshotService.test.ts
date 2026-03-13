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

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCityCount: jest.fn(() => 0),
}));

jest.mock('../../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn(() => ({
      getCard: jest.fn(() => undefined),
    })),
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
import { loadGridPoints } from '../../services/ai/MapTopology';

const mockQuery = db.query as jest.Mock;
const mockLoadGridPoints = loadGridPoints as jest.Mock;

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
});
