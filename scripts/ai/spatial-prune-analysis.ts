#!/usr/bin/env npx ts-node
/**
 * spatial-prune-analysis.ts
 *
 * Replays past bot trip-planner decisions through a spatial-prune + top-1
 * deterministic algorithm and tabulates how often it would have picked
 * differently than the LLM did.
 *
 * Inputs: logs/*.ndjson
 * Output: stdout markdown summary
 *
 * Caveat: existing-track is NOT reconstructed (logs only carry segment counts,
 * not segment lists). All candidates are simulated against an empty network.
 * Relative ranking within a turn is preserved; absolute build costs are
 * inflated for trips that would reuse existing track.
 */
import * as fs from 'fs';
import * as path from 'path';
import { simulateTrip } from '../../src/server/services/ai/RouteDetourEstimator';
import { hexDistance, loadGridPoints, gridToPixel, GridPointData } from '../../src/server/services/ai/MapTopology';
import { TrainType, RouteStop, TrackSegment, TerrainType } from '../../src/shared/types/GameTypes';

// ── Tunables ──────────────────────────────────────────────────────────
const PRUNE_MAX_TURNS = Number(process.env.PRUNE_MAX_TURNS ?? 18);
const PRUNE_MAX_BUILD_M = Number(process.env.PRUNE_MAX_BUILD_M ?? 130);
const HOP_AVG_COST_M = Number(process.env.HOP_AVG_COST_M ?? 1.3);
const OCPT_OVERRIDE = Number(process.env.OCPT ?? 5);
const OCPT = OCPT_OVERRIDE;
const TRAIN_CAP: Record<string, number> = {
  freight: 2, fast_freight: 2, heavy_freight: 3, superfreight: 3,
};
const TRAIN_SPEED: Record<string, number> = {
  freight: 9, fast_freight: 12, heavy_freight: 9, superfreight: 12,
};

// ── Types ─────────────────────────────────────────────────────────────
interface DemandRow {
  loadType: string;
  supplyCity: string;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
}
interface LogEntry {
  turn: number;
  playerId: string;
  playerName: string;
  positionStart: { row: number; col: number; cityName?: string } | null;
  positionEnd?: { row: number; col: number; cityName?: string } | null;
  trainSpeed: number;
  trainCapacity: number;
  activeRoute: { stops: Array<{ action: string; loadType: string; city: string }>; currentStopIndex: number } | null;
  demandCards: DemandRow[];
  action: string;
  decisionSource?: string;
  cash?: number;
  train?: string;
  gamePhase?: string;
  movementPath?: Array<{ row: number; col: number }>;
}
interface Candidate {
  id: string;
  rows: DemandRow[];
  stops: RouteStop[];
  payout: number;
}
interface ScoredCandidate extends Candidate {
  buildCost: number;
  turns: number;
  net: number;
  score: number;
  feasible: boolean;
}

// ── Grid + city lookup ─────────────────────────────────────────────────
const grid: Map<string, GridPointData> = loadGridPoints();
const cityToCoords: Map<string, { row: number; col: number }[]> = new Map();
for (const [_, pt] of grid) {
  if (pt.name) {
    if (!cityToCoords.has(pt.name)) cityToCoords.set(pt.name, []);
    cityToCoords.get(pt.name)!.push({ row: pt.row, col: pt.col });
  }
}

