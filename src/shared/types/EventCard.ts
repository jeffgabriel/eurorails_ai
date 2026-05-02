import { TerrainType } from './GameTypes';

/**
 * Enum representing the five event card types in Eurorails.
 * Uses string values to match the existing codebase enum style (e.g. TrainType, AIActionType).
 */
export enum EventCardType {
  Strike = 'Strike',
  Derailment = 'Derailment',
  Snow = 'Snow',
  Flood = 'Flood',
  ExcessProfitTax = 'ExcessProfitTax',
}

// ─── Per-type effect config interfaces ──────────────────────────────────────

/**
 * Strike event — two variants:
 * - 'coastal': no pickup/delivery within coastalRadius mileposts of any coast
 * - 'rail': the drawing player cannot move on their own track
 */
export interface StrikeEffect {
  readonly type: EventCardType.Strike;
  /** 'coastal' = near-coast restriction; 'rail' = drawing player's own rail */
  readonly variant: 'coastal' | 'rail';
  /** Radius in mileposts from any coast (coastal variant only) */
  readonly coastalRadius?: number;
  /** True if only the drawing player is affected (rail variant) */
  readonly affectsDrawingPlayerOnly?: boolean;
}

/**
 * Derailment event — all trains within `radius` mileposts of any listed city
 * lose 1 turn and 1 load.
 */
export interface DerailmentEffect {
  readonly type: EventCardType.Derailment;
  /** Cities that are the epicentre of the derailment */
  readonly cities: string[];
  /** Radius in mileposts around each city */
  readonly radius: number;
}

/**
 * Snow event — trains within `radius` mileposts of `centerCity` move at half
 * rate; no movement or rail-building allowed on `blockedTerrain` mileposts in
 * the affected area.
 */
export interface SnowEffect {
  readonly type: EventCardType.Snow;
  readonly centerCity: string;
  readonly radius: number;
  /** Terrain types that are blocked for movement and building in the area */
  readonly blockedTerrain: TerrainType[];
}

/**
 * Flood event — bridges crossing the named river are immediately erased.
 * The river name must match an entry in configuration/rivers.json.
 */
export interface FloodEffect {
  readonly type: EventCardType.Flood;
  readonly river: string;
}

/**
 * Tax bracket used by the ExcessProfitTax event.
 * Players with money >= `threshold` pay `tax` million ECU.
 */
export interface TaxBracket {
  readonly threshold: number;
  readonly tax: number;
}

/**
 * Excess Profit Tax event — all players pay a sliding-scale tax based on
 * their current cash holdings.
 */
export interface ExcessProfitTaxEffect {
  readonly type: EventCardType.ExcessProfitTax;
  /** Ordered tax brackets (highest threshold first) */
  readonly brackets: TaxBracket[];
}

/** Discriminated union of all event effect configurations */
export type EventEffectConfig =
  | StrikeEffect
  | DerailmentEffect
  | SnowEffect
  | FloodEffect
  | ExcessProfitTaxEffect;

// ─── EventCard interface ─────────────────────────────────────────────────────

/** An event card loaded from configuration/event_cards.json */
export interface EventCard {
  /** Unique card ID — rulebook IDs 121–140 */
  readonly id: number;
  readonly type: EventCardType;
  readonly title: string;
  readonly description: string;
  readonly effectConfig: EventEffectConfig;
}

/**
 * Raw JSON shape for an event card as stored in configuration/event_cards.json.
 * Mirrors EventCard but allows mutable fields for JSON.parse() results.
 */
export interface RawEventCard {
  id: number;
  type: EventCardType;
  title: string;
  description: string;
  effectConfig: EventEffectConfig;
}

// ─── Event processing result types ──────────────────────────────────────────

/**
 * Per-player effect descriptor. `effectType` is a closed union of literal
 * types to prevent stringly-typed bugs.
 */
