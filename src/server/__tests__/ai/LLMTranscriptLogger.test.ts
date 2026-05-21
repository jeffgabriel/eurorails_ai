import { appendLLMCall, LLMTranscriptEntry, TripPlannerSelectionDiagnostic } from '../../services/ai/LLMTranscriptLogger';
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

// ── JIRA-210B: LLMTranscriptEntry round-trip with narrowed tripPlannerSelection ──

describe('LLMTranscriptLogger — JIRA-210B tripPlannerSelection round-trip', () => {
  it('AC4: LLMTranscriptEntry with no_actionable_options diagnostic round-trips through JSON', () => {
    const diag: TripPlannerSelectionDiagnostic = {
      fallbackReason: 'no_actionable_options',
    };

    const entry: LLMTranscriptEntry = makeEntry({ tripPlannerSelection: diag });
    const serialized = JSON.stringify(entry);
    const parsed: LLMTranscriptEntry = JSON.parse(serialized);

    expect(parsed.tripPlannerSelection).toBeDefined();
    expect(parsed.tripPlannerSelection!.fallbackReason).toBe('no_actionable_options');
  });

  it('AC4b: LLMTranscriptEntry with keep_current_plan diagnostic round-trips through JSON', () => {
    const diag: TripPlannerSelectionDiagnostic = {
      fallbackReason: 'keep_current_plan',
    };

    const entry: LLMTranscriptEntry = makeEntry({ tripPlannerSelection: diag });
    const serialized = JSON.stringify(entry);
    const parsed: LLMTranscriptEntry = JSON.parse(serialized);

    expect(parsed.tripPlannerSelection).toBeDefined();
    expect(parsed.tripPlannerSelection!.fallbackReason).toBe('keep_current_plan');
  });

  it('AC6: entry without tripPlannerSelection does not serialize the key', () => {
    const entry: LLMTranscriptEntry = makeEntry(); // no tripPlannerSelection
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('tripPlannerSelection');
  });

  // ── Compile-time type checks for narrowed fallbackReason union ─────

  it('AC4c: fallbackReason accepts no_actionable_options (compile-time)', () => {
    // If TripPlannerSelectionDiagnostic.fallbackReason does not include
    // 'no_actionable_options', tsc will fail.
    const reason: TripPlannerSelectionDiagnostic['fallbackReason'] = 'no_actionable_options';
    expect(reason).toBe('no_actionable_options');
  });

  it('AC4d: fallbackReason accepts keep_current_plan (compile-time)', () => {
    const reason: TripPlannerSelectionDiagnostic['fallbackReason'] = 'keep_current_plan';
    expect(reason).toBe('keep_current_plan');
  });
});
