/**
 * JSON Schema for the LLM route planning response.
 * Matches the StrategicRoute structure expected by ResponseParser.parseStrategicRoute().
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const ROUTE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    route: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          action: { type: 'string' as const, enum: ['PICKUP', 'DELIVER', 'DROP'] },
          load: { type: 'string' as const },
          city: { type: 'string' as const },
          demandCardId: { type: 'number' as const },
          payment: { type: 'number' as const },
        },
        required: ['action', 'load', 'city'],
      },
    },
    startingCity: { type: 'string' as const },
    upgradeOnRoute: { type: 'string' as const, enum: ['FastFreight', 'HeavyFreight', 'Superfreight'] },
    reasoning: { type: 'string' as const },
    planHorizon: { type: 'string' as const },
  },
  required: ['route', 'startingCity', 'reasoning'],
};

/**
 * JSON Schema for the cargo conflict evaluation response (JIRA-92).
 * Lightweight schema: should the bot drop a carried load to free slots for a better route?
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const CARGO_CONFLICT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    action: { type: 'string' as const, enum: ['drop', 'keep'] },
    dropLoad: { type: 'string' as const },
    reasoning: { type: 'string' as const },
  },
  required: ['action', 'reasoning'],
};

/**
 * JSON Schema for the upgrade-before-drop evaluation response (JIRA-105b).
 * When the bot has a cargo conflict and a capacity-increasing upgrade is affordable,
 * should it upgrade instead of dropping a load?
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const UPGRADE_BEFORE_DROP_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    action: { type: 'string' as const, enum: ['upgrade', 'skip'] },
    targetTrain: { type: 'string' as const },
    reasoning: { type: 'string' as const },
  },
  required: ['action', 'reasoning'],
};

/**
 * JSON Schema for the LLM trip planning response (JIRA-126).
 * Multi-stop trip planner: generates 2-3 candidate trips with stops and reasoning,
 * then selects the best candidate by index.
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
/**
 * JSON Schema for the Build Advisor LLM response (JIRA-129).
 * Structured output: action (build/buildAlternative/replan/useOpponentTrack),
 * target city, waypoints as [row, col] pairs, optional newRoute for replan,
 * optional alternativeBuild, and reasoning.
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const BUILD_ADVISOR_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    action: { type: 'string' as const, enum: ['build', 'buildAlternative', 'replan', 'useOpponentTrack'] },
    target: { type: 'string' as const },
    waypoints: {
      type: 'array' as const,
      items: {
        type: 'array' as const,
        items: { type: 'number' as const },
      },
    },
    newRoute: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          action: { type: 'string' as const, enum: ['pickup', 'deliver'] },
          load: { type: 'string' as const },
          city: { type: 'string' as const },
          demandCardId: { type: 'number' as const },
          payment: { type: 'number' as const },
        },
        required: ['action', 'load', 'city'],
      },
    },
    alternativeBuild: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        target: { type: 'string' as const },
        waypoints: {
          type: 'array' as const,
          items: {
            type: 'array' as const,
            items: { type: 'number' as const },
          },
        },
      },
      required: ['target', 'waypoints'],
    },
    reasoning: { type: 'string' as const },
  },
  required: ['action', 'target', 'waypoints', 'reasoning'],
};

/**
 * Decision type for the Route Enrichment Advisor LLM response.
 * 'keep' = no changes to route; 'insert' = add new stops; 'reorder' = change stop ordering.
 */
export type RouteEnrichmentDecision = 'keep' | 'insert' | 'reorder';

/**
 * A single insertion suggested by the Route Enrichment Advisor.
 * Represents a new stop to be spliced into the existing route after the given stop index.
 */
export interface RouteEnrichmentInsertion {
  afterStopIndex: number;   // Insert the new stop after this index (-1 = before all stops)
  action: 'pickup' | 'deliver';
  loadType: string;
  city: string;
  reasoning: string;
  /** Optional: LLM-echoed detour cost used for divergence logging (R6). Not used for gating. */
  expectedDetourCost?: number;
}

/**
 * Full response shape from the Route Enrichment Advisor LLM call.
 * The LLM returns a decision with optional insertions or reorderedStops and overall reasoning.
 */
