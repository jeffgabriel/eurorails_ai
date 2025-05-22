import { MapElement } from "./MapElement";
import { TerrainType, CityData, GridPoint } from "../../../shared/types/GameTypes";
import { LoadService } from "../../services/LoadService";
import "phaser";

export abstract class City extends MapElement {
  protected readonly CITY_COLORS = {
    [TerrainType.MajorCity]: 0xab0000, // Brighter red for major cities
    [TerrainType.MediumCity]: 0x9999ff, // Brighter blue for cities
    [TerrainType.SmallCity]: 0x99ff99, // Brighter green for small cities
  };

  protected readonly CITY_RADIUS = {
    [TerrainType.MajorCity]: 30, // Size for major city hexagon
    [TerrainType.MediumCity]: 12, // Reduced size for city circle
    [TerrainType.SmallCity]: 8, // Reduced size for small city square
  };

  protected readonly POINT_RADIUS = 3; // Radius for the milepost dot
  private loadService: LoadService;
  protected cityData: CityData;

  constructor(
    scene: Phaser.Scene,
    point: GridPoint,
    x: number,
    y: number
  ) {
    super(scene, point, x, y);
    this.loadService = LoadService.getInstance();
      this.cityData = point.city || {
        type: TerrainType.MajorCity,
        name: "Unknown",
        connectedPoints: [],
        availableLoads: []
      };
  }

  protected addCityName(container: Phaser.GameObjects.Container, fontSize: string): void {
    const cityName = this.scene.add.text(
      this.x + this.GRID_MARGIN,
      this.y + this.GRID_MARGIN - 15,
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
    // Position them in a full circle around the city
    const radius = cityType === TerrainType.MajorCity ? 45 : 30;
    const angleStep = (2 * Math.PI) / loadDetails.length; // Distribute evenly in a full circle
    const startAngle = -Math.PI / 2; // Start from top (-90 degrees)

    loadDetails.forEach((load, index) => {
      try {
        if (!load || !load.loadType) {
          console.warn(
            `Invalid load data for city ${cityName} at index ${index}`
          );
          return;
        }

        const angle = startAngle + angleStep * index;
        const spriteX = cityX + radius * Math.cos(angle);
        const spriteY = cityY + radius * Math.sin(angle);

        const spriteKey = `load-${load.loadType.toLowerCase()}`;

        // Check if the sprite texture exists before creating the image
        if (!this.scene.textures.exists(spriteKey)) {
          console.warn(`Missing sprite texture for load type: ${spriteKey}`);
          return;
        }

        // Create sprite for the load
        const sprite = this.scene.add.image(spriteX, spriteY, spriteKey,);

        // Configure sprite
        sprite.setAlpha(this.LOAD_SPRITE_OPACITY);
        sprite.setDepth(1); // Ensure it appears above the city but below UI elements
        sprite.setScale(.8);
        // Add to container
        mapContainer.add(sprite);

        // Add count indicator if more than 1 available
        if (load.count > 1) {
          try {
            const countText = this.scene.add.text(
              spriteX + this.LOAD_SPRITE_SIZE / 2, // Position count to the right of sprite
              spriteY - this.LOAD_SPRITE_SIZE / 2, // Position count above sprite
              load.count.toString(),
              {
                fontSize: "10px",
                color: "#000000",
                backgroundColor: "#ffffff",
                padding: { x: 2, y: 2 },
              }
            );
            countText.setOrigin(0.5, 0.5); // Center the text
            countText.setDepth(2);
            //this.mapContainer.add(countText);
          } catch (textError) {
            console.warn(
              `Failed to add count text for ${load.loadType} at ${cityName}:`,
              textError
            );
          }
        }
      } catch (error) {
        console.warn(`Failed to add load sprite for ${cityName}:`, error);
        // Continue with the next load
      }
    });
  }
} 