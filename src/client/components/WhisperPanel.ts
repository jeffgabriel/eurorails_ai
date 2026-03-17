import "phaser";
import { socketService } from '../lobby/shared/socket';
import { GameToastManager } from './GameToastManager';
import type { BotTurnSummary } from '../../shared/types/WhisperTypes';

/** Accumulated bot turn data from bot:turn-complete events */
export interface WhisperTurnEntry {
  turnNumber: number;
  botPlayerId: string;
  botName: string;
  action: string;
  reasoning: string;
  cost: number;
  segmentsBuilt: number;
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number }>;
  milepostsMoved?: number;
  compositionTrace?: object;
  demandRanking?: object[];
}

/**
 * Overlay panel for composing and submitting whisper advice about bot turns.
 * Activated by the 'w' key during gameplay.
 * Follows the Phaser DOM overlay pattern used by DebugOverlay.
 */
export class WhisperPanel {
  private scene: Phaser.Scene;
  private container: HTMLDivElement | null = null;
  private isOpen: boolean = false;
  private turnHistory: WhisperTurnEntry[] = [];
  private selectedTurnIndex: number = 0;
  private gameId: string;
  private gameToastManager: GameToastManager | null;
  private keydownHandler: (e: KeyboardEvent) => void;

  constructor(
    scene: Phaser.Scene,
    gameId: string,
    gameToastManager: GameToastManager | null,
  ) {
    this.scene = scene;
    this.gameId = gameId;
    this.gameToastManager = gameToastManager;

    // Create DOM container
    this.container = document.createElement('div');
    this.container.id = 'whisper-panel';
    this.applyContainerStyles();
    this.container.style.display = 'none';
    document.body.appendChild(this.container);

    // Keyboard toggle handler
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'w' || e.key === 'W') {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        this.toggle();
      }
      // Ctrl+Enter to submit when panel is open
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && this.isOpen) {
        e.preventDefault();
        this.handleSubmit();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    // Listen for whisper responses
    socketService.onWhisperRecorded((data) => {
      this.gameToastManager?.show(
        `Whisper recorded for turn ${data.turnNumber}`,
        { color: 0x6366f1, duration: 4000 },
      );
      this.clearForm();
    });

    socketService.onWhisperError((data) => {
      this.gameToastManager?.show(
        `Whisper error: ${data.message}`,
        { color: 0xdc2626, duration: 6000 },
      );
    });
  }

  /** Add a bot turn to the history (called from GameScene on bot:turn-complete) */
  public addBotTurn(entry: WhisperTurnEntry): void {
    this.turnHistory.unshift(entry);
    if (this.isOpen) {
      this.selectedTurnIndex = 0;
      this.render();
    }
  }

  /** Get accumulated turn history (for testing) */
  public getTurnHistory(): WhisperTurnEntry[] {
    return this.turnHistory;
  }

  public toggle(): void {
    if (this.isOpen) {
      this.hide();
    } else {
      this.show();
    }
  }

  private show(): void {
    this.isOpen = true;
    if (this.container) {
      this.container.style.display = 'block';
    }
    this.render();
  }

  private hide(): void {
    this.isOpen = false;
    if (this.container) {
      this.container.style.display = 'none';
    }
  }

  public destroy(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }

  private render(): void {
    if (!this.container) return;

    if (this.turnHistory.length === 0) {
      this.container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(99,102,241,0.3);">
          <span style="color:#e0e7ff;font-weight:bold;font-size:18px;">Whisper Advice</span>
          <button id="whisper-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:24px;padding:6px 12px;">&times;</button>
        </div>
        <div style="padding:40px 20px;text-align:center;color:#9ca3af;font-size:16px;">
          No bot turns to whisper about yet
        </div>
      `;
      this.container.querySelector('#whisper-close')?.addEventListener('click', () => this.hide());
      return;
    }

    const selectedTurn = this.turnHistory[this.selectedTurnIndex];

    // Build turn selector options
    const options = this.turnHistory.map((t, i) => {
      const selected = i === this.selectedTurnIndex ? 'selected' : '';
      return `<option value="${i}" ${selected}>Turn ${t.turnNumber} - ${WhisperPanel.escapeHtml(t.botName)}</option>`;
    }).join('');

    // Bot decision summary
    const reasoning = selectedTurn.reasoning
      ? WhisperPanel.escapeHtml(selectedTurn.reasoning)
      : 'No reasoning provided';

    let loadsInfo = '';
    if (selectedTurn.loadsPickedUp?.length) {
      const items = selectedTurn.loadsPickedUp.map(p => `${p.loadType} at ${p.city}`).join(', ');
      loadsInfo += `<div style="color:#60a5fa;font-size:14px;margin-top:4px;">Picked up: ${items}</div>`;
    }
    if (selectedTurn.loadsDelivered?.length) {
      const items = selectedTurn.loadsDelivered.map(d => `${d.loadType} to ${d.city} (+${d.payment}M)`).join(', ');
      loadsInfo += `<div style="color:#fbbf24;font-size:14px;margin-top:4px;">Delivered: ${items}</div>`;
    }

    this.container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(99,102,241,0.3);">
        <span style="color:#e0e7ff;font-weight:bold;font-size:18px;">Whisper Advice</span>
        <button id="whisper-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:24px;padding:6px 12px;">&times;</button>
      </div>

      <div style="padding:12px 20px;border-bottom:1px solid rgba(99,102,241,0.15);">
        <label style="color:#a5b4fc;font-size:14px;display:block;margin-bottom:6px;">Turn:</label>
        <select id="whisper-turn-select" style="width:100%;padding:8px 12px;background:#1e1b4b;color:#e0e7ff;border:1px solid rgba(99,102,241,0.3);border-radius:6px;font-size:15px;outline:none;">
          ${options}
        </select>
      </div>

      <div style="padding:12px 20px;border-bottom:1px solid rgba(99,102,241,0.15);">
        <div style="color:#a5b4fc;font-size:14px;margin-bottom:6px;">Bot's Decision:</div>
        <div style="padding:10px 14px;background:rgba(99,102,241,0.08);border-radius:6px;border-left:3px solid #6366f1;">
          <div style="color:#c7d2fe;font-size:15px;font-weight:bold;">Action: ${WhisperPanel.escapeHtml(selectedTurn.action)}</div>
          <div style="color:#a5b4fc;font-size:14px;margin-top:6px;">${reasoning}</div>
          ${loadsInfo}
        </div>
      </div>

      <div style="padding:12px 20px;">
        <label style="color:#a5b4fc;font-size:14px;display:block;margin-bottom:6px;">Your advice:</label>
        <textarea id="whisper-advice" placeholder="What would you have done differently?" style="width:100%;height:120px;padding:10px 14px;background:#1e1b4b;color:#e0e7ff;border:1px solid rgba(99,102,241,0.3);border-radius:6px;font-size:15px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box;"></textarea>
        <div style="text-align:right;margin-top:10px;">
          <button id="whisper-submit" style="padding:10px 24px;background:#4f46e5;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:bold;cursor:pointer;">Submit Whisper</button>
        </div>
        <div style="color:#6b7280;font-size:12px;margin-top:6px;text-align:right;">Ctrl+Enter to submit</div>
      </div>
    `;

    // Event listeners
    this.container.querySelector('#whisper-close')?.addEventListener('click', () => this.hide());

    this.container.querySelector('#whisper-turn-select')?.addEventListener('change', (e) => {
      this.selectedTurnIndex = parseInt((e.target as HTMLSelectElement).value, 10);
      this.render();
    });

    this.container.querySelector('#whisper-submit')?.addEventListener('click', () => this.handleSubmit());
  }

  private handleSubmit(): void {
    if (this.turnHistory.length === 0) return;

    const textarea = this.container?.querySelector('#whisper-advice') as HTMLTextAreaElement | null;
    const advice = textarea?.value?.trim();

    if (!advice) {
      this.gameToastManager?.show('Please enter your advice before submitting', { color: 0xf59e0b, duration: 3000 });
      return;
    }

    const selectedTurn = this.turnHistory[this.selectedTurnIndex];

    const botTurnSummary: BotTurnSummary = {
      action: selectedTurn.action,
      reasoning: selectedTurn.reasoning,
      cost: selectedTurn.cost,
      segmentsBuilt: selectedTurn.segmentsBuilt,
      loadsPickedUp: selectedTurn.loadsPickedUp,
      loadsDelivered: selectedTurn.loadsDelivered,
      milepostsMoved: selectedTurn.milepostsMoved,
      compositionTrace: selectedTurn.compositionTrace,
      demandRanking: selectedTurn.demandRanking,
    };

    socketService.submitWhisper({
      gameId: this.gameId,
      turnNumber: selectedTurn.turnNumber,
      botPlayerId: selectedTurn.botPlayerId,
      advice,
      botTurnSummary,
    });
  }

  private clearForm(): void {
    const textarea = this.container?.querySelector('#whisper-advice') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = '';
    }
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private applyContainerStyles(): void {
    if (!this.container) return;
    Object.assign(this.container.style, {
      position: 'fixed',
      top: '80px',
      right: '20px',
      width: '380px',
      maxHeight: 'calc(100vh - 100px)',
      background: 'rgba(15, 23, 42, 0.95)',
      color: '#e0e7ff',
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      fontSize: '15px',
      zIndex: '4000',
      overflowY: 'auto',
      pointerEvents: 'auto',
      borderRadius: '12px',
      border: '1px solid rgba(99, 102, 241, 0.3)',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    });
  }
}