export interface RouteEnrichmentSchema {
  decision: RouteEnrichmentDecision;
  insertions?: RouteEnrichmentInsertion[];
  reorderedStops?: Array<{
    action: 'pickup' | 'deliver';
    loadType: string;
    city: string;
    demandCardId?: number;
    payment?: number;
  }>;
  reasoning: string;
}

/**
 * JSON Schema for the Route Enrichment Advisor LLM response.
 * The LLM examines a corridor map and suggests stop insertions or reordering
 * to capture en-route opportunities that TripPlanner's city-level planning misses.
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const ROUTE_ENRICHMENT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    decision: { type: 'string' as const, enum: ['keep', 'insert', 'reorder'] },
    insertions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          afterStopIndex: { type: 'number' as const },
          action: { type: 'string' as const, enum: ['pickup', 'deliver'] },
          loadType: { type: 'string' as const },
          city: { type: 'string' as const },
          reasoning: { type: 'string' as const },
          expectedDetourCost: { type: 'number' as const },
        },
        required: ['afterStopIndex', 'action', 'loadType', 'city', 'reasoning'],
      },
    },
    reorderedStops: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          action: { type: 'string' as const, enum: ['pickup', 'deliver'] },
          loadType: { type: 'string' as const },
          city: { type: 'string' as const },
          demandCardId: { type: 'number' as const },
          payment: { type: 'number' as const },
        },
        required: ['action', 'loadType', 'city'],
      },
    },
    reasoning: { type: 'string' as const },
  },
  required: ['decision', 'reasoning'],
};

/**
 * JSON Schema for the LLM trip planning response (JIRA-126, JIRA-190, JIRA-210B).
 * Single-route trip planner: returns one best multi-stop route per turn.
 *
 * JIRA-190: Field renames — city → supplyCity (PICKUP) / deliveryCity (DELIVER).
 * JIRA-210B: Collapsed from multi-candidate {candidates[], chosenIndex} shape to
 * single-route {stops, reasoning, upgradeOnRoute?} shape.
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const TRIP_PLAN_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    stops: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          action: { type: 'string' as const, enum: ['PICKUP', 'DELIVER'] },
          load: { type: 'string' as const },
          supplyCity: { type: 'string' as const },
          deliveryCity: { type: 'string' as const },
          demandCardId: { type: 'number' as const },
          payment: { type: 'number' as const },
        },
        required: ['action', 'load'],
      },
    },
    reasoning: { type: 'string' as const },
    upgradeOnRoute: { type: 'string' as const, enum: ['FastFreight', 'HeavyFreight', 'Superfreight'] },
  },
  required: ['stops', 'reasoning'],
};

/**
 * JSON Schema for the TripCandidateSelector LLM response (JIRA-217).
 * The selector picks one of the optimizer's top-N candidates by ID.
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const SELECTOR_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    chosenCandidateId: { type: 'number' as const },
    rationale: { type: 'string' as const, maxLength: 200 },
  },
  required: ['chosenCandidateId', 'rationale'],
} as const;

// ── Stage3Result ──────────────────────────────────────────────────────────

/**
 * Typed handoff record assembled at the end of the four-branch Stage 3 decision
 * gate inside AIStrategyEngine.takeTurn (JIRA-195b sub-slice A).
 *
 * Names the 13 mutable locals that flow from the decision branches into
 * sub-stages F1-F4. Sub-slices B/C/D will migrate each decision branch to
 * return through this typed contract instead of bare locals. Sub-slice A
 * assembles a temporary instance just before F1 (upgrade injection) so that
 * F1 reads from the named field rather than the bare local — the first step
 * in making the implicit Stage 3 return contract explicit.
 */
