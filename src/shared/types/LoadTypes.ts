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

/** A load chip lying in a city (dropped there, not native to it). */
export interface DroppedLoad {
  city_name: string;
  type: LoadType;
}

/** A change to the number of chips of one load type in the tray. */
export interface LoadTrayChange {
  loadType: LoadType;
  /** +1 when a chip went back to the tray, -1 when one was taken from it. */
  delta: number;
}

/**
 * Server response for a load pickup, a load drop, or the undo of either
 * (`POST /api/players/pickup-load`, `/drop-load`, `/undo-last-action`).
 */
export interface LoadActionResult {
  /** The loads on the player's train after the action. */
  updatedLoads: LoadType[];
  /** Every dropped load chip in the game after the action. */
  droppedLoads: DroppedLoad[];
  /** Tray changes the action caused. */
  trayChanges: LoadTrayChange[];
}
