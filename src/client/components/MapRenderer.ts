import "phaser";
import { mapConfig } from "../config/mapConfig";
import { TerrainType, GridPoint } from "../../shared/types/GameTypes";
import { GameState } from "../../shared/types/GameTypes";
import { TrackDrawingManager } from "../components/TrackDrawingManager";
import { MapElement } from "./map/MapElement";
import { MapElementFactory } from "./map/MapElementFactory";
import { FerryConnectionElement } from "./map/FerryConnection";

// All coordinates in configuration and rendering are zero-based. Do not add or subtract 1 from row/col anywhere in this file.

export class MapRenderer {
  public static readonly FERRY_ICONS_CONTAINER_NAME = "ferryIcons";
  public static readonly PORT_NAMES_CONTAINER_NAME = "portNames";
  // Grid configuration
  public static readonly HORIZONTAL_SPACING = 45;
  public static readonly VERTICAL_SPACING = 40;
  public static readonly GRID_MARGIN = 100; // Increased margin around the grid// Size for the ferry icon

  private scene: Phaser.Scene;
  private mapContainer: Phaser.GameObjects.Container;
  public gridPoints: GridPoint[][] = [];
  private trackDrawingManager: TrackDrawingManager;
  private backgroundGraphics: Phaser.GameObjects.Graphics;
  private mapElements: MapElement[][] = [];

  constructor(
    scene: Phaser.Scene,
    mapContainer: Phaser.GameObjects.Container,
    gameState: GameState,
    trackDrawingManager: TrackDrawingManager
  ) {
    this.scene = scene;
    this.mapContainer = mapContainer;
    this.trackDrawingManager = trackDrawingManager;

    // Initialize background graphics with lowest depth
    this.backgroundGraphics = this.scene.add.graphics();
    this.backgroundGraphics.setDepth(-1);
    this.mapContainer.add(this.backgroundGraphics);
  }

  public calculateMapDimensions() {
    const width =
      mapConfig.width * MapRenderer.HORIZONTAL_SPACING + MapRenderer.GRID_MARGIN * 2;
    const height =
      mapConfig.height * MapRenderer.VERTICAL_SPACING + MapRenderer.GRID_MARGIN * 2;
    return { width, height };
  }

