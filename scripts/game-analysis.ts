/**
 * Game Analysis — Comprehensive markdown report from NDJSON game logs.
 *
 * Produces an 11-section analysis covering turn composition, track building,
 * demand selection, income/economy, movement, train upgrades, hand management,
 * death spirals, head-to-head comparison, LLM interactions, and suggested improvements.
 *
 * Usage: npx tsx scripts/game-analysis.ts <game-id> [options]
 *   --player <name>    Filter to a single bot
 *   --out <file>       Write to file instead of stdout
 */

import * as fs from 'fs';
import * as path from 'path';

interface TurnEntry {
  turn: number;
  playerId: string;
  playerName?: string;
  timestamp?: string;
  positionStart?: { row: number; col: number; cityName?: string } | null;
  positionEnd?: { row: number; col: number; cityName?: string } | null;
  movementPath?: { row: number; col: number }[];
  carriedLoads?: string[];
  trainSpeed?: number;
  trainCapacity?: number;
  train?: string;
  connectedMajorCities?: string[];
  activeRoute?: { stops: Array<{ action: string; loadType: string; city: string }>; currentStopIndex: number };
  demandCards?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; cardIndex: number }>;
  demandRanking?: object;
  handQuality?: number | object;
  action: string;
  reasoning?: string;
  planHorizon?: string;
  model?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };
  llmLog?: Array<{ attemptNumber: number; status: string; responseText?: string; error?: string; latencyMs: number }>;
  tripPlanning?: object;
  advisorAction?: string;
  advisorReasoning?: string;
  advisorLatencyMs?: number;
  solvencyRetries?: number;
  guardrailOverride?: boolean;
  guardrailReason?: string;
  gamePhase?: string;
  cash?: number;
  success: boolean;
  error?: string;
  segmentsBuilt?: number;
  cost?: number;
  buildTargetCity?: string;
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number }>;
  milepostsMoved?: number;
  trackUsageFee?: number;
  durationMs?: number;
  composition?: { deliveries?: Array<{ load: string; city: string }>; [key: string]: any };
  secondaryDelivery?: object;
  turnValidation?: { hardGates: Array<{ gate: string; passed: boolean; detail?: string }>; outcome: string; recomposeCount: number };
}

