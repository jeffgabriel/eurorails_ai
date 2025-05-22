import { GridPoint } from "../../../shared/types/GameTypes";
import "phaser";

export abstract class MapElement {
  protected readonly HORIZONTAL_SPACING = 35;
  protected readonly VERTICAL_SPACING = 35;
  protected readonly POINT_RADIUS = 3;
  protected readonly GRID_MARGIN = 100;
  protected readonly LOAD_SPRITE_SIZE = 16; // Increased from 16 to 24 (50% larger)
  protected readonly LOAD_SPRITE_OPACITY = 0.7; // Opacity for load sprites

  constructor(
    protected scene: Phaser.Scene,
    protected point: GridPoint,
    protected x: number,
    protected y: number
  ) {}

  abstract draw(graphics: Phaser.GameObjects.Graphics, container: Phaser.GameObjects.Container): void;
  abstract getDepth(): number;
} 