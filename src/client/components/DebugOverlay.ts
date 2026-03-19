import "phaser";
import { GameState, Player, GameStatus, AIActionType, LlmAttempt } from '../../shared/types/GameTypes';
import { GameStateService } from '../services/GameStateService';

/** Captured socket event for the debug log ring buffer */
interface SocketEvent {
  name: string;
  payload: string;
  timestamp: Date;
}

/** Per-bot turn entry for the debug overlay history ring buffer */
export interface BotTurnEntry {
  name: string;
  startTime: number;
  action: string;
  durationMs: number;
  completed: boolean;
  turnNumber?: number;
  buildTrackData?: {
    segmentsBuilt: number;
    totalCost: number;
    remainingMoney: number;
    targetCity?: string;
  };
  movementData?: {
    from: { row: number; col: number };
    to: { row: number; col: number };
    mileposts: number;
    trackUsageFee: number;
  };
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
  reasoning?: string;
  planHorizon?: string;
  guardrailOverride?: boolean;
  guardrailReason?: string;
  activeRoute?: {
    stops: Array<{ action: string; loadType: string; city: string }>;
    currentStopIndex: number;
    phase: string;
  };
  demandRanking?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number; estimatedTurns?: number; trackCostToSupply?: number; trackCostToDelivery?: number }>;
  // FE-002: Dynamic upgrade advice
  upgradeAdvice?: string;
  // FE-003: Hand quality metrics
  handQuality?: { score: number; staleCards: number; assessment: string };
  // JIRA-19: LLM decision metadata
  model?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };
  retried?: boolean;
  // JIRA-31: LLM attempt log
  llmLog?: LlmAttempt[];
  // JIRA-131: Pipeline success/error tracking
  success?: boolean;
  error?: string;
  // JIRA-131: LLM prompt observability
  systemPrompt?: string;
  userPrompt?: string;
  // JIRA-129: Build Advisor
  advisorAction?: string;
  advisorReasoning?: string;
  advisorLatencyMs?: number;
  solvencyRetries?: number;
}

/**
 * Toggleable HTML overlay for debugging game state.
 * Activated by the backtick key (`) during gameplay.
 * Shows game state, player table, socket event log, and bot turn placeholder.
 */
export class DebugOverlay {
  private scene: Phaser.Scene;
  private gameStateService: GameStateService;
  private container: HTMLDivElement | null = null;
  private isOpen: boolean = false;
  private eventLog: SocketEvent[] = [];
  private keydownHandler: (e: KeyboardEvent) => void;
  private stateChangeListener: () => void;
  private turnChangeListener: (index: number) => void;

  private botTurnCount: number = 0;
  private botTurnHistory: Map<string, BotTurnEntry[]> = new Map();
  private lastActiveBotId: string | null = null;
  private expandedHistoryEntries = new Set<string>();