export interface Stage3Result {
  /** LLM (or computed) decision produced by the active branch. */
  decision: import('../../../shared/types/GameTypes').LLMDecisionResult;
  /** Strategic route after the decision gate (may be null when no route exists). */
  activeRoute: import('../../../shared/types/GameTypes').StrategicRoute | null;
  /** True when the active route completed all stops this turn. */
  routeWasCompleted: boolean;
  /** True when the active route was abandoned this turn. */
  routeWasAbandoned: boolean;
  /** True when at least one delivery was executed in Stage 3. */
  hasDelivery: boolean;
  /** Remaining route stops before the route was completed or abandoned (BE-010). */
  previousRouteStops: import('../../../shared/types/GameTypes').RouteStop[] | null;
  /** Secondary delivery diagnostic logged when a dead-load drop enabled a delivery. */
  secondaryDeliveryLog?: {
    action: string;
    reasoning: string;
    pickupCity?: string;
    loadType?: string;
    deliveryCity?: string;
    deadLoadsDropped?: string[];
  };
  /** Drop-load actions staged for dead loads (fed into TurnComposer). */
  deadLoadDropActions: import('../../../shared/types/GameTypes').TurnPlanDropLoad[];
  /** Upgrade action to inject into the turn plan (JIRA-105), or null when none. */
  pendingUpgradeAction: import('../../../shared/types/GameTypes').TurnPlanUpgradeTrain | null;
  /** Reason an upgrade was blocked (JIRA-161), or null when no suppression occurred. */
  upgradeSuppressionReason: string | null;
  /** Composition trace from TurnExecutorPlanner, populated on active-route paths. */
  execCompositionTrace: import('./TurnExecutorPlanner').CompositionTrace | null;
  /**
   * Game state snapshot at the time of the decision gate.
   * Mutated by JIRA-170 auto-delivery refresh; sub-slice D will surface this
   * through Stage3Result so downstream sub-stages receive the refreshed value.
   */
  snapshot: import('../../../shared/types/GameTypes').WorldSnapshot;
  /**
   * Bot context at the time of the decision gate.
   * Mutated by JIRA-170 auto-delivery refresh alongside snapshot.
   */
  context: import('../../../shared/types/GameTypes').GameContext;
}

// ── PhaseAResult ──────────────────────────────────────────────────────────

/**
 * Typed handoff record from MovementPhasePlanner.run() to BuildPhasePlanner.run().
 * This is the sole state vehicle between the two phase planners (JIRA-195 R5).
 *
 * Replaces the implicit local variables that previously flowed between Phase A
 * and Phase B inside TurnExecutorPlanner.execute(). Using a typed record makes
 * the boundary explicit and prevents JIRA-194's class of stale-locals bugs.
 */
export interface PhaseAResult {
  /** Active strategic route after Phase A movement (advanced stop indices, possibly replanned). */
  activeRoute: import('../../../shared/types/GameTypes').StrategicRoute;
  /**
   * Last city the bot was explicitly commanded to move toward (for AC13(b) build direction check).
   * Null when no move was emitted in Phase A or when a replan cleared it (JIRA-194).
   */
  lastMoveTargetCity: string | null;
  /** Number of deliveries executed during Phase A (for JIRA-185 deliveryCount patching). */
  deliveriesThisTurn: number;
  /** Turn plans accumulated during Phase A (moves, pickups, deliveries). */
  accumulatedPlans: import('../../../shared/types/GameTypes').TurnPlan[];
  /**
   * Load state side-effects applied to snapshot/context during Phase A.
   * Preserved here so BuildPhasePlanner can reconstruct context if needed.
   * Currently a plain object snapshot of the loads arrays after Phase A.
   */
  loadStateMutations: {
    snapshotLoads: string[];
    contextLoads: string[];
  };
  /** Post-delivery replan LLM data (propagated from PostDeliveryReplanner). */
  replanLlmLog?: import('../../../shared/types/GameTypes').LlmAttempt[];
  /** Post-delivery replan system prompt. */
  replanSystemPrompt?: string;
  /** Post-delivery replan user prompt. */
  replanUserPrompt?: string;
  /**
   * Accumulated upgrade action from post-delivery replans (JIRA-198).
   * Last non-null action wins across multiple in-turn replans.
   * Undefined when no replan emitted an upgradeOnRoute hint.
   */
  pendingUpgradeAction?: import('../../../shared/types/GameTypes').TurnPlanUpgradeTrain | null;
  /**
   * Suppression reason from the most recent replan that blocked an upgrade (JIRA-198).
   * Overwritten only by a later non-null action; a later null does not clobber a prior non-null.
   */
  upgradeSuppressionReason?: string | null;
  /** True when the route was abandoned during Phase A. */
  routeAbandoned: boolean;
  /** True when all route stops completed during Phase A. */
  routeComplete: boolean;
  /** True when at least one delivery was made in Phase A. */
  hasDelivery: boolean;
}

