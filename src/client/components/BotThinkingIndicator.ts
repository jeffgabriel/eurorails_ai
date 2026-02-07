import "phaser";

/**
 * BotThinkingIndicator
 *
 * Renders a pulsing circle next to an AI bot's name in the leaderboard
 * to indicate the bot is currently processing its turn.
 */
export class BotThinkingIndicator {
  private scene: Phaser.Scene;
  private circle: Phaser.GameObjects.Arc | null = null;
  private tween: Phaser.Tweens.Tween | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Create the pulsing indicator at a given position.
   * Returns the Phaser game object so the caller can add it to a container.
   */
  public create(x: number, y: number): Phaser.GameObjects.Arc {
    this.destroy();

    this.circle = this.scene.add.circle(x, y, 4, 0x00ff88, 0.9);

    this.tween = this.scene.tweens.add({
      targets: this.circle,
      alpha: { from: 0.9, to: 0.2 },
      scale: { from: 1, to: 1.4 },
      duration: 600,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    return this.circle;
  }

  public destroy(): void {
    if (this.tween) {
      this.tween.remove();
      this.tween = null;
    }
    if (this.circle) {
      this.circle.destroy();
      this.circle = null;
    }
  }
}
