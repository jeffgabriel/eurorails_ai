import crossings from "../../../configuration/waterCrossings.json";
import { GridPoint, WaterCrossingType } from "../types/GameTypes";

type WaterCrossingsJson = {
  riverEdges: string[];
  nonRiverWaterEdges: string[];
};

const json = crossings as unknown as WaterCrossingsJson;

function edgeKey(a: { row: number; col: number }, b: { row: number; col: number }): string {
  const aKey = `${a.row},${a.col}`;
  const bKey = `${b.row},${b.col}`;
  return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

// Precompute sets once for O(1) lookup.
const riverSet = new Set<string>(json.riverEdges || []);
const nonRiverSet = new Set<string>(json.nonRiverWaterEdges || []);

export function getWaterCrossingExtraCost(from: GridPoint, to: GridPoint): number {
  const key = edgeKey(from, to);
  if (riverSet.has(key)) return WaterCrossingType.River; // 2
  if (nonRiverSet.has(key)) return WaterCrossingType.Lake; // 3 (also used for ocean inlet)
  return 0;
}
