import { GameStateService } from '../services/GameStateService';
import { authenticatedFetch } from '../services/authenticatedFetch';
import { FullGameState, Player } from '../../shared/types/GameTypes';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

jest.mock('../config/apiConfig', () => ({
  config: { apiBaseUrl: 'http://test' },
}));

function createPlayer(id: string): Player {
  return {
    id,
    name: id,
    color: '#ff0000',
    money: 50,
    trainState: {
      position: null,
      remainingMovement: 0,
      movementHistory: [],
      loads: [],
    },
    hand: [],
  } as unknown as Player;
}

function createGameState(): FullGameState {
  return {
    id: 'game-1',
    players: [createPlayer('p1'), createPlayer('p2')],
    currentPlayerIndex: 0,
    status: 'active',
    maxPlayers: 4,
  } as unknown as FullGameState;
}

describe('GameStateService.startPollingForTurnChanges (hardened watchdog polling)', () => {
  let service: GameStateService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    service = new GameStateService(createGameState());
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    service.stopPollingForTurnChanges();
    jest.useRealTimers();
    warnSpy.mockRestore();
  });

  it('uses authenticatedFetch (not raw fetch) for the game state URL', async () => {
    (authenticatedFetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ currentPlayerIndex: 0 }),
    });

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(authenticatedFetch).toHaveBeenCalledWith('http://test/api/game/game-1');
  });

  it('keeps polling and does not call stopPollingForTurnChanges when authenticatedFetch returns 401', async () => {
    (authenticatedFetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    });
    const stopSpy = jest.spyOn(service, 'stopPollingForTurnChanges');

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(stopSpy).not.toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps polling and does not stop when authenticatedFetch returns 403', async () => {
    (authenticatedFetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({}),
    });
    const stopSpy = jest.spyOn(service, 'stopPollingForTurnChanges');

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(stopSpy).not.toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it('logs a warn message when polling hits an auth failure', async () => {
    (authenticatedFetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    });

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
  });

  it('does not warn on a successful poll', async () => {
    (authenticatedFetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ currentPlayerIndex: 0 }),
    });

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('only stops polling when stopPollingForTurnChanges is called explicitly, surviving repeated auth failures', async () => {
    (authenticatedFetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    });

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(5000); // 5 ticks, all 401s

    expect(authenticatedFetch).toHaveBeenCalledTimes(5);

    service.stopPollingForTurnChanges();
    await jest.advanceTimersByTimeAsync(5000);

    // No further calls after the explicit stop.
    expect(authenticatedFetch).toHaveBeenCalledTimes(5);
  });

  it('notifies turn-change listeners once the server-authoritative index changes after a prior auth failure', async () => {
    (authenticatedFetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ currentPlayerIndex: 1 }) });

    const listener = jest.fn();
    service.onTurnChange(listener);

    service.startPollingForTurnChanges(1000);
    await jest.advanceTimersByTimeAsync(1000); // 401 — no notification
    expect(listener).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000); // recovers — notification fires
    expect(listener).toHaveBeenCalledWith(1);
  });
});