function nearestCityCoord(name: string, from: { row: number; col: number }): { row: number; col: number } | null {
  const coords = cityToCoords.get(name);
  if (!coords || coords.length === 0) return null;
  let best = coords[0];
  let bestDist = hexDistance(from.row, from.col, best.row, best.col);
  for (const c of coords) {
    const d = hexDistance(from.row, from.col, c.row, c.col);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// ── Implicit-carry detection ──────────────────────────────────────────
/**
 * Returns the set of loadTypes the bot is currently carrying.
 *
 * Combines two signals:
 *  1. Demand rows with `supplyCity === null` (canonical carry marker — sometimes missing).
 *  2. activeRoute stops where a `deliver <load>` appears with no preceding `pickup <load>`
 *     in the same plan — implies the bot already has that load on board.
 */
function detectCarriedLoads(activeRoute: LogEntry['activeRoute'], rows: DemandRow[]): Set<string> {
  const carried = new Set<string>();
  for (const r of rows) {
    if (!r.supplyCity) carried.add(r.loadType);
  }
  if (!activeRoute || !activeRoute.stops) return carried;
  const pickedUp = new Set<string>();
  for (const stop of activeRoute.stops) {
    if (stop.action === 'pickup') pickedUp.add(stop.loadType);
    else if (stop.action === 'deliver' && !pickedUp.has(stop.loadType)) {
      carried.add(stop.loadType);
    }
  }
  return carried;
}

/** Annotate rows with an `isCarry` flag using both canonical and implicit signals. */
function normalizeRows(rows: DemandRow[], carried: Set<string>): (DemandRow & { isCarry: boolean })[] {
  return rows.map(r => ({ ...r, isCarry: !r.supplyCity || carried.has(r.loadType) }));
}

// ── Candidate generation ──────────────────────────────────────────────
function genSingles(rows: (DemandRow & { isCarry: boolean })[]): Candidate[] {
  return rows.map(r => {
    const isCarry = r.isCarry;
    const stops: RouteStop[] = isCarry
      ? [{ action: 'deliver', loadType: r.loadType, city: r.deliveryCity, demandCardId: r.cardIndex, payment: r.payout }]
      : [
          { action: 'pickup', loadType: r.loadType, city: r.supplyCity! },
          { action: 'deliver', loadType: r.loadType, city: r.deliveryCity, demandCardId: r.cardIndex, payment: r.payout },
        ];
    return {
      id: `${isCarry ? 'carry' : 'single'}:${r.cardIndex}:${r.loadType}`,
      rows: [r],
      stops,
      payout: r.payout,
    };
  });
}

function genPairs(rows: (DemandRow & { isCarry: boolean })[], cap: number): Candidate[] {
  if (cap < 2) return [];
  const pairs: Candidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      // Don't pair two demands from the same card (only one demand per card is fulfillable)
      if (a.cardIndex === b.cardIndex) continue;
      const aCarry = a.isCarry, bCarry = b.isCarry;
      const delA = { action: 'deliver' as const, loadType: a.loadType, city: a.deliveryCity, demandCardId: a.cardIndex, payment: a.payout };
      const delB = { action: 'deliver' as const, loadType: b.loadType, city: b.deliveryCity, demandCardId: b.cardIndex, payment: b.payout };
      const pickA: RouteStop = { action: 'pickup', loadType: a.loadType, city: a.supplyCity! };
      const pickB: RouteStop = { action: 'pickup', loadType: b.loadType, city: b.supplyCity! };

      // Build stop sequences depending on which (if any) are carry rows
      const variants: { suffix: string; stops: RouteStop[] }[] = [];
      if (aCarry && bCarry) {
        // Two carry loads: just deliver both, two orderings
        variants.push({ suffix: 'cAcB', stops: [delA, delB] });
        variants.push({ suffix: 'cBcA', stops: [delB, delA] });
      } else if (aCarry) {
        // a is carry, b needs pickup
        variants.push({ suffix: 'cA-pB', stops: [pickB, delA, delB] });
        variants.push({ suffix: 'pB-cA', stops: [pickB, delB, delA] });
        variants.push({ suffix: 'delAfirst', stops: [delA, pickB, delB] });
      } else if (bCarry) {
        // b is carry, a needs pickup
        variants.push({ suffix: 'cB-pA', stops: [pickA, delB, delA] });
        variants.push({ suffix: 'pA-cB', stops: [pickA, delA, delB] });
        variants.push({ suffix: 'delBfirst', stops: [delB, pickA, delA] });
      } else {
        // Both need pickup
        variants.push({ suffix: 'AB', stops: [pickA, pickB, delA, delB] });
        variants.push({ suffix: 'BA', stops: [pickA, pickB, delB, delA] });
      }
      for (const v of variants) {
        pairs.push({
          id: `pair:${a.cardIndex}-${a.loadType}+${b.cardIndex}-${b.loadType}:${v.suffix}`,
          rows: [a, b],
          stops: v.stops,
          payout: a.payout + b.payout,
        });
      }
    }
  }
  return pairs;
}

