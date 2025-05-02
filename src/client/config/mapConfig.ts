import { MapConfig, TerrainType, GridPoint } from "../../shared/types/GameTypes";
import mileposts from "../../../configuration/mileposts.json";

const min_x = 45.836;
const min_y = 325.591;
const avg_dx = 208.421;
const avg_dy = 114.367;

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

// Group major city outposts by name
const majorCityGroups: { [name: string]: any[] } = {};
mileposts.forEach((mp: any) => {
  if (mp.Type === "Major City Outpost" && mp.Name) {
    if (!majorCityGroups[mp.Name]) majorCityGroups[mp.Name] = [];
    majorCityGroups[mp.Name].push(mp);
  }
});

// Build points array
const points: GridPoint[] = (mileposts as any[])
  .filter(mp => mp.Type !== "Major City Outpost") // We'll add major cities separately
  .map(mp => {
    if (typeof mp.LocationX !== 'number' || typeof mp.LocationY !== 'number') return undefined;
    const { col, row } = toLocalGrid(mp.LocationX, mp.LocationY);
    if (col === undefined || row === undefined) return undefined;
    const terrain = mapTypeToTerrain(mp.Type);
    const base: GridPoint = { x: mp.LocationX, y: mp.LocationY, col, row, terrain };
    if (mp.Name && (mp.Type === "Small City" || mp.Type === "Medium City" || mp.Type === "Major City")) {
      base.city = {
        type: terrain,
        name: mp.Name,
        availableLoads: [], // TODO: Fill from config or rules
      };
    }
    if (mp.Ocean) {
      (base as any).ocean = mp.Ocean;
    }
    return base;
  })
  .filter((p): p is GridPoint => Boolean(p)); // Remove any undefined entries and type narrow

// Add major cities as single points with connectedPoints
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
      availableLoads: [], // TODO: Fill from config or rules
    }
  });
});

export const mapConfig: MapConfig = {
  width: 70, // Optionally compute from data
  height: 90, // Optionally compute from data
  points,
};