  private static readonly MAX_EVENTS = 50;
  private static readonly MAX_BOT_TURNS_PER_PLAYER = 10;
  private static readonly BOT_ACCENT_COLORS = ['#34d399', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa'];
  private static readonly STORAGE_KEY = 'eurorails.debugOverlay.open';

  constructor(scene: Phaser.Scene, gameStateService: GameStateService) {
    this.scene = scene;
    this.gameStateService = gameStateService;

    // Read persisted open/closed state
    try {
      this.isOpen = localStorage.getItem(DebugOverlay.STORAGE_KEY) === 'true';
    } catch {
      this.isOpen = false;
    }

    // Create DOM container
    this.container = document.createElement('div');
    this.container.id = 'debug-overlay';
    this.applyContainerStyles();
    document.body.appendChild(this.container);

    // Track expanded/collapsed state of history entries across re-renders
    this.container.addEventListener('toggle', (e) => {
      const target = e.target as HTMLDetailsElement;
      const key = target.getAttribute('data-history-entry');
      if (key) {
        if (target.open) {
          this.expandedHistoryEntries.add(key);
        } else {
          this.expandedHistoryEntries.delete(key);
        }
      }
    }, true);

    // Keyboard toggle handler
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === '`' || e.code === 'Backquote') {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    // State change listeners
    this.stateChangeListener = () => {
      if (this.isOpen) this.render();
    };
    this.turnChangeListener = (_index: number) => {
      if (this.isOpen) this.render();
    };
    this.gameStateService.onStateChange(this.stateChangeListener);
    this.gameStateService.onTurnChange(this.turnChangeListener);

    // Initial render
    if (this.isOpen) {
      this.show();
    } else {
      this.hide();
    }
  }

  public destroy(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    this.gameStateService.offStateChange(this.stateChangeListener);
    this.gameStateService.offTurnChange(this.turnChangeListener);
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }

  private toggle(): void {
    if (this.isOpen) {
      this.hide();
    } else {
      this.show();
    }
  }

  private show(): void {
    this.isOpen = true;
    this.persistState();
    if (this.container) {
      this.container.style.display = 'block';
    }
    this.render();
  }

  private hide(): void {
    this.isOpen = false;
    this.persistState();
    if (this.container) {
      this.container.style.display = 'none';
    }
  }

  private persistState(): void {
    try {
      localStorage.setItem(DebugOverlay.STORAGE_KEY, String(this.isOpen));
    } catch {
      // Non-fatal — localStorage may be unavailable
    }
  }

  public logSocketEvent(eventName: string, payload: any): void {
    this.eventLog.unshift({
      name: eventName,
      payload: JSON.stringify(payload).substring(0, 100),
      timestamp: new Date(),
    });
    if (this.eventLog.length > DebugOverlay.MAX_EVENTS) {
      this.eventLog.pop();
    }

    // Track bot turn events in per-bot ring buffer
    if (eventName === 'bot:turn-start') {
      const botId = payload?.botPlayerId || 'unknown';
      this.lastActiveBotId = botId;
      const entry: BotTurnEntry = {
        name: botId,
        startTime: Date.now(),
        action: '',
        durationMs: 0,
        completed: false,
        turnNumber: payload?.turnNumber,
      };
      const history = this.botTurnHistory.get(botId) || [];
      history.unshift(entry);
      if (history.length > DebugOverlay.MAX_BOT_TURNS_PER_PLAYER) {
        history.pop();
      }
      this.botTurnHistory.set(botId, history);
    } else if (eventName === 'bot:turn-complete') {
      this.botTurnCount++;
      const botId = payload?.botPlayerId || 'unknown';
      this.lastActiveBotId = botId;
      const action = payload?.action || AIActionType.PassTurn;
      const history = this.botTurnHistory.get(botId) || [];

      // Find pending entry from bot:turn-start, or create a new one
      let entry = history.find(e => !e.completed);
      if (!entry) {
        entry = {
          name: botId,
          startTime: Date.now(),
          action: '',
          durationMs: 0,
          completed: false,
        };
        history.unshift(entry);
        if (history.length > DebugOverlay.MAX_BOT_TURNS_PER_PLAYER) {
          history.pop();
        }
      }

      entry.action = action;
      entry.durationMs = payload?.durationMs || 0;
      entry.completed = true;
      entry.turnNumber = payload?.turnNumber;

      if (action === AIActionType.BuildTrack && payload?.segmentsBuilt) {
        entry.buildTrackData = {
          segmentsBuilt: payload.segmentsBuilt,
          totalCost: payload.cost ?? 0,
          remainingMoney: payload.remainingMoney ?? 0,
          targetCity: payload.buildTargetCity,
        };
      }
      if (payload?.movementData) {
        entry.movementData = {
          from: payload.movementData.from,
          to: payload.movementData.to,
          mileposts: payload.movementData.mileposts ?? 0,
          trackUsageFee: payload.movementData.trackUsageFee ?? 0,
        };
      }
      if (payload?.loadsPickedUp?.length) {
        entry.loadsPickedUp = payload.loadsPickedUp;
      }
      if (payload?.loadsDelivered?.length) {
        entry.loadsDelivered = payload.loadsDelivered;
      }
      if (payload?.reasoning) {
        entry.reasoning = payload.reasoning;
      }
      if (payload?.planHorizon) {
        entry.planHorizon = payload.planHorizon;
      }
      if (payload?.guardrailOverride) {
        entry.guardrailOverride = payload.guardrailOverride;
        entry.guardrailReason = payload.guardrailReason;
      }
      if ('activeRoute' in payload) {
        entry.activeRoute = payload.activeRoute ?? undefined;
      }
      if (payload?.demandRanking?.length) {
        entry.demandRanking = payload.demandRanking;
      }
      if (payload?.upgradeAdvice) {
        entry.upgradeAdvice = payload.upgradeAdvice;
      }
      if (payload?.handQuality) {
        entry.handQuality = payload.handQuality;
      }
      // JIRA-19: LLM decision metadata
      entry.model = payload?.model;
      entry.llmLatencyMs = payload?.llmLatencyMs;
      entry.tokenUsage = payload?.tokenUsage;
      entry.retried = payload?.retried;
      // JIRA-131: Pipeline success/error tracking
      entry.success = payload?.success ?? true;
      entry.error = payload?.error;
      // JIRA-131: LLM prompt observability
      if (payload?.systemPrompt) entry.systemPrompt = payload.systemPrompt;
      if (payload?.userPrompt) entry.userPrompt = payload.userPrompt;
      // JIRA-31: LLM attempt log
      if (payload?.llmLog?.length) {
        entry.llmLog = payload.llmLog;
      }
      // JIRA-129: Build Advisor
      if (payload?.advisorAction) entry.advisorAction = payload.advisorAction;
      if (payload?.advisorReasoning) entry.advisorReasoning = payload.advisorReasoning;
      if (payload?.advisorLatencyMs) entry.advisorLatencyMs = payload.advisorLatencyMs;
      if (payload?.solvencyRetries) entry.solvencyRetries = payload.solvencyRetries;

      this.botTurnHistory.set(botId, history);
    } else if (eventName === 'bot:demandRankingUpdate') {
      // Refresh demand ranking mid-turn on the latest entry for the relevant bot
      const botId = payload?.botPlayerId || this.lastActiveBotId;
      const entries = botId ? this.botTurnHistory.get(botId) : null;
      if (entries && entries.length > 0 && payload?.demandRanking?.length) {
        entries[0].demandRanking = payload.demandRanking;
      }
    }

    if (this.isOpen) this.render();
  }

  private render(): void {
    if (!this.container) return;
    const gameState = (this.scene as any).gameState as GameState | undefined;
    if (!gameState) {
      this.container.innerHTML = '<div style="padding:20px;color:#9ca3af;font-size:18px;">Waiting for game state...</div>';
      return;
    }

    this.container.innerHTML = `
      ${this.renderHeader(gameState)}
      ${this.renderPlayersTable(gameState)}
      ${this.renderBotTurnSection(gameState)}
      ${this.renderSocketLog()}
    `;
  }

  private renderHeader(gameState: GameState): string {
    const gameId = gameState.id ? gameState.id.substring(0, 8) : '—';
    const status = gameState.status || '—';
    const currentIdx = gameState.currentPlayerIndex ?? '—';
    const currentPlayer = gameState.players?.[gameState.currentPlayerIndex];
    const currentName = currentPlayer?.name || '—';

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,0.15);">
        <div>
          <span style="color:#f9fafb;font-weight:bold;font-size:22px;">Debug Overlay</span>
          <span style="margin-left:12px;color:#9ca3af;font-size:16px;">${gameId}</span>
          <span style="margin-left:12px;padding:4px 10px;border-radius:4px;background:rgba(255,255,255,0.1);color:#e5e7eb;font-size:16px;">${status}</span>
        </div>
        <button onclick="document.getElementById('debug-overlay').style.display='none'" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:24px;padding:6px 12px;">&times;</button>
      </div>
      <div style="padding:8px 20px;color:#9ca3af;font-size:16px;border-bottom:1px solid rgba(255,255,255,0.15);">
        Current Player: <span style="color:#e5e7eb;">#${currentIdx} — ${currentName}</span>
      </div>
    `;
  }

  private renderPlayersTable(gameState: GameState): string {
    const players = gameState.players || [];
    const currentIdx = gameState.currentPlayerIndex;

    const rows = players.map((p: Player, i: number) => {
      const isCurrent = i === currentIdx;
      const isBot = !!p.isBot;
      let rowBg = 'transparent';
      if (isCurrent && isBot) rowBg = 'rgba(34,197,94,0.15)';
      else if (isCurrent) rowBg = 'rgba(34,197,94,0.2)';
      else if (isBot) rowBg = 'rgba(59,130,246,0.2)';

      const pos = p.trainState?.position
        ? `(${p.trainState.position.row},${p.trainState.position.col})`
        : 'none';
      const loads = p.trainState?.loads?.length
        ? p.trainState.loads.join(', ')
        : '—';

      return `<tr style="background:${rowBg};">
        <td style="padding:6px 10px;">${p.name}</td>
        <td style="padding:6px 10px;text-align:center;">${isBot ? 'Y' : 'N'}</td>
        <td style="padding:6px 10px;text-align:right;">${p.money ?? 0}</td>
        <td style="padding:6px 10px;">${pos}</td>
        <td style="padding:6px 10px;">${p.trainType ?? '—'}</td>
        <td style="padding:6px 10px;">${loads}</td>
        <td style="padding:6px 10px;text-align:right;">${p.turnNumber ?? 0}</td>
      </tr>`;
    }).join('');

    return `
      <div style="padding:14px 20px;">
        <div style="color:#f9fafb;font-weight:bold;font-size:18px;margin-bottom:8px;">Players</div>
        <table style="width:100%;border-collapse:collapse;font-size:15px;color:#e5e7eb;">
          <thead>
            <tr style="color:#9ca3af;border-bottom:1px solid rgba(255,255,255,0.15);">
              <th style="padding:6px 10px;text-align:left;">Name</th>
              <th style="padding:6px 10px;text-align:center;">Bot?</th>
              <th style="padding:6px 10px;text-align:right;">Money</th>
              <th style="padding:6px 10px;text-align:left;">Position</th>
              <th style="padding:6px 10px;text-align:left;">Train</th>
              <th style="padding:6px 10px;text-align:left;">Loads</th>
              <th style="padding:6px 10px;text-align:right;">Turn#</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  private renderSocketLog(): string {
    const entries = this.eventLog.map((e) => {
      const time = e.timestamp.toLocaleTimeString('en-US', { hour12: false });
      return `<div style="padding:3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        <span style="color:#9ca3af;">[${time}]</span>
        <span style="color:#60a5fa;">${e.name}</span>
        <span style="color:#6b7280;"> — ${e.payload}</span>
      </div>`;
    }).join('');

    return `
      <div style="padding:14px 20px;border-top:1px solid rgba(255,255,255,0.15);">
        <details style="margin:0;">
          <summary style="cursor:pointer;color:#6b7280;font-weight:bold;font-size:16px;padding:4px 0;">Socket Events <span style="font-weight:normal;">(${this.eventLog.length})</span></summary>
          <div style="max-height:350px;overflow-y:auto;font-size:15px;color:#e5e7eb;margin-top:8px;">
            ${entries || '<div style="color:#6b7280;">No events yet</div>'}
          </div>
        </details>
      </div>
    `;
  }

