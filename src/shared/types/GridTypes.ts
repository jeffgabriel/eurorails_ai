export enum TerrainType {
    LAND = 'LAND',
    WATER = 'WATER',
    HILL = 'HILL',
    MOUNTAIN = 'MOUNTAIN',
    FERRY_PORT = 'FERRY_PORT'
}

export enum CityType {
    MAJOR_CITY = 'MAJOR_CITY',
    CITY = 'CITY',
    SMALL_CITY = 'SMALL_CITY'
}

export interface CityConfig {
    type: CityType;
    name: string;
    // For major cities, we need to know which points form the hexagon
    connectedPoints?: Array<{ row: number; col: number }>;
}

export interface GridPointConfig {
    row: number;
    col: number;
    terrain: TerrainType;
    ferryConnection?: {
        row: number;
        col: number;
    };
    city?: CityConfig;
}

export interface MapConfig {
    width: number;
    height: number;
    points: GridPointConfig[];
} 