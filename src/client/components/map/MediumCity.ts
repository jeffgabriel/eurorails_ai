import { City } from "./City";
import { CityData, GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

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
    graphics.fillStyle(this.CITY_COLORS[this.cityData.type], 0.7);
    graphics.lineStyle(2, 0x000000, 0.7);
    graphics.beginPath();
    graphics.arc(
      this.x,
      this.y,
      this.CITY_RADIUS[this.cityData.type],
      0,
      Math.PI * 2
    );
    graphics.closePath();
    graphics.fill();
    graphics.stroke();
    this.drawMilepostDot(graphics);
    // Add city name
    this.addCityName(container, "10px");
    this.addLoadSpritesToCity(this.x + this.GRID_MARGIN, this.y + this.GRID_MARGIN, this.cityData.name, this.cityData.type, container);
  }
} 