function loadLog(filePath: string): TurnEntry[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as TurnEntry[];
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function pct(num: number, den: number): string {
  if (den === 0) return 'N/A';
  return (100 * num / den).toFixed(1) + '%';
}

interface Delivery {
  loadType: string;
  city: string;
  payment: number;
}

/** Extract deliveries from either loadsDelivered (preferred) or composition.deliveries (fallback) */
function getDeliveries(entry: TurnEntry, prevCash?: number): Delivery[] {
  // Prefer top-level loadsDelivered (has payment info)
  if (entry.loadsDelivered && entry.loadsDelivered.length > 0) {
    return entry.loadsDelivered.map(d => ({ loadType: d.loadType, city: d.city, payment: d.payment }));
  }
  // Fallback: composition.deliveries (no payment — infer from cash delta)
  const compDeliveries = entry.composition?.deliveries;
  if (compDeliveries && compDeliveries.length > 0) {
    const cashDelta = (entry.cash ?? 0) - (prevCash ?? entry.cash ?? 0);
    // Also account for track cost spent this turn
    const buildCost = entry.action === 'BuildTrack' ? (entry.cost ?? 0) : 0;
    const totalPayment = Math.max(0, cashDelta + buildCost);
    const perDelivery = compDeliveries.length > 0 ? Math.round(totalPayment / compDeliveries.length) : 0;
    return compDeliveries.map(d => ({ loadType: d.load, city: d.city, payment: perDelivery }));
  }
  return [];
}

/** Build a delivery list for all entries, using previous-turn cash for payment inference */
function getAllDeliveries(entries: TurnEntry[]): Array<{ turn: number } & Delivery> {
  const result: Array<{ turn: number } & Delivery> = [];
  for (let i = 0; i < entries.length; i++) {
    const prevCash = i > 0 ? entries[i - 1].cash : entries[i].cash;
    const deliveries = getDeliveries(entries[i], prevCash);
    for (const d of deliveries) {
      result.push({ turn: entries[i].turn, ...d });
    }
  }
  return result;
}

/** Get total income from deliveries across all entries */
function getTotalIncome(entries: TurnEntry[]): number {
  return getAllDeliveries(entries).reduce((s, d) => s + d.payment, 0);
}

/** Check if a turn has deliveries */
function hasDeliveries(entry: TurnEntry, prevCash?: number): boolean {
  return getDeliveries(entry, prevCash).length > 0;
}

function isLlmModel(model: string | undefined): boolean {
  if (!model) return false;
  return !['heuristic-fallback', 'broke-bot-heuristic', 'pipeline-error', 'llm-failed', 'route-executor'].includes(model);
}

function isPlayingPhase(entry: TurnEntry): boolean {
  return entry.gamePhase !== 'initial_build';
}

function groupByPlayer(entries: TurnEntry[]): Map<string, TurnEntry[]> {
  const map = new Map<string, TurnEntry[]>();
  for (const e of entries) {
    const name = e.playerName ?? e.playerId;
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(e);
  }
  return map;
}

function findNearestTurn(entries: TurnEntry[], targetTurn: number): TurnEntry | undefined {
  let best: TurnEntry | undefined;
  let bestDist = Infinity;
  for (const e of entries) {
    const d = Math.abs(e.turn - targetTurn);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

// ─── Section 1: Turn Composition Quality ─────────────────────────────────────

function sectionTurnComposition(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const playing = entries.filter(isPlayingPhase);

  // Wasted movement budget
  const wastedTurns: Array<{ turn: number; moved: number; max: number; action: string; reasoning: string }> = [];
  let zeroMoveTurns = 0;
  let noRouteTurns = 0;

  for (const e of playing) {
    const speed = e.trainSpeed ?? 9;
    const moved = e.milepostsMoved ?? 0;
    const waste = speed - moved;
    if (moved === 0 && e.action !== 'BuildTrack' && e.action !== 'DiscardHand' && e.action !== 'PassTurn') {
      zeroMoveTurns++;
    }
    if (moved === 0 && e.action === 'MoveTrain') {
      zeroMoveTurns++;
    }
    if (e.action === 'MoveTrain' && (!e.activeRoute || !e.activeRoute.stops || e.activeRoute.stops.length === 0)) {
      noRouteTurns++;
    }
    if (waste > 0 && e.action === 'MoveTrain') {
      wastedTurns.push({ turn: e.turn, moved, max: speed, action: e.action, reasoning: (e.reasoning ?? '').substring(0, 80) });
    }
  }

  wastedTurns.sort((a, b) => (b.max - b.moved) - (a.max - a.moved));
  const worst5 = wastedTurns.slice(0, 5);

  if (worst5.length > 0) {
    lines.push('**Worst turns by wasted movement:**');
    lines.push('');
    lines.push('| Turn | Moved | Max | Wasted | Reasoning |');
    lines.push('|------|-------|-----|--------|-----------|');
    for (const t of worst5) {
      lines.push(`| ${t.turn} | ${t.moved} | ${t.max} | ${t.max - t.moved} | ${t.reasoning} |`);
    }
    lines.push('');
  }

  lines.push(`- Turns moved with no active route: ${noRouteTurns}`);
  lines.push(`- Zero-movement turns (playing phase): ${zeroMoveTurns}`);
  lines.push(`- Total wasted-movement turns: ${wastedTurns.length} of ${playing.filter(e => e.action === 'MoveTrain').length} move turns`);
  lines.push('');

  return lines;
}

// ─── Section 2: Track Building Efficiency ────────────────────────────────────

function sectionTrackBuilding(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const last = entries[entries.length - 1];
  const finalCities = last?.connectedMajorCities ?? [];
  lines.push(`- Final connected major cities (${finalCities.length}): ${finalCities.join(', ') || 'none'}`);

  const buildTurns = entries.filter(e => e.action === 'BuildTrack');
  const totalBuildCost = buildTurns.reduce((s, e) => s + (e.cost ?? 0), 0);
  const totalIncome = getTotalIncome(entries);
  const underBuilt = buildTurns.filter(e => (e.cost ?? 0) < 20 && (e.cost ?? 0) > 0);

  lines.push(`- Total track cost: ${fmt(totalBuildCost)}M`);
  lines.push(`- Total income: ${fmt(totalIncome)}M`);
  lines.push(`- Track spend as % of income: ${pct(totalBuildCost, totalIncome)}`);
  lines.push(`- Under-built turns (cost < 20M): ${underBuilt.length}`);
  lines.push('');

  // Build targets over time
  const targets = buildTurns
    .filter(e => e.buildTargetCity)
    .map(e => `T${e.turn}:${e.buildTargetCity}`);
  if (targets.length > 0) {
    lines.push(`- Build targets: ${targets.join(', ')}`);
    lines.push('');
  }

  return lines;
}

// ─── Section 3: Demand Selection & Routing ───────────────────────────────────

function sectionDemandSelection(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  // Deliveries
  const deliveries = getAllDeliveries(entries);

  if (deliveries.length > 0) {
    lines.push('**Deliveries:**');
    lines.push('');
    lines.push('| Turn | Load | City | Payment |');
    lines.push('|------|------|------|---------|');
    for (const d of deliveries) {
      lines.push(`| ${d.turn} | ${d.loadType} | ${d.city} | ${d.payment}M |`);
    }
    lines.push('');
  } else {
    lines.push('- No deliveries recorded.');
    lines.push('');
  }

  // Abandoned loads: picked up but never delivered
  const pickedUp: Array<{ turn: number; loadType: string; city: string }> = [];
  for (const e of entries) {
    for (const p of e.loadsPickedUp ?? []) {
      pickedUp.push({ turn: e.turn, ...p });
    }
  }
  const deliveredTypes = new Set(deliveries.map(d => d.loadType));
  const abandoned = pickedUp.filter(p => !deliveredTypes.has(p.loadType));
  if (abandoned.length > 0) {
    lines.push(`**Potentially abandoned loads** (picked up but never delivered): ${abandoned.map(a => `${a.loadType}@${a.city} (T${a.turn})`).join(', ')}`);
    lines.push('');
  }

  // Near-bankrupt turns
  const nearBankrupt = entries.filter(e => e.cash != null && e.cash >= 0 && e.cash <= 5);
  if (nearBankrupt.length > 0) {
    lines.push(`- Near-bankrupt turns (cash 0-5M): ${nearBankrupt.map(e => `T${e.turn}($${e.cash}M)`).join(', ')}`);
    lines.push('');
  }

  return lines;
}

// ─── Section 4: Income & Economy ─────────────────────────────────────────────

function sectionIncome(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const allDeliveries = getAllDeliveries(entries);
  const totalPayoffs = allDeliveries.reduce((s, d) => s + d.payment, 0);
  const totalTurns = entries.length;
  const avgPerTurn = totalTurns > 0 ? totalPayoffs / totalTurns : 0;

  // Turns with income
  const deliveryTurnNumbers = new Set(allDeliveries.map(d => d.turn));
  const turnsWithIncome = entries.filter(e => deliveryTurnNumbers.has(e.turn));
  const incomeExclZero = turnsWithIncome.length > 0 ? totalPayoffs / turnsWithIncome.length : 0;

  // First delivery turn
  const firstDelivery = allDeliveries.length > 0 ? entries.find(e => e.turn === allDeliveries[0].turn) : undefined;

  lines.push(`- Total payoffs: ${fmt(totalPayoffs)}M`);
  lines.push(`- Avg income/turn: ${avgPerTurn.toFixed(1)}M`);
  lines.push(`- Avg income (delivery turns only): ${incomeExclZero.toFixed(1)}M`);
  lines.push(`- First delivery: ${firstDelivery ? `Turn ${firstDelivery.turn}` : 'Never'}`);
  lines.push('');

  // Cash at milestones
  const milestones = [10, 20, 30, 40, 50];
  const cashAtMilestone: string[] = [];
  for (const m of milestones) {
    const nearest = findNearestTurn(entries, m);
    if (nearest && nearest.cash != null) {
      cashAtMilestone.push(`T${nearest.turn}: $${nearest.cash}M`);
    }
  }
  if (cashAtMilestone.length > 0) {
    lines.push(`- Cash milestones: ${cashAtMilestone.join(' | ')}`);
    lines.push('');
  }

  // Zero-income streaks
  const streaks: Array<{ start: number; end: number; actions: string[] }> = [];
  let streakStart = -1;
  let streakActions: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const hasIncome = deliveryTurnNumbers.has(entries[i].turn);
    if (!hasIncome) {
      if (streakStart === -1) { streakStart = i; streakActions = []; }
      streakActions.push(entries[i].action);
    } else {
      if (streakStart !== -1 && (i - streakStart) >= 5) {
        streaks.push({ start: entries[streakStart].turn, end: entries[i - 1].turn, actions: streakActions });
      }
      streakStart = -1;
    }
  }
  if (streakStart !== -1 && (entries.length - streakStart) >= 5) {
    streaks.push({ start: entries[streakStart].turn, end: entries[entries.length - 1].turn, actions: streakActions });
  }

  if (streaks.length > 0) {
    lines.push('**Zero-income streaks (5+ turns):**');
    lines.push('');
    for (const s of streaks) {
      const actionCounts: Record<string, number> = {};
      for (const a of s.actions) { actionCounts[a] = (actionCounts[a] ?? 0) + 1; }
      const actionSummary = Object.entries(actionCounts).map(([a, c]) => `${a}:${c}`).join(', ');
      lines.push(`- T${s.start}-T${s.end} (${s.actions.length} turns): ${actionSummary}`);
    }
    lines.push('');
  }

  // Cash over time table
  lines.push('**Cash over time (every 5 turns):**');
  lines.push('');
  lines.push('| Turn | Delivery | Cash |');
  lines.push('|------|----------|------|');
  for (let t = 1; t <= (entries[entries.length - 1]?.turn ?? 0); t += 5) {
    const nearest = findNearestTurn(entries, t);
    if (nearest && nearest.cash != null) {
      const prevCash = findNearestTurn(entries, t - 5)?.cash;
      const turnDeliveries = getDeliveries(nearest, prevCash);
      const delivery = turnDeliveries.map(d => `${d.loadType}(+${d.payment}M)`).join(', ') || '-';
      lines.push(`| ${nearest.turn} | ${delivery} | $${nearest.cash}M |`);
    }
  }
  lines.push('');

  return lines;
}

// ─── Section 5: Movement & Pathfinding ───────────────────────────────────────

function sectionMovement(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const playing = entries.filter(isPlayingPhase);
  let totalMoved = 0;
  let totalAvailable = 0;
  let zeroMoveTurns = 0;
  let totalTrackFees = 0;

  for (const e of playing) {
    const speed = e.trainSpeed ?? 9;
    const moved = e.milepostsMoved ?? 0;
    totalMoved += moved;
    totalAvailable += speed;
    if (moved === 0) zeroMoveTurns++;
    totalTrackFees += e.trackUsageFee ?? 0;
  }

  const avgMoved = playing.length > 0 ? totalMoved / playing.length : 0;
  const avgSpeed = playing.length > 0 ? totalAvailable / playing.length : 0;

  lines.push(`- Avg mileposts/turn: ${avgMoved.toFixed(1)} vs ${avgSpeed.toFixed(1)} available`);
  lines.push(`- Movement efficiency: ${pct(totalMoved, totalAvailable)}`);
  lines.push(`- Zero-movement turns: ${zeroMoveTurns} of ${playing.length}`);
  lines.push(`- Total track usage fees: ${fmt(totalTrackFees)}M`);
  lines.push('');

  // Position loops
  const posLoops: Array<{ turn: number; pos: string }> = [];
  for (let i = 0; i < playing.length; i++) {
    const e = playing[i];
    if (!e.positionEnd) continue;
    const pos = `${e.positionEnd.row},${e.positionEnd.col}`;
    for (let j = Math.max(0, i - 5); j < i; j++) {
      const prev = playing[j];
      if (prev.positionEnd && `${prev.positionEnd.row},${prev.positionEnd.col}` === pos) {
        posLoops.push({ turn: e.turn, pos: e.positionEnd.cityName ?? pos });
        break;
      }
    }
  }

  if (posLoops.length > 0) {
    lines.push(`- Position loops detected (same position within 5 turns): ${posLoops.slice(0, 10).map(l => `T${l.turn}@${l.pos}`).join(', ')}${posLoops.length > 10 ? ` (+${posLoops.length - 10} more)` : ''}`);
    lines.push('');
  }

  return lines;
}

// ─── Section 6: Train Upgrades ───────────────────────────────────────────────

function sectionTrainUpgrades(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const upgrades: Array<{ turn: number; cash: number; before: string; after: string }> = [];
  let prevTrain = entries[0]?.train ?? 'Freight';
  for (const e of entries) {
    const current = e.train ?? prevTrain;
    if (current !== prevTrain) {
      upgrades.push({ turn: e.turn, cash: e.cash ?? 0, before: prevTrain, after: current });
      prevTrain = current;
    }
  }

  if (upgrades.length > 0) {
    lines.push('**Upgrades:**');
    lines.push('');
    lines.push('| Turn | Cash | Before | After |');
    lines.push('|------|------|--------|-------|');
    for (const u of upgrades) {
      lines.push(`| ${u.turn} | $${u.cash}M | ${u.before} | ${u.after} |`);
    }
    lines.push('');
  } else {
    lines.push(`- No upgrades. Train type: ${prevTrain} for entire game.`);
    lines.push('');
  }

  // Movement utilization
  const playing = entries.filter(isPlayingPhase);
  let totalMoved = 0;
  let totalSpeed = 0;
  for (const e of playing) {
    totalMoved += e.milepostsMoved ?? 0;
    totalSpeed += e.trainSpeed ?? 9;
  }
  const utilization = totalSpeed > 0 ? (100 * totalMoved / totalSpeed) : 0;
  lines.push(`- Movement utilization: ${utilization.toFixed(1)}%${utilization > 80 ? ' (movement-constrained)' : ''}`);
  lines.push('');

  return lines;
}

// ─── Section 7: Hand Management ──────────────────────────────────────────────

function sectionHandManagement(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const discards = entries.filter(e => e.action === 'DiscardHand');
  lines.push(`- DiscardHand actions: ${discards.length}`);

  if (discards.length > 0) {
    lines.push(`- Discard turns: ${discards.map(e => `T${e.turn}`).join(', ')}`);
    lines.push('');
    for (const d of discards) {
      // Find previous turn's demands
      const idx = entries.indexOf(d);
      const prev = idx > 0 ? entries[idx - 1] : null;
      if (prev?.demandCards) {
        const demands = prev.demandCards.map(c => `${c.loadType}:${c.supplyCity}->${c.deliveryCity}($${c.payout}M)`).join(', ');
        lines.push(`  - T${d.turn} discarded: ${demands}`);
      }
    }
    lines.push('');
  }

  // Stale demands (same cardIndex for 10+ turns)
  const cardStreaks: Map<number, number> = new Map();
  const staleCards: Array<{ cardIndex: number; duration: number; desc: string }> = [];
  let prevCardIndices: Set<number> = new Set();
  let streakCounts: Map<number, number> = new Map();

  for (const e of entries) {
    if (!e.demandCards) continue;
    const currentIndices = new Set(e.demandCards.map(c => c.cardIndex));
    for (const idx of currentIndices) {
      if (prevCardIndices.has(idx)) {
        streakCounts.set(idx, (streakCounts.get(idx) ?? 1) + 1);
      } else {
        // Check if previous streak was long enough
        const prev = streakCounts.get(idx);
        if (prev && prev >= 10) {
          const card = e.demandCards.find(c => c.cardIndex === idx);
          staleCards.push({ cardIndex: idx, duration: prev, desc: card ? `${card.loadType}:${card.deliveryCity}` : `card#${idx}` });
        }
        streakCounts.set(idx, 1);
      }
    }
    // Check ended streaks
    for (const idx of prevCardIndices) {
      if (!currentIndices.has(idx)) {
        const count = streakCounts.get(idx) ?? 0;
        if (count >= 10) {
          staleCards.push({ cardIndex: idx, duration: count, desc: `card#${idx}` });
        }
        streakCounts.delete(idx);
      }
    }
    prevCardIndices = currentIndices;
  }
  // Check remaining
  for (const [idx, count] of streakCounts) {
    if (count >= 10) {
      staleCards.push({ cardIndex: idx, duration: count, desc: `card#${idx}` });
    }
  }

  if (staleCards.length > 0) {
    lines.push(`**Stale demands (held 10+ turns):** ${staleCards.map(s => `${s.desc} (${s.duration} turns)`).join(', ')}`);
    lines.push('');
  }

  return lines;
}

// ─── Section 8: Death Spirals & Stuck Detection ─────────────────────────────

function sectionDeathSpirals(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  // Cash = 0 turns
  const zeroTurns = entries.filter(e => e.cash === 0);
  lines.push(`- Turns at $0: ${zeroTurns.length}`);

  // Consecutive $0 ranges
  if (zeroTurns.length > 0) {
    const ranges: Array<{ start: number; end: number }> = [];
    let rangeStart = -1;
    let lastTurn = -1;
    for (const e of entries) {
      if (e.cash === 0) {
        if (rangeStart === -1) rangeStart = e.turn;
        lastTurn = e.turn;
      } else {
        if (rangeStart !== -1) {
          ranges.push({ start: rangeStart, end: lastTurn });
          rangeStart = -1;
        }
      }
    }
    if (rangeStart !== -1) ranges.push({ start: rangeStart, end: lastTurn });
    if (ranges.length > 0) {
      lines.push(`- $0 ranges: ${ranges.map(r => `T${r.start}-T${r.end}`).join(', ')}`);
    }
  }

  // Guardrail overrides
  const guardrails = entries.filter(e => e.guardrailOverride === true);
  lines.push(`- Guardrail overrides: ${guardrails.length}`);
  if (guardrails.length > 0) {
    for (const g of guardrails.slice(0, 10)) {
      lines.push(`  - T${g.turn}: ${g.guardrailReason ?? 'unknown'}`);
    }
    if (guardrails.length > 10) lines.push(`  - (+${guardrails.length - 10} more)`);
  }

  // Consecutive heuristic fallback
  let maxFallbackStreak = 0;
  let currentStreak = 0;
  let fallbackStreakStart = 0;
  let worstFallbackRange = '';
  for (const e of entries) {
    if (e.model === 'heuristic-fallback') {
      if (currentStreak === 0) fallbackStreakStart = e.turn;
      currentStreak++;
      if (currentStreak > maxFallbackStreak) {
        maxFallbackStreak = currentStreak;
        worstFallbackRange = `T${fallbackStreakStart}-T${e.turn}`;
      }
    } else {
      currentStreak = 0;
    }
  }
  const totalFallback = entries.filter(e => e.model === 'heuristic-fallback').length;
  lines.push(`- Heuristic fallback turns: ${totalFallback} (longest streak: ${maxFallbackStreak}${worstFallbackRange ? ` at ${worstFallbackRange}` : ''})`);

  // Pickup-drop loops
  let pickupDropLoops = 0;
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    if (!curr.loadsPickedUp?.length || !prev.carriedLoads?.length) continue;
    for (const pickup of curr.loadsPickedUp) {
      // Was this load carried last turn but disappeared (dropped)?
      if (prev.carriedLoads.includes(pickup.loadType) && !(curr.carriedLoads ?? []).includes(pickup.loadType)) {
        pickupDropLoops++;
      }
    }
  }
  lines.push(`- Pickup-drop loops detected: ${pickupDropLoops}`);
  lines.push('');

  return lines;
}

// ─── Section 9: Head-to-Head Comparison ──────────────────────────────────────

function sectionHeadToHead(playerMap: Map<string, TurnEntry[]>): string[] {
  const lines: string[] = [];

  lines.push('| Player | Deliveries | Income | Final Cash | Avg/Turn | Segments | Build Cost | Cities | Train | Move Eff% | Victory? |');
  lines.push('|--------|-----------|--------|------------|----------|----------|------------|--------|-------|-----------|----------|');

  for (const [name, entries] of playerMap) {
    const playerDeliveries = getAllDeliveries(entries);
    const totalDeliveries = playerDeliveries.length;
    const totalIncome = playerDeliveries.reduce((s, d) => s + d.payment, 0);
    const finalCash = entries[entries.length - 1]?.cash ?? 0;
    const avgPerTurn = entries.length > 0 ? (totalIncome / entries.length).toFixed(1) : '0';
    const totalSegments = entries.reduce((s, e) => s + (e.segmentsBuilt ?? 0), 0);
    const totalBuildCost = entries.filter(e => e.action === 'BuildTrack').reduce((s, e) => s + (e.cost ?? 0), 0);
    const finalCities = entries[entries.length - 1]?.connectedMajorCities ?? [];
    const finalTrain = entries[entries.length - 1]?.train ?? 'Freight';

    const playing = entries.filter(isPlayingPhase);
    let totalMoved = 0;
    let totalAvail = 0;
    for (const e of playing) {
      totalMoved += e.milepostsMoved ?? 0;
      totalAvail += e.trainSpeed ?? 9;
    }
    const moveEff = totalAvail > 0 ? (100 * totalMoved / totalAvail).toFixed(1) : 'N/A';

    const victory = finalCities.length >= 7 && finalCash >= 250 ? 'YES' : `${finalCities.length}/7 cities, $${finalCash}M`;

    lines.push(`| ${name} | ${totalDeliveries} | ${fmt(totalIncome)}M | $${fmt(finalCash)}M | ${avgPerTurn}M | ${totalSegments} | ${fmt(totalBuildCost)}M | ${finalCities.length} | ${finalTrain} | ${moveEff} | ${victory} |`);
  }
  lines.push('');

  return lines;
}

// ─── Section 10: LLM Interaction Analysis ────────────────────────────────────

function sectionLlmAnalysis(name: string, entries: TurnEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`#### ${name}`);
  lines.push('');

  const llmEntries = entries.filter(e => isLlmModel(e.model));
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let totalRetries = 0;
  let totalFailures = 0;
  let buildPhaseCount = 0;

  for (const e of llmEntries) {
    if (e.tokenUsage) { totalTokensIn += e.tokenUsage.input; totalTokensOut += e.tokenUsage.output; }
    if (e.llmLatencyMs) { totalLatency += e.llmLatencyMs; latencyCount++; }
    if (!isPlayingPhase(e)) buildPhaseCount++;
  }

  for (const e of entries) {
    if (e.llmLog) {
      if (e.llmLog.length > 1) totalRetries += e.llmLog.length - 1;
      totalFailures += e.llmLog.filter(a => a.status !== 'success').length;
    }
  }

  const avgLatency = latencyCount > 0 ? (totalLatency / latencyCount / 1000).toFixed(1) + 's' : 'N/A';

  lines.push(`- Total LLM calls: ${llmEntries.length}`);
  lines.push(`- Total tokens: ${fmt(totalTokensIn)} in / ${fmt(totalTokensOut)} out`);
  lines.push(`- Total retries: ${totalRetries}`);
  lines.push(`- Total failures: ${totalFailures}`);
  lines.push(`- Avg latency: ${avgLatency}`);
  lines.push(`- LLM calls during initial_build: ${buildPhaseCount}`);
  lines.push('');

  // LLM calls table (first 20)
  if (llmEntries.length > 0) {
    const showEntries = llmEntries.slice(0, 20);
    lines.push('**LLM calls:**');
    lines.push('');
    lines.push('| Turn | Model | Action | Latency | Tokens In | Tokens Out |');
    lines.push('|------|-------|--------|---------|-----------|------------|');
    for (const e of showEntries) {
      const model = e.model ?? '?';
      const lat = e.llmLatencyMs ? (e.llmLatencyMs / 1000).toFixed(1) + 's' : '?';
      const tokIn = e.tokenUsage?.input ?? '-';
      const tokOut = e.tokenUsage?.output ?? '-';
      lines.push(`| ${e.turn} | ${model} | ${e.action} | ${lat} | ${fmt(Number(tokIn))} | ${fmt(Number(tokOut))} |`);
    }
    if (llmEntries.length > 20) {
      lines.push(`| ... | (${llmEntries.length - 20} more calls truncated) | | | | |`);
    }
    lines.push('');
  }

  return lines;
}

