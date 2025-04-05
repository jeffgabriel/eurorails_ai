import { MapConfig, TerrainType } from '../../shared/types/GameTypes';

export const mapConfig: MapConfig = {
    width: 70,
    height: 90,
    points: [
        // Example major city (Berlin) - center point
        {
            row: 20,
            col: 35,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MajorCity,
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
        { row: 19, col: 34, terrain: TerrainType.Clear },
        { row: 19, col: 35, terrain: TerrainType.Clear },
        { row: 20, col: 34, terrain: TerrainType.Clear },
        { row: 20, col: 36, terrain: TerrainType.Clear },
        { row: 21, col: 34, terrain: TerrainType.Clear },
        { row: 21, col: 35, terrain: TerrainType.Clear },

        // Paris - Major City
        {
            row: 40,
            col: 30,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MajorCity,
                name: 'Paris',
                connectedPoints: [
                    // Center point
                    { row: 40, col: 30 },
                    // Top points
                    { row: 39, col: 29 },
                    { row: 39, col: 30 },
                    // Middle points
                    { row: 40, col: 29 },
                    { row: 40, col: 31 },
                    // Bottom points
                    { row: 41, col: 29 },
                    { row: 41, col: 30 }
                ]
            }
        },
        // Connected points for Paris
        { row: 39, col: 29, terrain: TerrainType.Clear },
        { row: 39, col: 30, terrain: TerrainType.Clear },
        { row: 40, col: 29, terrain: TerrainType.Clear },
        { row: 40, col: 31, terrain: TerrainType.Clear },
        { row: 41, col: 29, terrain: TerrainType.Clear },
        { row: 41, col: 30, terrain: TerrainType.Clear },

        // Example regular city (Frankfurt)
        {
            row: 25,
            col: 30,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MediumCity,
                name: 'Frankfurt'
            }
        },

        // Example small city (Heidelberg)
        {
            row: 25,
            col: 35,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.SmallCity,
                name: 'Heidelberg'
            }
        },

        // Example ferry ports with connection (English Channel)
        { 
            row: 40, 
            col: 20, 
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 40, col: 25 }
        },
        { 
            row: 40, 
            col: 25, 
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 40, col: 20 }
        },
        
        // Example water points for a lake
        { row: 50, col: 50, terrain: TerrainType.Water },
        { row: 50, col: 51, terrain: TerrainType.Water },
        { row: 51, col: 50, terrain: TerrainType.Water },
        { row: 51, col: 51, terrain: TerrainType.Water },
        
        // Example mountain range
        { row: 45, col: 30, terrain: TerrainType.Mountain },
        { row: 45, col: 31, terrain: TerrainType.Mountain },
        { row: 46, col: 30, terrain: TerrainType.Mountain },
        { row: 46, col: 31, terrain: TerrainType.Alpine }
    ]
}; 