  /** Get the most recently active bot's latest entry */
  private getLatestBotTurnEntry(): BotTurnEntry | null {
    if (this.lastActiveBotId) {
      const entries = this.botTurnHistory.get(this.lastActiveBotId);
      if (entries && entries.length > 0) return entries[0];
    }
    return null;
  }

  /** Expose turn history for testing */
  public getBotTurnHistory(): Map<string, BotTurnEntry[]> {
    return this.botTurnHistory;
  }

  private renderBotTurnSection(gameState: GameState): string {
    if (this.botTurnHistory.size === 0) {
      return `
        <div style="padding:14px 20px;border-top:1px solid rgba(255,255,255,0.15);">
          <div style="color:#f9fafb;font-weight:bold;font-size:18px;margin-bottom:8px;">Bot Turns <span style="color:#6b7280;font-weight:normal;">turns this game: ${this.botTurnCount}</span></div>
          <div style="color:#6b7280;font-size:15px;">No bot turn data yet</div>
        </div>
      `;
    }

    // Sort bots by player order (matching gameState.players array order)
    const playerOrder = new Map<string, number>();
    const playerColorMap = new Map<string, string>();
    gameState.players?.forEach((p, i) => {
      playerOrder.set(p.id, i);
      playerColorMap.set(p.id, DebugOverlay.ensureReadable(p.color));
    });

    const sortedBots = [...this.botTurnHistory.entries()].sort((a, b) => {
      const orderA = playerOrder.get(a[0]) ?? Infinity;
      const orderB = playerOrder.get(b[0]) ?? Infinity;
      return orderA - orderB;
    });

    const sections = sortedBots.map(([botId, entries], i) =>
      this.renderBotSection(botId, entries, playerColorMap.get(botId) || DebugOverlay.BOT_ACCENT_COLORS[i % DebugOverlay.BOT_ACCENT_COLORS.length]),
    ).join('');

    return `
      <div style="padding:14px 20px;border-top:1px solid rgba(255,255,255,0.15);">
        <div style="color:#f9fafb;font-weight:bold;font-size:18px;margin-bottom:8px;">Bot Turns <span style="color:#6b7280;font-weight:normal;">turns this game: ${this.botTurnCount}</span></div>
        ${sections}
      </div>
    `;
  }

