import { TerrainType } from '../types/GameTypes';

/** Base build cost per terrain type in ECU millions. */
export const TERRAIN_BUILD_COSTS: Record<TerrainType, number> = {
  [TerrainType.Clear]: 1,
  [TerrainType.Mountain]: 2,
  [TerrainType.Alpine]: 5,
  [TerrainType.SmallCity]: 3,
  [TerrainType.MediumCity]: 3,
  [TerrainType.MajorCity]: 5,
  [TerrainType.FerryPort]: 0,
  [TerrainType.Water]: Infinity,
};

/** Return the build cost for a terrain type in ECU millions. */
export function getTerrainBuildCost(terrain: TerrainType): number {
  return TERRAIN_BUILD_COSTS[terrain] ?? 1;
}
