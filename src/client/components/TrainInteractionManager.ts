import "phaser";
import {
  GameState,
  GridPoint,
  Player,
  TerrainType,
  TrackSegment,
  CityData,
  Point,
  TRAIN_PROPERTIES,
} from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { PlayerStateService } from "../services/PlayerStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
import { LoadService } from "../services/LoadService";
import { PlayerHandDisplay } from "./PlayerHandDisplay";
import { UIManager } from "./UIManager";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { TurnActionManager } from "./TurnActionManager";
import { majorCityGroups } from "../config/mapConfig";
import { computeTrackUsageForMove } from "../../shared/services/trackUsageFees";

export class TrainInteractionManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private trainMovementManager: TrainMovementManager;
  private mapRenderer: MapRenderer;
  private gameStateService: GameStateService;
  private playerStateService: PlayerStateService;
  private trainContainer: Phaser.GameObjects.Container;
  private isTrainMovementMode: boolean = false;
  private justEnteredMovementMode: boolean = false;
  private isDrawingMode: boolean = false;
  private playerHandDisplay: PlayerHandDisplay | null = null;
  private handContainer: Phaser.GameObjects.Container | null = null;
  private uiManager: UIManager | null = null;
  private trackDrawingManager: TrackDrawingManager;
  private turnActionManager: TurnActionManager | null = null;
  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    trainMovementManager: TrainMovementManager,
    mapRenderer: MapRenderer,
    gameStateService: GameStateService,
    trainContainer: Phaser.GameObjects.Container,
    trackDrawingManager: TrackDrawingManager,
    turnActionManager?: TurnActionManager
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.trainMovementManager = trainMovementManager;
    this.mapRenderer = mapRenderer;
    this.gameStateService = gameStateService;
    this.playerStateService = new PlayerStateService();
    this.playerStateService.initializeLocalPlayer(this.gameState.players);
    this.trainContainer = trainContainer;
    this.trackDrawingManager = trackDrawingManager;
    this.turnActionManager = turnActionManager || null;
    // Initialize trainSprites map in gameState if not exists
    if (!this.gameState.trainSprites) {
      this.gameState.trainSprites = new Map();
    }

    this.setupTrainInteraction();
  }

  private setupTrainInteraction(): void {
    // Listen for pointer down events on the scene
    this.scene.input.on(
      "pointerdown",
      async (pointer: Phaser.Input.Pointer) => {
        // Only handle train placement if we're in train movement mode
        // AND we didn't just enter movement mode on this same click
        if (this.isTrainMovementMode && !this.justEnteredMovementMode) {
          // Stop event propagation to prevent other handlers
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
        }
        // Use await to ensure we handle the entire train placement process
        await this.handleTrainPlacement(pointer);
        // Reset the flag after the click is processed
        this.justEnteredMovementMode = false;
      }
    );
  }

  public playerHasTrack(playerId: string): boolean {
    // Get player's track state from TrackDrawingManager
    const playerTrackState =
      this.trackDrawingManager.getPlayerTrackState(playerId);
    if (!playerTrackState || !playerTrackState.segments) {
      return false;
    }
    return playerTrackState.segments.length > 0;
  }

  public findNearestMilepostOnOwnTrack(
    x: number,
    y: number,
    playerId: string
  ): GridPoint | null {
    // First, get the clicked point using TrackDrawingManager's method
    const clickedPoint = this.trackDrawingManager.getGridPointAtPosition(x, y);

    if (!clickedPoint) {
      return null;
    }

    // Union-of-tracks selection: allow selecting a destination on any player's track.
    const trackPoints = this.trainMovementManager.getUnionTrackPointKeys();
    if (trackPoints.size === 0) {
      // Fallback to own track points if the movement manager has not loaded tracks yet.
      const playerTrackState = this.trackDrawingManager.getPlayerTrackState(playerId);
      if (!playerTrackState || !playerTrackState.segments) return null;
      playerTrackState.segments.forEach((segment) => {
        trackPoints.add(`${segment.from.row},${segment.from.col}`);
        trackPoints.add(`${segment.to.row},${segment.to.col}`);
      });
    }

    if (trackPoints.has(`${clickedPoint.row},${clickedPoint.col}`)) {
      return clickedPoint;
    }

    // If not, find the nearest point that is part of a player's track segment
    let nearestPoint: GridPoint | null = null;
    let minDistance = Infinity;

    // Search through adjacent points first (within a reasonable radius)
    const searchRadius = 3; // Adjust this value as needed
    const rowStart = Math.max(0, clickedPoint.row - searchRadius);
    const rowEnd = Math.min(
      this.mapRenderer.gridPoints.length - 1,
      clickedPoint.row + searchRadius
    );

    for (let row = rowStart; row <= rowEnd; row++) {
      if (!this.mapRenderer.gridPoints[row]) continue;

      const colStart = Math.max(0, clickedPoint.col - searchRadius);
      const colEnd = Math.min(
        this.mapRenderer.gridPoints[row].length - 1,
        clickedPoint.col + searchRadius
      );

      for (let col = colStart; col <= colEnd; col++) {
        const point = this.mapRenderer.gridPoints[row][col];
        if (!point || point.terrain === TerrainType.Water) continue;

        // Check if this point is part of the player's track network
        if (trackPoints.has(`${point.row},${point.col}`)) {
          // Calculate distance to this point
          const dx = point.x - clickedPoint.x;
          const dy = point.y - clickedPoint.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Update nearest point if this is closer
          if (distance < minDistance) {
            minDistance = distance;
            nearestPoint = point;
          }
        }
      }
    }

    if (nearestPoint) {
      return nearestPoint;
    }

    return null;
  }

  private async handleTrainPlacement(
    pointer: Phaser.Input.Pointer
  ): Promise<void> {
    // Early return guard: only allow movement if it's the local player's turn
    const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
      this.gameState.currentPlayerIndex,
      this.gameState.players
    );
    if (!isLocalPlayerTurn) {
      return;
    }

    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    // Convert pointer position to world coordinates
    const worldPoint = this.scene.cameras.main.getWorldPoint(
      pointer.x,
      pointer.y
    );

    // Find the nearest milepost to the click that belongs to the current player
    const nearestMilepost = this.findNearestMilepostOnOwnTrack(
      worldPoint.x,
      worldPoint.y,
      currentPlayer.id
    );

    if (nearestMilepost) {
      if (this.isTrainMovementMode) {
        // If the player clicks the city they are already on, allow reopening the load dialog
        // without requiring a successful movement (distance 0 moves are typically rejected).
        if (
          this.isCity(nearestMilepost) &&
          this.isSamePoint(nearestMilepost, currentPlayer.trainState.position)
        ) {
          await this.handleCityArrival(currentPlayer, nearestMilepost);
          return;
        }

        // Store position before movement to verify movement actually succeeded
        const positionBeforeMovement = currentPlayer.trainState.position
          ? { ...currentPlayer.trainState.position }
          : null;
        
        await this.handleMovement(currentPlayer, nearestMilepost, pointer);
        
        // Check if arrived at any city - only if movement actually succeeded
        // Verify: (1) destination is a city, (2) train position matches destination, 
        // and (3) position actually changed (movement was successful, preventing dialog 
        // from opening on failed moves)
        const positionAfterMovement = currentPlayer.trainState.position;
        // Movement succeeded if: train now has a position AND either:
        // - train didn't have a position before (first placement), OR
        // - position changed (train moved to a new location)
        const movementSucceeded = positionAfterMovement && 
          (!positionBeforeMovement || 
           !this.isSamePoint(positionBeforeMovement, positionAfterMovement));
        
        if (
          this.isCity(nearestMilepost) &&
          this.isSamePoint(nearestMilepost, positionAfterMovement) &&
          movementSucceeded
        ) {
          await this.handleCityArrival(currentPlayer, nearestMilepost);
        }
      }
    }
  }

  private isCity(gridPoint: GridPoint): boolean {
    return (
      gridPoint.terrain === TerrainType.MajorCity ||
      gridPoint.terrain === TerrainType.MediumCity ||
      gridPoint.terrain === TerrainType.SmallCity
    );
  }

  private isSamePoint(point1: Point | null, point2: Point | null): boolean {
    if (point1 && point2) {
      return point1.row === point2.row && point1.col === point2.col;
    } else {
      return false;
    }
  }

  private async handleMovement(
    currentPlayer: Player,
    nearestMilepost: GridPoint,
    pointer: Phaser.Input.Pointer
  ) {
    try {
      //where the train is coming from
      const previousPosition = currentPlayer.trainState.position;
      const previousRemainingMovement = currentPlayer.trainState.remainingMovement;
      const previousFerryState: Player["trainState"]["ferryState"] =
        currentPlayer.trainState.ferryState
          ? (JSON.parse(
              JSON.stringify(currentPlayer.trainState.ferryState)
            ) as Player["trainState"]["ferryState"])
          : undefined;
      const previousJustCrossedFerry = currentPlayer.trainState.justCrossedFerry;
      //check if the selected point is a valid move
      const moveResult = this.trainMovementManager.canMoveTo(nearestMilepost);
      if (!moveResult.canMove) {
        this.showInvalidMoveMessage(
          pointer,
          moveResult.message || "Invalid move. You cannot move to this point."
        );
        return;
      }

      // canMoveTo() deducts movement immediately; if user cancels or server rejects we must restore.
      const restoreAfterAbort = () => {
        currentPlayer.trainState.remainingMovement = previousRemainingMovement;
        currentPlayer.trainState.ferryState = previousFerryState;
        currentPlayer.trainState.justCrossedFerry = previousJustCrossedFerry;
      };

      // Fee warning modal (UX only). Server remains authoritative.
      if (previousPosition && this.uiManager) {
        const usage = computeTrackUsageForMove({
          allTracks: this.trainMovementManager.getAllTrackStates(),
          from: { row: previousPosition.row, col: previousPosition.col },
          to: { row: nearestMilepost.row, col: nearestMilepost.col },
          currentPlayerId: currentPlayer.id,
        });

        if (usage.isValid && usage.ownersUsed.size > 0 && this.turnActionManager) {
          const alreadyPaid = this.turnActionManager.getPaidOpponentIdsThisTurn();
          const newlyPayable = Array.from(usage.ownersUsed).filter((pid) => !alreadyPaid.has(pid));
          if (newlyPayable.length > 0) {
            const payees = newlyPayable.map((pid) => {
              const p = this.gameState.players.find((pp) => pp.id === pid);
              return { name: p?.name || "Opponent", amount: 4 };
            });
            const total = payees.reduce((sum, p) => sum + p.amount, 0);
            const accepted = await this.uiManager.confirmOpponentTrackFee({ payees, total });
            if (!accepted) {
              restoreAfterAbort();
              return;
            }
          }
        }
      }

      // Persist movement via server-authoritative fee settlement.
      const moveApiResult = await this.playerStateService.moveTrainWithFees(
        { x: nearestMilepost.x, y: nearestMilepost.y, row: nearestMilepost.row, col: nearestMilepost.col },
        this.gameState.id
      );
      if (!moveApiResult) {
        restoreAfterAbort();
        this.showInvalidMoveMessage(pointer, "Move rejected by server (fees/path).");
        return;
      }

      // Create a track segment for movement history (client-only, for direction rules)
      if (previousPosition) {
        const movementSegment: TrackSegment = {
          from: {
            x: previousPosition.x,
            y: previousPosition.y,
            row: previousPosition.row,
            col: previousPosition.col,
            terrain: TerrainType.Clear,
          },
          to: {
            x: nearestMilepost.x,
            y: nearestMilepost.y,
            row: nearestMilepost.row,
            col: nearestMilepost.col,
            terrain: nearestMilepost.terrain,
          },
          cost: 0,
        };
        if (!currentPlayer.trainState.movementHistory) {
          currentPlayer.trainState.movementHistory = [];
        }
        currentPlayer.trainState.movementHistory.push(movementSegment);
      }

      // Update train position visually without re-posting position (already persisted by move-train).
      await this.updateTrainPosition(
        currentPlayer.id,
        nearestMilepost.x,
        nearestMilepost.y,
        nearestMilepost.row,
        nearestMilepost.col,
        { persist: false }
      );

      // Record on unified undo stack (single click undoes one action)
      if (this.turnActionManager && previousPosition) {
        this.turnActionManager.recordTrainMoved({
          playerId: currentPlayer.id,
          previousPosition: { ...previousPosition },
          previousRemainingMovement,
          previousFerryState,
          previousJustCrossedFerry,
          ownersPaidPlayerIds: (moveApiResult.ownersPaid || []).map((p) => p.playerId),
          feeTotal: moveApiResult.feeTotal,
        });
        // Refresh hand UI so Undo button visibility updates immediately
        try {
          const prevSessions =
            this.trackDrawingManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;
          const currentSession = this.trackDrawingManager.getCurrentTurnBuildCost();
          const totalCost = prevSessions + currentSession;
          await this.uiManager?.setupPlayerHand(this.trackDrawingManager.isInDrawingMode, totalCost);
        } catch (e) {
          // Non-fatal
        }
      }
      // If arrived at a ferry port, or if movement should end, exit movement mode
      if (moveResult.endMovement) {
        this.exitTrainMovementMode();
      }
    } catch (error) {
      throw error;
    }
  }

  private showInvalidMoveMessage(
    pointer: Phaser.Input.Pointer,
    message: string
  ): void {
    const movementProblemText = this.scene.add.text(
      pointer.x,
      pointer.y,
      message,
      {
        fontSize: "16px",
        color: "#ff0000",
        backgroundColor: "#ffffff",
        padding: { x: 10, y: 5 },
        align: "center",
      }
    );

    // Set a timeout to remove the text after a few seconds
    this.scene.time.addEvent({
      delay: 3000, // 3 seconds
      callback: () => {
        movementProblemText.destroy();
      },
    });
  }

  private async handleCityArrival(
    currentPlayer: Player,
    nearestMilepost: any
  ): Promise<void> {
    // Only show dialog if this is the local player
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    if (!localPlayerId || currentPlayer.id !== localPlayerId) {
      return;
    }

    // Always use the city property on the grid point
    const cityData = nearestMilepost.city;
    if (!cityData) return;
    // Get the LoadService instance to check available loads
    const loadService = LoadService.getInstance();
    // Check if train has any loads that could potentially be delivered
    const hasLoads =
      currentPlayer.trainState.loads &&
      currentPlayer.trainState.loads.length > 0;
    // Check if city has any loads available for pickup
    const cityLoads = await loadService.getCityLoadDetails(cityData.name);
    const cityHasLoads = cityLoads && cityLoads.length > 0;
    // Show dialog if either:
    // 1. Train has loads (could be delivered or dropped)
    // 2. City has loads (can be picked up, possibly after dropping current loads)
    if (hasLoads || cityHasLoads) {
      this.showLoadDialog(currentPlayer, cityData);
    }
  }

  private showLoadDialog(player: Player, city: any): void {
    if (!this.uiManager) {
      return;
    }

    // Prevent accidental board interaction while dialog is open.
    // LoadDialogScene will handle its own input; we disable this scene's input until close.
    this.scene.input.enabled = false;

    this.scene.scene.launch("LoadDialogScene", {
      city: city,
      player: player,
      gameState: this.gameState,
      onClose: () => {
        this.scene.scene.stop("LoadDialogScene");
        // Re-enable board input after dialog closes.
        this.scene.input.enabled = true;
      },
      onUpdateTrainCard: () => {
        // Update the train card display through PlayerHandDisplay
        if (this.playerHandDisplay) {
          this.playerHandDisplay.updateTrainCardLoads();
        }
      },
      onUpdateHandDisplay: () => {
        // Update the entire player hand display using the existing container
        if (this.playerHandDisplay && this.handContainer) {
          this.playerHandDisplay.update(false, 0, this.handContainer);
        }
      },
      uiManager: this.uiManager,
      turnActionManager: this.turnActionManager,
    });

    // Ensure the dialog scene renders above the game scene.
    try {
      this.scene.scene.bringToTop("LoadDialogScene");
    } catch (e) {
      // Non-fatal
    }
  }

  public async enterTrainMovementMode(): Promise<void> {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    const trainSprite = this.gameState.trainSprites?.get(currentPlayer.id);

    // Check if train just arrived at ferry - if so, prevent movement
    if (currentPlayer.trainState.ferryState?.status === "just_arrived") {
      // console.log("Cannot enter movement mode - just arrived at ferry this turn");
      return;
    }

    // Load latest track data before enabling movement mode
    if (this.trainMovementManager && this.trainMovementManager.loadTrackData) {
      await this.trainMovementManager.loadTrackData();
    }

    this.isTrainMovementMode = true;
    this.justEnteredMovementMode = true; // Set flag to prevent immediate placement

    // Set cursor to indicate movement mode
    this.scene.input.setDefaultCursor("pointer");

    // Add visual indicator that train is selected
    if (trainSprite) {
      trainSprite.setAlpha(0.7); // Make train slightly transparent to indicate it's being moved
    }
  }

  private exitTrainMovementMode(): void {
    this.isTrainMovementMode = false;
    // Reset cursor style
    this.scene.input.setDefaultCursor("default");

    // Reset opacity for all train sprites
    this.gameState.trainSprites?.forEach((sprite) => {
      sprite.setAlpha(1);
    });
  }

  public resetTrainMovementMode(): void {
    if (this.isTrainMovementMode) {
      this.exitTrainMovementMode();
    }
  }

  public async updateTrainPosition(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
  , opts?: { persist?: boolean }): Promise<void> {
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) return;

    // Initialize trainState if it doesn't exist
    if (!player.trainState) {
      player.trainState = {
        position: null,
        remainingMovement: 0,
        movementHistory: [],
        loads: [], // Initialize empty loads array
      };
    }

    const shouldPersist = opts?.persist !== false;
    if (shouldPersist && this.playerStateService.getLocalPlayerId() === playerId) {
      await this.playerStateService.updatePlayerPosition(x, y, row, col, this.gameState.id);
    } else {
      player.trainState.position = { x, y, row, col };
    }

    // Find all trains at this location
    const trainsAtLocation = this.gameState.players
      .filter(
        (p) =>
          p.trainState?.position?.row === row &&
          p.trainState?.position?.col === col
      )
      .map((p) => p.id);

    // Calculate offset based on position in stack
    const OFFSET_X = 5; // pixels to offset each train horizontally
    const OFFSET_Y = 5; // pixels to offset each train vertically
    const index = trainsAtLocation.indexOf(playerId);
    const offsetX = index * OFFSET_X;
    const offsetY = index * OFFSET_Y;

    // Update or create train sprite
    let trainSprite = this.gameState.trainSprites?.get(playerId);
    if (!trainSprite) {
      trainSprite = this.createTrainSprite(player, x + offsetX, y + offsetY);
      this.gameState.trainSprites?.set(playerId, trainSprite);

      // Set up interaction for new sprites - interactivity will be set by updateTrainInteractivity
      this.setupTrainSpriteInteraction(trainSprite, playerId);
    } else {
      // Just update position for existing sprites
      trainSprite.setPosition(x + offsetX, y + offsetY);

      // Make sure it's still interactive - interactivity will be set by updateTrainInteractivity
      if (!trainSprite.input) {
        trainSprite.setInteractive({ useHandCursor: true });
        this.setupTrainSpriteInteraction(trainSprite, playerId);
      }
    }

    // Update z-ordering for all trains
    this.updateTrainZOrders();
    
    // Ensure interactivity is correctly set based on current turn state
    this.updateTrainInteractivity();
  }

  private createTrainSprite(
    player: Player,
    x: number,
    y: number
  ): Phaser.GameObjects.Image {
    const colorMap: { [key: string]: string } = {
      "#FFD700": "yellow",
      "#FF0000": "red",
      "#0000FF": "blue",
      "#000000": "black",
      "#008000": "green",
      "#8B4513": "brown",
    };

    const trainColor = colorMap[player.color.toUpperCase()] || "black";
    const trainProps = TRAIN_PROPERTIES[player.trainType];
    const spritePrefix = trainProps ? trainProps.spritePrefix : 'train';
    const trainTexture = `${spritePrefix}_${trainColor}`;

    const trainSprite = this.scene.add.image(x, y, trainTexture);
    // Pawn sprite sizing: train_12_* art is visually larger, so scale it down.
    // Here we set it to 50% of the baseline pawn size.
    const baseScale = 0.1;
    const desiredScale = spritePrefix === 'train_12' ? baseScale * 0.5 : baseScale;
    trainSprite.setScale(desiredScale);
    this.trainContainer.add(trainSprite);

    return trainSprite;
  }

  private setupTrainSpriteInteraction(
    sprite: Phaser.GameObjects.Image,
    playerId: string
  ): void {
    // Make sprite interactive with hand cursor
    sprite.setInteractive({ useHandCursor: true });

    // Remove any existing listeners to prevent duplicates
    sprite.removeAllListeners("pointerdown");

    // Add the pointer down listener
    sprite.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Only allow interaction if:
      // 1. This is the local player's train
      // 2. It is the local player's turn
      const localPlayerId = this.playerStateService.getLocalPlayerId();
      const isLocalPlayerTrain = localPlayerId === playerId;
      const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
        this.gameState.currentPlayerIndex,
        this.gameState.players
      );

      if (isLocalPlayerTrain && isLocalPlayerTurn) {
        const activePlayer =
          this.gameState.players[this.gameState.currentPlayerIndex];

        // Per rules: players get 2 full track-drawing turns before any movement.
        // Since movement comes first in a turn, movement is only allowed starting on turn 3.
        if ((activePlayer?.turnNumber ?? 1) < 3) {
          this.uiManager?.showHandToast?.(
            "You must build track for 2 turns before moving."
          );
          return;
        }

        if (this.isDrawingMode) {
          this.uiManager?.showHandToast?.(
            "Exit track drawing mode before moving."
          );
          return;
        }

        const hasTrack = this.playerHasTrack(playerId);
        if (!hasTrack) {
          this.uiManager?.showHandToast?.(
            "Build at least 1 track segment before moving."
          );
          return;
        }

        // First stop event propagation to prevent it from being handled by the scene
        if (pointer.event) {
          pointer.event.stopPropagation();
        }
        // Toggle movement mode: if already in movement mode, exit; otherwise, enter
        if (this.isTrainMovementMode) {
          // Prevent immediate exit if just entered movement mode
          if (!this.justEnteredMovementMode) {
            this.exitTrainMovementMode();
          }
        } else {
          this.enterTrainMovementMode();
        }
      }
    });
  }

  public updateTrainZOrders(): void {
    // Group trains by location
    const trainsByLocation = new Map<string, string[]>();

    this.gameState.players.forEach((player) => {
      if (player.trainState.position) {
        const locationKey = `${player.trainState.position.row},${player.trainState.position.col}`;
        const trains = trainsByLocation.get(locationKey) || [];
        trains.push(player.id);
        trainsByLocation.set(locationKey, trains);
      }
    });

    // Update z-order for each location with multiple trains
    trainsByLocation.forEach((trainsAtLocation) => {
      // First, bring non-current player trains to top in their original order
      trainsAtLocation.forEach((trainId) => {
        if (
          trainId !==
          this.gameState.players[this.gameState.currentPlayerIndex].id
        ) {
          const sprite = this.gameState.trainSprites?.get(trainId);
          if (sprite) {
            this.trainContainer.bringToTop(sprite);
          }
        }
      });

      // Finally, bring current player's train to the very top
      const currentPlayerSprite = this.gameState.trainSprites?.get(
        this.gameState.players[this.gameState.currentPlayerIndex].id
      );
      if (currentPlayerSprite) {
        this.trainContainer.bringToTop(currentPlayerSprite);
      }
    });
  }

  /**
   * If a player's trainType changes (upgrade/crossgrade), update the existing pawn sprite texture.
   * This is safe to call on every gameState refresh.
   */
  public refreshTrainSpriteTextures(): void {
    if (!this.gameState.trainSprites) return;

    const colorMap: { [key: string]: string } = {
      "#FFD700": "yellow",
      "#FF0000": "red",
      "#0000FF": "blue",
      "#000000": "black",
      "#008000": "green",
      "#8B4513": "brown",
    };

    this.gameState.players.forEach((player) => {
      const sprite = this.gameState.trainSprites?.get(player.id);
      if (!sprite) return;

      const trainColor = colorMap[player.color.toUpperCase()] || "black";
      const trainProps = TRAIN_PROPERTIES[player.trainType];
      const spritePrefix = trainProps ? trainProps.spritePrefix : "train";
      const desiredTexture = `${spritePrefix}_${trainColor}`;
      const baseScale = 0.1;
      const desiredScale = spritePrefix === 'train_12' ? baseScale * 0.5 : baseScale;

      if ((sprite as any).texture?.key !== desiredTexture) {
        try {
          sprite.setTexture(desiredTexture);
        } catch (e) {
          console.warn("Failed to update train sprite texture:", e);
        }
      }

      // Keep scale in sync with texture family (fast sprites are larger).
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
   * Update train sprite interactivity based on whose turn it is
   * Only the local player's train should be interactive, and only when it's their turn
   */
  public updateTrainInteractivity(): void {
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
      this.gameState.currentPlayerIndex,
      this.gameState.players
    );

    // Update interactivity for all train sprites
    this.gameState.trainSprites?.forEach((sprite, playerId) => {
      const isLocalPlayerTrain = localPlayerId === playerId;
      
      // Only enable interactivity if:
      // 1. It's the local player's train
      // 2. It's the local player's turn
      const shouldBeInteractive = 
        isLocalPlayerTrain && 
        isLocalPlayerTurn;

      if (shouldBeInteractive) {
        // Make sprite interactive with hand cursor and set up the click handler
        sprite.setInteractive({ useHandCursor: true });
        this.setupTrainSpriteInteraction(sprite, playerId);
      } else {
        // Disable interactivity - train should not be clickable
        sprite.disableInteractive();
        sprite.removeAllListeners("pointerdown");
      }
    });
  }

  public async initializePlayerTrain(
    playerId: string,
    startX: number,
    startY: number,
    startRow: number,
    startCol: number
  ): Promise<void> {
    await this.updateTrainPosition(
      playerId,
      startX,
      startY,
      startRow,
      startCol
    );
  }

  public setDrawingMode(isDrawing: boolean): void {
    this.isDrawingMode = isDrawing;

    // When entering drawing mode, exit train movement mode if active
    if (isDrawing && this.isTrainMovementMode) {
      this.exitTrainMovementMode();
    }
  }

  public setPlayerHandDisplay(playerHandDisplay: PlayerHandDisplay): void {
    this.playerHandDisplay = playerHandDisplay;
  }

  public setHandContainer(container: Phaser.GameObjects.Container): void {
    this.handContainer = container;
  }

  public setUIManager(uiManager: UIManager): void {
    this.uiManager = uiManager;
  }
}
