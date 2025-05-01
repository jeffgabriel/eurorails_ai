import { MapConfig, TerrainType } from '../../shared/types/GameTypes';

export const mapConfig: MapConfig = {
    width: 70,
    height: 90,
    points: [
        // Example major city (Berlin) - center point
        {
            row: 20,
            col: 35,
            x: 20,
            y: 35,
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
                ],
                availableLoads: ['Beer', 'Cars']
            }
        },
        // Connected points for Berlin
        { row: 19, col: 34, terrain: TerrainType.Clear, x: 19, y: 34 },
        { row: 19, col: 35, terrain: TerrainType.Clear, x: 19, y: 35 },
        { row: 20, col: 34, terrain: TerrainType.Clear, x: 20, y: 34 },
        { row: 20, col: 36, terrain: TerrainType.Clear, x: 20, y: 36 },
        { row: 21, col: 34, terrain: TerrainType.Clear, x: 21, y: 34 },
        { row: 21, col: 35, terrain: TerrainType.Clear, x: 21, y: 35 },

        // Glasgow - Medium City
        {
            row: 20,
            col: 28,
            x: 20,
            y: 28,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MediumCity,
                name: 'Glasgow',
                availableLoads: ['Coal', 'Steel', 'Machinery', 'Textiles']
            }
        },

        // Paris - Major City
        {
            row: 40,
            col: 30,
            x: 40,
            y: 30,
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
                ],
                availableLoads: ['Beer', 'Cars', 'Coal', 'Iron', 'Steel', 'Sugar', 'Tin']
            }
        },
        // Connected points for Paris
        { row: 39, col: 29, terrain: TerrainType.Clear, x: 39, y: 29 },
        { row: 39, col: 30, terrain: TerrainType.Clear, x: 39, y: 30 },
        { row: 40, col: 29, terrain: TerrainType.Clear, x: 40, y: 29 },
        { row: 40, col: 31, terrain: TerrainType.Clear, x: 40, y: 31 },
        { row: 41, col: 29, terrain: TerrainType.Clear, x: 41, y: 29 },
        { row: 41, col: 30, terrain: TerrainType.Clear, x: 41, y: 30 },

        // Example regular city (Frankfurt)
        {
            row: 25,
            col: 30,
            x: 25,
            y: 30,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MediumCity,
                name: 'Frankfurt',
                availableLoads: ['Beer', 'Cars', 'Coal', 'Iron', 'Steel', 'Sugar', 'Tin']
            }
        },

        // Example small city (Heidelberg)
        {
            row: 25,
            col: 35,
            x: 25,
            y: 35,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.SmallCity,
                name: 'Heidelberg',
                availableLoads: ['Beer', 'Cars', 'Coal', 'Iron', 'Steel', 'Sugar', 'Tin']
            }
        },
        
        // Example mountain range
        { row: 45, col: 30, terrain: TerrainType.Mountain, x: 45, y: 30 },
        { row: 45, col: 31, terrain: TerrainType.Mountain, x: 45, y: 31 },
        { row: 46, col: 30, terrain: TerrainType.Mountain, x: 46, y: 30 },
        { row: 46, col: 31, terrain: TerrainType.Alpine, x: 46, y: 31 },
        
        // Small city (Saarbrücken) with surrounding clear terrain
        {
            row: 32,
            col: 32,
            x: 32,
            y: 32,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.SmallCity,
                name: 'Saarbrücken',
                availableLoads: ['Beer', 'Cars', 'Coal', 'Iron', 'Steel', 'Sugar', 'Tin']
            }
        },
        
        // Mountain range in central region
        { row: 30, col: 33, terrain: TerrainType.Mountain, x: 30, y: 33 },
        { row: 29, col: 33, terrain: TerrainType.Mountain, x: 29, y: 33 },
        { row: 28, col: 33, terrain: TerrainType.Alpine, x: 28, y: 33 },
        { row: 28, col: 34, terrain: TerrainType.Mountain, x: 28, y: 34 },

        // Ferry ports across the lake
        { 
            row: 28, 
            col: 39, 
            x: 28,
            y: 39,
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 36, col: 38 }
        },
        { 
            row: 36, 
            col: 38, 
            x: 36,
            y: 38,
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 28, col: 39 }
        },

        // Lake points (from coordinate list)
        { row: 29, col: 30, terrain: TerrainType.Water, x: 29, y: 30 },
        { row: 29, col: 37, terrain: TerrainType.Water, x: 29, y: 37 },
        { row: 29, col: 38, terrain: TerrainType.Water, x: 29, y: 38 },
        { row: 29, col: 39, terrain: TerrainType.Water, x: 29, y: 39 },
        { row: 29, col: 40, terrain: TerrainType.Water, x: 29, y: 40 },
        { row: 30, col: 37, terrain: TerrainType.Water, x: 30, y: 37 },
        { row: 30, col: 38, terrain: TerrainType.Water, x: 30, y: 38 },
        { row: 30, col: 39, terrain: TerrainType.Water, x: 30, y: 39 },
        { row: 30, col: 40, terrain: TerrainType.Water, x: 30, y: 40 },
        { row: 30, col: 41, terrain: TerrainType.Water, x: 30, y: 41 },
        { row: 31, col: 35, terrain: TerrainType.Water, x: 31, y: 35 },
        { row: 31, col: 36, terrain: TerrainType.Water, x: 31, y: 36 },
        { row: 31, col: 37, terrain: TerrainType.Water, x: 31, y: 37 },
        { row: 31, col: 38, terrain: TerrainType.Water, x: 31, y: 38 },
        { row: 31, col: 39, terrain: TerrainType.Water, x: 31, y: 39 },
        { row: 31, col: 40, terrain: TerrainType.Water, x: 31, y: 40 },
        { row: 31, col: 41, terrain: TerrainType.Water, x: 31, y: 41 },
        { row: 32, col: 35, terrain: TerrainType.Water, x: 32, y: 35 },
        { row: 32, col: 36, terrain: TerrainType.Water, x: 32, y: 36 },
        { row: 32, col: 37, terrain: TerrainType.Water, x: 32, y: 37 },
        { row: 32, col: 38, terrain: TerrainType.Water, x: 32, y: 38 },
        { row: 32, col: 39, terrain: TerrainType.Water, x: 32, y: 39 },
        { row: 32, col: 40, terrain: TerrainType.Water, x: 32, y: 40 },
        { row: 32, col: 41, terrain: TerrainType.Water, x: 32, y: 41 },
        { row: 32, col: 42, terrain: TerrainType.Water, x: 32, y: 42 },
        { row: 32, col: 43, terrain: TerrainType.Water, x: 32, y: 43 },
        { row: 33, col: 35, terrain: TerrainType.Water, x: 33, y: 35 },
        { row: 33, col: 36, terrain: TerrainType.Water, x: 33, y: 36 },
        { row: 33, col: 37, terrain: TerrainType.Water, x: 33, y: 37 },
        { row: 33, col: 38, terrain: TerrainType.Water, x: 33, y: 38 },
        { row: 33, col: 39, terrain: TerrainType.Water, x: 33, y: 39 },
        { row: 33, col: 40, terrain: TerrainType.Water, x: 33, y: 40 },
        { row: 33, col: 41, terrain: TerrainType.Water, x: 33, y: 41 },
        { row: 33, col: 42, terrain: TerrainType.Water, x: 33, y: 42 },
        { row: 34, col: 29, terrain: TerrainType.Water, x: 34, y: 29 },
        { row: 34, col: 36, terrain: TerrainType.Water, x: 34, y: 36 },
        { row: 34, col: 37, terrain: TerrainType.Water, x: 34, y: 37 },
        { row: 34, col: 38, terrain: TerrainType.Water, x: 34, y: 38 },
        { row: 34, col: 39, terrain: TerrainType.Water, x: 34, y: 39 },
        { row: 34, col: 40, terrain: TerrainType.Water, x: 34, y: 40 },
        { row: 34, col: 41, terrain: TerrainType.Water, x: 34, y: 41 },
        { row: 34, col: 42, terrain: TerrainType.Water, x: 34, y: 42 },
        { row: 35, col: 36, terrain: TerrainType.Water, x: 35, y: 36 },
        { row: 35, col: 37, terrain: TerrainType.Water, x: 35, y: 37 },
        { row: 35, col: 38, terrain: TerrainType.Water, x: 35, y: 38 },
        { row: 35, col: 39, terrain: TerrainType.Water, x: 35, y: 39 },
        { row: 35, col: 40, terrain: TerrainType.Water, x: 35, y: 40 },
        { row: 35, col: 41, terrain: TerrainType.Water, x: 35, y: 41 },
        { row: 36, col: 39, terrain: TerrainType.Water, x: 36, y: 39 },

        // Hamburg - Major City (regular hexagon like Berlin)
        {
            row: 15,
            col: 32,
            x: 15,
            y: 32,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MajorCity,
                name: 'Hamburg',
                connectedPoints: [
                    // Center point
                    { row: 15, col: 32 },
                    // Top points
                    { row: 14, col: 32 },
                    { row: 14, col: 33 },
                    // Middle points
                    { row: 15, col: 31 },
                    { row: 15, col: 33 },
                    // Bottom points
                    { row: 16, col: 32 },
                    { row: 16, col: 33 }
                ],
                availableLoads: ['Fish', 'Cars', 'Steel', 'Oil']
            }
        },
        // Connected points for Hamburg (regular hexagon)
        { row: 14, col: 32, terrain: TerrainType.Clear, x: 14, y: 32 },
        { row: 14, col: 33, terrain: TerrainType.Clear, x: 14, y: 33 },
        { row: 15, col: 31, terrain: TerrainType.Clear, x: 15, y: 31 },
        { row: 15, col: 33, terrain: TerrainType.Clear, x: 15, y: 33 },
        { row: 16, col: 32, terrain: TerrainType.Clear, x: 16, y: 32 },
        { row: 16, col: 33, terrain: TerrainType.Clear, x: 16, y: 33 },

        // Munich (München) - Major City (moved away from lake, fixed hexagonal pattern)
        {
            row: 42,
            col: 40,
            x: 42,
            y: 40,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MajorCity,
                name: 'Munich',
                connectedPoints: [
                    // Center point
                    { row: 42, col: 40 },
                    // Top points (2)
                    { row: 41, col: 39 },
                    { row: 41, col: 40 },
                    // Middle points (2)
                    { row: 42, col: 39 },
                    { row: 42, col: 41 },
                    // Bottom points (2)
                    { row: 43, col: 39 },
                    { row: 43, col: 40 }
                ],
                availableLoads: ['Beer', 'Cars', 'Electronics', 'Steel']
            }
        },
        // Connected points for Munich (hexagonal)
        { row: 41, col: 39, terrain: TerrainType.Clear, x: 41, y: 39 },
        { row: 41, col: 40, terrain: TerrainType.Clear, x: 41, y: 40 },
        { row: 42, col: 39, terrain: TerrainType.Clear, x: 42, y: 39 },
        { row: 42, col: 41, terrain: TerrainType.Clear, x: 42, y: 41 },
        { row: 43, col: 39, terrain: TerrainType.Clear, x: 43, y: 39 },
        { row: 43, col: 40, terrain: TerrainType.Clear, x: 43, y: 40 },

        // Medium cities
        {
            row: 28,
            col: 45,
            x: 28,
            y: 45,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MediumCity,
                name: 'Dresden',
                availableLoads: ['Coal', 'Electronics', 'Textiles']
            }
        },
        {
            row: 45,
            col: 35,
            x: 45,
            y: 35,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.MediumCity,
                name: 'Stuttgart',
                availableLoads: ['Cars', 'Steel', 'Wine']
            }
        },

        // Small cities
        {
            row: 22,
            col: 38,
            x: 22,
            y: 38,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.SmallCity,
                name: 'Leipzig',
                availableLoads: ['Books', 'Coal']
            }
        },
        {
            row: 38,
            col: 42,
            x: 38,
            y: 42,
            terrain: TerrainType.Clear,
            city: {
                type: TerrainType.SmallCity,
                name: 'Nuremberg',
                availableLoads: ['Toys', 'Beer']
            }
        },

        // Mountain ranges
        // Alpine range near Munich
        { row: 44, col: 43, terrain: TerrainType.Mountain, x: 44, y: 43 },
        { row: 44, col: 44, terrain: TerrainType.Alpine, x: 44, y: 44 },
        { row: 45, col: 43, terrain: TerrainType.Alpine, x: 45, y: 43 },
        { row: 45, col: 44, terrain: TerrainType.Mountain, x: 45, y: 44 },
        { row: 46, col: 43, terrain: TerrainType.Mountain, x: 46, y: 43 },

        // Mountain range between Dresden and Berlin
        { row: 23, col: 40, terrain: TerrainType.Mountain, x: 23, y: 40 },
        { row: 24, col: 40, terrain: TerrainType.Mountain, x: 24, y: 40 },
        { row: 24, col: 41, terrain: TerrainType.Alpine, x: 24, y: 41 },
        { row: 25, col: 41, terrain: TerrainType.Mountain, x: 25, y: 41 },

        // Ferry connection across Baltic Sea
        { 
            row: 12, 
            col: 45, 
            x: 12,
            y: 45,
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 12, col: 55 }
        },
        { 
            row: 12, 
            col: 55, 
            x: 12,
            y: 55,
            terrain: TerrainType.FerryPort,
            ferryConnection: { row: 12, col: 45 }
        },

        // Baltic Sea water points
        { row: 12, col: 46, terrain: TerrainType.Water, x: 12, y: 46 },
        { row: 12, col: 47, terrain: TerrainType.Water, x: 12, y: 47 },
        { row: 12, col: 48, terrain: TerrainType.Water, x: 12, y: 48 },
        { row: 12, col: 49, terrain: TerrainType.Water, x: 12, y: 49 },
        { row: 12, col: 50, terrain: TerrainType.Water, x: 12, y: 50 },
        { row: 12, col: 51, terrain: TerrainType.Water, x: 12, y: 51 },
        { row: 12, col: 52, terrain: TerrainType.Water, x: 12, y: 52 },
        { row: 12, col: 53, terrain: TerrainType.Water, x: 12, y: 53 },
        { row: 12, col: 54, terrain: TerrainType.Water, x: 12, y: 54 },
    ]
}; 