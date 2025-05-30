import { TrainMovementManager } from '../components/TrainMovementManager';
import { TerrainType, TrackSegment, GridPoint, GameState, Player } from '../../shared/types/GameTypes';

describe('TrainMovementManager Ferry Movement', () => {
  let gameState: GameState;
  let player: Player;
  let manager: TrainMovementManager;
  let ferryPort: GridPoint;
  let nextPoint: GridPoint;
  let prevPoint: GridPoint;

  beforeEach(() => {
    ferryPort = { row: 5, col: 5, x: 0, y: 0, terrain: TerrainType.FerryPort } as GridPoint;
    nextPoint = { row: 5, col: 6, x: 0, y: 0, terrain: TerrainType.Clear } as GridPoint;
    prevPoint = { row: 5, col: 4, x: 0, y: 0, terrain: TerrainType.Clear } as GridPoint;
    player = {
      id: 'p1',
      name: 'Test',
      color: '#000000',
      trainType: 'Freight',
      money: 100,
      trainState: {
        position: { ...ferryPort },
        remainingMovement: 4, // Assume halved already for ferry
        movementHistory: [
          { from: { ...prevPoint, terrain: TerrainType.Clear }, to: { ...ferryPort }, cost: 0 }
        ],
        loads: []
      },
      hand: [],
      turnNumber: 1
    } as unknown as Player;
    gameState = {
      players: [player],
      currentPlayerIndex: 0
    } as GameState;
    manager = new TrainMovementManager(gameState);
  });

  it('allows movement at half speed after stopping at a ferry port', () => {
    // remainingMovement is 4 (halved from 9)
    expect(manager.canMoveTo(nextPoint)).toMatchObject({ canMove: true });
    // Should deduct 1
    expect(player.trainState.remainingMovement).toBe(3);
  });

  it('does not double halve movement when checking multiple times', () => {
    // Simulate two checks
    expect(manager.canMoveTo(nextPoint)).toMatchObject({ canMove: true });
    expect(manager.canMoveTo(nextPoint)).toMatchObject({ canMove: true });
    // Should deduct 1 each time, not halve again
    expect(player.trainState.remainingMovement).toBe(2);
  });

  it('allows reversal at a ferry port', () => {
    // Try to move back to prevPoint (reverse direction)
    expect(manager.canMoveTo(prevPoint)).toMatchObject({ canMove: true });
    expect(player.trainState.remainingMovement).toBe(3);
  });

  it('does not halve movement when not at a ferry port', () => {
    // Move to a clear point, then try another move
    player.trainState.position = { ...nextPoint };
    player.trainState.movementHistory.push({ from: { ...ferryPort }, to: { ...nextPoint }, cost: 0 });
    player.trainState.remainingMovement = 9;
    const anotherPoint = { row: 5, col: 7, x: 0, y: 0, terrain: TerrainType.Clear } as GridPoint;
    expect(manager.canMoveTo(anotherPoint)).toMatchObject({ canMove: true });
    expect(player.trainState.remainingMovement).toBe(8);
  });
}); 