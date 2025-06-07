import { MapElement } from "./MapElement";
import {
  TerrainType,
  CityData,
  GridPoint,
} from "../../../shared/types/GameTypes";
import { LoadService } from "../../services/LoadService";
import "phaser";
import { MapRenderer } from "../MapRenderer";

export const CITY_COLOR = 0xab0000;

export abstract class City extends MapElement {
  protected readonly CITY_RADIUS = {
    [TerrainType.MajorCity]: 30,
    [TerrainType.MediumCity]: 8,
    [TerrainType.SmallCity]: 12,
  };

  protected readonly POINT_RADIUS = 3; // Radius for the milepost dot
  private loadService: LoadService;
  protected cityData: CityData;

  constructor(scene: Phaser.Scene, point: GridPoint, x: number, y: number) {
    super(scene, point, x, y);
    this.loadService = LoadService.getInstance();
    this.cityData = point.city || {
      type: TerrainType.MajorCity,
      name: "Unknown",
      connectedPoints: [],
      availableLoads: [],
    };
  }

  protected addCityName(
    container: Phaser.GameObjects.Container,
    fontSize: string
  ): void {
    const cityName = this.scene.add.text(
      this.x + MapRenderer.GRID_MARGIN,
      this.y + MapRenderer.GRID_MARGIN - 18,
      this.cityData.name.toUpperCase(),
      {
        color: "#000000",
        fontSize: fontSize,
        font: "Arial",
      }
    );
    cityName.setOrigin(0.5, 0.5);
    container.add(cityName);
    this.scene.children.bringToTop(cityName);
  }

  getDepth(): number {
    return 2; // Cities should appear above terrain
  }

  protected drawMilepostDot(graphics: Phaser.GameObjects.Graphics): void {
    graphics.fillStyle(0x000000, 1);
    graphics.beginPath();
    graphics.arc(this.x, this.y, this.POINT_RADIUS, 0, Math.PI * 2);
    graphics.closePath();
    graphics.fill();
  }

  protected addLoadSpritesToCity(
    cityX: number,
    cityY: number,
    cityName: string,
    cityType: TerrainType,
    mapContainer: Phaser.GameObjects.Container
  ): void {
    const loadDetails = this.loadService.getCityLoadDetails(cityName);
    if (!loadDetails || loadDetails.length === 0) return;

    // Calculate starting position for load sprites
    // First load: below the city, then bottom right, then counter-clockwise
    const radius = cityType === TerrainType.MajorCity ? 45 : 30;
    const loadCount = loadDetails.length;
    // Start angle: 90 degrees (below the city)
    const startAngle = Math.PI / 2;
    const angleStep = (-2 * Math.PI) / loadCount; // Negative for counter-clockwise

    loadDetails.forEach((load, index) => {
      try {
        if (!load || !load.loadType) {
          console.warn(
            `Invalid load data for city ${cityName} at index ${index}`
          );
          return;
        }

        const angle = startAngle + angleStep * index;
        const spriteX = cityX + MapRenderer.GRID_MARGIN + radius * Math.cos(angle);
        const spriteY = cityY + MapRenderer.GRID_MARGIN + radius * Math.sin(angle);

        const spriteKey = `load-${load.loadType.toLowerCase()}`;

        // Check if the sprite texture exists before creating the image
        if (!this.scene.textures.exists(spriteKey)) {
          console.warn(`Missing sprite texture for load type: ${spriteKey}`);
          return;
        }

        // Create sprite for the load
        const sprite = this.scene.add.image(spriteX, spriteY, spriteKey);

        // Configure sprite
        sprite.setAlpha(this.LOAD_SPRITE_OPACITY);
        sprite.setDepth(1); // Ensure it appears above the city but below UI elements
        sprite.setScale(0.8);
        // Add to container
        mapContainer.add(sprite);
      } catch (error) {
        console.warn(`Failed to add load sprite for ${cityName}:`, error);
      }
    });
  }
}
