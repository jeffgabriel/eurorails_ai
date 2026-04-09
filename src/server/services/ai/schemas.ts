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
          action: { type: 'string' as const, enum: ['PICKUP', 'DELIVER'] },
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

export const TRIP_PLAN_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    candidates: {
      type: 'array' as const,
      items: {
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
                city: { type: 'string' as const },
                demandCardId: { type: 'number' as const },
                payment: { type: 'number' as const },
              },
              required: ['action', 'load', 'city'],
            },
          },
          reasoning: { type: 'string' as const },
        },
        required: ['stops', 'reasoning'],
      },
    },
    chosenIndex: { type: 'number' as const },
    reasoning: { type: 'string' as const },
    upgradeOnRoute: { type: 'string' as const, enum: ['FastFreight', 'HeavyFreight', 'Superfreight'] },
  },
  required: ['candidates', 'chosenIndex', 'reasoning'],
};

