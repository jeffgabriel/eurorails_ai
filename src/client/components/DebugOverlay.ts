import "phaser";
import { GameState, Player, GameStatus } from '../../shared/types/GameTypes';
import { GameStateService } from '../services/GameStateService';

/** Captured socket event for the debug log ring buffer */
interface SocketEvent {
  name: string;
  payload: string;
  timestamp: Date;
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

  private static readonly MAX_EVENTS = 50;
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
    if (this.isOpen) this.render();
  }

  private render(): void {
    if (!this.container) return;
    const gameState = (this.scene as any).gameState as GameState | undefined;
    if (!gameState) {
      this.container.innerHTML = '<div style="padding:12px;color:#9ca3af;">Waiting for game state...</div>';
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
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.1);">
        <div>
          <span style="color:#f9fafb;font-weight:bold;font-size:14px;">Debug Overlay</span>
          <span style="margin-left:8px;color:#9ca3af;font-size:11px;">${gameId}</span>
          <span style="margin-left:8px;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,0.1);color:#e5e7eb;font-size:11px;">${status}</span>
        </div>
        <button onclick="document.getElementById('debug-overlay').style.display='none'" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;padding:4px 8px;">&times;</button>
      </div>
      <div style="padding:4px 12px;color:#9ca3af;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.1);">
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
        <td style="padding:2px 6px;">${p.name}</td>
        <td style="padding:2px 6px;text-align:center;">${isBot ? 'Y' : 'N'}</td>
        <td style="padding:2px 6px;text-align:right;">${p.money ?? 0}</td>
        <td style="padding:2px 6px;">${pos}</td>
        <td style="padding:2px 6px;">${p.trainType ?? '—'}</td>
        <td style="padding:2px 6px;">${loads}</td>
        <td style="padding:2px 6px;text-align:right;">${p.turnNumber ?? 0}</td>
      </tr>`;
    }).join('');

    return `
      <div style="padding:8px 12px;">
        <div style="color:#f9fafb;font-weight:bold;font-size:12px;margin-bottom:4px;">Players</div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;color:#e5e7eb;">
          <thead>
            <tr style="color:#9ca3af;border-bottom:1px solid rgba(255,255,255,0.1);">
              <th style="padding:2px 6px;text-align:left;">Name</th>
              <th style="padding:2px 6px;text-align:center;">Bot?</th>
              <th style="padding:2px 6px;text-align:right;">Money</th>
              <th style="padding:2px 6px;text-align:left;">Position</th>
              <th style="padding:2px 6px;text-align:left;">Train</th>
              <th style="padding:2px 6px;text-align:left;">Loads</th>
              <th style="padding:2px 6px;text-align:right;">Turn#</th>
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
      return `<div style="padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        <span style="color:#9ca3af;">[${time}]</span>
        <span style="color:#60a5fa;">${e.name}</span>
        <span style="color:#6b7280;"> — ${e.payload}</span>
      </div>`;
    }).join('');

    return `
      <div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,0.1);">
        <div style="color:#f9fafb;font-weight:bold;font-size:12px;margin-bottom:4px;">Socket Events <span style="color:#6b7280;font-weight:normal;">(${this.eventLog.length})</span></div>
        <div style="max-height:200px;overflow-y:auto;font-size:11px;color:#e5e7eb;">
          ${entries || '<div style="color:#6b7280;">No events yet</div>'}
        </div>
      </div>
    `;
  }

  private renderBotTurnSection(): string {
    return `
      <div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,0.1);">
        <div style="color:#f9fafb;font-weight:bold;font-size:12px;margin-bottom:4px;">Bot Turn</div>
        <div style="color:#6b7280;font-size:11px;">No bot turn data yet — bot turn execution not implemented</div>
      </div>
    `;
  }

  private applyContainerStyles(): void {
    if (!this.container) return;
    Object.assign(this.container.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '400px',
      height: '100vh',
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#e5e7eb',
      fontFamily: "'Courier New', Consolas, monospace",
      fontSize: '12px',
      zIndex: '5000',
      overflowY: 'auto',
      pointerEvents: 'auto',
    });
  }
}