  private renderBotSection(botPlayerId: string, entries: BotTurnEntry[], color: string): string {
    const isActive = botPlayerId === this.lastActiveBotId;
    const latest = entries[0];

    if (!latest) {
      return `
        <details data-bot-section="${botPlayerId}" ${isActive ? 'open' : ''} style="margin-bottom:8px;border-left:3px solid ${color};padding-left:10px;">
          <summary style="cursor:pointer;color:${color};font-weight:bold;font-size:16px;padding:6px 0;">${botPlayerId}</summary>
          <div style="padding:6px 0;color:#6b7280;">No turns yet</div>
        </details>
      `;
    }

    // Summary line for collapsed view
    const summaryText = latest.completed
      ? `${botPlayerId} — T${latest.turnNumber ?? '?'}: ${latest.action} (${latest.durationMs}ms)`
      : `${botPlayerId} — turn in progress...`;

    // Full detail for the current (most recent) turn
    let latestDetail = '';
    if (!latest.completed) {
      const time = new Date(latest.startTime).toLocaleTimeString('en-US', { hour12: false });
      latestDetail = `<div style="color:#fbbf24;font-size:15px;">Bot ${latest.name} turn started at ${time}</div>`;
    } else {
      const statusColor = latest.success === false ? '#f87171' : color;
      latestDetail = `<div style="color:${statusColor};font-size:15px;">Bot ${latest.name} turn completed: ${latest.action} (${latest.durationMs}ms)</div>`;
      // JIRA-131: Show pipeline error prominently
      if (latest.success === false && latest.error) {
        latestDetail += `<div style="margin-top:6px;padding:8px 12px;background:rgba(248,113,113,0.15);border:1px solid rgba(248,113,113,0.4);border-radius:4px;"><div style="color:#f87171;font-size:14px;font-weight:bold;">Pipeline Error</div><div style="color:#fca5a5;font-size:13px;margin-top:4px;white-space:pre-wrap;word-break:break-all;">${DebugOverlay.escapeHtml(latest.error)}</div></div>`;
      }
      latestDetail += this.renderLlmMetadata(latest);
      // JIRA-131: Auto-open LLM attempts when there are failures; fall back to previous turn if latest has none
      const llmLogSource = (latest.llmLog && latest.llmLog.length > 0)
        ? latest.llmLog
        : entries.find(e => e.llmLog && e.llmLog.length > 0)?.llmLog;
      if (llmLogSource && llmLogSource.length > 0) {
        const hasFailures = llmLogSource.some(a => a.status !== 'success');
        const isFromPrevTurn = llmLogSource !== latest.llmLog;
        latestDetail += this.renderLlmLog(llmLogSource, hasFailures, isFromPrevTurn);
      }
      // JIRA-131: LLM prompt viewer (fall back to previous turn)
      const promptSource = (latest.systemPrompt || latest.userPrompt)
        ? latest
        : entries.find(e => e.systemPrompt || e.userPrompt);
      if (promptSource && (promptSource.systemPrompt || promptSource.userPrompt)) {
        const isStalePrompt = promptSource !== latest;
        latestDetail += this.renderPromptViewer(promptSource.systemPrompt, promptSource.userPrompt, isStalePrompt);
      }
      if (latest.reasoning) {
        latestDetail += `<div style="color:#c4b5fd;font-size:14px;margin-top:6px;padding:6px 10px;background:rgba(139,92,246,0.12);border-radius:4px;border-left:3px solid #8b5cf6;"><strong>Strategy:</strong> ${latest.reasoning}</div>`;
      }
      if (latest.planHorizon) {
        latestDetail += `<div style="color:#93c5fd;font-size:14px;margin-top:4px;padding:4px 10px;"><strong>Plan:</strong> ${latest.planHorizon}</div>`;
      }
      if (latest.activeRoute) {
        const route = latest.activeRoute;
        const stopsHtml = route.stops.map((s, i) => {
          const isCurrent = i === route.currentStopIndex;
          const isDone = i < route.currentStopIndex;
          const c = isDone ? '#6b7280' : isCurrent ? '#fbbf24' : '#9ca3af';
          const prefix = isDone ? '\u2713' : isCurrent ? '\u25b6' : '\u2022';
          return `<span style="color:${c};">${prefix} ${s.action.toUpperCase()} ${s.loadType} @ ${s.city}</span>`;
        }).join(' &rarr; ');
        latestDetail += `<div style="color:#a78bfa;font-size:14px;margin-top:6px;padding:6px 10px;background:rgba(167,139,250,0.1);border-radius:4px;border-left:3px solid #a78bfa;"><strong>Route:</strong> ${stopsHtml} <span style="color:#6b7280;margin-left:8px;">[phase: ${route.phase}]</span></div>`;
      }
      if (latest.guardrailOverride) {
        latestDetail += `<div style="color:#f87171;font-size:14px;margin-top:4px;font-weight:bold;">Guardrail override: ${latest.guardrailReason || 'unknown'}</div>`;
      }
      // JIRA-131: Fall back to most recent entry with ranking if latest has none (e.g. pipeline-error)
      const rankingSource = (latest.demandRanking && latest.demandRanking.length > 0)
        ? latest.demandRanking
        : entries.find(e => e.demandRanking && e.demandRanking.length > 0)?.demandRanking;
      if (rankingSource && rankingSource.length > 0) {
        const isStale = rankingSource !== latest.demandRanking;
        latestDetail += this.renderDemandRanking(rankingSource, color, isStale);
      }
      if (latest.handQuality) {
        const hq = latest.handQuality;
        const assessColor = hq.assessment === 'Good' ? '#34d399' : hq.assessment === 'Fair' ? '#fbbf24' : '#f87171';
        latestDetail += `<div style="margin-top:8px;padding:6px 10px;background:rgba(96,165,250,0.08);border-radius:4px;border-left:3px solid #60a5fa;"><div style="color:#60a5fa;font-size:14px;font-weight:bold;margin-bottom:2px;">Hand Quality</div><div style="color:#e5e7eb;font-size:13px;">Score: ${hq.score} (threshold=3.0) | Assessment: <span style="color:${assessColor};font-weight:bold;">${hq.assessment}</span> | Stale: ${hq.staleCards} card(s)</div></div>`;
      }
      if (latest.upgradeAdvice) {
        latestDetail += `<div style="margin-top:8px;padding:6px 10px;background:rgba(251,191,36,0.08);border-radius:4px;border-left:3px solid #fbbf24;"><div style="color:#fbbf24;font-size:14px;font-weight:bold;margin-bottom:2px;">Upgrade Path</div><div style="color:#e5e7eb;font-size:13px;">${latest.upgradeAdvice}</div></div>`;
      }
      // JIRA-129: Build Advisor section
      if (latest.advisorAction) {
        const retryInfo = latest.solvencyRetries ? ` | Retries: ${latest.solvencyRetries}` : '';
        const latencyInfo = latest.advisorLatencyMs ? ` | ${latest.advisorLatencyMs}ms` : '';
        latestDetail += `<div style="margin-top:8px;padding:6px 10px;background:rgba(34,197,94,0.08);border-radius:4px;border-left:3px solid #22c55e;"><div style="color:#22c55e;font-size:14px;font-weight:bold;margin-bottom:2px;">Build Advisor: ${latest.advisorAction}${latencyInfo}${retryInfo}</div>`;
        if (latest.advisorReasoning) {
          latestDetail += `<div style="color:#e5e7eb;font-size:13px;">${latest.advisorReasoning}</div>`;
        }
        latestDetail += `</div>`;
      }
      if (latest.loadsPickedUp || latest.loadsDelivered) {
        latestDetail += this.renderLoadDetails(latest.loadsPickedUp, latest.loadsDelivered);
      }
      if (latest.buildTrackData) {
        latestDetail += this.renderBuildTrackDetails(latest.buildTrackData);
      }
      if (latest.movementData) {
        latestDetail += this.renderMovementDetails(latest.movementData);
      }
    }

    // Condensed history rows for past turns
    const pastEntries = entries.slice(1);
    let historyHtml = '';
    if (pastEntries.length > 0) {
      const rows = pastEntries.map(e => this.renderTurnHistoryRow(e, botPlayerId)).join('');
      historyHtml = `
        <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;">
          <div style="color:#6b7280;font-size:13px;margin-bottom:4px;">History (${pastEntries.length})</div>
          <div style="max-height:400px;overflow-y:auto;">${rows}</div>
        </div>
      `;
    }

    return `
      <details data-bot-section="${botPlayerId}" ${isActive ? 'open' : ''} style="margin-bottom:8px;border-left:3px solid ${color};padding-left:10px;">
        <summary style="cursor:pointer;color:${color};font-weight:bold;font-size:16px;padding:6px 0;">${summaryText}</summary>
        <div style="padding:6px 0;">
          ${latestDetail}
          ${historyHtml}
        </div>
      </details>
    `;
  }

