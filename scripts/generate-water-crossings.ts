import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

import {
  mapConfig,
  MAP_BACKGROUND_CALIBRATION,
  HORIZONTAL_SPACING,
  VERTICAL_SPACING,
  GRID_MARGIN,
} from "../src/client/config/mapConfig";
import { TerrainType, WaterCrossingType } from "../src/shared/types/GameTypes";

type GridRef = { row: number; col: number };

type RiverConfig = Array<{
  Name: string;
  Edges: Array<{
    Start: { Row: number; Col: number };
    End: { Row: number; Col: number };
  }>;
}>;

type WaterCrossingsConfig = {
  version: number;
  generatedAt: string;
  source: {
    mapPng: string;
    mapCalibration: typeof MAP_BACKGROUND_CALIBRATION;
  };
  classification: {
    waterPixel: {
      // A pixel is treated as water when blue is dominant.
      minBlue: number;
      minBlueMinusMaxRG: number;
      maxRed: number;
      maxGreen: number;
    };
    sample: {
      stepPx: number;
      neighborhoodRadiusPx: number;
    };
  };
  overrides: {
    // Optional manual fixes. Keys must match the normalized edge-key format.
    forceRiverEdges: string[];
    forceNonRiverWaterEdges: string[];
    // Optional manual exclusions. Any key here will be removed from all outputs.
    excludeEdges: string[];
  };
  riverEdges: string[];
  nonRiverWaterEdges: string[];
};

type RiverCrossingsConfig = {
  version: number;
  generatedAt: string;
  rivers: Array<{ name: string; edges: string[] }>;
  // River edges detected as "river water" but whose underlying water component
  // was seeded by more than one river name (cannot uniquely assign).
  ambiguousEdges: string[];
};

const REPO_ROOT = path.resolve(__dirname, "..");

const MAP_PNG_PATH = path.join(REPO_ROOT, "public", "assets", "map.png");
const RIVERS_JSON_PATH = path.join(REPO_ROOT, "configuration", "rivers.json");
const OUT_PATH = path.join(REPO_ROOT, "configuration", "waterCrossings.json");
const RIVER_GROUPS_OUT_PATH = path.join(REPO_ROOT, "configuration", "riverCrossings.json");

// Tune these once if needed.
const WATER_PIXEL = {
  // Rivers are thin/anti-aliased, so keep this fairly permissive.
  minBlue: 80,
  minBlueMinusMaxRG: 15,
  maxRed: 230,
  maxGreen: 230,
} as const;

const SAMPLE = {
  stepPx: 1,
  // Radius around each sample point to search for water pixels.
  // This needs to be >0 because map symbols (triangles/text) can occlude the river stroke.
  neighborhoodRadiusPx: 8,
  // Also try a small perpendicular offset corridor (helps when the exact segment is fully occluded).
  perpendicularOffsetsPx: [-12, -8, -4, 0, 4, 8, 12],
} as const;

// Heuristic used only for water *fill* components if needed; river detection uses the ink mask.
// Left here as a tuning knob, but currently not applied to river-ink components.
const MAX_WATER_FILL_COMPONENT_PIXELS = 50_000;

