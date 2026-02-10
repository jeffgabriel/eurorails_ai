import { TrainType, TrackSegment, GridPoint, Point, TerrainType, PlayerTrackState } from '../../shared/types/GameTypes';
import { DemandCard } from '../../shared/types/DemandCard';
import { LoadType } from '../../shared/types/LoadTypes';

// --- Archetype & Skill Configuration ---

export type ArchetypeId =
  | 'backbone_builder'
  | 'freight_optimizer'
  | 'trunk_sprinter'
  | 'continental_connector'
  | 'opportunist';

export type SkillLevel = 'easy' | 'medium' | 'hard';

export interface BotConfig {
  skillLevel: SkillLevel;
  archetype: ArchetypeId;
  botId: string;
  botName: string;
}

// --- AI Action Types ---

export enum AIActionType {
  DeliverLoad = 'DeliverLoad',
  PickupAndDeliver = 'PickupAndDeliver',
  BuildTrack = 'BuildTrack',
  UpgradeTrain = 'UpgradeTrain',
  BuildTowardMajorCity = 'BuildTowardMajorCity',
  PassTurn = 'PassTurn',
}

// --- Option Types ---

export interface FeasibilityResult {
  feasible: boolean;
  reason?: string;
}

export interface FeasibleOption {
  type: AIActionType;
  description: string;
  feasible: true;
  /** Action-specific data needed by TurnExecutor */
  params: ActionParams;
}

export interface InfeasibleOption {
  type: AIActionType;
  description: string;
  feasible: false;
  reason: string;
}

export interface ScoredOption extends FeasibleOption {
  score: number;
  rationale: string;
}

// --- Action Parameters ---

export interface DeliverLoadParams {
  type: AIActionType.DeliverLoad;
  movePath: Point[];
  demandCardId: number;
  demandIndex: number;
  loadType: LoadType;
  city: string;
}

export interface PickupAndDeliverParams {
  type: AIActionType.PickupAndDeliver;
  pickupPath: Point[];
  pickupCity: string;
  pickupLoadType: LoadType;
  deliverPath: Point[];
  deliverCity: string;
  demandCardId: number;
  demandIndex: number;
}

export interface BuildTrackParams {
  type: AIActionType.BuildTrack;
  segments: TrackSegment[];
  totalCost: number;
}

export interface UpgradeTrainParams {
  type: AIActionType.UpgradeTrain;
  targetTrainType: TrainType;
  kind: 'upgrade' | 'crossgrade';
  cost: number;
}

export interface BuildTowardMajorCityParams {
  type: AIActionType.BuildTowardMajorCity;
  targetCity: string;
  segments: TrackSegment[];
  totalCost: number;
}

export interface PassTurnParams {
  type: AIActionType.PassTurn;
}

export type ActionParams =
  | DeliverLoadParams
  | PickupAndDeliverParams
  | BuildTrackParams
  | UpgradeTrainParams
  | BuildTowardMajorCityParams
  | PassTurnParams;

// --- Turn Plan ---

export interface TurnPlan {
  actions: FeasibleOption[];
}

// --- Execution Result ---

export interface ExecutionResult {
  success: boolean;
  actionsExecuted: number;
  error?: string;
  /** Duration of execution in milliseconds */
  durationMs: number;
}

// --- World Snapshot ---

export interface OpponentData {
  playerId: string;
  name: string;
  money: number;
  trainType: TrainType;
  position: Point | null;
  loads: LoadType[];
  trackSegmentCount: number;
  majorCitiesConnected: number;
}

export interface WorldSnapshot {
  gameId: string;
  botPlayerId: string;
  botUserId: string;
  gamePhase: 'initialBuild' | 'active';
  turnBuildCostSoFar: number;

  // Bot state
  position: Point | null;
  money: number;
  debtOwed: number;
  trainType: TrainType;
  remainingMovement: number;
  carriedLoads: LoadType[];
  demandCards: DemandCard[];

  // Track network (bot's own)
  trackSegments: TrackSegment[];
  connectedMajorCities: number;

  // Opponent data
  opponents: OpponentData[];

  // All players' tracks (for movement on opponent track)
  allPlayerTracks: PlayerTrackState[];

  // Global state
  loadAvailability: Map<string, string[]>; // city -> available load types
  droppedLoads: Map<string, LoadType[]>;   // city -> dropped load types
  mapPoints: GridPoint[];

  // Events (placeholder for future event system)
  activeEvents: never[];
}

// --- Strategy Audit ---

export interface StrategyAudit {
  turnNumber: number;
  archetypeName: string;
  skillLevel: SkillLevel;
  currentPlan: string;
  archetypeRationale: string;
  feasibleOptions: ScoredOption[];
  rejectedOptions: InfeasibleOption[];
  botStatus: {
    cash: number;
    trainType: TrainType;
    loads: LoadType[];
    majorCitiesConnected: number;
  };
  durationMs: number;
}

// --- Validation Result ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