/**
 * Generate triple-demand candidates.
 *
 * Considered configurations (cap=2 freight dominant in logs; cap=3 also handled):
 *  - 3 carries (cap≥3): all on board, just pick a delivery order (1 ordering for now)
 *  - 2 carries + 1 fresh (cap=2 OK): must deliver one carry to free a slot before pickup
 *  - 1 carry + 2 fresh (cap=2 OK): deliver carry first, then fresh-pair
 *  - 0 carries + 3 fresh (cap≥3 only): pickup all 3 then deliver all 3
 *
 * Same-card pairs/triples are blocked: each card fulfills only one demand at a time.
 */
function genTriples(rows: (DemandRow & { isCarry: boolean })[], cap: number): Candidate[] {
  const triples: Candidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      for (let k = j + 1; k < rows.length; k++) {
        const a = rows[i], b = rows[j], c = rows[k];
        if (a.cardIndex === b.cardIndex || b.cardIndex === c.cardIndex || a.cardIndex === c.cardIndex) continue;
        const carryFlags = [a.isCarry, b.isCarry, c.isCarry];
        const carryCount = carryFlags.filter(Boolean).length;
        const freshCount = 3 - carryCount;

        const stop = (kind: 'pickup' | 'deliver', r: DemandRow): RouteStop =>
          kind === 'pickup'
            ? { action: 'pickup', loadType: r.loadType, city: r.supplyCity! }
            : { action: 'deliver', loadType: r.loadType, city: r.deliveryCity, demandCardId: r.cardIndex, payment: r.payout };

        const variants: { suffix: string; stops: RouteStop[] }[] = [];
        if (carryCount === 3) {
          // 3 carries — only feasible when cap ≥ 3 (all already on board)
          if (cap < 3) continue;
          // One natural ordering; let the simulator handle distance optimization
          variants.push({ suffix: '3c', stops: [stop('deliver', a), stop('deliver', b), stop('deliver', c)] });
        } else if (carryCount === 2) {
          // 2 carries + 1 fresh: identify which is fresh; deliver carries to free a slot then pickup fresh
          const fresh = !a.isCarry ? a : !b.isCarry ? b : c;
          const carries = [a, b, c].filter(x => x.isCarry);
          const ca = carries[0], cb = carries[1];
          // Deliver one carry, pickup fresh, deliver other carry, deliver fresh — and other-carry-first variant
          variants.push({ suffix: '2c1f-ab', stops: [stop('deliver', ca), stop('pickup', fresh), stop('deliver', cb), stop('deliver', fresh)] });
          variants.push({ suffix: '2c1f-ba', stops: [stop('deliver', cb), stop('pickup', fresh), stop('deliver', ca), stop('deliver', fresh)] });
          // Deliver-both-carries-first variants (drop the fresh load between them)
          variants.push({ suffix: '2c1f-cf', stops: [stop('deliver', ca), stop('deliver', cb), stop('pickup', fresh), stop('deliver', fresh)] });
          variants.push({ suffix: '2c1f-cf2', stops: [stop('deliver', cb), stop('deliver', ca), stop('pickup', fresh), stop('deliver', fresh)] });
        } else if (carryCount === 1) {
          // 1 carry + 2 fresh: cap=2 means deliver carry before second pickup; cap≥3 also fine.
          const carry = a.isCarry ? a : b.isCarry ? b : c;
          const fresh = [a, b, c].filter(x => !x.isCarry);
          const fa = fresh[0], fb = fresh[1];
          // Always-feasible: deliver carry first, then handle the two fresh as a pair
          variants.push({ suffix: '1c2f-cAB', stops: [stop('deliver', carry), stop('pickup', fa), stop('pickup', fb), stop('deliver', fa), stop('deliver', fb)] });
          variants.push({ suffix: '1c2f-cBA', stops: [stop('deliver', carry), stop('pickup', fa), stop('pickup', fb), stop('deliver', fb), stop('deliver', fa)] });
          // Pickup-first variants (only if cap≥3 since carry+2fresh exceeds 2)
          if (cap >= 3) {
            variants.push({ suffix: '1c2f-AcB', stops: [stop('pickup', fa), stop('pickup', fb), stop('deliver', carry), stop('deliver', fa), stop('deliver', fb)] });
          }
          // Interleaved: pickup fa, deliver carry+fa interleaved with fb pickup
          variants.push({ suffix: '1c2f-int', stops: [stop('pickup', fa), stop('deliver', carry), stop('deliver', fa), stop('pickup', fb), stop('deliver', fb)] });
        } else {
          // 0 carries + 3 fresh: cap≥3 only (pick all then deliver)
          if (cap < 3) continue;
          variants.push({ suffix: '3f-ABC', stops: [stop('pickup', a), stop('pickup', b), stop('pickup', c), stop('deliver', a), stop('deliver', b), stop('deliver', c)] });
          // Sequential single-style (cap=2-friendly but not generated here since 0-carry path above gates on cap≥3)
        }

        for (const v of variants) {
          triples.push({
            id: `triple:${a.cardIndex}-${a.loadType}+${b.cardIndex}-${b.loadType}+${c.cardIndex}-${c.loadType}:${v.suffix}`,
            rows: [a, b, c],
            stops: v.stops,
            payout: a.payout + b.payout + c.payout,
          });
        }
      }
    }
  }
  return triples;
}

