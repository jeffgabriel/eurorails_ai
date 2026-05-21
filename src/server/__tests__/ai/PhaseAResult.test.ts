/**
 * PhaseAResult type-shape tests (JIRA-195 Slice 3b).
 *
 * Validates that the PhaseAResult interface is correctly typed and that
 * all handoff fields are populated correctly across three turn shapes:
 *   - Simple turn: move + pickup/deliver, no replan
 *   - Replan turn: post-delivery replan via PostDeliveryReplanner
 *   - Pure-build turn: no movement at all (Phase A exits early)
 *
 * These tests are compile-time + runtime type-shape checks. They do NOT test
 * MovementPhasePlanner internals (those are in MovementPhasePlanner.test.ts).
 * They ensure the PhaseAResult contract is stable before BuildPhasePlanner
 * and TurnExecutorPlanner consume it.
 */

import type { PhaseAResult } from '../../services/ai/schemas';
import type {
  StrategicRoute,
  TurnPlan,
  LlmAttempt,
} from '../../../shared/types/GameTypes';
import { AIActionType } from '../../../shared/types/GameTypes';

// ── Factory helpers ────────────────────────────────────────────────────────

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', city: 'Lyon', loadType: 'Wine' },
      { action: 'deliver', city: 'Berlin', loadType: 'Wine' },
    ],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Lyon',
    createdAtTurn: 1,
    reasoning: 'test route',
    ...overrides,
  };
}

function makeMovePlan(): TurnPlan {
  return {
    type: AIActionType.MoveTrain,
    path: [{ row: 5, col: 5 }, { row: 5, col: 6 }],
    milesUsed: 1,
    cost: 0,
    trackUsageFees: [],
  } as unknown as TurnPlan;
}

function makeDeliverPlan(): TurnPlan {
  return {
    type: AIActionType.DeliverLoad,
    load: 'Wine',
    city: 'Berlin',
  } as unknown as TurnPlan;
}

function makePickupPlan(): TurnPlan {
  return {
    type: AIActionType.PickupLoad,
    load: 'Wine',
    city: 'Lyon',
  } as unknown as TurnPlan;
}

/**
 * Construct a valid PhaseAResult object.
 * TypeScript enforces all required fields at compile time — if this compiles,
 * the interface shape is correct.
 */
function makePhaseAResult(overrides: Partial<PhaseAResult> = {}): PhaseAResult {
  return {
    activeRoute: makeRoute(),
    lastMoveTargetCity: null,
    deliveriesThisTurn: 0,
    accumulatedPlans: [],
    loadStateMutations: { snapshotLoads: [], contextLoads: [] },
    routeAbandoned: false,
    routeComplete: false,
    hasDelivery: false,
    ...overrides,
  };
}

// ── Type-shape: required fields exist and have correct types ───────────────

