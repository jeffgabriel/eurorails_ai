export enum TerrainType {
    LAND = 'land',
    WATER = 'water',
    HILL = 'hill',
    MOUNTAIN = 'mountain',
    FERRY_PORT = 'ferry_port'
}

export interface GridPointConfig {
    row: number;
    col: number;
    terrain: TerrainType;
    ferryConnection?: {
        row: number;
        col: number;
    };
}

export interface MapConfig {
    width: number;
    height: number;
    points: GridPointConfig[];
} 