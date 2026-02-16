import {
  initTurnLog,
  logPhase,
  flushTurnLog,
  getCurrentLog,
  setOutputEnabled,
} from '../services/ai/DecisionLogger';
import {
  FeasibleOption,
  AIActionType,
  TurnDecisionLog,
} from '../../shared/types/GameTypes';
import { ExecutionResult } from '../services/ai/TurnExecutor';

// Suppress console output during tests
beforeAll(() => setOutputEnabled(false));
afterAll(() => setOutputEnabled(true));

afterEach(() => {
  // Ensure clean state between tests
  flushTurnLog();
});

describe('DecisionLogger', () => {
  describe('initTurnLog', () => {
    it('creates a new log with correct metadata', () => {
      initTurnLog('game-123', 'player-456', 5);
      const log = getCurrentLog();
      expect(log).not.toBeNull();
      expect(log!.gameId).toBe('game-123');
      expect(log!.playerId).toBe('player-456');
      expect(log!.turn).toBe(5);
      expect(log!.phases).toEqual([]);
    });

    it('replaces previous log when called again', () => {
      initTurnLog('game-1', 'player-1', 1);
      logPhase('Phase 0', [], null, null);
      expect(getCurrentLog()!.phases).toHaveLength(1);

      initTurnLog('game-2', 'player-2', 2);
      const log = getCurrentLog();
      expect(log!.gameId).toBe('game-2');
      expect(log!.phases).toHaveLength(0);
    });
  });

  describe('logPhase', () => {
    it('does nothing when no log is initialized', () => {
      // No initTurnLog called — should not throw
      logPhase('Phase 0', [], null, null);
      expect(getCurrentLog()).toBeNull();
    });

    it('appends a phase entry with empty options', () => {
      initTurnLog('g', 'p', 1);
      logPhase('Phase 0', [], null, null);

      const log = getCurrentLog()!;
      expect(log.phases).toHaveLength(1);
      expect(log.phases[0].phase).toBe('Phase 0');
      expect(log.phases[0].options).toEqual([]);
      expect(log.phases[0].chosen).toBeNull();
      expect(log.phases[0].result).toBeNull();
    });

    it('summarizes options correctly', () => {
      initTurnLog('g', 'p', 1);

      const options: FeasibleOption[] = [
        {
          action: AIActionType.MoveTrain,
          feasible: true,
          reason: 'path found',
          score: 85,
          targetCity: 'Berlin',
          mileposts: 7,
        },
        {
          action: AIActionType.MoveTrain,
          feasible: true,
          reason: 'alternate path',
          score: 60,
          targetCity: 'Wien',
          mileposts: 4,
        },
      ];

      logPhase('Phase 1', options, null, null);

      const logged = getCurrentLog()!.phases[0];
      expect(logged.options).toHaveLength(2);
      expect(logged.options[0]).toEqual({
        action: AIActionType.MoveTrain,
        feasible: true,
        reason: 'path found',
        score: 85,
        targetCity: 'Berlin',
        loadType: undefined,
        payment: undefined,
      });
      expect(logged.options[1].score).toBe(60);
    });

    it('records chosen option and execution result', () => {
      initTurnLog('g', 'p', 1);

      const chosen: FeasibleOption = {
        action: AIActionType.BuildTrack,
        feasible: true,
        reason: 'expand network',
        score: 100,
        targetCity: 'Paris',
        segments: [],
        estimatedCost: 15,
      };

      const result: ExecutionResult = {
        success: true,
        action: AIActionType.BuildTrack,
        cost: 14,
        segmentsBuilt: 5,
        remainingMoney: 36,
        durationMs: 25,
      };

      logPhase('Phase 2', [chosen], chosen, result);

      const phase = getCurrentLog()!.phases[0];
      expect(phase.chosen).not.toBeNull();
      expect(phase.chosen!.action).toBe(AIActionType.BuildTrack);
      expect(phase.chosen!.targetCity).toBe('Paris');
      expect(phase.result).not.toBeNull();
      expect(phase.result!.success).toBe(true);
      expect(phase.result!.cost).toBe(14);
      expect(phase.result!.remainingMoney).toBe(36);
    });

    it('records delivery load options with payment', () => {
      initTurnLog('g', 'p', 1);

      const option: FeasibleOption = {
        action: AIActionType.DeliverLoad,
        feasible: true,
        reason: 'demand matched',
        score: 200,
        targetCity: 'Roma',
        loadType: 'Wine' as any,
        payment: 15,
        cardId: 42,
      };

      logPhase('Phase 0', [option], option, null);

      const logged = getCurrentLog()!.phases[0].options[0];
      expect(logged.loadType).toBe('Wine');
      expect(logged.payment).toBe(15);
    });

    it('accumulates multiple phases', () => {
      initTurnLog('g', 'p', 1);
      logPhase('Phase 0', [], null, null);
      logPhase('Phase 1', [], null, null);
      logPhase('Phase 1.5', [], null, null);
      logPhase('Phase 2', [], null, null);

      expect(getCurrentLog()!.phases).toHaveLength(4);
      expect(getCurrentLog()!.phases.map(p => p.phase)).toEqual([
        'Phase 0', 'Phase 1', 'Phase 1.5', 'Phase 2',
      ]);
    });
  });

  describe('flushTurnLog', () => {
    it('clears the current log', () => {
      initTurnLog('g', 'p', 1);
      expect(getCurrentLog()).not.toBeNull();
      flushTurnLog();
      expect(getCurrentLog()).toBeNull();
    });

    it('does nothing when no log exists', () => {
      expect(() => flushTurnLog()).not.toThrow();
    });

    it('outputs JSON to console when enabled', () => {
      setOutputEnabled(true);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      initTurnLog('g', 'p', 1);
      logPhase('Phase 0', [], null, null);
      flushTurnLog();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[DecisionLog]');
      const jsonPart = output.replace('[DecisionLog] ', '');
      const parsed = JSON.parse(jsonPart) as TurnDecisionLog;
      expect(parsed.gameId).toBe('g');
      expect(parsed.phases).toHaveLength(1);

      consoleSpy.mockRestore();
      setOutputEnabled(false);
    });

    it('does not output when disabled', () => {
      setOutputEnabled(false);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      initTurnLog('g', 'p', 1);
      flushTurnLog();

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('getCurrentLog', () => {
    it('returns null before initialization', () => {
      expect(getCurrentLog()).toBeNull();
    });

    it('returns the live log object (not a copy)', () => {
      initTurnLog('g', 'p', 1);
      const log1 = getCurrentLog();
      logPhase('Phase 0', [], null, null);
      const log2 = getCurrentLog();
      // Same reference
      expect(log1).toBe(log2);
      expect(log1!.phases).toHaveLength(1);
    });
  });

  describe('setOutputEnabled', () => {
    it('toggles output on and off', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      setOutputEnabled(false);
      initTurnLog('g', 'p', 1);
      flushTurnLog();
      expect(consoleSpy).not.toHaveBeenCalled();

      setOutputEnabled(true);
      initTurnLog('g', 'p', 2);
      flushTurnLog();
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
      setOutputEnabled(false);
    });
  });

  describe('summarizeOption edge cases', () => {
    it('handles infeasible options', () => {
      initTurnLog('g', 'p', 1);

      const option: FeasibleOption = {
        action: AIActionType.BuildTrack,
        feasible: false,
        reason: 'insufficient funds',
        score: 0,
      };

      logPhase('Phase 2', [option], null, null);

      const logged = getCurrentLog()!.phases[0].options[0];
      expect(logged.feasible).toBe(false);
      expect(logged.reason).toBe('insufficient funds');
      expect(logged.targetCity).toBeUndefined();
    });

    it('handles PassTurn option', () => {
      initTurnLog('g', 'p', 1);

      const option: FeasibleOption = {
        action: AIActionType.PassTurn,
        feasible: true,
        reason: 'Fallback after retries',
      };

      logPhase('Phase 2', [option], option, {
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 50,
        durationMs: 1,
      });

      const phase = getCurrentLog()!.phases[0];
      expect(phase.chosen!.action).toBe(AIActionType.PassTurn);
      expect(phase.result!.cost).toBe(0);
    });

    it('handles UpgradeTrain option', () => {
      initTurnLog('g', 'p', 1);

      const option: FeasibleOption = {
        action: AIActionType.UpgradeTrain,
        feasible: true,
        reason: 'upgrade available',
        score: 50,
        targetTrainType: 'fast_freight' as any,
      };

      logPhase('Phase 2', [option], option, null);

      const logged = getCurrentLog()!.phases[0].options[0];
      // targetTrainType is not in LoggedOption — it's excluded by summarizeOption
      expect(logged.action).toBe(AIActionType.UpgradeTrain);
    });
  });
});