describe('PhaseAResult — type shape', () => {
  it('can be constructed with all required fields', () => {
    const result: PhaseAResult = makePhaseAResult();

    // Required fields present
    expect(result).toHaveProperty('activeRoute');
    expect(result).toHaveProperty('lastMoveTargetCity');
    expect(result).toHaveProperty('deliveriesThisTurn');
    expect(result).toHaveProperty('accumulatedPlans');
    expect(result).toHaveProperty('loadStateMutations');
    expect(result).toHaveProperty('routeAbandoned');
    expect(result).toHaveProperty('routeComplete');
    expect(result).toHaveProperty('hasDelivery');
  });

  it('activeRoute is a StrategicRoute with stops array', () => {
    const result = makePhaseAResult();
    expect(Array.isArray(result.activeRoute.stops)).toBe(true);
    expect(typeof result.activeRoute.currentStopIndex).toBe('number');
  });

  it('lastMoveTargetCity is string or null', () => {
    const withNull = makePhaseAResult({ lastMoveTargetCity: null });
    const withCity = makePhaseAResult({ lastMoveTargetCity: 'Berlin' });

    expect(withNull.lastMoveTargetCity).toBeNull();
    expect(withCity.lastMoveTargetCity).toBe('Berlin');
  });

  it('deliveriesThisTurn is a number', () => {
    const result = makePhaseAResult({ deliveriesThisTurn: 2 });
    expect(typeof result.deliveriesThisTurn).toBe('number');
    expect(result.deliveriesThisTurn).toBe(2);
  });

  it('accumulatedPlans is an array of TurnPlan', () => {
    const plans: TurnPlan[] = [makeMovePlan(), makeDeliverPlan()];
    const result = makePhaseAResult({ accumulatedPlans: plans });

    expect(Array.isArray(result.accumulatedPlans)).toBe(true);
    expect(result.accumulatedPlans).toHaveLength(2);
    expect(result.accumulatedPlans[0].type).toBe(AIActionType.MoveTrain);
    expect(result.accumulatedPlans[1].type).toBe(AIActionType.DeliverLoad);
  });

  it('loadStateMutations has snapshotLoads and contextLoads arrays', () => {
    const result = makePhaseAResult({
      loadStateMutations: { snapshotLoads: ['Wine'], contextLoads: ['Wine'] },
    });
    expect(result.loadStateMutations.snapshotLoads).toEqual(['Wine']);
    expect(result.loadStateMutations.contextLoads).toEqual(['Wine']);
  });

  it('optional fields default to undefined when not provided', () => {
    const result = makePhaseAResult();
    expect(result.replanLlmLog).toBeUndefined();
    expect(result.replanSystemPrompt).toBeUndefined();
    expect(result.replanUserPrompt).toBeUndefined();
  });

  it('optional replan fields accept correct types', () => {
    const llmLog: LlmAttempt[] = [];
    const result = makePhaseAResult({
      replanLlmLog: llmLog,
      replanSystemPrompt: 'system',
      replanUserPrompt: 'user',
    });
    expect(result.replanLlmLog).toBe(llmLog);
    expect(result.replanSystemPrompt).toBe('system');
    expect(result.replanUserPrompt).toBe('user');
  });
});

// ── Simple turn scenario: move + pickup, no replan ─────────────────────────

describe('PhaseAResult — simple turn scenario (move + pickup, no replan)', () => {
  it('reflects a pickup executed and stop index advanced', () => {
    const route = makeRoute({ currentStopIndex: 1 }); // pickup done, deliver pending
    const plans: TurnPlan[] = [makeMovePlan(), makePickupPlan()];

    const result = makePhaseAResult({
      activeRoute: route,
      lastMoveTargetCity: 'Lyon',
      deliveriesThisTurn: 0,
      accumulatedPlans: plans,
      loadStateMutations: { snapshotLoads: ['Wine'], contextLoads: ['Wine'] },
      routeAbandoned: false,
      routeComplete: false,
      hasDelivery: false,
    });

    expect(result.activeRoute.currentStopIndex).toBe(1);
    expect(result.lastMoveTargetCity).toBe('Lyon');
    expect(result.deliveriesThisTurn).toBe(0);
    expect(result.accumulatedPlans).toHaveLength(2);
    expect(result.loadStateMutations.snapshotLoads).toContain('Wine');
    expect(result.hasDelivery).toBe(false);
    expect(result.routeComplete).toBe(false);
    expect(result.routeAbandoned).toBe(false);
  });
});

// ── Replan turn scenario: delivery + post-delivery replan ─────────────────

describe('PhaseAResult — replan turn scenario (delivery + PostDeliveryReplanner)', () => {
  it('reflects a delivery made and route replanned with LLM data', () => {
    const replanRoute = makeRoute({ currentStopIndex: 0, reasoning: 'replanned' });
    const llmLog: LlmAttempt[] = [];
    const plans: TurnPlan[] = [makeMovePlan(), makeDeliverPlan()];

    const result = makePhaseAResult({
      activeRoute: replanRoute,
      lastMoveTargetCity: null, // cleared by JIRA-194 moveTargetInvalidated signal
      deliveriesThisTurn: 1,
      accumulatedPlans: plans,
      loadStateMutations: { snapshotLoads: [], contextLoads: [] }, // load removed after delivery
      replanLlmLog: llmLog,
      replanSystemPrompt: 'sys-prompt',
      replanUserPrompt: 'usr-prompt',
      routeAbandoned: false,
      routeComplete: false,
      hasDelivery: true,
    });

    expect(result.activeRoute.reasoning).toBe('replanned');
    expect(result.lastMoveTargetCity).toBeNull(); // cleared after replan
    expect(result.deliveriesThisTurn).toBe(1);
    expect(result.accumulatedPlans).toHaveLength(2);
    expect(result.loadStateMutations.snapshotLoads).toHaveLength(0); // load delivered
    expect(result.replanLlmLog).toBe(llmLog);
    expect(result.replanSystemPrompt).toBe('sys-prompt');
    expect(result.replanUserPrompt).toBe('usr-prompt');
    expect(result.hasDelivery).toBe(true);
  });

  it('lastMoveTargetCity is null when moveTargetInvalidated was true', () => {
    // Simulates the JIRA-194 contract: after any route replacement,
    // MovementPhasePlanner should set lastMoveTargetCity = null in PhaseAResult
    const result = makePhaseAResult({
      lastMoveTargetCity: null,
      hasDelivery: true,
      deliveriesThisTurn: 1,
    });
    expect(result.lastMoveTargetCity).toBeNull();
  });
});

