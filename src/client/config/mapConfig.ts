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
        
        // Example mountain range
        { row: 45, col: 30, terrain: TerrainType.Mountain },
        { row: 45, col: 31, terrain: TerrainType.Mountain },
        { row: 46, col: 30, terrain: TerrainType.Mountain },
        { row: 46, col: 31, terrain: TerrainType.Alpine },
        
        // Small city (Saarbrücken) with surrounding clear terrain
        {
            row: 32,
            col: 32,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.SmallCity,
                name: 'Saarbrücken'
            }
        },
        
        // Mountain range in central region
        { row: 30, col: 33, terrain: TerrainType.Mountain },
        { row: 29, col: 33, terrain: TerrainType.Mountain },
        { row: 28, col: 33, terrain: TerrainType.Alpine },
        { row: 28, col: 34, terrain: TerrainType.Mountain },

        // Ferry ports across the lake
        { 
            row: 28, 
            col: 39, 
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 36, col: 38 }
        },
        { 
            row: 36, 
            col: 38, 
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 28, col: 39 }
        },

        // Lake points (from coordinate list)
        { row: 29, col: 30, terrain: TerrainType.Water },
        { row: 29, col: 37, terrain: TerrainType.Water },
        { row: 29, col: 38, terrain: TerrainType.Water },
        { row: 29, col: 39, terrain: TerrainType.Water },
        { row: 29, col: 40, terrain: TerrainType.Water },
        { row: 30, col: 37, terrain: TerrainType.Water },
        { row: 30, col: 38, terrain: TerrainType.Water },
        { row: 30, col: 39, terrain: TerrainType.Water },
        { row: 30, col: 40, terrain: TerrainType.Water },
        { row: 30, col: 41, terrain: TerrainType.Water },
        { row: 31, col: 35, terrain: TerrainType.Water },
        { row: 31, col: 36, terrain: TerrainType.Water },
        { row: 31, col: 37, terrain: TerrainType.Water },
        { row: 31, col: 38, terrain: TerrainType.Water },
        { row: 31, col: 39, terrain: TerrainType.Water },
        { row: 31, col: 40, terrain: TerrainType.Water },
        { row: 31, col: 41, terrain: TerrainType.Water },
        { row: 32, col: 35, terrain: TerrainType.Water },
        { row: 32, col: 36, terrain: TerrainType.Water },
        { row: 32, col: 37, terrain: TerrainType.Water },
        { row: 32, col: 38, terrain: TerrainType.Water },
        { row: 32, col: 39, terrain: TerrainType.Water },
        { row: 32, col: 40, terrain: TerrainType.Water },
        { row: 32, col: 41, terrain: TerrainType.Water },
        { row: 32, col: 42, terrain: TerrainType.Water },
        { row: 32, col: 43, terrain: TerrainType.Water },
        { row: 33, col: 35, terrain: TerrainType.Water },
        { row: 33, col: 36, terrain: TerrainType.Water },
        { row: 33, col: 37, terrain: TerrainType.Water },
        { row: 33, col: 38, terrain: TerrainType.Water },
        { row: 33, col: 39, terrain: TerrainType.Water },
        { row: 33, col: 40, terrain: TerrainType.Water },
        { row: 33, col: 41, terrain: TerrainType.Water },
        { row: 33, col: 42, terrain: TerrainType.Water },
        { row: 34, col: 29, terrain: TerrainType.Water },
        { row: 34, col: 36, terrain: TerrainType.Water },
        { row: 34, col: 37, terrain: TerrainType.Water },
        { row: 34, col: 38, terrain: TerrainType.Water },
        { row: 34, col: 39, terrain: TerrainType.Water },
        { row: 34, col: 40, terrain: TerrainType.Water },
        { row: 34, col: 41, terrain: TerrainType.Water },
        { row: 34, col: 42, terrain: TerrainType.Water },
        { row: 35, col: 36, terrain: TerrainType.Water },
        { row: 35, col: 37, terrain: TerrainType.Water },
        { row: 35, col: 38, terrain: TerrainType.Water },
        { row: 35, col: 39, terrain: TerrainType.Water },
        { row: 35, col: 40, terrain: TerrainType.Water },
        { row: 35, col: 41, terrain: TerrainType.Water },
        { row: 36, col: 39, terrain: TerrainType.Water }
    ]
}; 