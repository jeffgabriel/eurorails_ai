import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { GameState, TerrainType, GridPoint } from '../../shared/types/GameTypes';
import { PlayerTrackState } from '../../shared/types/TrackTypes';

// Minimal fetch mock for tests
(global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));

// Mock Phaser dependencies
const mockGraphics = {
  setDepth: jest.fn(),
  clear: jest.fn(),
  destroy: jest.fn(),
  lineStyle: jest.fn(),
  beginPath: jest.fn(),
  moveTo: jest.fn(),
  lineTo: jest.fn(),
  strokePath: jest.fn(),
};
const mockScene = {
  add: { graphics: () => mockGraphics },
  events: { on: () => {}, off: () => {} },
  input: { on: () => {}, off: () => {} },
  cameras: { main: { getWorldPoint: () => ({ x: 0, y: 0 }) } },
  scale: { height: 1000 }
} as any;
const mockMapContainer = { add: () => {} } as any;
const mockGameState: GameState = {
  id: 'game1',
  players: [{ id: 'p1', color: '#ff0000', money: 50 }],
  currentPlayerIndex: 0
} as any;
const mockGridPoints: GridPoint[][] = [[{ x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear, id: '0,0' }]];

describe('TrackDrawingManager Undo Feature', () => {
  it('should initialize segmentsDrawnThisTurn as an empty array', () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
  });

  it('should accumulate segmentsDrawnThisTurn across multiple drawing sessions in a turn', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // Simulate first drawing session
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1]);

    // Simulate second drawing session in the same turn
    const segment2 = { from: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, to: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment2];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1, segment2]);
  });

  it('should not accumulate segments if drawing mode is toggled without drawing', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // Simulate toggling drawing mode on/off without drawing
    (manager as any)["currentSegments"] = [];
    (manager as any)["turnBuildCost"] = 0;
    await (manager as any)["saveCurrentTracks"]();
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
  });

  it('should accumulate only actual segments across mixed drawing sessions', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // First session: draw one segment
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    // Second session: no drawing
    (manager as any)["currentSegments"] = [];
    (manager as any)["turnBuildCost"] = 0;
    await (manager as any)["saveCurrentTracks"]();
    // Third session: draw another segment
    const segment2 = { from: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, to: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment2];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1, segment2]);
  });

  it('should reset segmentsDrawnThisTurn and build cost on endTurnCleanup', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // Simulate drawing and committing two segments
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    const segment2 = { from: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, to: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    (manager as any)["currentSegments"] = [segment2];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1, segment2]);
    // Simulate a nonzero build cost
    const playerId = mockGameState.players[0].id;
    expect(manager.getLastBuildCost(playerId)).toBeGreaterThan(0);
    // Call endTurnCleanup
    await manager.endTurnCleanup(playerId);
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    expect(manager.getLastBuildCost(playerId)).toBe(0);
  });

  it('should undo the last segment built this turn', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // Simulate drawing and committing two segments
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    const segment2 = { from: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, to: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, cost: 2 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    (manager as any)["currentSegments"] = [segment2];
    (manager as any)["turnBuildCost"] = 2;
    await (manager as any)["saveCurrentTracks"]();
    // Undo last segment
    manager.undoLastSegment();
    // Only segment1 should remain
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1]);
    const playerId = mockGameState.players[0].id;
    const playerTrackState = (manager as any).playerTracks.get(playerId);
    expect(playerTrackState.segments).toEqual([segment1]);
    // Cost should be updated
    expect(manager.getLastBuildCost(playerId)).toBe(1);
  });

  it('should do nothing if undoLastSegment is called with no segments', () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // Should not throw or change state
    expect(() => manager.undoLastSegment()).not.toThrow();
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    const playerId = mockGameState.players[0].id;
    expect(manager.getLastBuildCost(playerId)).toBe(0);
  });

  it('should support multiple undos in LIFO order', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints
    );
    // Simulate drawing and committing three segments
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    const segment2 = { from: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, to: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, cost: 2 };
    const segment3 = { from: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, to: { x: 3, y: 3, row: 0, col: 3, terrain: TerrainType.Clear }, cost: 3 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    (manager as any)["currentSegments"] = [segment2];
    (manager as any)["turnBuildCost"] = 2;
    await (manager as any)["saveCurrentTracks"]();
    (manager as any)["currentSegments"] = [segment3];
    (manager as any)["turnBuildCost"] = 3;
    await (manager as any)["saveCurrentTracks"]();
    const playerId = mockGameState.players[0].id;
    // Undo last (segment3)
    manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1, segment2]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([segment1, segment2]);
    expect(manager.getLastBuildCost(playerId)).toBe(3);
    // Undo again (segment2)
    manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([segment1]);
    expect(manager.getLastBuildCost(playerId)).toBe(1);
    // Undo again (segment1)
    manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([]);
    expect(manager.getLastBuildCost(playerId)).toBe(0);
  });
}); 