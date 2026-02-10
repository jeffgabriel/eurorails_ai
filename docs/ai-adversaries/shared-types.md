# Shared AI Types Reference

Type definitions used across the AI bot pipeline. Server-side types are in `src/server/ai/types.ts`. Client-side display types are in `src/shared/types/GameTypes.ts`.

## BotConfig

Server-side configuration for a bot player.

```typescript
// src/server/ai/types.ts
interface BotConfig {
  skillLevel: SkillLevel;   // 'easy' | 'medium' | 'hard'
  archetype: ArchetypeId;   // e.g. 'backbone_builder'
  botId: string;            // Unique identifier
  botName: string;          // Display name
}
```

## BotDisplayConfig

Client-side display configuration attached to `Player` objects.

```typescript
// src/shared/types/GameTypes.ts
interface BotDisplayConfig {
  archetype: string;    // Archetype identifier
  skillLevel: string;   // Skill level string
}
```

The `Player` interface includes optional bot fields:
```typescript
interface Player {
  // ... standard fields ...
  isBot?: boolean;
  botConfig?: BotDisplayConfig;
}
```

## ArchetypeId

```typescript
type ArchetypeId =
  | 'backbone_builder'
  | 'freight_optimizer'
  | 'trunk_sprinter'
  | 'continental_connector'
  | 'opportunist';
```

## SkillLevel

```typescript
type SkillLevel = 'easy' | 'medium' | 'hard';
```

## AIActionType

```typescript
enum AIActionType {
  DeliverLoad = 'DeliverLoad',
  PickupAndDeliver = 'PickupAndDeliver',
  BuildTrack = 'BuildTrack',
  UpgradeTrain = 'UpgradeTrain',
  BuildTowardMajorCity = 'BuildTowardMajorCity',
  PassTurn = 'PassTurn',
}
```

## FeasibleOption

A bot action that passed feasibility checks.

```typescript
interface FeasibleOption {
  type: AIActionType;
  description: string;
  feasible: true;
  params: ActionParams;  // Discriminated union per action type
}
```

## InfeasibleOption

A bot action that was considered but rejected.

```typescript
interface InfeasibleOption {
  type: AIActionType;
  description: string;
  feasible: false;
  reason: string;
}
```

## ScoredOption

A feasible option after scoring.

```typescript
interface ScoredOption extends FeasibleOption {
  score: number;
  rationale: string;
}
```

## StrategyAudit

Captured after each bot turn for the Strategy Inspector UI.

```typescript
interface StrategyAudit {
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
```

## WorldSnapshot

Complete immutable game state for bot decision-making.

```typescript
interface WorldSnapshot {
  // Bot state
  botPlayerId: string;
  botPosition: Point | null;
  botMoney: number;
  botDebt: number;
  botTrainType: TrainType;
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
  loadAvailability: Map<string, string[]>;  // city -> available load types
  droppedLoads: Map<string, LoadType[]>;    // city -> dropped load types
  mapPoints: GridPoint[];

  // Events
  activeEvents: never[];  // placeholder for future event system
}
```

## Action Parameters

Each `AIActionType` has corresponding parameters:

```typescript
interface DeliverLoadParams {
  loadType: LoadType;
  targetCity: string;
  demandCardIndex: number;
  movementPath: Point[];
}

interface PickupAndDeliverParams {
  loadType: LoadType;
  pickupCity: string;
  targetCity: string;
  demandCardIndex: number;
  movementPath: Point[];
}

interface BuildTrackParams {
  segments: TrackSegment[];
  totalCost: number;
}

interface UpgradeTrainParams {
  targetTrainType: TrainType;
  cost: number;
}

interface BuildTowardMajorCityParams {
  targetCity: string;
  segments: TrackSegment[];
  totalCost: number;
}

interface PassTurnParams {}
```
