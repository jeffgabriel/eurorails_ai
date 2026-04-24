/**
 * logRoutes.jira194.test.ts — JIRA-194 viewer render tests.
 *
 * AC9: handleGameViewer emits a visible diagnostic section when a turn entry
 * contains tripPlanning.fallbackReason. handleLLMViewer emits a visible
 * diagnostic section when an LLM entry contains tripPlannerSelection.
 * Both viewers render cleanly when the new fields are absent.
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

describe('logRoutes — JIRA-194 viewer renders', () => {
  // AC9: handleGameViewer emits diagnostic section when fallbackReason is present
  it('renderTurnCard: emits TripPlanner Override section when fallbackReason is present', () => {
    const entry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        candidates: [],
        chosen: 1,
        llmLatencyMs: 500,
        llmTokens: { input: 100, output: 50 },
        llmReasoning: 'chose oil route',
        chosenByLlm: 0,
        fallbackReason: 'chosen_not_in_validated',
      },
    });

    const html = _renderTurnCard(entry, 0);

    expect(html).toContain('TripPlanner Override');
    expect(html).toContain('chosen_not_in_validated');
    expect(html).toContain('LLM chose candidate');
    expect(html).toContain('0'); // llmChosenIndex
  });

  // AC9: renderTurnCard renders cleanly when tripPlanning is absent
  it('renderTurnCard: renders cleanly when tripPlanning is absent', () => {
    const entry = baseTurnEntry(); // no tripPlanning

    expect(() => _renderTurnCard(entry, 0)).not.toThrow();
    const html = _renderTurnCard(entry, 0);
    expect(html).not.toContain('TripPlanner Override');
  });

  // AC9: renderTurnCard renders cleanly when tripPlanning exists but no fallbackReason
  it('renderTurnCard: no TripPlanner Override section when fallbackReason is absent', () => {
    const entry = baseTurnEntry({
      tripPlanning: {
        trigger: 'no-active-route',
        candidates: [],
        chosen: 0,
        llmLatencyMs: 200,
        llmTokens: { input: 50, output: 25 },
        llmReasoning: 'honored',
        // No chosenByLlm or fallbackReason — honored path
      },
    });

    const html = _renderTurnCard(entry, 0);
    expect(html).not.toContain('TripPlanner Override');
    expect(html).toContain('Trip Planning'); // still shows the trip planning section
  });

  // AC9: handleLLMViewer emits diagnostic section when tripPlannerSelection is present
  it('renderLLMCallCards: emits TripPlanner Selection Override section when tripPlannerSelection is present', () => {
    const entry = baseLlmEntry({
      tripPlannerSelection: {
        llmChosenIndex: 0,
        actualSelectedLlmIndex: 1,
        fallbackReason: 'chosen_not_in_validated',
        candidates: [
          {
            llmIndex: 0,
            rawStops: [{ action: 'PICKUP', load: 'Ham', city: 'Warszawa' }],
            validatorErrors: ['No demand card for Ham→Torino'],
            prunedToZero: false,
          },
          {
            llmIndex: 1,
            rawStops: [{ action: 'PICKUP', load: 'Oil', city: 'Beograd' }],
            validatorErrors: [],
            prunedToZero: false,
          },
        ],
      },
    });

    const html = _renderLLMCallCards([entry], 'g1');

    expect(html).toContain('TripPlanner Selection Override');
    expect(html).toContain('chosen_not_in_validated');
    expect(html).toContain('LLM chosenIndex: 0');
    expect(html).toContain('No demand card for Ham');
  });

  // AC9: renderLLMCallCards renders cleanly when tripPlannerSelection is absent
  it('renderLLMCallCards: renders cleanly when tripPlannerSelection is absent', () => {
    const entry = baseLlmEntry(); // no tripPlannerSelection

    expect(() => _renderLLMCallCards([entry], 'g1')).not.toThrow();
    const html = _renderLLMCallCards([entry], 'g1');
    expect(html).not.toContain('TripPlanner Selection Override');
  });
});
