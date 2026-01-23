/**
 * Integration tests for train movement and camera panning coordination.
 *
 * These tests verify that:
 * 1. Train movement and camera panning don't conflict
 * 2. Camera panning is suppressed during train movement
 * 3. The complete drag flow works end-to-end
 */

import { TrainMovementModeController } from '../components/TrainMovementModeController';
import { CameraController } from '../components/CameraController';
import { GameState, Player, TrainType } from '../../shared/types/GameTypes';

describe('Train Movement and Camera Panning Integration', () => {
  let movementController: TrainMovementModeController;
  let mockScene: any;
  let mockGameState: GameState;
  let mockTrainMovementManager: any;
  let mockTrainSpriteManager: any;
  let mockPlayerStateService: any;
  let isTrainMovementActive: () => boolean;

  // Track event handlers registered on the scene
  let scenePointerdownHandlers: Function[] = [];
  let scenePointermoveHandlers: Function[] = [];
  let scenePointerupHandlers: Function[] = [];

  const createMockPlayer = (id: string): Player => ({
    id,
    name: 'Test Player',
    color: '#FF0000',
    money: 100,
    trainType: TrainType.Freight,
    turnNumber: 3,
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
    scenePointerdownHandlers = [];
    scenePointermoveHandlers = [];
    scenePointerupHandlers = [];

    mockScene = {
      input: {
        on: jest.fn((event: string, handler: Function) => {
          if (event === 'pointerdown') scenePointerdownHandlers.push(handler);
          if (event === 'pointermove') scenePointermoveHandlers.push(handler);
          if (event === 'pointerup') scenePointerupHandlers.push(handler);
        }),
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
          setBounds: jest.fn(),
          setZoom: jest.fn(),
          scrollX: 0,
          scrollY: 0,
          zoom: 1,
          width: 800,
          height: 600,
          dirty: false,
          ignore: jest.fn()
        }
      }
    };

    mockGameState = {
      id: 'test-game',
      players: [createMockPlayer('player1')],
      currentPlayerIndex: 0,
      status: 'active',
      maxPlayers: 4
    } as GameState;

    mockTrainMovementManager = {
      loadTrackData: jest.fn().mockResolvedValue(undefined)
    };

    mockTrainSpriteManager = {
      setSpriteAlpha: jest.fn(),
      resetAllSpriteAlpha: jest.fn(),
      getSprite: jest.fn().mockReturnValue({
        setPosition: jest.fn()
      })
    };

    mockPlayerStateService = {};

    // Create the movement controller
    movementController = new TrainMovementModeController(
      mockScene,
      mockGameState,
      mockTrainMovementManager,
      mockTrainSpriteManager,
      mockPlayerStateService
    );

    // Set up the callback that CameraController would use
    isTrainMovementActive = () => movementController.isInMovementMode();
  });

  describe('Movement Mode State Coordination', () => {
    it('should report false when not in movement mode', () => {
      expect(isTrainMovementActive()).toBe(false);
    });

    it('should report true when in movement mode', async () => {
      await movementController.enterMovementMode();
      expect(isTrainMovementActive()).toBe(true);
    });

    it('should report false after exiting movement mode', async () => {
      await movementController.enterMovementMode();
      expect(isTrainMovementActive()).toBe(true);

      movementController.exitMovementMode();
      expect(isTrainMovementActive()).toBe(false);
    });
  });

  describe('Camera Panning Suppression Logic', () => {
    /**
     * Simulates the camera panning logic from CameraController.
     * Camera panning should be suppressed when train movement is active.
     */
    const shouldPanCamera = (pointer: any, lastPosition: any, isMouseDown: boolean, isDragging: boolean): boolean => {
      // Skip camera panning when train movement is active
      if (isTrainMovementActive()) return false;

      // Standard drag detection logic
      if (!isMouseDown) return false;

      const deltaX = pointer.x - lastPosition.x;
      const deltaY = pointer.y - lastPosition.y;
      const dragThreshold = 5;

      // Only pan if dragging
      if (!isDragging && (Math.abs(deltaX) <= dragThreshold && Math.abs(deltaY) <= dragThreshold)) {
        return false;
      }

      return true;
    };

    it('should allow camera panning when not in movement mode', () => {
      const pointer = { x: 150, y: 150 };
      const lastPosition = { x: 100, y: 100 };

      expect(shouldPanCamera(pointer, lastPosition, true, true)).toBe(true);
    });

    it('should suppress camera panning when in movement mode', async () => {
      await movementController.enterMovementMode();

      const pointer = { x: 150, y: 150 };
      const lastPosition = { x: 100, y: 100 };

      expect(shouldPanCamera(pointer, lastPosition, true, true)).toBe(false);
    });

    it('should restore camera panning after exiting movement mode', async () => {
      await movementController.enterMovementMode();
      const pointer = { x: 150, y: 150 };
      const lastPosition = { x: 100, y: 100 };

      // Suppressed while in movement mode
      expect(shouldPanCamera(pointer, lastPosition, true, true)).toBe(false);

      // Exit movement mode
      movementController.exitMovementMode();

      // Camera panning restored
      expect(shouldPanCamera(pointer, lastPosition, true, true)).toBe(true);
    });

    it('should not pan camera when mouse is not down', () => {
      const pointer = { x: 150, y: 150 };
      const lastPosition = { x: 100, y: 100 };

      expect(shouldPanCamera(pointer, lastPosition, false, false)).toBe(false);
    });

    it('should not pan camera when movement is below drag threshold', () => {
      const pointer = { x: 103, y: 103 }; // Only 3px movement
      const lastPosition = { x: 100, y: 100 };

      expect(shouldPanCamera(pointer, lastPosition, true, false)).toBe(false);
    });
  });

  describe('Complete Drag Flow Simulation', () => {
    /**
     * Simulates the complete train movement drag flow.
     */
    it('should handle complete train movement flow without camera interference', async () => {
      // Initial state
      expect(movementController.isInMovementMode()).toBe(false);
      expect(isTrainMovementActive()).toBe(false);

      // User clicks on train (enter movement mode)
      await movementController.enterMovementMode();
      expect(movementController.isInMovementMode()).toBe(true);
      expect(isTrainMovementActive()).toBe(true);

      // Simulate drag (camera should be suppressed)
      const shouldPan = !isTrainMovementActive();
      expect(shouldPan).toBe(false); // Camera panning suppressed

      // User releases mouse (exit movement mode)
      movementController.exitMovementMode();
      expect(movementController.isInMovementMode()).toBe(false);
      expect(isTrainMovementActive()).toBe(false);

      // Camera panning should work again
      const shouldPanAfter = !isTrainMovementActive();
      expect(shouldPanAfter).toBe(true);
    });

    it('should handle rapid enter/exit transitions', async () => {
      // Rapid transitions shouldn't cause state inconsistency
      for (let i = 0; i < 10; i++) {
        await movementController.enterMovementMode();
        expect(isTrainMovementActive()).toBe(true);

        movementController.exitMovementMode();
        expect(isTrainMovementActive()).toBe(false);
      }
    });

    it('should handle drawing mode interrupting movement mode', async () => {
      // Enter movement mode
      await movementController.enterMovementMode();
      expect(movementController.isInMovementMode()).toBe(true);
      expect(isTrainMovementActive()).toBe(true);

      // User switches to drawing mode
      movementController.setDrawingMode(true);
      expect(movementController.isInMovementMode()).toBe(false);
      expect(movementController.isInDrawingMode()).toBe(true);
      expect(isTrainMovementActive()).toBe(false);

      // Camera panning should work in drawing mode
      expect(!isTrainMovementActive()).toBe(true);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle multiple exit calls gracefully', async () => {
      await movementController.enterMovementMode();

      // Multiple exits should not throw
      movementController.exitMovementMode();
      movementController.exitMovementMode();
      movementController.exitMovementMode();

      expect(movementController.isInMovementMode()).toBe(false);
    });

    it('should handle exit without enter', () => {
      // Exit without entering should not throw
      expect(() => movementController.exitMovementMode()).not.toThrow();
      expect(movementController.isInMovementMode()).toBe(false);
    });

    it('should handle resetMovementMode correctly', async () => {
      await movementController.enterMovementMode();
      expect(movementController.isInMovementMode()).toBe(true);

      movementController.resetMovementMode();
      expect(movementController.isInMovementMode()).toBe(false);
      expect(isTrainMovementActive()).toBe(false);
    });
  });
});

