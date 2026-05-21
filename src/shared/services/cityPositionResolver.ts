import { getMajorCityLookup } from './majorCityGroups';

/**
 * Returns the city name at a grid position, or null if not a city.
 * Checks major cities via getMajorCityLookup() first, then falls back
 * to the gridPoints map for small/medium cities.
 *
 * @param gridPoints - Map keyed by "row,col" with optional name field.
 *   Callers pass loadGridPoints() result (satisfies structural type).
 */
export function getCityNameAtPosition(
  row: number,
  col: number,
  gridPoints: Map<string, { name?: string }>,
): string | null {
  const key = `${row},${col}`;

  // Check major cities first (includes center + outpost mileposts)
  const majorCityName = getMajorCityLookup().get(key);
  if (majorCityName) return majorCityName;

  // Fall back to small/medium city name from grid data
  return gridPoints.get(key)?.name ?? null;
}

/**
 * Returns whether a grid position corresponds to any milepost of the named city.
 * For major cities, checks all mileposts (center + outposts) via getMajorCityLookup().
 * For small/medium cities, checks the single grid point name.
 */
export function isPositionAtCity(
  row: number,
  col: number,
  cityName: string,
  gridPoints: Map<string, { name?: string }>,
): boolean {
  const resolved = getCityNameAtPosition(row, col, gridPoints);
  return resolved === cityName;
}
