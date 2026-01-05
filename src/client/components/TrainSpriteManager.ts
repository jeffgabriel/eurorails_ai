import "phaser";
import {
  GameState,
  Player,
  TRAIN_PROPERTIES,
} from "../../shared/types/GameTypes";
import { PlayerStateService } from "../services/PlayerStateService";

/**
 * Callback type for train sprite interaction events.
 */
export type TrainInteractionCallback = (
  playerId: string,
  pointer: Phaser.Input.Pointer
) => void;

/**
 * TrainSpriteManager handles all train sprite lifecycle and visual management:
 * - Sprite creation and texture management
 * - Z-ordering of trains at the same location
 * - Interactivity state based on whose turn it is
 * - Visual stacking offsets for multiple trains
 */
export class TrainSpriteManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private trainContainer: Phaser.GameObjects.Container;
  private playerStateService: PlayerStateService;
  private interactionCallback: TrainInteractionCallback | null = null;

  private static readonly COLOR_MAP: { [key: string]: string } = {
    "#FFD700": "yellow",
    "#FF0000": "red",
    "#0000FF": "blue",
    "#000000": "black",
    "#008000": "green",
    "#8B4513": "brown",
  };

  private static readonly OFFSET_X = 5; // pixels to offset each train horizontally
  private static readonly OFFSET_Y = 5; // pixels to offset each train vertically

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    trainContainer: Phaser.GameObjects.Container,
    playerStateService: PlayerStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.trainContainer = trainContainer;
    this.playerStateService = playerStateService;

    // Initialize trainSprites map in gameState if not exists
    if (!this.gameState.trainSprites) {
      this.gameState.trainSprites = new Map();
    }
  }

  /**
   * Set the callback to be invoked when a train sprite is clicked.
   */
  public setInteractionCallback(callback: TrainInteractionCallback): void {
    this.interactionCallback = callback;
  }

  /**
   * Get a train sprite by player ID.
   */
  public getSprite(playerId: string): Phaser.GameObjects.Image | undefined {
    return this.gameState.trainSprites?.get(playerId);
  }

  /**
   * Create or update a train sprite at the specified position.
   * Handles stacking offsets when multiple trains are at the same location.
   */
  public createOrUpdateSprite(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
  ): Phaser.GameObjects.Image {
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error(`Player not found: ${playerId}`);
    }

    // Find all trains at this location for stacking offset
    const trainsAtLocation = this.gameState.players
      .filter(
        (p) =>
          p.trainState?.position?.row === row &&
          p.trainState?.position?.col === col
      )
      .map((p) => p.id);

    // Calculate offset based on position in stack
    const index = trainsAtLocation.indexOf(playerId);
    const offsetX = index * TrainSpriteManager.OFFSET_X;
    const offsetY = index * TrainSpriteManager.OFFSET_Y;

    let trainSprite = this.gameState.trainSprites?.get(playerId);

    if (!trainSprite) {
      // Create new sprite
      trainSprite = this.createTrainSprite(player, x + offsetX, y + offsetY);
      this.gameState.trainSprites?.set(playerId, trainSprite);
      this.setupSpriteInteraction(trainSprite, playerId);
    } else {
      // Update position for existing sprite
      trainSprite.setPosition(x + offsetX, y + offsetY);

      // Ensure it's still interactive
      if (!trainSprite.input) {
        trainSprite.setInteractive({ useHandCursor: true });
        this.setupSpriteInteraction(trainSprite, playerId);
      }
    }

    return trainSprite;
  }

  /**
   * Create a new train sprite for a player.
   */
  private createTrainSprite(
    player: Player,
    x: number,
    y: number
  ): Phaser.GameObjects.Image {
    const trainColor =
      TrainSpriteManager.COLOR_MAP[player.color.toUpperCase()] || "black";
    const trainProps = TRAIN_PROPERTIES[player.trainType];
    const spritePrefix = trainProps ? trainProps.spritePrefix : "train";
    const trainTexture = `${spritePrefix}_${trainColor}`;

    const trainSprite = this.scene.add.image(x, y, trainTexture);

    // Pawn sprite sizing: train_12_* art is visually larger, so scale it down.
    const baseScale = 0.1;
    const desiredScale = spritePrefix === "train_12" ? baseScale * 0.5 : baseScale;
    trainSprite.setScale(desiredScale);

    this.trainContainer.add(trainSprite);

    return trainSprite;
  }

  /**
   * Set up pointer interaction for a train sprite.
   */
  private setupSpriteInteraction(
    sprite: Phaser.GameObjects.Image,
    playerId: string
  ): void {
    sprite.setInteractive({ useHandCursor: true });

    // Remove any existing listeners to prevent duplicates
    sprite.removeAllListeners("pointerdown");

    sprite.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Only allow interaction if this is the local player's train on their turn
      const localPlayerId = this.playerStateService.getLocalPlayerId();
      const isLocalPlayerTrain = localPlayerId === playerId;
      const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
        this.gameState.currentPlayerIndex,
        this.gameState.players
      );

      if (isLocalPlayerTrain && isLocalPlayerTurn && this.interactionCallback) {
        // Stop event propagation to prevent scene handler
        if (pointer.event) {
          pointer.event.stopPropagation();
        }
        this.interactionCallback(playerId, pointer);
      }
    });
  }

  /**
   * Update z-ordering for all trains.
   * Current player's train is always on top.
   */
  public updateZOrders(): void {
    // Group trains by location
    const trainsByLocation = new Map<string, string[]>();

    this.gameState.players.forEach((player) => {
      if (player.trainState?.position) {
        const locationKey = `${player.trainState.position.row},${player.trainState.position.col}`;
        const trains = trainsByLocation.get(locationKey) || [];
        trains.push(player.id);
        trainsByLocation.set(locationKey, trains);
      }
    });

    const currentPlayerId =
      this.gameState.players[this.gameState.currentPlayerIndex]?.id;

    // Update z-order for each location with multiple trains
    trainsByLocation.forEach((trainsAtLocation) => {
      // First, bring non-current player trains to top in their original order
      trainsAtLocation.forEach((trainId) => {
        if (trainId !== currentPlayerId) {
          const sprite = this.gameState.trainSprites?.get(trainId);
          if (sprite) {
            this.trainContainer.bringToTop(sprite);
          }
        }
      });

      // Finally, bring current player's train to the very top
      if (currentPlayerId) {
        const currentPlayerSprite =
          this.gameState.trainSprites?.get(currentPlayerId);
        if (currentPlayerSprite) {
          this.trainContainer.bringToTop(currentPlayerSprite);
        }
      }
    });
  }

  /**
   * Refresh train sprite textures when train type changes (upgrade/crossgrade).
   * Safe to call on every gameState refresh.
   */
  public refreshTextures(): void {
    if (!this.gameState.trainSprites) return;

    this.gameState.players.forEach((player) => {
      const sprite = this.gameState.trainSprites?.get(player.id);
      if (!sprite) return;

      const trainColor =
        TrainSpriteManager.COLOR_MAP[player.color.toUpperCase()] || "black";
      const trainProps = TRAIN_PROPERTIES[player.trainType];
      const spritePrefix = trainProps ? trainProps.spritePrefix : "train";
      const desiredTexture = `${spritePrefix}_${trainColor}`;
      const baseScale = 0.1;
      const desiredScale =
        spritePrefix === "train_12" ? baseScale * 0.5 : baseScale;

      // Update texture if different
      if ((sprite as any).texture?.key !== desiredTexture) {
        try {
          sprite.setTexture(desiredTexture);
        } catch (e) {
          console.warn("Failed to update train sprite texture:", e);
        }
      }

      // Keep scale in sync with texture family
      try {
        if (Math.abs(sprite.scaleX - desiredScale) > 0.0001) {
          sprite.setScale(desiredScale);
        }
      } catch (e) {
        console.warn("Failed to update train sprite scale:", e);
      }
    });
  }

  /**
   * Update train sprite interactivity based on whose turn it is.
   * Only the local player's train should be interactive on their turn.
   */
  public updateInteractivity(): void {
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
      this.gameState.currentPlayerIndex,
      this.gameState.players
    );

    this.gameState.trainSprites?.forEach((sprite, playerId) => {
      const isLocalPlayerTrain = localPlayerId === playerId;
      const shouldBeInteractive = isLocalPlayerTrain && isLocalPlayerTurn;

      if (shouldBeInteractive) {
        sprite.setInteractive({ useHandCursor: true });
        this.setupSpriteInteraction(sprite, playerId);
      } else {
        sprite.disableInteractive();
        sprite.removeAllListeners("pointerdown");
      }
    });
  }

  /**
   * Set the alpha (transparency) for a specific train sprite.
   * Used for visual feedback during movement mode.
   */
  public setSpriteAlpha(playerId: string, alpha: number): void {
    const sprite = this.gameState.trainSprites?.get(playerId);
    if (sprite) {
      sprite.setAlpha(alpha);
    }
  }

  /**
   * Reset alpha for all train sprites to fully opaque.
   */
  public resetAllSpriteAlpha(): void {
    this.gameState.trainSprites?.forEach((sprite) => {
      sprite.setAlpha(1);
    });
  }
}