  private renderLlmMetadata(entry: BotTurnEntry): string {
    const parts: string[] = [];
    if (entry.model) {
      parts.push(`<span style="background:rgba(255,255,255,0.1);padding:2px 8px;border-radius:4px;font-size:13px;">${entry.model}</span>`);
    }
    if (entry.llmLatencyMs != null) {
      parts.push(`<span style="color:#9ca3af;font-size:13px;">LLM: ${entry.llmLatencyMs}ms</span>`);
    }
    if (entry.tokenUsage) {
      parts.push(`<span style="color:#9ca3af;font-size:13px;">Tokens: ${entry.tokenUsage.input}\u2193 ${entry.tokenUsage.output}\u2191</span>`);
    }
    if (entry.retried) {
      parts.push(`<span style="color:#fbbf24;font-size:13px;">\u27F3 Retried</span>`);
    }
    if (parts.length === 0) return '';
    return `<div style="margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${parts.join('')}</div>`;
  }

  private renderTurnHistoryRow(entry: BotTurnEntry, botId: string): string {
    const turn = entry.turnNumber != null ? `T${entry.turnNumber}` : 'T?';
    const reasoning = entry.reasoning
      ? entry.reasoning.substring(0, 60) + (entry.reasoning.length > 60 ? '...' : '')
      : '';
    const duration = `${(entry.durationMs / 1000).toFixed(1)}s`;
    const grTag = entry.guardrailOverride ? ' <span style="color:#f87171;">[GR]</span>' : '';
    const errorTag = entry.success === false ? ' <span style="color:#f87171;font-weight:bold;">[ERROR]</span>' : '';
    const llmTag = DebugOverlay.llmLogSummary(entry.llmLog);
    const summaryLine = `${turn}: ${entry.action} <span style="color:#6b7280;">"${reasoning}"</span> (${duration})${errorTag}${grTag}${llmTag}`;
    const key = `${botId}-${entry.turnNumber ?? entry.startTime}`;
    const isOpen = this.expandedHistoryEntries.has(key);
    const expanded = this.renderExpandedHistoryEntry(entry);
    return `<details data-history-entry="${key}" ${isOpen ? 'open' : ''} style="padding:2px 0;font-size:13px;color:#9ca3af;">
      <summary style="cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${summaryLine}</summary>
      <div style="padding:4px 0 8px 12px;border-left:2px solid rgba(255,255,255,0.1);">${expanded}</div>
    </details>`;
  }