function readExistingOverrides(): WaterCrossingsConfig["overrides"] {
  try {
    if (!fs.existsSync(OUT_PATH)) {
      return { forceRiverEdges: [], forceNonRiverWaterEdges: [], excludeEdges: [] };
    }
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8")) as Partial<WaterCrossingsConfig>;
    return {
      forceRiverEdges: prev.overrides?.forceRiverEdges ?? [],
      forceNonRiverWaterEdges: prev.overrides?.forceNonRiverWaterEdges ?? [],
      excludeEdges: prev.overrides?.excludeEdges ?? [],
    };
  } catch {
    return { forceRiverEdges: [], forceNonRiverWaterEdges: [], excludeEdges: [] };
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function edgeKey(a: GridRef, b: GridRef): string {
  const aKey = `${a.row},${a.col}`;
  const bKey = `${b.row},${b.col}`;
  return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function isAdjacentHex(a: GridRef, b: GridRef): boolean {
  const rowDiff = b.row - a.row;
  const colDiff = b.col - a.col;

  if (rowDiff === 0) return Math.abs(colDiff) === 1;
  if (Math.abs(rowDiff) !== 1) return false;

  const fromOdd = a.row % 2 === 1;
  if (rowDiff === 1) {
    return fromOdd ? colDiff === 0 || colDiff === 1 : colDiff === 0 || colDiff === -1;
  }
  // rowDiff === -1
  const toOdd = b.row % 2 === 1;
  return toOdd ? colDiff === 0 || colDiff === -1 : colDiff === 0 || colDiff === 1;
}

function neighborsOf(p: GridRef, maxRow: number, maxCol: number): GridRef[] {
  const { row, col } = p;
  const odd = row % 2 === 1;
  const candidates: GridRef[] = [
    { row, col: col - 1 },
    { row, col: col + 1 },
    { row: row - 1, col: odd ? col : col - 1 },
    { row: row - 1, col: odd ? col + 1 : col },
    { row: row + 1, col: odd ? col : col - 1 },
    { row: row + 1, col: odd ? col + 1 : col },
  ];
  return candidates.filter(
    (q) => q.row >= 0 && q.row < maxRow && q.col >= 0 && q.col < maxCol
  );
}

function loadPng(p: string): PNG {
  const buf = fs.readFileSync(p);
  return PNG.sync.read(buf);
}

function isWaterPixel(r: number, g: number, b: number): boolean {
  if (b < WATER_PIXEL.minBlue) return false;
  if (r > WATER_PIXEL.maxRed) return false;
  if (g > WATER_PIXEL.maxGreen) return false;
  const maxRG = Math.max(r, g);
  return b - maxRG >= WATER_PIXEL.minBlueMinusMaxRG;
}

// Detect the water *fill* (sea/lake) which is a very consistent color on the base map.
// Keep this strict so coastline/rivers (ink) don't match.
function isWaterFillPixel(r: number, g: number, b: number): boolean {
  // Observed fill is ~[1,117,176] in map.png
  return Math.abs(r - 1) <= 6 && Math.abs(g - 117) <= 6 && Math.abs(b - 176) <= 6;
}

// Detect the *river stroke ink* (dark blue line), distinct from sea/lake fill.
// The sea fill is ~[1,117,176]; river ink tends to be darker (lower luminance) and slightly less green.
function isRiverInkPixel(r: number, g: number, b: number): boolean {
  if (b < 50) return false;
  const maxRG = Math.max(r, g);
  if (b - maxRG < 10) return false;
  const lum = r + g + b; // 0..765
  // Sea fill fails g<116 and lum<285, river ink typically passes.
  return g < 116 && lum < 285;
}

function idxOf(x: number, y: number, width: number): number {
  return y * width + x;
}

function buildMask(png: PNG, predicate: (r: number, g: number, b: number) => boolean): Uint8Array {
  const mask = new Uint8Array(png.width * png.height);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i]!;
      const g = png.data[i + 1]!;
      const b = png.data[i + 2]!;
      if (predicate(r, g, b)) {
        mask[idxOf(x, y, png.width)] = 1;
      }
    }
  }
  return mask;
}

class LazyComponents {
  private readonly width: number;
  private readonly height: number;
  private readonly mask: Uint8Array; // 1=hit
  private readonly compIds: Int32Array; // -1 unknown, otherwise component id
  private readonly compSizes: Map<number, number> = new Map();
  private nextId = 0;

  constructor(png: PNG, mask: Uint8Array) {
    this.width = png.width;
    this.height = png.height;
    this.mask = mask;
    this.compIds = new Int32Array(this.width * this.height);
    this.compIds.fill(-1);
  }

