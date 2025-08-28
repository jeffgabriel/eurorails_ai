import { FerryConnection } from "../../../shared/types/GameTypes";
import { BaseMapElement } from "./MapElement";
import { MapRenderer } from "../MapRenderer";

export class FerryConnectionElement extends BaseMapElement {
  protected ferryConnection: FerryConnection;
  
  constructor(scene: Phaser.Scene, connection: FerryConnection) {
    super(scene);
    this.ferryConnection = connection;
  }

  draw(graphics: Phaser.GameObjects.Graphics, textContainer: Phaser.GameObjects.Text[]): void {
    graphics.lineStyle(6, 0x808080, 0.8);
    const [pointA, pointB] = this.ferryConnection.connections;
    const isFromOffsetRow = pointA.row % 2 === 1;
    const isToOffsetRow = pointB.row % 2 === 1;

    const fromX =
      pointA.col * this.HORIZONTAL_SPACING +
      (isFromOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
    const fromY = pointA.row * this.VERTICAL_SPACING;

    const toX =
      pointB.col * this.HORIZONTAL_SPACING +
      (isToOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
    const toY = pointB.row * this.VERTICAL_SPACING;

    // Draw the ferry connection line with a gentle, smooth upward arc
    graphics.beginPath();
    graphics.moveTo(fromX, fromY);

    // Calculate control point for the curve
    const curveMidX = (fromX + toX) / 2;
    const curveMidY = (fromY + toY) / 2;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const length = Math.sqrt(dx * dx + dy * dy);
    const offset = length * 0.1; // Smaller offset for a milder curve
    // Perpendicular vector (flip sign on perpY for upward arc)
    const perpX = -dy / length;
    const perpY = -dx / length; // negative for upward
    const controlX = curveMidX + perpX * offset;
    const controlY = curveMidY + perpY * offset;
    // Draw the curve using multiple segments for smoothness
    const segments = 24;
    let midCurveX = 0;
    let midCurveY = 0;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      // Quadratic Bézier formula
      const x =
        (1 - t) * (1 - t) * fromX + 2 * (1 - t) * t * controlX + t * t * toX;
      const y =
        (1 - t) * (1 - t) * fromY + 2 * (1 - t) * t * controlY + t * t * toY;
      graphics.lineTo(x, y);
      // Save midpoint at t=0.5 for the cost circle
      if (Math.abs(t - 0.5) < 1e-2) {
        midCurveX = x;
        midCurveY = y;
      }
    }
    graphics.stroke();
    // Draw the circled cost at the midpoint of the curve
    const text = this.drawCircledNumber(
      graphics,
      midCurveX,
      midCurveY,
      this.ferryConnection.cost
    );
    textContainer.push(text);
  }

  getDepth(): number {
    return 2;
  }

  private drawCircledNumber(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    number: number
  ): Phaser.GameObjects.Text {
    const CIRCLE_RADIUS = 7;

    // Draw white circle background
    graphics.lineStyle(2, 0x000000, 1); // Black border
    graphics.fillStyle(0xffffff, 1); // White fill
    graphics.beginPath();
    graphics.arc(x, y, CIRCLE_RADIUS, 0, Math.PI * 2);
    graphics.closePath();
    graphics.fill();
    graphics.stroke();

    // Add the number with even higher depth
    const text = this.scene.add.text(
      x + MapRenderer.GRID_MARGIN,
      y + MapRenderer.GRID_MARGIN,
      number.toString(),
      {
        color: "#000000",
        fontSize: "10px",
        fontStyle: "bold",
      }
    );
    text.setOrigin(0.5, 0.5);

    return text;
  }
}
