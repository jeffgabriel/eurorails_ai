import { MapConfig, TerrainType, CityType } from '../../shared/types/GridTypes';

export const mapConfig: MapConfig = {
    width: 70,
    height: 90,
    points: [
        // Example major city (Berlin) - center point
        {
            row: 20,
            col: 35,
            terrain: TerrainType.LAND,
            city: {
                type: CityType.MAJOR_CITY,
                name: 'Berlin',
                connectedPoints: [
                    // Center point
                    { row: 20, col: 35 },
                    // Top points
                    { row: 19, col: 34 },
                    { row: 19, col: 35 },
                    // Middle points
                    { row: 20, col: 34 },
                    { row: 20, col: 36 },
                    // Bottom points
                    { row: 21, col: 34 },
                    { row: 21, col: 35 }
                ]
            }
        },
        // Connected points for Berlin
        { row: 19, col: 34, terrain: TerrainType.LAND },
        { row: 19, col: 35, terrain: TerrainType.LAND },
        { row: 20, col: 34, terrain: TerrainType.LAND },
        { row: 20, col: 36, terrain: TerrainType.LAND },
        { row: 21, col: 34, terrain: TerrainType.LAND },
        { row: 21, col: 35, terrain: TerrainType.LAND },

        // Example regular city (Frankfurt)
        {
            row: 25,
            col: 30,
            terrain: TerrainType.LAND,
            city: {
                type: CityType.CITY,
                name: 'Frankfurt'
            }
        },

        // Example small city (Heidelberg)
        {
            row: 25,
            col: 35,
            terrain: TerrainType.LAND,
            city: {
                type: CityType.SMALL_CITY,
                name: 'Heidelberg'
            }
        },

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