  /** Render expanded details for a past turn history entry */
  private renderExpandedHistoryEntry(entry: BotTurnEntry): string {
    let html = '';
    // JIRA-131: Show pipeline error in expanded history
    if (entry.success === false && entry.error) {
      html += `<div style="margin-top:4px;padding:6px 10px;background:rgba(248,113,113,0.15);border:1px solid rgba(248,113,113,0.4);border-radius:4px;"><div style="color:#f87171;font-size:13px;font-weight:bold;">Pipeline Error</div><div style="color:#fca5a5;font-size:12px;margin-top:2px;white-space:pre-wrap;word-break:break-all;">${DebugOverlay.escapeHtml(entry.error)}</div></div>`;
    }
    html += this.renderLlmMetadata(entry);
    if (entry.llmLog && entry.llmLog.length > 0) {
      const hasFailures = entry.llmLog.some(a => a.status !== 'success');
      html += this.renderLlmLog(entry.llmLog, hasFailures);
    }
    if (entry.systemPrompt || entry.userPrompt) {
      html += this.renderPromptViewer(entry.systemPrompt, entry.userPrompt);
    }
    if (entry.reasoning) {
      html += `<div style="color:#c4b5fd;font-size:14px;margin-top:6px;padding:6px 10px;background:rgba(139,92,246,0.12);border-radius:4px;border-left:3px solid #8b5cf6;"><strong>Strategy:</strong> ${entry.reasoning}</div>`;
    }
    if (entry.planHorizon) {
      html += `<div style="color:#93c5fd;font-size:14px;margin-top:4px;padding:4px 10px;"><strong>Plan:</strong> ${entry.planHorizon}</div>`;
    }
    if (entry.activeRoute) {
      const route = entry.activeRoute;
      const stopsHtml = route.stops.map((s, i) => {
        const isCurrent = i === route.currentStopIndex;
        const isDone = i < route.currentStopIndex;
        const c = isDone ? '#6b7280' : isCurrent ? '#fbbf24' : '#9ca3af';
        const prefix = isDone ? '\u2713' : isCurrent ? '\u25b6' : '\u2022';
        return `<span style="color:${c};">${prefix} ${s.action.toUpperCase()} ${s.loadType} @ ${s.city}</span>`;
      }).join(' &rarr; ');
      html += `<div style="color:#a78bfa;font-size:14px;margin-top:6px;padding:6px 10px;background:rgba(167,139,250,0.1);border-radius:4px;border-left:3px solid #a78bfa;"><strong>Route:</strong> ${stopsHtml} <span style="color:#6b7280;margin-left:8px;">[phase: ${route.phase}]</span></div>`;
    }
    if (entry.guardrailOverride) {
      html += `<div style="color:#f87171;font-size:14px;margin-top:4px;font-weight:bold;">Guardrail override: ${entry.guardrailReason || 'unknown'}</div>`;
    }
    // JIRA-129: Build Advisor in history
    if (entry.advisorAction) {
      const retryInfo = entry.solvencyRetries ? ` | Retries: ${entry.solvencyRetries}` : '';
      const latencyInfo = entry.advisorLatencyMs ? ` | ${entry.advisorLatencyMs}ms` : '';
      html += `<div style="margin-top:4px;padding:4px 8px;background:rgba(34,197,94,0.08);border-radius:4px;border-left:3px solid #22c55e;"><span style="color:#22c55e;font-size:13px;font-weight:bold;">Advisor: ${entry.advisorAction}${latencyInfo}${retryInfo}</span>`;
      if (entry.advisorReasoning) {
        html += `<div style="color:#d1d5db;font-size:12px;">${entry.advisorReasoning}</div>`;
      }
      html += `</div>`;
    }
    if (entry.loadsPickedUp || entry.loadsDelivered) {
      html += this.renderLoadDetails(entry.loadsPickedUp, entry.loadsDelivered);
    }
    if (entry.buildTrackData) {
      html += this.renderBuildTrackDetails(entry.buildTrackData);
    }
    if (entry.movementData) {
      html += this.renderMovementDetails(entry.movementData);
    }
    return html;
  }

