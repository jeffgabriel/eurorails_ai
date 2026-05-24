import "phaser";
import { LlmAttempt } from '../../shared/types/GameTypes';

/** A single message in the transcript conversation */
interface TranscriptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
  meta?: {
    botName?: string;
    turnNumber?: number;
    attemptNumber?: number;
    status?: string;
    latencyMs?: number;
    model?: string;
  };
}

/** A group of messages from one bot turn */
interface TranscriptTurn {
  botName: string;
  turnNumber: number;
  timestamp: Date;
  messages: TranscriptMessage[];
}

/**
 * Full-screen LLM transcript overlay toggled by the spacebar.
 * Shows system/user prompts on the left and LLM responses on the right,
 * styled like an iMessage conversation. Scrollable and persistent.
 */
export class LLMTranscriptOverlay {
  private container: HTMLDivElement | null = null;
  private isOpen: boolean = false;
  private turns: TranscriptTurn[] = [];
  private keydownHandler: (e: KeyboardEvent) => void;

  private static readonly MAX_TURNS = 50;
  private static readonly STORAGE_KEY = 'eurorails.llmTranscript.open';

  constructor() {
    // Read persisted open/closed state
    try {
      this.isOpen = localStorage.getItem(LLMTranscriptOverlay.STORAGE_KEY) === 'true';
    } catch {
      this.isOpen = false;
    }

    // Create DOM container
    this.container = document.createElement('div');
    this.container.id = 'llm-transcript-overlay';
    this.applyContainerStyles();
    document.body.appendChild(this.container);

    // Keyboard toggle handler (spacebar)
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        e.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    // Initial render
    if (this.isOpen) {
      this.show();
    } else {
      this.hide();
    }
  }

  public destroy(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }

