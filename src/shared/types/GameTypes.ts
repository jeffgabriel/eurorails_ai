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

export enum BotSkillLevel {
    Easy = 'easy',
    Medium = 'medium',
    Hard = 'hard'
}

export enum BotArchetype {
    Aggressive = 'aggressive',
    Defensive = 'defensive',
    Balanced = 'balanced',
    Opportunistic = 'opportunistic',
    BuilderFirst = 'builder_first'
}

export interface BotConfig {
    skillLevel: BotSkillLevel;
    archetype: BotArchetype;
    name?: string;
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

/**
 * Camera state interface for player viewport settings
 * Stores zoom level and scroll position for independent per-player camera control
 */
export interface CameraState {
    zoom: number;
    scrollX: number;
    scrollY: number;
}

export interface Player {
    id: string;  // Add unique identifier for database
    userId?: string;  // Optional user ID for authentication (matches players.user_id in database)
    name: string;
    color: string;  // Hex color code
    money: number;
    debtOwed?: number;  // Amount remaining to repay (already doubled from borrowed amount)
    trainType: TrainType;
    turnNumber: number;
    trainState: TrainState;
    hand: DemandCard[];  // Array of demand cards in player's hand
    cameraState?: CameraState;  // Per-player camera state (zoom, pan position)
    isBot?: boolean;
    botConfig?: BotConfig;
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
    /**
     * Track which opponents have been paid for track usage this turn.
     * Loaded from server on page refresh to ensure "once per turn" fee tracking persists.
     */
    paidOpponentIds?: string[];
    /**
     * Preserves the last traversed edge for reversal detection even when movementHistory is empty.
     * Used after undo operations to maintain directional context.
     */
    lastTraversedEdge?: TrackSegment;
}

export type GameStatus = 'setup' | 'initialBuild' | 'active' | 'completed' | 'abandoned';

export const VICTORY_INITIAL_THRESHOLD = 250; // 250M ECU to win
export const VICTORY_TIE_THRESHOLD = 300; // 300M ECU after a tie
export const TRACK_USAGE_FEE = 4; // 4M ECU per opponent's track used per turn

export interface VictoryState {
    triggered: boolean;              // Has someone declared victory?
    triggerPlayerIndex: number;      // Who triggered it? (-1 if not triggered)
    victoryThreshold: number;        // 250M initially, 300M after tie
    finalTurnPlayerIndex: number;    // Last player who gets a turn (-1 if not triggered)
}

export interface Game {
    id: string;
    status: GameStatus;
    maxPlayers: number;
    currentPlayerIndex: number;
    winnerId?: string;
    createdAt: Date;
    updatedAt: Date;
    victoryState?: VictoryState;
}

export interface GameState {
    id: string;  // Add unique identifier for the game
    players: Player[];
    currentPlayerIndex: number;
    status: GameStatus;
    maxPlayers: number;
    /** @deprecated Camera state is now stored per-player in Player.cameraState. This field is kept for backwards compatibility during migration. */
    cameraState?: CameraState;
    trainSprites?: Map<string, any>; // Map of player ID to train sprite (client-side only)
    victoryState?: VictoryState;
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
    /** Display name for the point (ferry ports, etc.) - separate from city data */
    name?: string;
    /**
     * Flag for locations that are both ferry ports AND cities (Dublin, Belfast).
     * These hybrid locations allow trains to both use ferry connections AND
     * load/unload goods like a regular city.
     */
    isFerryCity?: boolean;
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

/**
 * Result of borrowing money from the bank (Mercy Rule)
 */
export interface BorrowResult {
    borrowedAmount: number;      // Amount borrowed (same as request)
    debtIncurred: number;        // Amount added to debt (2x borrowed)
    updatedMoney: number;        // New player money balance
    updatedDebtOwed: number;     // New total debt owed
}

/** A feasible option the AI bot can take during its turn */
export interface FeasibleOption {
    action: AIActionType;
    feasible: boolean;
    reason: string;
    segments?: TrackSegment[];
    estimatedCost?: number;
    targetCity?: string;
    score?: number;
    movementPath?: { row: number; col: number }[];
    targetPosition?: { row: number; col: number };
    mileposts?: number;
    loadType?: LoadType;
    cardId?: number;
    payment?: number;
    chainScore?: number;
    targetTrainType?: TrainType;
    upgradeKind?: 'upgrade' | 'crossgrade';
}

/** Resolved demand card data for AI decision-making */
export interface ResolvedDemand {
    cardId: number;
    demands: Array<{ city: string; loadType: string; payment: number }>;
}

/** Frozen game state snapshot for AI bot evaluation */
export interface WorldSnapshot {
    gameId: string;
    gameStatus: GameStatus;
    turnNumber: number;
    bot: {
        playerId: string;
        userId: string;
        money: number;
        position: { row: number; col: number } | null;
        existingSegments: TrackSegment[];
        demandCards: number[];  // card IDs from player.hand
        resolvedDemands: ResolvedDemand[];  // fully resolved demand card data
        trainType: string;
        loads: string[];
        botConfig: {
            skillLevel: string;
            archetype: string;
            name?: string;
        } | null;
        /** Set by AIStrategyEngine when bot crosses a ferry — halves movement speed for this turn */
        ferryHalfSpeed?: boolean;
        /** Number of major cities connected by the bot's continuous track network */
        connectedMajorCityCount: number;
    };
    allPlayerTracks: Array<{
        playerId: string;
        segments: TrackSegment[];
    }>;
    loadAvailability: Record<string, string[]>;  // city name → available load types
}

/** Actions a bot can take during its turn */
export enum AIActionType {
    PassTurn = 'PassTurn',
    BuildTrack = 'BuildTrack',
    MoveTrain = 'MoveTrain',
    PickupLoad = 'PickupLoad',
    DeliverLoad = 'DeliverLoad',
    DropLoad = 'DropLoad',
    UpgradeTrain = 'UpgradeTrain',
    DiscardHand = 'DiscardHand',
}

/** Persistent bot state that spans across turns within a game */
export interface BotMemoryState {
    /** City name the bot is building toward */
    currentBuildTarget: string | null;
    /** How many turns the bot has been building toward this target */
    turnsOnTarget: number;
    /** What the bot did last turn (Phase 2 action) */
    lastAction: AIActionType | null;
    /** Consecutive PassTurn actions — used to detect stuck loops */
    consecutivePassTurns: number;
    /** Total deliveries completed this game */
    deliveryCount: number;
    /** Total money earned from deliveries */
    totalEarnings: number;
    /** Last turn number processed */
    turnNumber: number;
}

/** Simplified option summary for decision logging */
export interface LoggedOption {
    action: AIActionType;
    score?: number;
    feasible: boolean;
    reason?: string;
    targetCity?: string;
    loadType?: string;
    payment?: number;
}

/** A single phase's decision data within a turn */
export interface PhaseDecisionLog {
    phase: string;
    options: LoggedOption[];
    chosen: LoggedOption | null;
    result: {
        success: boolean;
        action: AIActionType;
        cost: number;
        remainingMoney: number;
    } | null;
}

/** Complete decision log for one bot turn */
export interface TurnDecisionLog {
    gameId: string;
    playerId: string;
    turn: number;
    phases: PhaseDecisionLog[];
}

/** Human-readable labels for each AIActionType, used by UI components */
export const AI_ACTION_LABELS: Record<AIActionType, string> = {
    [AIActionType.PassTurn]: 'Pass Turn',
    [AIActionType.BuildTrack]: 'Build Track',
    [AIActionType.MoveTrain]: 'Move Train',
    [AIActionType.PickupLoad]: 'Pick Up Load',
    [AIActionType.DeliverLoad]: 'Deliver Load',
    [AIActionType.DropLoad]: 'Drop Load',
    [AIActionType.UpgradeTrain]: 'Upgrade Train',
    [AIActionType.DiscardHand]: 'Discard Hand',
};