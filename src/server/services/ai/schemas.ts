import { AIActionType } from '../../../shared/types/GameTypes';

/**
 * All valid action strings accepted by ResponseParser.parseActionIntent().
 * Includes AIActionType enum values and LLM shorthand aliases.
 */
const VALID_ACTION_STRINGS = [
  ...Object.values(AIActionType),
  'BUILD', 'MOVE', 'DELIVER', 'PICKUP', 'UPGRADE', 'DISCARD_HAND', 'PASS',
];

/**
 * JSON Schema for the LLM action decision response.
 * Supports both single-action (action field) and multi-action (actions array) formats
 * using oneOf. Passed to Anthropic's structured output API via output_config.
 *
 * Note: Anthropic requires additionalProperties: false on all object types.
 */
export const ACTION_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  oneOf: [
    {
      properties: {
        action: { type: 'string' as const, enum: VALID_ACTION_STRINGS },
        details: {
          type: 'object' as const,
          additionalProperties: { type: 'string' as const },
        },
        reasoning: { type: 'string' as const },
        planHorizon: { type: 'string' as const },
      },
      required: ['action', 'reasoning'],
      additionalProperties: false as const,
    },
    {
      properties: {
        actions: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              action: { type: 'string' as const, enum: VALID_ACTION_STRINGS },
              details: {
                type: 'object' as const,
                additionalProperties: { type: 'string' as const },
              },
            },
            required: ['action'],
          },
        },
        reasoning: { type: 'string' as const },
        planHorizon: { type: 'string' as const },
      },
      required: ['actions', 'reasoning'],
      additionalProperties: false as const,
    },
  ],
};

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
      minItems: 1,
      maxItems: 3,
    },
    chosenIndex: { type: 'number' as const },
    reasoning: { type: 'string' as const },
  },
  required: ['candidates', 'chosenIndex', 'reasoning'],
};

