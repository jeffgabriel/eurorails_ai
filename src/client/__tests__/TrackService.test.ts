import { TrackService } from '../services/TrackService';

// Mock global fetch
const globalAny: any = global;

describe('TrackService', () => {
  let trackService: TrackService;
  beforeEach(() => {
    trackService = new TrackService();
    globalAny.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
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
      globalAny.fetch.mockResolvedValue({
        ok: false,
        status: 500,
      });
      await expect(trackService.loadAllTracks(gameId)).rejects.toThrow('Failed to load tracks: HTTP 500');
    });

    it('throws on network error', async () => {
      globalAny.fetch.mockRejectedValue(new Error('Network error'));
      await expect(trackService.loadAllTracks(gameId)).rejects.toThrow('Network error');
    });
  });
}); 