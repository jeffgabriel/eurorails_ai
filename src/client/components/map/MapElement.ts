import { GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

export abstract class BaseMapElement {
  protected readonly HORIZONTAL_SPACING = 40;
  protected readonly VERTICAL_SPACING = 40;
  protected readonly POINT_RADIUS = 3;
  protected readonly GRID_MARGIN = 100;
  protected readonly LOAD_SPRITE_SIZE = 16; // Increased from 16 to 24 (50% larger)
  protected readonly LOAD_SPRITE_OPACITY = 0.7; // Opacity for load sprites

  constructor(protected scene: Phaser.Scene) {
    this.scene = scene;
  }

  abstract getDepth(): number;
}
export abstract class MapElement extends BaseMapElement {
  constructor(
    protected scene: Phaser.Scene,
    protected point: GridPoint,
    protected x: number,
    protected y: number
  ) {
    super(scene);
  }

  abstract draw(
    graphics: Phaser.GameObjects.Graphics,
    container: Phaser.GameObjects.Container
  ): void;
}
