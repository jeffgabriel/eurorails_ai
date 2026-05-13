#!/usr/bin/env npx ts-node
/**
 * Extract track-building data from an NDJSON game log for JIRA-129 analysis.
 *
 * Usage: npx ts-node scripts/extract-build-data.ts <game-log-path>
 *
 * Outputs a condensed JSON report to stdout with:
 * - Per-player build summary (total cost, segments, build turns)
 * - Every build turn with advisor data, targets, costs, and context
 * - Advisor success/failure breakdown
 * - Non-build turns where advisor ran (latency > 0 but no build)
 * - Route context at time of each build decision
 */

import * as fs from 'fs';
import * as path from 'path';

interface AdvisorTrace {
  action: string | null;
  reasoning: string | null;
  waypoints: [number, number][];
  solvencyRetries: number;
  latencyMs: number;
  fallback: boolean;
}

interface BuildEntry {
  turn: number;
  player: string;
  action: string;
  segmentsBuilt: number;
  cost: number;
  cash: number;
  buildTargetCity: string | null;
  connectedMajorCities: string[];
  activeRouteStops: string[];
  activeRouteCurrentStop: number;
  gamePhase: string;
  trainType: string;
  advisor: AdvisorTrace | null;
  compositionBuild: {
    target: string | null;
    cost: number;
    skipped: boolean;
    upgradeConsidered: boolean;
  } | null;
  advisorLatencyMs: number;
  solvencyRetries: number;
  // Top-level advisor fields (post-fix)
  advisorAction: string | null;
  advisorReasoning: string | null;
  advisorWaypoints: [number, number][] | null;
  reasoning: string;
  planHorizon: string;
  model: string;
}

interface SkippedBuildEntry {
  turn: number;
  player: string;
  action: string;
  advisorLatencyMs: number;
  advisorAction: string | null;
  advisorFallback: boolean;
  cash: number;
  buildTargetCity: string | null;
  reasoning: string;
}

interface PlayerSummary {
  totalBuildTurns: number;
  totalSegments: number;
  totalBuildCost: number;
  totalTurns: number;
  advisorCalls: number;
  advisorSuccesses: number;
  advisorFallbacks: number;
  advisorNulls: number;
  advisorTotalLatencyMs: number;
  advisorAvgLatencyMs: number;
  solvencyRetries: number;
  buildTargets: Record<string, number>;
  turnsWithAdvisorButNoBuild: number;
}

