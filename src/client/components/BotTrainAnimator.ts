import "phaser";
import type { TimelineStep } from '../../shared/types/GameTypes';

const MILEPOST_TWEEN_MS = 150;
const ACTION_PAUSE_MS = 300;

/**
 * BotTrainAnimator — Animates bot train sprites along movement paths
 * received from bot:turn-complete socket events.
 *
 * Manages active animations per player and supports cancellation
 * for rapid sequential bot turns.
 */
export class BotTrainAnimator {
  private scene: Phaser.Scene;
  private activeAnimations = new Map<string, { cancelled: boolean }>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Check if a player has an active animation. */
  isAnimating(playerId: string): boolean {
    return this.activeAnimations.has(playerId);
  }

  /**
   * Cancel any in-progress animation for a player.
   * The animation loop checks the cancelled flag and snaps to final position.
   */
  cancelAnimation(playerId: string): void {
    const state = this.activeAnimations.get(playerId);
    if (state) {
      state.cancelled = true;
    }
  }

  /**
   * Animate a train sprite through each waypoint in the path.
   *
   * @param playerId - The player whose train to animate
   * @param path - Array of { row, col } mileposts
   * @param gridPoints - mapRenderer.gridPoints for coordinate conversion
   * @param getSprite - Function to retrieve the current sprite for the player
   * @returns Promise that resolves when animation completes (or is cancelled)
   */
  async animateAlongPath(
    playerId: string,
    path: { row: number; col: number }[],
    gridPoints: any[][],
    getSprite: () => Phaser.GameObjects.Image | undefined,
  ): Promise<{ row: number; col: number; x: number; y: number } | null> {
    // Convert grid coords to world pixel positions
    const worldPath = path
      .map(p => {
        const gp = gridPoints[p.row]?.[p.col];
        return gp ? { x: gp.x, y: gp.y, row: p.row, col: p.col } : null;
      })
      .filter((p): p is { x: number; y: number; row: number; col: number } => p !== null);

    if (worldPath.length < 2) return null;

    // Cancel any existing animation for this player
    this.cancelAnimation(playerId);

    const animState = { cancelled: false };
    this.activeAnimations.set(playerId, animState);

    try {
      for (let i = 1; i < worldPath.length; i++) {
        if (animState.cancelled) break;

        const sprite = getSprite();
        if (!sprite) break;

        const target = worldPath[i];
        await new Promise<void>(resolve => {
          if (animState.cancelled || !this.scene || !this.scene.tweens) {
            resolve();
            return;
          }
          this.scene.tweens.add({
            targets: sprite,
            x: target.x,
            y: target.y,
            duration: MILEPOST_TWEEN_MS,
            ease: 'Linear',
            onComplete: () => resolve(),
          });
        });
      }

      // If cancelled mid-animation, snap sprite to final position
      if (animState.cancelled) {
        const sprite = getSprite();
        const finalPos = worldPath[worldPath.length - 1];
        if (sprite && finalPos) {
          sprite.setPosition(finalPos.x, finalPos.y);
        }
      }

      const finalPos = worldPath[worldPath.length - 1];
      return finalPos;
    } finally {
      this.activeAnimations.delete(playerId);
    }
  }

  /**
   * Animate a structured action timeline — move segments animate visually,
   * action steps (deliver/pickup/etc.) invoke onAction callback for toasts.
   */
  async animateTimeline(
    playerId: string,
    timeline: TimelineStep[],
    gridPoints: any[][],
    getSprite: () => Phaser.GameObjects.Image | undefined,
    onAction: (step: TimelineStep) => void,
  ): Promise<{ row: number; col: number; x: number; y: number } | null> {
    this.cancelAnimation(playerId);

    const animState = { cancelled: false };
    this.activeAnimations.set(playerId, animState);
    let lastPos: { row: number; col: number; x: number; y: number } | null = null;

    try {
      for (const step of timeline) {
        if (animState.cancelled) break;

        if (step.type === 'move') {
          const worldPath = step.path
            .map(p => {
              const gp = gridPoints[p.row]?.[p.col];
              return gp ? { x: gp.x, y: gp.y, row: p.row, col: p.col } : null;
            })
            .filter((p): p is { x: number; y: number; row: number; col: number } => p !== null);

          for (let i = 1; i < worldPath.length; i++) {
            if (animState.cancelled) break;
            const sprite = getSprite();
            if (!sprite) break;

            const target = worldPath[i];
            await new Promise<void>(resolve => {
              if (animState.cancelled || !this.scene || !this.scene.tweens) {
                resolve();
                return;
              }
              this.scene.tweens.add({
                targets: sprite,
                x: target.x,
                y: target.y,
                duration: MILEPOST_TWEEN_MS,
                ease: 'Linear',
                onComplete: () => resolve(),
              });
            });
            lastPos = target;
          }
        } else {
          // Non-move step: fire callback and pause briefly
          onAction(step);
          await new Promise<void>(resolve => {
            if (animState.cancelled) { resolve(); return; }
            this.scene.time.delayedCall(ACTION_PAUSE_MS, resolve);
          });
        }
      }

      // If cancelled mid-animation, snap to last known position
      if (animState.cancelled && lastPos) {
        const sprite = getSprite();
        if (sprite) sprite.setPosition(lastPos.x, lastPos.y);
      }

      return lastPos;
    } finally {
      this.activeAnimations.delete(playerId);
    }
  }

  /** Clean up all animations (e.g., on scene shutdown). */
  destroy(): void {
    for (const [, state] of this.activeAnimations) {
      state.cancelled = true;
    }
    this.activeAnimations.clear();
  }
}
