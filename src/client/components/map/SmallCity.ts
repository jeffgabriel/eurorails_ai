import { City } from "./City";
import { CityData, GridPoint } from "../../../shared/types/GameTypes";
import "phaser";
import { CITY_COLOR } from "./City";

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
    graphics.fillStyle(CITY_COLOR, 0.7);
    graphics.lineStyle(2, 0x000000, 0.7);
    graphics.beginPath();
    graphics.arc(
      this.x,
      this.y,
      this.CITY_RADIUS[this.cityData.type as keyof typeof this.CITY_RADIUS] || 12,
      0,
      Math.PI * 2
    );
    graphics.closePath();
    graphics.fill();
    graphics.stroke();
    this.drawMilepostDot(graphics);
    // Add city name
    this.addCityName(container, "11px");
    this.addLoadSpritesToCity(this.x, this.y, this.cityData.name, this.cityData.type, container);
  }
} 