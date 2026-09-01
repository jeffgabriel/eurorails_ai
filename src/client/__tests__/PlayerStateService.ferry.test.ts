import { PlayerStateService } from '../services/PlayerStateService';
import { Player, GridPoint, TerrainType } from '../../shared/types/GameTypes';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

function createGridPoint(row: number, col: number, city?: any): GridPoint {
  return {
    id: `${row},${col}`,
    x: col * 10,
    y: row * 10,
    row,
    col,
    terrain: TerrainType.Clear,
    city,
  } as GridPoint;
}

function createPlayer(ferryState?: Player['trainState']['ferryState']): Player {
  return {
    id: 'player-1',
    name: 'Test',
    color: '#ff0000',
    money: 50,
    trainType: 'Freight',
    turnNumber: 1,
    trainState: {
      position: { x: 0, y: 0, row: 5, col: 5 },
      remainingMovement: 9,
      movementHistory: [{ from: {}, to: {}, cost: 1 } as any],
      loads: [],
      ferryState,
      justCrossedFerry: false,
    },
    hand: [],
  } as unknown as Player;
}

function createFerryState(status: 'just_arrived' | 'ready_to_cross') {
  return {
    status,
    ferryConnection: {} as any,
    currentSide: { row: 5, col: 5 } as any,
    otherSide: { row: 8, col: 9 } as any,
  };
}

describe('PlayerStateService.applyFerryTurnTransition', () => {
  let service: PlayerStateService;

  beforeEach(() => {
    service = new PlayerStateService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('is a no-op when the player is not at a ferry', () => {
    const player = createPlayer(undefined);
    const result = service.applyFerryTurnTransition(player, () => createGridPoint(8, 9));

    expect(result).toEqual({});
    expect(player.trainState.justCrossedFerry).toBe(false);
    expect(player.trainState.movementHistory).toHaveLength(1);
  });

  it('crosses the ferry on just_arrived: mutates state and returns the new position', () => {
    const player = createPlayer(createFerryState('just_arrived'));
    const destination = createGridPoint(8, 9);

    const result = service.applyFerryTurnTransition(player, (row, col) =>
      row === 8 && col === 9 ? destination : undefined
    );

    expect(result.newPosition).toBe(destination);
    expect(result.arrivedAtCity).toBeUndefined();
    expect(player.trainState.justCrossedFerry).toBe(true);
    expect(player.trainState.movementHistory).toEqual([]);
    expect(player.trainState.ferryState).toBeUndefined();
  });

  it('reports city arrival when the destination is a ferry-city hybrid', () => {
    const player = createPlayer(createFerryState('just_arrived'));
    const destination = createGridPoint(8, 9, { name: 'Dublin' });

    const result = service.applyFerryTurnTransition(player, () => destination);

    expect(result.newPosition).toBe(destination);
    expect(result.arrivedAtCity).toBe(destination);
  });

  it('leaves the flipped ready_to_cross status when the grid point is unresolvable', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const player = createPlayer(createFerryState('just_arrived'));

    const result = service.applyFerryTurnTransition(player, () => undefined);

    expect(result).toEqual({});
    // Status flipped before the lookup; the stale branch heals it next turn.
    expect(player.trainState.ferryState?.status).toBe('ready_to_cross');
    expect(player.trainState.justCrossedFerry).toBe(false);
    expect(player.trainState.movementHistory).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('clears a stale ready_to_cross state without moving the train', () => {
    const player = createPlayer(createFerryState('ready_to_cross'));

    const result = service.applyFerryTurnTransition(player, () => createGridPoint(8, 9));

    expect(result).toEqual({});
    expect(player.trainState.ferryState).toBeUndefined();
    expect(player.trainState.justCrossedFerry).toBe(false);
  });
});
