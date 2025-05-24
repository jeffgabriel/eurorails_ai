import { City } from "./City";
import { GridPoint, CityData } from "../../../shared/types/GameTypes";
import "phaser";

export class SmallCity extends City {
  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
  }

  draw(graphics: Phaser.GameObjects.Graphics, container: Phaser.GameObjects.Container): void {
    graphics.fillStyle(this.CITY_COLORS[this.cityData.type], 0.7);
    graphics.lineStyle(2, 0x000000, 0.7);
    const radius = this.CITY_RADIUS[this.cityData.type];
    graphics.fillRect(
      this.x - radius,
      this.y - radius,
      radius * 2,
      radius * 2
    );
    graphics.strokeRect(
      this.x - radius,
      this.y - radius,
      radius * 2,
      radius * 2
    );
    this.drawMilepostDot(graphics);
    // Add city name
    this.addCityName(container, "8px");
    this.addLoadSpritesToCity(this.x + this.GRID_MARGIN, this.y + this.GRID_MARGIN, this.cityData.name, this.cityData.type, container);
  }
} 