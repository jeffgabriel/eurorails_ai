import "phaser";
import { GameState, TerrainType } from "../../shared/types/GameTypes";
import { MapRenderer } from "./MapRenderer";

export class CitySelectionManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private mapRenderer: MapRenderer;
  private onCitySelected: (playerId: string, x: number, y: number, row: number, col: number) => Promise<void>;
  private dropdownDomElement: Phaser.GameObjects.DOMElement | null = null;
  
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

    // Remove any existing dropdown DOM element
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

    // Create dropdown (as a DOM element)
    const dropdown = document.createElement("select");
    dropdown.className = "city-selection-dropdown";
    dropdown.style.width = "180px";
    dropdown.style.padding = "5px";
    dropdown.style.backgroundColor = "#444444";
    dropdown.style.color = "#ffffff";
    dropdown.style.border = "1px solid #666666";
    dropdown.style.fontSize = "16px";
    dropdown.style.fontFamily = "Arial, sans-serif";
    dropdown.style.pointerEvents = "auto";

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

    // Add the dropdown as a Phaser DOM element at the player info area (x=820, y=hand area)
    const handY = this.scene.scale.height - 280 + 20; // 20px from top of hand area
    this.dropdownDomElement = this.scene.add.dom(820, handY, dropdown);
    this.dropdownDomElement.setOrigin(0, 0);
    this.dropdownDomElement.setDepth(1000); // Ensure it appears above other elements
  }
  
  public cleanupCityDropdowns(): void {
    // Remove dropdown DOM element from scene if present
    if (this.dropdownDomElement) {
      this.dropdownDomElement.destroy();
      this.dropdownDomElement = null;
    }
  }
}