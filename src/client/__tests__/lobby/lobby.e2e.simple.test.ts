import { useLobbyStore } from '../../lobby/store/lobby.store';
import { api } from '../../lobby/shared/api';
import { CreateGameForm, JoinGameForm } from '../../lobby/shared/types';

// Mock the API client
jest.mock('../../lobby/shared/api', () => ({
  api: {
    createGame: jest.fn(),
    joinGame: jest.fn(),
    getGame: jest.fn(),
    getGamePlayers: jest.fn(),
    startGame: jest.fn(),
  },
  getErrorMessage: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;

// Mock localStorage
const mockLocalStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
} as unknown as Storage;

beforeAll(() => {
  Object.defineProperty(window, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
    configurable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset store state
  useLobbyStore.setState({
    currentGame: null,
    players: [],
    isLoading: false,
    error: null,
    retryCount: 0,
  });
  // Mock user in localStorage
  (mockLocalStorage.getItem as jest.Mock).mockImplementation((key) => {
    if (key === 'eurorails.user') {
      return JSON.stringify({ id: 'user-123', name: 'Test User' });
    }
    return null;
  });
});

describe('Lobby E2E - Simple Verification', () => {
  it('should verify createGame returns Game object', async () => {
    const mockGame = {
      id: 'game-123',
      joinCode: 'ABC123',
      createdBy: 'user-123',
      status: 'setup' as const,
      maxPlayers: 4,
      isPublic: true,
      createdAt: new Date('2023-01-01T00:00:00Z'),
    };

    // Mock API response
    mockApi.createGame.mockResolvedValueOnce({ game: mockGame });
    mockApi.getGamePlayers.mockResolvedValueOnce({ players: [] });

    const store = useLobbyStore.getState();
    const result = await store.createGame();

    // Verify the actual behavior
    expect(result).toEqual(mockGame);
    expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
    expect(useLobbyStore.getState().players).toEqual([]);
    expect(useLobbyStore.getState().isLoading).toBe(false);
    expect(useLobbyStore.getState().error).toBeNull();
  });

  it('should verify joinGame returns Game object', async () => {
    const mockGame = {
      id: 'game-123',
      joinCode: 'ABC123',
      createdBy: 'user-456',
      status: 'setup' as const,
      maxPlayers: 4,
      isPublic: true,
      createdAt: new Date('2023-01-01T00:00:00Z'),
    };

    const mockPlayers = [
      {
        id: 'player-1',
        userId: 'user-456',
        name: 'Creator',
        color: '#FF0000',
        isOnline: true,
      },
    ];

    // Mock API responses
    mockApi.joinGame.mockResolvedValueOnce({ game: mockGame });
    mockApi.getGamePlayers.mockResolvedValueOnce({ players: mockPlayers });

    const store = useLobbyStore.getState();
    const result = await store.joinGame({ joinCode: 'ABC123' });

    // Verify the actual behavior
    expect(result).toEqual(mockGame);
    expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
    expect(useLobbyStore.getState().players).toEqual(mockPlayers);
    expect(useLobbyStore.getState().isLoading).toBe(false);
    expect(useLobbyStore.getState().error).toBeNull();
  });

  it('should not call startGame API and keep status setup when startGame is called', async () => {
    const mockGame = {
      id: 'game-123',
      joinCode: 'ABC123',
      createdBy: 'user-123',
      status: 'setup' as const,
      maxPlayers: 4,
      isPublic: true,
      createdAt: new Date('2023-01-01T00:00:00Z'),
    };

    // Set up initial state
    useLobbyStore.setState({
      currentGame: mockGame,
      players: [],
      isLoading: false,
      error: null,
    });

    const store = useLobbyStore.getState();
    
    // Verify initial state is setup
    expect(useLobbyStore.getState().currentGame?.status).toBe('setup');
    await store.startGame('game-123');

    // Verify the API was NOT called (lobby startGame does nothing)
    expect(mockApi.startGame).not.toHaveBeenCalled();
    // Verify the status remains setup (lobby doesn't set active)
    expect(useLobbyStore.getState().currentGame?.status).toBe('setup');
    expect(useLobbyStore.getState().isLoading).toBe(false);
    expect(useLobbyStore.getState().error).toBeNull();
  });
});
