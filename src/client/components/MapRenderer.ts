import "phaser";
import {
  mapConfig,
  HORIZONTAL_SPACING,
  VERTICAL_SPACING,
  GRID_MARGIN,
  DEBUG_OVERLAYS,
} from "../config/mapConfig";
import { TerrainType, GridPoint } from "../../shared/types/GameTypes";
import { GameState } from "../../shared/types/GameTypes";
import { TrackDrawingManager } from "../components/TrackDrawingManager";
import { MapElement } from "./map/MapElement";
import { MapElementFactory } from "./map/MapElementFactory";
import { FerryConnectionElement } from "./map/FerryConnection";
import {
  getAllWaterCrossingEdgeKeysUnfiltered,
  getOverrideSnapshot,
  getNonRiverWaterCrossingEdgeKeys,
  getRiverCrossingEdgeKeys,
} from "../../shared/config/waterCrossings";

// All coordinates in configuration and rendering are zero-based. Do not add or subtract 1 from row/col anywhere in this file.

export class MapRenderer {
  public static readonly FERRY_ICONS_CONTAINER_NAME = "ferryIcons";
  public static readonly PORT_NAMES_CONTAINER_NAME = "portNames";
  // Grid configuration - using constants from mapConfig to avoid circular dependency
  public static readonly HORIZONTAL_SPACING = HORIZONTAL_SPACING;
  public static readonly VERTICAL_SPACING = VERTICAL_SPACING;
  public static readonly GRID_MARGIN = GRID_MARGIN;

  private scene: Phaser.Scene;
  private mapContainer: Phaser.GameObjects.Container;
  public gridPoints: GridPoint[][] = [];
  private trackDrawingManager: TrackDrawingManager;
  private backgroundGraphics: Phaser.GameObjects.Graphics;
  private mapElements: MapElement[][] = [];
  private riverCrossingsDebugGraphics: Phaser.GameObjects.Graphics | null = null;
  private nonRiverWaterCrossingsDebugGraphics: Phaser.GameObjects.Graphics | null =
    null;
  private edgePickerGraphics: Phaser.GameObjects.Graphics | null = null;
  private edgePickerEnabled: boolean = false;
  private edgeCandidates: Array<{
    key: string;
    a: GridPoint;
    b: GridPoint;
  }> = [];
  private pickedExcludeEdges: Set<string> = new Set();
  private pickedForceRiverEdges: Set<string> = new Set();
  private pickedForceNonRiverEdges: Set<string> = new Set();

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
      mapConfig.width * MapRenderer.HORIZONTAL_SPACING +
      MapRenderer.GRID_MARGIN * 2;
    const height =
      mapConfig.height * MapRenderer.VERTICAL_SPACING +
      MapRenderer.GRID_MARGIN * 2;
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
        x: point.x,
        y: point.y,
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

