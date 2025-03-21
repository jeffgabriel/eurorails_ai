import { MapConfig, TerrainType } from '../../shared/types/GridTypes';

export const mapConfig: MapConfig = {
    width: 70,
    height: 90,
    points: [
        // Example ferry ports with connection (English Channel)
        { 
            row: 40, 
            col: 20, 
            terrain: TerrainType.FERRY_PORT,
            ferryConnection: { row: 40, col: 25 }
        },
        { 
            row: 40, 
            col: 25, 
            terrain: TerrainType.FERRY_PORT,
            ferryConnection: { row: 40, col: 20 }
        },
        // Example ferry ports (North Sea)
        {
            row: 30,
            col: 35,
            terrain: TerrainType.FERRY_PORT,
            ferryConnection: { row: 30, col: 40 }
        },
        {
            row: 30,
            col: 40,
            terrain: TerrainType.FERRY_PORT,
            ferryConnection: { row: 30, col: 35 }
        },
        
        // Example water points for a lake
        { row: 50, col: 50, terrain: TerrainType.WATER },
        { row: 50, col: 51, terrain: TerrainType.WATER },
        { row: 51, col: 50, terrain: TerrainType.WATER },
        { row: 51, col: 51, terrain: TerrainType.WATER },
        
        // Example mountain range
        { row: 45, col: 30, terrain: TerrainType.MOUNTAIN },
        { row: 45, col: 31, terrain: TerrainType.MOUNTAIN },
        { row: 46, col: 30, terrain: TerrainType.MOUNTAIN },
        { row: 46, col: 31, terrain: TerrainType.HILL }
    ]
}; 