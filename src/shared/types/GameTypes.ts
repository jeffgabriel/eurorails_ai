import { DemandCard } from './DemandCard';
import { LoadType } from './LoadTypes';
export enum PlayerColor {
    YELLOW = '#FFD700',  // Using a golden yellow for better visibility
    RED = '#FF0000',
    BLUE = '#0000FF',
    BLACK = '#000000',
    GREEN = '#008000',  // Using a darker green for better visibility
    BROWN = '#8B4513'   // Using saddle brown for better visibility
}

export enum TrainType {
    Freight = 'freight',           // 2 loads, 9 mileposts
    FastFreight = 'fast_freight',  // 2 loads, 12 mileposts
    HeavyFreight = 'heavy_freight', // 3 loads, 9 mileposts
    Superfreight = 'superfreight'   // 3 loads, 12 mileposts
}

export interface TrainProperties {
    speed: number;
    capacity: number;
    spritePrefix: string;
}

export const TRAIN_PROPERTIES: Record<TrainType, TrainProperties> = {
    [TrainType.Freight]: { speed: 9, capacity: 2, spritePrefix: 'train' },
    [TrainType.FastFreight]: { speed: 12, capacity: 2, spritePrefix: 'train_12' },
    [TrainType.HeavyFreight]: { speed: 9, capacity: 3, spritePrefix: 'train' },
    [TrainType.Superfreight]: { speed: 12, capacity: 3, spritePrefix: 'train_12' }
};

export interface Player {
    id: string;  // Add unique identifier for database
    userId?: string;  // Optional user ID for authentication (matches players.user_id in database)
    name: string;
    color: string;  // Hex color code
    money: number;
    trainType: TrainType;
    turnNumber: number;
    trainState: TrainState;
    hand: DemandCard[];  // Array of demand cards in player's hand
    cameraState?: {  // Per-player camera state (zoom, pan position)
        zoom: number;
        scrollX: number;
        scrollY: number;
    };
}

export interface TrainState {
    position: Point | null;
    remainingMovement: number;
    movementHistory: TrackSegment[];
    loads: LoadType[];
    /**
     * Ferry state management:
     * - 'just_arrived': Just arrived at ferry this turn, no further movement allowed
     * - 'ready_to_cross': At ferry from last turn, ready to cross (with halved movement)
     * - undefined: Not at a ferry port
     */
    ferryState?: {
        status: 'just_arrived' | 'ready_to_cross';
        ferryConnection: FerryConnection;
        currentSide: FerryPoint;  // Which ferry port we're currently at
        otherSide: FerryPoint;    // Where we would go if we cross
    };
    /**
     * Set to true for the turn immediately after crossing a ferry, to halve movement.
     */
    justCrossedFerry?: boolean;
}

export type GameStatus = 'setup' | 'active' | 'completed' | 'abandoned';

export interface Game {
    id: string;
    status: GameStatus;
    maxPlayers: number;
    currentPlayerIndex: number;
    winnerId?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface GameState {
    id: string;  // Add unique identifier for the game
    players: Player[];
    currentPlayerIndex: number;
    status: GameStatus;
    maxPlayers: number;
    /** @deprecated Camera state is now stored per-player in Player.cameraState. This field is kept for backwards compatibility during migration. */
    cameraState?: {
        zoom: number;
        scrollX: number;
        scrollY: number;
    };
    trainSprites?: Map<string, any>; // Map of player ID to train sprite (client-side only)
}

export const INITIAL_PLAYER_MONEY = 50; // 50M ECU starting money

export interface Milepost {
    id: string;
    x: number;
    y: number;
    type: TerrainType;
}

export enum TerrainType {
    Clear = 1,
    Mountain = 2,
    Alpine = 3,
    SmallCity = 4,
    MediumCity = 5,
    MajorCity = 6,
    FerryPort = 7,
    Water = 8,
}

export enum WaterCrossingType {
    River = 2,
    Lake = 3,
    OceanInlet = 3
}

export interface TrackNetwork {
    nodes: Set<string>;  // Set of milepost IDs
    edges: Map<string, Set<string>>;  // Adjacency list
}

// Load types from configuration
export interface LoadCityConfig {
    [loadType: string]: string[];  // Maps load type to array of city names
}

// City data including available loads
export interface CityData {
    type: TerrainType;
    name: string;
    connectedPoints?: Array<{ row: number; col: number }>;
    availableLoads: string[];  // List of load types available at this city
}

// Base point interface
export interface Point {
    x: number;      // screen x
    y: number;      // screen y
    row: number;    // grid row
    col: number;    // grid column
}

// Unified GridPoint type
export interface GridPoint extends Point {
    id: string;
    terrain: TerrainType;
    ferryConnection?: FerryConnection;  // Updated to use full FerryConnection type
    city?: CityData;
    ocean?: string;
    // Runtime properties (client-side only)
    sprite?: any; // Phaser sprite object
    tracks?: Array<{ playerId: string }>;
}

export interface FerryPoint {
    row: number;
    col: number;
    x: number;
    y: number;
    id: string;
    terrain: TerrainType.FerryPort;
}

export interface FerryConnection {
    Name: string;
    connections: [FerryPoint, FerryPoint];
    cost: number;
}
// Updated MapConfig
export interface MapConfig {
    width: number;
    height: number;
    points: GridPoint[];
    ferryConnections?: FerryConnection[];  // Optional ferry connections
}

export interface TrackSegment {
    from: {
        x: number;
        y: number;
        row: number;
        col: number;
        terrain: TerrainType;
    };
    to: {
        x: number;
        y: number;
        row: number;
        col: number;
        terrain: TerrainType;
    };
    cost: number;
}

export interface PlayerTrackState {
    playerId: string;
    gameId: string;
    segments: TrackSegment[];
    totalCost: number;
    turnBuildCost: number;
    lastBuildTimestamp: Date;
}