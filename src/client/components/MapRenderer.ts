import "phaser";
import { mapConfig } from "../config/mapConfig";
import {
  TerrainType,
  GridPoint,
  Point,
  CityData,
} from "../../shared/types/GameTypes";
import { GameState } from "../../shared/types/GameTypes";
import { TrackDrawingManager } from "../components/TrackDrawingManager";
import { LoadService } from "../services/LoadService";

// All coordinates in configuration and rendering are zero-based. Do not add or subtract 1 from row/col anywhere in this file.

export class MapRenderer {
  // Grid configuration
  private readonly HORIZONTAL_SPACING = 35;
  private readonly VERTICAL_SPACING = 35;
  private readonly POINT_RADIUS = 3;
  private readonly GRID_MARGIN = 100; // Increased margin around the grid
  private readonly FERRY_ICON_SIZE = 14; // Size for the ferry icon

  private readonly terrainColors = {
    [TerrainType.Clear]: 0x000000,
    [TerrainType.Water]: 0x0000ff,
    [TerrainType.Mountain]: 0x964b00,
    [TerrainType.Alpine]: 0x808080,
    [TerrainType.FerryPort]: 0xffa500,
  };

  private readonly CITY_COLORS = {
    [TerrainType.MajorCity]: 0xab0000, // Brighter red for major cities
    [TerrainType.MediumCity]: 0x9999ff, // Brighter blue for cities
    [TerrainType.SmallCity]: 0x99ff99, // Brighter green for small cities
  };

  private readonly CITY_RADIUS = {
    [TerrainType.MajorCity]: 30, // Size for major city hexagon
    [TerrainType.MediumCity]: 12, // Reduced size for city circle
    [TerrainType.SmallCity]: 8, // Reduced size for small city square
  };

  private readonly LOAD_SPRITE_SIZE = 24; // Increased from 16 to 24 (50% larger)
  private readonly LOAD_SPRITE_OPACITY = 0.7; // Opacity for load sprites

  private scene: Phaser.Scene;
  private mapContainer: Phaser.GameObjects.Container;
  public gridPoints: GridPoint[][] = [];
  private trackDrawingManager: TrackDrawingManager;
  private backgroundGraphics: Phaser.GameObjects.Graphics;
  private loadService: LoadService;

  constructor(
    scene: Phaser.Scene,
    mapContainer: Phaser.GameObjects.Container,
    gameState: GameState,
    trackDrawingManager: TrackDrawingManager
  ) {
    this.scene = scene;
    this.mapContainer = mapContainer;
    this.trackDrawingManager = trackDrawingManager;
    this.loadService = LoadService.getInstance();

    // Initialize background graphics with lowest depth
    this.backgroundGraphics = this.scene.add.graphics();
    this.backgroundGraphics.setDepth(-1);
    this.mapContainer.add(this.backgroundGraphics);
  }

  public calculateMapDimensions() {
    const width =
      mapConfig.width * this.HORIZONTAL_SPACING + this.GRID_MARGIN * 2;
    const height =
      mapConfig.height * this.VERTICAL_SPACING + this.GRID_MARGIN * 2;
    return { width, height };
  }