  /**
   * Ingest a bot:turn-complete payload and extract the LLM conversation.
   */
  public ingestBotTurnComplete(payload: any): void {
    if (!payload) return;

    const botName = payload.botPlayerId || 'unknown';
    const turnNumber = payload.turnNumber ?? 0;
    const systemPrompt: string | undefined = payload.systemPrompt;
    const userPrompt: string | undefined = payload.userPrompt;
    const llmLog: LlmAttempt[] | undefined = payload.llmLog;
    const model: string | undefined = payload.model;

    if (!systemPrompt && !userPrompt && (!llmLog || llmLog.length === 0)) {
      return; // No LLM data to show
    }

    const now = new Date();
    const messages: TranscriptMessage[] = [];

    // System prompt
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
        timestamp: now,
        meta: { botName, turnNumber, model },
      });
    }

    // For each LLM attempt, show the user prompt and the response
    if (llmLog && llmLog.length > 0) {
      for (const attempt of llmLog) {
        // User prompt (show on first attempt, or with error context on retries)
        if (userPrompt) {
          const promptLabel = attempt.attemptNumber > 1
            ? `[Retry ${attempt.attemptNumber}] `
            : '';
          messages.push({
            role: 'user',
            content: `${promptLabel}${userPrompt}${attempt.error && attempt.attemptNumber > 1 ? `\n\n--- VALIDATION ERROR FROM PREVIOUS ATTEMPT ---\n${attempt.error}` : ''}`,
            timestamp: now,
            meta: { botName, turnNumber, attemptNumber: attempt.attemptNumber },
          });
        }

        // LLM response
        if (attempt.responseText) {
          messages.push({
            role: 'assistant',
            content: attempt.responseText,
            timestamp: now,
            meta: {
              botName,
              turnNumber,
              attemptNumber: attempt.attemptNumber,
              status: attempt.status,
              latencyMs: attempt.latencyMs,
              model,
            },
          });
        }

        // If there was an error but no response text, show the error
        if (!attempt.responseText && attempt.error) {
          messages.push({
            role: 'assistant',
            content: `[ERROR] ${attempt.error}`,
            timestamp: now,
            meta: {
              botName,
              turnNumber,
              attemptNumber: attempt.attemptNumber,
              status: attempt.status,
              latencyMs: attempt.latencyMs,
              model,
            },
          });
        }
      }
    } else if (userPrompt) {
      // No llmLog but we have the prompt — show it anyway
      messages.push({
        role: 'user',
        content: userPrompt,
        timestamp: now,
        meta: { botName, turnNumber },
      });
    }

    if (messages.length === 0) return;

    const turn: TranscriptTurn = {
      botName,
      turnNumber,
      timestamp: now,
      messages,
    };

    this.turns.push(turn);
    if (this.turns.length > LLMTranscriptOverlay.MAX_TURNS) {
      this.turns.shift();
    }

    if (this.isOpen) {
      this.render();
      this.scrollToBottom();
    }
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
      this.container.style.display = 'flex';
    }
    this.render();
    this.scrollToBottom();
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
      localStorage.setItem(LLMTranscriptOverlay.STORAGE_KEY, String(this.isOpen));
    } catch {
      // Non-fatal
    }
  }

  private scrollToBottom(): void {
    if (!this.container) return;
    const messagesDiv = this.container.querySelector('#llm-transcript-messages');
    if (messagesDiv) {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }

  private render(): void {
    if (!this.container) return;

    const header = this.renderHeader();
    const messages = this.renderMessages();

    this.container.innerHTML = `
      ${header}
      <div id="llm-transcript-messages" style="
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
        display: flex;
        flex-direction: column;
        gap: 24px;
      ">
        ${messages}
      </div>
    `;
  }

  private renderHeader(): string {
    const turnCount = this.turns.length;
    return `
      <div style="
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(255,255,255,0.15);
        flex-shrink: 0;
      ">
        <div>
          <span style="color: #f9fafb; font-weight: bold; font-size: 22px;">LLM Transcript</span>
          <span style="margin-left: 12px; color: #9ca3af; font-size: 16px;">${turnCount} turn${turnCount !== 1 ? 's' : ''}</span>
          <span style="margin-left: 12px; color: #6b7280; font-size: 14px;">[Space to toggle]</span>
        </div>
        <button onclick="document.getElementById('llm-transcript-overlay').style.display='none'" style="
          background: none;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          font-size: 24px;
          padding: 6px 12px;
        ">&times;</button>
      </div>
    `;
  }

  private renderMessages(): string {
    if (this.turns.length === 0) {
      return `<div style="color: #6b7280; font-size: 16px; text-align: center; margin-top: 40px;">
        No LLM interactions yet. Waiting for bot turns...
      </div>`;
    }

    return this.turns.map(turn => this.renderTurn(turn)).join('');
  }

  private renderTurn(turn: TranscriptTurn): string {
    const timeStr = turn.timestamp.toLocaleTimeString();
    const messages = turn.messages.map(msg => this.renderMessage(msg)).join('');

    return `
      <div style="margin-bottom: 8px;">
        <div style="
          text-align: center;
          margin-bottom: 12px;
          color: #6b7280;
          font-size: 13px;
        ">
          <span style="
            background: rgba(255,255,255,0.08);
            padding: 4px 12px;
            border-radius: 12px;
          ">Turn ${turn.turnNumber} — ${turn.botName} — ${timeStr}</span>
        </div>
        ${messages}
      </div>
    `;
  }

  private renderMessage(msg: TranscriptMessage): string {
    const isLeft = msg.role === 'system' || msg.role === 'user';

    // Colors
    let bubbleBg: string;
    let labelColor: string;
    let label: string;

    if (msg.role === 'system') {
      bubbleBg = 'rgba(99, 102, 241, 0.25)';
      labelColor = '#818cf8';
      label = 'SYSTEM';
    } else if (msg.role === 'user') {
      bubbleBg = 'rgba(59, 130, 246, 0.25)';
      labelColor = '#60a5fa';
      label = 'USER PROMPT';
    } else {
      bubbleBg = 'rgba(34, 197, 94, 0.25)';
      labelColor = '#34d399';
      label = 'LLM RESPONSE';
    }

    // Meta line
    const metaParts: string[] = [];
    if (msg.meta?.model) metaParts.push(msg.meta.model);
    if (msg.meta?.attemptNumber && msg.meta.attemptNumber > 1) metaParts.push(`attempt #${msg.meta.attemptNumber}`);
    if (msg.meta?.latencyMs) metaParts.push(`${msg.meta.latencyMs}ms`);
    if (msg.meta?.status && msg.meta.status !== 'success') metaParts.push(msg.meta.status);
    const metaLine = metaParts.length > 0
      ? `<div style="color: #6b7280; font-size: 12px; margin-top: 4px;">${this.escapeHtml(metaParts.join(' · '))}</div>`
      : '';

    // Content — truncate with expandable details if very long
    const content = msg.content;
    const maxPreview = 2000;
    let contentHtml: string;

    if (content.length > maxPreview) {
      const preview = content.substring(0, maxPreview);
      contentHtml = `
        <details style="margin: 0;">
          <summary style="cursor: pointer; color: ${labelColor}; font-size: 12px; margin-bottom: 4px;">
            Show full (${content.length.toLocaleString()} chars)
          </summary>
          <pre style="
            white-space: pre-wrap;
            word-break: break-word;
            margin: 0;
            font-size: 13px;
            line-height: 1.4;
            color: #e5e7eb;
            max-height: 60vh;
            overflow-y: auto;
          ">${this.escapeHtml(content)}</pre>
        </details>
        <pre style="
          white-space: pre-wrap;
          word-break: break-word;
          margin: 0;
          font-size: 13px;
          line-height: 1.4;
          color: #e5e7eb;
        ">${this.escapeHtml(preview)}…</pre>
      `;
    } else {
      contentHtml = `<pre style="
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        font-size: 13px;
        line-height: 1.4;
        color: #e5e7eb;
      ">${this.escapeHtml(content)}</pre>`;
    }

    const alignment = isLeft ? 'flex-start' : 'flex-end';
    const maxWidth = '75%';

    return `
      <div style="
        display: flex;
        justify-content: ${alignment};
        margin-bottom: 8px;
      ">
        <div style="
          max-width: ${maxWidth};
          background: ${bubbleBg};
          border-radius: 12px;
          padding: 10px 14px;
        ">
          <div style="
            color: ${labelColor};
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
          ">${label}</div>
          ${contentHtml}
          ${metaLine}
        </div>
      </div>
    `;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private applyContainerStyles(): void {
    if (!this.container) return;
    Object.assign(this.container.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      background: 'rgba(0, 0, 0, 0.92)',
      color: '#e5e7eb',
      fontFamily: "'Courier New', Consolas, monospace",
      fontSize: '16px',
      zIndex: '6000',
      display: 'none',
      flexDirection: 'column',
      pointerEvents: 'auto',
    });
  }
}
