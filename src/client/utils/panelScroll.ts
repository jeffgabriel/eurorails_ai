/**
 * Horizontal scroll math for the player hand panel on narrow screens.
 *
 * "Left" is the x of the panel content's left edge in screen coordinates:
 * 0 shows the start of the content; negative values scroll it left.
 */

/** Pixels a touch must travel before it counts as a swipe rather than a tap. */
export const PANEL_SWIPE_THRESHOLD_PX = 8;

/** Clamp the content's left edge so neither end scrolls past the visible area. */
export function clampPanelScrollLeft(left: number, contentWidth: number, visibleWidth: number): number {
  const minLeft = Math.min(0, visibleWidth - contentWidth);
  return Math.max(minLeft, Math.min(0, left));
}

/** True when the panel's natural width does not fit on screen. */
export function isPanelWiderThanScreen(panelWidth: number, screenWidth: number): boolean {
  // 1px tolerance for fractional layout widths
  return panelWidth > screenWidth + 1;
}
