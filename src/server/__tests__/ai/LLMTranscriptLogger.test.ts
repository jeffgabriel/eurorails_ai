import { appendLLMCall, LLMTranscriptEntry, TripPlannerSelectionDiagnostic, CandidateFailure } from '../../services/ai/LLMTranscriptLogger';
import * as fs from 'fs';
import { join } from 'path';

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  appendFile: jest.fn((_path: string, _data: string, _encoding: string, cb: (err: Error | null) => void) => {
    cb(null);
  }),
}));

const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const mockAppendFile = fs.appendFile as unknown as jest.MockedFunction<
  (path: string, data: string, encoding: string, cb: (err: Error | null) => void) => void
>;

function makeEntry(overrides: Partial<LLMTranscriptEntry> = {}): LLMTranscriptEntry {
  return {
    callId: 'test-call-id',
    gameId: 'game-123',
    playerId: 'player-1',
    turn: 1,
    timestamp: '2026-03-24T12:00:00.000Z',
    caller: 'strategy-brain',
    method: 'decideAction',
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: 'You are a bot.',
    userPrompt: 'What should I do?',
    responseText: '{"action":"move"}',
    status: 'success',
    latencyMs: 500,
    attemptNumber: 1,
    totalAttempts: 1,
    ...overrides,
  };
}

describe('LLMTranscriptLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should ensure logs directory exists before writing', () => {
    appendLLMCall('game-123', makeEntry());

    expect(mockMkdirSync).toHaveBeenCalledWith(
      join(process.cwd(), 'logs'),
      { recursive: true },
    );
  });

  it('should write valid NDJSON to the correct file path', () => {
    const entry = makeEntry();
    appendLLMCall('game-123', entry);

    expect(mockAppendFile).toHaveBeenCalledWith(
      join(process.cwd(), 'logs', 'llm-game-123.ndjson'),
      JSON.stringify(entry) + '\n',
      'utf8',
      expect.any(Function),
    );
  });

  it('should handle different entry data correctly', () => {
    const entry = makeEntry({
      callId: 'different-id',
      status: 'error',
      error: 'Timeout exceeded',
      tokenUsage: { input: 100, output: 50 },
    });
    appendLLMCall('game-456', entry);

    const writtenData = (mockAppendFile as jest.Mock).mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenData.trim());
    expect(parsed.callId).toBe('different-id');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('Timeout exceeded');
    expect(parsed.tokenUsage).toEqual({ input: 100, output: 50 });
  });

  it('should not throw when appendFile callback returns error', () => {
    (mockAppendFile as jest.Mock).mockImplementation(
      (_path: string, _data: string, _encoding: string, cb: (err: Error | null) => void) => {
        cb(new Error('disk full'));
      },
    );

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    expect(() => appendLLMCall('game-123', makeEntry())).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LLMTranscriptLogger]'),
      expect.stringContaining('disk full'),
    );

    consoleSpy.mockRestore();
  });

  it('should not throw when mkdirSync throws', () => {
    mockMkdirSync.mockImplementation(() => { throw new Error('permission denied'); });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    expect(() => appendLLMCall('game-123', makeEntry())).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LLMTranscriptLogger]'),
      expect.stringContaining('permission denied'),
    );

    consoleSpy.mockRestore();
  });
});

// ── JIRA-194: LLMTranscriptEntry round-trip with tripPlannerSelection ─────────

describe('LLMTranscriptLogger — JIRA-194 tripPlannerSelection round-trip', () => {
  it('AC8: LLMTranscriptEntry with tripPlannerSelection round-trips through JSON.stringify/JSON.parse', () => {
    const diag: TripPlannerSelectionDiagnostic = {
      llmChosenIndex: 0,
      actualSelectedLlmIndex: 1,
      fallbackReason: 'chosen_not_in_validated',
      candidates: [
        {
          llmIndex: 0,
          rawStops: [
            { action: 'PICKUP', load: 'Ham', city: 'Warszawa' },
            { action: 'DELIVER', load: 'Ham', city: 'Torino' },
          ],
          validatorErrors: ['No demand card for Ham→Torino'],
          prunedToZero: false,
        },
        {
          llmIndex: 1,
          rawStops: [
            { action: 'PICKUP', load: 'Oil', city: 'Beograd' },
            { action: 'DELIVER', load: 'Oil', city: 'Zurich' },
          ],
          validatorErrors: [],
          prunedToZero: false,
        },
      ],
    };

    const entry: LLMTranscriptEntry = makeEntry({ tripPlannerSelection: diag });
    const serialized = JSON.stringify(entry);
    const parsed: LLMTranscriptEntry = JSON.parse(serialized);

    expect(parsed.tripPlannerSelection).toBeDefined();
    expect(parsed.tripPlannerSelection!.llmChosenIndex).toBe(0);
    expect(parsed.tripPlannerSelection!.actualSelectedLlmIndex).toBe(1);
    expect(parsed.tripPlannerSelection!.fallbackReason).toBe('chosen_not_in_validated');
    expect(parsed.tripPlannerSelection!.candidates).toHaveLength(2);
    expect(parsed.tripPlannerSelection!.candidates[0].validatorErrors).toHaveLength(1);
    expect(parsed.tripPlannerSelection!.candidates[0].validatorErrors[0]).toBe('No demand card for Ham→Torino');
    expect(parsed.tripPlannerSelection!.candidates[1].validatorErrors).toHaveLength(0);
  });

  it('AC6: entry without tripPlannerSelection does not serialize the key', () => {
    const entry: LLMTranscriptEntry = makeEntry(); // no tripPlannerSelection
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('tripPlannerSelection');
  });
});

