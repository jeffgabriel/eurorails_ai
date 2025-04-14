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
}

// Raw interface matching the JSON structure
export type LoadType = 'Bauxite' | 'Beer' | 'Cars' | 'Flowers' | 'Sheep' | 'Cattle' | 
                      'Cheese' | 'Ham' | 'Steel' | 'Hops' | 'Imports' | 'China' | 
                      'Tobacco' | 'Iron' | 'Tourists' | 'Wheat' | 'Coal' | 'Wine' | 
                      'Machinery' | 'Marble';

export interface RawLoadConfigItem extends Record<string, unknown> {
  count: number;
}

export interface RawLoadConfig {
  LoadConfiguration: RawLoadConfigItem[];
} 