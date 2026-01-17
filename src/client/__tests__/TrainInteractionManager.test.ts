import { TrainInteractionManager } from '../components/TrainInteractionManager';
import { GameState, Player, TrainType, TerrainType } from '../../shared/types/GameTypes';

// Mock all component dependencies
jest.mock('../components/TrainSpriteManager', () => ({
  TrainSpriteManager: jest.fn().mockImplementation(() => ({
    setInteractionCallback: jest.fn(),
    createOrUpdateSprite: jest.fn(),
    updateZOrders: jest.fn(),
    updateInteractivity: jest.fn(),
    refreshTextures: jest.fn(),
    setSpriteAlpha: jest.fn(),
    resetAllSpriteAlpha: jest.fn(),
    getSprite: jest.fn().mockReturnValue({
      setPosition: jest.fn()
    })
  }))
}));

// Create a stateful mock for TrainMovementModeController
const createMovementModeControllerMock = () => {
  let _isMovementMode = false;
  let _isDrawingMode = false;
  return {
    isInMovementMode: jest.fn(() => _isMovementMode),
    isInDrawingMode: jest.fn(() => _isDrawingMode),
    enterMovementMode: jest.fn(async () => { _isMovementMode = true; }),
    exitMovementMode: jest.fn(() => { _isMovementMode = false; }),
    resetMovementMode: jest.fn(() => { _isMovementMode = false; }),
    setDrawingMode: jest.fn((isDrawing: boolean) => {
      _isDrawingMode = isDrawing;
      if (isDrawing) _isMovementMode = false;
    }),
    _reset: () => { _isMovementMode = false; _isDrawingMode = false; }
  };
};

let movementModeControllerMock = createMovementModeControllerMock();

jest.mock('../components/TrainMovementModeController', () => ({
  TrainMovementModeController: jest.fn().mockImplementation(() => movementModeControllerMock)
}));

jest.mock('../components/CityArrivalHandler', () => ({
  CityArrivalHandler: jest.fn().mockImplementation(() => ({
    handleArrival: jest.fn().mockResolvedValue(undefined),
    isCity: jest.fn().mockReturnValue(false),
    isSamePoint: jest.fn().mockReturnValue(false),
    setPlayerHandDisplay: jest.fn(),
    setHandContainer: jest.fn(),
    setUIManager: jest.fn(),
    setTurnActionManager: jest.fn()
  }))
}));

jest.mock('../components/MovementExecutor', () => ({
  MovementExecutor: jest.fn().mockImplementation(() => ({
    executeMovement: jest.fn().mockResolvedValue(undefined),
    setTrainPositionUpdater: jest.fn(),
    setExitMovementModeCallback: jest.fn(),
    setUIManager: jest.fn(),
    setTurnActionManager: jest.fn()
  }))
}));

jest.mock('../services/PlayerStateService', () => ({
  PlayerStateService: jest.fn().mockImplementation(() => ({
    initializeLocalPlayer: jest.fn(),
    getLocalPlayerId: jest.fn().mockReturnValue('player1'),
    isCurrentPlayer: jest.fn().mockReturnValue(true),
    updatePlayerPosition: jest.fn().mockResolvedValue(undefined),
    moveTrainWithFees: jest.fn().mockResolvedValue({ ok: true })
  }))
}));

