import { DemandCard } from './DemandCard';
import { LoadType, LoadState } from './LoadTypes';
import { TrainType, GridPoint, Point } from './GameTypes';

// --- Core AI Configuration Types ---

export type AIDifficulty = 'easy' | 'medium' | 'hard';

export type AIArchetype =
  | 'backbone_builder'
  | 'freight_optimizer'
  | 'trunk_sprinter'
  | 'continental_connector'
  | 'opportunist';

export interface AIPlayerConfig {
  difficulty: AIDifficulty;
  archetype: AIArchetype;
  name?: string;
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

// --- World Snapshot (Immutable Game State for AI Planning) ---

export interface OtherPlayerSnapshot {
  readonly playerId: string;
  readonly position: Point | null;
  readonly carriedLoads: readonly LoadType[];
  readonly trainType: TrainType;
  readonly cash: number;
  readonly connectedMajorCities: number;
}

export interface WorldSnapshot {
  readonly botPlayerId: string;
  readonly botPosition: Point | null;
  readonly trackNetworkGraph: ReadonlyMap<string, ReadonlySet<string>>;
  readonly cash: number;
  readonly demandCards: readonly DemandCard[];
  readonly carriedLoads: readonly LoadType[];
  readonly trainType: TrainType;
  readonly otherPlayers: readonly OtherPlayerSnapshot[];
  readonly globalLoadAvailability: readonly LoadState[];
  readonly activeEvents: readonly string[];
  readonly mapTopology: readonly GridPoint[];
  readonly majorCityConnectionStatus: ReadonlyMap<string, boolean>;
  readonly turnNumber: number;
  readonly snapshotHash: string;
}

// --- Feasible Option (Candidate action evaluated for feasibility) ---

export interface FeasibleOption {
  readonly id: string;
  readonly type: AIActionType;
  readonly parameters: Record<string, unknown>;
  readonly score: number;
  readonly feasible: boolean;
  readonly rejectionReason: string | null;
}

// --- Turn Plan (Selected sequence of actions for execution) ---

export interface TurnPlanAction {
  readonly type: AIActionType;
  readonly parameters: Record<string, unknown>;
}

export interface TurnPlan {
  readonly actions: readonly TurnPlanAction[];
  readonly expectedOutcome: {
    readonly cashChange: number;
    readonly loadsDelivered: number;
    readonly trackSegmentsBuilt: number;
    readonly newMajorCitiesConnected: number;
  };
  readonly totalScore: number;
  readonly archetype: AIArchetype;
  readonly skillLevel: AIDifficulty;
}

// --- Strategy Audit (Full decision record for debugging/inspector) ---

export interface ExecutionResult {
  readonly actionType: AIActionType;
  readonly success: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

export interface StrategyAudit {
  readonly snapshotHash: string;
  readonly allOptions: readonly FeasibleOption[];
  readonly scores: readonly number[];
  readonly selectedPlan: TurnPlan;
  readonly executionResults: readonly ExecutionResult[];
  readonly timing: {
    readonly snapshotMs: number;
    readonly optionGenerationMs: number;
    readonly scoringMs: number;
    readonly executionMs: number;
    readonly totalMs: number;
  };
}