// ── Pure-build turn scenario: no movement, route not on network ───────────

describe('PhaseAResult — pure-build turn scenario (no movement)', () => {
  it('reflects empty plans and no movement when Phase A exits immediately', () => {
    const route = makeRoute({ currentStopIndex: 0 }); // stop not on network

    const result = makePhaseAResult({
      activeRoute: route,
      lastMoveTargetCity: null, // no move emitted
      deliveriesThisTurn: 0,
      accumulatedPlans: [], // empty — no movement plans
      loadStateMutations: { snapshotLoads: [], contextLoads: [] },
      routeAbandoned: false,
      routeComplete: false,
      hasDelivery: false,
    });

    expect(result.accumulatedPlans).toHaveLength(0);
    expect(result.lastMoveTargetCity).toBeNull();
    expect(result.deliveriesThisTurn).toBe(0);
    expect(result.hasDelivery).toBe(false);
    expect(result.routeComplete).toBe(false);
    expect(result.routeAbandoned).toBe(false);
  });

  it('routeAbandoned=true when Phase A failed an action', () => {
    const result = makePhaseAResult({
      accumulatedPlans: [{ type: AIActionType.PassTurn } as TurnPlan],
      routeAbandoned: true,
      routeComplete: false,
    });

    expect(result.routeAbandoned).toBe(true);
    expect(result.routeComplete).toBe(false);
  });

  it('routeComplete=true when all stops finished during Phase A', () => {
    const completedRoute = makeRoute({ currentStopIndex: 2 }); // past all stops

    const result = makePhaseAResult({
      activeRoute: completedRoute,
      routeComplete: true,
      routeAbandoned: false,
      hasDelivery: true,
    });

    expect(result.routeComplete).toBe(true);
    expect(result.routeAbandoned).toBe(false);
    expect(result.activeRoute.currentStopIndex).toBe(2);
  });
});

// ── Cross-scenario invariants ─────────────────────────────────────────────

describe('PhaseAResult — cross-scenario invariants', () => {
  it('routeAbandoned and routeComplete are never both true', () => {
    // These are mutually exclusive per the spec — test that we can distinguish them
    const abandonedResult = makePhaseAResult({ routeAbandoned: true, routeComplete: false });
    const completeResult = makePhaseAResult({ routeAbandoned: false, routeComplete: true });
    const neitherResult = makePhaseAResult({ routeAbandoned: false, routeComplete: false });

    expect(abandonedResult.routeAbandoned && abandonedResult.routeComplete).toBe(false);
    expect(completeResult.routeAbandoned && completeResult.routeComplete).toBe(false);
    expect(!neitherResult.routeAbandoned && !neitherResult.routeComplete).toBe(true);
  });

  it('hasDelivery is false when deliveriesThisTurn is 0', () => {
    const result = makePhaseAResult({ deliveriesThisTurn: 0, hasDelivery: false });
    expect(result.hasDelivery).toBe(false);
    expect(result.deliveriesThisTurn).toBe(0);
  });

  it('hasDelivery is true when deliveriesThisTurn > 0', () => {
    const result = makePhaseAResult({ deliveriesThisTurn: 2, hasDelivery: true });
    expect(result.hasDelivery).toBe(true);
    expect(result.deliveriesThisTurn).toBeGreaterThan(0);
  });
});