  public getComponentIdNear(x0: number, y0: number, radius: number): number | null {
    const xMin = Math.max(0, x0 - radius);
    const xMax = Math.min(this.width - 1, x0 + radius);
    const yMin = Math.max(0, y0 - radius);
    const yMax = Math.min(this.height - 1, y0 + radius);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const idx = idxOf(x, y, this.width);
        if (this.mask[idx] !== 1) continue;
        return this.getComponentIdAt(x, y);
      }
    }
    return null;
  }

  public getComponentSize(compId: number): number | null {
    return this.compSizes.get(compId) ?? null;
  }

  private getComponentIdAt(x: number, y: number): number {
    const startIdx = idxOf(x, y, this.width);
    const existing = this.compIds[startIdx];
    if (existing !== -1) return existing;

    const id = this.nextId++;
    // Flood fill (4-neighbor) to label this component.
    const queue = new Int32Array(this.width * this.height); // upper bound, but reused per fill
    let qh = 0;
    let qt = 0;
    queue[qt++] = startIdx;
    this.compIds[startIdx] = id;
    let size = 1;

    while (qh < qt) {
      const cur = queue[qh++]!;
      const cx = cur % this.width;
      const cy = Math.floor(cur / this.width);

      // 4-neighbors
      const n = [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ] as const;
      for (const [nx, ny] of n) {
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        const ni = idxOf(nx, ny, this.width);
        if (this.mask[ni] !== 1) continue;
        if (this.compIds[ni] !== -1) continue;
        this.compIds[ni] = id;
        queue[qt++] = ni;
        size++;
      }
    }

    this.compSizes.set(id, size);
    return id;
  }
}

function buildGrid(): {
  grid: Array<Array<{ row: number; col: number; x: number; y: number; terrain: TerrainType } | null>>;
  rows: number;
  cols: number;
} {
  const rows = mapConfig.height;
  const cols = mapConfig.width;
  const grid: Array<Array<{ row: number; col: number; x: number; y: number; terrain: TerrainType } | null>> =
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));

  for (const p of mapConfig.points) {
    grid[p.row]![p.col] = {
      row: p.row,
      col: p.col,
      x: p.x,
      y: p.y,
      terrain: p.terrain,
    };
  }
  return { grid, rows, cols };
}

function getMapDisplaySizeWorld(): { displayW: number; displayH: number } {
  // Must match MapRenderer.calculateMapDimensions() + GameScene background display sizing.
  const mapWorldWidth = mapConfig.width * HORIZONTAL_SPACING + GRID_MARGIN * 2;
  const mapWorldHeight = mapConfig.height * VERTICAL_SPACING + GRID_MARGIN * 2;
  return {
    displayW: mapWorldWidth * MAP_BACKGROUND_CALIBRATION.scaleX,
    displayH: mapWorldHeight * MAP_BACKGROUND_CALIBRATION.scaleY,
  };
}

function worldToImagePx(
  worldX: number,
  worldY: number,
  png: PNG,
  displayW: number,
  displayH: number
): { x: number; y: number } {
  const xOnImage = (worldX - MAP_BACKGROUND_CALIBRATION.offsetX) / displayW;
  const yOnImage = (worldY - MAP_BACKGROUND_CALIBRATION.offsetY) / displayH;
  return {
    x: xOnImage * png.width,
    y: yOnImage * png.height,
  };
}

type SegmentHit = { compId: number; x: number; y: number; offset: number };

function firstComponentHitAlongSegment(
  comps: LazyComponents,
  png: PNG,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): SegmentHit | null {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const step = SAMPLE.stepPx / len;

  // Perpendicular unit vector
  const px = -dy / len;
  const py = dx / len;

  for (let t = 0; t <= 1; t += step) {
    const sx0 = ax + dx * t;
    const sy0 = ay + dy * t;

    for (const off of SAMPLE.perpendicularOffsetsPx) {
      const sx = clampInt(sx0 + px * off, 0, png.width - 1);
      const sy = clampInt(sy0 + py * off, 0, png.height - 1);
      const compId = comps.getComponentIdNear(sx, sy, radius);
      if (compId !== null) return { compId, x: sx, y: sy, offset: off };
    }
  }

  return null;
}

