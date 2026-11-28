import { TrackService } from '../services/TrackService';

// Mock global fetch
const globalAny: any = global;

describe('TrackService', () => {
  let trackService: TrackService;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    trackService = new TrackService();
    globalAny.fetch = jest.fn();
    // Store original console.error to restore it
    originalConsoleError = console.error;
  });

  afterEach(() => {
    jest.resetAllMocks();
    // Restore original console.error
    console.error = originalConsoleError;
  });

  describe('loadAllTracks', () => {
    const gameId = 'game-123';

    it('returns data when fetch is successful', async () => {
      const mockTracks = [{ playerId: 'p1', segments: [] }];
      globalAny.fetch.mockResolvedValue({
        ok: true,
        json: async () => mockTracks,
      });
      const result = await trackService.loadAllTracks(gameId);
      expect(result).toEqual(mockTracks);
    });

    it('throws on HTTP error', async () => {
      // Suppress console.error for this error test - the error logging is intentional
      // but we don't want it cluttering test output
      console.error = jest.fn();
      
      globalAny.fetch.mockResolvedValue({
        ok: false,
        status: 500,
      });
      await expect(trackService.loadAllTracks(gameId)).rejects.toThrow('Failed to load tracks: HTTP 500');
    });

    it('throws on network error', async () => {
      // Suppress console.error for this error test - the error logging is intentional
      // but we don't want it cluttering test output
      console.error = jest.fn();
      
      globalAny.fetch.mockRejectedValue(new Error('Network error'));
      await expect(trackService.loadAllTracks(gameId)).rejects.toThrow('Network error');
    });
  });

  describe('buildTrack', () => {
    const drawn = {
      from: { x: 10, y: 20, row: 24, col: 51, terrain: 2 },
      to: { x: 30, y: 40, row: 24, col: 50, terrain: 0 },
      cost: 99,
    };

    it('sends only the mileposts of the drawn sections and returns the server result', async () => {
      const built = [{ ...drawn, cost: 1 }];
      globalAny.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ segments: built, cost: 1, turnBuildCost: 4, money: 50 }),
      });

      const result = await trackService.buildTrack('game-123', [drawn]);

      expect(result).toEqual({ ok: true, segments: built, cost: 1, turnBuildCost: 4 });
      const [url, init] = globalAny.fetch.mock.calls[0];
      expect(url).toContain('/api/tracks/build');
      expect(JSON.parse(init.body)).toEqual({
        gameId: 'game-123',
        segments: [{ from: { row: 24, col: 51 }, to: { row: 24, col: 50 } }],
      });
    });

    it('returns the server\'s reason when the build is refused', async () => {
      globalAny.fetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Conflict', code: 'TurnBudgetExceeded', details: 'Build costs 21M' }),
      });

      expect(await trackService.buildTrack('game-123', [drawn])).toEqual({ ok: false, message: 'Build costs 21M' });
    });

    it('fails without throwing on a network error', async () => {
      console.error = jest.fn();
      globalAny.fetch.mockRejectedValue(new Error('Network error'));

      expect(await trackService.buildTrack('game-123', [drawn])).toEqual({
        ok: false,
        message: 'Track could not be built',
      });
    });
  });

  describe('undoLastSegment', () => {
    it('returns the removed section, turn spend and money from the server', async () => {
      const removedSegment = { from: { row: 24, col: 51 }, to: { row: 24, col: 50 }, cost: 1 };
      globalAny.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ removedSegment, refunded: 1, turnBuildCost: 0, money: 50 }),
      });

      const result = await trackService.undoLastSegment('game-123');

      expect(result).toEqual({ ok: true, removedSegment, turnBuildCost: 0, money: 50 });
      const [url, init] = globalAny.fetch.mock.calls[0];
      expect(url).toContain('/api/tracks/undo-segment');
      expect(JSON.parse(init.body)).toEqual({ gameId: 'game-123' });
    });

    it('returns the server\'s reason when the undo is refused', async () => {
      globalAny.fetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ code: 'NoSegmentToUndo', details: 'No track built this turn to undo' }),
      });

      expect(await trackService.undoLastSegment('game-123')).toEqual({
        ok: false,
        message: 'No track built this turn to undo',
      });
    });
  });
});
