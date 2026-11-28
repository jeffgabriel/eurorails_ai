import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { FullGameState, TerrainType, GridPoint, TrackSegment } from '../../shared/types/GameTypes';
import { TrackBuildResult, TrackUndoResult } from '../services/TrackService';
import { PlayerTrackState } from '../../shared/types/TrackTypes';

/**
 * Stands in for the server: it keeps the sections built this turn, prices them
 * as sent, and undoes them last-in-first-out, like POST /api/tracks/build and
 * /api/tracks/undo-segment.
 */
class FakeTrackService {
  public built: TrackSegment[] = [];
  public failing = false;

  private turnBuildCost(): number {
    return this.built.reduce((sum: number, seg: TrackSegment): number => sum + seg.cost, 0);
  }

  async buildTrack(_gameId: string, segments: readonly TrackSegment[]): Promise<TrackBuildResult> {
    if (this.failing) return { ok: false, message: 'refused' };
    this.built.push(...segments);
    return {
      ok: true,
      segments: [...segments],
      cost: segments.reduce((sum: number, seg: TrackSegment): number => sum + seg.cost, 0),
      turnBuildCost: this.turnBuildCost(),
    };
  }

  async undoLastSegment(_gameId: string): Promise<TrackUndoResult> {
    const removedSegment = this.failing ? undefined : this.built.pop();
    if (!removedSegment) return { ok: false, message: 'refused' };
    return { ok: true, removedSegment, turnBuildCost: this.turnBuildCost(), money: 50 };
  }

  async loadAllTracks(): Promise<PlayerTrackState[]> {
    return [];
  }
}
let trackService: FakeTrackService;
const fakeTrackService = (): any => trackService;

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
  // Start-milepost glow
  fillStyle: jest.fn(),
  fillCircle: jest.fn(),
  strokeCircle: jest.fn(),
  setAlpha: jest.fn(),
};
const mockScene = {
  add: { graphics: () => mockGraphics },
  events: { on: () => {}, off: () => {} },
  input: { on: () => {}, off: () => {} },
  cameras: { main: { getWorldPoint: () => ({ x: 0, y: 0 }) } },
  scale: { height: 1000 }
} as any;
const mockMapContainer = { add: () => {} } as any;
const mockGameState: FullGameState = {
  id: 'game1',
  players: [{ id: 'p1', color: '#ff0000', money: 50 }],
  currentPlayerIndex: 0
} as any;
const mockGridPoints: GridPoint[][] = [[{ x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear, id: '0,0' }]];
const mockGameStateService = {
  isLocalPlayerActive: () => true
} as any;

