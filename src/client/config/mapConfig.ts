import { MapConfig, TerrainType, GridPoint } from "../../shared/types/GameTypes";
import mileposts from "../../../configuration/mileposts.json";

// Compute min/max for normalization
const xs = (mileposts as any[]).map(mp => mp.LocationX).filter((x: number) => typeof x === 'number');
const ys = (mileposts as any[]).map(mp => mp.LocationY).filter((y: number) => typeof y === 'number');
const min_x = Math.min(...xs);
const max_x = Math.max(...xs);
const min_y = Math.min(...ys);
const max_y = Math.max(...ys);

const gridRows = 61;
const gridCols = 61;

function toLocalGrid(x: number, y: number): { col: number; row: number } {
  const normX = (x - min_x) / (max_x - min_x);
  const normY = (y - min_y) / (max_y - min_y);
  const col = Math.floor(normX * (gridCols - 1));
  const row = Math.floor(normY * (gridRows - 1));
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

// Helper for flat-topped hex grid (even-q offset)
function getFlatTopHexNeighbors(col: number, row: number): { col: number; row: number }[] {
  // Even-q offset (flat-topped)
  // See https://www.redblobgames.com/grids/hexagons/#neighbors-offset
  const evenq_directions = [
    [+1,  0], [0, +1], [-1, +1],
    [-1,  0], [0, -1], [+1, -1]
  ];
  const oddq_directions = [
    [+1,  0], [+1, +1], [0, +1],
    [-1,  0], [0, -1], [+1, -1]
  ];
  const directions = col % 2 === 0 ? evenq_directions : oddq_directions;
  return directions.map(([dc, dr]) => ({ col: col + dc, row: row + dr }));
}

// Now, handle major cities as a group (center + outposts)
Object.entries(majorCityGroups).forEach(([name, group]) => {
  // Use the first outpost as the center
  const center = group[0];
  if (!center || typeof center.LocationX !== 'number' || typeof center.LocationY !== 'number') return;
  const { col, row } = toLocalGrid(center.LocationX, center.LocationY);
  if (col === undefined || row === undefined) return;

  // Compute the 6 true hex neighbors for this center, in flat-topped hex order
  // Order: E, SE, SW, W, NW, NE (clockwise from the right)
  const neighborCoords = getFlatTopHexNeighbors(col, row);

  // Map outpost points for quick lookup
  const outpostSet = new Set(group
    .map(mp => {
      if (typeof mp.LocationX !== 'number' || typeof mp.LocationY !== 'number') return undefined;
      const outColRow = toLocalGrid(mp.LocationX, mp.LocationY);
      if (outColRow.col === col && outColRow.row === row) return undefined; // skip center
      return `${outColRow.col},${outColRow.row}`;
    })
    .filter(Boolean)
  );

  // Use all 6 neighbor coordinates for a complete hexagon, even if not all are in the outpost set
  // This ensures we have a complete hexagon for every major city
  const connectedPoints = neighborCoords;

  points.push({
    x: center.LocationX,
    y: center.LocationY,
    col,
    row,
    terrain: TerrainType.MajorCity,
    city: {
      type: TerrainType.MajorCity,
      name,
      connectedPoints, // Always 6, in flat-topped hex order
      availableLoads: [],
    }
  });
});

// Use fixed width and height for the grid
const width = gridCols;
const height = gridRows;

export const mapConfig: MapConfig = {
  width,
  height,
  points,
};