// ─── Section 11: Suggested Improvements ──────────────────────────────────────

function sectionSuggestedImprovements(playerMap: Map<string, TurnEntry[]>): string[] {
  const lines: string[] = [];
  const issues: Array<{ problem: string; severity: string; module: string; fix: string }> = [];

  for (const [name, entries] of playerMap) {
    const playing = entries.filter(isPlayingPhase);

    // Check movement waste
    const moveTurns = playing.filter(e => e.action === 'MoveTrain');
    let totalWaste = 0;
    for (const e of moveTurns) {
      totalWaste += (e.trainSpeed ?? 9) - (e.milepostsMoved ?? 0);
    }
    const avgWaste = moveTurns.length > 0 ? totalWaste / moveTurns.length : 0;
    if (avgWaste > 3) {
      issues.push({
        problem: `${name}: High avg movement waste (${avgWaste.toFixed(1)} mileposts/turn)`,
        severity: 'High',
        module: 'TurnComposer',
        fix: 'Improve pathfinding to minimize wasted movement budget; check for unnecessary stops.',
      });
    }

    // Check zero-income streaks
    let streak = 0;
    let worstStreak = 0;
    let worstStart = 0;
    for (let i = 0; i < entries.length; i++) {
      const prevCash = i > 0 ? entries[i - 1].cash : entries[i].cash;
      if (!hasDeliveries(entries[i], prevCash)) {
        streak++;
        if (streak > worstStreak) { worstStreak = streak; worstStart = entries[i - streak + 1]?.turn ?? 0; }
      } else {
        streak = 0;
      }
    }
    if (worstStreak >= 10) {
      issues.push({
        problem: `${name}: ${worstStreak}-turn zero-income streak starting T${worstStart}`,
        severity: 'High',
        module: 'RouteValidator',
        fix: 'Detect income stalls and trigger route re-evaluation or hand discard.',
      });
    }

    // Check guardrail overrides
    const guardrails = entries.filter(e => e.guardrailOverride === true);
    if (guardrails.length >= 3) {
      issues.push({
        problem: `${name}: ${guardrails.length} guardrail overrides (T${guardrails.map(g => g.turn).join(', T')})`,
        severity: 'Medium',
        module: 'TurnComposer',
        fix: 'Investigate why LLM output requires repeated guardrail corrections.',
      });
    }

    // Check fallback usage
    const fallbacks = entries.filter(e => e.model === 'heuristic-fallback');
    if (fallbacks.length > entries.length * 0.2) {
      issues.push({
        problem: `${name}: ${fallbacks.length}/${entries.length} turns used heuristic fallback (${pct(fallbacks.length, entries.length)})`,
        severity: 'High',
        module: 'LLM Pipeline',
        fix: 'Reduce LLM failures causing fallback; check prompt quality and model reliability.',
      });
    }

    // No upgrades check
    const lastTrain = entries[entries.length - 1]?.train ?? 'Freight';
    if (lastTrain === 'Freight' && entries.length > 30) {
      issues.push({
        problem: `${name}: Never upgraded from Freight over ${entries.length} turns`,
        severity: 'Medium',
        module: 'TurnComposer',
        fix: 'Consider triggering upgrade earlier when cash allows; Freight limits movement to 9 mileposts.',
      });
    }

    // Under-built turns
    const buildTurns = entries.filter(e => e.action === 'BuildTrack');
    const underBuilt = buildTurns.filter(e => (e.cost ?? 0) < 10 && (e.cost ?? 0) > 0);
    if (underBuilt.length > buildTurns.length * 0.3 && buildTurns.length > 5) {
      issues.push({
        problem: `${name}: ${underBuilt.length}/${buildTurns.length} build turns spent <10M (under-building)`,
        severity: 'Medium',
        module: 'BuildAdvisor',
        fix: 'Maximize build budget usage per turn to accelerate network growth.',
      });
    }

    // Position loops
    const positionLoops: number[] = [];
    const playingEntries = entries.filter(isPlayingPhase);
    for (let i = 0; i < playingEntries.length; i++) {
      const e = playingEntries[i];
      if (!e.positionEnd) continue;
      const pos = `${e.positionEnd.row},${e.positionEnd.col}`;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const prev = playingEntries[j];
        if (prev.positionEnd && `${prev.positionEnd.row},${prev.positionEnd.col}` === pos) {
          positionLoops.push(e.turn);
          break;
        }
      }
    }
    if (positionLoops.length >= 5) {
      issues.push({
        problem: `${name}: ${positionLoops.length} position loops detected (revisiting same milepost within 3 turns)`,
        severity: 'Medium',
        module: 'RouteValidator',
        fix: 'Detect oscillating movement patterns and break loops with route recalculation.',
      });
    }
  }

  if (issues.length === 0) {
    lines.push('No significant issues detected.');
    lines.push('');
    return lines;
  }

  // Sort by severity
  const sevOrder: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
  issues.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));

  lines.push('| # | Severity | Module | Problem | Suggested Fix |');
  lines.push('|---|----------|--------|---------|---------------|');
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    lines.push(`| ${i + 1} | ${issue.severity} | ${issue.module} | ${issue.problem} | ${issue.fix} |`);
  }
  lines.push('');

  return lines;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: npx tsx scripts/game-analysis.ts <game-id> [options]');
    console.log('  --player <name>    Filter to a single bot');
    console.log('  --out <file>       Write to file instead of stdout');
    process.exit(0);
  }

  const gameId = args[0];
  let playerFilter: string | null = null;
  let outFile: string | null = null;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--player': playerFilter = args[++i]; break;
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

  let entries = loadLog(path.join(logsDir, logFile));

  if (playerFilter) {
    const pf = playerFilter.toLowerCase();
    entries = entries.filter(e => (e.playerName ?? e.playerId).toLowerCase().includes(pf));
  }

  if (entries.length === 0) {
    console.error('No matching turns found.');
    process.exit(1);
  }

  const playerMap = groupByPlayer(entries);
  const players = [...playerMap.keys()];
  const output: string[] = [];

  output.push(`# Game Analysis: ${gameId}`);
  output.push('');
  output.push(`- **Log file**: ${logFile}`);
  output.push(`- **Total entries**: ${entries.length}`);
  output.push(`- **Players**: ${players.join(', ')}`);
  output.push(`- **Turn range**: ${entries[0].turn}-${entries[entries.length - 1].turn}`);
  output.push('');

  // Section 1
  output.push('## 1. Turn Composition Quality');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionTurnComposition(name, pEntries));
  }

  // Section 2
  output.push('## 2. Track Building Efficiency');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionTrackBuilding(name, pEntries));
  }

  // Section 3
  output.push('## 3. Demand Selection & Routing');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionDemandSelection(name, pEntries));
  }

  // Section 4
  output.push('## 4. Income & Economy');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionIncome(name, pEntries));
  }

  // Section 5
  output.push('## 5. Movement & Pathfinding');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionMovement(name, pEntries));
  }

  // Section 6
  output.push('## 6. Train Upgrades');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionTrainUpgrades(name, pEntries));
  }

  // Section 7
  output.push('## 7. Hand Management');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionHandManagement(name, pEntries));
  }

  // Section 8
  output.push('## 8. Death Spirals & Stuck Detection');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionDeathSpirals(name, pEntries));
  }

  // Section 9
  output.push('## 9. Head-to-Head Comparison');
  output.push('');
  output.push(...sectionHeadToHead(playerMap));

  // Section 10
  output.push('## 10. LLM Interaction Analysis');
  output.push('');
  for (const [name, pEntries] of playerMap) {
    output.push(...sectionLlmAnalysis(name, pEntries));
  }

  // Section 11
  output.push('## 11. Suggested Improvements');
  output.push('');
  output.push(...sectionSuggestedImprovements(playerMap));

  const text = output.join('\n');

  if (outFile) {
    fs.writeFileSync(outFile, text, 'utf8');
    console.log(`Written to ${outFile}`);
  } else {
    console.log(text);
  }
}

run();
