import { MapElement } from "./MapElement";
import { GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

export class Mountain extends MapElement {
  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
  }

  draw(graphics: Phaser.GameObjects.Graphics): void {
    const triangleHeight = this.POINT_RADIUS * 2;
    graphics.beginPath();
    graphics.moveTo(this.x, this.y - triangleHeight);
    graphics.lineTo(this.x - triangleHeight, this.y + triangleHeight);
    graphics.lineTo(this.x + triangleHeight, this.y + triangleHeight);
    graphics.closePath();
    graphics.fillStyle(0x964b00, 1); // Brown fill
    graphics.fill();
    graphics.stroke();
  }

  getDepth(): number {
    return 1; // Mountains should appear above regular mileposts
  }
} 