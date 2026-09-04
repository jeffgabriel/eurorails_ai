import { db } from '../db';
import { TrackService } from '../services/trackService';
import { VictoryService } from '../services/victoryService';
import { cleanupGameState } from '../services/gameCleanupService';
import { WinConditionsService, UnmetWinCondition } from '../services/winConditionsService';
import { victoryCities, victoryTrack } from './fixtures/victoryFixtures';
import type { TrackSegment } from '../../shared/types/TrackTypes';

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../services/trackService');
jest.mock('../services/gameCleanupService', () => ({
  cleanupGameState: jest.fn().mockResolvedValue(undefined),
}));

const query = jest.mocked(db.query);
const tracks = jest.mocked(TrackService.getTrackState);

function player(id: string, money: number, debt: number = 0): object {
  return { id, name: id, money, debt_owed: debt, net_worth: money - debt };
}

function setTrack(playerId: string, segments: TrackSegment[]): void {
  trackByPlayer.set(playerId, segments);
}

const trackByPlayer = new Map<string, TrackSegment[]>();

beforeEach(() => {
  jest.resetAllMocks();
  trackByPlayer.clear();
  query.mockResolvedValue({ rows: [], command: '', rowCount: 0, oid: 0, fields: [] });
  tracks.mockImplementation(async (gameId, playerId) => {
    const segments = trackByPlayer.get(playerId);
    return segments ? {
      gameId, playerId, segments, totalCost: 0, turnBuildCost: 0, lastBuildTimestamp: new Date(),
    } : null;
  });
});

function resolveRows(players: object[], threshold: number = 250): void {
  query.mockResolvedValueOnce({ rows: players, command: '', rowCount: players.length, oid: 0, fields: [] });
  query.mockResolvedValueOnce({ rows: [{ victory_threshold: threshold }], command: '', rowCount: 1, oid: 0, fields: [] });
}

function declarationRows(money: number = 250, debt: number = 0): void {
  query.mockResolvedValueOnce({
    rows: [{ victory_triggered: false, victory_threshold: 250, player_count: '2' }],
    command: '', rowCount: 1, oid: 0, fields: [],
  });
  query.mockResolvedValueOnce({
    rows: [{ ...player('p1', money, debt), player_index: 0 }],
    command: '', rowCount: 1, oid: 0, fields: [],
  });
}

describe('WinConditionsService', () => {
  it('requires both seven connected cities and the exact net-worth threshold', () => {
    expect(WinConditionsService.evaluate(270, 20, victoryTrack(), 250)).toMatchObject({
      eligible: true, netWorth: 250, connectedCities: expect.arrayContaining(victoryCities),
    });
    expect(WinConditionsService.evaluate(269, 20, victoryTrack(), 250)).toMatchObject({
      eligible: false, netWorth: 249, unmetCondition: UnmetWinCondition.InsufficientFunds,
    });
    expect(WinConditionsService.evaluate(500, 0, [], 250)).toMatchObject({
      eligible: false, connectedCities: [], unmetCondition: UnmetWinCondition.InsufficientCities,
    });
    expect(WinConditionsService.evaluate(299, 0, victoryTrack(), 300).eligible).toBe(false);
  });

  it('does not sum cities across disconnected components', () => {
    const segments = [...victoryTrack(victoryCities.slice(0, 4)), ...victoryTrack(victoryCities.slice(4))];
    const result = WinConditionsService.evaluate(500, 0, segments, 250);
    expect(result.eligible).toBe(false);
    expect(result.connectedCities).toHaveLength(4);
  });
});

describe('authoritative victory declaration', () => {
  it('accepts persisted eligibility even with no client claims', async () => {
    declarationRows(270, 20);
    setTrack('p1', victoryTrack());
    expect(await VictoryService.declareVictory('game', 'p1', [])).toMatchObject({
      success: true, victoryState: { triggered: true },
    });
  });

  it.each(['missing', 'empty', 'two-cities', 'disconnected'])(
    'rejects fabricated claims when persisted track is %s without triggering a final round',
    async (scenario) => {
      declarationRows(423);
      if (scenario === 'empty') setTrack('p1', []);
      if (scenario === 'two-cities') setTrack('p1', victoryTrack(victoryCities.slice(0, 2)));
      if (scenario === 'disconnected') {
        setTrack('p1', [...victoryTrack(victoryCities.slice(0, 4)), ...victoryTrack(victoryCities.slice(4))]);
      }
      const claims = victoryCities.map((city, index) => ({ ...city, name: `Invented ${index}` }));
      expect(await VictoryService.declareVictory('game', 'p1', claims)).toMatchObject({ success: false });
      expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE games'))).toBe(false);
    },
  );

  it('rejects debt reducing net worth below the threshold', async () => {
    declarationRows(260, 20);
    setTrack('p1', victoryTrack());
    expect(await VictoryService.declareVictory('game', 'p1', victoryCities)).toMatchObject({
      success: false, error: expect.stringContaining('240M'),
    });
  });
});

describe('issue 191 resolution', () => {
  it('awards 252M with seven cities over 423M with two cities', async () => {
    resolveRows([player('test5', 423), player('test6', 252)]);
    setTrack('test5', victoryTrack([victoryCities[0], victoryCities[5]]));
    setTrack('test6', victoryTrack());
    expect(await VictoryService.resolveVictory('game')).toMatchObject({
      gameOver: true, winnerId: 'test6',
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'completed'"), ['game', 'test6'],
    );
    expect(cleanupGameState).toHaveBeenCalledWith('game');
  });

  it('excludes an ineligible player from a monetary tie', async () => {
    resolveRows([player('p1', 260), player('p2', 260)]);
    setTrack('p2', victoryTrack());
    expect(await VictoryService.resolveVictory('game')).toMatchObject({ gameOver: true, winnerId: 'p2' });
  });

  it('preserves tie extension among qualifying players', async () => {
    resolveRows([player('p1', 260), player('p2', 260)]);
    setTrack('p1', victoryTrack());
    setTrack('p2', victoryTrack());
    expect(await VictoryService.resolveVictory('game')).toMatchObject({
      gameOver: false, tieExtended: true, newThreshold: 300,
    });
    expect(cleanupGameState).not.toHaveBeenCalled();
  });

  it.each([250, 300])('resets a round with no eligible players and preserves threshold %i', async (threshold) => {
    resolveRows([player('p1', 500), player('p2', 249)], threshold);
    expect(await VictoryService.resolveVictory('game')).toEqual({
      gameOver: false,
      victoryState: { triggered: false, triggerPlayerIndex: -1, finalTurnPlayerIndex: -1, victoryThreshold: threshold },
    });
    expect(tracks).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('victory_triggered = false'), ['game']);
    expect(cleanupGameState).not.toHaveBeenCalled();
  });

  it('aborts on a track read failure without choosing a partial winner or resetting', async () => {
    resolveRows([player('p1', 300), player('p2', 280)]);
    setTrack('p1', victoryTrack());
    tracks.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(VictoryService.resolveVictory('game')).rejects.toThrow('database unavailable');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE games'))).toBe(false);
    expect(cleanupGameState).not.toHaveBeenCalled();
  });
});