// ── JIRA-207A: CandidateFailure round-trip + widened fallbackReason ────────────

describe('LLMTranscriptLogger — JIRA-207A schema widening', () => {
  // ── AC4: candidateFailures NDJSON round-trip ─────────────────────────────────

  it('AC4: candidateFailures array round-trips through JSON.stringify/JSON.parse', () => {
    const failures: CandidateFailure[] = [
      {
        candidateIndex: 1,
        failedRule: 'missing_pickup',
        detail: 'Candidate 1 PICKUP stop for Coal has no supply city in the candidates stops',
        suggestion: 'Add a PICKUP stop for Coal before the DELIVER stop',
      },
      {
        candidateIndex: 2,
        failedRule: 'capacity_exceeded',
        detail: 'Candidate 2 requests 3 loads but Freight train capacity is 2',
      },
    ];

    const diag: TripPlannerSelectionDiagnostic = {
      llmChosenIndex: 1,
      actualSelectedLlmIndex: -1,
      fallbackReason: 'no_affordable_candidate',
      candidates: [],
      candidateFailures: failures,
    };

    const entry: LLMTranscriptEntry = makeEntry({ tripPlannerSelection: diag });
    const serialized = JSON.stringify(entry);
    const parsed: LLMTranscriptEntry = JSON.parse(serialized);

    expect(parsed.tripPlannerSelection!.candidateFailures).toBeDefined();
    expect(parsed.tripPlannerSelection!.candidateFailures).toHaveLength(2);

    const f0 = parsed.tripPlannerSelection!.candidateFailures![0];
    expect(f0.candidateIndex).toBe(1);
    expect(f0.failedRule).toBe('missing_pickup');
    expect(f0.detail).toBe('Candidate 1 PICKUP stop for Coal has no supply city in the candidates stops');
    expect(f0.suggestion).toBe('Add a PICKUP stop for Coal before the DELIVER stop');

    const f1 = parsed.tripPlannerSelection!.candidateFailures![1];
    expect(f1.candidateIndex).toBe(2);
    expect(f1.failedRule).toBe('capacity_exceeded');
    expect(f1.detail).toBe('Candidate 2 requests 3 loads but Freight train capacity is 2');
    expect(f1.suggestion).toBeUndefined();
  });

  it('AC4b: tripPlannerSelection without candidateFailures does not serialize the key', () => {
    const diag: TripPlannerSelectionDiagnostic = {
      llmChosenIndex: 0,
      actualSelectedLlmIndex: 0,
      fallbackReason: 'chosen_not_in_validated',
      candidates: [],
      // candidateFailures omitted
    };
    const entry: LLMTranscriptEntry = makeEntry({ tripPlannerSelection: diag });
    const serialized = JSON.stringify(entry);
    const parsed: LLMTranscriptEntry = JSON.parse(serialized);
    expect(parsed.tripPlannerSelection!.candidateFailures).toBeUndefined();
  });

  // ── AC5, AC10b: Compile-time type checks for widened fallbackReason union ─────

  it('AC5: fallbackReason accepts chosen_invalid_alternative_used (compile-time)', () => {
    // This test asserts TypeScript compile-time type correctness.
    // If TripPlannerSelectionDiagnostic.fallbackReason does not include
    // 'chosen_invalid_alternative_used', tsc will fail and this test won't reach runtime.
    const reason: TripPlannerSelectionDiagnostic['fallbackReason'] = 'chosen_invalid_alternative_used';
    expect(reason).toBe('chosen_invalid_alternative_used');
  });

  it('AC10b-a: fallbackReason accepts no_actionable_options (compile-time)', () => {
    const reason: TripPlannerSelectionDiagnostic['fallbackReason'] = 'no_actionable_options';
    expect(reason).toBe('no_actionable_options');
  });

  it('AC10b-b: fallbackReason accepts keep_current_plan (compile-time)', () => {
    const reason: TripPlannerSelectionDiagnostic['fallbackReason'] = 'keep_current_plan';
    expect(reason).toBe('keep_current_plan');
  });

  it('AC4c: CandidateFailure failedRule accepts all defined values', () => {
    const rules: CandidateFailure['failedRule'][] = [
      'missing_pickup',
      'capacity_exceeded',
      'city_not_on_route',
      'load_not_at_supply',
      'pruned_to_zero',
    ];
    expect(rules).toHaveLength(5);
    rules.forEach(r => expect(typeof r).toBe('string'));
  });
});
