/**
 * Shared color display utilities for the lobby.
 * Used by both JoinGameModal and BotConfigPopover.
 */

/** Canonical 6-color palette used by the lobby (lowercase hex). */
export const PLAYER_COLOR_PALETTE = [
  '#ff0000',
  '#0000ff',
  '#008000',
  '#ffd700',
  '#000000',
  '#8b4513',
] as const;

/** Map a hex color value to its English display name. */
export const getColorName = (colorValue: string): string => {
  const colorMap: Record<string, string> = {
    '#ff0000': 'Red',
    '#0000ff': 'Blue',
    '#008000': 'Green',
    '#ffd700': 'Yellow',
    '#000000': 'Black',
    '#8b4513': 'Brown',
  };
  return colorMap[colorValue] || 'Unknown';
};
