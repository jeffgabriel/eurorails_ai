import { TerrainType } from './GameTypes';

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

/**
 * Represents a player's track state, including both runtime and storage concerns
 */
export interface PlayerTrackState {
    playerId: string;
    gameId: string;
    segments: TrackSegment[];
    totalCost: number;
    turnBuildCost: number;  // Cost spent this turn
    lastBuildTimestamp: Date;
    
    // Network representation for pathfinding and validation
    networkState?: {
        nodes: string[];  // Array of milepost IDs
        edges: [string, string][]; // Array of [from, to] pairs
    };
}

// Track building validation results
export type TrackBuildResult = {
    isValid: boolean;
    error?: TrackBuildError;
    cost?: number;
};

export enum TrackBuildError {
    INVALID_TERRAIN = 'INVALID_TERRAIN',
    INVALID_CONNECTION = 'INVALID_CONNECTION',
    EXCEEDS_TURN_BUDGET = 'EXCEEDS_TURN_BUDGET',
    TRACK_EXISTS = 'TRACK_EXISTS',
    NOT_CONNECTED_TO_NETWORK = 'NOT_CONNECTED_TO_NETWORK',
    NOT_MAJOR_CITY = 'NOT_MAJOR_CITY',  // For first track placement
    NOT_ADJACENT = 'NOT_ADJACENT',  // Points must be adjacent to connect
    UNKNOWN_ERROR = 'UNKNOWN_ERROR'
} 