function isCoastlineInkAt(
  waterFillMask: Uint8Array,
  png: PNG,
  x: number,
  y: number,
  // A bit beyond ink thickness
  distPx: number = 10
): boolean {
  const w = png.width;
  // Approximate normal directions: check left/right by sampling a small cross.
  // We'll treat "water on exactly one side" as coastline.
  const sample = (sx: number, sy: number): boolean => {
    const cx = clampInt(sx, 0, png.width - 1);
    const cy = clampInt(sy, 0, png.height - 1);
    return waterFillMask[idxOf(cx, cy, w)] === 1;
  };

  const left = sample(x - distPx, y) || sample(x - distPx, y - 2) || sample(x - distPx, y + 2);
  const right = sample(x + distPx, y) || sample(x + distPx, y - 2) || sample(x + distPx, y + 2);
  return left !== right;
}

function parseEdgeKey(input: string): { a: GridRef; b: GridRef } | null {
  const trimmed = input.trim().replace(/^"|"$/g, "");
  const parts = trimmed.split("|");
  if (parts.length !== 2) return null;
  const parseEndpoint = (s: string): GridRef | null => {
    const [r, c] = s.split(",").map((t) => Number(t.trim()));
    if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
    return { row: r, col: c };
  };
  const a = parseEndpoint(parts[0]!);
  const b = parseEndpoint(parts[1]!);
  if (!a || !b) return null;
  return { a, b };
}

function normalizeSeedEdge(
  rawStart: { Row: number; Col: number },
  rawEnd: { Row: number; Col: number },
  rows: number,
  cols: number
): { start: GridRef; end: GridRef } | null {
  const candidates: Array<{ start: GridRef; end: GridRef }> = [
    { start: { row: rawStart.Row, col: rawStart.Col }, end: { row: rawEnd.Row, col: rawEnd.Col } },
    { start: { row: rawStart.Row, col: rawStart.Col }, end: { row: rawEnd.Col, col: rawEnd.Row } },
    { start: { row: rawStart.Col, col: rawStart.Row }, end: { row: rawEnd.Row, col: rawEnd.Col } },
    { start: { row: rawStart.Col, col: rawStart.Row }, end: { row: rawEnd.Col, col: rawEnd.Row } },
  ];

  for (const c of candidates) {
    if (
      c.start.row < 0 ||
      c.start.row >= rows ||
      c.start.col < 0 ||
      c.start.col >= cols ||
      c.end.row < 0 ||
      c.end.row >= rows ||
      c.end.col < 0 ||
      c.end.col >= cols
    ) {
      continue;
    }
    if (isAdjacentHex(c.start, c.end)) return c;
  }

  return null;
}

