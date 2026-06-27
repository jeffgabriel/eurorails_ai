import { Scene } from 'phaser';
import { EventCardDrawnPayload, EventCardType as EventCardTypeEnum } from '../../shared/types/EventCard';
import { UI_FONT_FAMILY } from '../config/uiFont';

/** Auto-dismiss delay in milliseconds */
const AUTO_DISMISS_DELAY_MS = 30_000;

/** Dismiss button dimensions */
const BUTTON_WIDTH = 200;
const BUTTON_HEIGHT = 44;

/** Card panel width */
const CARD_WIDTH = 340;

/** Internal padding */
const PAD = 16;

/** Maps EventCardType enum values to display icons */
const EVENT_TYPE_ICONS: Record<EventCardTypeEnum, string> = {
  [EventCardTypeEnum.Strike]: '🚫',
  [EventCardTypeEnum.Derailment]: '⚠️',
  [EventCardTypeEnum.Snow]: '❄️',
  [EventCardTypeEnum.Flood]: '🌊',
  [EventCardTypeEnum.ExcessProfitTax]: '💰',
};

/**
 * Full-screen modal overlay that displays an event card to all players.
 * Blocks all underlying game interaction while visible.
 * Auto-dismisses after 30 seconds if not manually dismissed.
 *
 * All elements are built directly in a native Phaser Container positioned
 * at the camera's worldView origin, matching the pattern used by PlayerHandScene
 * modals.
 */
export class EventCardOverlay {
  private autoDismissTimer: Phaser.Time.TimerEvent | null = null;
  private readonly onDismiss: () => void;
  private readonly root: Phaser.GameObjects.Container;
  private readonly scene: Scene;

