import { GridPoint } from "@/shared/types/GameTypes";
import { MapElement } from "./MapElement";
import { mapConfig } from "../../config/mapConfig";
import "phaser";
import { MapRenderer } from "../MapRenderer";

export class FerryPort extends MapElement {
  private readonly FERRY_ICON_SIZE = 14; // Size for the ferry icon

  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
  }
  getDepth(): number {
    return 2;
  }

  draw(graphics: Phaser.GameObjects.Graphics, container: Phaser.GameObjects.Container): void {
    let ferryPortIcons = this.scene.children.getByName(MapRenderer.FERRY_ICONS_CONTAINER_NAME) as Phaser.GameObjects.Container || this.scene.add.container().setName(MapRenderer.FERRY_ICONS_CONTAINER_NAME);
    let portNames = this.scene.children.getByName(MapRenderer.PORT_NAMES_CONTAINER_NAME) as Phaser.GameObjects.Container || this.scene.add.container().setName(MapRenderer.PORT_NAMES_CONTAINER_NAME);
    const sprite = this.scene.add.image(
      this.x + this.GRID_MARGIN,
      this.y + this.GRID_MARGIN,
      "ferry-port"
    ).setName(`ferryPort--${this.point.city?.name}`);
    sprite.setScale(1);
    sprite.setOrigin(0.5, 0.5);
    this.scene.textures.get('ferry-port').setFilter(Phaser.Textures.FilterMode.LINEAR);
    sprite.setDisplaySize(this.FERRY_ICON_SIZE, this.FERRY_ICON_SIZE);
    ferryPortIcons.add(sprite);

    // Find the ferry connection for this port
    const ferryConnection = mapConfig.ferryConnections?.find(ferry => {
      const [pointA, pointB] = ferry.connections;
      return (pointA.row === this.point.row && pointA.col === this.point.col) || (pointB.row === this.point.row && pointB.col === this.point.col);
    });

    // Calculate text position based on ferry connection
    let textX = this.x + this.GRID_MARGIN;
    let textY = this.y + this.GRID_MARGIN;
    let textOrigin = { x: 0.5, y: 0.5 }; // Default centered origin

    if (ferryConnection) {
      const [pointA, pointB] = ferryConnection.connections;
      const isPointA = pointA.row === this.point.row && pointA.col === this.point.col;
      const otherPoint = isPointA ? pointB : pointA;
      
      // Determine if text should be above or below based on relative position
      const isAbove = otherPoint.row < this.point.row || (otherPoint.row === this.point.row && otherPoint.col < this.point.col);
      
      if (isAbove) {
        textOrigin = { x: 0.0, y: -1.75 };
      } else {
        textOrigin = { x: 0.5, y: 2.5 };
      }
    }

    // Add ferry port name
    const portName = this.scene.add.text(
      textX,
      textY,
      this.point.city?.name || "Port", // Use city name if available, otherwise "Port"
      {
        color: "#000000",
        fontSize: "7px", // Smaller than small city (8px)
        fontFamily: "sans-serif",
      }
    );
    portName.setOrigin(textOrigin.x, textOrigin.y);
    portNames.add(portName);
  }
} 