    for (let row = 0; row < mapConfig.height; row++) {
      this.gridPoints[row] = [];
      this.mapElements[row] = [];
      const isOffsetRow = row % 2 === 1;

      for (let col = 0; col < mapConfig.width; col++) {
        const x =
          col * MapRenderer.HORIZONTAL_SPACING +
          (isOffsetRow ? MapRenderer.HORIZONTAL_SPACING / 2 : 0);
        const y = row * MapRenderer.VERTICAL_SPACING;

        let config = terrainLookup.get(`${row},${col}`);

        // All grid positions should have a config now (including water)
        if (!config) {
          console.warn(`No config found for grid position ${row},${col}`);
          continue;
        }

        const terrain = config.terrain;
        const city = config.city;
        //this.writeGridPointLabel(config, isOffsetRow);
        this.writeGridPointCoordinates(x, y, col, row);
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
          x: config ? config.x : x + MapRenderer.GRID_MARGIN,
          y: config ? config.y : y + MapRenderer.GRID_MARGIN,
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

    if (DEBUG_OVERLAYS.riverCrossings) this.drawRiverCrossingsDebugOverlay();
    if (DEBUG_OVERLAYS.nonRiverWaterCrossings)
      this.drawNonRiverWaterCrossingsDebugOverlay();

    if (DEBUG_OVERLAYS.edgeOverridePicker) {
      this.setupEdgeOverridePicker();
    }
  }

  private setupEdgeOverridePicker(): void {
    if (this.edgePickerEnabled) return;
    this.edgePickerEnabled = true;

    // Seed picker sets from current config overrides (so you can add/remove and copy full lists).
    const snap = getOverrideSnapshot();
    this.pickedExcludeEdges = new Set(snap.excludeEdges);
    this.pickedForceRiverEdges = new Set(snap.forceRiverEdges);
    this.pickedForceNonRiverEdges = new Set(snap.forceNonRiverWaterEdges);

    // Build candidate edge list once (includes excluded edges too).
    const keys = getAllWaterCrossingEdgeKeysUnfiltered();
    const candidates: typeof this.edgeCandidates = [];

    for (const key of keys) {
      const [a, b] = key.split("|");
      if (!a || !b) continue;
      const [ar, ac] = a.split(",").map((v) => Number(v.trim()));
      const [br, bc] = b.split(",").map((v) => Number(v.trim()));
      if (![ar, ac, br, bc].every(Number.isFinite)) continue;
      const p1 = this.gridPoints[ar]?.[ac];
      const p2 = this.gridPoints[br]?.[bc];
      if (!p1 || !p2) continue;
      candidates.push({ key, a: p1, b: p2 });
    }

    this.edgeCandidates = candidates;

    // Picker overlay graphics (draw selected edges on top).
    if (!this.edgePickerGraphics) {
      this.edgePickerGraphics = this.scene.add.graphics();
      this.edgePickerGraphics.setDepth(20_000);
      this.mapContainer.add(this.edgePickerGraphics);
    }
    this.redrawEdgePickerOverlay();

    // Click handler: toggle entries and print paste-ready JSON.
    this.scene.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Don't interfere with track drawing mode.
      if (this.trackDrawingManager?.isInDrawingMode) return;

      // Ignore UI area (mirrors TrackDrawingManager’s behavior)
      if (pointer.y > this.scene.scale.height - 200) return;

      const world = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const nearest = this.findNearestEdge(world.x, world.y, 14);
      if (!nearest) return;

      const evt = pointer.event as MouseEvent | undefined;
      const shift = !!evt?.shiftKey;
      const alt = !!evt?.altKey || !!evt?.metaKey;

      if (shift) {
        this.toggleSet(this.pickedForceRiverEdges, nearest.key);
        this.pickedExcludeEdges.delete(nearest.key);
        this.pickedForceNonRiverEdges.delete(nearest.key);
      } else if (alt) {
        this.toggleSet(this.pickedForceNonRiverEdges, nearest.key);
        this.pickedExcludeEdges.delete(nearest.key);
        this.pickedForceRiverEdges.delete(nearest.key);
      } else {
        this.toggleSet(this.pickedExcludeEdges, nearest.key);
        this.pickedForceRiverEdges.delete(nearest.key);
        this.pickedForceNonRiverEdges.delete(nearest.key);
      }

      this.redrawEdgePickerOverlay();
      this.printPickedOverrides();
    });
  }

  private toggleSet(set: Set<string>, key: string): void {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }

  private printPickedOverrides(): void {
    const payload = {
      forceRiverEdges: Array.from(this.pickedForceRiverEdges).sort(),
      forceNonRiverWaterEdges: Array.from(this.pickedForceNonRiverEdges).sort(),
      excludeEdges: Array.from(this.pickedExcludeEdges).sort(),
    };
    // Paste directly into configuration/waterCrossings.json -> overrides
    console.log("[EdgeOverridePicker] overrides =", payload);
    console.log(
      "[EdgeOverridePicker] JSON:",
      JSON.stringify(payload, null, 2)
    );
    console.log(
      "[EdgeOverridePicker] Tip: click = exclude, shift+click = forceRiver, alt/option+click = forceNonRiver"
    );
  }

  private redrawEdgePickerOverlay(): void {
    if (!this.edgePickerGraphics) return;
    const g = this.edgePickerGraphics;
    g.clear();

    // Exclude = magenta
    this.drawEdgeSet(g, this.pickedExcludeEdges, 0xff00ff, 6, 0.9);
    // Force river = green
    this.drawEdgeSet(g, this.pickedForceRiverEdges, 0x00ff00, 6, 0.9);
    // Force non-river = cyan
    this.drawEdgeSet(g, this.pickedForceNonRiverEdges, 0x00ffff, 6, 0.9);
  }

  private drawEdgeSet(
    g: Phaser.GameObjects.Graphics,
    set: Set<string>,
    color: number,
    width: number,
    alpha: number
  ): void {
    g.lineStyle(width, color, alpha);
    for (const key of set) {
      const edge = this.edgeCandidates.find((e) => e.key === key);
      if (!edge) continue;
      g.beginPath();
      g.moveTo(edge.a.x, edge.a.y);
      g.lineTo(edge.b.x, edge.b.y);
      g.strokePath();
    }
  }

  private findNearestEdge(
    x: number,
    y: number,
    maxDistPx: number
  ): { key: string; distSq: number } | null {
    let best: { key: string; distSq: number } | null = null;
    const maxSq = maxDistPx * maxDistPx;

    for (const e of this.edgeCandidates) {
      const d2 = this.pointToSegmentDistanceSq(x, y, e.a.x, e.a.y, e.b.x, e.b.y);
      if (d2 > maxSq) continue;
      if (!best || d2 < best.distSq) {
        best = { key: e.key, distSq: d2 };
      }
    }
    return best;
  }

  private pointToSegmentDistanceSq(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): number {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const abLenSq = abx * abx + aby * aby;
    if (abLenSq === 0) {
      const dx = px - ax;
      const dy = py - ay;
      return dx * dx + dy * dy;
    }
    let t = (apx * abx + apy * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy;
  }

  private drawRiverCrossingsDebugOverlay(): void {
    // Draw bright red overlay lines for every edge classified as a river crossing.
    // This is intended for spot-checking and calibration.
    if (this.riverCrossingsDebugGraphics) {
      this.riverCrossingsDebugGraphics.clear();
    } else {
      this.riverCrossingsDebugGraphics = this.scene.add.graphics();
      this.riverCrossingsDebugGraphics.setDepth(9_000); // above tracks/UI board elements
      this.mapContainer.add(this.riverCrossingsDebugGraphics);
    }

    const g = this.riverCrossingsDebugGraphics;
    g.lineStyle(4, 0xff0000, 0.9);

    const edgeKeys = getRiverCrossingEdgeKeys();
    for (const key of edgeKeys) {
      const [a, b] = key.split("|");
      if (!a || !b) continue;
      const [ar, ac] = a.split(",").map((v) => Number(v.trim()));
      const [br, bc] = b.split(",").map((v) => Number(v.trim()));
      if (![ar, ac, br, bc].every(Number.isFinite)) continue;

      const p1 = this.gridPoints[ar]?.[ac];
      const p2 = this.gridPoints[br]?.[bc];
      if (!p1 || !p2) continue;

      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);
      g.strokePath();
    }
  }

  private drawNonRiverWaterCrossingsDebugOverlay(): void {
    // Draw bright yellow overlay lines for every edge classified as a non-river water crossing.
    if (this.nonRiverWaterCrossingsDebugGraphics) {
      this.nonRiverWaterCrossingsDebugGraphics.clear();
    } else {
      this.nonRiverWaterCrossingsDebugGraphics = this.scene.add.graphics();
      this.nonRiverWaterCrossingsDebugGraphics.setDepth(8_099); // just under river overlay
      this.mapContainer.add(this.nonRiverWaterCrossingsDebugGraphics);
    }

    const g = this.nonRiverWaterCrossingsDebugGraphics;
    g.lineStyle(4, 0xffff00, 0.9);

    const edgeKeys = getNonRiverWaterCrossingEdgeKeys();
    for (const key of edgeKeys) {
      const [a, b] = key.split("|");
      if (!a || !b) continue;
      const [ar, ac] = a.split(",").map((v) => Number(v.trim()));
      const [br, bc] = b.split(",").map((v) => Number(v.trim()));
      if (![ar, ac, br, bc].every(Number.isFinite)) continue;

      const p1 = this.gridPoints[ar]?.[ac];
      const p2 = this.gridPoints[br]?.[bc];
      if (!p1 || !p2) continue;

      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);
      g.strokePath();
    }
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
    // Use explicit axis labels to avoid row/col vs x/y confusion.
    const coordLabel = this.scene.add.text(x + 110, y + 140, `${row}, ${col}`, {
      color: "#000000",
      fontSize: "7px",
      //backgroundColor: "#ffffff80", // Semi-transparent white background
    });
    coordLabel.setDepth(10000);
    coordLabel.setOrigin(0, 1);
    this.mapContainer.add(coordLabel);
  }

  private writeGridPointLabel(p: GridPoint | undefined, isOffsetRow: boolean) {
    if (!p) return;
    const label = this.scene.add.text(
      p.x - 15,
      p.y + 18,
      TerrainType[p.terrain],
      {
        color: "#000000",
        fontSize: "8px",
        backgroundColor: "#ffffff80", // Semi-transparent white background
      }
    );
    this.mapContainer.add(label);
  }
}
