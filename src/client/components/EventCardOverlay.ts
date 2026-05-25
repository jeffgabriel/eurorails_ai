import { Scene } from 'phaser';
import ContainerLite from 'phaser3-rex-plugins/plugins/containerlite.js';
import { EventCardDrawnPayload } from '../../shared/types/EventCard';
import { EventCard } from './EventCard';
import { UI_FONT_FAMILY } from '../config/uiFont';

/** Auto-dismiss delay in milliseconds */
const AUTO_DISMISS_DELAY_MS = 30_000;

/** Vertical gap between the event card panel and the dismiss button */
const BUTTON_GAP = 20;
/** Dismiss button dimensions */
const BUTTON_WIDTH = 200;
const BUTTON_HEIGHT = 44;

/**
 * Full-screen modal overlay that displays an event card to all players.
 * Blocks all underlying game interaction while visible.
 * Auto-dismisses after 30 seconds if not manually dismissed.
 *
 * Follows the ContainerLite pattern from DemandCard.ts / EventCard.ts.
 */
export class EventCardOverlay extends ContainerLite {
  private autoDismissTimer: Phaser.Time.TimerEvent | null = null;
  private readonly onDismiss: () => void;

  constructor(
    scene: Scene,
    payload: EventCardDrawnPayload,
    onDismiss: () => void
  ) {
    // Position at top-left; we fill the full camera viewport manually
    super(scene, 0, 0);
    this.onDismiss = onDismiss;

    const { width, height } = scene.cameras.main;

    // ── Backdrop ──────────────────────────────────────────────────────────────
    // Semi-transparent black rectangle covering the full viewport.
    const backdrop = scene.add
      .rectangle(width / 2, height / 2, width, height, 0x000000, 0.72)
      .setOrigin(0.5)
      .setInteractive(); // Swallow all pointer events beneath the overlay
    this.add(backdrop);

    // ── Event card panel ─────────────────────────────────────────────────────
    const cardComponent = new EventCard(scene, width / 2, height / 2 - 30, payload.card);
    scene.add.existing(cardComponent);
    this.add(cardComponent);

    // ── Metadata text (drawer, duration, affected players) ──────────────────
    const cardBottom = height / 2 - 30 + 150; // card center + half card height

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
      .text(width / 2, cardBottom + 12, metaLines.join('\n'), {
        fontSize: '12px',
        color: '#aaaaaa',
        fontFamily: UI_FONT_FAMILY,
        align: 'center',
        wordWrap: { width: 320 },
      })
      .setOrigin(0.5, 0);
    this.add(metaText);

    // ── Dismiss button ───────────────────────────────────────────────────────
    const buttonY = cardBottom + 12 + 60 + BUTTON_GAP;
    this.buildDismissButton(scene, width / 2, buttonY);

    // ── Z-ordering: bring entire overlay to the top ──────────────────────────
    // setDepth ensures this container renders above all other game objects.
    this.setDepth(1000);

    // ── Auto-dismiss timer ───────────────────────────────────────────────────
    this.autoDismissTimer = scene.time.addEvent({
      delay: AUTO_DISMISS_DELAY_MS,
      callback: this.dismiss,
      callbackScope: this,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildDismissButton(scene: Scene, x: number, y: number): void {
    // Button background
    const btnBg = scene.add
      .rectangle(x, y, BUTTON_WIDTH, BUTTON_HEIGHT, 0xf0a500)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.add(btnBg);

    // Button label
    const btnLabel = scene.add
      .text(x, y, 'OK — Dismiss', {
        fontSize: '15px',
        color: '#1a1a2e',
        fontFamily: UI_FONT_FAMILY,
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5);
    this.add(btnLabel);

    // Hover effects
    btnBg.on('pointerover', () => btnBg.setFillStyle(0xffc200));
    btnBg.on('pointerout', () => btnBg.setFillStyle(0xf0a500));

    // Click triggers dismissal
    btnBg.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      pointer.event?.stopPropagation();
      this.dismiss();
    });
  }

  /** Clears the auto-dismiss timer and invokes the provided onDismiss callback. */
  private dismiss(): void {
    this.clearTimer();
    this.onDismiss();
    // Destroy the overlay once dismissed so Phaser cleans up resources
    this.destroy();
  }

  private clearTimer(): void {
    if (this.autoDismissTimer) {
      this.autoDismissTimer.remove(false);
      this.autoDismissTimer = null;
    }
  }

  /** Call this if you need to manually cancel the overlay without triggering onDismiss. */
  public cancel(): void {
    this.clearTimer();
    this.destroy();
  }
}
