/**
 * Data transformation utilities for processing load_cities.json
 * into formats suitable for the LoadsReferencePanel UI.
 */

/**
 * Input structure from configuration/load_cities.json
 */
export interface LoadConfiguration {
  LoadConfiguration: LoadConfigEntry[];
}

/**
 * Each entry has a resource name key mapping to city array, plus count
 */
export interface LoadConfigEntry {
  [resourceName: string]: string[] | number;
  count: number;
}

/**
 * Transformed data for the Resource Table (By Resource tab)
 */
export interface ResourceTableEntry {
  name: string;       // "Bauxite"
  cities: string[];   // ["Budapest", "Marseille"]
  count: number;      // 3
  iconKey: string;    // "loads/Bauxite" (Phaser texture key)
}

/**
 * Transformed data for the City Table (By City tab)
 */
export interface CityTableEntry {
  name: string;           // "Budapest"
  resources: string[];    // ["Bauxite", "Beer", ...]
}

/**
 * Parse raw load configuration into ResourceTableEntry array.
 * Extracts resource name, cities, count, and generates icon key.
 * Returns alphabetically sorted by resource name.
 *
 * @param config - Raw LoadConfiguration from load_cities.json
 * @returns Array of ResourceTableEntry sorted by name
 */
export function parseResourceData(config: LoadConfiguration): ResourceTableEntry[] {
  if (!config?.LoadConfiguration || !Array.isArray(config.LoadConfiguration)) {
    return [];
  }

  return config.LoadConfiguration
    .map(entry => {
      // Find the resource name key (excludes 'count')
      const keys = Object.keys(entry).filter(k => k !== 'count');
      if (keys.length === 0) {
        return null;
      }

      const resourceName = keys[0];
      const cities = entry[resourceName];

      // Validate cities is an array
      if (!Array.isArray(cities)) {
        return null;
      }

      return {
        name: resourceName,
        cities: cities as string[],
        count: typeof entry.count === 'number' ? entry.count : 0,
        iconKey: `load-${resourceName.toLowerCase()}`
      };
    })
    .filter((entry): entry is ResourceTableEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
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
