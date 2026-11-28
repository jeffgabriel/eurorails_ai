import { TurnActionManager } from "../components/TurnActionManager";
import { LoadType } from "../../shared/types/LoadTypes";
import { TerrainType, TrainType } from "../../shared/types/GameTypes";

describe("TurnActionManager", () => {
  function createGameState() {
    return {
      id: "game-1",
      currentPlayerIndex: 0,
      players: [
        {
          id: "p1",
          userId: "u1",
          name: "P1",
          color: "#ff0000",
          money: 50,
          trainType: TrainType.Freight,
          turnNumber: 3,
          trainState: {
            position: { x: 10, y: 20, row: 1, col: 2 },
            remainingMovement: 7,
            movementHistory: [],
            loads: [],
          },
          hand: [],
        },
      ],
    } as any;
  }

  it("should undo last track segment by delegating to TrackDrawingManager.undoLastSegment()", async () => {
    const gameState = createGameState();
    const trackDrawingManager = {
      undoLastSegment: jest.fn().mockResolvedValue(true),
      undoLastUncommittedSegment: jest.fn().mockReturnValue(true),
    } as any;
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
    } as any;
    const loadService = {} as any;
    const trainUpdater = {
      updateTrainPosition: jest.fn().mockResolvedValue(undefined),
    };

    const mgr = new TurnActionManager({
      gameState,
      trackDrawingManager,
      trainInteractionManager: trainUpdater,
      playerStateService,
      loadService,
    });

    mgr.recordTrackSegmentBuilt({
      from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
      to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear },
      cost: 1,
    });
    mgr.markLastUncommittedTrackSegmentsCommitted(1);

    const ok = await mgr.undoLastAction();
    expect(ok).toBe(true);
    expect(trackDrawingManager.undoLastSegment).toHaveBeenCalledTimes(1);
    expect(mgr.canUndo()).toBe(false);
  });

  it("should undo train movement by restoring prior position and popping movementHistory", async () => {
    const gameState = createGameState();
    const player = gameState.players[0];
    player.trainState.movementHistory = [
      {
        from: { x: 10, y: 20, row: 1, col: 2, terrain: TerrainType.Clear },
        to: { x: 12, y: 22, row: 1, col: 3, terrain: TerrainType.Clear },
        cost: 0,
      },
    ];
    player.trainState.position = { x: 12, y: 22, row: 1, col: 3 };
    player.trainState.remainingMovement = 5;
    player.trainState.ferryState = { status: "just_arrived" } as any;

    const trackDrawingManager = {
      undoLastSegment: jest.fn(),
      getUncommittedSegmentCount: jest.fn().mockReturnValue(0),
      undoLastUncommittedSegment: jest.fn().mockReturnValue(false),
    } as any;
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      undoLastAction: jest.fn().mockResolvedValue(true),
    } as any;
    const loadService = {} as any;
    const trainUpdater = { updateTrainPosition: jest.fn().mockResolvedValue(undefined) };

    const mgr = new TurnActionManager({
      gameState,
      trackDrawingManager,
      trainInteractionManager: trainUpdater,
      playerStateService,
      loadService,
    });

    mgr.recordTrainMoved({
      playerId: "p1",
      previousPosition: { x: 10, y: 20, row: 1, col: 2 },
      previousRemainingMovement: 7,
      previousFerryState: undefined,
      previousJustCrossedFerry: undefined,
    });

    const ok = await mgr.undoLastAction();
    expect(ok).toBe(true);
    expect(playerStateService.undoLastAction).toHaveBeenCalledWith("game-1");
    expect(player.trainState.remainingMovement).toBe(7);
    expect(player.trainState.ferryState).toBeUndefined();
    expect(player.trainState.movementHistory).toHaveLength(0);
    expect(trainUpdater.updateTrainPosition).toHaveBeenCalledWith("p1", 10, 20, 1, 2, { persist: false });
  });

  const createManager = (playerStateService: any, loadService: any, gameState = createGameState()) => {
    const trackDrawingManager = {
      undoLastSegment: jest.fn(),
      getUncommittedSegmentCount: jest.fn().mockReturnValue(0),
      undoLastUncommittedSegment: jest.fn().mockReturnValue(false),
    } as any;
    const trainUpdater = { updateTrainPosition: jest.fn().mockResolvedValue(undefined) };
    return new TurnActionManager({
      gameState,
      trackDrawingManager,
      trainInteractionManager: trainUpdater,
      playerStateService,
      loadService,
    });
  };

  it("should undo load pickup through the server and apply the result to the load service", async () => {
    const undone = {
      kind: "pickup",
      updatedLoads: [],
      droppedLoads: [],
      trayChanges: [{ loadType: LoadType.Oil, delta: 1 }],
    };
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      undoLoadAction: jest.fn().mockResolvedValue(undone),
    } as any;
    const loadService = { applyServerUpdate: jest.fn() } as any;
    const mgr = createManager(playerStateService, loadService);

    mgr.recordLoadPickup("Berlin", LoadType.Oil);
    const ok = await mgr.undoLastAction();

    expect(ok).toBe(true);
    expect(playerStateService.undoLoadAction).toHaveBeenCalledWith("game-1");
    expect(loadService.applyServerUpdate).toHaveBeenCalledWith(undone);
    expect(mgr.canUndo()).toBe(false);
  });

  it("should undo load drop through the server and apply the result to the load service", async () => {
    const undone = {
      kind: "drop",
      updatedLoads: [LoadType.Oil],
      droppedLoads: [{ city_name: "Berlin", type: LoadType.Wine }],
      trayChanges: [{ loadType: LoadType.Wine, delta: -1 }],
    };
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      undoLoadAction: jest.fn().mockResolvedValue(undone),
    } as any;
    const loadService = { applyServerUpdate: jest.fn() } as any;
    const mgr = createManager(playerStateService, loadService);

    mgr.recordLoadDrop("Berlin", LoadType.Oil);
    const ok = await mgr.undoLastAction();

    expect(ok).toBe(true);
    expect(playerStateService.undoLoadAction).toHaveBeenCalledWith("game-1");
    expect(loadService.applyServerUpdate).toHaveBeenCalledWith(undone);
  });

  it("should keep a load action on the stack and change nothing when the server refuses the undo", async () => {
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      undoLoadAction: jest.fn().mockResolvedValue(null),
    } as any;
    const loadService = { applyServerUpdate: jest.fn() } as any;
    const mgr = createManager(playerStateService, loadService);

    mgr.recordLoadPickup("Berlin", LoadType.Oil);
    const ok = await mgr.undoLastAction();

    expect(ok).toBe(false);
    expect(loadService.applyServerUpdate).not.toHaveBeenCalled();
    expect(mgr.canUndo()).toBe(true);
  });

  it("should undo delivery through the server, then take the chip back out of the tray", async () => {
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      undoLastAction: jest.fn().mockResolvedValue(true),
    } as any;
    const loadService = { adjustTrayCount: jest.fn() } as any;
    const mgr = createManager(playerStateService, loadService);
    const delivery = {
      city: "Berlin",
      loadType: LoadType.Oil,
      cardIdUsed: 1,
      newCardIdDrawn: 2,
      payment: 10,
    };

    mgr.recordLoadDelivery(delivery);
    const ok = await mgr.undoLastAction();
    expect(ok).toBe(true);
    expect(playerStateService.undoLastAction).toHaveBeenCalledWith("game-1");
    expect(loadService.adjustTrayCount).toHaveBeenCalledWith(LoadType.Oil, -1);

    // Failure path: the tray count is left alone.
    loadService.adjustTrayCount.mockClear();
    playerStateService.undoLastAction.mockResolvedValueOnce(false);
    mgr.recordLoadDelivery(delivery);
    const ok2 = await mgr.undoLastAction();
    expect(ok2).toBe(false);
    expect(loadService.adjustTrayCount).not.toHaveBeenCalled();
  });

  it("should forget drawn track sections the server refused", async () => {
    const trackDrawingManager = {
      undoLastSegment: jest.fn().mockResolvedValue(true),
      undoLastUncommittedSegment: jest.fn().mockReturnValue(false),
    } as any;
    const mgr = new TurnActionManager({
      gameState: createGameState(),
      trackDrawingManager,
      trainInteractionManager: { updateTrainPosition: jest.fn().mockResolvedValue(undefined) },
      playerStateService: { isCurrentPlayer: jest.fn().mockReturnValue(true) } as any,
      loadService: {} as any,
    });
    const segment = {
      from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
      to: { x: 1, y: 1, row: 0, col: 1, terrain: TerrainType.Clear },
      cost: 1,
    };
    mgr.recordTrackSegmentBuilt(segment);
    mgr.markLastUncommittedTrackSegmentsCommitted(1);
    mgr.recordTrackSegmentBuilt(segment);
    mgr.recordTrackSegmentBuilt(segment);

    mgr.discardLastUncommittedTrackSegments(2);

    // Only the committed section is left to undo.
    expect(await mgr.undoLastAction()).toBe(true);
    expect(trackDrawingManager.undoLastSegment).toHaveBeenCalledTimes(1);
    expect(trackDrawingManager.undoLastUncommittedSegment).not.toHaveBeenCalled();
    expect(mgr.canUndo()).toBe(false);
  });
});
