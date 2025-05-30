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

export interface Player {
    id: string;  // Add unique identifier for database
    name: string;
    color: string;  // Hex color code
    money: number;
    trainType: string;  // We'll expand this later with proper train types
    turnNumber: number;
    trainState: TrainState;
    hand: DemandCard[];  // Array of demand cards in player's hand
}

export interface TrainState {
    position: Point | null;
    remainingMovement: number;
    movementHistory: TrackSegment[];
    loads: LoadType[];
    /**
     * If set, the train is at a ferry port and eligible to cross or reverse.
     * - from: the current ferry port GridPoint
     * - to: the other end of the ferry
     * - status: 'pending' (awaiting player choice) or 'reversed' (player chose to reverse)
     */
    atFerryPort?: {
        from: GridPoint;
        to: GridPoint;
        status: 'pending' | 'reversed';
    };
}

export type GameStatus = 'setup' | 'active' | 'completed';

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
    cameraState?: {
        zoom: number;
        scrollX: number;
        scrollY: number;
    };
    trainSprites?: Map<string, Phaser.GameObjects.Image>; // Map of player ID to train sprite}
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
    // Runtime properties
    sprite?: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image;
    tracks?: Array<{ playerId: string }>;
}

export interface FerryConnection {
    Name: string;
    connections: [GridPoint, GridPoint];
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