  constructor(
    scene: Scene,
    payload: EventCardDrawnPayload,
    onDismiss: () => void
  ) {
    this.scene = scene;
    this.onDismiss = onDismiss;

    const cam = scene.cameras.main;
    const worldView = cam.worldView;
    const viewW = worldView.width;
    const viewH = worldView.height;
    const originX = worldView.x;
    const originY = worldView.y;

    this.root = scene.add.container(originX, originY);
    this.root.setDepth(1000);
    this.root.name = 'EventCardOverlay';

    const cx = viewW / 2;

    // ── Backdrop ──────────────────────────────────────────────────────────────
    const backdrop = scene.add
      .rectangle(cx, viewH / 2, viewW, viewH, 0x000000, 0.72)
      .setOrigin(0.5)
      .setInteractive();
    backdrop.name = 'EventCardOverlay_backdrop';
    backdrop.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      pointer.event?.stopPropagation();
    });
    this.root.add(backdrop);

    // ── Build card content top-down, measuring as we go ─────────────────────
    // We'll place elements relative to a running cursor `y`, then size the
    // background to fit afterwards.

    const cardLeft = cx - CARD_WIDTH / 2;
    let cursorY = 0; // relative to card top

    // Header
    const icon = EVENT_TYPE_ICONS[payload.card.type] ?? '📋';
    const headerText = scene.add
      .text(0, 0, `${icon}  EVENT CARD #${payload.card.id}`, {
        fontSize: '13px',
        color: '#f0a500',
        fontFamily: UI_FONT_FAMILY,
        fontStyle: 'bold',
      })
      .setOrigin(0, 0);
    headerText.name = 'EventCard_header';
    cursorY += PAD;

    // Divider (placed after header)
    const dividerY = cursorY + headerText.height + 8;

    // Title
    const titleText = scene.add
      .text(0, 0, payload.card.title.toUpperCase(), {
        fontSize: '20px',
        color: '#ffffff',
        fontFamily: UI_FONT_FAMILY,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: CARD_WIDTH - PAD * 2 },
      })
      .setOrigin(0.5, 0);
    titleText.name = 'EventCard_title';
    const titleY = dividerY + 12;

    // Description
    const descText = scene.add
      .text(0, 0, payload.card.description, {
        fontSize: '13px',
        color: '#cccccc',
        fontFamily: UI_FONT_FAMILY,
        align: 'center',
        wordWrap: { width: CARD_WIDTH - PAD * 2 },
      })
      .setOrigin(0.5, 0);
    descText.name = 'EventCard_description';
    const descY = titleY + titleText.height + 12;

    // Meta text
    const metaLines: string[] = [
      `Drawn by: ${payload.drawingPlayerName}`,
      `Duration: ${payload.duration === 'immediate' ? 'Immediate effect' : 'Until end of next turn'}`,
    ];
    if (payload.affectedPlayerIds.length > 0) {
      metaLines.push(`Affected: ${payload.affectedPlayerIds.join(', ')}`);
    }
    if (payload.effectSummary) {
      metaLines.push(payload.effectSummary);
    }

    const metaText = scene.add
      .text(0, 0, metaLines.join('\n'), {
        fontSize: '11px',
        color: '#999999',
        fontFamily: UI_FONT_FAMILY,
        align: 'center',
        wordWrap: { width: CARD_WIDTH - PAD * 2 },
      })
      .setOrigin(0.5, 0);
    metaText.name = 'EventCardOverlay_meta';
    const metaY = descY + descText.height + 16;

    // Dismiss button
    const buttonY = metaY + metaText.height + 16;

    // Total card height
    const cardHeight = buttonY + BUTTON_HEIGHT + PAD;

    // ── Now position everything with the card centered on screen ────────────
    const cardTop = (viewH - cardHeight) / 2;

    // Card background
    const cardBg = scene.add
      .rectangle(cx, cardTop + cardHeight / 2, CARD_WIDTH, cardHeight, 0x1a1a2e)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xf0a500);
    cardBg.name = 'EventCard_bg';
    this.root.add(cardBg);

    // Position all text elements
    headerText.setPosition(cardLeft + PAD, cardTop + cursorY);
    this.root.add(headerText);

    const divider = scene.add
      .rectangle(cx, cardTop + dividerY, CARD_WIDTH - PAD, 1, 0xf0a500)
      .setOrigin(0.5, 0.5);
    divider.name = 'EventCard_divider';
    this.root.add(divider);

    titleText.setPosition(cx, cardTop + titleY);
    this.root.add(titleText);

    descText.setPosition(cx, cardTop + descY);
    this.root.add(descText);

    metaText.setPosition(cx, cardTop + metaY);
    this.root.add(metaText);

    // Dismiss button
    const btnAbsY = cardTop + buttonY + BUTTON_HEIGHT / 2;
    const btnBg = scene.add
      .rectangle(cx, btnAbsY, BUTTON_WIDTH, BUTTON_HEIGHT, 0xf0a500)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btnBg.name = 'EventCardOverlay_btnBg';
    this.root.add(btnBg);

    const btnLabel = scene.add
      .text(cx, btnAbsY, 'OK — Dismiss', {
        fontSize: '15px',
        color: '#1a1a2e',
        fontFamily: UI_FONT_FAMILY,
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5);
    btnLabel.name = 'EventCardOverlay_btnLabel';
    this.root.add(btnLabel);

    btnBg.on('pointerover', () => btnBg.setFillStyle(0xffc200));
    btnBg.on('pointerout', () => btnBg.setFillStyle(0xf0a500));
    btnBg.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      pointer.event?.stopPropagation();
      this.dismiss();
    });

    // ── Auto-dismiss timer ───────────────────────────────────────────────────
    this.autoDismissTimer = scene.time.addEvent({
      delay: AUTO_DISMISS_DELAY_MS,
      callback: this.dismiss,
      callbackScope: this,
    });
  }

  private dismiss(): void {
    this.clearTimer();
    this.onDismiss();
    this.root.destroy(true);
  }

  private clearTimer(): void {
    if (this.autoDismissTimer) {
      this.autoDismissTimer.remove(false);
      this.autoDismissTimer = null;
    }
  }

  public cancel(): void {
    this.clearTimer();
    this.root.destroy(true);
  }

  public destroy(): void {
    this.cancel();
  }
}
