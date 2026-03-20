#!/usr/bin/env npx ts-node
/**
 * Analyse Build Advisor quality from an NDJSON game log.
 *
 * Focuses on: when the advisor is called, does it produce good recommendations?
 * Tracks advisor success/failure/fallback, JSON parse errors, reasoning quality,
 * and correlates advisor recommendations with build outcomes.
 *
 * Usage: npx ts-node scripts/analyse-build-advisor.ts <game-log-path>
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ──

interface AdvisorData {
  action: string | null;
  reasoning: string | null;
  waypoints: [number, number][];
  solvencyRetries: number;
  latencyMs: number;
  fallback: boolean;
  rawResponse?: string;
  error?: string;
  extractionUsed?: boolean;
  extractionLatencyMs?: number;
  extractionError?: string;
}

interface GameEvent {
  turn: number;
  playerId: string;
  playerName: string;
  action: string;
  reasoning: string;
  model: string;
  cash: number;
  cost?: number;
  segmentsBuilt?: number;
  buildTargetCity?: string;
  connectedMajorCities?: string[];
  gamePhase?: string;
  train?: string;
  advisorLatencyMs?: number;
  solvencyRetries?: number;
  composition?: {
    build?: {
      target: string | null;
      cost: number;
      skipped: boolean;
      upgradeConsidered: boolean;
    };
    advisor?: AdvisorData;
    a3?: { movePreprended: boolean; skipped?: boolean; reason?: string };
  };
  activeRoute?: {
    stops: Array<{ action: string; loadType: string; city: string }>;
    currentStopIndex: number;
  };
  loadsPickedUp?: string[];
  carriedLoads?: string[];
}

// ── Analysis types ──

interface AdvisorCall {
  turn: number;
  player: string;
  latencyMs: number;
  outcome: 'success' | 'fallback' | 'null' | 'error';
  errorMessage?: string;
  rawResponseSnippet?: string;
  reasoning?: string;
  waypoints: [number, number][];
  solvencyRetries: number;
  // Extraction diagnostics
  extractionUsed: boolean;
  extractionLatencyMs?: number;
  extractionError?: string;
  // Build context
  didBuild: boolean;
  buildTarget?: string;
  buildCost?: number;
  cash: number;
  routeStops: string[];
  routeCurrentIdx: number;
  gamePhase: string;
  model: string;
}

interface AdvisorOutcomeGroup {
  calls: AdvisorCall[];
  buildCostTotal: number;
  buildCount: number;
}

// ── Main ──

function main(): void {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error('Usage: npx ts-node scripts/analyse-build-advisor.ts <game-log-path>');
    process.exit(1);
  }

  const fullPath = path.resolve(logPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(fullPath, 'utf-8').trim().split('\n');
  const events: GameEvent[] = lines.map(line => JSON.parse(line));

  const advisorCalls: AdvisorCall[] = [];
  const buildTurnsWithoutAdvisor: GameEvent[] = [];
  const allBuilds: GameEvent[] = [];

  // Track delivery outcomes per player to correlate with builds
  const playerDeliveries: Record<string, Array<{ turn: number; city: string; load: string }>> = {};
  const playerBuildSpend: Record<string, number> = {};
  const playerDeliveryIncome: Record<string, number> = {};

  for (const ev of events) {
    const player = ev.playerName;
    if (!playerBuildSpend[player]) playerBuildSpend[player] = 0;
    if (!playerDeliveryIncome[player]) playerDeliveryIncome[player] = 0;
    if (!playerDeliveries[player]) playerDeliveries[player] = [];

    const advisor = ev.composition?.advisor;
    const route = ev.activeRoute;
    const stops = route?.stops?.map(s => `${s.action}(${s.loadType}@${s.city})`) ?? [];
    const currentIdx = route?.currentStopIndex ?? 0;

    // Track advisor calls (present when latencyMs > 0)
    if (advisor && advisor.latencyMs > 0) {
      let outcome: AdvisorCall['outcome'];
      if (advisor.error) {
        outcome = 'error';
      } else if (advisor.fallback) {
        outcome = 'fallback';
      } else if (advisor.action) {
        outcome = 'success';
      } else {
        outcome = 'null';
      }

      advisorCalls.push({
        turn: ev.turn,
        player,
        latencyMs: advisor.latencyMs,
        outcome,
        errorMessage: advisor.error,
        rawResponseSnippet: advisor.rawResponse?.substring(0, 200),
        reasoning: advisor.reasoning?.substring(0, 300) ?? undefined,
        waypoints: advisor.waypoints ?? [],
        solvencyRetries: advisor.solvencyRetries ?? 0,
        extractionUsed: advisor.extractionUsed ?? false,
        extractionLatencyMs: advisor.extractionLatencyMs,
        extractionError: advisor.extractionError,
        didBuild: ev.action === 'BuildTrack',
        buildTarget: ev.buildTargetCity ?? ev.composition?.build?.target ?? undefined,
        buildCost: ev.cost,
        cash: ev.cash,
        routeStops: stops,
        routeCurrentIdx: currentIdx,
        gamePhase: ev.gamePhase ?? '?',
        model: ev.model,
      });
    }

    if (ev.action === 'BuildTrack') {
      allBuilds.push(ev);
      playerBuildSpend[player] += ev.cost ?? 0;
      if (!advisor || advisor.latencyMs === 0) {
        buildTurnsWithoutAdvisor.push(ev);
      }
    }
  }

  // ── Report ──

  const gameId = path.basename(fullPath, '.ndjson').replace('game-', '');
  const totalTurns = events.length;

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  BUILD ADVISOR ANALYSIS — Game ${gameId}`);
  console.log(`  ${totalTurns} events, ${allBuilds.length} builds, ${advisorCalls.length} advisor calls`);
  console.log(`${'═'.repeat(72)}\n`);

  // ── 1. Advisor engagement rate ──
  console.log('─── 1. ADVISOR ENGAGEMENT ───\n');
  const advisorBuilds = advisorCalls.filter(c => c.didBuild);
  const advisorNonBuilds = advisorCalls.filter(c => !c.didBuild);
  console.log(`  Builds with advisor:    ${advisorBuilds.length}/${allBuilds.length} (${pct(advisorBuilds.length, allBuilds.length)})`);
  console.log(`  Builds without advisor: ${buildTurnsWithoutAdvisor.length}/${allBuilds.length} (${pct(buildTurnsWithoutAdvisor.length, allBuilds.length)})`);
  console.log(`  Advisor called but no build: ${advisorNonBuilds.length}`);
  console.log();

  // Per-player
  const players = [...new Set(events.map(e => e.playerName))];
  for (const p of players) {
    const pBuilds = allBuilds.filter(b => b.playerName === p);
    const pAdvisorBuilds = advisorBuilds.filter(c => c.player === p);
    const pNonAdvisorBuilds = buildTurnsWithoutAdvisor.filter(b => b.playerName === p);
    console.log(`  ${p}: ${pAdvisorBuilds.length}/${pBuilds.length} builds advised (${pct(pAdvisorBuilds.length, pBuilds.length)}), ${pNonAdvisorBuilds.length} unadvised`);
  }

  // ── 2. Advisor outcome breakdown ──
  console.log(`\n─── 2. ADVISOR OUTCOMES ───\n`);
  const byOutcome = groupBy(advisorCalls, c => c.outcome);
  for (const [outcome, calls] of Object.entries(byOutcome)) {
    const avgLat = Math.round(calls.reduce((s, c) => s + c.latencyMs, 0) / calls.length);
    console.log(`  ${outcome.toUpperCase()}: ${calls.length} calls (avg ${avgLat}ms)`);
  }
  console.log();

  // Per-player outcome breakdown
  for (const p of players) {
    const pCalls = advisorCalls.filter(c => c.player === p);
    if (pCalls.length === 0) continue;
    const pByOutcome = groupBy(pCalls, c => c.outcome);
    const parts = Object.entries(pByOutcome).map(([o, cs]) => `${o}=${cs.length}`).join(', ');
    console.log(`  ${p}: ${pCalls.length} calls — ${parts}`);
  }

  // ── 3. Error analysis ──
  const errors = advisorCalls.filter(c => c.outcome === 'error');
  const fallbacks = advisorCalls.filter(c => c.outcome === 'fallback');
  if (errors.length > 0 || fallbacks.length > 0) {
    console.log(`\n─── 3. ERRORS & FALLBACKS ───\n`);

    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}):`);
      const errorTypes = groupBy(errors, c => c.errorMessage ?? 'unknown');
      for (const [msg, cs] of Object.entries(errorTypes)) {
        console.log(`    "${msg}" — ${cs.length} occurrences`);
        for (const c of cs.slice(0, 3)) {
          console.log(`      T${c.turn} ${c.player}: rawResponse="${c.rawResponseSnippet}"`);
        }
      }
    }

    if (fallbacks.length > 0) {
      console.log(`\n  Fallbacks (${fallbacks.length}):`);
      for (const c of fallbacks) {
        console.log(`    T${c.turn} ${c.player}: target=${c.buildTarget ?? '?'}, cost=${c.buildCost ?? 0}M, cash=${c.cash}M`);
        if (c.rawResponseSnippet) {
          console.log(`      rawResponse="${c.rawResponseSnippet}"`);
        }
      }
    }
  }

  // ── 4. Successful advisor calls — quality assessment ──
  const successes = advisorCalls.filter(c => c.outcome === 'success');
  if (successes.length > 0) {
    console.log(`\n─── 4. SUCCESSFUL ADVISOR CALLS (${successes.length}) ───\n`);
    for (const c of successes) {
      const waypointsStr = c.waypoints.length > 0
        ? c.waypoints.map(w => `(${w[0]},${w[1]})`).join(' → ')
        : 'none';
      console.log(`  T${c.turn} ${c.player}: target=${c.buildTarget ?? '?'}, cost=${c.buildCost ?? 0}M, cash=${c.cash}M`);
      console.log(`    waypoints: ${waypointsStr}`);
      console.log(`    solvencyRetries: ${c.solvencyRetries}`);
      console.log(`    route: [${c.routeStops.join(', ')}] @idx=${c.routeCurrentIdx}`);
      if (c.reasoning) {
        console.log(`    reasoning: "${c.reasoning}"`);
      }
      console.log();
    }
  }

  // ── 5. Solvency retry analysis ──
  const withRetries = advisorCalls.filter(c => c.solvencyRetries > 0);
  console.log(`─── 5. SOLVENCY RETRIES ───\n`);
  if (withRetries.length === 0) {
    console.log(`  No solvency retries in any advisor call.`);
    console.log(`  This means either:`);
    console.log(`    a) Advisor always recommends affordable builds, OR`);
    console.log(`    b) Solvency check is not triggering when it should`);
    console.log();
    // Show advisor builds where cost is high relative to cash
    const tightBudget = advisorBuilds.filter(c => c.buildCost && c.cash < c.buildCost * 2);
    if (tightBudget.length > 0) {
      console.log(`  Advisor builds where cash < 2x build cost (solvency should have been tight):`);
      for (const c of tightBudget) {
        console.log(`    T${c.turn} ${c.player}: cost=${c.buildCost}M, cash=${c.cash}M (ratio=${(c.cash / (c.buildCost || 1)).toFixed(1)}x)`);
      }
    }
  } else {
    for (const c of withRetries) {
      console.log(`  T${c.turn} ${c.player}: ${c.solvencyRetries} retries, cost=${c.buildCost}M, cash=${c.cash}M`);
    }
  }

  // ── 6. Builds WITHOUT advisor — what's going on? ──
  console.log(`\n─── 6. BUILDS WITHOUT ADVISOR (${buildTurnsWithoutAdvisor.length}) ───\n`);
  const byPhase = groupBy(buildTurnsWithoutAdvisor, b => b.gamePhase ?? '?');
  for (const [phase, bs] of Object.entries(byPhase)) {
    console.log(`  ${phase}: ${bs.length} builds`);
  }
  console.log();
  const byModel = groupBy(buildTurnsWithoutAdvisor, b => b.model);
  for (const [model, bs] of Object.entries(byModel)) {
    const totalCost = bs.reduce((s, b) => s + (b.cost ?? 0), 0);
    console.log(`  ${model}: ${bs.length} builds, ${totalCost}M total cost`);
  }
  console.log();
  // Show the worst unadvised builds (highest cost)
  const sortedUnadvised = [...buildTurnsWithoutAdvisor].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  console.log('  Top 10 most expensive unadvised builds:');
  for (const b of sortedUnadvised.slice(0, 10)) {
    const route = b.activeRoute;
    const stops = route?.stops?.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ') ?? 'none';
    console.log(`    T${b.turn} ${b.playerName}: ${b.buildTargetCity ?? '?'} (${b.cost}M) cash=${b.cash}M model=${b.model}`);
    console.log(`      route: ${stops}`);
    console.log(`      reasoning: "${(b.reasoning ?? '').substring(0, 150)}"`);
  }

  // ── 7. Advisor bypassed: why? ──
  console.log(`\n─── 7. WHY IS ADVISOR BYPASSED? ───\n`);
  console.log('  Builds without advisor, grouped by decision model and game phase:');
  for (const b of buildTurnsWithoutAdvisor) {
    const hasComposition = !!b.composition;
    const buildTrace = b.composition?.build;
    const skipped = buildTrace?.skipped;
    // Determine bypass reason
    let reason = 'unknown';
    if (b.gamePhase === 'Initial Build') reason = 'initial-build-phase';
    else if (!hasComposition) reason = 'no-composition-trace';
    else if (buildTrace && !b.composition?.advisor) reason = 'advisor-not-in-composition';
    else if (b.composition?.advisor && b.composition.advisor.latencyMs === 0) reason = 'advisor-skipped (0ms)';

    (b as any)._bypassReason = reason;
  }
  const byReason = groupBy(buildTurnsWithoutAdvisor, b => (b as any)._bypassReason);
  for (const [reason, bs] of Object.entries(byReason)) {
    const totalCost = bs.reduce((s, b) => s + (b.cost ?? 0), 0);
    console.log(`  ${reason}: ${bs.length} builds, ${totalCost}M total`);
  }

  // ── 8. Summary verdict ──
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  VERDICT');
  console.log(`${'═'.repeat(72)}\n`);

  const totalAdvisorCalls = advisorCalls.length;
  const successRate = pct(successes.length, totalAdvisorCalls);
  const errorRate = pct(errors.length + fallbacks.length, totalAdvisorCalls);
  const advisorCoverage = pct(advisorBuilds.length, allBuilds.length);

  console.log(`  Advisor called on ${advisorCoverage} of builds`);
  console.log(`  When called: ${successRate} success, ${errorRate} error/fallback`);
  console.log(`  Solvency retries: ${withRetries.length} (${pct(withRetries.length, totalAdvisorCalls)} of calls)`);
  console.log(`  JSON parse errors: ${errors.filter(e => e.errorMessage?.includes('JSON')).length}`);

  // Extraction stats
  const extractionAttempts = advisorCalls.filter(c => c.extractionUsed);
  const extractionSuccesses = extractionAttempts.filter(c => !c.extractionError);
  const extractionFailures = extractionAttempts.filter(c => c.extractionError);
  if (extractionAttempts.length > 0) {
    const avgExtractionMs = Math.round(
      extractionAttempts.reduce((s, c) => s + (c.extractionLatencyMs ?? 0), 0) / extractionAttempts.length,
    );
    console.log(`  Extraction fallback used: ${extractionAttempts.length} times`);
    console.log(`    Success: ${extractionSuccesses.length}, Failed: ${extractionFailures.length} (avg ${avgExtractionMs}ms)`);
    if (extractionFailures.length > 0) {
      const errTypes = groupBy(extractionFailures, c => c.extractionError ?? 'unknown');
      for (const [errMsg, cs] of Object.entries(errTypes)) {
        console.log(`    Error: "${errMsg}" — ${cs.length} occurrences`);
      }
    }
  } else {
    console.log(`  Extraction fallback: not used (all pass-1 responses were valid JSON)`);
  }
  console.log();
}

// ── Helpers ──

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round(100 * n / total)}%`;
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

main();
