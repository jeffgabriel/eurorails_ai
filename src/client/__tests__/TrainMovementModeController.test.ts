import { TrainMovementModeController } from '../components/TrainMovementModeController';
import { GameState, Player, TrainType } from '../../shared/types/GameTypes';

describe('TrainMovementModeController', () => {
  let controller: TrainMovementModeController;
  let mockScene: any;
  let mockGameState: GameState;
  let mockTrainMovementManager: any;
  let mockTrainSpriteManager: any;
  let mockPlayerStateService: any;

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

    mockScene = {
      input: {
        setDefaultCursor: jest.fn()
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

    controller = new TrainMovementModeController(
      mockScene,
      mockGameState,
      mockTrainMovementManager,
      mockTrainSpriteManager,
      mockPlayerStateService
    );
  });

  describe('Initial State', () => {
    it('should start with isInMovementMode false', () => {
      expect(controller.isInMovementMode()).toBe(false);
    });

    it('should start with isInDrawingMode false', () => {
      expect(controller.isInDrawingMode()).toBe(false);
    });
  });

  describe('enterMovementMode', () => {
    it('should set isInMovementMode to true', async () => {
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
    });

    it('should load track data before enabling movement mode', async () => {
      await controller.enterMovementMode();
      expect(mockTrainMovementManager.loadTrackData).toHaveBeenCalled();
    });

    it('should set cursor to pointer', async () => {
      await controller.enterMovementMode();
      expect(mockScene.input.setDefaultCursor).toHaveBeenCalledWith('pointer');
    });

    it('should set sprite alpha to 0.7 for current player', async () => {
      await controller.enterMovementMode();
      expect(mockTrainSpriteManager.setSpriteAlpha).toHaveBeenCalledWith('player1', 0.7);
    });

    it('should not enter movement mode when train just arrived at ferry', async () => {
      mockGameState.players[0].trainState.ferryState = {
        status: 'just_arrived',
        ferryConnection: null as any,
        currentSide: null as any,
        otherSide: null as any
      };

      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(false);
    });

    it('should enter movement mode when ferry status is ready_to_cross', async () => {
      mockGameState.players[0].trainState.ferryState = {
        status: 'ready_to_cross',
        ferryConnection: null as any,
        currentSide: null as any,
        otherSide: null as any
      };

      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
    });
  });

  describe('exitMovementMode', () => {
    it('should set isInMovementMode to false', async () => {
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);

      controller.exitMovementMode();
      expect(controller.isInMovementMode()).toBe(false);
    });

    it('should reset cursor to default', async () => {
      await controller.enterMovementMode();
      jest.clearAllMocks();

      controller.exitMovementMode();
      expect(mockScene.input.setDefaultCursor).toHaveBeenCalledWith('default');
    });

    it('should reset all sprite alpha', async () => {
      await controller.enterMovementMode();
      jest.clearAllMocks();

      controller.exitMovementMode();
      expect(mockTrainSpriteManager.resetAllSpriteAlpha).toHaveBeenCalled();
    });
  });

  describe('resetMovementMode', () => {
    it('should exit movement mode if currently active', async () => {
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);

      controller.resetMovementMode();
      expect(controller.isInMovementMode()).toBe(false);
    });

    it('should be safe to call when not in movement mode', () => {
      expect(controller.isInMovementMode()).toBe(false);

      // Should not throw
      expect(() => controller.resetMovementMode()).not.toThrow();
      expect(controller.isInMovementMode()).toBe(false);
    });

    it('should not call exitMovementMode if not in movement mode', () => {
      const exitSpy = jest.spyOn(controller, 'exitMovementMode');

      controller.resetMovementMode();

      // exitMovementMode should not be called when not in movement mode
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('setDrawingMode', () => {
    it('should set isInDrawingMode to true', () => {
      controller.setDrawingMode(true);
      expect(controller.isInDrawingMode()).toBe(true);
    });

    it('should set isInDrawingMode to false', () => {
      controller.setDrawingMode(true);
      expect(controller.isInDrawingMode()).toBe(true);

      controller.setDrawingMode(false);
      expect(controller.isInDrawingMode()).toBe(false);
    });

    it('should exit movement mode when entering drawing mode', async () => {
      // First enter movement mode
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);

      // Now enter drawing mode
      controller.setDrawingMode(true);

      // Should have exited movement mode
      expect(controller.isInMovementMode()).toBe(false);
      expect(controller.isInDrawingMode()).toBe(true);
    });

    it('should not affect movement mode when exiting drawing mode', async () => {
      // Enter both modes
      await controller.enterMovementMode();
      controller.setDrawingMode(true);

      // Movement mode should be off (exited when entering drawing mode)
      expect(controller.isInMovementMode()).toBe(false);

      // Exit drawing mode
      controller.setDrawingMode(false);

      // Movement mode should still be off (not automatically re-enabled)
      expect(controller.isInMovementMode()).toBe(false);
    });
  });

  describe('State Transitions', () => {
    it('should allow multiple enter/exit cycles', async () => {
      // First cycle
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
      controller.exitMovementMode();
      expect(controller.isInMovementMode()).toBe(false);

      // Second cycle
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
      controller.exitMovementMode();
      expect(controller.isInMovementMode()).toBe(false);

      // Third cycle
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
      controller.exitMovementMode();
      expect(controller.isInMovementMode()).toBe(false);
    });

    it('should handle drawing mode interrupting movement mode', async () => {
      // Enter movement mode
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
      expect(controller.isInDrawingMode()).toBe(false);

      // Enter drawing mode (should exit movement mode)
      controller.setDrawingMode(true);
      expect(controller.isInMovementMode()).toBe(false);
      expect(controller.isInDrawingMode()).toBe(true);

      // Exit drawing mode
      controller.setDrawingMode(false);
      expect(controller.isInMovementMode()).toBe(false);
      expect(controller.isInDrawingMode()).toBe(false);

      // Should be able to enter movement mode again
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
    });
  });

  describe('No Toggle Semantics', () => {
    it('should not have a toggleMovementMode method', () => {
      // The refactored controller should not have toggle semantics
      expect((controller as any).toggleMovementMode).toBeUndefined();
    });

    it('should not have _justEnteredMovementMode property', () => {
      // The refactored controller should not need this flag
      expect((controller as any)._justEnteredMovementMode).toBeUndefined();
    });

    it('should not have wasJustEntered method', () => {
      // The refactored controller should not need this method
      expect((controller as any).wasJustEntered).toBeUndefined();
    });

    it('should not have clearJustEnteredFlag method', () => {
      // The refactored controller should not need this method
      expect((controller as any).clearJustEnteredFlag).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing trainMovementManager.loadTrackData gracefully', async () => {
      mockTrainMovementManager.loadTrackData = undefined;

      // Should not throw
      await expect(controller.enterMovementMode()).resolves.not.toThrow();
      expect(controller.isInMovementMode()).toBe(true);
    });

    it('should handle missing current player', async () => {
      mockGameState.players = [];

      // Should still enter movement mode but not set sprite alpha
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
      expect(mockTrainSpriteManager.setSpriteAlpha).not.toHaveBeenCalled();
    });

    it('should handle currentPlayerIndex out of bounds', async () => {
      mockGameState.currentPlayerIndex = 5; // Invalid index

      // Should still enter movement mode but not set sprite alpha
      await controller.enterMovementMode();
      expect(controller.isInMovementMode()).toBe(true);
      expect(mockTrainSpriteManager.setSpriteAlpha).not.toHaveBeenCalled();
    });
  });
});
