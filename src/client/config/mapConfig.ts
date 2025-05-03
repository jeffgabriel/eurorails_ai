import { MapConfig, TerrainType, GridPoint } from "../../shared/types/GameTypes";
import mileposts from "../../../configuration/mileposts.json";

const min_x = 45.836;
const min_y = 319.591;
const avg_dx = 150;
const avg_dy = 120;

function toLocalGrid(x: number, y: number): { col: number; row: number } {
  const col = Math.round((x - min_x) / avg_dx);
  const row = Math.round((y - min_y) / avg_dy);
  return { col, row };
}

function mapTypeToTerrain(type: string): TerrainType {
  switch (type) {
    case "Clear":
    case "Milepost":
      return TerrainType.Clear;
    case "Mountain":
      return TerrainType.Mountain;
    case "Alpine":
      return TerrainType.Alpine;
    case "Small City":
      return TerrainType.SmallCity;
    case "Medium City":
      return TerrainType.MediumCity;
    case "Major City":
      return TerrainType.MajorCity;
    case "Major City Outpost":
      return TerrainType.MajorCity;
    case "Ferry Port":
      return TerrainType.FerryPort;
    case "Water":
      return TerrainType.Water;
    default:
      throw new Error(`Unknown type: ${type}`);
  }
}

const assignedCells = new Set<string>();

function findNearestAvailableCell(col: number, row: number): { col: number, row: number } {
  // Try the intended cell first
  if (!assignedCells.has(`${col},${row}`)) return { col, row };

  // Spiral search for the nearest available cell
  for (let radius = 1; radius < 20; radius++) {
    for (let dCol = -radius; dCol <= radius; dCol++) {
      for (let dRow = -radius; dRow <= radius; dRow++) {
        if (Math.abs(dCol) !== radius && Math.abs(dRow) !== radius) continue; // Only check the border
        const tryCol = col + dCol;
        const tryRow = row + dRow;
        if (!assignedCells.has(`${tryCol},${tryRow}`)) {
          return { col: tryCol, row: tryRow };
        }
      }
    }
  }
  throw new Error('No available cell found for point!');
}

// Group major city outposts by name
const majorCityGroups: { [name: string]: any[] } = {};
mileposts.forEach((mp: any) => {
  if (mp.Type === "Major City Outpost" && mp.Name) {
    if (!majorCityGroups[mp.Name]) majorCityGroups[mp.Name] = [];
    majorCityGroups[mp.Name].push(mp);
  }
});

// Build points array
const points: GridPoint[] = [];

// First, handle all non-major city outposts
(mileposts as any[])
  .filter(mp => mp.Type !== "Major City Outpost")
  .forEach(mp => {
    if (typeof mp.LocationX !== 'number' || typeof mp.LocationY !== 'number') return;
    let { col, row } = toLocalGrid(mp.LocationX, mp.LocationY);
    // For major cities, skip for now (we'll handle as a group below)
    if (mp.Type === "Major City") return;
    ({ col, row } = findNearestAvailableCell(col, row));
    assignedCells.add(`${col},${row}`);
    const terrain = mapTypeToTerrain(mp.Type);
    const base: GridPoint = { x: mp.LocationX, y: mp.LocationY, col, row, terrain };
    if (mp.Name && (mp.Type === "Small City" || mp.Type === "Medium City")) {
      base.city = {
        type: terrain,
        name: mp.Name,
        availableLoads: [],
      };
    }
    if (mp.Ocean) {
      (base as any).ocean = mp.Ocean;
    }
    points.push(base);
  });

// Now, handle major cities as a group (center + outposts)
Object.entries(majorCityGroups).forEach(([name, group]) => {
  const connectedPoints = group
    .map(mp => {
      if (typeof mp.LocationX !== 'number' || typeof mp.LocationY !== 'number') return undefined;
      const { col, row } = toLocalGrid(mp.LocationX, mp.LocationY);
      if (col === undefined || row === undefined) return undefined;
      return { col, row };
    })
    .filter((p): p is { col: number; row: number } => Boolean(p));
  // Use the first outpost as the "center"
  const center = group[0];
  if (!center || connectedPoints.length === 0) return; // skip if no valid points
  const { col, row } = toLocalGrid(center.LocationX, center.LocationY);
  if (col === undefined || row === undefined) return; // skip if center is invalid
  points.push({
    x: center.LocationX,
    y: center.LocationY,
    col,
    row,
    terrain: TerrainType.MajorCity,
    city: {
      type: TerrainType.MajorCity,
      name,
      connectedPoints,
      availableLoads: [],
    }
  });
});

// Compute width and height dynamically from points
const width = Math.max(...points.map(p => p.col)) + 1;
const height = Math.max(...points.map(p => p.row)) + 1;

export const mapConfig: MapConfig = {
  width,
  height,
  points,
};