// ── Spatial prune (cheap, no simulator) ───────────────────────────────
function cheapPrune(cand: Candidate, startPos: { row: number; col: number }, speed: number): { keep: boolean; estTurns: number; estBuild: number } {
  let totalHops = 0;
  let cur = startPos;
  for (const s of cand.stops) {
    const dest = nearestCityCoord(s.city, cur);
    if (!dest) return { keep: false, estTurns: 999, estBuild: 999 };
    totalHops += hexDistance(cur.row, cur.col, dest.row, dest.col);
    cur = dest;
  }
  const estTurns = Math.max(1, Math.ceil(totalHops / speed));
  const estBuild = totalHops * HOP_AVG_COST_M;
  const keep = estTurns <= PRUNE_MAX_TURNS && estBuild <= PRUNE_MAX_BUILD_M;
  return { keep, estTurns, estBuild };
}

// ── Existing-track reconstruction ─────────────────────────────────────
function edgeKey(a: { row: number; col: number }, b: { row: number; col: number }): string {
  const k1 = `${a.row},${a.col}`;
  const k2 = `${b.row},${b.col}`;
  return k1 <= k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}
function edgesFromPath(path: Array<{ row: number; col: number }>): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 1 < path.length; i++) set.add(edgeKey(path[i], path[i + 1]));
  return set;
}
function edgeSetToSegments(edges: Set<string>): TrackSegment[] {
  const segs: TrackSegment[] = [];
  for (const ek of edges) {
    const [aStr, bStr] = ek.split('|');
    const [aR, aC] = aStr.split(',').map(Number);
    const [bR, bC] = bStr.split(',').map(Number);
    const aPt = grid.get(`${aR},${aC}`);
    const bPt = grid.get(`${bR},${bC}`);
    if (!aPt || !bPt) continue;
    const aXY = gridToPixel(aR, aC);
    const bXY = gridToPixel(bR, bC);
    segs.push({
      from: { x: aXY.x, y: aXY.y, row: aR, col: aC, terrain: aPt.terrain },
      to:   { x: bXY.x, y: bXY.y, row: bR, col: bC, terrain: bPt.terrain },
      cost: 0,
    } as TrackSegment);
  }
  return segs;
}

// ── Run real simulator ────────────────────────────────────────────────
function scoreWithSimulator(cand: Candidate, startPos: { row: number; col: number }, trainType: string, playerId: string, existingSegments: TrackSegment[] = []): ScoredCandidate {
  const snapshot = {
    bot: {
      playerId,
      existingSegments,
      trainType,
      ferryHalfSpeed: false,
    },
    allPlayerTracks: [] as Array<{ playerId: string; segments: TrackSegment[] }>,
  };
  let result;
  try {
    result = simulateTrip(startPos, cand.stops, snapshot);
  } catch (e) {
    return { ...cand, buildCost: 999, turns: 999, net: -999, score: -9999, feasible: false };
  }
  const buildCost = result.totalBuildCost;
  const turns = result.turnsToComplete;
  const net = cand.payout - buildCost;
  const score = net - OCPT * turns;
  return { ...cand, buildCost, turns, net, score, feasible: result.feasible };
}

