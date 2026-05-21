/**
 * logRoutes.jira194.test.ts — JIRA-210B viewer render tests.
 *
 * AC15: handleGameViewer emits a visible diagnostic section when a turn entry
 * contains tripPlanning.fallbackReason. handleLLMViewer emits a visible
 * diagnostic section when an LLM entry contains tripPlannerSelection.
 * Both viewers render cleanly when the new fields are absent.
 * Backward-compat: historical logs with candidates[]/chosen still render without throwing.
 */

// ── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../services/logParser', () => ({
  loadNdjsonLog: jest.fn(),
  loadLLMTranscript: jest.fn(),
  inferDecisionSource: jest.fn(() => 'trip-planner'),
  isLlmModel: jest.fn(() => false),
  isValidGameId: jest.fn(() => true),
  listGameLogs: jest.fn(() => []),
  parseTurnRange: jest.fn(() => null),
  fmt: jest.fn((n: number) => String(n)),
  secs: jest.fn((ms: number) => `${(ms / 1000).toFixed(1)}s`),
  loc: jest.fn(() => '(5,5)'),
}));

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  appendFile: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(() => ({ mtimeMs: Date.now() })),
}));

jest.mock('../db/index', () => ({ db: { query: jest.fn() } }));

import { _renderTurnCard, _renderLLMCallCards } from '../routes/logRoutes';
import type { GameTurnLogEntry } from '../services/ai/GameLogger';
import type { LLMTranscriptEntry } from '../services/ai/LLMTranscriptLogger';

// ── Helpers ────────────────────────────────────────────────────────────────

function baseTurnEntry(overrides: Partial<GameTurnLogEntry> = {}): GameTurnLogEntry {
  return {
    turn: 1,
    playerId: 'bot-1',
    timestamp: '2024-01-01T00:00:00Z',
    action: 'MoveTrain' as any,
    success: true,
    segmentsBuilt: 0,
    cost: 0,
    durationMs: 100,
    ...overrides,
  } as GameTurnLogEntry;
}

function baseLlmEntry(overrides: Partial<LLMTranscriptEntry> = {}): LLMTranscriptEntry {
  return {
    callId: 'test-id',
    gameId: 'g1',
    playerId: 'bot-1',
    turn: 1,
    timestamp: '2024-01-01T00:00:00Z',
    caller: 'trip-planner',
    method: 'planTrip',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'system',
    userPrompt: 'user',
    responseText: '{}',
    status: 'success',
    latencyMs: 100,
    attemptNumber: 1,
    totalAttempts: 1,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('logRoutes — JIRA-210B viewer renders (single-route shape)', () => {
  // AC15: renderTurnCard emits short-circuit section when fallbackReason is present
  it('renderTurnCard: emits TripPlanner Short-circuit section when fallbackReason is no_actionable_options', () => {
    const entry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        stops: [],
        llmLatencyMs: 500,
        llmTokens: { input: 100, output: 50 },
        llmReasoning: '',
        fallbackReason: 'no_actionable_options',
      },
    });

    const html = _renderTurnCard(entry, 0);

    expect(html).toContain('TripPlanner Short-circuit');
    expect(html).toContain('no_actionable_options');
  });

  it('renderTurnCard: emits TripPlanner Short-circuit section when fallbackReason is keep_current_plan', () => {
    const entry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        llmLatencyMs: 200,
        llmTokens: { input: 50, output: 25 },
        llmReasoning: '',
        fallbackReason: 'keep_current_plan',
      },
    });

    const html = _renderTurnCard(entry, 0);

    expect(html).toContain('TripPlanner Short-circuit');
    expect(html).toContain('keep_current_plan');
  });

  // AC15: renderTurnCard renders single-route stops
  it('renderTurnCard: renders single-route stops (no Chosen: Route N/M line)', () => {
    const entry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        stops: ['pickup(Coal@Cardiff)', 'deliver(Coal@Ruhr)'],
        llmLatencyMs: 300,
        llmTokens: { input: 80, output: 40 },
        llmReasoning: 'good route',
      },
    });

    const html = _renderTurnCard(entry, 0);
    expect(html).toContain('Trip Planning');
    expect(html).toContain('pickup(Coal@Cardiff)');
    expect(html).not.toContain('Chosen: Route');
  });

  // AC15: renderTurnCard renders cleanly when tripPlanning is absent
  it('renderTurnCard: renders cleanly when tripPlanning is absent', () => {
    const entry = baseTurnEntry(); // no tripPlanning

    expect(() => _renderTurnCard(entry, 0)).not.toThrow();
    const html = _renderTurnCard(entry, 0);
    expect(html).not.toContain('TripPlanner Short-circuit');
  });

  // AC15: renderTurnCard renders cleanly when tripPlanning exists but no fallbackReason
  it('renderTurnCard: no TripPlanner Short-circuit section when fallbackReason is absent', () => {
    const entry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        llmLatencyMs: 200,
        llmTokens: { input: 50, output: 25 },
        llmReasoning: 'honored',
        // No fallbackReason — normal route planned
      },
    });

    const html = _renderTurnCard(entry, 0);
    expect(html).not.toContain('TripPlanner Short-circuit');
    expect(html).toContain('Trip Planning'); // still shows the trip planning section
  });

  // Backward-compat: historical log entries with candidates[]/chosen still render without throwing
  it('renderTurnCard: handles historical logs with candidates[]/chosen without throwing (R19)', () => {
    const historicalEntry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        // Old shape fields (historical logs) — cast to any to simulate NDJSON read
        ...({
          candidates: [{ stops: ['pickup(Coal@Cardiff)', 'deliver(Coal@Ruhr)'], score: 5, netValue: 10, estimatedTurns: 2, buildCostEstimate: 5, usageFeeEstimate: 0 }],
          chosen: 0,
          chosenByLlm: 0,
        } as any),
        llmLatencyMs: 200,
        llmTokens: { input: 50, output: 25 },
        llmReasoning: 'old log',
      } as any,
    });

    expect(() => _renderTurnCard(historicalEntry, 0)).not.toThrow();
    const html = _renderTurnCard(historicalEntry, 0);
    expect(html).toContain('Trip Planning');
  });

  // AC15: handleLLMViewer emits short-circuit diagnostic when tripPlannerSelection is present
  it('renderLLMCallCards: emits TripPlanner Short-circuit section when tripPlannerSelection is present', () => {
    const entry = baseLlmEntry({
      tripPlannerSelection: {
        fallbackReason: 'no_actionable_options',
      },
    });

    const html = _renderLLMCallCards([entry], 'g1');

    expect(html).toContain('TripPlanner Short-circuit');
    expect(html).toContain('no_actionable_options');
  });

  // AC15: renderLLMCallCards renders cleanly when tripPlannerSelection is absent
  it('renderLLMCallCards: renders cleanly when tripPlannerSelection is absent', () => {
    const entry = baseLlmEntry(); // no tripPlannerSelection

    expect(() => _renderLLMCallCards([entry], 'g1')).not.toThrow();
    const html = _renderLLMCallCards([entry], 'g1');
    expect(html).not.toContain('TripPlanner Short-circuit');
  });
});