  public createHexagonalGrid(): void {
    // Create lookup maps
    const terrainLookup = new Map<string, GridPoint>();
    //console.log(mapConfig.points);
    // First pass: Build lookup maps and identify city areas
    mapConfig.points.forEach((point) => {
      terrainLookup.set(`${point.row},${point.col}`, {
        ...point,
        x: point.x + MapRenderer.GRID_MARGIN,
        y: point.y + MapRenderer.GRID_MARGIN,
      });
    });

    // Create graphics objects for different elements
    const ferryConnections = this.scene.add
      .graphics({
        x: MapRenderer.GRID_MARGIN,
        y: MapRenderer.GRID_MARGIN,
      })
      .setName("ferryConnections");

    const cityAreas = this.scene.add
      .graphics({
        x: MapRenderer.GRID_MARGIN,
        y: MapRenderer.GRID_MARGIN,
      })
      .setName("cityAreas");

    const landPoints = this.scene.add
      .graphics({
        x: MapRenderer.GRID_MARGIN,
        y: MapRenderer.GRID_MARGIN,
      })
      .setName("landPoints");

    const mountainPoints = this.scene.add
      .graphics({
        x: MapRenderer.GRID_MARGIN,
        y: MapRenderer.GRID_MARGIN,
      })
      .setName("mountainPoints");
    const alpinePoints = this.scene.add
      .graphics({
        x: MapRenderer.GRID_MARGIN,
        y: MapRenderer.GRID_MARGIN,
      })
      .setName("alpinePoints");

    const graphicsMap = new Map<TerrainType, Phaser.GameObjects.Graphics>();
    graphicsMap.set(TerrainType.FerryPort, ferryConnections);
    graphicsMap.set(TerrainType.MajorCity, cityAreas);
    graphicsMap.set(TerrainType.Clear, landPoints);
    graphicsMap.set(TerrainType.SmallCity, landPoints);
    graphicsMap.set(TerrainType.MediumCity, landPoints);
    graphicsMap.set(TerrainType.Mountain, mountainPoints);
    graphicsMap.set(TerrainType.Alpine, alpinePoints);

    const portNames = this.scene.add.container();
    portNames.setName(MapRenderer.PORT_NAMES_CONTAINER_NAME);
    const ferryPortIcons = this.scene.add.container();
    ferryPortIcons.setName(MapRenderer.FERRY_ICONS_CONTAINER_NAME);

    for (let row = 0; row <= mapConfig.height; row++) {
      this.gridPoints[row] = [];
      this.mapElements[row] = [];
      const isOffsetRow = row % 2 === 1;

      for (let col = 0; col <= mapConfig.width; col++) {
        const x =
          col * MapRenderer.HORIZONTAL_SPACING +
          (isOffsetRow ? MapRenderer.HORIZONTAL_SPACING / 2 : 0);
        const y = row * MapRenderer.VERTICAL_SPACING;

        let config = terrainLookup.get(`${row},${col}`);

        // Use city area config if available, otherwise use regular config
        let terrain = config?.terrain || TerrainType.Clear;
        const city = config?.city;
        
        //this.writeGridPointCoordinates(x, y, col, row);
        if (terrain !== TerrainType.Water && config) {
          // Create and store the map element
          const mapElement = MapElementFactory.createMapElement(
            this.scene,
            terrain,
            config as GridPoint,
            x,
            y
          );
          this.mapElements[row][col] = mapElement;
          mapElement.draw(
            this.getGraphicsForTerrain(graphicsMap, terrain, landPoints),
            this.mapContainer
          );
        }

        // Store point data with grid coordinates
        this.gridPoints[row][col] = {
          id: config?.id || "",
          x: x + MapRenderer.GRID_MARGIN,
          y: y + MapRenderer.GRID_MARGIN,
          row,
          col,
          terrain,
          ferryConnection: config?.ferryConnection,
          ocean: config?.ocean,
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

    // Draw ferry connections using the ferryConnections array from mapConfig
    const ferryCostsText: Phaser.GameObjects.Text[] = [];
    if (mapConfig.ferryConnections) {
      mapConfig.ferryConnections.forEach((ferry) => {
        new FerryConnectionElement(this.scene, ferry).draw(
          ferryConnections,
          ferryCostsText
        );
      });
    }

    // Convert all graphics to static textures
    const ferryTexture = ferryConnections.generateTexture("ferry-connections");
    const cityAreasTexture = cityAreas.generateTexture("city-areas");
    const landPointsTexture = landPoints.generateTexture("land-points");
    const mountainPointsTexture =
      mountainPoints.generateTexture("mountain-points");
    const alpinePointsTexture = alpinePoints.generateTexture("hill-points");

    // Add all graphics objects to the map container in correct order
    this.mapContainer.add([
      ferryTexture,
      cityAreasTexture,
      landPointsTexture,
      mountainPointsTexture,
      alpinePointsTexture,
      ...ferryCostsText,
      portNames,
      ferryPortIcons,
    ]);
  }

  private getGraphicsForTerrain(
    map: Map<TerrainType, Phaser.GameObjects.Graphics>,
    terrain: TerrainType,
    defaultGraphics: Phaser.GameObjects.Graphics
  ): Phaser.GameObjects.Graphics {
    return map.has(terrain)
      ? (map.get(terrain) as Phaser.GameObjects.Graphics)
      : defaultGraphics;
  }

  private writeGridPointCoordinates(
    x: number,
    y: number,
    col: number,
    row: number
  ) {
    // Add coordinate label for each point
    const coordLabel = this.scene.add.text(
      x + MapRenderer.GRID_MARGIN,
      y + MapRenderer.GRID_MARGIN,
      `${col},${row}`,
      {
        color: "#000000",
        fontSize: "8px",
        backgroundColor: "#ffffff80", // Semi-transparent white background
      }
    );
    coordLabel.setOrigin(0, 1);
    this.mapContainer.add(coordLabel);
  }
}
