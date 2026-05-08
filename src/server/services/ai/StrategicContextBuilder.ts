/**
 * StrategicContextBuilder — Computes four strategic context blocks for Medium-skill
 * trip planning prompts.
 *
 * All block builders are pure functions: no side effects, no LLM calls.
 * Each builder degrades gracefully when inputs are missing or empty.
 */

import {
  WorldSnapshot,
  GameContext,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { getConnectedMajorCityCount } from './connectedMajorCities';
import {
  HAND_STALE_THRESHOLD_TURNS,
  VICTORY_TARGETS_COUNT,
  RECENT_DELIVERIES_WINDOW,
} from './StrategicConstants';

// ── Types ────────────────────────────────────────────────────────────

export interface VictoryTarget {
  cityName: string;
  estimatedCost: number;
  handAffinityCount: number;
}

export interface CapitalProjection {
  cash: number;
  targetGap: number;
  recentIncomeVelocity: number;
  projectedTurnsToVictoryCash: number;
}

export interface HandStalenessRow {
  cardIndex: number;
  turnsHeld: number;
  isStale: boolean;
}

export interface OpponentRow {
  playerId: string;
  playerName: string;
  citiesConnected: number;
  cash: number;
  projectedTurnsFromWin: number;
  isLeading: boolean;
}

export interface PhaseSnapshot {
  turn: number;
  deliveries: number;
  citiesConnected: number;
}

export interface StrategicContext {
  phaseSnapshot: PhaseSnapshot;
  victoryTargets: VictoryTarget[];
  capital: CapitalProjection;
  handStaleness: HandStalenessRow[];
  opponents: OpponentRow[];
}

// ── Constants ────────────────────────────────────────────────────────

const VICTORY_CASH_THRESHOLD = 250;

// ── Block Builders ───────────────────────────────────────────────────

/**
 * Returns up to VICTORY_TARGETS_COUNT cheapest unconnected major cities,
 * sorted by estimatedCost ascending.
 *
 * handAffinityCount: number of demand cards in the current hand whose
 * delivery city is the city itself (direct affinity — demand for this city).
 */
export function buildVictoryTargets(context: GameContext): VictoryTarget[] {
  if (!context.unconnectedMajorCities || context.unconnectedMajorCities.length === 0) {
    return [];
  }

  const sorted = [...context.unconnectedMajorCities]
    .sort((a, b) => a.estimatedCost - b.estimatedCost)
    .slice(0, VICTORY_TARGETS_COUNT);

  return sorted.map(city => {
    const handAffinityCount = (context.demands ?? []).filter(
      d => d.deliveryCity === city.cityName,
    ).length;

    return {
      cityName: city.cityName,
      estimatedCost: city.estimatedCost,
      handAffinityCount,
    };
  });
}

/**
 * Computes capital projection from recent delivery history.
 *
 * recentIncomeVelocity = sum(payouts) / count (0 when empty)
 * projectedTurnsToVictoryCash = ceil((250 - cash) / velocity)
 *   → Infinity-equivalent sentinel (999999) when velocity is 0
 */
export function buildCapitalProjection(
  snapshot: WorldSnapshot,
  memory: BotMemoryState,
): CapitalProjection {
  const cash = snapshot.bot.money;
  const targetGap = Math.max(0, VICTORY_CASH_THRESHOLD - cash);

  const recentDeliveries = memory.recentDeliveries ?? [];
  const window = recentDeliveries.slice(-RECENT_DELIVERIES_WINDOW);

  let recentIncomeVelocity = 0;
  if (window.length > 0) {
    const sum = window.reduce((acc, d) => acc + d.payout, 0);
    recentIncomeVelocity = sum / window.length;
  }

  const projectedTurnsToVictoryCash =
    recentIncomeVelocity > 0
      ? Math.ceil(targetGap / recentIncomeVelocity)
      : 999999;

  return {
    cash,
    targetGap,
    recentIncomeVelocity,
    projectedTurnsToVictoryCash,
  };
}

/**
 * Returns one HandStalenessRow per demand card in context.
 *
 * turnsHeld = currentTurn - cardAcquisitionTurn[cardIndex]
 * When cardAcquisitionTurn entry is missing, returns turnsHeld: 0 and isStale: false.
 */
export function buildHandStaleness(
  context: GameContext,
  memory: BotMemoryState,
): HandStalenessRow[] {
  const cardAcquisitionTurn = memory.cardAcquisitionTurn ?? {};
  const currentTurn = context.turnNumber;

  const uniqueCardIndices = [...new Set((context.demands ?? []).map(d => d.cardIndex))];

  return uniqueCardIndices.map(cardIndex => {
    const acquiredAt = cardAcquisitionTurn[cardIndex];
    const turnsHeld = acquiredAt != null ? Math.max(0, currentTurn - acquiredAt) : 0;
    return {
      cardIndex,
      turnsHeld,
      isStale: turnsHeld >= HAND_STALE_THRESHOLD_TURNS,
    };
  });
}

/**
 * Returns one OpponentRow per non-bot player in snapshot.
 *
 * citiesConnected is derived via the existing getConnectedMajorCityCount BFS.
 * projectedTurnsFromWin: turns needed to connect 7 cities (rough heuristic:
 *   max(0, 7 - citiesConnected) * 5 as a placeholder; zero means already winning).
 * isLeading: true for the opponent with the lowest projectedTurnsFromWin
 *   (ties broken by lowest index).
 */
export function buildOpponents(snapshot: WorldSnapshot): OpponentRow[] {
  const botId = snapshot.bot.playerId;
  const opponents = (snapshot.opponents ?? []).filter(o => o.playerId !== botId);

  if (opponents.length === 0) {
    return [];
  }

  const allPlayerTracks = snapshot.allPlayerTracks ?? [];

  const rows: OpponentRow[] = opponents.map(opponent => {
    const trackEntry = allPlayerTracks.find(t => t.playerId === opponent.playerId);
    const segments = trackEntry?.segments ?? [];
    const citiesConnected = getConnectedMajorCityCount(segments);

    // Rough heuristic: ~5 turns per additional city needed
    const citiesNeeded = Math.max(0, 7 - citiesConnected);
    const projectedTurnsFromWin = citiesNeeded * 5;

    return {
      playerId: opponent.playerId,
      playerName: opponent.playerId, // playerId used as display name (no name field in OpponentSnapshot)
      citiesConnected,
      cash: opponent.money,
      projectedTurnsFromWin,
      isLeading: false,
    };
  });

  // Flag the single opponent with the lowest projectedTurnsFromWin as leading
  if (rows.length > 0) {
    const minTurns = Math.min(...rows.map(r => r.projectedTurnsFromWin));
    let flagged = false;
    for (const row of rows) {
      if (!flagged && row.projectedTurnsFromWin === minTurns) {
        row.isLeading = true;
        flagged = true;
      }
    }
  }

  return rows;
}

// ── Main Entry Point ─────────────────────────────────────────────────

/**
 * Compute all four strategic context blocks plus the phase snapshot header.
 *
 * Degrades gracefully when inputs are empty/missing — never throws.
 */
export function build(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
): StrategicContext {
  const phaseSnapshot: PhaseSnapshot = {
    turn: context.turnNumber,
    deliveries: memory.deliveryCount ?? 0,
    citiesConnected: context.connectedMajorCities?.length ?? 0,
  };

  const victoryTargets = buildVictoryTargets(context);
  const capital = buildCapitalProjection(snapshot, memory);
  const handStaleness = buildHandStaleness(context, memory);
  const opponents = buildOpponents(snapshot);

  return {
    phaseSnapshot,
    victoryTargets,
    capital,
    handStaleness,
    opponents,
  };
}

// ── Renderer ─────────────────────────────────────────────────────────

/**
 * Format the StrategicContext into the prompt-text block inserted between
 * CURRENT PLAN and OPTIONS in buildTripPlanningContext.
 */
export function renderStrategicContext(ctx: StrategicContext): string {
  const lines: string[] = [];

  lines.push(`STRATEGIC CONTEXT (turn ${ctx.phaseSnapshot.turn}):`);
  lines.push(`- Deliveries completed: ${ctx.phaseSnapshot.deliveries}`);
  lines.push(`- Cities connected: ${ctx.phaseSnapshot.citiesConnected}/8`);
  lines.push('');

  // VICTORY TARGETS
  lines.push('VICTORY TARGETS (cheapest unconnected major cities):');
  if (ctx.victoryTargets.length === 0) {
    lines.push('  (all major cities connected)');
  } else {
    for (const t of ctx.victoryTargets) {
      const affinityNote = t.handAffinityCount > 0 ? ` [${t.handAffinityCount} card(s) deliver here]` : '';
      lines.push(`  ${t.cityName}: ~${t.estimatedCost}M to connect${affinityNote}`);
    }
  }
  lines.push('');

  // CAPITAL PROJECTION
  lines.push('CAPITAL PROJECTION:');
  lines.push(`  Cash: ${ctx.capital.cash}M | Gap to 250M: ${ctx.capital.targetGap}M`);
  if (ctx.capital.recentIncomeVelocity > 0) {
    lines.push(`  Recent income velocity: ${ctx.capital.recentIncomeVelocity.toFixed(1)}M/delivery`);
    const turns = ctx.capital.projectedTurnsToVictoryCash;
    lines.push(`  Projected turns to 250M cash: ${turns >= 999999 ? '∞' : turns}`);
  } else {
    lines.push('  Recent income velocity: 0 (no recent deliveries)');
    lines.push('  Projected turns to 250M cash: ∞');
  }
  lines.push('');

  // HAND STALENESS
  if (ctx.handStaleness.length > 0) {
    lines.push('HAND STALENESS:');
    for (const row of ctx.handStaleness) {
      const staleFlag = row.isStale ? ' [STALE]' : '';
      lines.push(`  Card ${row.cardIndex}: held ${row.turnsHeld} turn(s)${staleFlag}`);
    }
    lines.push('');
  }

  // OPPONENTS
  if (ctx.opponents.length > 0) {
    lines.push('OPPONENTS:');
    for (const opp of ctx.opponents) {
      const leadFlag = opp.isLeading ? ' [LEADING]' : '';
      lines.push(`  ${opp.playerName}: ${opp.citiesConnected} cities, ${opp.cash}M cash, ~${opp.projectedTurnsFromWin} turns from win${leadFlag}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
