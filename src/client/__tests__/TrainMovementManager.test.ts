import { TrainMovementManager } from '../components/TrainMovementManager';
import { TerrainType, TrackSegment, GridPoint, GameState, Player, FerryConnection } from '../../shared/types/GameTypes';

describe('TrainMovementManager Ferry Movement', () => {
  let gameState: GameState;
  let player: Player;
  let manager: TrainMovementManager;
  let ferryPort: GridPoint;
  let nextPoint: GridPoint;
  let prevPoint: GridPoint;
  let ferryConnection: FerryConnection;

  beforeEach(() => {
    ferryPort = { row: 5, col: 5, x: 0, y: 0, terrain: TerrainType.FerryPort, id: 'ferry1' } as GridPoint;
    nextPoint = { row: 5, col: 6, x: 0, y: 0, terrain: TerrainType.Clear, id: 'next1' } as GridPoint;
    prevPoint = { row: 5, col: 4, x: 0, y: 0, terrain: TerrainType.Clear, id: 'prev1' } as GridPoint;
    
    // Create ferry connection
    ferryConnection = {
      Name: 'Test Ferry',
      connections: [ferryPort, { row: 10, col: 5, x: 100, y: 0, terrain: TerrainType.FerryPort, id: 'ferry2' } as GridPoint],
      cost: 4
    };
    ferryPort.ferryConnection = ferryConnection;
    
    player = {
      id: 'p1',
      name: 'Test',
      color: '#000000',
      trainType: 'Freight',
      money: 100,
      trainState: {
        position: { ...ferryPort },
        remainingMovement: 5, // Assume halved already for ferry
        movementHistory: [
          { from: { ...prevPoint, terrain: TerrainType.Clear }, to: { ...ferryPort }, cost: 0 }
        ],
        loads: [],
        ferryState: {
          status: 'ready_to_cross',
          ferryConnection: ferryConnection,
          currentSide: ferryPort,
          otherSide: ferryConnection.connections[1]
        }
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

  it('allows movement at half speed when ready to cross ferry', () => {
    // remainingMovement is 5 (halved from 9, rounded up)
    expect(manager.canMoveTo(nextPoint)).toMatchObject({ canMove: true });
    // Should deduct 1
    expect(player.trainState.remainingMovement).toBe(4);
  });

  it('prevents movement when just arrived at ferry', () => {
    // Change status to just_arrived
    player.trainState.ferryState = {
      status: 'just_arrived',
      ferryConnection: ferryConnection,
      currentSide: ferryPort,
      otherSide: ferryConnection.connections[1]
    };
    
    expect(manager.canMoveTo(nextPoint)).toMatchObject({ canMove: false });
    // Movement should not be deducted
    expect(player.trainState.remainingMovement).toBe(5);
  });

  it('allows reversal when ready to cross ferry', () => {
    // Try to move back to prevPoint (reverse direction)
    expect(manager.canMoveTo(prevPoint)).toMatchObject({ canMove: true });
    expect(player.trainState.remainingMovement).toBe(4);
  });

  it('sets ferry state when arriving at ferry port', () => {
    // Reset player to normal state
    player.trainState.ferryState = undefined;
    player.trainState.position = prevPoint;
    player.trainState.remainingMovement = 9;
    
    const result = manager.canMoveTo(ferryPort);
    
    expect(result).toMatchObject({ canMove: true, endMovement: true });
    expect(player.trainState.ferryState).toBeDefined();
    expect(player.trainState.ferryState!.status).toBe('just_arrived');
    expect(player.trainState.remainingMovement).toBe(0);
  });

  it('does not halve movement when not at a ferry port', () => {
    // Move to a clear point, then try another move
    player.trainState.position = { ...nextPoint };
    player.trainState.ferryState = undefined;
    player.trainState.movementHistory.push({ from: { ...ferryPort }, to: { ...nextPoint }, cost: 0 });
    player.trainState.remainingMovement = 9;
    const anotherPoint = { row: 5, col: 7, x: 0, y: 0, terrain: TerrainType.Clear, id: 'another1' } as GridPoint;
    expect(manager.canMoveTo(anotherPoint)).toMatchObject({ canMove: true });
    expect(player.trainState.remainingMovement).toBe(8);
  });
}); 