export interface LoadConfiguration {
  [loadType: string]: {
    cities: string[];
    count: number;
  };
}

export interface LoadState {
  loadType: string;
  availableCount: number;
  totalCount: number;
  cities: string[];
  cityLoads?: Map<string, string>; // Maps city name to load type for loads dropped in cities that don't produce them
}

export enum LoadType {
  Bauxite = 'Bauxite',
  Beer = 'Beer',
  Cars = 'Cars',
  Flowers = 'Flowers',
  Sheep = 'Sheep',
  Cattle = 'Cattle',
  Cheese = 'Cheese',
  Ham = 'Ham',
  Steel = 'Steel',
  Hops = 'Hops',
  Imports = 'Imports',
  China = 'China',
  Tobacco = 'Tobacco',
  Iron = 'Iron',
  Tourists = 'Tourists',
  Wheat = 'Wheat',
  Coal = 'Coal',
  Wine = 'Wine',
  Machinery = 'Machinery',
  Marble = 'Marble',
  Labor = 'Labor',
  Fish = 'Fish',
  Oranges = 'Oranges',
  Chocolate = 'Chocolate',
  Copper = 'Copper',
  Potatoes = 'Potatoes',
  Wood = 'Wood',
  Oil = 'Oil',
  Cork = 'Cork'
}

export interface RawLoadConfigItem extends Record<string, unknown> {
  count: number;
}

export interface RawLoadConfig {
  LoadConfiguration: RawLoadConfigItem[];
} 