describe('TrainInteractionManager Drag State and Event Handling', () => {
  let manager: TrainInteractionManager;
  let mockScene: any;
  let mockGameState: GameState;
  let mockTrainMovementManager: any;
  let mockMapRenderer: any;
  let mockGameStateService: any;
  let mockTrainContainer: any;
  let mockTrackDrawingManager: any;
  let mockTurnActionManager: any;
  let mockPlayerStateService: any;

  // Store event handlers for testing
  let pointerdownHandler: (pointer: any) => void;
  let pointermoveHandler: (pointer: any) => void;
  let pointerupHandler: (pointer: any) => Promise<void>;
  let blurHandler: () => void;

  const createMockPointer = (x: number, y: number): any => ({
    x,
    y,
    worldX: x,
    worldY: y
  });

  const createMockPlayer = (id: string, turnNumber: number = 3): Player => ({
    id,
    name: 'Test Player',
    color: '#FF0000',
    money: 100,
    trainType: TrainType.Freight,
    turnNumber,
    trainState: {
      position: { x: 100, y: 100, row: 10, col: 10 },
      remainingMovement: 9,
      movementHistory: [],
      loads: []
    },
    hand: []
  });

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset the stateful mock
    movementModeControllerMock._reset();

    // Create mock scene with input event system
    mockScene = {
      input: {
        on: jest.fn((event: string, handler: Function) => {
          if (event === 'pointerdown') pointerdownHandler = handler as any;
          if (event === 'pointermove') pointermoveHandler = handler as any;
          if (event === 'pointerup') pointerupHandler = handler as any;
        }),
        off: jest.fn(),
        setDefaultCursor: jest.fn()
      },
      game: {
        events: {
          on: jest.fn((event: string, handler: Function) => {
            if (event === 'blur') blurHandler = handler as any;
          }),
          off: jest.fn()
        }
      },
      cameras: {
        main: {
          getWorldPoint: jest.fn((x: number, y: number) => ({ x, y })),
          scrollX: 0,
          scrollY: 0,
          zoom: 1
        }
      }
    };

    // Create mock game state
    mockGameState = {
      id: 'test-game',
      players: [createMockPlayer('player1')],
      currentPlayerIndex: 0,
      status: 'active',
      maxPlayers: 4
    } as GameState;

    // Create mock train movement manager
    mockTrainMovementManager = {
      loadTrackData: jest.fn().mockResolvedValue(undefined),
      getUnionTrackPointKeys: jest.fn().mockReturnValue(new Set(['10,10', '11,10', '12,10'])),
      canMoveTo: jest.fn().mockReturnValue({ canMove: true })
    };

    // Create mock map renderer
    mockMapRenderer = {
      gridPoints: []
    };

    // Create mock game state service
    mockGameStateService = {};

    // Create mock train container
    mockTrainContainer = {
      add: jest.fn(),
      remove: jest.fn()
    };

    // Create mock track drawing manager
    mockTrackDrawingManager = {
      hasDrawnThisTurn: jest.fn().mockReturnValue(false),
      getPlayerTrackState: jest.fn().mockReturnValue({
        playerId: 'player1',
        segments: [{ from: { row: 10, col: 10 }, to: { row: 11, col: 10 } }]
      }),
      getGridPointAtPosition: jest.fn().mockReturnValue({ row: 10, col: 10, x: 100, y: 100 })
    };

    // Create mock turn action manager
    mockTurnActionManager = {};

    // Create mock player state service
    mockPlayerStateService = {
      initializeLocalPlayer: jest.fn(),
      getLocalPlayerId: jest.fn().mockReturnValue('player1'),
      isCurrentPlayer: jest.fn().mockReturnValue(true),
      updatePlayerPosition: jest.fn().mockResolvedValue(undefined)
    };

    // Create the manager instance
    manager = new TrainInteractionManager(
      mockScene,
      mockGameState,
      mockTrainMovementManager,
      mockMapRenderer,
      mockGameStateService,
      mockTrainContainer,
      mockTrackDrawingManager,
      mockTurnActionManager,
      mockPlayerStateService
    );
  });

  describe('Event Handler Registration', () => {
    it('should register pointerdown handler on scene input', () => {
      expect(mockScene.input.on).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    });

    it('should register pointermove handler on scene input', () => {
      expect(mockScene.input.on).toHaveBeenCalledWith('pointermove', expect.any(Function));
    });

    it('should register pointerup handler on scene input', () => {
      expect(mockScene.input.on).toHaveBeenCalledWith('pointerup', expect.any(Function));
    });

    it('should register blur handler on game events', () => {
      expect(mockScene.game.events.on).toHaveBeenCalledWith('blur', expect.any(Function));
    });
  });

  describe('Pointer Down Event', () => {
    it('should set isMouseDown to true on pointerdown', () => {
      const pointer = createMockPointer(100, 200);
      pointerdownHandler(pointer);

      // Access private state via type assertion
      expect((manager as any).isMouseDown).toBe(true);
    });

    it('should reset isDragging to false on pointerdown', () => {
      // First simulate a drag
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      const pointer2 = createMockPointer(200, 300);
      pointermoveHandler(pointer2);

      // Now isDragging should be true
      expect((manager as any).isDragging).toBe(true);

      // New pointerdown should reset isDragging
      const pointer3 = createMockPointer(150, 250);
      pointerdownHandler(pointer3);

      expect((manager as any).isDragging).toBe(false);
    });

    it('should record lastPointerPosition on pointerdown', () => {
      const pointer = createMockPointer(150, 250);
      pointerdownHandler(pointer);

      expect((manager as any).lastPointerPosition).toEqual({ x: 150, y: 250 });
    });
  });

  describe('Pointer Move Event - Drag Detection', () => {
    it('should not process pointermove when mouse is not down', () => {
      const pointer = createMockPointer(200, 300);
      pointermoveHandler(pointer);

      expect((manager as any).isDragging).toBe(false);
    });

    it('should not set isDragging when movement is below threshold', () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      // Move less than DRAG_THRESHOLD (5px)
      const pointer2 = createMockPointer(102, 202);
      pointermoveHandler(pointer2);

      expect((manager as any).isDragging).toBe(false);
    });

    it('should set isDragging to true when horizontal movement exceeds threshold', () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      // Move more than DRAG_THRESHOLD in x direction
      const pointer2 = createMockPointer(106, 200);
      pointermoveHandler(pointer2);

      expect((manager as any).isDragging).toBe(true);
    });

    it('should set isDragging to true when vertical movement exceeds threshold', () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      // Move more than DRAG_THRESHOLD in y direction
      const pointer2 = createMockPointer(100, 206);
      pointermoveHandler(pointer2);

      expect((manager as any).isDragging).toBe(true);
    });

    it('should set isDragging to true when diagonal movement exceeds threshold', () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      // Move more than DRAG_THRESHOLD diagonally
      const pointer2 = createMockPointer(106, 206);
      pointermoveHandler(pointer2);

      expect((manager as any).isDragging).toBe(true);
    });

    it('should keep isDragging true once set', () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      // First move exceeds threshold
      const pointer2 = createMockPointer(110, 210);
      pointermoveHandler(pointer2);
      expect((manager as any).isDragging).toBe(true);

      // Subsequent small move should not reset isDragging
      const pointer3 = createMockPointer(111, 211);
      pointermoveHandler(pointer3);
      expect((manager as any).isDragging).toBe(true);
    });
  });

  describe('Pointer Up Event', () => {
    it('should set isMouseDown to false on pointerup', async () => {
      const pointer = createMockPointer(100, 200);
      pointerdownHandler(pointer);
      expect((manager as any).isMouseDown).toBe(true);

      await pointerupHandler(createMockPointer(0, 0));
      expect((manager as any).isMouseDown).toBe(false);
    });

    it('should set isDragging to false on pointerup', async () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      const pointer2 = createMockPointer(200, 300);
      pointermoveHandler(pointer2);
      expect((manager as any).isDragging).toBe(true);

      await pointerupHandler(createMockPointer(0, 0));
      expect((manager as any).isDragging).toBe(false);
    });

    it('should call exitTrainMovementMode on pointerup', async () => {
      // Enter movement mode first
      (manager as any).movementModeController.enterMovementMode();
      expect((manager as any).movementModeController.isInMovementMode()).toBe(true);

      // Trigger pointerup
      await pointerupHandler(createMockPointer(0, 0));

      // Should have exited movement mode
      expect((manager as any).movementModeController.isInMovementMode()).toBe(false);
    });
  });

  describe('Blur Event (Window Focus Lost)', () => {
    it('should set isMouseDown to false on blur', () => {
      const pointer = createMockPointer(100, 200);
      pointerdownHandler(pointer);
      expect((manager as any).isMouseDown).toBe(true);

      blurHandler();
      expect((manager as any).isMouseDown).toBe(false);
    });

    it('should set isDragging to false on blur', () => {
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);

      const pointer2 = createMockPointer(200, 300);
      pointermoveHandler(pointer2);
      expect((manager as any).isDragging).toBe(true);

      blurHandler();
      expect((manager as any).isDragging).toBe(false);
    });

    it('should call exitTrainMovementMode on blur', () => {
      // Enter movement mode first
      (manager as any).movementModeController.enterMovementMode();
      expect((manager as any).movementModeController.isInMovementMode()).toBe(true);

      // Trigger blur
      blurHandler();

      // Should have exited movement mode
      expect((manager as any).movementModeController.isInMovementMode()).toBe(false);
    });
  });

  describe('DRAG_THRESHOLD constant', () => {
    it('should have DRAG_THRESHOLD set to 5 pixels', () => {
      expect((manager as any).DRAG_THRESHOLD).toBe(5);
    });
  });

  describe('isInMovementMode public method', () => {
    it('should return false when not in movement mode', () => {
      expect(manager.isInMovementMode()).toBe(false);
    });

    it('should return true after entering movement mode', async () => {
      await manager.enterTrainMovementMode();
      expect(manager.isInMovementMode()).toBe(true);
    });

    it('should return false after exiting movement mode', async () => {
      await manager.enterTrainMovementMode();
      expect(manager.isInMovementMode()).toBe(true);

      // Exit via pointerup
      await pointerupHandler(createMockPointer(0, 0));
      expect(manager.isInMovementMode()).toBe(false);
    });
  });

  describe('Complete Drag Flow', () => {
    it('should handle complete drag flow: pointerdown -> pointermove -> pointerup', async () => {
      // Enter movement mode
      await manager.enterTrainMovementMode();
      expect(manager.isInMovementMode()).toBe(true);

      // Start drag
      const pointer1 = createMockPointer(100, 200);
      pointerdownHandler(pointer1);
      expect((manager as any).isMouseDown).toBe(true);
      expect((manager as any).isDragging).toBe(false);

      // Move beyond threshold
      const pointer2 = createMockPointer(150, 250);
      pointermoveHandler(pointer2);
      expect((manager as any).isDragging).toBe(true);

      // Release
      await pointerupHandler(createMockPointer(0, 0));
      expect((manager as any).isMouseDown).toBe(false);
      expect((manager as any).isDragging).toBe(false);
      expect(manager.isInMovementMode()).toBe(false);
    });

    it('should handle click without drag: pointerdown -> pointerup (no movement)', async () => {
      // Enter movement mode
      await manager.enterTrainMovementMode();

      // Click without moving
      const pointer = createMockPointer(100, 200);
      pointerdownHandler(pointer);
      expect((manager as any).isMouseDown).toBe(true);
      expect((manager as any).isDragging).toBe(false);

      // Release immediately
      await pointerupHandler(createMockPointer(0, 0));
      expect((manager as any).isMouseDown).toBe(false);
      expect((manager as any).isDragging).toBe(false);
      expect(manager.isInMovementMode()).toBe(false);
    });
  });
});