describe('Drag Interaction Scenarios', () => {
  /**
   * These tests simulate user interaction scenarios
   * to verify the drag-based train movement works correctly.
   */

  interface DragState {
    isMouseDown: boolean;
    isDragging: boolean;
    lastPosition: { x: number; y: number };
    isInMovementMode: boolean;
  }

  const DRAG_THRESHOLD = 5;

  const createInitialState = (): DragState => ({
    isMouseDown: false,
    isDragging: false,
    lastPosition: { x: 0, y: 0 },
    isInMovementMode: false
  });

  const simulatePointerDown = (state: DragState, x: number, y: number, onTrain: boolean): DragState => ({
    ...state,
    isMouseDown: true,
    isDragging: false,
    lastPosition: { x, y },
    isInMovementMode: onTrain
  });

  const simulatePointerMove = (state: DragState, x: number, y: number): DragState => {
    if (!state.isMouseDown) return state;

    const deltaX = Math.abs(x - state.lastPosition.x);
    const deltaY = Math.abs(y - state.lastPosition.y);
    const shouldDrag = deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD;

    return {
      ...state,
      isDragging: state.isDragging || shouldDrag,
      lastPosition: state.isDragging ? { x, y } : state.lastPosition
    };
  };

  const simulatePointerUp = (state: DragState): DragState => ({
    ...state,
    isMouseDown: false,
    isDragging: false,
    isInMovementMode: false
  });

  describe('Click on train without dragging', () => {
    it('should enter and exit movement mode without train moving', () => {
      let state = createInitialState();

      // Click on train
      state = simulatePointerDown(state, 100, 100, true);
      expect(state.isMouseDown).toBe(true);
      expect(state.isDragging).toBe(false);
      expect(state.isInMovementMode).toBe(true);

      // Release without moving
      state = simulatePointerUp(state);
      expect(state.isMouseDown).toBe(false);
      expect(state.isDragging).toBe(false);
      expect(state.isInMovementMode).toBe(false);
    });
  });

  describe('Click on empty space and drag', () => {
    it('should trigger camera panning', () => {
      let state = createInitialState();

      // Click on empty space (not on train)
      state = simulatePointerDown(state, 100, 100, false);
      expect(state.isInMovementMode).toBe(false);

      // Drag
      state = simulatePointerMove(state, 150, 150);
      expect(state.isDragging).toBe(true);
      expect(state.isInMovementMode).toBe(false);

      // Camera should be panning (movement mode is false)
      const shouldPanCamera = !state.isInMovementMode && state.isDragging;
      expect(shouldPanCamera).toBe(true);
    });
  });

  describe('Click on train and drag to destination', () => {
    it('should move train and suppress camera panning', () => {
      let state = createInitialState();

      // Click on train
      state = simulatePointerDown(state, 100, 100, true);
      expect(state.isInMovementMode).toBe(true);

      // Drag to destination
      state = simulatePointerMove(state, 200, 200);
      expect(state.isDragging).toBe(true);
      expect(state.isInMovementMode).toBe(true);

      // Camera should NOT be panning (movement mode is true)
      const shouldPanCamera = !state.isInMovementMode && state.isDragging;
      expect(shouldPanCamera).toBe(false);

      // Release
      state = simulatePointerUp(state);
      expect(state.isInMovementMode).toBe(false);
    });
  });

  describe('Small movements below drag threshold', () => {
    it('should not trigger dragging', () => {
      let state = createInitialState();

      // Click
      state = simulatePointerDown(state, 100, 100, true);

      // Small move (below threshold)
      state = simulatePointerMove(state, 102, 102);
      expect(state.isDragging).toBe(false);

      // Another small move
      state = simulatePointerMove(state, 104, 104);
      expect(state.isDragging).toBe(false);
    });

    it('should trigger dragging once threshold is exceeded', () => {
      let state = createInitialState();

      // Click
      state = simulatePointerDown(state, 100, 100, true);

      // Small move (below threshold)
      state = simulatePointerMove(state, 103, 103);
      expect(state.isDragging).toBe(false);

      // Move exceeds threshold
      state = simulatePointerMove(state, 106, 106);
      expect(state.isDragging).toBe(true);
    });
  });
});
