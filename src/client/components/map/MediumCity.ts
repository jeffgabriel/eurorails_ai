import { City } from "./City";
import { GridPoint, CityData } from "../../../shared/types/GameTypes";
import "phaser";
import { CITY_COLOR } from "./City";

export class MediumCity extends City {
  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
  }

  draw(graphics: Phaser.GameObjects.Graphics, container: Phaser.GameObjects.Container): void {
    graphics.fillStyle(CITY_COLOR, 0.7);
    graphics.lineStyle(2, 0x000000, 0.7);
    const scalerRadius = 2.7;
    const scalerX = 1.35;
    const scalerY = 1.35;
    const radius = this.CITY_RADIUS[this.cityData.type as keyof typeof this.CITY_RADIUS] || 8;
    graphics.fillRect(
      this.x - radius * scalerX,
      this.y - radius * scalerY,
      radius * scalerRadius,
      radius * scalerRadius
    );
    graphics.strokeRect(
      this.x - radius * scalerX,
      this.y - radius * scalerY,
      radius * scalerRadius,
      radius * scalerRadius
    );
    this.drawMilepostDot(graphics);
    // Add city name
    this.addCityName(container, "10px");
    this.addLoadSpritesToCity(this.x, this.y, this.cityData.name, this.cityData.type, container);
  }
} 