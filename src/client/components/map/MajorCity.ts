import { City } from "./City";
import { GridPoint, CityData } from "../../../shared/types/GameTypes";
import "phaser";
import { CITY_COLOR } from "./City";

export class MajorCity extends City {
  private centerX: number;
  private centerY: number;
  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
    const centerPoint = {
            row: point.row,
            col: point.col,
          };
    const centerIsOffsetRow = centerPoint.row % 2 === 1;
    this.centerX =
         centerPoint.col * this.HORIZONTAL_SPACING +
         (centerIsOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
    this.centerY = centerPoint.row * this.VERTICAL_SPACING;
  }

  draw(graphics: Phaser.GameObjects.Graphics, container: Phaser.GameObjects.Container): void {
    if (!this.cityData.connectedPoints || this.cityData.connectedPoints.length === 0) {
      console.error("Major city with empty connectedPoints:", this.cityData.name);
      return;
    }

    const hexRadius = 43;
    graphics.fillStyle(CITY_COLOR, 0.8);
    graphics.blendMode = Phaser.BlendModes.MULTIPLY;
    graphics.lineStyle(2, 0x000000, 0.7);
    graphics.beginPath();

    // Draw hexagon
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3;
      const x_i = this.x + hexRadius * Math.cos(angle);
      const y_i = this.y + hexRadius * Math.sin(angle);
      if (i === 0) {
        graphics.moveTo(x_i, y_i);
      } else {
        graphics.lineTo(x_i, y_i);
      }
    }
    graphics.closePath();
    graphics.fill();
    graphics.stroke();

    // Draw star at center
    this.drawStar(graphics, this.x, this.y, 8);
    this.addCityName(container, "12px");
    this.addLoadSpritesToCity(this.x + this.GRID_MARGIN, this.y + this.GRID_MARGIN, this.cityData.name, this.cityData.type, container);
  }

  private drawStar(graphics: Phaser.GameObjects.Graphics, x: number, y: number, radius: number): void {
    const points = 5;
    const innerRadius = radius * 0.4;

    graphics.beginPath();
    for (let i = 0; i <= points * 2; i++) {
      const r = i % 2 === 0 ? radius : innerRadius;
      const angle = (i * Math.PI) / points;
      const pointX = x + r * Math.sin(angle);
      const pointY = y - r * Math.cos(angle);

      if (i === 0) {
        graphics.moveTo(pointX, pointY);
      } else {
        graphics.lineTo(pointX, pointY);
      }
    }
    graphics.closePath();
    graphics.fillStyle(0x000000, 1);
    graphics.fill();
    graphics.lineStyle(1, 0x000000);
    graphics.stroke();
  }

  protected addCityName(container: Phaser.GameObjects.Container, fontSize: string): void {
     // Add city name centered in the hexagon
      const cityName = this.scene.add.text(
        this.centerX + this.GRID_MARGIN,
        this.centerY + this.GRID_MARGIN + 15, // Added offset to move below center point
        this.cityData.name,
        {
          color: "#000000",
          font: "Arial",
          fontSize: "12px",
          fontStyle: "bold",
        }
      );
      cityName.setOrigin(0.5, 0.5);
      cityName.setText(cityName.text.toUpperCase());
      container.add(cityName);
      this.scene.children.bringToTop(cityName);
  }
} 