  private addLoadSpritesToCity(
    cityX: number,
    cityY: number,
    cityName: string,
    cityType: TerrainType
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
        const sprite = this.scene.add.image(spriteX, spriteY, spriteKey);

        // Configure sprite
        sprite.setAlpha(this.LOAD_SPRITE_OPACITY);
        sprite.setDepth(1); // Ensure it appears above the city but below UI elements

        // Add to container
        this.mapContainer.add(sprite);

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
            this.mapContainer.add(countText);
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

  private drawCityWithLoads(
    graphics: Phaser.GameObjects.Graphics,
    point: Point,
    config: { city: CityData; terrain: TerrainType }
  ): void {
    const { city } = config;

    // Defensive: Check connectedPoints for major cities
    if (city.type === TerrainType.MajorCity) {
      if (!city.connectedPoints || city.connectedPoints.length === 0) {
        // eslint-disable-next-line no-console
        console.error(
          "drawCityWithLoads: city.connectedPoints is missing or empty for",
          city.name,
          city
        );
        return;
      }
      const centerPoint = {
        row: point.row,
        col: point.col,
      };
      if (
        !centerPoint ||
        typeof centerPoint.row !== "number" ||
        typeof centerPoint.col !== "number"
      ) {
        // eslint-disable-next-line no-console
        console.error(
          "drawCityWithLoads: centerPoint is invalid for",
          city.name,
          centerPoint,
          city
        );
        return;
      }

      // Draw a regular hexagon centered at the city center
      const centerIsOffsetRow = centerPoint.row % 2 === 1;
      const centerX =
        centerPoint.col * this.HORIZONTAL_SPACING +
        (centerIsOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
      const centerY = centerPoint.row * this.VERTICAL_SPACING;
      const hexRadius = 36; // Adjust as needed for visual size

      // Display debug info for connected points
      console.debug(
        `City ${city.name} at (${centerPoint.row},${centerPoint.col}) has ${city.connectedPoints.length} connected points:`,
        city.connectedPoints.map((cp) => `(${cp.row},${cp.col})`).join(", ")
      );

      graphics.fillStyle(this.CITY_COLORS[TerrainType.MajorCity], .8);
      graphics.blendMode = Phaser.BlendModes.MULTIPLY;
      graphics.lineStyle(2, 0x000000, 0.7);
      graphics.beginPath();

      // For a flat-topped hexagon, the top and bottom sides are horizontal
      // Start at the right-top vertex and go clockwise
      for (let i = 0; i < 6; i++) {
        // For flat-topped hex, angles start at 0° and go by 60° increments
        // 0° = right-top, 60° = right, 120° = right-bottom, 180° = left-bottom, 240° = left, 300° = left-top
        const angle = (i * Math.PI) / 3;
        const x_i = centerX + hexRadius * Math.cos(angle);
        const y_i = centerY + hexRadius * Math.sin(angle);
        if (i === 0) {
          graphics.moveTo(x_i, y_i);
        } else {
          graphics.lineTo(x_i, y_i);
        }
      }
      graphics.closePath();
      graphics.fill();
      graphics.stroke();

      // Draw star at center point
      this.drawStar(graphics, centerX, centerY, 8);

      // Add city name centered in the hexagon
      const cityName = this.scene.add.text(
        centerX + this.GRID_MARGIN,
        centerY + this.GRID_MARGIN + 15, // Added offset to move below center point
        city.name,
        {
          color: "#000000",
          font: "Arial",
          fontSize: "12px",
          fontStyle: "bold",
        }
      );
      cityName.setOrigin(0.5, 0.5);
      cityName.setText(cityName.text.toUpperCase());
      this.mapContainer.add(cityName);

      // Add load sprites using the center coordinates with margin
      this.addLoadSpritesToCity(
        centerX + this.GRID_MARGIN,
        centerY + this.GRID_MARGIN,
        city.name,
        city.type
      );
      return;
    }

    // Medium and small cities (unchanged)
    if (city.type === TerrainType.MediumCity) {
      graphics.fillStyle(this.CITY_COLORS[TerrainType.MediumCity], 0.7);
      graphics.lineStyle(2, 0x000000, 0.7);
      graphics.beginPath();
      graphics.arc(
        point.x,
        point.y,
        this.CITY_RADIUS[TerrainType.MediumCity],
        0,
        Math.PI * 2
      );
      graphics.closePath();
      graphics.fill();
      graphics.stroke();

      // Add city name
      const cityName = this.scene.add.text(
        point.x + this.GRID_MARGIN,
        point.y + this.GRID_MARGIN - 15,
        city.name.toUpperCase(),
        {
          color: "#000000",
          fontSize: "10px",
          font: "Arial",
        }
      );
      cityName.setOrigin(0.5, 0.5);
      this.mapContainer.add(cityName);
      this.scene.children.bringToTop(cityName);

      // Add load sprites
      this.addLoadSpritesToCity(
        point.x + this.GRID_MARGIN,
        point.y + this.GRID_MARGIN,
        city.name,
        city.type
      );
      return;
    }
    if (city.type === TerrainType.SmallCity) {
      graphics.fillStyle(this.CITY_COLORS[TerrainType.SmallCity], 0.7);
      graphics.lineStyle(2, 0x000000, 0.7);
      const radius = this.CITY_RADIUS[TerrainType.SmallCity];
      graphics.fillRect(
        point.x - radius,
        point.y - radius,
        radius * 2,
        radius * 2
      );
      graphics.strokeRect(
        point.x - radius,
        point.y - radius,
        radius * 2,
        radius * 2
      );

      // Add city name
      const cityName = this.scene.add.text(
        point.x + this.GRID_MARGIN,
        point.y + this.GRID_MARGIN - 15,
        city.name.toUpperCase(),
        {
          color: "#000000",
          fontSize: "8px",
          font: "Arial",
        }
      );
      cityName.setOrigin(0.5, 0.5);
      this.mapContainer.add(cityName);

      // Add load sprites
      this.addLoadSpritesToCity(
        point.x + this.GRID_MARGIN,
        point.y + this.GRID_MARGIN,
        city.name,
        city.type
      );
      return;
    }
  }

  public createHexagonalGrid(): void {
    // Create lookup maps
    const terrainLookup = new Map<
      string,
      {
        id: string;
        terrain: TerrainType;
        ferryConnection?: { row: number; col: number };
        //TODO: Add centerPoint to the config for any city, allow saving the row/col of the center point
        //points come from mapConfig which has this data - connected points only filled for major cities
        city?: {
          type: TerrainType;
          name: string;
          connectedPoints?: Array<{ row: number; col: number }>;
          availableLoads?: string[];
        };
        ocean: string;
      }
    >();

    // First pass: Build lookup maps and identify city areas
    mapConfig.points.forEach((point) => {
      terrainLookup.set(`${point.row},${point.col}`, {
        id: point.id,
        terrain: point.terrain,
        ferryConnection: point.ferryConnection,
        city: point.city,
        ocean: (point as any).ocean,
      });
    });

    // Create graphics objects for different elements
    const ferryConnections = this.scene.add.graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      }).setName('ferryConnections');
    const cityAreas = this.scene.add.graphics({
      x: this.GRID_MARGIN,
      y: this.GRID_MARGIN,
    }).setName('cityAreas');
    const landPoints = this.scene.add.graphics({
      x: this.GRID_MARGIN,
      y: this.GRID_MARGIN,
    }).setName('landPoints');
    const mountainPoints = this.scene.add.graphics({
      x: this.GRID_MARGIN,
      y: this.GRID_MARGIN,
    }).setName('mountainPoints');
    const hillPoints = this.scene.add.graphics({
      x: this.GRID_MARGIN,
      y: this.GRID_MARGIN,
    }).setName('hillPoints');
    const ferryCosts = this.scene.add.graphics({
      x: this.GRID_MARGIN,
      y: this.GRID_MARGIN,
    }).setName('ferryCosts');
    // Set styles
    landPoints.lineStyle(1, 0x000000);
    landPoints.fillStyle(this.terrainColors[TerrainType.Clear]);
    mountainPoints.lineStyle(1, 0x000000);
    hillPoints.lineStyle(1, 0x000000);
    hillPoints.fillStyle(this.terrainColors[TerrainType.Mountain]);
    ferryConnections.lineStyle(6, 0x808080, 0.8); // Increased thickness to 6, using gray color, 0.8 opacity

    const portNames = this.scene.add.container();
    const ferryPortIcons = this.scene.add.container();
    // First pass: Draw city areas
    const majorCities = new Set<string>();
    for (let row = 0; row <= mapConfig.height; row++) {
      for (let col = 0; col <= mapConfig.width; col++) {
        const config = terrainLookup.get(`${row},${col}`);
        if (config?.city) {
          const isOffsetRow = row % 2 === 1;
          const x =
            col * this.HORIZONTAL_SPACING +
            (isOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
          const y = row * this.VERTICAL_SPACING;

          const cityConfig = {
            city: {
              type: config.city.type,
              name: config.city.name,
              connectedPoints: config.city.connectedPoints || [],
              availableLoads: config.city.availableLoads || [],
            },
            terrain: config.terrain,
          };
          const currentPoint = { col, row, x, y };
          if (
            config.city.type === TerrainType.MajorCity &&
            config.city.connectedPoints
          ) {
            // Only draw major city once
            const cityKey = `${config.city.name}`;
            if (!majorCities.has(cityKey)) {
              majorCities.add(cityKey);
              if (!config.city.connectedPoints.length) {
                // eslint-disable-next-line no-console
                console.error(
                  "Major city with empty connectedPoints:",
                  config.city.name,
                  config.city
                );
              } else if (
                config.city.connectedPoints.some(
                  (cp) =>
                    !cp ||
                    typeof cp.row !== "number" ||
                    typeof cp.col !== "number"
                )
              ) {
                // eslint-disable-next-line no-console
                console.error(
                  "Major city with bad connectedPoint:",
                  config.city.name,
                  config.city.connectedPoints
                );
              }
              //console.log("Drawing city with loads:", cityConfig, x, y);
              this.drawCityWithLoads(cityAreas, currentPoint, cityConfig);
            }
          } else {
            if (
              config.city.type !== TerrainType.MajorCity &&
              config.city.connectedPoints &&
              config.city.connectedPoints.some(
                (cp) =>
                  !cp ||
                  typeof cp.row !== "number" ||
                  typeof cp.col !== "number"
              )
            ) {
              // eslint-disable-next-line no-console
              console.error(
                "Non-major city with bad connectedPoint:",
                config.city.name,
                config.city.connectedPoints
              );
            }
            this.drawCityWithLoads(cityAreas, currentPoint, cityConfig);
          }
        }
      }
    }

    // Second pass: Draw regular grid points and terrain
    for (let row = 0; row <= mapConfig.height; row++) {
      this.gridPoints[row] = [];
      const isOffsetRow = row % 2 === 1;

      for (let col = 0; col <= mapConfig.width; col++) {
        const x =
          col * this.HORIZONTAL_SPACING +
          (isOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
        const y = row * this.VERTICAL_SPACING;

        const config = terrainLookup.get(`${row},${col}`);

        // Use city area config if available, otherwise use regular config
        let terrain = config?.terrain || TerrainType.Clear;
        const ferryConnection = config?.ferryConnection;
        const city = config?.city;

        // If this point has a city, use the city's type as the terrain type for cost calculations
        if (city) {
          terrain = city.type;

          // For all major city connectedPoints, ensure we tag those as major city terrain too
          if (city.type === TerrainType.MajorCity && city.connectedPoints) {
            // Check if this point is one of the connected points for the major city
            for (const cp of city.connectedPoints) {
                terrain = TerrainType.MajorCity;              
            }
          }
        }

        //Add coordinate label for each point
        // const coordLabel = this.scene.add.text(
        //     x + this.GRID_MARGIN,
        //     y + this.GRID_MARGIN,
        //     `${col},${row}`,
        //     {
        //         color: '#000000',
        //         fontSize: '8px',
        //         backgroundColor: '#ffffff80' // Semi-transparent white background
        //     }
        // );
        // coordLabel.setOrigin(0, 1);
        // this.mapContainer.add(coordLabel);

        let sprite:
          | Phaser.GameObjects.Graphics
          | Phaser.GameObjects.Image
          | undefined;

        // Check if this point is a connected point of any major city
        let isConnectedPointOfMajorCity = false;
        for (const [key, value] of terrainLookup.entries()) {
          if (
            value.city?.type === TerrainType.MajorCity &&
            value.city.connectedPoints
          ) {
            if (
              value.city.connectedPoints.some(
                (cp) => cp.row === row && cp.col === col
              )
            ) {
              isConnectedPointOfMajorCity = true;
              break;
            }
          }
        }

       if (terrain !== TerrainType.Water) {
          if (
            terrain === TerrainType.Alpine ||
            terrain === TerrainType.Mountain
          ) {
            // Draw terrain features as before
            const graphics =
              terrain === TerrainType.Alpine ? mountainPoints : hillPoints;
            const triangleHeight = this.POINT_RADIUS * 2;
            graphics.beginPath();
            graphics.moveTo(x, y - triangleHeight);
            graphics.lineTo(x - triangleHeight, y + triangleHeight);
            graphics.lineTo(x + triangleHeight, y + triangleHeight);
            graphics.closePath();
            if (terrain === TerrainType.Mountain) {
              graphics.fill();
            }
            graphics.stroke();
          }  
        //   else if (terrain === TerrainType.Water) {
        //     landPoints.beginPath();
        //     landPoints.fillStyle(0x1cb2f5, 1); // Bright blue
        //     landPoints.arc(x, y, this.POINT_RADIUS, 0, Math.PI * 2);
        //     landPoints.closePath();
        //     landPoints.fill();
        //     landPoints.stroke();
        // }
        else if (terrain === TerrainType.FerryPort) {
            sprite = this.scene.add.image(
              x + this.GRID_MARGIN,
              y + this.GRID_MARGIN,
              "ferry-port"
            ).setName(`ferryPort--${config?.city?.name}`);
            sprite.setScale(1);
            sprite.setOrigin(0.5, 0.5);
            this.scene.textures.get('ferry-port').setFilter(Phaser.Textures.FilterMode.LINEAR);
            sprite.setDisplaySize(this.FERRY_ICON_SIZE, this.FERRY_ICON_SIZE);
            ferryPortIcons.add(sprite);

            // Find the ferry connection for this port
            const ferryConnection = mapConfig.ferryConnections?.find(ferry => {
              const [pointA, pointB] = ferry.connections;
              return (pointA.row === row && pointA.col === col) || (pointB.row === row && pointB.col === col);
            });

            // Calculate text position based on ferry connection
            let textX = x + this.GRID_MARGIN;
            let textY = y + this.GRID_MARGIN;
            let textOrigin = { x: 0.5, y: 0.5 }; // Default centered origin

            if (ferryConnection) {
              const [pointA, pointB] = ferryConnection.connections;
              const isPointA = pointA.row === row && pointA.col === col;
              const otherPoint = isPointA ? pointB : pointA;
              
              // Determine if text should be above or below based on relative position
              const isAbove = otherPoint.row < row || (otherPoint.row === row && otherPoint.col < col);
              
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
              config?.city?.name || "Port", // Use city name if available, otherwise "Port"
              {
                color: "#000000",
                fontSize: "7px", // Smaller than small city (8px)
                fontFamily: "sans-serif",
              }
            );
            portName.setOrigin(textOrigin.x, textOrigin.y);
            portNames.add(portName);
          } else if (config || isConnectedPointOfMajorCity) {
            // Draw standard point
            landPoints.beginPath();
            landPoints.fillStyle(this.terrainColors[TerrainType.Clear], 1); // Always set to black for land

            landPoints.arc(x, y, this.POINT_RADIUS, 0, Math.PI * 2);
            landPoints.closePath();
            landPoints.fill();
            landPoints.stroke();
          }
         
        }

        // Store point data with grid coordinates
        this.gridPoints[row][col] = {
          id: config?.id || "",
          x: x + this.GRID_MARGIN,
          y: y + this.GRID_MARGIN,
          row,
          col,
          sprite,
          terrain,
          ferryConnection,
          city: city
            ? {
                type: city.type,
                name: city.name,
                connectedPoints: city.connectedPoints || [],
                availableLoads: city.availableLoads || [],
              }
            : undefined,
        };
      }
    }
    const ferryCostsText: Phaser.GameObjects.Text[] = [];
    // Draw ferry connections using the ferryConnections array from mapConfig
    if (mapConfig.ferryConnections) {
      mapConfig.ferryConnections.forEach(ferry => {
        const [pointA, pointB] = ferry.connections;
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

        // Draw the ferry connection line
        ferryConnections.beginPath();
        ferryConnections.moveTo(fromX, fromY);
        ferryConnections.lineTo(toX, toY);
        ferryConnections.stroke();

        // Calculate midpoint for the cost circle
        const midX = (fromX + toX) / 2;
        const midY = (fromY + toY) / 2;

        // Draw the circled cost using the ferry's cost
        const text = this.drawCircledNumber(ferryCosts, midX, midY, ferry.cost);
        ferryCostsText.push(text);
      });
    }
    // //convert all graphics to static textures
    const ferryTexture = ferryConnections.generateTexture("ferry-connections");
    const cityAreasTexture = cityAreas.generateTexture("city-areas");
    const landPointsTexture = landPoints.generateTexture("land-points");
    const mountainPointsTexture = mountainPoints.generateTexture("mountain-points");
    const hillPointsTexture = hillPoints.generateTexture("hill-points");
    const ferryCostsTexture = ferryCosts.generateTexture("ferry-costs");
    // Add all graphics objects to the map container in correct order
    this.mapContainer.add([
     ferryTexture,
      cityAreasTexture ,
      landPointsTexture,
      mountainPointsTexture,
      hillPointsTexture,
      ferryCostsTexture,
      ...ferryCostsText,
      portNames,
      ferryPortIcons,
    ]);
  }

  private drawStar(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    radius: number
  ) {
    const points = 5;
    const innerRadius = radius * 0.4; // Inner radius of the star

    graphics.beginPath();

    for (let i = 0; i <= points * 2; i++) {
      const r = i % 2 === 0 ? radius : innerRadius;
      const angle = (i * Math.PI) / points;
      const pointX = x + r * Math.sin(angle);
      const pointY = y - r * Math.cos(angle);

      if (i === 0) {
        graphics.moveTo(pointX, pointY);
      } else {
        graphics.lineTo(pointX, pointY);
      }
    }

    graphics.closePath();
    graphics.fillStyle(0x000000, 1); // Black fill
    graphics.fill();
    graphics.lineStyle(1, 0x000000);
    graphics.stroke();
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
      x + this.GRID_MARGIN,
      y + this.GRID_MARGIN,
      number.toString(),
      {
        color: "#000000",
        fontSize: "10px",
        fontStyle: "bold",
      }
    );
    //text.setDepth(2); // Set even higher depth to ensure text appears above circle
    text.setOrigin(0.5, 0.5);

    return text;
  }

  public getGridPointAtPosition(
    screenX: number,
    screenY: number,
    camera: Phaser.Cameras.Scene2D.Camera
  ): GridPoint | null {
    // Convert screen coordinates to world coordinates
    const worldPoint = camera.getWorldPoint(screenX, screenY);

    // Define maximum distance for point selection
    const MAX_DISTANCE = 15; // pixels

    let closestPoint: GridPoint | null = null;
    let minDistance = MAX_DISTANCE;

    // Calculate approximate position, accounting for row offset
    const approxRow = Math.floor(
      (worldPoint.y - this.GRID_MARGIN) / this.VERTICAL_SPACING
    );
    const isOddRow = approxRow % 2 === 1;
    const rowOffset = isOddRow ? this.HORIZONTAL_SPACING / 2 : 0;
    const approxCol = Math.floor(
      (worldPoint.x - this.GRID_MARGIN - rowOffset) / this.HORIZONTAL_SPACING
    );

    // Search in a hexagonal pattern around the approximate position
    // This covers the 6 surrounding hexes plus the center
    const searchPattern = [
      { dr: 0, dc: 0 },  // center
      { dr: -1, dc: 0 }, // top
      { dr: 1, dc: 0 },  // bottom
      { dr: 0, dc: -1 }, // left
      { dr: 0, dc: 1 },  // right
      { dr: -1, dc: isOddRow ? 1 : -1 }, // top-left or top-right
      { dr: 1, dc: isOddRow ? 1 : -1 },  // bottom-left or bottom-right
    ];

    for (const { dr, dc } of searchPattern) {
      const r = approxRow + dr;
      const c = approxCol + dc;

      // Skip if out of bounds
      if (r < 0 || r >= mapConfig.height || c < 0 || c >= mapConfig.width) {
        continue;
      }

      if (!this.gridPoints[r] || !this.gridPoints[r][c]) continue;

      const point = this.gridPoints[r][c];
      if (!point) continue;

      // Calculate distance to this point
      const dx = point.x - worldPoint.x;
      const dy = point.y - worldPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Update closest point if this is closer
      if (distance < minDistance) {
        minDistance = distance;
        closestPoint = point;
      }
    }

    return closestPoint;
  }

  public isAdjacent(point1: GridPoint, point2: GridPoint): boolean {
    // Prevent null/undefined points
    if (!point1 || !point2) return false;

    // Same row adjacency - must be consecutive columns
    if (point1.row === point2.row) {
      return Math.abs(point1.col - point2.col) === 1;
    }

    // One row difference only
    const rowDiff = Math.abs(point1.row - point2.row);
    if (rowDiff !== 1) return false;

    // For points in adjacent rows, the column relationship depends on which row is odd/even
    const isPoint1OddRow = point1.row % 2 === 1;
    const colDiff = point2.col - point1.col; // Use directed difference

    // In a hexagonal grid, each point can connect to two points in adjacent rows
    if (isPoint1OddRow) {
      // For odd rows, can connect to same column or one column to the right
      return colDiff === 0 || colDiff === 1;
    } else {
      // For even rows, can connect to same column or one column to the left
      return colDiff === 0 || colDiff === -1;
    }
  }

  public playerHasTrack(playerId: string): boolean {
    // Get player's track state from TrackDrawingManager
    const playerTrackState =
      this.trackDrawingManager.getPlayerTrackState(playerId);
    if (!playerTrackState || !playerTrackState.segments) {
      return false;
    }
    return playerTrackState.segments.length > 0;
  }

  // Also let's add a method to help debug track data
  public debugTrackData(): void {
    console.log("=== Track Data Debug ===");
    this.gridPoints.forEach((row, rowIndex) => {
      row.forEach((point, colIndex) => {
        if (point?.tracks && point.tracks.length > 0) {
          console.log(`Track at [${rowIndex},${colIndex}]:`, {
            point,
            tracks: point.tracks,
            numTracks: point.tracks.length,
          });
        }
      });
    });
    console.log("=== End Track Data Debug ===");
  }

  public findNearestMilepostOnOwnTrack(
    x: number,
    y: number,
    playerId: string
  ): GridPoint | null {
    // First, get the clicked point using TrackDrawingManager's method
    const clickedPoint = this.trackDrawingManager.getGridPointAtPosition(x, y);

    if (!clickedPoint) {
      console.log("No valid grid point found at click position");
      return null;
    }

    // Get the player's track state
    const playerTrackState =
      this.trackDrawingManager.getPlayerTrackState(playerId);
    if (!playerTrackState || !playerTrackState.segments) {
      console.log("No track state found for player");
      return null;
    }

    // Check if the clicked point is part of any of the player's track segments
    const isOnPlayerTrack = playerTrackState.segments.some(
      (segment) =>
        // Check both ends of each segment
        (segment.from.row === clickedPoint.row &&
          segment.from.col === clickedPoint.col) ||
        (segment.to.row === clickedPoint.row &&
          segment.to.col === clickedPoint.col)
    );

    if (isOnPlayerTrack) {
      console.log("Found player track at clicked point");
      return clickedPoint;
    }

    // If not, find the nearest point that is part of a player's track segment
    let nearestPoint: GridPoint | null = null;
    let minDistance = Infinity;

    // Create a set of all points that are part of the player's track network
    const trackPoints = new Set<string>();
    playerTrackState.segments.forEach((segment) => {
      trackPoints.add(`${segment.from.row},${segment.from.col}`);
      trackPoints.add(`${segment.to.row},${segment.to.col}`);
    });

    // Search through adjacent points first (within a reasonable radius)
    const searchRadius = 3; // Adjust this value as needed
    const rowStart = Math.max(0, clickedPoint.row - searchRadius);
    const rowEnd = Math.min(
      this.gridPoints.length - 1,
      clickedPoint.row + searchRadius
    );

    for (let row = rowStart; row <= rowEnd; row++) {
      if (!this.gridPoints[row]) continue;

      const colStart = Math.max(0, clickedPoint.col - searchRadius);
      const colEnd = Math.min(
        this.gridPoints[row].length - 1,
        clickedPoint.col + searchRadius
      );

      for (let col = colStart; col <= colEnd; col++) {
        const point = this.gridPoints[row][col];
        if (!point || point.terrain === TerrainType.Water) continue;

        // Check if this point is part of the player's track network
        if (trackPoints.has(`${point.row},${point.col}`)) {
          // Calculate distance to this point
          const dx = point.x - clickedPoint.x;
          const dy = point.y - clickedPoint.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Update nearest point if this is closer
          if (distance < minDistance) {
            minDistance = distance;
            nearestPoint = point;
          }
        }
      }
    }

    if (nearestPoint) {
      console.log("Found nearest point with player track:", nearestPoint);
      return nearestPoint;
    }

    console.log("No valid track point found within search radius");
    return null;
  }
}
