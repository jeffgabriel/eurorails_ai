import 'phaser';
import { EventCardType } from '../../shared/types/EventCard';
import {
  HORIZONTAL_SPACING,
  VERTICAL_SPACING,
  GRID_MARGIN,
} from '../config/mapConfig';

/** Radius of each hex highlight circle in pixels */
const HEX_RADIUS = 22;

/** Fade-in/out duration in milliseconds */
const FADE_DURATION_MS = 350;

/** Alpha value for active highlights (semi-transparent fill) */
const HIGHLIGHT_ALPHA = 0.3;

/**
 * ARGB color for each event card type.
 * Stored as 24-bit RGB hex — alpha is applied separately via Graphics.fillStyle.
 */
const EVENT_TYPE_COLORS: Record<EventCardType, number> = {
  [EventCardType.Derailment]: 0xff0000, // red
  [EventCardType.Flood]: 0x0000ff,      // blue
  [EventCardType.Snow]: 0xffffff,        // white
  [EventCardType.Strike]: 0xffd700,     // yellow/gold
  [EventCardType.ExcessProfitTax]: 0xff8c00, // orange (no map zone effect, but handled gracefully)
};

/**
 * Parse a zone key ("row,col") into numeric row and column.
 * Returns null if the key is malformed.
 */
function parseZoneKey(key: string): { row: number; col: number } | null {
  const parts = key.split(',');
  if (parts.length !== 2) return null;
  const row = parseInt(parts[0], 10);
  const col = parseInt(parts[1], 10);
  if (isNaN(row) || isNaN(col)) return null;
  return { row, col };
}

/**
 * Convert grid (row, col) to world pixel coordinates within the map container.
 * Mirrors the logic in mapConfig.ts / calculateWorldCoordinates.
 */
function gridToPixel(row: number, col: number): { x: number; y: number } {
  const isOffsetRow = row % 2 === 1;
  const x =
    col * HORIZONTAL_SPACING +
    GRID_MARGIN +
    (isOffsetRow ? HORIZONTAL_SPACING / 2 : 0);
  const y = row * VERTICAL_SPACING + GRID_MARGIN;
  return { x, y };
}

/**
 * Represents a single active highlight layer (one Graphics object per card).
 */
interface HighlightEntry {
  cardId: number;
  graphics: Phaser.GameObjects.Graphics;
  tween: Phaser.Tweens.Tween | null;
}

/**
 * MapHighlighter manages semi-transparent color-coded overlays on the hex map.
 *
 * Responsibilities:
 * - Activate highlight polygons for a zone + event type, keyed by cardId
 * - Deactivate highlights by cardId with fade-out
 * - Z-ordered above tracks but below trains/UI (managed by the caller via container depth)
 *
 * This component uses one Graphics object per active card, avoiding full map re-renders.
 */
export class MapHighlighter {
  private readonly scene: Phaser.Scene;
  private readonly mapContainer: Phaser.GameObjects.Container;
  /** Active highlight entries keyed by cardId */
  private readonly highlights: Map<number, HighlightEntry> = new Map();

  constructor(scene: Phaser.Scene, mapContainer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.mapContainer = mapContainer;
  }

  /**
   * Draw semi-transparent, color-coded hex circles for all mileposts in `zone`.
   * If a highlight for `cardId` already exists, it is replaced.
   *
   * @param zone     Array of milepost keys ("row,col")
   * @param eventType Determines overlay color
   * @param cardId   Unique identifier used to deactivate this overlay later
   */
  public activate(zone: string[], eventType: EventCardType, cardId: number): void {
    // Replace any existing highlight for this card
    if (this.highlights.has(cardId)) {
      this.removeEntry(cardId, /* skipFade */ true);
    }

    const color = EVENT_TYPE_COLORS[eventType] ?? 0xffffff;
    const graphics = this.scene.add.graphics();

    this.drawZone(graphics, zone, color);

    // Add to the map container above background/tracks (z-order managed externally)
    this.mapContainer.add(graphics);

    // Fade in from transparent
    graphics.setAlpha(0);
    const tween = this.scene.tweens.add({
      targets: graphics,
      alpha: HIGHLIGHT_ALPHA,
      duration: FADE_DURATION_MS,
      ease: 'Linear',
    });

    this.highlights.set(cardId, { cardId, graphics, tween });
  }

  /**
   * Fade out and remove the highlight overlay for the given `cardId`.
   * Does nothing if no highlight exists for that card.
   */
  public deactivate(cardId: number): void {
    const entry = this.highlights.get(cardId);
    if (!entry) return;

    // Stop any in-progress fade-in tween
    entry.tween?.stop();
    entry.tween = null;

    const { graphics } = entry;

    // Fade out, then destroy
    this.scene.tweens.add({
      targets: graphics,
      alpha: 0,
      duration: FADE_DURATION_MS,
      ease: 'Linear',
      onComplete: () => {
        graphics.destroy();
      },
    });

    this.highlights.delete(cardId);
  }

  /**
   * Remove all active highlights immediately (no fade).
   * Useful for scene teardown.
   */
  public clear(): void {
    for (const cardId of Array.from(this.highlights.keys())) {
      this.removeEntry(cardId, /* skipFade */ true);
    }
  }

  /** Returns true if there is an active highlight for the given cardId. */
  public hasHighlight(cardId: number): boolean {
    return this.highlights.has(cardId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private drawZone(
    graphics: Phaser.GameObjects.Graphics,
    zone: string[],
    color: number
  ): void {
    graphics.fillStyle(color, HIGHLIGHT_ALPHA);

    for (const key of zone) {
      const coords = parseZoneKey(key);
      if (!coords) continue;

      const { x, y } = gridToPixel(coords.row, coords.col);
      // Draw a circle approximating the hex milepost footprint
      graphics.fillCircle(x, y, HEX_RADIUS);
    }
  }

  /** Immediately remove an entry (with optional tween stop). */
  private removeEntry(cardId: number, skipFade: boolean): void {
    const entry = this.highlights.get(cardId);
    if (!entry) return;

    entry.tween?.stop();

    if (skipFade) {
      entry.graphics.destroy();
    }

    this.highlights.delete(cardId);
  }
}
