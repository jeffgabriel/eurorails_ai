import { TrainCard } from '../components/TrainCard';
import { Player, TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';

describe("TrainCard", () => {
  let mockScene: any;
  let mockPlayer: Player;
  let trainCard: TrainCard;

  beforeEach(() => {
    // Mock Phaser.Scene
    const mockContainer = () => {
      const container = {
        x: 0,
        y: 0,
        add: jest.fn(),
        addLocal: jest.fn(),
        setName: jest.fn().mockReturnThis(),
        setSize: jest.fn().mockReturnThis(),
        setPosition: jest.fn().mockReturnThis(),
        setVisible: jest.fn(),
        destroy: jest.fn(),
      };
      return container;
    };

    const mockImage = () => {
      const image: any = {
        displayWidth: 200,
        displayHeight: 300,
        setOrigin: jest.fn().mockReturnThis(),
        setTexture: jest.fn().mockReturnThis(),
        setScale: jest.fn().mockImplementation((_scale: number) => {
          // Keep display size stable for layout math in TrainCard
          image.displayWidth = 200;
          image.displayHeight = 300;
          return image;
        }),
        setPosition: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      };
      return image;
    };

    mockScene = {
      rexUI: {
        add: {
          container: jest.fn().mockImplementation(() => mockContainer()),
        },
      },
      add: {
        image: jest.fn().mockImplementation(() => mockImage()),
        rectangle: jest.fn().mockReturnValue({
          setOrigin: jest.fn().mockReturnThis(),
          setStrokeStyle: jest.fn().mockReturnThis(),
          setFillStyle: jest.fn().mockReturnThis(),
          destroy: jest.fn()
        }),
        circle: jest.fn().mockReturnValue({
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
      trainType: TrainType.Freight,
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
    mockPlayer.trainType = TrainType.HeavyFreight;
    trainCard = new TrainCard(mockScene, 0, 0, mockPlayer);
    expect(mockScene.add.rectangle).toHaveBeenCalledTimes(3);
  });

  it("should update train card image when train type changes", () => {
    const trainImage = mockScene.add.image.mock.results[0].value;
    mockPlayer.trainType = TrainType.FastFreight;
    trainCard.updateTrainType();
    // The existing TrainCard image should be re-textured.
    expect(trainImage.setTexture).toHaveBeenCalledWith("train_card_fast_freight");
  });

  it("should update load slots based on current loads", () => {
    // Add a load
    mockPlayer.trainState.loads = [LoadType.Coal];
    trainCard.updateLoads();

    // Verify slots have correct fill styles
    const calls = mockScene.add.rectangle().setFillStyle.mock.calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        [0x444444, 0.3]
      ])
    );
  });

  it("should clean up resources on destroy", () => {
    const trainContainer = mockScene.rexUI.add.container.mock.results[0].value;
    trainCard.destroy();
    // TrainCard uses rexUI ContainerLite now
    expect(trainContainer.destroy).toHaveBeenCalled();
  });
}); 