import { MapConfig, TerrainType, GridPoint, FerryConnection } from "../../shared/types/GameTypes";
import mileposts from "../../../configuration/gridPoints.json";
import ferryPoints from "../../../configuration/ferryPoints.json";

// Define spacing constants directly here to avoid circular dependency with MapRenderer
export const HORIZONTAL_SPACING = 45;
export const VERTICAL_SPACING = 40;
export const GRID_MARGIN = 100;

const gridRows = 58;
const gridCols = 64;

// Helper function to calculate world coordinates from grid coordinates
function calculateWorldCoordinates(col: number, row: number): { x: number, y: number } {
  const isOffsetRow = row % 2 === 1;
  const x = col * HORIZONTAL_SPACING + GRID_MARGIN + (isOffsetRow ? HORIZONTAL_SPACING / 2 : 0);
  const y = row * VERTICAL_SPACING + GRID_MARGIN;
  return { x, y };
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

// Group major city outposts by name
const majorCityGroups: { [name: string]: any[] } = {};

// Build points array
const points: GridPoint[] = [];

// First, handle all non-major city outposts
(mileposts as any[])
  .forEach(mp => {
    if (typeof mp.GridX !== 'number' || typeof mp.GridY !== 'number') return;
    let col = mp.GridX;
    let row = mp.GridY;
    assignedCells.add(`${col},${row}`);
    const terrain = mapTypeToTerrain(mp.Type);
    const { x, y } = calculateWorldCoordinates(col, row);
    // Build the GridPoint directly
    const gridPoint: GridPoint = {
      x: x,
      y: y,
      col,
      row,
      terrain,
      id: mp.Id,
      // Only assign city for small, medium, and ferry port cities
      city: (mp.Type === "Small City" || mp.Type === "Medium City" || mp.Type === "Ferry Port") && mp.Name
        ? {
            type: terrain,
            name: mp.Name,
            availableLoads: [],
          }
        : undefined,
      // Set ocean if present
      ...(mp.Ocean ? { ocean: mp.Ocean } : {})
    };
    // Group major city outposts and centers for second pass
    if (mp.Type === "Major City Outpost" && mp.Name) {
      if (!majorCityGroups[mp.Name]) {
        majorCityGroups[mp.Name] = [];
      }
      majorCityGroups[mp.Name].push(mp);
    } else if (mp.Type === "Major City") {
      if (!majorCityGroups[mp.Name] || majorCityGroups[mp.Name].length === 0) {
        majorCityGroups[mp.Name] = [mp];
      } else {
        majorCityGroups[mp.Name].splice(0, 0, mp);
      }
    }
    points.push(gridPoint);
  });

// Now, handle major cities as a group (center + outposts)
Object.entries(majorCityGroups).forEach(([name, group]) => {
  // Use the first outpost as the center
  const center = group[0];
  if (!center || typeof center.GridX !== 'number' || typeof center.GridY !== 'number') return;
  const col = center.GridX;
  const row = center.GridY;
  
  const connectedPoints = group.slice(1, 7).map(outpost => ({ col: outpost.GridX, row: outpost.GridY }));

  points.push({
    id: center.id,
    x: center.GridX,
    y: center.GridY,
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

// Create a lookup map of grid points by their ID
const gridPointLookup = new Map<string, GridPoint>();
points.forEach(point => {
  if (point.id) {
    gridPointLookup.set(point.id, point);
  }
});

// Load and process ferry connections
const ferryConnections: FerryConnection[] = ferryPoints.ferryPoints.map(ferry => {
  const point1 = gridPointLookup.get(ferry.connections[0]);
  const point2 = gridPointLookup.get(ferry.connections[1]);
  
  if (!point1 || !point2) {
    throw new Error(`Invalid ferry connection: Could not find grid points for ${ferry.Name}`);
  }

  // Set ferry connection on both points and update their terrain type
  const ferryConnection: FerryConnection = {
    Name: ferry.Name,
    connections: [point1, point2],
    cost: ferry.cost
  };
  point1.ferryConnection = ferryConnection;
  point2.ferryConnection = ferryConnection;
  point1.terrain = TerrainType.FerryPort;
  point2.terrain = TerrainType.FerryPort;

  return ferryConnection;
});

// Use fixed width and height for the grid
const width = gridCols;
const height = gridRows;

export const mapConfig: MapConfig = {
  width,
  height,
  points,
  ferryConnections, // Add ferry connections to the config
};

export { majorCityGroups };
