import crossings from "../../../configuration/waterCrossings.json";
import { GridPoint, WaterCrossingType } from "../types/GameTypes";

type WaterCrossingsJson = {
  riverEdges: string[];
  nonRiverWaterEdges: string[];
  overrides?: {
    forceRiverEdges?: string[];
    forceNonRiverWaterEdges?: string[];
    // Keys look like: "43,18|44,18" (row,col|row,col) - add in waterCrossings.json
    excludeEdges?: string[];
  };
};

const json = crossings as unknown as WaterCrossingsJson;

function edgeKey(a: { row: number; col: number }, b: { row: number; col: number }): string {
  const aKey = `${a.row},${a.col}`;
  const bKey = `${b.row},${b.col}`;
  return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

// Precompute sets once for O(1) lookup.
const riverSet = new Set<string>([
  ...(json.riverEdges || []),
  ...(json.overrides?.forceRiverEdges || []),
]);

const nonRiverSet = new Set<string>([
  ...(json.nonRiverWaterEdges || []),
  ...(json.overrides?.forceNonRiverWaterEdges || []),
]);

const excludedSet = new Set<string>(json.overrides?.excludeEdges || []);

export function getOverrideSnapshot(): {
  forceRiverEdges: string[];
  forceNonRiverWaterEdges: string[];
  excludeEdges: string[];
} {
  return {
    forceRiverEdges: [...(json.overrides?.forceRiverEdges || [])],
    forceNonRiverWaterEdges: [...(json.overrides?.forceNonRiverWaterEdges || [])],
    excludeEdges: [...(json.overrides?.excludeEdges || [])],
  };
}

// Includes excluded edges; intended for debug tooling / pickers.
export function getAllWaterCrossingEdgeKeysUnfiltered(): string[] {
  return Array.from(
    new Set<string>([
      ...(json.riverEdges || []),
      ...(json.nonRiverWaterEdges || []),
      ...(json.overrides?.forceRiverEdges || []),
      ...(json.overrides?.forceNonRiverWaterEdges || []),
      ...(json.overrides?.excludeEdges || []),
    ])
  );
}

// If an edge is in both due to overrides, force river (cheaper and matches game rules intent).
export function getWaterCrossingExtraCost(from: GridPoint, to: GridPoint): number {
  const key = edgeKey(from, to);
  if (excludedSet.has(key)) return 0;
  if (riverSet.has(key)) return WaterCrossingType.River; // 2
  if (nonRiverSet.has(key)) return WaterCrossingType.Lake; // 3 (also used for ocean inlet)
  return 0;
}

// Debug/inspection helpers
export function getRiverCrossingEdgeKeys(): string[] {
  // Include overrides; ensure uniqueness.
  return Array.from(
    new Set<string>([...(json.riverEdges || []), ...(json.overrides?.forceRiverEdges || [])])
  ).filter((k) => !excludedSet.has(k));
}

export function getNonRiverWaterCrossingEdgeKeys(): string[] {
  // Include overrides; ensure uniqueness.
  return Array.from(
    new Set<string>([
      ...(json.nonRiverWaterEdges || []),
      ...(json.overrides?.forceNonRiverWaterEdges || []),
    ])
  ).filter((k) => !excludedSet.has(k));
}

export function getExcludedCrossingEdgeKeys(): string[] {
  return Array.from(excludedSet);
}

