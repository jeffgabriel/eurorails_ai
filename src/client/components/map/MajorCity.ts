import { City } from "./City";
import { GridPoint, CityData } from "../../../shared/types/GameTypes";
import "phaser";
import { CITY_COLOR } from "./City";
import { MapRenderer } from "../MapRenderer";

export class MajorCity extends City {
  private centerX: number;
  private centerY: number;
  constructor(scene: Phaser.Scene, point: GridPoint, x: number, y: number) {
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

  draw(
    graphics: Phaser.GameObjects.Graphics,
    container: Phaser.GameObjects.Container
  ): void {
    if (
      !this.cityData.connectedPoints ||
      this.cityData.connectedPoints.length === 0
    ) {
      console.error(
        "Major city with empty connectedPoints:",
        this.cityData.name
      );
      return;
    }

    const poly = new Phaser.Geom.Polygon(
      this.getNeighborCoords(this.point.col, this.point.row)
    );
    graphics.blendMode = Phaser.BlendModes.MULTIPLY;
    graphics.lineStyle(.1, 0x000000, 1.0);
    graphics.fillStyle(CITY_COLOR, 0.8);
    graphics.fillPoints(poly.points, true, true);
    graphics.stroke();
    // Draw star at center
    this.drawStar(graphics, this.x, this.y, 8);
    this.addCityName(container);
    this.addLoadSpritesToCity(
      this.x,
      this.y,
      this.cityData.name,
      this.cityData.type,
      container
    );
  }

  private drawStar(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    radius: number
  ): void {
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
    graphics.stroke();
  }

  protected addCityName(
    container: Phaser.GameObjects.Container
  ): void {
    // Add city name centered in the hexagon
    const cityName = this.scene.add.text(
      this.centerX + MapRenderer.GRID_MARGIN,
      this.centerY + MapRenderer.GRID_MARGIN + 15, // Added offset to move below center point
      this.cityData.name,
      {
        color: "#000000",
        fontSize: "13px",
        fontStyle: "bold",
        fontFamily: "Arial",
      }
    );
    cityName.setOrigin(0.5, 0.5);
    cityName.setText(cityName.text.toUpperCase());
    container.add(cityName);
    this.scene.children.bringToTop(cityName);
  }

  private transformToXY(col: number, row: number) {
    const isOffsetRow = row % 2 === 1;
    const x =
      col * this.HORIZONTAL_SPACING +
      (isOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
    const y = row * this.VERTICAL_SPACING;
    return { x, y };
  }

  private getNeighborCoords(col: number, row: number) {
    const isOffsetRow = row % 2 === 1;
    const columnModifier = isOffsetRow ? +1 : 0;
    const neighborTransform = [
      { col: -1 + columnModifier, row: -1 }, // 0: top-left
      { col: 0 + columnModifier, row: -1 }, // 1: top-right
      { col: +1, row: 0 }, // 2: right
      { col: 0 + columnModifier, row: +1 }, // 3: bottom-right
      { col: -1 + columnModifier, row: +1 }, // 4: bottom-left
      { col: -1, row: 0 }, // 5: left
    ];
    return neighborTransform.map((transform) =>
      this.transformToXY(col + transform.col, row + transform.row)
    );
  }
}
