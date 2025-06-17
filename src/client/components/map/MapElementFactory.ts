import { TerrainType, GridPoint, CityData } from "../../../shared/types/GameTypes";
import { MapElement } from "./MapElement";
import { Milepost } from "./Milepost";
import { Mountain } from "./Mountain";
import { Alpine } from "./Alpine";
import { MajorCity } from "./MajorCity";
import { MediumCity } from "./MediumCity";
import { SmallCity } from "./SmallCity";
import { FerryPort } from "./FerryPort";
import "phaser";

export class MapElementFactory {
  static createMapElement(
    scene: Phaser.Scene,
    terrain: TerrainType,
    point: GridPoint,
    x: number,
    y: number
  ): MapElement {
    // Handle cities first
    if (point && point.city) {
      switch (point.city.type) {
        case TerrainType.MajorCity:
          // Only render as MajorCity if this is the center (has connectedPoints and non-empty)
          if (point.city.connectedPoints && point.city.connectedPoints.length > 0) {
            return new MajorCity(scene, point, x, y);
          } else {
            // Outposts: fall through to default rendering below
            break;
          }
        case TerrainType.MediumCity:
          return new MediumCity(scene, point, x, y);
        case TerrainType.SmallCity:
          return new SmallCity(scene, point, x, y);
      }
    }

    // Handle terrain types
    switch (terrain) {
      case TerrainType.Mountain:
        return new Mountain(scene, point, x, y);
      case TerrainType.Alpine:
        return new Alpine(scene, point, x, y);
      case TerrainType.FerryPort:
        return new FerryPort(scene, point, x, y);
      case TerrainType.Clear:
      default:
        return new Milepost(scene, point, x, y);
    }
  }
} 