/**
 * BotTurnTrigger — Detects bot turns and orchestrates execution.
 *
 * Stateless module with exported functions (not a class).
 * Called from emitTurnChange() as a side effect after turn:change emission.
 */

/** Feature flag: defaults to true if unset */
function isAIBotsEnabled(): boolean {
  const value = process.env.ENABLE_AI_BOTS;
  if (value === undefined || value === '') return true;
  return value.toLowerCase() !== 'false';
}

// Log flag status once at module load
console.log(`[BotTurnTrigger] ENABLE_AI_BOTS=${isAIBotsEnabled() ? 'true' : 'false'}`);

/** Guard set to prevent double-execution of bot turns per game */
const pendingBotTurns = new Set<string>();

/** Queued turns for games where no human is connected */
interface QueuedTurn {
  gameId: string;
  currentPlayerIndex: number;
  currentPlayerId: string;
}
const queuedBotTurns = new Map<string, QueuedTurn>();

/**
 * Called after emitTurnChange() to detect and execute bot turns.
 * Returns immediately if ENABLE_AI_BOTS is false.
 */
export async function onTurnChange(
  gameId: string,
  currentPlayerIndex: number,
  currentPlayerId: string,
): Promise<void> {
  if (!isAIBotsEnabled()) return;

  // TODO: Query player is_bot, guard against double execution, delay, execute PassTurn
}

/**
 * Dequeue and execute a pending bot turn when a human reconnects.
 */
export async function onHumanReconnect(gameId: string): Promise<void> {
  if (!isAIBotsEnabled()) return;

  const queued = queuedBotTurns.get(gameId);
  if (!queued) return;

  queuedBotTurns.delete(gameId);
  await onTurnChange(queued.gameId, queued.currentPlayerIndex, queued.currentPlayerId);
}

/**
 * Phase-aware turn advancement after a bot completes its turn.
 */
export async function advanceTurnAfterBot(gameId: string): Promise<void> {
  // TODO: Route to InitialBuildService.advanceTurn() or PlayerService.updateCurrentPlayerIndex()
}

export { isAIBotsEnabled, pendingBotTurns, queuedBotTurns };
