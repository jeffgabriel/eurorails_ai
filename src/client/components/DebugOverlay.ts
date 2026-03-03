import "phaser";
import { GameState, Player, GameStatus, AIActionType } from '../../shared/types/GameTypes';
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
  demandRanking?: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number }>;
  // JIRA-19: LLM decision metadata
  model?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };
  retried?: boolean;
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
      if (payload?.activeRoute) {
        entry.activeRoute = payload.activeRoute;
      }
      if (payload?.demandRanking?.length) {
        entry.demandRanking = payload.demandRanking;
      }
      // JIRA-19: LLM decision metadata
      entry.model = payload?.model;
      entry.llmLatencyMs = payload?.llmLatencyMs;
      entry.tokenUsage = payload?.tokenUsage;
      entry.retried = payload?.retried;

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
      ${this.renderSocketLog()}
      ${this.renderBotTurnSection()}
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
        <div style="color:#f9fafb;font-weight:bold;font-size:18px;margin-bottom:8px;">Socket Events <span style="color:#6b7280;font-weight:normal;">(${this.eventLog.length})</span></div>
        <div style="max-height:350px;overflow-y:auto;font-size:15px;color:#e5e7eb;">
          ${entries || '<div style="color:#6b7280;">No events yet</div>'}
        </div>
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

  private renderBotTurnSection(): string {
    if (this.botTurnHistory.size === 0) {
      return `
        <div style="padding:14px 20px;border-top:1px solid rgba(255,255,255,0.15);">
          <div style="color:#f9fafb;font-weight:bold;font-size:18px;margin-bottom:8px;">Bot Turns <span style="color:#6b7280;font-weight:normal;">turns this game: ${this.botTurnCount}</span></div>
          <div style="color:#6b7280;font-size:15px;">No bot turn data yet</div>
        </div>
      `;
    }

    // Sort bots: most recently active first
    const sortedBots = [...this.botTurnHistory.entries()].sort((a, b) => {
      if (a[0] === this.lastActiveBotId) return -1;
      if (b[0] === this.lastActiveBotId) return 1;
      const aTime = a[1][0]?.startTime || 0;
      const bTime = b[1][0]?.startTime || 0;
      return bTime - aTime;
    });

    const sections = sortedBots.map(([botId, entries], i) =>
      this.renderBotSection(botId, entries, i),
    ).join('');

    return `
      <div style="padding:14px 20px;border-top:1px solid rgba(255,255,255,0.15);">
        <div style="color:#f9fafb;font-weight:bold;font-size:18px;margin-bottom:8px;">Bot Turns <span style="color:#6b7280;font-weight:normal;">turns this game: ${this.botTurnCount}</span></div>
        ${sections}
      </div>
    `;
  }

  private renderBotSection(botPlayerId: string, entries: BotTurnEntry[], colorIndex: number): string {
    const color = DebugOverlay.BOT_ACCENT_COLORS[colorIndex % DebugOverlay.BOT_ACCENT_COLORS.length];
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
      latestDetail = `<div style="color:#34d399;font-size:15px;">Bot ${latest.name} turn completed: ${latest.action} (${latest.durationMs}ms)</div>`;
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
      if (latest.demandRanking && latest.demandRanking.length > 0) {
        latestDetail += this.renderDemandRanking(latest.demandRanking);
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
      const rows = pastEntries.map(e => this.renderTurnHistoryRow(e)).join('');
      historyHtml = `
        <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;">
          <div style="color:#6b7280;font-size:13px;margin-bottom:4px;">History (${pastEntries.length})</div>
          <div style="max-height:150px;overflow-y:auto;">${rows}</div>
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

  private renderTurnHistoryRow(entry: BotTurnEntry): string {
    const turn = entry.turnNumber != null ? `T${entry.turnNumber}` : 'T?';
    const reasoning = entry.reasoning
      ? entry.reasoning.substring(0, 60) + (entry.reasoning.length > 60 ? '...' : '')
      : '';
    const duration = `${(entry.durationMs / 1000).toFixed(1)}s`;
    const grTag = entry.guardrailOverride ? ' <span style="color:#f87171;">[GR]</span>' : '';
    return `<div style="padding:2px 0;font-size:13px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${turn}: ${entry.action} <span style="color:#6b7280;">"${reasoning}"</span> (${duration})${grTag}</div>`;
  }

  private renderDemandRanking(ranking: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; score: number; rank: number }>): string {
    const rows = ranking.map(d => {
      const color = d.rank === 1 ? '#34d399' : d.score < 0 ? '#f87171' : '#e5e7eb';
      const tag = d.rank === 1 ? ' \u2190 BEST' : '';
      return `<tr style="color:${color};"><td style="padding:2px 8px;">#${d.rank}</td><td style="padding:2px 8px;">${d.loadType}</td><td style="padding:2px 8px;">${d.supplyCity}\u2192${d.deliveryCity}</td><td style="padding:2px 8px;text-align:right;">${d.payout}M</td><td style="padding:2px 8px;text-align:right;font-weight:bold;">${d.score}</td><td style="padding:2px 8px;">${tag}</td></tr>`;
    }).join('');
    return `
      <div style="margin-top:8px;padding:6px 10px;background:rgba(52,211,153,0.08);border-radius:4px;border-left:3px solid #34d399;">
        <div style="color:#34d399;font-size:14px;font-weight:bold;margin-bottom:4px;">Demand Ranking</div>
        <table style="font-size:13px;border-collapse:collapse;width:100%;">
          <tr style="color:#6b7280;"><th style="text-align:left;padding:2px 8px;">Rank</th><th style="text-align:left;padding:2px 8px;">Load</th><th style="text-align:left;padding:2px 8px;">Route</th><th style="text-align:right;padding:2px 8px;">Payout</th><th style="text-align:right;padding:2px 8px;">Score</th><th></th></tr>
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