export interface PerPlayerEffect {
  playerId: string;
  effectType:
    | 'load_lost'
    | 'turn_lost'
    | 'speed_halved'
    | 'no_pickup_delivery'
    | 'no_movement'
    | 'tax_paid'
    | 'track_erased';
  details: string;
  /** Numeric amount, e.g. tax deducted or loads lost count */
  amount?: number;
}

/**
 * Descriptor for an effect that persists across turns.
 * Returned by `EventCardService.processEventCard` so that Project 3 can
 * persist it to `games.active_event` — this project does NOT write to the DB
 * column itself.
 */
export interface ActiveEffectDescriptor {
  cardId: number;
  drawingPlayerId: string;
  drawingPlayerIndex: number;
  /** Turn number after which this effect expires (drawing player's turn + 1) */
  expiresAfterTurnNumber: number;
  /** Serialized milepost keys; rehydrated to Set<string> on read */
  affectedZone: string[];
}

// ─── ActiveEffectManager types (P3-SP1) ─────────────────────────────────────

/**
 * Restriction on train movement — half rate, blocked terrain, or player-rail movement ban.
 */
export interface MovementRestriction {
  type: 'half_rate' | 'blocked_terrain' | 'no_movement_on_player_rail';
  zone?: string[];
  blockedTerrain?: TerrainType[];
  targetPlayerId?: string;
}

/**
 * Restriction on track building — blocked terrain or build ban for a specific player.
 */
export interface BuildRestriction {
  type: 'blocked_terrain' | 'no_build_for_player';
  zone?: string[];
  blockedTerrain?: TerrainType[];
  targetPlayerId?: string;
}

/**
 * Restriction on pickup and delivery in a zone.
 */
export interface PickupDeliveryRestriction {
  type: 'no_pickup_delivery_in_zone';
  zone: string[];
}

/**
 * Persisted to games.active_event JSONB array.
 * games.active_event = ActiveEffectRecord[] (JSON array)
 */
export interface ActiveEffectRecord {
  cardId: number;
  /** 'Strike' | 'Snow' | 'Flood' | 'Derailment' */
  cardType: string;
  drawingPlayerId: string;
  drawingPlayerIndex: number;
  drawingPlayerTurnNumber: number;
  expiresAfterTurnNumber: number;
  affectedZone: string[];
  restrictions: {
    movement: MovementRestriction[];
    build: BuildRestriction[];
    pickupDelivery: PickupDeliveryRestriction[];
  };
  pendingLostTurns: { playerId: string }[];
  /** Flood only — river name (e.g., "Rhine") for rebuild blocking */
  floodedRiver?: string;
  createdAt: string;
}

/**
 * Runtime representation of an active effect (rehydrated from ActiveEffectRecord).
 * affectedZone is a Set<string> for efficient lookup.
 */
export interface ActiveEffect {
  cardId: number;
  cardType: EventCardType;
  drawingPlayerId: string;
  drawingPlayerIndex: number;
  expiresAfterTurnNumber: number;
  /** Rehydrated from string[] */
  affectedZone: Set<string>;
  restrictions: {
    movement: MovementRestriction[];
    build: BuildRestriction[];
    pickupDelivery: PickupDeliveryRestriction[];
  };
  pendingLostTurns: { playerId: string }[];
  /** Flood only */
  floodedRiver?: string;
}

/**
 * Structured result returned by `EventCardService.processEventCard`.
 * Describes every state change made (and every persistent descriptor to
 * forward to Project 3).
 */
export interface EventCardResult {
  cardId: number;
  cardType: EventCardType;
  drawingPlayerId: string;
  /** Milepost keys included in the effect zone (serializable array) */
  affectedZone: string[];
  perPlayerEffects: PerPlayerEffect[];
  /** Non-empty only for Flood events */
  floodSegmentsRemoved: Array<{ playerId: string; removedCount: number }>;
  /** Present for all event types that produce persistent effects */
  persistentEffectDescriptor?: ActiveEffectDescriptor;
}
