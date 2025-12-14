import "phaser";
import { UI_FONT_FAMILY } from "../config/uiFont";

/**
 * TurnNotification Component
 * 
 * Displays a toast-style notification when the local player becomes active.
 * Non-intrusive, auto-dismisses after a few seconds with fade animations.
 */
export class TurnNotification {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container | null = null;
  private isVisible: boolean = false;
  private hideTimer: Phaser.Time.TimerEvent | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Show the turn notification
   * @param message Optional custom message (defaults to "It's your turn!")
   * @param duration Duration in milliseconds before auto-dismiss (default: 4000ms)
   */
  public show(message: string = "It's your turn!", duration: number = 4000): void {
    // If already visible, hide the current one first
    if (this.isVisible) {
      this.hide(true); // Skip animation for immediate hide
    }

    // Clear any existing timer
    if (this.hideTimer) {
      this.scene.time.removeEvent(this.hideTimer);
      this.hideTimer = null;
    }

    const width = 300;
    const height = 60;
    const padding = 20;
    const x = this.scene.scale.width - width - padding;
    const y = padding;

    // Create container for notification positioned at target location
    this.container = this.scene.add.container(x, y);
    
    // Create semi-transparent dark background (relative to container)
    const bg = this.scene.add
      .rectangle(
        width / 2,
        height / 2,
        width,
        height,
        0x000000,
        0.8
      )
      .setOrigin(0.5, 0.5)
      .setStrokeStyle(2, 0xffffff, 0.5);

    // Create notification text (relative to container)
    const text = this.scene.add
      .text(
        width / 2,
        height / 2,
        message,
        {
          color: "#ffffff",
          fontSize: "20px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
          align: "center",
        }
      )
      .setOrigin(0.5, 0.5);

    // Add elements to container
    this.container.add([bg, text]);
    
    // Add container to scene (ensure it's on top)
    this.scene.add.existing(this.container);
    this.container.setDepth(10000); // Very high depth to ensure it's on top

    // Start with alpha 0 and offset position for fade-in animation
    this.container.setAlpha(0);
    this.container.x = x + 50; // Start off-screen to the right

    // Slide in from right and fade in
    this.scene.tweens.add({
      targets: this.container,
      alpha: { from: 0, to: 1 },
      x: { from: x + 50, to: x }, // Slide in from right
      duration: 300,
      ease: 'Power2',
      onComplete: () => {
        this.isVisible = true;
      }
    });

    // Auto-dismiss after duration
    this.hideTimer = this.scene.time.delayedCall(duration, () => {
      this.hide();
    });
  }

  /**
   * Hide the turn notification with fade-out animation
   * @param immediate If true, hide immediately without animation
   */
  public hide(immediate: boolean = false): void {
    if (!this.container || !this.isVisible) {
      return;
    }

    // Clear hide timer
    if (this.hideTimer) {
      this.scene.time.removeEvent(this.hideTimer);
      this.hideTimer = null;
    }

    if (immediate) {
      // Immediate hide - no animation
      this.container.destroy();
      this.container = null;
      this.isVisible = false;
    } else {
      // Fade out and slide out to the right
      const x = this.container.x;
      
      this.scene.tweens.add({
        targets: this.container,
        alpha: { from: 1, to: 0 },
        x: { from: x, to: x + 50 }, // Slide out to right
        duration: 300,
        ease: 'Power2',
        onComplete: () => {
          if (this.container) {
            this.container.destroy();
            this.container = null;
          }
          this.isVisible = false;
        }
      });
    }
  }

  /**
   * Clean up resources when notification is no longer needed
   */
  public destroy(): void {
    if (this.hideTimer) {
      this.scene.time.removeEvent(this.hideTimer);
      this.hideTimer = null;
    }
    
    if (this.container) {
      this.container.destroy();
      this.container = null;
    }
    
    this.isVisible = false;
  }
}

