import { MapElement } from "./MapElement";
import { GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

export class Alpine extends MapElement {
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
    graphics.lineStyle(1, 0x808080, 1); // Gray stroke
    graphics.stroke();
  }

  getDepth(): number {
    return 1; // Alpine should appear above regular mileposts
  }
} 