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

export enum LLMProvider {
    Anthropic = 'anthropic',
    Google = 'google',
}

/** Default model per provider and skill level */
export const LLM_DEFAULT_MODELS: Record<LLMProvider, Record<BotSkillLevel, string>> = {
    [LLMProvider.Anthropic]: {
        [BotSkillLevel.Easy]: 'claude-haiku-4-5-20251001',
        [BotSkillLevel.Medium]: 'claude-sonnet-4-6',
        [BotSkillLevel.Hard]: 'claude-opus-4-6',
    },
    [LLMProvider.Google]: {
        [BotSkillLevel.Easy]: 'gemini-3-flash-preview',
        [BotSkillLevel.Medium]: 'gemini-3-pro-preview',
        [BotSkillLevel.Hard]: 'gemini-3.1-pro-preview',
    },
};

export interface BotConfig {
    skillLevel: BotSkillLevel;
    name?: string;
    /** LLM provider. Defaults to Anthropic if omitted. */
    provider?: LLMProvider;
    /** Model override. If omitted, uses the default for provider + skillLevel. */
    model?: string;
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
    estimatedBuildCost?: number;
    targetTrainType?: TrainType;
    upgradeKind?: 'upgrade' | 'crossgrade';
    /** If set, this move requires crossing a ferry first (teleport to otherSide, half speed). */
    ferryCrossing?: { otherSide: { row: number; col: number }; ferryName: string };
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
            name?: string;
            provider?: string;
            model?: string;
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
    /** Opponent player data for LLM serialization (populated for Medium/Hard skill) */
    opponents?: OpponentSnapshot[];
    /** Full hex grid point data for pathfinding and context building (v6.3) */
    hexGrid?: GridPoint[];
    /** Major city geometry (center + outpost coordinates) for pathfinding (v6.3) */
    majorCityGroups?: Array<{
        cityName: string;
        center: { row: number; col: number };
        outposts: Array<{ row: number; col: number }>;
    }>;
    /** Ferry edge connections for route planning (v6.3) */
    ferryEdges?: Array<{
        name: string;
        pointA: { row: number; col: number };
        pointB: { row: number; col: number };
        cost: number;
    }>;
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

/** Delivery plan representing a committed pickup→delivery chain */
export interface DeliveryPlan {
  demandCardId: number;       // Which demand card we're fulfilling
  loadType: string;           // e.g., "Steel"
  pickupCity: string;         // e.g., "Ruhr"
  deliveryCity: string;       // e.g., "Bruxelles"
  payment: number;            // ECU payoff
  phase: 'build_to_pickup' | 'travel_to_pickup' | 'pickup' | 'build_to_delivery' | 'travel_to_delivery' | 'deliver';
  createdAtTurn: number;
  reasoning: string;          // LLM's reasoning for choosing this chain
}

// ─── Plan-then-Execute Architecture Types ───────────────────────────────────

/** A single stop in a multi-stop delivery route */
export interface RouteStop {
  action: 'pickup' | 'deliver';
  loadType: string;
  city: string;
  demandCardId?: number;   // for delivers — which demand card this fulfills
  payment?: number;         // for delivers — ECU payout
}

/** Multi-stop strategic route planned by LLM, auto-executed over multiple turns */
export interface StrategicRoute {
  stops: RouteStop[];           // ordered goal sequence
  currentStopIndex: number;     // which stop we're working toward
  phase: 'build' | 'travel' | 'act';  // within current stop: build track → travel → pickup/deliver
  startingCity?: string;        // for initial build: where to start building from
  createdAtTurn: number;
  reasoning: string;            // LLM's reasoning for choosing this route
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
    /** Consecutive DiscardHand actions — used to prevent discard death spirals */
    consecutiveDiscards: number;
    /** Total deliveries completed this game */
    deliveryCount: number;
    /** Total money earned from deliveries */
    totalEarnings: number;
    /** Last turn number processed */
    turnNumber: number;
    /** Active strategic route the bot is auto-executing (plan-then-execute architecture) */
    activeRoute: StrategicRoute | null;
    /** How many turns the bot has been on the current route */
    turnsOnRoute: number;
    /** History of completed/abandoned routes */
    routeHistory: Array<{ route: StrategicRoute; outcome: 'completed' | 'abandoned'; turns: number }>;
    /** Key of the most recently abandoned route — prevents re-selecting same route */
    lastAbandonedRouteKey?: string | null;
    /** Previous turn's LLM reasoning — fed into next turn's prompt for continuity */
    lastReasoning?: string | null;
    /** Previous turn's plan horizon — fed into next turn's prompt for continuity */
    lastPlanHorizon?: string | null;
    /** Remaining stops from a partially completed route — passed to LLM for context (BE-010) */
    previousRouteStops?: RouteStop[] | null;
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
    /** LLM model identifier used for this phase (e.g. "claude-sonnet-4-20250514") */
    llmModel?: string;
    /** LLM API call latency in milliseconds */
    llmLatencyMs?: number;
    /** LLM token usage for this phase */
    llmTokenUsage?: { input: number; output: number };
    /** LLM reasoning text explaining the decision */
    llmReasoning?: string;
    /** LLM multi-turn plan horizon description */
    llmPlanHorizon?: string;
    /** Whether a guardrail rule overrode the LLM selection */
    wasGuardrailOverride?: boolean;
    /** Reason for the guardrail override */
    guardrailReason?: string;
    /** Whether this phase fell back to heuristic scoring */
    wasFallback?: boolean;
    /** Reason for the heuristic fallback */
    fallbackReason?: string;
}

/** Complete decision log for one bot turn */
export interface TurnDecisionLog {
    gameId: string;
    playerId: string;
    turn: number;
    phases: PhaseDecisionLog[];
}

/** A single LLM API call attempt — used for debug overlay logging */
export interface LlmAttempt {
    attemptNumber: number;
    status: 'success' | 'parse_error' | 'validation_error' | 'api_error';
    responseText: string;
    error?: string;
    latencyMs: number;
}

// ─── LLM Strategy Brain Types ───────────────────────────────────────────────

/** Configuration for constructing an LLMStrategyBrain instance */
export interface LLMStrategyConfig {
    skillLevel: BotSkillLevel;
    provider: LLMProvider;
    /** If omitted, uses LLM_DEFAULT_MODELS[provider][skillLevel] */
    model?: string;
    apiKey: string;
    /** Timeout in ms for LLM API calls. 10000 for Easy, 15000 for Medium/Hard. */
    timeoutMs: number;
    /** Number of retries with minimal prompt before heuristic fallback. Default 1. */
    maxRetries: number;
}

/** Result from LLMStrategyBrain.selectOptions() — includes both chosen indices and metadata */
export interface LLMSelectionResult {
    moveOptionIndex: number;    // -1 = skip movement
    buildOptionIndex: number;
    reasoning: string;
    planHorizon: string;
    model: string;
    latencyMs: number;
    tokenUsage: { input: number; output: number };
    wasGuardrailOverride: boolean;
    guardrailReason?: string;
}

/** Result from ResponseParser.parse() — extracted indices and text from LLM response */
export interface ParsedSelection {
    moveOptionIndex: number;
    buildOptionIndex: number;
    reasoning: string;
    planHorizon: string;
}

/** Result from GuardrailEnforcer.check() — indicates whether hard rules overrode the LLM choice */
export interface GuardrailResult {
    moveOverridden: boolean;
    buildOverridden: boolean;
    correctedMoveIndex?: number;
    correctedBuildIndex?: number;
    reason?: string;
}

/** Result from GuardrailEnforcer.checkPlan() — v6.3 intent-based guardrail */
export interface GuardrailPlanResult {
    plan: TurnPlan;
    overridden: boolean;
    reason?: string;
}

/** Normalized response from any LLM provider adapter */
export interface ProviderResponse {
    text: string;
    usage: { input: number; output: number };
}

/** Opponent player data included in WorldSnapshot for Medium/Hard skill serialization */
export interface OpponentSnapshot {
    playerId: string;
    money: number;
    position: { row: number; col: number } | null;
    trainType: string;
    loads: string[];
    trackSummary?: string;
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

// ─── AI v6.3 Pipeline Types ─────────────────────────────────────────────────

/** Pre-computed reachability and cost metadata for a single demand card */
export interface DemandContext {
    cardIndex: number;
    loadType: string;
    supplyCity: string;
    deliveryCity: string;
    payout: number;
    isSupplyReachable: boolean;
    isDeliveryReachable: boolean;
    isSupplyOnNetwork: boolean;
    isDeliveryOnNetwork: boolean;
    estimatedTrackCostToSupply: number;
    estimatedTrackCostToDelivery: number;
    isLoadAvailable: boolean;
    isLoadOnTrain: boolean;
    ferryRequired: boolean;
    /** Total copies of this load type in the game (3 or 4) */
    loadChipTotal: number;
    /** Number of copies currently carried by any player */
    loadChipCarried: number;
    /** Estimated total turns to complete this demand (build + travel + deliver) */
    estimatedTurns: number;
    /** Computed demand score: (immediateROI / estimatedTurns) + networkValueBonus + victoryBonus */
    demandScore: number;
    /** Efficiency: ROI per estimated turn (M/turn) */
    efficiencyPerTurn: number;
    /** Count of cities near the proposed track corridor (network value) */
    networkCitiesUnlocked: number;
    /** Count of unconnected major cities reachable via the track corridor */
    victoryMajorCitiesEnRoute: number;
    /** Whether the bot can afford to build track for this demand (cash + projected delivery income >= cost) */
    isAffordable: boolean;
    /** Bot's projected funds after delivering all currently carried loads (cash + carried load payouts) */
    projectedFundsAfterDelivery: number;
}

/** An immediately completable delivery at the bot's current position */
export interface DeliveryOpportunity {
    loadType: string;
    deliveryCity: string;
    payout: number;
    cardIndex: number;
}

/** A load that can be picked up at the bot's current position matching a demand card */
export interface PickupOpportunity {
    loadType: string;
    supplyCity: string;
    /** Highest-payout demand card this load could fulfill */
    bestPayout: number;
    bestDeliveryCity: string;
}

/** Filtered opponent info included in LLM context (skill-level dependent) */
export interface OpponentContext {
    name: string;
    money: number;
    trainType: string;
    position: string;
    loads: string[];
    trackCoverage: string;
    recentBuildDirection?: string;
}

/** Structured game state produced by ContextBuilder for LLM prompt serialization */
export interface GameContext {
    position: { city?: string; row: number; col: number } | null;
    money: number;
    trainType: string;
    speed: number;
    capacity: number;
    loads: string[];
    connectedMajorCities: string[];
    /** Unconnected major cities with estimated track cost from current network */
    unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>;
    totalMajorCities: number;
    trackSummary: string;
    turnBuildCost: number;
    demands: DemandContext[];
    canDeliver: DeliveryOpportunity[];
    canPickup: PickupOpportunity[];
    reachableCities: string[];
    citiesOnNetwork: string[];
    canUpgrade: boolean;
    canBuild: boolean;
    isInitialBuild: boolean;
    opponents: OpponentContext[];
    phase: string;
    turnNumber: number;
    /** Summary of previous turn's action/reasoning for LLM context continuity */
    previousTurnSummary?: string;
    /** Dynamic upgrade advice based on current train, cash, and game state */
    upgradeAdvice?: string;
}

/** A single action within an LLM multi-action response */
export interface LLMAction {
    action: string;
    details: Record<string, string>;
}

/** Parsed LLM response expressing strategic intent (single or multi-action) */
export interface LLMActionIntent {
    action?: string;
    actions?: LLMAction[];
    details?: Record<string, string>;
    reasoning: string;
    planHorizon: string;
}

/**
 * Discriminated union of executable action plans.
 *
 * FerryCrossing is intentionally excluded:
 * - FerryCrossing: transparent in pathfinding; ferry traversal is encoded in MoveTrain.path.
 */
export type TurnPlan =
    | TurnPlanBuildTrack
    | TurnPlanMoveTrain
    | TurnPlanDeliverLoad
    | TurnPlanPickupLoad
    | TurnPlanDropLoad
    | TurnPlanUpgradeTrain
    | TurnPlanDiscardHand
    | TurnPlanPassTurn
    | TurnPlanMultiAction;

export interface TurnPlanBuildTrack {
    type: AIActionType.BuildTrack;
    segments: TrackSegment[];
    targetCity?: string;
}

export interface TurnPlanMoveTrain {
    type: AIActionType.MoveTrain;
    path: { row: number; col: number }[];
    fees: Set<string>;
    totalFee: number;
}

export interface TurnPlanDeliverLoad {
    type: AIActionType.DeliverLoad;
    load: string;
    city: string;
    cardId: number;
    payout: number;
}

export interface TurnPlanPickupLoad {
    type: AIActionType.PickupLoad;
    load: string;
    city: string;
}

export interface TurnPlanDropLoad {
    type: AIActionType.DropLoad;
    load: string;
    city: string;
}

export interface TurnPlanUpgradeTrain {
    type: AIActionType.UpgradeTrain;
    targetTrain: string;
    cost: number;
}

export interface TurnPlanDiscardHand {
    type: AIActionType.DiscardHand;
}

export interface TurnPlanPassTurn {
    type: AIActionType.PassTurn;
}

export interface TurnPlanMultiAction {
    type: 'MultiAction';
    steps: TurnPlan[];
}

/** ActionResolver output — success/failure wrapper with error message for LLM retry */
export interface ResolvedAction {
    success: boolean;
    plan?: TurnPlan;
    error?: string;
}

/** Result from LLMStrategyBrain.decideAction() — includes resolved plan and LLM metadata */
export interface LLMDecisionResult {
    plan: TurnPlan;
    reasoning: string;
    planHorizon: string;
    model: string;
    latencyMs: number;
    tokenUsage?: { input: number; output: number };
    retried: boolean;
    guardrailOverride?: boolean;
}