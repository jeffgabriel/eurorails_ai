import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

interface Milepost {
  Id?: string;
  Type: string;
  Name?: string | null;
  LocationX: number;
  LocationY: number;
  Ocean?: string | null;
}

interface GridPoint {
  Id: string;
  Type: string;
  Name?: string | null;
  GridX: number;
  GridY: number;
  Ocean: string | null;
}

const GridX = 64;
const GridY = 58;

function loadConfig(filePath: string): Milepost[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function convertToGrid(points: Milepost[]): GridPoint[] {
  const occupied = new Set<string>();
  const finalPoints: GridPoint[] = [];

  for (const p of points) {
    const predictedCol = 0.00821 * p.LocationX - 0.0000371 * p.LocationY + 2.34;
    const predictedRow = 0.0000342 * p.LocationX + 0.00968 * p.LocationY - 3.47;

    let col = Math.max(0, Math.min(63, Math.round(predictedCol)));
    let row = Math.max(0, Math.min(57, Math.round(predictedRow)));

    [col, row] = resolveConflict(col, row, occupied);

    occupied.add(`${col},${row}`);
    finalPoints.push({
      Id: uuidv4(),
      Type: p.Type,
      Name: p.Name ?? null,
      GridX: col,
      GridY: row,
      Ocean: p.Ocean ?? null,
    });
  }
  return finalPoints;
}

function resolveConflict(
  x: number,
  y: number,
  occupied: Set<string>
): [number, number] {
  if (!occupied.has(`${x},${y}`)) return [x, y];

  const queue: [number, number][] = [[x, y]];
  const visited = new Set<string>([`${x},${y}`]);

  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];

  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [dx, dy] of directions) {
      const nx = cx + dx;
      const ny = cy + dy;
      const key = `${nx},${ny}`;
      if (nx >= 0 && ny >= 0 && nx < GridX && ny < GridY && !visited.has(key)) {
        if (!occupied.has(key)) return [nx, ny];
        queue.push([nx, ny]);
        visited.add(key);
      }
    }
  }

  throw new Error("No available grid cell found.");
}

if (require.main === module) {
  const configPath = "/Users/Jeff/Downloads/Config_Mileposts.json";
  const originalData = loadConfig(configPath);
  const gridPoints = convertToGrid(originalData);

  const outputPath = path.resolve(__dirname, 'Mapped_GridPoints.json');
  fs.writeFileSync(outputPath, JSON.stringify(gridPoints, null, 2), 'utf-8');
} 
