import "phaser";
import SimpleDropDownList from "phaser3-rex-plugins/templates/ui/simpledropdownlist/SimpleDropDownList";
import { TerrainType } from "../../shared/types/GameTypes";
import { MapRenderer } from "./MapRenderer";
export type CityListItem = {
  name: string;
  terrain: TerrainType;
  x: number;
  y: number;
  row: number;
  col: number;
};

type CityListDropDownStyle = {
  list?: {
    maxHeight?: number;
    mouseWheelScroller?: {
      focus?: number;
      speed?: number;
    };
    createThumbCallback?: (scene: Phaser.Scene) => Phaser.GameObjects.GameObject;
    sliderAdaptThumbSize?: boolean;
    space?: { panel?: number };
  };
  label?: {
    space?: { left?: number; right?: number; top?: number; bottom?: number };
    background?: { color?: number };
    text?: {
      fontSize?: number;
      fontFamily?: string;
      fixedWidth?: number;
    };
  };
  button?: {
    space?: { left?: number; right?: number; top?: number; bottom?: number };
    background?: {
      color?: number;
      strokeWidth?: number;
      "hover.strokeColor"?: number;
      "hover.strokeWidth"?: number;
    };
    text?: {
      fontSize?: number;
      fontFamily?: string;
    };
  };
};

export class CityListDropDown extends SimpleDropDownList {
  private mapRenderer: MapRenderer;
  private selectedCity: CityListItem | null = null;

  private static readonly style: CityListDropDownStyle = {
    list: {
      maxHeight: 220,
      mouseWheelScroller: {
        focus: 2,
        speed: 0.15,
      },
      createThumbCallback: function (scene: Phaser.Scene) {
        return (scene as any).rexUI.add.roundRectangle({
          width: 14,
          height: 24,
          color: 0x363636,
        });
      },
      sliderAdaptThumbSize: false,
      space: { panel: 2 },
    },
    label: {
      space: { left: 8, right: 8, top: 6, bottom: 6 },
      background: { color: 0x444444 },
      text: {
        fontSize: 16,
        fontFamily: "Arial",
        fixedWidth: 250,
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

  constructor(scene: Phaser.Scene, mapRenderer: MapRenderer) {
    // @ts-ignore rexUI types are not declared
    super(scene, CityListDropDown.style);
    this.mapRenderer = mapRenderer;
    this.setInteractive(true);

    this.on("button.click", (_dropDownList: any, _listPanel: any, selectedOption: any) => {
      const selectedCity = selectedOption?.value as CityListItem | undefined;
      if (!selectedCity) return;
      this.selectedCity = selectedCity;
      this.setText(selectedOption.text);
    });
  }

  public init(): void {
    this.setOptions(this.buildOptions());
    this.resetDisplayContent("Select a city…");
    super.layout();
  }

  public getSelectedCity(): CityListItem | null {
    return this.selectedCity;
  }

  private buildOptions(): Array<{ text: string; value: CityListItem }> {
    const points = this.mapRenderer.gridPoints?.flat?.() ?? [];

    // Group all city points by normalized name.
    const grouped: Map<string, CityListItem[]> = new Map();
    for (const point of points) {
      const name = point?.city?.name;
      const terrain = point?.terrain;
      if (!name || typeof terrain === "undefined") continue;
      if (
        terrain !== TerrainType.MajorCity &&
        terrain !== TerrainType.MediumCity &&
        terrain !== TerrainType.SmallCity
      ) {
        continue;
      }

      const key = name.trim().toLowerCase();
      if (!key) continue;

      const item: CityListItem = {
        name: name.trim(),
        terrain,
        x: point.x,
        y: point.y,
        row: point.row,
        col: point.col,
      };

      const arr = grouped.get(key) ?? [];
      arr.push(item);
      grouped.set(key, arr);
    }

    const deduped: CityListItem[] = [];
    for (const group of grouped.values()) {
      // For cities with multiple points (e.g. major cities), use the centroid.
      let sumX = 0;
      let sumY = 0;
      for (const g of group) {
        sumX += g.x;
        sumY += g.y;
      }
      const first = group[0];
      deduped.push({
        ...first,
        x: sumX / group.length,
        y: sumY / group.length,
      });
    }

    deduped.sort((a, b) => a.name.localeCompare(b.name));

    return deduped.map((city) => ({
      text: city.name,
      value: city,
    }));
  }
}