// ── Match bot's actual choice to a candidate ──────────────────────────
function botChoiceFromActiveRoute(active: LogEntry['activeRoute'], rows: DemandRow[]): Candidate | null {
  if (!active || !active.stops || active.stops.length === 0) return null;
  // Identify which demand rows this trip fulfills (by load type + delivery city)
  const matchedRows: DemandRow[] = [];
  for (const stop of active.stops) {
    if (stop.action !== 'deliver') continue;
    const r = rows.find(x => x.loadType === stop.loadType && x.deliveryCity === stop.city);
    if (r) matchedRows.push(r);
  }
  if (matchedRows.length === 0) return null;
  const stops: RouteStop[] = active.stops.map(s => ({
    action: s.action as 'pickup' | 'deliver' | 'drop',
    loadType: s.loadType,
    city: s.city,
  }));
  // Wire payment/demandCardId for delivers
  for (const stop of stops) {
    if (stop.action === 'deliver') {
      const r = matchedRows.find(x => x.loadType === stop.loadType && x.deliveryCity === stop.city);
      if (r) {
        stop.demandCardId = r.cardIndex;
        stop.payment = r.payout;
      }
    }
  }
  return {
    id: 'BOT_CHOICE',
    rows: matchedRows,
    stops,
    payout: matchedRows.reduce((s, r) => s + r.payout, 0),
  };
}

// ── Main analysis per turn ────────────────────────────────────────────
interface TurnAnalysis {
  game: string;
  turn: number;
  player: string;
  position?: string;
  cash?: number;
  train?: string;
  handSize: number;
  rawCandidates: number;
  pruneSurvivors: number;
  feasibleSurvivors: number;
  top1Id: string;
  top1Score: number;
  top1Net: number;
  top1Turns: number;
  botChoiceId: string;
  botChoiceScore: number;
  botChoiceNet: number;
  botChoiceTurns: number;
  matches: boolean;
  scoreDelta: number; // top1 - bot
}

function analyzeTurn(entry: LogEntry, gameId: string, existingSegments: TrackSegment[], dumpStream?: fs.WriteStream): TurnAnalysis | null {
  if (!entry.positionStart || !entry.demandCards || entry.demandCards.length === 0) return null;
  const trainType = (entry.train || 'freight').toLowerCase();
  const cap = TRAIN_CAP[trainType] ?? 2;
  const speed = entry.trainSpeed || TRAIN_SPEED[trainType] || 9;

  const carried = detectCarriedLoads(entry.activeRoute, entry.demandCards);
  const rows = normalizeRows(entry.demandCards, carried);
  const singles = genSingles(rows);
  const pairs = genPairs(rows, cap);
  const triples = genTriples(rows, cap);
  const allCandidates = [...singles, ...pairs, ...triples];

  // Spatial prune
  const pruneInfos = allCandidates.map(c => ({ c, p: cheapPrune(c, entry.positionStart!, speed) }));
  const survivors = pruneInfos.filter(x => x.p.keep);

  // Simulate survivors
  const scored: ScoredCandidate[] = [];
  for (const { c } of survivors) {
    const s = scoreWithSimulator(c, entry.positionStart!, trainType, entry.playerId, existingSegments);
    if (s.feasible) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);
  const top1 = scored[0];
  if (!top1) return null;

  // Score bot's choice (always run through simulator, regardless of prune verdict)
  const botCand = botChoiceFromActiveRoute(entry.activeRoute, rows);
  let botScored: ScoredCandidate | null = null;
  if (botCand) {
    botScored = scoreWithSimulator(botCand, entry.positionStart!, trainType, entry.playerId, existingSegments);
  }

  if (dumpStream) {
    // Dump full per-candidate data so a sweep script can reapply different (OCPT, prune) parameters.
    const dumpRecord = {
      game: gameId,
      turn: entry.turn,
      player: entry.playerName,
      cap,
      speed,
      candidates: pruneInfos.map(({ c, p }) => {
        const s = p.keep ? scored.find(x => x.id === c.id) : null;
        return {
          id: c.id,
          payout: c.payout,
          rowKey: c.rows.map(r => `${r.cardIndex}:${r.loadType}`).sort().join('|'),
          estTurns: p.estTurns,
          estBuild: p.estBuild,
          simTurns: s ? s.turns : null,
          simBuild: s ? s.buildCost : null,
          feasible: !!s,
        };
      }),
      botChoice: botCand && botScored ? {
        rowKey: botCand.rows.map(r => `${r.cardIndex}:${r.loadType}`).sort().join('|'),
        payout: botCand.payout,
        simTurns: botScored.turns,
        simBuild: botScored.buildCost,
        feasible: botScored.feasible,
      } : null,
    };
    dumpStream.write(JSON.stringify(dumpRecord) + '\n');
  }

  return {
    game: gameId,
    turn: entry.turn,
    player: entry.playerName,
    position: entry.positionStart.cityName ?? `(${entry.positionStart.row},${entry.positionStart.col})`,
    cash: entry.cash,
    train: trainType,
    handSize: rows.length,
    rawCandidates: allCandidates.length,
    pruneSurvivors: survivors.length,
    feasibleSurvivors: scored.length,
    top1Id: top1.id,
    top1Score: top1.score,
    top1Net: top1.net,
    top1Turns: top1.turns,
    botChoiceId: botCand?.id ?? 'NONE',
    botChoiceScore: botScored?.score ?? NaN,
    botChoiceNet: botScored?.net ?? NaN,
    botChoiceTurns: botScored?.turns ?? NaN,
    matches: !!botCand && sameRows(top1.rows, botCand.rows),
    scoreDelta: top1.score - (botScored?.score ?? top1.score),
  };
}