function main(): void {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error('Usage: npx ts-node scripts/extract-build-data.ts <game-log-path>');
    process.exit(1);
  }

  const fullPath = path.resolve(logPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(fullPath, 'utf-8').trim().split('\n');
  const entries = lines.map(line => JSON.parse(line));

  const buildEntries: BuildEntry[] = [];
  const skippedBuilds: SkippedBuildEntry[] = [];
  const playerSummaries: Record<string, PlayerSummary> = {};

  for (const entry of entries) {
    const player = entry.playerName ?? '?';

    // Initialize player summary
    if (!playerSummaries[player]) {
      playerSummaries[player] = {
        totalBuildTurns: 0,
        totalSegments: 0,
        totalBuildCost: 0,
        totalTurns: 0,
        advisorCalls: 0,
        advisorSuccesses: 0,
        advisorFallbacks: 0,
        advisorNulls: 0,
        advisorTotalLatencyMs: 0,
        advisorAvgLatencyMs: 0,
        solvencyRetries: 0,
        buildTargets: {},
        turnsWithAdvisorButNoBuild: 0,
      };
    }
    const summary = playerSummaries[player];
    summary.totalTurns++;

    const composition = entry.composition ?? entry.compositionTrace ?? {};
    const advisor: AdvisorTrace | null = composition.advisor ?? null;
    const compositionBuild = composition.build ?? null;
    const advisorLatency = entry.advisorLatencyMs ?? advisor?.latencyMs ?? 0;

    // Track advisor calls regardless of build action
    if (advisor && advisorLatency > 0) {
      summary.advisorCalls++;
      summary.advisorTotalLatencyMs += advisorLatency;
      if (advisor.fallback) {
        summary.advisorFallbacks++;
      } else if (advisor.action) {
        summary.advisorSuccesses++;
      } else {
        summary.advisorNulls++;
      }
      summary.solvencyRetries += advisor.solvencyRetries ?? 0;
    }

    if (entry.action === 'BuildTrack') {
      const route = entry.activeRoute;
      const stops = route?.stops ?? [];

      const be: BuildEntry = {
        turn: entry.turn,
        player,
        action: entry.action,
        segmentsBuilt: entry.segmentsBuilt ?? 0,
        cost: entry.cost ?? 0,
        cash: entry.cash ?? 0,
        buildTargetCity: entry.buildTargetCity ?? compositionBuild?.target ?? null,
        connectedMajorCities: entry.connectedMajorCities ?? [],
        activeRouteStops: stops.map((s: any) => `${s.action}(${s.loadType}@${s.city})`),
        activeRouteCurrentStop: route?.currentStopIndex ?? 0,
        gamePhase: entry.gamePhase ?? '?',
        trainType: entry.train ?? '?',
        advisor,
        compositionBuild,
        advisorLatencyMs: advisorLatency,
        solvencyRetries: entry.solvencyRetries ?? advisor?.solvencyRetries ?? 0,
        advisorAction: entry.advisorAction ?? null,
        advisorReasoning: entry.advisorReasoning ?? null,
        advisorWaypoints: entry.advisorWaypoints ?? null,
        reasoning: (entry.reasoning ?? '').substring(0, 300),
        planHorizon: entry.planHorizon ?? '',
        model: entry.model ?? '?',
      };

      buildEntries.push(be);

      summary.totalBuildTurns++;
      summary.totalSegments += be.segmentsBuilt;
      summary.totalBuildCost += be.cost;
      const target = be.buildTargetCity ?? 'unknown';
      summary.buildTargets[target] = (summary.buildTargets[target] ?? 0) + 1;
    } else if (advisor && advisorLatency > 0 && entry.action !== 'BuildTrack') {
      // Advisor ran but no build happened
      summary.turnsWithAdvisorButNoBuild++;
      skippedBuilds.push({
        turn: entry.turn,
        player,
        action: entry.action,
        advisorLatencyMs: advisorLatency,
        advisorAction: advisor.action,
        advisorFallback: advisor.fallback,
        cash: entry.cash ?? 0,
        buildTargetCity: entry.buildTargetCity ?? null,
        reasoning: (entry.reasoning ?? '').substring(0, 200),
      });
    }
  }

  // Compute averages
  for (const summary of Object.values(playerSummaries)) {
    summary.advisorAvgLatencyMs = summary.advisorCalls > 0
      ? Math.round(summary.advisorTotalLatencyMs / summary.advisorCalls)
      : 0;
  }

  const report = {
    gameId: path.basename(fullPath, '.ndjson').replace('game-', ''),
    totalEntries: entries.length,
    playerSummaries,
    buildEntries,
    skippedBuilds,
    advisorAnalysis: {
      description: 'Breakdown of Build Advisor behavior across all turns',
      perPlayer: Object.entries(playerSummaries).map(([name, s]) => ({
        player: name,
        advisorCallRate: s.advisorCalls > 0
          ? `${s.advisorCalls}/${s.totalTurns} turns (${Math.round(100 * s.advisorCalls / s.totalTurns)}%)`
          : '0 calls',
        successRate: s.advisorCalls > 0
          ? `${s.advisorSuccesses}/${s.advisorCalls} (${Math.round(100 * s.advisorSuccesses / s.advisorCalls)}%)`
          : 'N/A',
        fallbackRate: s.advisorCalls > 0
          ? `${s.advisorFallbacks}/${s.advisorCalls} (${Math.round(100 * s.advisorFallbacks / s.advisorCalls)}%)`
          : 'N/A',
        nullRate: s.advisorCalls > 0
          ? `${s.advisorNulls}/${s.advisorCalls} (${Math.round(100 * s.advisorNulls / s.advisorCalls)}%)`
          : 'N/A',
        avgLatencyMs: s.advisorAvgLatencyMs,
        totalSolvencyRetries: s.solvencyRetries,
      })),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
