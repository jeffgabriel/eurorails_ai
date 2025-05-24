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
  private readonly HORIZONTAL_SPACING = 35;
  private readonly VERTICAL_SPACING = 35;
  private readonly GRID_MARGIN = 100; // Increased margin around the grid// Size for the ferry icon

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
      mapConfig.width * this.HORIZONTAL_SPACING + this.GRID_MARGIN * 2;
    const height =
      mapConfig.height * this.VERTICAL_SPACING + this.GRID_MARGIN * 2;
    return { width, height };
  }

  public createHexagonalGrid(): void {
    // Create lookup maps
    const terrainLookup = new Map<string, GridPoint>();

    // First pass: Build lookup maps and identify city areas
    mapConfig.points.forEach((point) => {
      terrainLookup.set(`${point.row},${point.col}`, {
        ...point,
        x: point.x + this.GRID_MARGIN,
        y: point.y + this.GRID_MARGIN,
      });
    });

    // Create graphics objects for different elements
    const ferryConnections = this.scene.add
      .graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      })
      .setName("ferryConnections");
    const cityAreas = this.scene.add
      .graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      })
      .setName("cityAreas");
    const landPoints = this.scene.add
      .graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      })
      .setName("landPoints");
    const mountainPoints = this.scene.add
      .graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      })
      .setName("mountainPoints");
    const alpinePoints = this.scene.add
      .graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      })
      .setName("alpinePoints");
    const ferryCosts = this.scene.add
      .graphics({
        x: this.GRID_MARGIN,
        y: this.GRID_MARGIN,
      })
      .setName("ferryCosts");
    const portNames = this.scene.add.container();
    portNames.setName(MapRenderer.PORT_NAMES_CONTAINER_NAME);
    const ferryPortIcons = this.scene.add.container();
    ferryPortIcons.setName(MapRenderer.FERRY_ICONS_CONTAINER_NAME);

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
          }
        }
      }
    }

    // Second pass: Draw regular grid points and terrain
    for (let row = 0; row <= mapConfig.height; row++) {
      this.gridPoints[row] = [];
      this.mapElements[row] = [];
      const isOffsetRow = row % 2 === 1;

      for (let col = 0; col <= mapConfig.width; col++) {
        const x =
          col * this.HORIZONTAL_SPACING +
          (isOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
        const y = row * this.VERTICAL_SPACING;

        let config = terrainLookup.get(`${row},${col}`);

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
          // Create and store the map element
          const mapElement = MapElementFactory.createMapElement(
            this.scene,
            terrain,
            config as GridPoint,
            x,
            y
          );
          this.mapElements[row][col] = mapElement;

          // Draw the element
          if (terrain === TerrainType.Mountain) {
            mapElement.draw(mountainPoints, this.mapContainer);
          } else if (terrain === TerrainType.Alpine) {
            mapElement.draw(alpinePoints, this.mapContainer);
          } else if (terrain === TerrainType.FerryPort) {
            mapElement.draw(ferryConnections, this.mapContainer);
          } else if (config || isConnectedPointOfMajorCity) {
            mapElement.draw(landPoints, this.mapContainer);
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
    const ferryCostsTexture = ferryCosts.generateTexture("ferry-costs");

    // Add all graphics objects to the map container in correct order
    this.mapContainer.add([
      ferryTexture,
      cityAreasTexture,
      landPointsTexture,
      mountainPointsTexture,
      alpinePointsTexture,
      ferryCostsTexture,
      ...ferryCostsText,
      portNames,
      ferryPortIcons,
    ]);
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