describe('TrackDrawingManager Undo Feature', () => {
  beforeEach(() => {
    trackService = new FakeTrackService();
  });

  it('should initialize segmentsDrawnThisTurn as an empty array', () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
    );
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
  });

  describe('hasDrawnThisTurn', () => {
    it('should be false when nothing has been drawn or committed this turn', () => {
      const manager = new TrackDrawingManager(
        mockScene,
        mockMapContainer,
        mockGameState,
        mockGridPoints,
      undefined,
      fakeTrackService()
      );
      expect(manager.hasDrawnThisTurn()).toBe(false);
    });

    it('should be true when there are uncommitted segments in the current session', () => {
      const manager = new TrackDrawingManager(
        mockScene,
        mockMapContainer,
        mockGameState,
        mockGridPoints,
      undefined,
      fakeTrackService()
      );
      (manager as any)["currentSegments"] = [
        {
          from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
          to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear },
          cost: 1
        }
      ];
      expect(manager.hasDrawnThisTurn()).toBe(true);
    });

    it('should be true when committed turnBuildCost exists for the player', () => {
      const manager = new TrackDrawingManager(
        mockScene,
        mockMapContainer,
        mockGameState,
        mockGridPoints,
      undefined,
      fakeTrackService()
      );
      (manager as any).playerTracks.set(mockGameState.players[0].id, {
        playerId: mockGameState.players[0].id,
        gameId: mockGameState.id,
        segments: [],
        totalCost: 0,
        turnBuildCost: 3,
        lastBuildTimestamp: new Date()
      } as any);
      expect(manager.hasDrawnThisTurn()).toBe(true);
    });

    it('should become false again after undo clears committed spend (turnBuildCost -> 0)', async () => {
      const manager = new TrackDrawingManager(
        mockScene,
        mockMapContainer,
        mockGameState,
        mockGridPoints,
      undefined,
      fakeTrackService()
      );
      const segment1 = {
        from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
        to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear },
        cost: 1
      };
      (manager as any).playerTracks.set(mockGameState.players[0].id, {
        playerId: mockGameState.players[0].id,
        gameId: mockGameState.id,
        segments: [segment1],
        totalCost: 1,
        turnBuildCost: 1,
        lastBuildTimestamp: new Date()
      } as any);
      manager.segmentsDrawnThisTurn = [segment1 as any];
      trackService.built = [segment1 as any];

      expect(manager.hasDrawnThisTurn()).toBe(true);
      await manager.undoLastSegment();
      expect(manager.hasDrawnThisTurn()).toBe(false);
    });
  });

  it('should accumulate segmentsDrawnThisTurn across multiple drawing sessions in a turn', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
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
      mockGridPoints,
      undefined,
      fakeTrackService()
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
      mockGridPoints,
      undefined,
      fakeTrackService()
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
      mockGridPoints,
      undefined,
      fakeTrackService()
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
    manager.endTurnCleanup(playerId);
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    expect(manager.getLastBuildCost(playerId)).toBe(0);
  });

  it('should undo the last segment built this turn', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      mockGameStateService,
      fakeTrackService()
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
    await manager.undoLastSegment();
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
      mockGridPoints,
      undefined,
      fakeTrackService()
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
      mockGridPoints,
      mockGameStateService,
      fakeTrackService()
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
    await manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1, segment2]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([segment1, segment2]);
    expect(manager.getLastBuildCost(playerId)).toBe(3);
    // Undo again (segment2)
    await manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([segment1]);
    expect(manager.getLastBuildCost(playerId)).toBe(1);
    // Undo again (segment1)
    await manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([]);
    expect(manager.getLastBuildCost(playerId)).toBe(0);
  });

  it('should not affect this.turnBuildCost when undoing a saved segment', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      mockGameStateService,
      fakeTrackService()
    );
    // Simulate drawing and committing a segment
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    // Start a new drawing session (simulate unsaved cost)
    (manager as any)["turnBuildCost"] = 5;
    // Undo last segment
    await manager.undoLastSegment();
    // The unsaved session cost should remain unchanged
    expect((manager as any)["turnBuildCost"]).toBe(5);
    // The player's build cost should be 0
    const playerId = mockGameState.players[0].id;
    expect(manager.getLastBuildCost(playerId)).toBe(0);
  });

  it('should clear networkNodesCache after undo', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      mockGameStateService,
      fakeTrackService()
    );
    // Simulate drawing and committing a segment
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    // Add a fake cache entry
    (manager as any)["networkNodesCache"].set("test", new Set(["a"]));
    // Undo last segment
    await manager.undoLastSegment();
    // Cache should be cleared
    expect((manager as any)["networkNodesCache"].size).toBe(0);
  });

  it('should not allow undoing segments from previous turns after turn change', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
    );
    // Simulate drawing and committing a segment in turn 1
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1]);
    // End turn (simulate turn change)
    const playerId = mockGameState.players[0].id;
    manager.endTurnCleanup(playerId);
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    // Try to undo (should do nothing)
    await manager.undoLastSegment();
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    const playerTrackState = (manager as any).playerTracks.get(playerId);
    expect(playerTrackState.segments).toEqual([segment1]);
  });

  it('should change nothing when the server refuses the undo', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
    );
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();

    trackService.failing = true;
    await expect(manager.undoLastSegment()).resolves.toBe(false);

    const playerId = mockGameState.players[0].id;
    expect(manager.segmentsDrawnThisTurn).toEqual([segment1]);
    expect((manager as any).playerTracks.get(playerId).segments).toEqual([segment1]);
    expect(manager.getLastBuildCost(playerId)).toBe(1);
  });

  it('should take segments, costs and turn spend from the server response', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
    );
    const drawn = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    const priced = { ...drawn, cost: 3 };
    trackService.buildTrack = jest.fn().mockResolvedValue({ ok: true, segments: [priced], cost: 3, turnBuildCost: 3 });
    (manager as any)["currentSegments"] = [drawn];
    (manager as any)["turnBuildCost"] = 1;
    await (manager as any)["saveCurrentTracks"]();

    const playerId = mockGameState.players[0].id;
    expect(trackService.buildTrack).toHaveBeenCalledWith(mockGameState.id, [drawn]);
    expect(manager.segmentsDrawnThisTurn).toEqual([priced]);
    expect((manager as any).playerTracks.get(playerId)).toMatchObject({ segments: [priced], totalCost: 3, turnBuildCost: 3 });
    // Money is charged by the server at the end of the turn, not on commit.
    expect(mockGameState.players[0].money).toBe(50);
  });

  it('should not duplicate sections when a socket reload lands before the build response', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
    );
    const playerId = mockGameState.players[0].id;
    const older = { from: { x: 9, y: 9, row: 5, col: 5, terrain: TerrainType.Clear }, to: { x: 9, y: 9, row: 5, col: 6, terrain: TerrainType.Clear }, cost: 2 };
    const built = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    // While the build request is in flight, the track:updated reload replaces the
    // stored state with one that already contains the new section.
    trackService.buildTrack = jest.fn().mockImplementation(async () => {
      (manager as any).playerTracks.set(playerId, {
        playerId,
        gameId: mockGameState.id,
        segments: [older, { ...built }],
        totalCost: 3,
        turnBuildCost: 1,
        lastBuildTimestamp: new Date()
      });
      return { ok: true, segments: [built], cost: 1, turnBuildCost: 1 };
    });
    (manager as any)["currentSegments"] = [built];
    (manager as any)["turnBuildCost"] = 1;

    await (manager as any)["saveCurrentTracks"]();

    expect((manager as any).playerTracks.get(playerId)).toMatchObject({
      segments: [older, built],
      totalCost: 3,
      turnBuildCost: 1,
    });
    expect(manager.segmentsDrawnThisTurn).toEqual([built]);
  });

  it('should drop the drawn segments and report why when the server refuses the build', async () => {
    const manager = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      undefined,
      fakeTrackService()
    );
    const hints: string[] = [];
    const discarded: number[] = [];
    const committed = jest.fn();
    manager.setOnDrawingHint((message: string) => hints.push(message));
    manager.setOnTrackSegmentsDiscarded((count: number) => discarded.push(count));
    manager.setOnTrackSegmentsCommitted(committed);
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    (manager as any)["currentSegments"] = [segment1];
    (manager as any)["turnBuildCost"] = 1;

    trackService.failing = true;
    await (manager as any)["saveCurrentTracks"]();

    expect(hints).toEqual(['refused']);
    expect(discarded).toEqual([1]);
    expect(committed).not.toHaveBeenCalled();
    expect(manager.segmentsDrawnThisTurn).toEqual([]);
    expect(manager.getLastBuildCost(mockGameState.players[0].id)).toBe(0);
  });

  it('should persist undo state and restore correctly after reload', async () => {
    // Simulate drawing and committing two segments
    const manager1 = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      mockGameStateService,
      fakeTrackService()
    );
    const segment1 = { from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, cost: 1 };
    const segment2 = { from: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear }, to: { x: 2, y: 2, row: 0, col: 2, terrain: TerrainType.Clear }, cost: 2 };
    (manager1 as any)["currentSegments"] = [segment1];
    (manager1 as any)["turnBuildCost"] = 1;
    await (manager1 as any)["saveCurrentTracks"]();
    (manager1 as any)["currentSegments"] = [segment2];
    (manager1 as any)["turnBuildCost"] = 2;
    await (manager1 as any)["saveCurrentTracks"]();
    // Simulate reload: create a new manager and load tracks
    const manager2 = new TrackDrawingManager(
      mockScene,
      mockMapContainer,
      mockGameState,
      mockGridPoints,
      mockGameStateService,
      fakeTrackService()
    );
    // Mock TrackService to return the same segments
    (manager2 as any).playerTracks.set(
      mockGameState.players[0].id,
      {
        playerId: mockGameState.players[0].id,
        gameId: mockGameState.id,
        segments: [segment1, segment2],
        totalCost: 3,
        turnBuildCost: 3,
        lastBuildTimestamp: new Date()
      }
    );
    manager2.segmentsDrawnThisTurn = [segment1, segment2];
    // Undo last segment
    await manager2.undoLastSegment();
    expect(manager2.segmentsDrawnThisTurn).toEqual([segment1]);
    const playerTrackState = (manager2 as any).playerTracks.get(mockGameState.players[0].id);
    expect(playerTrackState.segments).toEqual([segment1]);
  });
}); 