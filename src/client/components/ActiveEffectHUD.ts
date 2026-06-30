import { Scene } from 'phaser';
import { ActiveEffectSummary } from '../../shared/types/EventCard';
import { EventCardType } from '../../shared/types/EventCard';
import { UI_FONT_FAMILY } from '../config/uiFont';

/** Maps EventCardType string values to display icons */
const EVENT_TYPE_ICONS: Record<string, string> = {
  [EventCardType.Strike]: '🚫',
  [EventCardType.Derailment]: '⚠️',
  [EventCardType.Snow]: '❄️',
  [EventCardType.Flood]: '🌊',
  [EventCardType.ExcessProfitTax]: '💰',
};

/** Short human-readable labels for each event type */
const EVENT_TYPE_LABELS: Record<string, string> = {
  [EventCardType.Strike]: 'Strike',
  [EventCardType.Derailment]: 'Derailment',
  [EventCardType.Snow]: 'Snow',
  [EventCardType.Flood]: 'Flood',
  [EventCardType.ExcessProfitTax]: 'Tax',
};

/** Font size for active effect rows */
const EFFECT_FONT_SIZE = '13px';

/** Color for effect row text */
const EFFECT_TEXT_COLOR = '#ffdd88';

/**
 * HUD component that displays active event effects within the PlayerHandScene infoSizer.
 *
 * Follows the RexUI sizer pattern used throughout PlayerHandScene.
 * Returns a sizer that can be added directly to any parent sizer.
 */
export class ActiveEffectHUD {
  private scene: Scene;
  private sizer: any;
  private effectRows: Phaser.GameObjects.Text[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
    this.sizer = (scene as any).rexUI.add
      .sizer({
        orientation: 'y',
        space: { item: 2 },
      })
      .setName('active-effects-hud-sizer');
  }

  /**
   * Returns the RexUI sizer to be added to a parent sizer.
   */
  public getSizer(): any {
    return this.sizer;
  }

  /**
   * Update the displayed effects, rebuilding all rows.
   * Call this whenever activeEffects changes in the store.
   */
  public updateEffects(effects: ActiveEffectSummary[], currentTurnNumber?: number): void {
    // Destroy existing rows
    this.effectRows.forEach((row) => row.destroy());
    this.effectRows = [];

    // Clear sizer children
    this.sizer.clear(true);

    if (effects.length === 0) {
      // Hide entirely when no active effects
      this.sizer.setVisible(false);
      return;
    }

    this.sizer.setVisible(true);

    for (const effect of effects) {
      const row = this.createEffectRow(effect, currentTurnNumber);
      this.sizer.add(row, {
        proportion: 0,
        align: 'left',
        expand: false,
      });
      this.effectRows.push(row);
    }
  }

  /**
   * Build a text object for a single active effect row.
   * Format: "[icon] [label] - [duration]"
   */
  private createEffectRow(effect: ActiveEffectSummary, currentTurnNumber?: number): Phaser.GameObjects.Text {
    const icon = EVENT_TYPE_ICONS[effect.cardType] ?? '📋';
    const label = EVENT_TYPE_LABELS[effect.cardType] ?? effect.cardType;
    const durationText = this.formatDuration(effect, currentTurnNumber);

    const rowText = this.scene.add.text(0, 0, `${icon} ${label} - ${durationText}`, {
      color: EFFECT_TEXT_COLOR,
      fontSize: EFFECT_FONT_SIZE,
      fontFamily: UI_FONT_FAMILY,
      fontStyle: 'bold',
    });
    rowText.setName(`active-effect-row-${effect.cardId}`);
    return rowText;
  }

  /**
   * Format the duration label for an effect.
   * Uses expiresAfterTurnNumber when available.
   */
  private formatDuration(effect: ActiveEffectSummary, currentTurnNumber?: number): string {
    if (currentTurnNumber !== undefined && currentTurnNumber !== null) {
      const turnsLeft = effect.expiresAfterTurnNumber - currentTurnNumber;
      if (turnsLeft <= 0) {
        return 'expiring';
      }
      return turnsLeft === 1 ? '1 turn' : `${turnsLeft} turns`;
    }
    // Fallback: just show "active" when we don't have a current turn number
    return 'active';
  }

  /**
   * Destroy this HUD and all its children.
   */
  public destroy(): void {
    this.effectRows.forEach((row) => row.destroy());
    this.effectRows = [];
    try {
      this.sizer.clear(true);
      this.sizer.destroy();
    } catch {
      // Non-critical
    }
  }
}