  private renderDemandRanking(ranking: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number; estimatedTurns?: number; trackCostToSupply?: number; trackCostToDelivery?: number; ferryRequired?: boolean }>, playerColor: string, isStale = false): string {
    const rows = ranking.map(d => {
      const rowColor = d.rank === 1 ? playerColor : d.score < 0 ? '#f87171' : '#e5e7eb';
      const turns = d.estimatedTurns != null ? `${d.estimatedTurns}` : '—';
      const totalBuildCost = (d.trackCostToSupply ?? 0) + (d.trackCostToDelivery ?? 0);
      const buildDisplay = totalBuildCost > 0 ? `${totalBuildCost}M` : '0';
      const ferryIcon = d.ferryRequired ? '\u26F4' : '';
      return `<tr style="color:${rowColor};"><td style="padding:2px 8px;">#${d.rank}</td><td style="padding:2px 8px;">${d.loadType}</td><td style="padding:2px 8px;">${d.supplyCity}\u2192${d.deliveryCity}</td><td style="padding:2px 8px;text-align:right;">${d.payout}M</td><td style="padding:2px 8px;text-align:right;">${buildDisplay}</td><td style="padding:2px 8px;text-align:right;">${turns}</td><td style="padding:2px 4px;text-align:center;">${ferryIcon}</td><td style="padding:2px 8px;text-align:right;font-weight:bold;">${d.score.toFixed(2)}</td></tr>`;
    }).join('');
    const staleLabel = isStale ? ' <span style="color:#fbbf24;font-weight:normal;font-size:12px;">(from previous turn)</span>' : '';
    return `
      <div style="margin-top:8px;padding:6px 10px;background:rgba(52,211,153,0.08);border-radius:4px;border-left:3px solid ${playerColor};">
        <div style="color:${playerColor};font-size:14px;font-weight:bold;margin-bottom:4px;">Demand Ranking${staleLabel}</div>
        <table style="font-size:13px;border-collapse:collapse;width:100%;">
          <tr style="color:#6b7280;"><th style="text-align:left;padding:2px 8px;">Rank</th><th style="text-align:left;padding:2px 8px;">Load</th><th style="text-align:left;padding:2px 8px;">Route</th><th style="text-align:right;padding:2px 8px;">Payout</th><th style="text-align:right;padding:2px 8px;">Build</th><th style="text-align:right;padding:2px 8px;">Turns</th><th style="text-align:center;padding:2px 4px;">F</th><th style="text-align:right;padding:2px 8px;">Score</th></tr>
          ${rows}
        </table>
      </div>
    `;
  }

  private renderBuildTrackDetails(data: BotTurnEntry['buildTrackData']): string {
    if (!data) return '';
    const targetLine = data.targetCity
      ? `<div style="color:#60a5fa;font-size:15px;margin-top:6px;font-weight:bold;">Building toward: ${data.targetCity}</div>`
      : `<div style="color:#f87171;font-size:15px;margin-top:6px;">No build target (undirected)</div>`;
    const costLine = `<div style="color:#e5e7eb;font-size:15px;">Segments: ${data.segmentsBuilt} | Cost: ${data.totalCost}M | Remaining: ${data.remainingMoney}M</div>`;
    return `${targetLine}${costLine}`;
  }

  /** Render collapsible LLM prompt viewer with system and user prompts */
  private renderPromptViewer(systemPrompt?: string, userPrompt?: string, isStale = false): string {
    if (!systemPrompt && !userPrompt) return '';
    const staleTag = isStale ? ' <span style="color:#fbbf24;font-weight:normal;font-size:12px;">(from previous turn)</span>' : '';
    const preStyle = 'color:#d1d5db;font-size:12px;margin:4px 0 0 0;padding:8px;background:rgba(255,255,255,0.04);border-radius:3px;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;line-height:1.4;';
    let content = '';
    if (systemPrompt) {
      content += `<details style="margin-top:4px;"><summary style="cursor:pointer;color:#60a5fa;font-size:13px;font-weight:bold;">System Prompt <span style="color:#6b7280;font-weight:normal;">(${systemPrompt.length.toLocaleString()} chars)</span></summary><pre style="${preStyle}">${DebugOverlay.escapeHtml(systemPrompt)}</pre></details>`;
    }
    if (userPrompt) {
      content += `<details style="margin-top:4px;"><summary style="cursor:pointer;color:#34d399;font-size:13px;font-weight:bold;">User Prompt <span style="color:#6b7280;font-weight:normal;">(${userPrompt.length.toLocaleString()} chars)</span></summary><pre style="${preStyle}">${DebugOverlay.escapeHtml(userPrompt)}</pre></details>`;
    }
    return `
      <details style="margin-top:8px;padding:6px 10px;background:rgba(96,165,250,0.06);border-radius:4px;border-left:3px solid #60a5fa;">
        <summary style="cursor:pointer;color:#60a5fa;font-size:14px;font-weight:bold;">LLM Prompts${staleTag}</summary>
        <div style="margin-top:4px;">${content}</div>
      </details>
    `;
  }

  private renderMovementDetails(data: BotTurnEntry['movementData']): string {
    if (!data) return '';
    return `<div style="color:#e5e7eb;font-size:15px;">Moved: (${data.from.row},${data.from.col}) → (${data.to.row},${data.to.col}), ${data.mileposts}mp, fee: ${data.trackUsageFee}M</div>`;
  }

  private renderLoadDetails(
    pickups?: Array<{ loadType: string; city: string }>,
    deliveries?: Array<{ loadType: string; city: string; payment: number; cardId: number }>,
  ): string {
    let html = '';
    if (pickups && pickups.length > 0) {
      const items = pickups.map(p => `${p.loadType} at ${p.city}`).join(', ');
      html += `<div style="color:#60a5fa;font-size:15px;">Picked up: ${items}</div>`;
    }
    if (deliveries && deliveries.length > 0) {
      const items = deliveries.map(d => `${d.loadType} to ${d.city} (+${d.payment}M)`).join(', ');
      html += `<div style="color:#fbbf24;font-size:15px;">Delivered: ${items}</div>`;
    }
    return html;
  }

  /** Escape HTML special characters for safe innerHTML insertion */
  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Render collapsible LLM Attempts panel for a bot turn */
  private renderLlmLog(log: LlmAttempt[], autoOpen: boolean = false, isFromPrevTurn: boolean = false): string {
    const failed = log.filter(a => a.status !== 'success').length;
    const staleTag = isFromPrevTurn ? ' <span style="color:#fbbf24;font-weight:normal;font-size:12px;">(from previous turn)</span>' : '';
    const failTag = failed > 0 ? ` — <span style="color:#f87171;">${failed} failed</span>` : '';
    const summaryLabel = `LLM Attempts (${log.length})${failTag}${staleTag}`;

    const STATUS_COLORS: Record<string, string> = {
      success: '#34d399',
      parse_error: '#f87171',
      validation_error: '#fbbf24',
      api_error: '#f87171',
    };

    const attempts = log.map(a => {
      const badgeColor = STATUS_COLORS[a.status] || '#9ca3af';
      const badge = `<span style="background:${badgeColor};color:#000;padding:1px 6px;border-radius:3px;font-size:12px;font-weight:bold;">${a.status}</span>`;
      const latency = `<span style="color:#9ca3af;font-size:13px;">${a.latencyMs}ms</span>`;

      let detail = '';
      if (a.error) {
        detail += `<div style="color:#f87171;font-size:13px;margin-top:2px;">Error: ${DebugOverlay.escapeHtml(a.error)}</div>`;
      }
      if (a.responseText) {
        const truncated = a.responseText.length > 500 ? a.responseText.slice(0, 500) + '...' : a.responseText;
        detail += `<pre style="color:#9ca3af;font-size:12px;margin:4px 0 0 0;padding:4px 8px;background:rgba(255,255,255,0.05);border-radius:3px;white-space:pre-wrap;word-break:break-all;max-height:100px;overflow-y:auto;">${DebugOverlay.escapeHtml(truncated)}</pre>`;
      }

      return `<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <div style="display:flex;gap:8px;align-items:center;">#${a.attemptNumber} ${badge} ${latency}</div>
        ${detail}
      </div>`;
    }).join('');

    return `
      <details ${autoOpen ? 'open' : ''} style="margin-top:8px;padding:6px 10px;background:rgba(139,92,246,0.06);border-radius:4px;border-left:3px solid #8b5cf6;">
        <summary style="cursor:pointer;color:#8b5cf6;font-size:14px;font-weight:bold;">${summaryLabel}</summary>
        <div style="margin-top:4px;">${attempts}</div>
      </details>
    `;
  }

  /** Compact LLM log summary for past turn history rows */
  private static llmLogSummary(log?: LlmAttempt[]): string {
    if (!log || log.length === 0) return '';
    const failed = log.filter(a => a.status !== 'success').length;
    if (failed > 0) {
      return ` <span style="color:#8b5cf6;font-size:12px;">[LLM: ${log.length} attempts, ${failed} failed]</span>`;
    }
    return ` <span style="color:#8b5cf6;font-size:12px;">[LLM: ${log.length} attempt${log.length > 1 ? 's' : ''}]</span>`;
  }

  /** Lighten a hex color if its luminance is too low for dark backgrounds */
  private static ensureReadable(hex: string): string {
    const match = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!match) return hex;
    let r = parseInt(match[1], 16);
    let g = parseInt(match[2], 16);
    let b = parseInt(match[3], 16);
    // Relative luminance (simplified sRGB)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (luminance >= 0.35) return hex;
    // Mix with white until readable (target ~0.5 luminance)
    const factor = 0.5 / Math.max(luminance, 0.01);
    r = Math.min(255, Math.round(r * factor + 80));
    g = Math.min(255, Math.round(g * factor + 80));
    b = Math.min(255, Math.round(b * factor + 80));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  private applyContainerStyles(): void {
    if (!this.container) return;
    Object.assign(this.container.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '60vw',
      height: '100vh',
      background: 'rgba(0, 0, 0, 0.9)',
      color: '#e5e7eb',
      fontFamily: "'Courier New', Consolas, monospace",
      fontSize: '16px',
      zIndex: '5000',
      overflowY: 'auto',
      pointerEvents: 'auto',
    });
  }
}
