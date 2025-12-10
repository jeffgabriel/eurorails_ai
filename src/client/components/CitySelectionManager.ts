import "phaser";
import { GameState, TerrainType } from "../../shared/types/GameTypes";
import { MapRenderer } from "./MapRenderer";
import SimpleDropDownList from "phaser3-rex-plugins/templates/ui/simpledropdownlist/SimpleDropDownList";
export class CitySelectionManager extends SimpleDropDownList {
  public scene: Phaser.Scene;
  private gameState: GameState;
  private mapRenderer: MapRenderer;
  private onCitySelected: (
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
  ) => Promise<void>;
  private dropdownDomElement: any | null = null; // RexUI DropDownList type
  private isHandCollapsed: () => boolean;
  private dropdown: Phaser.GameObjects.GameObject;
  private static style = {
    list: {
      maxHeight: 200,
      mouseWheelScroller: {
        focus: 2,
        speed: 0.1,
      },
      // createTrackCallback: function (scene) {
      //   return scene.rexUI.add.roundRectangle({ width: 10, color: 0x808588 });
      // },
      createThumbCallback: function (scene) {
        return scene.rexUI.add.roundRectangle({
          width: 14,
          height: 24,
          color: 0x363636,
        });
      },
      sliderAdaptThumbSize: false,
      space: { panel: 2 },
    },
    label: {
      space: { left: 5, right: 5, top: 5, bottom: 5 },
      // width: 210,
      // height: 30,
      background: { color: 0x444444 },
      text: {
        fontSize: 17,
        fontFamily: "Arial",
        fixedWidth: 150
      },
    },

    button: {
      space: { left: 10, right: 10, top: 10, bottom: 10 },
      background: {
        color: 0xbdb7ab,
        strokeWidth: 0,
        "hover.strokeColor": 0xffffff,
        "hover.strokeWidth": 2,
      },
      text: {
        fontSize: 16,
        fontFamily: "Arial",
      },
    },
  };

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    mapRenderer: MapRenderer,
    onCitySelected: (
      playerId: string,
      x: number,
      y: number,
      row: number,
      col: number
    ) => Promise<void>,
    isHandCollapsed?: () => boolean
  ) { //@ts-ignore: Type 'number' is not assignable to type 'boolean | 0 | 2 | 1 | undefined'
    super(scene, CitySelectionManager.style);
    this.scene = scene;
    this.gameState = gameState;
    this.mapRenderer = mapRenderer;
    this.setInteractive(true);
    const playerId =
      this.gameState.players[this.gameState.currentPlayerIndex].id;
    this.isHandCollapsed = isHandCollapsed || (() => false);
    if (!this.shouldShowCitySelectionForPlayer(playerId)) {
      this.visible = false;
      return;
    }
    this.onCitySelected = onCitySelected;
    this.on("button.click", (_dropDownList, _listPanel, selectedOption) => {
      const selectedCity = selectedOption.value;
      this.onCitySelected(
        playerId,
        selectedCity.x,
        selectedCity.y,
        selectedCity.row,
        selectedCity.col
      );
      this.setText(selectedOption.text);
    });
  }

  // private preventWheel = (e: WheelEvent) => {
  //   console.log("preventWheel", e);
  //   e.preventDefault();
  //   e.stopPropagation();
  // };

  public init(): void {
    this.createOptions();
    this.resetDisplayContent("Select Starting City...");
    super.layout();
  }

  private createOptions(): void {
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

    // Create options array for the dropdown
    const options = majorCities.map((city) => ({
      text: city.name,
      value: {
        name: city.name,
        x: city.x,
        y: city.y,
        row: city.row,
        col: city.col,
      },
    }));

    this.setOptions(options);
  }

  public shouldShowCitySelectionForPlayer(playerId: string): boolean {
    // Don't show dropdown if hand is collapsed
    if (this.isHandCollapsed()) {
      return false;
    }

    // Find the player
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) {
      return false;
    }

    // Check if this is the current player
    const isCurrentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex].id === playerId;
    if (!isCurrentPlayer) {
      return false;
    }

    // Check if player already has a position
    if (player.trainState && player.trainState.position) {
      return false;
    }

    return true;
  }
}
