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
 */
export const ACTION_SCHEMA = {
  type: 'object' as const,
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
    },
    {
      properties: {
        actions: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
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
    },
  ],
};

/**
 * JSON Schema for the LLM route planning response.
 * Matches the StrategicRoute structure expected by ResponseParser.parseStrategicRoute().
 */
export const ROUTE_SCHEMA = {
  type: 'object' as const,
  properties: {
    route: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
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
    reasoning: { type: 'string' as const },
    planHorizon: { type: 'string' as const },
  },
  required: ['route', 'startingCity', 'reasoning'],
};
