/**
 * TripCandidateSelector — LLM-backed trip candidate picker.
 *
 * JIRA-217: Given up to 3 pre-scored candidates from MultiDemandTripOptimizer,
 * calls a focused LLM to pick the best one by income velocity. Falls back to
 * the top-EV candidate (index 0) on LLM error or invalid id.
 *
 * Single-candidate skip: if only one candidate is provided, returns it directly
 * without an LLM call.
 */

import {
  BotMemoryState,
  GameContext,
  LlmAttempt,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { TripCandidate } from './MultiDemandTripOptimizer';
import { SELECTOR_SCHEMA } from './schemas';

// ── Types ──────────────────────────────────────────────────────────────

export interface SelectorResult {
  chosenCandidate: TripCandidate;
  rationale: string;
  llmLatencyMs: number;
  llmTokens: { input: number; output: number };
  llmLog: LlmAttempt[];
  fallbackReason?: 'invalid_id' | 'llm_failure' | 'single_candidate';
}

// ── Prompt builder ─────────────────────────────────────────────────────

const SELECTOR_SYSTEM_PROMPT =
  'You are picking a trip for a freight train bot. You will see up to 3 pre-computed candidate trips, ' +
  'each with payout, build cost, turns, and the loads picked up and delivered on the trip. ' +
  'Each load is shown as `loadType @ supplyCity → deliveryCity (payout)`. ' +
  'Pick the trip that best maximizes income velocity. ' +
  'Return JSON: { chosenCandidateId, rationale }.';

/**
 * Build the user prompt for the selector LLM call.
 * Format: candidate rows with payout/build/turns/net plus loads in
 * `loadType @ supplyCity → deliveryCity (payout)` format.
 * Patterns are NOT included — kept as diagnostic-only on TripCandidate.
 */
export function buildSelectorUserPrompt(
  candidates: TripCandidate[],
  snapshot: WorldSnapshot,
  context: GameContext,
): string {
  const trainType = context.trainType;
  const capacity = context.capacity;
  const loads = context.loads;
  const loadStr = loads.length === 0 ? 'empty' : loads.join(', ');
  const positionCity = context.position?.city ?? `(${snapshot.bot.position?.row},${snapshot.bot.position?.col})`;

  const lines: string[] = [
    `Bot: cash ${snapshot.bot.money}M, ${trainType} cap ${capacity}, ${loadStr}, at ${positionCity}.`,
    '',
    'Candidates:',
    '',
  ];

  for (const candidate of candidates) {
    const net = candidate.payoutTotal - candidate.buildCost;
    lines.push(
      `[${candidate.candidateId + 1}] ${candidate.payoutTotal}M payout, ${candidate.buildCost}M build, ${candidate.turns} turns, net ${net}M.`,
    );

    // Build loads line: one entry per demand covered
    const loadEntries = candidate.demandsCovered
      .filter(d => d.supplyCity) // carried-load delivers have empty supplyCity
      .map(d => `${d.loadType} @ ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M)`);

    // Also include carried-load deliver legs (no supplyCity)
    const carriedEntries = candidate.demandsCovered
      .filter(d => !d.supplyCity)
      .map(d => `${d.loadType} [carried] → ${d.deliveryCity} (${d.payout}M)`);

    const allEntries = [...loadEntries, ...carriedEntries];
    if (allEntries.length > 0) {
      lines.push(`    Loads: ${allEntries.join(', ')}.`);
    }
    lines.push('');
  }

  lines.push('Return JSON: { chosenCandidateId, rationale }.');

  return lines.join('\n');
}

// ── TripCandidateSelector ──────────────────────────────────────────────

export class TripCandidateSelector {
  constructor(private readonly brain: LLMStrategyBrain) {}

  /**
   * Select the best candidate from the optimizer's output.
   *
   * - 1 candidate: returned directly with fallbackReason 'single_candidate', no LLM call.
   * - 2-3 candidates: LLM picks by chosenCandidateId (1-based in prompt, 0-based in candidates).
   * - Invalid id: falls back to candidates[0] with fallbackReason 'invalid_id'.
   * - LLM error: falls back to candidates[0] with fallbackReason 'llm_failure'.
   *
   * Caller guarantees candidates.length >= 1.
   */
  async select(
    candidates: TripCandidate[],
    snapshot: WorldSnapshot,
    context: GameContext,
    _memory: BotMemoryState,
  ): Promise<SelectorResult> {
    if (candidates.length === 1) {
      return {
        chosenCandidate: candidates[0],
        rationale: 'Only one candidate available.',
        llmLatencyMs: 0,
        llmTokens: { input: 0, output: 0 },
        llmLog: [],
        fallbackReason: 'single_candidate',
      };
    }

    const userPrompt = buildSelectorUserPrompt(candidates, snapshot, context);
    const llmLog: LlmAttempt[] = [];
    const adapter = this.brain.providerAdapter;
    const model = this.brain.modelName;

    const startMs = Date.now();
    try {
      adapter.setContext({
        gameId: snapshot.gameId,
        playerId: snapshot.bot.playerId,
        playerName: snapshot.bot.botConfig?.name,
        turn: snapshot.turnNumber,
        caller: 'trip-selector',
        method: 'select',
      });

      const response = await adapter.chat({
        model,
        maxTokens: 512,
        temperature: 0.1,
        systemPrompt: SELECTOR_SYSTEM_PROMPT,
        userPrompt,
        outputSchema: SELECTOR_SCHEMA,
        timeoutMs: 15000,
      });

      const latencyMs = Date.now() - startMs;

      // Parse the LLM response
      let parsed: { chosenCandidateId: number; rationale: string };
      try {
        parsed = typeof response.text === 'string'
          ? JSON.parse(response.text)
          : response.text as unknown as { chosenCandidateId: number; rationale: string };
      } catch {
        const err = `JSON parse error: ${String(response.text).substring(0, 200)}`;
        llmLog.push({ attemptNumber: 1, status: 'parse_error', responseText: String(response.text).substring(0, 500), error: err, latencyMs });
        console.warn(`[trip-selector] LLM parse failure, falling back to top-EV: ${err}`);
        return {
          chosenCandidate: candidates[0],
          rationale: '',
          llmLatencyMs: latencyMs,
          llmTokens: response.usage,
          llmLog,
          fallbackReason: 'llm_failure',
        };
      }

      // chosenCandidateId is 1-based in the prompt; map to 0-based index
      const chosenIndex = parsed.chosenCandidateId - 1;

      if (chosenIndex < 0 || chosenIndex >= candidates.length) {
        const err = `chosenCandidateId ${parsed.chosenCandidateId} out of range [1, ${candidates.length}]`;
        llmLog.push({ attemptNumber: 1, status: 'validation_error', responseText: String(response.text).substring(0, 500), error: err, latencyMs });
        console.warn(`[trip-selector] invalid_id fallback: ${err}`);
        return {
          chosenCandidate: candidates[0],
          rationale: parsed.rationale ?? '',
          llmLatencyMs: latencyMs,
          llmTokens: response.usage,
          llmLog,
          fallbackReason: 'invalid_id',
        };
      }

      llmLog.push({ attemptNumber: 1, status: 'success', responseText: String(response.text).substring(0, 500), latencyMs });
      console.log(`[trip-selector] LLM picked candidate #${parsed.chosenCandidateId}, rationale="${parsed.rationale?.substring(0, 80)}"`);

      return {
        chosenCandidate: candidates[chosenIndex],
        rationale: parsed.rationale ?? '',
        llmLatencyMs: latencyMs,
        llmTokens: response.usage,
        llmLog,
      };
    } catch (error) {
      const latencyMs = Date.now() - startMs;
      const err = error instanceof Error ? error.message : String(error);
      llmLog.push({ attemptNumber: 1, status: 'api_error', responseText: '', error: err, latencyMs });
      console.warn(`[trip-selector] LLM call failed, falling back to top-EV: ${err}`);
      return {
        chosenCandidate: candidates[0],
        rationale: '',
        llmLatencyMs: latencyMs,
        llmTokens: { input: 0, output: 0 },
        llmLog,
        fallbackReason: 'llm_failure',
      };
    }
  }
}
