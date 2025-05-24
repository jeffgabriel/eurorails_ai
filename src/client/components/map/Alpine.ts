import { MapElement } from "./MapElement";
import { GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

export class Alpine extends MapElement {
  constructor(scene: Phaser.Scene, point: GridPoint, x: number, y: number) {
    super(scene, point, x, y);
  }

  draw(graphics: Phaser.GameObjects.Graphics): void {

    let triangle = Phaser.Geom.Triangle.BuildEquilateral(0, 0, 18 );
    let triangleFill = Phaser.Geom.Triangle.BuildEquilateral(0, 0, 8 );
    triangle = Phaser.Geom.Triangle.CenterOn(triangle, this.x - this.POINT_RADIUS, this.y + this.POINT_RADIUS);
    triangleFill = Phaser.Geom.Triangle.CenterOn(triangleFill, this.x - this.POINT_RADIUS, this.y + this.POINT_RADIUS);
    // Fill triangle
    graphics.fillStyle(0x000000, 1);
    graphics.fillTriangleShape(triangle);
    graphics.fillStyle(0xffffff, 1);
    graphics.fillTriangleShape(triangleFill);
  }

  getDepth(): number {
    return 1; // Alpine should appear above regular mileposts
  }
}