function main(): void {
  const png = loadPng(MAP_PNG_PATH);
  const waterMask = buildMask(png, isWaterPixel);
  const waterFillMask = buildMask(png, isWaterFillPixel);
  const riverInkMask = buildMask(png, isRiverInkPixel);
  const { grid, rows, cols } = buildGrid();
  const waterComps = new LazyComponents(png, waterMask);
  const waterFillComps = new LazyComponents(png, waterFillMask);
  const riverInkComps = new LazyComponents(png, riverInkMask);
  const { displayW, displayH } = getMapDisplaySizeWorld();
  const overrides = readExistingOverrides();

  const riversRaw = JSON.parse(fs.readFileSync(RIVERS_JSON_PATH, "utf-8")) as RiverConfig;
  // Map water component id -> set of river names that seeded it.
  const riverComponentsToNames = new Map<number, Set<string>>();

  // Seed river components.
  for (const river of riversRaw) {
    for (const e of river.Edges || []) {
      const norm = normalizeSeedEdge(e.Start, e.End, rows, cols);
      if (!norm) continue;

      const a = grid[norm.start.row]?.[norm.start.col];
      const b = grid[norm.end.row]?.[norm.end.col];
      if (!a || !b) continue;

      const aPx = worldToImagePx(a.x, a.y, png, displayW, displayH);
      const bPx = worldToImagePx(b.x, b.y, png, displayW, displayH);
      const dx = bPx.x - aPx.x;
      const dy = bPx.y - aPx.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const step = SAMPLE.stepPx / len;

      // Use the same sampling logic as edge detection, but with a larger neighborhood so that
      // thin rivers or anti-aliased edges still get picked up for seeding.
      const hit = firstComponentHitAlongSegment(
        riverInkComps,
        png,
        aPx.x,
        aPx.y,
        bPx.x,
        bPx.y,
        SAMPLE.neighborhoodRadiusPx
      );

      if (hit !== null) {
        if (!riverComponentsToNames.has(hit.compId)) riverComponentsToNames.set(hit.compId, new Set());
        riverComponentsToNames.get(hit.compId)!.add(river.Name);
      } else {
        // Keep this quiet by default; if needed we can add a verbose flag.
        // console.warn(`No water pixels found for river seed edge: ${river.Name} ${norm.start.row},${norm.start.col}|${norm.end.row},${norm.end.col}`);
      }
    }
  }

  const riverEdges = new Set<string>();
  const nonRiverWaterEdges = new Set<string>();
  const ambiguousRiverEdges = new Set<string>();
  const riverEdgesByName = new Map<string, Set<string>>();

  // Optional debug: DEBUG_EDGE="43,18|44,18" (row,col|row,col)
  const debugEdgeRaw = process.env.DEBUG_EDGE;
  if (debugEdgeRaw) {
    const parsed = parseEdgeKey(debugEdgeRaw);
    if (!parsed) {
      console.error(`Invalid DEBUG_EDGE format: ${debugEdgeRaw}`);
      process.exitCode = 2;
      return;
    }
    const a = grid[parsed.a.row]?.[parsed.a.col];
    const b = grid[parsed.b.row]?.[parsed.b.col];
    if (!a || !b) {
      console.error(`DEBUG_EDGE endpoint not in grid: ${debugEdgeRaw}`);
      process.exitCode = 2;
      return;
    }
    const aPx = worldToImagePx(a.x, a.y, png, displayW, displayH);
    const bPx = worldToImagePx(b.x, b.y, png, displayW, displayH);
    const hitRiverInk = firstComponentHitAlongSegment(
      riverInkComps,
      png,
      aPx.x,
      aPx.y,
      bPx.x,
      bPx.y,
      SAMPLE.neighborhoodRadiusPx
    );
    const hitWaterFill = firstComponentHitAlongSegment(
      waterFillComps,
      png,
      aPx.x,
      aPx.y,
      bPx.x,
      bPx.y,
      SAMPLE.neighborhoodRadiusPx
    );
    const hitWater = firstComponentHitAlongSegment(
      waterComps,
      png,
      aPx.x,
      aPx.y,
      bPx.x,
      bPx.y,
      SAMPLE.neighborhoodRadiusPx
    );
    console.log("DEBUG_EDGE:", edgeKey(parsed.a, parsed.b));
    console.log(" endpoints:", parsed.a, parsed.b);
    console.log(" terrains:", a.terrain, b.terrain);
    console.log(" world:", { ax: a.x, ay: a.y, bx: b.x, by: b.y });
    console.log(" imagePx:", { ax: aPx, bx: bPx });
    console.log(" firstRiverInkHit:", hitRiverInk);
    console.log(" firstWaterFillHit:", hitWaterFill);
    console.log(" firstWaterAnyHit:", hitWater);
    if (hitRiverInk !== null) {
      console.log(
        " riverNamesForRiverInkComponent:",
        Array.from(riverComponentsToNames.get(hitRiverInk.compId) || [])
      );
      console.log(
        " coastlineInkHeuristic:",
        isCoastlineInkAt(waterFillMask, png, hitRiverInk.x, hitRiverInk.y)
      );
    }
    return;
  }

  // Enumerate all undirected adjacent edges once.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const p = grid[row]?.[col];
      if (!p) continue;
      if (p.terrain === TerrainType.Water) continue;

      for (const n of neighborsOf({ row, col }, rows, cols)) {
        // Undirected edge; only keep one orientation
        if (n.row < row || (n.row === row && n.col <= col)) continue;
        const q = grid[n.row]?.[n.col];
        if (!q) continue;
        if (q.terrain === TerrainType.Water) continue;

        const key = edgeKey({ row, col }, n);

        const pPx = worldToImagePx(p.x, p.y, png, displayW, displayH);
        const qPx = worldToImagePx(q.x, q.y, png, displayW, displayH);
        const hitRiverInk = firstComponentHitAlongSegment(
          riverInkComps,
          png,
          pPx.x,
          pPx.y,
          qPx.x,
          qPx.y,
          SAMPLE.neighborhoodRadiusPx
        );
        if (
          hitRiverInk !== null &&
          riverComponentsToNames.has(hitRiverInk.compId) &&
          !isCoastlineInkAt(waterFillMask, png, hitRiverInk.x, hitRiverInk.y)
        ) {
          riverEdges.add(key);
          const names = riverComponentsToNames.get(hitRiverInk.compId)!;
          if (names.size === 1) {
            const name = Array.from(names)[0]!;
            if (!riverEdgesByName.has(name)) riverEdgesByName.set(name, new Set());
            riverEdgesByName.get(name)!.add(key);
          } else {
            ambiguousRiverEdges.add(key);
          }
          continue;
        }

        const hitWaterFill = firstComponentHitAlongSegment(
          waterFillComps,
          png,
          pPx.x,
          pPx.y,
          qPx.x,
          qPx.y,
          SAMPLE.neighborhoodRadiusPx
        );
        if (hitWaterFill === null) continue;
        nonRiverWaterEdges.add(key);
      }
    }
  }

  // Apply overrides: force classification regardless of image sampling.
  for (const k of overrides.forceRiverEdges) {
    riverEdges.add(k);
    nonRiverWaterEdges.delete(k);
  }
  for (const k of overrides.forceNonRiverWaterEdges) {
    nonRiverWaterEdges.add(k);
    riverEdges.delete(k);
  }

  // Apply exclusions last so they win over everything.
  for (const k of overrides.excludeEdges) {
    riverEdges.delete(k);
    nonRiverWaterEdges.delete(k);
    ambiguousRiverEdges.delete(k);
    for (const set of riverEdgesByName.values()) set.delete(k);
  }

  // Apply overrides (optional; left empty initially)
  const output: WaterCrossingsConfig = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      mapPng: "public/assets/map.png",
      mapCalibration: MAP_BACKGROUND_CALIBRATION,
    },
    classification: {
      waterPixel: { ...WATER_PIXEL },
      sample: { ...SAMPLE },
    },
    overrides,
    riverEdges: Array.from(riverEdges).sort(),
    nonRiverWaterEdges: Array.from(nonRiverWaterEdges).sort(),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");

  const riversGrouped: RiverCrossingsConfig["rivers"] = Array.from(riverEdgesByName.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, edges]) => ({ name, edges: Array.from(edges).sort() }));

  const riverGroupsOut: RiverCrossingsConfig = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rivers: riversGrouped,
    ambiguousEdges: Array.from(ambiguousRiverEdges).sort(),
  };

  fs.writeFileSync(
    RIVER_GROUPS_OUT_PATH,
    JSON.stringify(riverGroupsOut, null, 2) + "\n",
    "utf-8"
  );

  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
  console.log(`River edges: ${output.riverEdges.length}`);
  console.log(`Non-river water edges: ${output.nonRiverWaterEdges.length}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, RIVER_GROUPS_OUT_PATH)}`);
  console.log(`Rivers with unique assignments: ${riversGrouped.length}`);
  console.log(`Ambiguous river edges: ${riverGroupsOut.ambiguousEdges.length}`);
  console.log(
    `Costs: river=${WaterCrossingType.River} nonRiverWater=${WaterCrossingType.Lake} (lake/ocean-inlet)`
  );
}

main();