describe('TrainInteractionManager handleTrainSpriteClick validation', () => {
  let manager: TrainInteractionManager;
  let mockScene: any;
  let mockGameState: GameState;
  let mockUIManager: any;
  let mockTrackDrawingManager: any;

  const createMockPlayer = (id: string, turnNumber: number = 3): Player => ({
    id,
    name: 'Test Player',
    color: '#FF0000',
    money: 100,
    trainType: TrainType.Freight,
    turnNumber,
    trainState: {
      position: { x: 100, y: 100, row: 10, col: 10 },
      remainingMovement: 9,
      movementHistory: [],
      loads: []
    },
    hand: []
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the stateful mock
    movementModeControllerMock._reset();

    mockScene = {
      input: {
        on: jest.fn(),
        off: jest.fn(),
        setDefaultCursor: jest.fn()
      },
      game: {
        events: {
          on: jest.fn(),
          off: jest.fn()
        }
      },
      cameras: {
        main: {
          getWorldPoint: jest.fn((x: number, y: number) => ({ x, y }))
        }
      }
    };

    mockGameState = {
      id: 'test-game',
      players: [createMockPlayer('player1', 3)],
      currentPlayerIndex: 0,
      status: 'active',
      maxPlayers: 4
    } as GameState;

    mockUIManager = {
      showHandToast: jest.fn()
    };

    mockTrackDrawingManager = {
      hasDrawnThisTurn: jest.fn().mockReturnValue(false),
      getPlayerTrackState: jest.fn().mockReturnValue({
        playerId: 'player1',
        segments: [{ from: { row: 10, col: 10 }, to: { row: 11, col: 10 } }]
      }),
      getGridPointAtPosition: jest.fn()
    };

    const mockTrainMovementManager = {
      loadTrackData: jest.fn().mockResolvedValue(undefined),
      getUnionTrackPointKeys: jest.fn().mockReturnValue(new Set(['10,10']))
    };

    const mockPlayerStateService = {
      initializeLocalPlayer: jest.fn(),
      getLocalPlayerId: jest.fn().mockReturnValue('player1'),
      isCurrentPlayer: jest.fn().mockReturnValue(true)
    };

    manager = new TrainInteractionManager(
      mockScene,
      mockGameState,
      mockTrainMovementManager as any,
      { gridPoints: [] } as any,
      {} as any,
      {} as any,
      mockTrackDrawingManager,
      {} as any,
      mockPlayerStateService as any
    );

    manager.setUIManager(mockUIManager);
  });

  it('should prevent movement before turn 3', () => {
    // Set player to turn 2
    mockGameState.players[0].turnNumber = 2;

    // Call handleTrainSpriteClick
    (manager as any).handleTrainSpriteClick('player1', { x: 100, y: 200 });

    expect(mockUIManager.showHandToast).toHaveBeenCalledWith(
      'You must build track for 2 turns before moving.'
    );
    expect(manager.isInMovementMode()).toBe(false);
  });

  it('should prevent movement when in drawing mode', () => {
    // Set drawing mode
    manager.setDrawingMode(true);

    // Call handleTrainSpriteClick
    (manager as any).handleTrainSpriteClick('player1', { x: 100, y: 200 });

    expect(mockUIManager.showHandToast).toHaveBeenCalledWith(
      'Exit track drawing mode before moving.'
    );
    expect(manager.isInMovementMode()).toBe(false);
  });

  it('should prevent movement after drawing track this turn', () => {
    mockTrackDrawingManager.hasDrawnThisTurn.mockReturnValue(true);

    // Call handleTrainSpriteClick
    (manager as any).handleTrainSpriteClick('player1', { x: 100, y: 200 });

    expect(mockUIManager.showHandToast).toHaveBeenCalledWith(
      'You cannot move again this turn after you start drawing track.'
    );
    expect(manager.isInMovementMode()).toBe(false);
  });

  it('should prevent movement when player has no track', () => {
    mockTrackDrawingManager.getPlayerTrackState.mockReturnValue({
      playerId: 'player1',
      segments: []
    });

    // Call handleTrainSpriteClick
    (manager as any).handleTrainSpriteClick('player1', { x: 100, y: 200 });

    expect(mockUIManager.showHandToast).toHaveBeenCalledWith(
      'Build at least 1 track segment before moving.'
    );
    expect(manager.isInMovementMode()).toBe(false);
  });

  it('should enter movement mode when all validations pass', () => {
    // All conditions are met (default setup)
    mockGameState.players[0].turnNumber = 3;
    manager.setDrawingMode(false);
    mockTrackDrawingManager.hasDrawnThisTurn.mockReturnValue(false);
    mockTrackDrawingManager.getPlayerTrackState.mockReturnValue({
      playerId: 'player1',
      segments: [{ from: { row: 10, col: 10 }, to: { row: 11, col: 10 } }]
    });

    // Call handleTrainSpriteClick
    (manager as any).handleTrainSpriteClick('player1', { x: 100, y: 200 });

    expect(mockUIManager.showHandToast).not.toHaveBeenCalled();
    expect(manager.isInMovementMode()).toBe(true);
  });
});
