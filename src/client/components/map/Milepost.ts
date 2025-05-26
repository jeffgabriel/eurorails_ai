import { MapElement } from "./MapElement";
import { GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

export class Milepost extends MapElement {
  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
  }

  draw(graphics: Phaser.GameObjects.Graphics): void {
    graphics.fillStyle(0x000000, 1);
    graphics.beginPath();
    graphics.arc(this.x, this.y, this.POINT_RADIUS, 0, Math.PI * 2);
    graphics.closePath();
    graphics.fill();
  }

  getDepth(): number {
    return 0; // Base depth for regular mileposts
  }
} 