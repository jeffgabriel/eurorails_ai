import "phaser";
import {
  GameState,
  GridPoint,
  Player,
  Point,
  TerrainType,
  CityData,
} from "../../shared/types/GameTypes";
import { PlayerStateService } from "../services/PlayerStateService";
import { LoadService } from "../services/LoadService";
import { PlayerHandDisplay } from "./PlayerHandDisplay";
import { UIManager } from "./UIManager";
import { TurnActionManager } from "./TurnActionManager";

/**
 * CityArrivalHandler manages city arrival events and load dialog display.
 *
 * Responsibilities:
 * - Detect when train arrives at a city
 * - Show load pickup/delivery dialog
 * - Coordinate with LoadService for available loads
 * - Handle dialog lifecycle (open, close, callbacks)
 */
export class CityArrivalHandler {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private playerStateService: PlayerStateService;
  private playerHandDisplay: PlayerHandDisplay | null = null;
  private handContainer: Phaser.GameObjects.Container | null = null;
  private uiManager: UIManager | null = null;
  private turnActionManager: TurnActionManager | null = null;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    playerStateService: PlayerStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.playerStateService = playerStateService;
  }

  /**
   * Set the player hand display reference (late-bound dependency).
   */
  public setPlayerHandDisplay(display: PlayerHandDisplay): void {
    this.playerHandDisplay = display;
  }

  /**
   * Set the hand container reference (late-bound dependency).
   */
  public setHandContainer(container: Phaser.GameObjects.Container): void {
    this.handContainer = container;
  }

  /**
   * Set the UI manager reference (late-bound dependency).
   */
  public setUIManager(uiManager: UIManager): void {
    this.uiManager = uiManager;
  }

  /**
   * Set the turn action manager reference (late-bound dependency).
   */
  public setTurnActionManager(turnActionManager: TurnActionManager): void {
    this.turnActionManager = turnActionManager;
  }

  /**
   * Check if a grid point is a city (major, medium, small, or ferry-city hybrid).
   *
   * Ferry-city hybrids (Dublin, Belfast) are locations with TerrainType.FerryPort
   * that also have city data attached. These function as both ferry ports AND cities,
   * allowing trains to load/unload goods.
   */
  public isCity(gridPoint: GridPoint): boolean {
    // Standard city terrain check
    const isCityTerrain = (
      gridPoint.terrain === TerrainType.MajorCity ||
      gridPoint.terrain === TerrainType.MediumCity ||
      gridPoint.terrain === TerrainType.SmallCity
    );

    // Ferry-city hybrid check (Dublin, Belfast)
    // These are ferry ports that also function as cities
    const isFerryCity = (
      gridPoint.terrain === TerrainType.FerryPort &&
      gridPoint.city !== undefined
    );

    return isCityTerrain || isFerryCity;
  }

  /**
   * Check if two points are at the same grid position.
   */
  public isSamePoint(point1: Point | null, point2: Point | null): boolean {
    if (point1 && point2) {
      return point1.row === point2.row && point1.col === point2.col;
    }
    return false;
  }

  /**
   * Handle city arrival for a player.
   * Shows the load dialog if the train has loads or the city has available loads.
   *
   * @param currentPlayer - The player arriving at the city
   * @param milepost - The grid point where the player arrived
   */
  public async handleArrival(
    currentPlayer: Player,
    milepost: GridPoint
  ): Promise<void> {
    // Only show dialog if this is the local player
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    if (!localPlayerId || currentPlayer.id !== localPlayerId) {
      return;
    }

    // Get city data from the milepost
    const cityData = milepost.city;
    if (!cityData) {
      return;
    }

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

  /**
   * Show the load pickup/delivery dialog for a city.
   *
   * @param player - The player at the city
   * @param city - The city data
   */
  private showLoadDialog(player: Player, city: CityData): void {
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
      playerStateService: this.playerStateService,
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
}
