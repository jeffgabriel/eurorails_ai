/**
 * logRoutes — Express routes for browsing game logs and LLM transcripts.
 *
 * Dev-only debugging tool. No auth required. All HTML is self-contained
 * with inline CSS and vanilla JS.
 */

import express from 'express';
import {
  isValidGameId,
  listGameLogs,
  loadGameLog,
  loadLLMTranscript,
  inferDecisionSource,
  isLlmModel,
  fmt,
  secs,
  loc,
} from '../services/logParser';
import { GameTurnLogEntry } from '../services/ai/GameLogger';

const router = express.Router();

// ─── GET /logs — Game log index page ─────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const logs = listGameLogs();
    const rows = logs.map(log => `
      <tr>
        <td><a href="/logs/${log.gameId}">${log.gameId.slice(0, 8)}…</a></td>
        <td>${log.turnCount}</td>
        <td>${log.players.join(', ')}</td>
        <td>${log.models.join(', ') || '—'}</td>
        <td>${log.lastModified.toLocaleDateString()} ${log.lastModified.toLocaleTimeString()}</td>
        <td><a href="/logs/llm/${log.gameId}">LLM</a></td>
      </tr>
    `).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game Logs</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #1a1a2e; color: #eee; padding: 24px; }
  h1 { margin-bottom: 16px; color: #e94560; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #333; }
  th { background: #16213e; color: #0f3460; font-weight: 600; color: #e94560; }
  tr:hover { background: #16213e; }
  a { color: #0f9ef7; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { padding: 40px; text-align: center; color: #888; }
</style>
</head>
<body>
<h1>Game Logs</h1>
${logs.length === 0
  ? '<div class="empty">No game logs found in logs/ directory.</div>'
  : `<table>
  <thead><tr><th>Game ID</th><th>Turns</th><th>Players</th><th>Models</th><th>Last Modified</th><th>Links</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`}
</body>
</html>`);
  } catch (error) {
    console.error('[logRoutes] Error listing game logs:', error);
    res.status(500).json({ error: 'SERVER_ERROR', details: 'Failed to list game logs' });
  }
});

// ─── GET /api/log/:gameId — Raw JSON game log ──────────────────────────────

router.get('/api/log/:gameId', (req, res) => {
  const { gameId } = req.params;
  if (!isValidGameId(gameId)) {
    return res.status(400).json({ error: 'INVALID_GAME_ID', details: 'Game ID must contain only hex characters and hyphens' });
  }
  const entries = loadGameLog(gameId);
  if (entries === null) {
    return res.status(404).json({ error: 'LOG_NOT_FOUND', details: `No log file found for game ${gameId}` });
  }
  return res.json(entries);
});

// ─── GET /:gameId — HTML turn-by-turn viewer ─────────────────────────────────

router.get('/:gameId', (req, res) => {
  const { gameId } = req.params;
  if (!isValidGameId(gameId)) {
    return res.status(400).json({ error: 'INVALID_GAME_ID', details: 'Game ID must contain only hex characters and hyphens' });
  }
  const entries = loadGameLog(gameId);
  if (entries === null) {
    return res.status(404).type('html').send(`<!DOCTYPE html>
<html><head><title>Log Not Found</title>
<style>body{font-family:monospace;background:#1a1a2e;color:#eee;padding:40px;text-align:center;}a{color:#0f9ef7;}</style>
</head><body><h1>Log not found for game ${escapeHtml(gameId)}</h1><p><a href="/logs">← Back to log index</a></p></body></html>`);
  }

  try {
    const turnCards = entries.map((entry, i) => renderTurnCard(entry, i)).join('\n');
    const players = Array.from(new Set(entries.map(e => e.playerName ?? e.playerId)));
    const phases = Array.from(new Set(entries.map(e => e.gamePhase).filter(Boolean)));
    const sources = Array.from(new Set(entries.map(e => inferDecisionSource(e))));
    const models = Array.from(new Set(entries.map(e => e.llmModel).filter((m): m is string => !!m)));
    const stats = computeStats(entries);

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game ${gameId.slice(0, 8)} — Turn Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #1a1a2e; color: #eee; display: flex; min-height: 100vh; }
  .sidebar { width: 280px; background: #16213e; padding: 16px; flex-shrink: 0; overflow-y: auto; position: sticky; top: 0; height: 100vh; }
  .sidebar h2 { color: #e94560; margin-bottom: 12px; font-size: 14px; }
  .sidebar label { display: block; font-size: 12px; color: #aaa; margin: 8px 0 4px; }
  .sidebar select, .sidebar input { width: 100%; padding: 6px 8px; background: #0f3460; border: 1px solid #555; color: #eee; border-radius: 4px; font-size: 13px; }
  .sidebar .stats { margin-top: 20px; padding-top: 12px; border-top: 1px solid #333; }
  .sidebar .stats div { font-size: 12px; color: #aaa; margin: 4px 0; }
  .sidebar .stats span { color: #0f9ef7; font-weight: 600; }
  .sidebar a { color: #0f9ef7; text-decoration: none; font-size: 13px; }
  .sidebar a:hover { text-decoration: underline; }
  .main { flex: 1; padding: 16px 24px; overflow-y: auto; }
  .main h1 { color: #e94560; margin-bottom: 16px; font-size: 20px; }
  .turn-card { border: 2px solid #333; border-radius: 8px; margin-bottom: 12px; padding: 12px 16px; background: #16213e; }
  .turn-card.delivery { border-color: #2ecc71; }
  .turn-card.error { border-color: #e74c3c; }
  .turn-card.guardrail { border-color: #f39c12; }
  .turn-card.llm { border-color: #3498db; }
  .turn-header { display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
  .turn-header h3 { font-size: 14px; }
  .turn-header .badges span { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 4px; }
  .badge-llm { background: #3498db33; color: #3498db; }
  .badge-heuristic { background: #f39c1233; color: #f39c12; }
  .badge-system { background: #95a5a633; color: #95a5a6; }
  .badge-error { background: #e74c3c33; color: #e74c3c; }
  .badge-guardrail { background: #f39c1233; color: #f39c12; }
  .badge-delivery { background: #2ecc7133; color: #2ecc71; }
  .turn-body { margin-top: 8px; }
  details { margin: 6px 0; }
  summary { cursor: pointer; font-size: 13px; color: #aaa; padding: 4px 0; }
  summary:hover { color: #eee; }
  .section { padding: 8px 12px; background: #0f3460; border-radius: 4px; margin-top: 4px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .context-line { font-size: 12px; color: #888; margin: 4px 0; }
  .result-line { font-size: 13px; color: #2ecc71; margin-top: 6px; }
  .error-line { font-size: 13px; color: #e74c3c; margin-top: 6px; }
  .nav-links { margin-bottom: 12px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="sidebar">
  <h2>Filters</h2>
  <a href="/logs">← All Games</a>
  <br><a href="/logs/llm/${gameId}">View LLM Transcript →</a>

  <label for="f-player">Player</label>
  <select id="f-player"><option value="">All</option>${players.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}</select>

  <label for="f-turns">Turn Range</label>
  <input id="f-turns" type="text" placeholder="e.g. 5-15 or 10">

  <label for="f-phase">Game Phase</label>
  <select id="f-phase"><option value="">All</option>${phases.map(p => `<option value="${escapeHtml(p!)}">${escapeHtml(p!)}</option>`).join('')}</select>

  <label for="f-source">Decision Source</label>
  <select id="f-source"><option value="">All</option>${sources.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>

  <label for="f-model">Model</label>
  <select id="f-model"><option value="">All</option>${models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}</select>

  <label for="f-search">Text Search</label>
  <input id="f-search" type="text" placeholder="Search actions, reasoning…">

  <div class="stats">
    <h2>Stats</h2>
    <div>Turns: <span>${entries.length}</span></div>
    <div>LLM Calls: <span>${stats.llmCalls}</span></div>
    <div>Tokens In: <span>${fmt(stats.tokensIn)}</span></div>
    <div>Tokens Out: <span>${fmt(stats.tokensOut)}</span></div>
    <div>Avg Latency: <span>${stats.avgLatency}</span></div>
    <div>Deliveries: <span>${stats.deliveries}</span></div>
    <div>Errors: <span>${stats.errors}</span></div>
  </div>
</div>
<div class="main">
  <h1>Game ${escapeHtml(gameId.slice(0, 8))}… — ${entries.length} Turns</h1>
  <div id="turns">${turnCards}</div>
</div>
<script>
(function() {
  const cards = document.querySelectorAll('.turn-card');
  const filters = {
    player: document.getElementById('f-player'),
    turns: document.getElementById('f-turns'),
    phase: document.getElementById('f-phase'),
    source: document.getElementById('f-source'),
    model: document.getElementById('f-model'),
    search: document.getElementById('f-search'),
  };

  // Load filters from URL params
  const params = new URLSearchParams(window.location.search);
  if (params.get('player')) filters.player.value = params.get('player');
  if (params.get('turns')) filters.turns.value = params.get('turns');
  if (params.get('phase')) filters.phase.value = params.get('phase');
  if (params.get('source')) filters.source.value = params.get('source');
  if (params.get('model')) filters.model.value = params.get('model');
  if (params.get('search')) filters.search.value = params.get('search');

  function applyFilters() {
    const p = filters.player.value.toLowerCase();
    const turnVal = filters.turns.value.trim();
    let tMin = -Infinity, tMax = Infinity;
    if (turnVal) {
      if (turnVal.includes('-')) { const [a, b] = turnVal.split('-').map(Number); tMin = a; tMax = b; }
      else { tMin = tMax = Number(turnVal); }
    }
    const ph = filters.phase.value.toLowerCase();
    const src = filters.source.value.toLowerCase();
    const mdl = filters.model.value.toLowerCase();
    const search = filters.search.value.toLowerCase();

    cards.forEach(card => {
      const d = card.dataset;
      let show = true;
      if (p && d.player.toLowerCase() !== p) show = false;
      if (show && (Number(d.turn) < tMin || Number(d.turn) > tMax)) show = false;
      if (show && ph && (d.phase || '').toLowerCase() !== ph) show = false;
      if (show && src && (d.source || '').toLowerCase() !== src) show = false;
      if (show && mdl && (d.model || '').toLowerCase() !== mdl) show = false;
      if (show && search && !card.textContent.toLowerCase().includes(search)) show = false;
      card.classList.toggle('hidden', !show);
    });

    // Update URL params
    const url = new URL(window.location);
    ['player','turns','phase','source','model','search'].forEach(k => {
      const v = filters[k].value;
      if (v) url.searchParams.set(k, v); else url.searchParams.delete(k);
    });
    history.replaceState(null, '', url);
  }

  Object.values(filters).forEach(el => el.addEventListener('input', applyFilters));
  Object.values(filters).forEach(el => el.addEventListener('change', applyFilters));
  applyFilters();
})();
</script>
</body>
</html>`);
  } catch (error) {
    console.error('[logRoutes] Error rendering game log:', error);
    res.status(500).json({ error: 'SERVER_ERROR', details: 'Failed to render game log' });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTurnCard(entry: GameTurnLogEntry, index: number): string {
  const name = entry.playerName ?? entry.playerId;
  const source = inferDecisionSource(entry);
  const hasDelivery = (entry.loadsDelivered?.length ?? 0) > 0;
  const hasError = !entry.success && !!entry.error;
  const isGuardrail = entry.guardrailOverride === true;
  const isLlm = entry.actor === 'llm' || isLlmModel(entry.llmModel);

  let cardClass = '';
  if (hasDelivery) cardClass = 'delivery';
  else if (hasError) cardClass = 'error';
  else if (isGuardrail) cardClass = 'guardrail';
  else if (isLlm) cardClass = 'llm';

  const badges: string[] = [];
  if (isLlm && entry.llmModel) badges.push(`<span class="badge-llm">${escapeHtml(entry.llmModel)}</span>`);
  if (entry.actor === 'heuristic') badges.push('<span class="badge-heuristic">heuristic</span>');
  if (entry.actor === 'system') badges.push('<span class="badge-system">system</span>');
  if (hasError) badges.push('<span class="badge-error">error</span>');
  if (isGuardrail) badges.push('<span class="badge-guardrail">guardrail</span>');
  if (hasDelivery) badges.push('<span class="badge-delivery">delivery</span>');

  const start = loc(entry.positionStart);
  const end = loc(entry.positionEnd);
  const loads = entry.carriedLoads?.length ? `Carrying: [${entry.carriedLoads.join(', ')}]` : 'Empty';

  // Results line
  const results: string[] = [];
  if (entry.loadsPickedUp?.length) results.push(`picked up: ${entry.loadsPickedUp.map(l => `${l.loadType}@${l.city}`).join(', ')}`);
  if (entry.loadsDelivered?.length) results.push(`delivered: ${entry.loadsDelivered.map(l => `${l.loadType}→${l.city} (+${l.payment}M)`).join(', ')}`);
  if (entry.segmentsBuilt > 0) results.push(`built: ${entry.segmentsBuilt} segments (${entry.cost}M)`);
  if (entry.milepostsMoved) results.push(`moved: ${entry.milepostsMoved} mp`);

  let sections = '';

  // Trip Planning
  if (entry.tripPlanning) {
    const tp = entry.tripPlanning;
    const chosen = tp.chosen >= 0 && tp.chosen < tp.candidates.length ? tp.candidates[tp.chosen] : null;
    sections += `<details><summary>Trip Planning (${secs(tp.llmLatencyMs)})</summary><div class="section">`;
    sections += `Trigger: ${escapeHtml(tp.trigger)}\n`;
    if (chosen) sections += `Chosen: Route ${tp.chosen + 1}/${tp.candidates.length} — ${chosen.stops.join('→')} (score: ${chosen.score}, ${chosen.estimatedTurns}T, ${chosen.buildCostEstimate}M build)\n`;
    if (tp.llmReasoning) sections += `Reasoning: ${escapeHtml(tp.llmReasoning)}\n`;
    sections += `</div></details>`;
  }

  // Build Advisor
  if (entry.advisorAction) {
    sections += `<details><summary>Build Advisor${entry.advisorLatencyMs ? ` (${secs(entry.advisorLatencyMs)})` : ''}</summary><div class="section">`;
    sections += `Action: ${escapeHtml(entry.advisorAction)}\n`;
    if (entry.advisorReasoning) sections += `Reasoning: ${escapeHtml(entry.advisorReasoning)}\n`;
    if (entry.solvencyRetries && entry.solvencyRetries > 0) sections += `Solvency retries: ${entry.solvencyRetries}\n`;
    sections += `</div></details>`;
  }

  // Turn Validation
  if (entry.turnValidation) {
    const tv = entry.turnValidation;
    const icon = tv.outcome === 'passed' ? '✓' : '✗';
    sections += `<details><summary>Validation ${icon} ${tv.outcome}${tv.recomposeCount > 0 ? ` (${tv.recomposeCount} recompositions)` : ''}</summary><div class="section">`;
    for (const gate of tv.hardGates) {
      sections += `${gate.passed ? '✓' : '✗'} ${escapeHtml(gate.gate)}${gate.detail ? ` — ${escapeHtml(gate.detail)}` : ''}\n`;
    }
    sections += `</div></details>`;
  }

  // Composition Trace
  if (entry.composition) {
    const c = entry.composition;
    sections += `<details><summary>Composition (budget: ${c.moveBudget.used}/${c.moveBudget.total}, wasted: ${c.moveBudget.wasted})</summary><div class="section">`;
    sections += `Input: ${c.inputPlan.join(' → ')}\nOutput: ${c.outputPlan.join(' → ')}\n`;
    sections += `A1: ${c.a1.citiesScanned} cities, ${c.a1.opportunitiesFound} opportunities\n`;
    sections += `A2: ${c.a2.iterations} iterations, ${c.a2.terminationReason}\n`;
    if (c.build.target) sections += `Build: ${c.build.target} (${c.build.cost}M)\n`;
    sections += `</div></details>`;
  }

  // Demand Ranking
  if (entry.demandRanking?.length) {
    sections += `<details><summary>Demand Ranking (${entry.demandRanking.length} demands)</summary><div class="section">`;
    for (const d of entry.demandRanking) {
      sections += `#${d.rank} ${d.loadType}: ${d.supplyCity}→${d.deliveryCity} ${d.payout}M (score: ${d.score.toFixed(1)}${d.estimatedTurns ? `, ~${d.estimatedTurns}T` : ''})\n`;
    }
    sections += `</div></details>`;
  }

  // Prompts
  if (entry.reasoning) {
    sections += `<details><summary>Strategy Reasoning</summary><div class="section">${escapeHtml(entry.reasoning)}</div></details>`;
  }

  return `<div class="turn-card ${cardClass}" data-turn="${entry.turn}" data-player="${escapeHtml(name)}" data-phase="${escapeHtml(entry.gamePhase ?? '')}" data-source="${escapeHtml(source)}" data-model="${escapeHtml(entry.llmModel ?? '')}">
  <div class="turn-header" onclick="this.parentElement.querySelector('.turn-body').classList.toggle('hidden')">
    <h3>Turn ${entry.turn} | ${escapeHtml(name)} | ${escapeHtml(entry.action)}${entry.gamePhase ? ` | ${escapeHtml(entry.gamePhase)}` : ''}</h3>
    <div class="badges">${badges.join('')}</div>
  </div>
  <div class="turn-body hidden">
    <div class="context-line">${escapeHtml(start)} → ${escapeHtml(end)} | ${escapeHtml(loads)}${entry.cash != null ? ` | Cash: ${entry.cash}M` : ''}${entry.train ? ` | ${escapeHtml(entry.train)}` : ''}</div>
    <div class="context-line">Source: ${escapeHtml(source)} | Duration: ${secs(entry.durationMs)}${entry.llmLatencyMs ? ` | LLM: ${secs(entry.llmLatencyMs)}` : ''}</div>
    ${results.length > 0 ? `<div class="result-line">→ ${escapeHtml(results.join(' | '))}</div>` : ''}
    ${hasError ? `<div class="error-line">✗ ${escapeHtml(entry.error!)}</div>` : ''}
    ${sections}
  </div>
</div>`;
}

function computeStats(entries: GameTurnLogEntry[]): { llmCalls: number; tokensIn: number; tokensOut: number; avgLatency: string; deliveries: number; errors: number } {
  let llmCalls = 0, tokensIn = 0, tokensOut = 0, totalLatency = 0, latencyCount = 0, deliveries = 0, errors = 0;
  for (const e of entries) {
    if (isLlmModel(e.llmModel) || e.actor === 'llm') {
      llmCalls++;
      if (e.tokenUsage) { tokensIn += e.tokenUsage.input; tokensOut += e.tokenUsage.output; }
      if (e.llmLatencyMs) { totalLatency += e.llmLatencyMs; latencyCount++; }
    }
    if (e.tripPlanning) {
      llmCalls++;
      tokensIn += e.tripPlanning.llmTokens.input;
      tokensOut += e.tripPlanning.llmTokens.output;
      totalLatency += e.tripPlanning.llmLatencyMs;
      latencyCount++;
    }
    if (e.advisorLatencyMs) {
      llmCalls++;
      totalLatency += e.advisorLatencyMs;
      latencyCount++;
    }
    if (e.loadsDelivered?.length) deliveries += e.loadsDelivered.length;
    if (!e.success && e.error) errors++;
  }
  return {
    llmCalls,
    tokensIn,
    tokensOut,
    avgLatency: latencyCount > 0 ? secs(totalLatency / latencyCount) : 'N/A',
    deliveries,
    errors,
  };
}

export default router;
