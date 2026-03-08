import "phaser";
import { UI_FONT_FAMILY } from "../config/uiFont";

interface ToastEntry {
  container: Phaser.GameObjects.Container;
  hideTimer: Phaser.Time.TimerEvent;
}

/**
 * GameToastManager — Displays stacking toast banners across the top of the screen
 * announcing game events (deliveries, track builds, upgrades, LLM strategy) to all players.
 *
 * Toasts slide in from the top, stack downward, and auto-dismiss based on message length.
 */
export class GameToastManager {
  private scene: Phaser.Scene;
  private activeToasts: ToastEntry[] = [];
  private readonly TOAST_DEPTH = 9000;
  private readonly PADDING = 12;
  private readonly GAP = 8;
  private readonly SLIDE_DURATION = 300;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Show a toast banner at the top of the screen.
   * Duration auto-scales with message length if not provided.
   */
  show(message: string, options: { color?: number; duration?: number; flourish?: boolean } = {}): void {
    const { color = 0x1a1a2e, duration, flourish = false } = options;
    const displayDuration = duration ?? this.calculateDuration(message);

    const paddingX = 20;
    const paddingY = 12;
    const maxWidth = Math.min(700, this.scene.scale.width - 40);

    const text = this.scene.add.text(0, 0, message, {
      color: "#ffffff",
      fontSize: "15px",
      fontFamily: UI_FONT_FAMILY,
      wordWrap: { width: maxWidth - paddingX * 2, useAdvancedWrap: true },
    }).setOrigin(0.5, 0.5);

    const width = Math.min(maxWidth, text.width + paddingX * 2);
    const height = text.height + paddingY * 2;

    const bg = this.scene.add.rectangle(
      width / 2, height / 2, width, height, color, 0.9,
    ).setOrigin(0.5, 0.5).setStrokeStyle(1, 0xffffff, 0.3);

    text.setPosition(width / 2, height / 2);

    const x = (this.scene.scale.width - width) / 2;
    const targetY = this.PADDING + this.stackOffset();

    const container = this.scene.add.container(x, targetY - height);
    container.add([bg, text]);
    container.setDepth(this.TOAST_DEPTH);
    container.setAlpha(0);

    // Slide in from top, with optional scale flourish for celebrations
    if (flourish) {
      container.setScale(0.8);
    }
    this.scene.tweens.add({
      targets: container,
      alpha: 1,
      y: targetY,
      ...(flourish ? { scale: 1 } : {}),
      duration: flourish ? 400 : this.SLIDE_DURATION,
      ease: flourish ? "Back.easeOut" : "Power2",
    });

    const hideTimer = this.scene.time.delayedCall(displayDuration, () => {
      this.dismiss(entry);
    });

    const entry: ToastEntry = { container, hideTimer };
    this.activeToasts.push(entry);
  }

  private dismiss(entry: ToastEntry): void {
    const idx = this.activeToasts.indexOf(entry);
    if (idx === -1) return;

    this.activeToasts.splice(idx, 1);

    this.scene.tweens.add({
      targets: entry.container,
      alpha: 0,
      y: entry.container.y - 30,
      duration: this.SLIDE_DURATION,
      ease: "Power2",
      onComplete: () => {
        entry.container.destroy();
      },
    });

    // Reflow remaining toasts upward
    this.reflowToasts();
  }

  private reflowToasts(): void {
    let y = this.PADDING;
    for (const toast of this.activeToasts) {
      this.scene.tweens.add({
        targets: toast.container,
        y,
        duration: 200,
        ease: "Power2",
      });
      const bg = toast.container.list[0] as Phaser.GameObjects.Rectangle;
      y += bg.height + this.GAP;
    }
  }

  private stackOffset(): number {
    let offset = 0;
    for (const toast of this.activeToasts) {
      const bg = toast.container.list[0] as Phaser.GameObjects.Rectangle;
      offset += bg.height + this.GAP;
    }
    return offset;
  }

  /**
   * Auto-scale duration based on message length.
   * Short messages (deliveries, builds): ~3.5s
   * Long messages (LLM strategy): ~6-8s
   */
  private calculateDuration(message: string): number {
    const words = message.split(/\s+/).length;
    // ~200 wpm reading speed, minimum 3s, max 10s
    const readTimeMs = (words / 200) * 60 * 1000;
    return Math.min(10000, Math.max(3000, readTimeMs + 2000));
  }

  destroy(): void {
    for (const entry of this.activeToasts) {
      this.scene.time.removeEvent(entry.hideTimer);
      entry.container.destroy();
    }
    this.activeToasts = [];
  }
}