function sameRows(a: DemandRow[], b: DemandRow[]): boolean {
  if (a.length !== b.length) return false;
  const keyA = a.map(r => `${r.cardIndex}:${r.loadType}`).sort().join('|');
  const keyB = b.map(r => `${r.cardIndex}:${r.loadType}`).sort().join('|');
  return keyA === keyB;
}

// ── Debug mode ────────────────────────────────────────────────────────
function debugTurn(entry: LogEntry, existingSegments: TrackSegment[] = []): void {
  if (!entry.positionStart) { console.log('no position'); return; }
  const trainType = (entry.train || 'freight').toLowerCase();
  const cap = TRAIN_CAP[trainType] ?? 2;
  const speed = entry.trainSpeed || TRAIN_SPEED[trainType] || 9;
  const carried = detectCarriedLoads(entry.activeRoute, entry.demandCards);
  const rows = normalizeRows(entry.demandCards, carried);
  const singles = genSingles(rows);
  const pairs = genPairs(rows, cap);
  const triples = genTriples(rows, cap);
  const all = [...singles, ...pairs, ...triples];

  console.log(`\n=== ${entry.playerName} turn ${entry.turn} pos=${entry.positionStart.cityName ?? `(${entry.positionStart.row},${entry.positionStart.col})`} train=${trainType} cash=${entry.cash} ===`);
  console.log(`hand (${rows.length} rows): ${rows.map(r => `c${r.cardIndex}:${r.loadType}@${r.isCarry ? '[CARRY]' : r.supplyCity}→${r.deliveryCity}(${r.payout})`).join(' | ')}`);
  console.log(`carried loads detected: ${[...carried].join(', ') || '(none)'}`);
  console.log(`active: ${JSON.stringify(entry.activeRoute)}`);
  console.log(`existingSegments: ${existingSegments.length} edges`);
  console.log(`raw candidates: ${all.length} (${singles.length} singles + ${pairs.length} pairs + ${triples.length} triples)\n`);

  console.log('| Cand | est_turns | est_build | pruned? | sim_turns | sim_build | net | score |');
  console.log('|---|---:|---:|---|---:|---:|---:|---:|');
  const scored: ScoredCandidate[] = [];
  for (const c of all) {
    const p = cheapPrune(c, entry.positionStart, speed);
    let sim: ScoredCandidate | null = null;
    if (p.keep) {
      sim = scoreWithSimulator(c, entry.positionStart, trainType, entry.playerId, existingSegments);
      if (sim.feasible) scored.push(sim);
    }
    const id = shortId(c.id);
    if (sim && sim.feasible) {
      console.log(`| ${id} | ${p.estTurns} | ${p.estBuild.toFixed(0)}M | keep | ${sim.turns} | ${sim.buildCost}M | ${sim.net.toFixed(0)} | ${sim.score.toFixed(0)} |`);
    } else if (p.keep) {
      console.log(`| ${id} | ${p.estTurns} | ${p.estBuild.toFixed(0)}M | infeasible | - | - | - | - |`);
    } else {
      console.log(`| ${id} | ${p.estTurns} | ${p.estBuild.toFixed(0)}M | PRUNED | - | - | - | - |`);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  console.log(`\ntop-1: ${scored[0]?.id ?? 'NONE'} score=${scored[0]?.score.toFixed(1) ?? 'n/a'}`);
}

// ── Main entrypoint ───────────────────────────────────────────────────
function main(): void {
  const args = process.argv.slice(2);
  const dumpIdx = args.indexOf('--dump');
  const dumpFile = dumpIdx >= 0 ? args[dumpIdx + 1] : null;
  const debugFilter = !dumpFile && args[0] && !args[0].startsWith('--') ? args[0] : null;
  const logsDir = path.join(__dirname, '../../logs');
  const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.ndjson'));
  if (!debugFilter) console.error(`Scanning ${files.length} game logs...`);
  const dumpStream = dumpFile ? fs.createWriteStream(dumpFile) : undefined;

  const results: TurnAnalysis[] = [];
  let totalTripPlannerEntries = 0;
  let totalAnalyzed = 0;

  for (const file of files) {
    const gameId = file.replace(/^game-/, '').replace(/\.ndjson$/, '').slice(0, 8);
    const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean);
    // Per-player accumulated edge sets, built up turn-by-turn from movementPath
    const playerEdges: Map<string, Set<string>> = new Map();
    for (const line of lines) {
      let entry: LogEntry;
      try { entry = JSON.parse(line); } catch { continue; }
      const playerKey = entry.playerId || entry.playerName;
      if (!playerEdges.has(playerKey)) playerEdges.set(playerKey, new Set());
      const accEdges = playerEdges.get(playerKey)!;

      if (entry.decisionSource === 'trip-planner' || entry.decisionSource === 'trip-planner-deterministic') {
        if (debugFilter) {
          const [gPrefix, turnStr, player] = debugFilter.split(':');
          if (gameId.startsWith(gPrefix) && entry.turn === Number(turnStr) && entry.playerName === player) {
            debugTurn(entry, edgeSetToSegments(accEdges));
            return;
          }
        } else {
          totalTripPlannerEntries++;
          const r = analyzeTurn(entry, gameId, edgeSetToSegments(accEdges), dumpStream);
          if (r) {
            results.push(r);
            totalAnalyzed++;
          }
        }
      }

      // Update accumulated edges from this turn's movementPath (regardless of decisionSource)
      if (entry.movementPath && entry.movementPath.length > 1) {
        for (const e of edgesFromPath(entry.movementPath)) accEdges.add(e);
      }
    }
  }
  if (debugFilter) { console.error('No matching turn found'); return; }
  if (dumpStream) { dumpStream.end(); console.error(`Dumped ${totalAnalyzed} turns to ${dumpFile}`); return; }

  console.error(`Found ${totalTripPlannerEntries} trip-planner entries; analyzed ${totalAnalyzed}.`);

  // Output markdown summary
  console.log(`# Spatial-Prune + Top-1 Analysis vs LLM Choice\n`);
  console.log(`- Games scanned: ${files.length}`);
  console.log(`- Trip-planner entries: ${totalTripPlannerEntries}`);
  console.log(`- Analyzed (had position + hand + feasible top-1): ${totalAnalyzed}\n`);

  const matches = results.filter(r => r.matches).length;
  const wins = results.filter(r => !r.matches && r.scoreDelta > 0).length;
  const losses = results.filter(r => !r.matches && r.scoreDelta < 0).length;
  const ties = results.filter(r => !r.matches && r.scoreDelta === 0).length;
  console.log(`## Outcome distribution\n`);
  console.log(`| Outcome | Count | % |`);
  console.log(`|---|---:|---:|`);
  console.log(`| Top-1 == Bot choice | ${matches} | ${((100 * matches) / totalAnalyzed).toFixed(1)}% |`);
  console.log(`| Top-1 different & better | ${wins} | ${((100 * wins) / totalAnalyzed).toFixed(1)}% |`);
  console.log(`| Top-1 different & worse | ${losses} | ${((100 * losses) / totalAnalyzed).toFixed(1)}% |`);
  console.log(`| Top-1 different & tied | ${ties} | ${((100 * ties) / totalAnalyzed).toFixed(1)}% |\n`);

  // Score deltas
  const deltas = results.map(r => r.scoreDelta);
  if (deltas.length) {
    const sum = deltas.reduce((a, b) => a + b, 0);
    const avg = sum / deltas.length;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    console.log(`## Score deltas (top1 − bot)\n`);
    console.log(`- Mean: ${avg.toFixed(2)}`);
    console.log(`- Median: ${median.toFixed(2)}`);
    console.log(`- Min: ${deltas[0].toFixed(2)}`);
    console.log(`- Max: ${deltas[deltas.length - 1].toFixed(2)}\n`);
  }

  // Top mismatches by delta
  const mismatches = results.filter(r => !r.matches).sort((a, b) => b.scoreDelta - a.scoreDelta);
  console.log(`## Top 20 cases where top-1 beats bot most\n`);
  console.log(`| Game | Turn | Player | Position | Bot choice | Bot score | Top-1 choice | Top-1 score | Δ |`);
  console.log(`|---|---:|---|---|---|---:|---|---:|---:|`);
  for (const r of mismatches.slice(0, 20)) {
    console.log(`| ${r.game} | ${r.turn} | ${r.player} | ${r.position} | ${shortId(r.botChoiceId)} | ${fmt(r.botChoiceScore)} | ${shortId(r.top1Id)} | ${fmt(r.top1Score)} | ${r.scoreDelta.toFixed(1)} |`);
  }

  console.log(`\n## Bottom 10 cases where top-1 is worse than bot\n`);
  console.log(`| Game | Turn | Player | Position | Bot choice | Bot score | Top-1 choice | Top-1 score | Δ |`);
  console.log(`|---|---:|---|---|---|---:|---|---:|---:|`);
  for (const r of mismatches.slice(-10).reverse()) {
    console.log(`| ${r.game} | ${r.turn} | ${r.player} | ${r.position} | ${shortId(r.botChoiceId)} | ${fmt(r.botChoiceScore)} | ${shortId(r.top1Id)} | ${fmt(r.top1Score)} | ${r.scoreDelta.toFixed(1)} |`);
  }

  // Pattern breakdown of top-1 vs bot
  const top1Pattern = (id: string) =>
    id.startsWith('triple:') ? 'triple'
    : id.startsWith('pair:') ? 'pair'
    : id.startsWith('carry:') ? 'carry'
    : id.startsWith('single:') ? 'single'
    : 'other';
  const counts = { single: 0, pair: 0, triple: 0, carry: 0, other: 0 };
  for (const r of results) counts[top1Pattern(r.top1Id) as keyof typeof counts]++;
  const botCounts = { single: 0, pair: 0, other: 0, none: 0 };
  for (const r of results) {
    if (r.botChoiceId === 'NONE') { botCounts.none++; continue; }
    const pat = r.botChoiceId === 'BOT_CHOICE' ? (r.handSize > 0 && r.botChoiceTurns > 0 ? (r.botChoiceNet > 0 ? 'pair-or-single' : 'single') : 'single') : 'other';
    // Best effort: count delivers in stops via active route — but we erased that detail; classify by row count
  }
  console.log(`\n## Top-1 candidate type distribution\n`);
  console.log(`| Type | Count | % |`);
  console.log(`|---|---:|---:|`);
  console.log(`| Triple (3 demands) | ${counts.triple} | ${((100 * counts.triple) / totalAnalyzed).toFixed(1)}% |`);
  console.log(`| Pair (2 demands) | ${counts.pair} | ${((100 * counts.pair) / totalAnalyzed).toFixed(1)}% |`);
  console.log(`| Single fresh (1 demand) | ${counts.single} | ${((100 * counts.single) / totalAnalyzed).toFixed(1)}% |`);
  console.log(`| Single carry (1 demand) | ${counts.carry} | ${((100 * counts.carry) / totalAnalyzed).toFixed(1)}% |`);
}

function shortId(id: string): string {
  if (id === 'NONE' || id === 'BOT_CHOICE') return id;
  return id.replace(/^single:/, 's:').replace(/^pair:/, 'p:').slice(0, 40);
}
function fmt(n: number): string {
  if (Number.isNaN(n)) return 'n/a';
  return n.toFixed(1);
}

main();
