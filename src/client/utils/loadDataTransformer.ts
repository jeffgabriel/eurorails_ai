/**
 * Data transformation utilities for processing resource data
 * into formats suitable for the LoadsReferencePanel UI.
 */

/**
 * Transformed data for the Resource Table (By Resource tab)
 */
export interface ResourceTableEntry {
  name: string;       // "Bauxite"
  cities: string[];   // ["Budapest", "Marseille"]
  count: number;      // 3
  iconKey: string;    // "load-bauxite" (Phaser texture key)
}

/**
 * Transformed data for the City Table (By City tab)
 */
export interface CityTableEntry {
  name: string;           // "Budapest"
  resources: string[];    // ["Bauxite", "Beer", ...]
}

/**
 * Transform ResourceTableEntry array into CityTableEntry array.
 * Aggregates resources by city.
 * Returns alphabetically sorted by city name.
 *
 * @param resources - Array of ResourceTableEntry from parseResourceData
 * @returns Array of CityTableEntry sorted by city name
 */
export function transformToCityData(resources: ResourceTableEntry[]): CityTableEntry[] {
  if (!resources || !Array.isArray(resources)) {
    return [];
  }

  const cityMap = new Map<string, string[]>();

  for (const resource of resources) {
    if (!resource.cities || !Array.isArray(resource.cities)) {
      continue;
    }

    for (const city of resource.cities) {
      if (!cityMap.has(city)) {
        cityMap.set(city, []);
      }
      cityMap.get(city)!.push(resource.name);
    }
  }

  return Array.from(cityMap.entries())
    .map(([name, resourceList]) => ({
      name,
      resources: resourceList.sort((a, b) => a.localeCompare(b)) // Sort resources alphabetically within each city
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
