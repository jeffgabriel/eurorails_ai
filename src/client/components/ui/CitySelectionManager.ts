import "phaser";
import { GameState, TerrainType } from "../../../shared/types/GameTypes";
import { MapRenderer } from "../MapRenderer";

export class CitySelectionManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private mapRenderer: MapRenderer;
  private onCitySelected: (playerId: string, x: number, y: number, row: number, col: number) => Promise<void>;
  
  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    mapRenderer: MapRenderer,
    onCitySelected: (playerId: string, x: number, y: number, row: number, col: number) => Promise<void>
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.mapRenderer = mapRenderer;
    this.onCitySelected = onCitySelected;
  }
  
  public showCitySelectionForPlayer(playerId: string): void {
    // Only show selection for current player
    
    // Find the player
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) {
      return;
    }

    // Check if this is the current player
    const isCurrentPlayer = this.gameState.players[this.gameState.currentPlayerIndex].id === playerId;
    if (!isCurrentPlayer) {
      return;
    }

    // Check if player already has a position
    if (player.trainState && player.trainState.position) {
      return;
    }

    // Remove any existing city selection dropdowns
    this.cleanupCityDropdowns();

    // Find all major cities from the grid
    const majorCities = [
      ...new Map(
        this.mapRenderer.gridPoints
          .flat()
          .filter((point) => point?.city?.type === TerrainType.MajorCity)
          .map((point) => [
            point.city!.name, // use name as key for uniqueness
            {
              name: point.city!.name,
              x: point.x,
              y: point.y,
              row: point.row,
              col: point.col,
            },
          ])
      ).values(),
    ];

    // Create dropdown (using HTML overlay)
    const dropdown = document.createElement("select");
    dropdown.className = "city-selection-dropdown"; // Add class for easy cleanup
    dropdown.style.position = "absolute";
    dropdown.style.left = "820px"; // Align with player info
    dropdown.style.top = `${this.scene.scale.height - 140}px`; // Fixed position aligned with player info
    dropdown.style.width = "180px";
    dropdown.style.padding = "5px";
    dropdown.style.backgroundColor = "#444444";
    dropdown.style.color = "#ffffff";
    dropdown.style.border = "1px solid #666666";
    dropdown.style.zIndex = "1000"; // Ensure it appears above other elements

    // Add prompt option
    const promptOption = document.createElement("option");
    promptOption.value = "";
    promptOption.text = "Choose Starting City...";
    promptOption.disabled = true;
    promptOption.selected = true;
    dropdown.appendChild(promptOption);

    // Add options for each major city
    majorCities.forEach((city) => {
      const option = document.createElement("option");
      option.value = JSON.stringify({
        name: city.name,
        x: city.x,
        y: city.y,
        row: city.row,
        col: city.col,
      });
      option.text = city.name;
      dropdown.appendChild(option);

      // If this city matches player's current position, select it
      if (player.trainState?.position && 
          player.trainState.position.row === city.row && 
          player.trainState.position.col === city.col) {
        option.selected = true;
        promptOption.selected = false;
      }
    });

    // Handle selection
    dropdown.onchange = () => {
      if (!dropdown.value) return; // Don't process if prompt is selected
      const selectedCity = JSON.parse(dropdown.value);
      this.onCitySelected(
        playerId,
        selectedCity.x,
        selectedCity.y,
        selectedCity.row,
        selectedCity.col
      );
      // Note: No longer removing dropdown here - it will be removed when track is built
    };

    document.body.appendChild(dropdown);
  }
  
  public cleanupCityDropdowns(): void {
    const existingDropdowns = document.querySelectorAll(
      ".city-selection-dropdown"
    );
    existingDropdowns.forEach((dropdown) => {
      document.body.removeChild(dropdown);
    });
  }
}