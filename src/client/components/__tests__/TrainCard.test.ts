import { TrainCard } from "../TrainCard";
import { Player } from "../../../shared/types/GameTypes";
import { LoadType } from "../../../shared/types/LoadTypes";

describe("TrainCard", () => {
  let mockScene: any;
  let mockPlayer: Player;
  let trainCard: TrainCard;

  beforeEach(() => {
    // Mock Phaser.Scene
    mockScene = {
      add: {
        container: jest.fn().mockReturnValue({
          add: jest.fn(),
          setVisible: jest.fn(),
          destroy: jest.fn()
        }),
        image: jest.fn().mockReturnValue({
          setOrigin: jest.fn().mockReturnThis(),
          setTexture: jest.fn().mockReturnThis(),
          destroy: jest.fn()
        }),
        rectangle: jest.fn().mockReturnValue({
          setOrigin: jest.fn().mockReturnThis(),
          setStrokeStyle: jest.fn().mockReturnThis(),
          setFillStyle: jest.fn().mockReturnThis(),
          destroy: jest.fn()
        })
      }
    };

    // Mock Player
    mockPlayer = {
      id: "1",
      name: "Test Player",
      color: "#FF0000",
      money: 50,
      trainType: "Freight",
      turnNumber: 1,
      trainState: {
        position: null,
        remainingMovement: 9,
        movementHistory: [],
        loads: []
      },
      hand: []
    };

    trainCard = new TrainCard(mockScene, 0, 0, mockPlayer);
  });

  it("should create train card with correct image", () => {
    expect(mockScene.add.image).toHaveBeenCalledWith(0, 0, "train_card_freight");
  });

  it("should create correct number of load slots based on train type", () => {
    // Freight train should have 2 load slots
    expect(mockScene.add.rectangle).toHaveBeenCalledTimes(2);

    // Reset mocks
    jest.clearAllMocks();

    // Test Heavy Freight train (3 slots)
    mockPlayer.trainType = "Heavy Freight";
    trainCard = new TrainCard(mockScene, 0, 0, mockPlayer);
    expect(mockScene.add.rectangle).toHaveBeenCalledTimes(3);
  });

  it("should update train card image when train type changes", () => {
    mockPlayer.trainType = "Fast Freight";
    trainCard.updateTrainType();
    expect(mockScene.add.image().setTexture).toHaveBeenCalledWith("train_card_fastfreight");
  });

  it("should update load slots based on current loads", () => {
    // Add a load
    mockPlayer.trainState.loads = [LoadType.Coal];
    trainCard.updateLoads();

    // Verify slots have correct fill styles
    expect(mockScene.add.rectangle().setFillStyle).toHaveBeenCalledWith(0x888888, 0.5);
  });

  it("should handle visibility changes", () => {
    trainCard.setVisible(false);
    expect(mockScene.add.container().setVisible).toHaveBeenCalledWith(false);

    trainCard.setVisible(true);
    expect(mockScene.add.container().setVisible).toHaveBeenCalledWith(true);
  });

  it("should clean up resources on destroy", () => {
    trainCard.destroy();
    expect(mockScene.add.container().destroy).toHaveBeenCalled();
  });
}); 