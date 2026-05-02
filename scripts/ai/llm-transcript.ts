/**
 * LLM Transcript Reader — Pretty-print LLM interactions from NDJSON game logs.
 *
 * Strips away game state noise and shows only the bot's decision-making flow:
 * strategy calls, trip planning, build advisor, validation, and errors.
 *
 * Usage: npx tsx scripts/llm-transcript.ts <game-id> [options]
 *   --player <name>    Filter to a single bot
 *   --turns <range>    Filter to turn range (e.g., "5-15" or "10")
 *   --no-prompts       Hide system/user prompts (default)
 *   --full-prompts     Show full system/user prompts
 *   --out <file>       Write to file instead of stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadNdjsonLog, parseTurnRange, fmt, secs, loc, isLlmModel } from '../src/server/services/logParser';
import { GameTurnLogEntry } from '../src/server/services/ai/GameLogger';

type TurnEntry = GameTurnLogEntry & {
  model?: string;
  llmLog?: Array<{ attemptNumber: number; status: string; responseText: string; error?: string; latencyMs: number }>;
  systemPrompt?: string;
  userPrompt?: string;
};

function formatTurn(entry: TurnEntry, showFullPrompts: boolean): string {
  const lines: string[] = [];
  const name = entry.playerName ?? entry.playerId;
  const phase = entry.gamePhase ?? '';
  const cash = entry.cash != null ? `Cash: ${entry.cash}M` : '';
  const train = entry.train ? `Train: ${entry.train}` : '';
  const header = [`Turn ${entry.turn}`, name, phase, cash, train].filter(Boolean).join(' | ');

  lines.push(`── ${header} ──`);

  // Context line
  const start = loc(entry.positionStart);
  const end = loc(entry.positionEnd);
  const loads = entry.carriedLoads?.length ? `Carrying: [${entry.carriedLoads.join(', ')}]` : 'Empty';
  const cities = entry.connectedMajorCities?.length ? `Cities: ${entry.connectedMajorCities.join(', ')}` : '';
  lines.push(`   ${start} → ${end} | ${loads}${cities ? ` | ${cities}` : ''}`);

  // Strategy LLM call
  const model = entry.model ?? 'unknown';
  if (isLlmModel(model)) {
    const lat = entry.llmLatencyMs ? secs(entry.llmLatencyMs) : '?';
    const tok = entry.tokenUsage ? `${fmt(entry.tokenUsage.input)} in / ${fmt(entry.tokenUsage.output)} out` : '';
    lines.push('');
    lines.push(`   [STRATEGY] ${model} | ${lat}${tok ? ` | ${tok}` : ''}`);
  } else {
    lines.push('');
    lines.push(`   [${model.toUpperCase().replace(/-/g, ' ')}]`);
  }

  lines.push(`   Action: ${entry.action}`);
  if (entry.reasoning) {
    lines.push(`   Reasoning: ${entry.reasoning}`);
  }
  if (entry.planHorizon) {
    lines.push(`   Plan: ${entry.planHorizon}`);
  }
  if (entry.guardrailOverride) {
    lines.push(`   ⚠ Guardrail override: ${entry.guardrailReason ?? 'unknown reason'}`);
  }

  // JIRA-148: Initial build planner evaluated options
  if (entry.initialBuildOptions && entry.initialBuildOptions.length > 0) {
    lines.push('');
    lines.push(`   [INITIAL BUILD OPTIONS] ${entry.initialBuildOptions.length} evaluated:`);
    for (const o of entry.initialBuildOptions) {
      const pen = o.penalized ? ' [PENALIZED]' : '';
      lines.push(`     #${o.rank} ${o.loadType} ${o.supplyCity}→${o.deliveryCity} from ${o.startingCity}: eff=${o.efficiency} pay=${o.payout}M build=${o.totalBuildCost}M (supply=${o.buildCostToSupply}M deliver=${o.buildCostSupplyToDelivery}M) ~${o.estimatedTurns}T${pen}`);
    }
  }

  // Full prompts if requested
  if (showFullPrompts) {
    if (entry.systemPrompt) {
      lines.push('');
      lines.push(`   [SYSTEM PROMPT] (${fmt(entry.systemPrompt.length)} chars)`);
      for (const line of entry.systemPrompt.split('\n')) {
        lines.push(`   │ ${line}`);
      }
    }
    if (entry.userPrompt) {
      lines.push('');
      lines.push(`   [USER PROMPT] (${fmt(entry.userPrompt.length)} chars)`);
      for (const line of entry.userPrompt.split('\n')) {
        lines.push(`   │ ${line}`);
      }
    }
  }

  // Retries / errors from llmLog
  if (entry.llmLog && entry.llmLog.length > 1) {
    const failures = entry.llmLog.filter(a => a.status !== 'success');
    if (failures.length > 0) {
      lines.push('');
      lines.push(`   [RETRIES] ${entry.llmLog.length} attempts, ${failures.length} failed`);
      for (const attempt of failures) {
        lines.push(`     #${attempt.attemptNumber}: ${attempt.status}${attempt.error ? ` — ${attempt.error}` : ''} (${secs(attempt.latencyMs)})`);
      }
    }
  }

  // Trip Planner
  if (entry.tripPlanning) {
    const tp = entry.tripPlanning;
    const lat = secs(tp.llmLatencyMs);
    const tok = `${fmt(tp.llmTokens.input)} in / ${fmt(tp.llmTokens.output)} out`;
    lines.push('');
    lines.push(`   [TRIP PLANNER] ${lat} | ${tok}`);
    lines.push(`   Trigger: ${tp.trigger}`);
    // JIRA-210B: single-route shape. Backward-compat via optional-chain for historical logs.
    const stopsArr: string[] | undefined =
      tp.stops ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((tp as any).candidates?.[(tp as any).chosen]?.stops as string[] | undefined);
    if (stopsArr && stopsArr.length > 0) {
      lines.push(`   Route: ${stopsArr.join('→')}`);
    }
    if (tp.llmReasoning) {
      lines.push(`   Reasoning: ${tp.llmReasoning}`);
    }
  }

  // Build Advisor
  if (entry.advisorAction) {
    lines.push('');
    const lat = entry.advisorLatencyMs ? ` ${secs(entry.advisorLatencyMs)}` : '';
    lines.push(`   [BUILD ADVISOR]${lat}`);
    lines.push(`   Action: ${entry.advisorAction}`);
    if (entry.advisorReasoning) {
      lines.push(`   Reasoning: ${entry.advisorReasoning}`);
    }
    if (entry.solvencyRetries && entry.solvencyRetries > 0) {
      lines.push(`   Solvency retries: ${entry.solvencyRetries}`);
    }
  }

  // Secondary Delivery
  if (entry.secondaryDelivery && entry.secondaryDelivery.action !== 'none') {
    const sd = entry.secondaryDelivery;
    lines.push('');
    lines.push(`   [SECONDARY DELIVERY] ${sd.action}`);
    if (sd.loadType && sd.deliveryCity) {
      lines.push(`   ${sd.loadType} → ${sd.deliveryCity}`);
    }
    if (sd.reasoning) {
      lines.push(`   Reasoning: ${sd.reasoning}`);
    }
  }

  // Turn Validation
  if (entry.turnValidation) {
    const tv = entry.turnValidation;
    const icon = tv.outcome === 'passed' ? '✓' : '✗';
    const recomp = tv.recomposeCount > 0 ? ` (${tv.recomposeCount} recompositions)` : '';
    lines.push('');
    lines.push(`   [VALIDATION] ${icon} ${tv.outcome}${recomp}`);
    if (tv.outcome === 'hard_reject') {
      const failed = tv.hardGates.filter(g => !g.passed);
      for (const gate of failed) {
        lines.push(`     FAILED: ${gate.gate}${gate.detail ? ` — ${gate.detail}` : ''}`);
      }
    }
  }

  // Execution results (compact)
  const results: string[] = [];
  if (entry.loadsPickedUp?.length) {
    results.push(`picked up: ${entry.loadsPickedUp.map(l => `${l.loadType}@${l.city}`).join(', ')}`);
  }
  if (entry.loadsDelivered?.length) {
    results.push(`delivered: ${entry.loadsDelivered.map(l => `${l.loadType}→${l.city} (+${l.payment}M)`).join(', ')}`);
  }
  if (entry.segmentsBuilt > 0) {
    results.push(`built: ${entry.segmentsBuilt} segments (${entry.cost}M)`);
  }
  if (entry.trackUsageFee && entry.trackUsageFee > 0) {
    results.push(`track fee: ${entry.trackUsageFee}M`);
  }
  if (entry.milepostsMoved) {
    results.push(`moved: ${entry.milepostsMoved} mileposts`);
  }
  if (results.length > 0) {
    lines.push('');
    lines.push(`   → ${results.join(' | ')}`);
  }

  // Error
  if (!entry.success && entry.error) {
    lines.push('');
    lines.push(`   ✗ ERROR: ${entry.error}`);
  }

  return lines.join('\n');
}

function run(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: npx tsx scripts/llm-transcript.ts <game-id> [options]');
    console.log('  --player <name>    Filter to a single bot');
    console.log('  --turns <range>    Filter to turn range (e.g., "5-15" or "10")');
    console.log('  --no-prompts       Hide system/user prompts (default)');
    console.log('  --full-prompts     Show full system/user prompts');
    console.log('  --out <file>       Write to file instead of stdout');
    process.exit(0);
  }

  const gameId = args[0];
  let playerFilter: string | null = null;
  let turnRange: { min: number; max: number } | null = null;
  let showFullPrompts = false;
  let outFile: string | null = null;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--player': playerFilter = args[++i]; break;
      case '--turns': turnRange = parseTurnRange(args[++i]); break;
      case '--full-prompts': showFullPrompts = true; break;
      case '--no-prompts': showFullPrompts = false; break;
      case '--out': outFile = args[++i]; break;
    }
  }

  // Find log file
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    console.error(`No logs directory found at ${logsDir}`);
    process.exit(1);
  }
  const logFile = fs.readdirSync(logsDir).find(f => f.includes(gameId) && f.endsWith('.ndjson'));
  if (!logFile) {
    console.error(`No log found for game ${gameId}`);
    console.error('Available logs:');
    fs.readdirSync(logsDir).filter(f => f.endsWith('.ndjson')).forEach(f => console.error(`  ${f}`));
    process.exit(1);
  }

  let entries = loadNdjsonLog<TurnEntry>(path.join(logsDir, logFile));

  // Apply filters
  if (playerFilter) {
    const pf = playerFilter.toLowerCase();
    entries = entries.filter(e => (e.playerName ?? e.playerId).toLowerCase().includes(pf));
  }
  if (turnRange) {
    entries = entries.filter(e => e.turn >= turnRange!.min && e.turn <= turnRange!.max);
  }

  if (entries.length === 0) {
    console.error('No matching turns found.');
    process.exit(1);
  }

  // Aggregate stats
  let totalLlmCalls = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let totalRetries = 0;
  let totalFailures = 0;

  for (const e of entries) {
    if (isLlmModel(e.model)) {
      totalLlmCalls++;
      if (e.tokenUsage) { totalTokensIn += e.tokenUsage.input; totalTokensOut += e.tokenUsage.output; }
      if (e.llmLatencyMs) { totalLatency += e.llmLatencyMs; latencyCount++; }
    }
    if (e.tripPlanning) {
      totalLlmCalls++;
      totalTokensIn += e.tripPlanning.llmTokens.input;
      totalTokensOut += e.tripPlanning.llmTokens.output;
      totalLatency += e.tripPlanning.llmLatencyMs;
      latencyCount++;
    }
    if (e.advisorLatencyMs) {
      totalLlmCalls++;
      totalLatency += e.advisorLatencyMs;
      latencyCount++;
    }
    if (e.llmLog) {
      const failures = e.llmLog.filter(a => a.status !== 'success');
      if (e.llmLog.length > 1) totalRetries += e.llmLog.length - 1;
      totalFailures += failures.length;
    }
  }

  // Build output
  const output: string[] = [];
  const players = [...new Set(entries.map(e => e.playerName ?? e.playerId))];
  const models = [...new Set(entries.map(e => e.model).filter(Boolean))];

  output.push('══════════════════════════════════════════════════════════');
  output.push(` Game: ${gameId} | ${entries.length} turns | ${players.join(', ')}`);
  output.push(` Models: ${models.join(', ')}`);
  output.push('══════════════════════════════════════════════════════════');
  output.push('');

  for (const entry of entries) {
    output.push(formatTurn(entry, showFullPrompts));
    output.push('');
  }

  output.push('══════════════════════════════════════════════════════════');
  const avgLat = latencyCount > 0 ? secs(totalLatency / latencyCount) : 'N/A';
  output.push(` ${entries.length} turns | ${totalLlmCalls} LLM calls | ${fmt(totalTokensIn)} tokens in / ${fmt(totalTokensOut)} out`);
  output.push(` Avg latency: ${avgLat} | Retries: ${totalRetries} | Failures: ${totalFailures}`);
  output.push('══════════════════════════════════════════════════════════');

  const text = output.join('\n');

  if (outFile) {
    fs.writeFileSync(outFile, text, 'utf8');
    console.log(`Written to ${outFile}`);
  } else {
    console.log(text);
  }
}

run();
