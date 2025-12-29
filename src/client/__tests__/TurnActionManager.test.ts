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
      undoLastSegment: jest.fn().mockResolvedValue(undefined),
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

    const trackDrawingManager = { undoLastSegment: jest.fn() } as any;
    const playerStateService = { isCurrentPlayer: jest.fn().mockReturnValue(true) } as any;
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
    expect(player.trainState.remainingMovement).toBe(7);
    expect(player.trainState.ferryState).toBeUndefined();
    expect(player.trainState.movementHistory).toHaveLength(0);
    expect(trainUpdater.updateTrainPosition).toHaveBeenCalledWith("p1", 10, 20, 1, 2);
  });

  it("should undo load pickup by returning load and updating player loads", async () => {
    const gameState = createGameState();
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      getLocalPlayer: jest.fn().mockReturnValue(gameState.players[0]),
      updatePlayerLoads: jest.fn().mockResolvedValue(true),
    } as any;

    gameState.players[0].trainState.loads = [LoadType.Oil];

    const loadService = {
      returnLoad: jest.fn().mockResolvedValue(true),
    } as any;
    const trackDrawingManager = { undoLastSegment: jest.fn() } as any;
    const trainUpdater = { updateTrainPosition: jest.fn().mockResolvedValue(undefined) };

    const mgr = new TurnActionManager({
      gameState,
      trackDrawingManager,
      trainInteractionManager: trainUpdater,
      playerStateService,
      loadService,
    });

    mgr.recordLoadPickup("Berlin", LoadType.Oil);
    const ok = await mgr.undoLastAction();
    expect(ok).toBe(true);
    expect(loadService.returnLoad).toHaveBeenCalledWith(LoadType.Oil, "game-1", "Berlin");
    expect(playerStateService.updatePlayerLoads).toHaveBeenCalledWith([], "game-1");
  });

  it("should undo delivery by picking up the returned load then calling server undo; compensates on failure", async () => {
    const gameState = createGameState();
    const playerStateService = {
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      undoLastAction: jest.fn().mockResolvedValue(true),
    } as any;
    const loadService = {
      pickupLoad: jest.fn().mockResolvedValue(true),
      returnLoad: jest.fn().mockResolvedValue(true),
    } as any;
    const trackDrawingManager = { undoLastSegment: jest.fn() } as any;
    const trainUpdater = { updateTrainPosition: jest.fn().mockResolvedValue(undefined) };

    const mgr = new TurnActionManager({
      gameState,
      trackDrawingManager,
      trainInteractionManager: trainUpdater,
      playerStateService,
      loadService,
    });

    mgr.recordLoadDelivery({
      city: "Berlin",
      loadType: LoadType.Oil,
      cardIdUsed: 1,
      newCardIdDrawn: 2,
      payment: 10,
    });

    const ok = await mgr.undoLastAction();
    expect(ok).toBe(true);
    expect(loadService.pickupLoad).toHaveBeenCalledWith(LoadType.Oil, "Berlin", "game-1");
    expect(playerStateService.undoLastAction).toHaveBeenCalledWith("game-1");

    // Failure path should compensate by returning the load to the pool.
    playerStateService.undoLastAction.mockResolvedValueOnce(false);
    mgr.recordLoadDelivery({
      city: "Berlin",
      loadType: LoadType.Oil,
      cardIdUsed: 1,
      newCardIdDrawn: 2,
      payment: 10,
    });
    const ok2 = await mgr.undoLastAction();
    expect(ok2).toBe(false);
    expect(loadService.returnLoad).toHaveBeenCalledWith(LoadType.Oil, "game-1", "Berlin");
  });
});


