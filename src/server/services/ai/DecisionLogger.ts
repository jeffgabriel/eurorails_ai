/**
 * DecisionLogger — Captures structured logs of AI bot decisions per turn.
 *
 * Records all options generated, scored, validated, and executed for each
 * phase of a bot turn. Outputs a complete TurnDecisionLog as JSON to console
 * at the end of each turn for debugging and post-game analysis.
 *
 * Module-level state — one active log at a time (bot turns are sequential).
 */

import {
  FeasibleOption,
  AIActionType,
  TurnDecisionLog,
  PhaseDecisionLog,
  LoggedOption,
} from '../../../shared/types/GameTypes';
import { ExecutionResult } from './TurnExecutor';

let currentLog: TurnDecisionLog | null = null;

/** Whether to output logs. Enabled by default; tests can disable. */
let outputEnabled = true;

/**
 * Simplify a FeasibleOption to a LoggedOption for compact logging.
 */
function summarizeOption(option: FeasibleOption): LoggedOption {
  return {
    action: option.action,
    score: option.score,
    feasible: option.feasible,
    reason: option.reason,
    targetCity: option.targetCity,
    loadType: option.loadType as string | undefined,
    payment: option.payment,
  };
}

/**
 * Initialize logging for a new bot turn. Must be called at the start
 * of AIStrategyEngine.takeTurn(). Clears any previous turn's log.
 */
export function initTurnLog(gameId: string, playerId: string, turn: number): void {
  currentLog = {
    gameId,
    playerId,
    turn,
    phases: [],
  };
}

/**
 * Log a decision phase. Called after each major phase (0, 1, 1.5, 2)
 * in AIStrategyEngine.takeTurn().
 *
 * @param phase - Phase name (e.g., "Phase 0", "Phase 1", "Phase 1.5", "Phase 2")
 * @param options - All options generated and scored for this phase
 * @param chosen - The option that was selected for execution (null if none)
 * @param result - The execution result (null if no action executed)
 */
export function logPhase(
  phase: string,
  options: FeasibleOption[],
  chosen: FeasibleOption | null,
  result: ExecutionResult | null,
): void {
  if (!currentLog) return;

  const phaseLog: PhaseDecisionLog = {
    phase,
    options: options.map(summarizeOption),
    chosen: chosen ? summarizeOption(chosen) : null,
    result: result ? {
      success: result.success,
      action: result.action,
      cost: result.cost,
      remainingMoney: result.remainingMoney,
    } : null,
  };

  currentLog.phases.push(phaseLog);
}

/**
 * Output the complete turn log as structured JSON and clear internal state.
 * Called at the end of AIStrategyEngine.takeTurn().
 */
export function flushTurnLog(): void {
  if (!currentLog) return;

  if (outputEnabled) {
    console.log(`[DecisionLog] ${JSON.stringify(currentLog)}`);
  }

  currentLog = null;
}

/**
 * Get the current in-progress turn log (for testing).
 */
export function getCurrentLog(): TurnDecisionLog | null {
  return currentLog;
}

/**
 * Enable or disable log output. Useful for suppressing console noise in tests.
 */
export function setOutputEnabled(enabled: boolean): void {
  outputEnabled = enabled;
}
