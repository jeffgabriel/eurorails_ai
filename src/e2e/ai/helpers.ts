/**
 * Shared helpers for AI E2E tests.
 * Provides utilities for game setup, bot configuration, and assertions.
 *
 * Note: These helpers will be expanded when the AI pipeline is implemented.
 */

import type { Page } from '@playwright/test';

/** Bot configuration for E2E test setup */
export interface TestBotConfig {
  name: string;
  skillLevel: 'easy' | 'medium' | 'hard';
  archetype:
    | 'backbone_builder'
    | 'freight_optimizer'
    | 'trunk_sprinter'
    | 'continental_connector'
    | 'opportunist';
}

/** Default bot configurations for tests */
export const DEFAULT_BOTS: TestBotConfig[] = [
  { name: 'Bot-Easy', skillLevel: 'easy', archetype: 'backbone_builder' },
  { name: 'Bot-Medium', skillLevel: 'medium', archetype: 'freight_optimizer' },
  { name: 'Bot-Hard', skillLevel: 'hard', archetype: 'trunk_sprinter' },
];

/** All 5 archetypes for archetype validation tests */
export const ALL_ARCHETYPE_BOTS: TestBotConfig[] = [
  { name: 'Backbone', skillLevel: 'hard', archetype: 'backbone_builder' },
  { name: 'Freight', skillLevel: 'hard', archetype: 'freight_optimizer' },
  { name: 'Sprinter', skillLevel: 'hard', archetype: 'trunk_sprinter' },
  { name: 'Connector', skillLevel: 'hard', archetype: 'continental_connector' },
  { name: 'Opportunist', skillLevel: 'hard', archetype: 'opportunist' },
];

/**
 * Wait for a bot turn to complete by watching for turn indicator changes.
 * Placeholder — will be implemented when bot turn UI is connected.
 */
export async function waitForBotTurnComplete(page: Page, botName: string, timeoutMs = 10_000): Promise<void> {
  // TODO: Implement when bot turn animations and turn advancement are connected
  await page.waitForTimeout(Math.min(timeoutMs, 1000));
}

/**
 * Open the Strategy Inspector modal for a specific bot.
 * Placeholder — will be implemented when Strategy Inspector UI is connected to live data.
 */
export async function openStrategyInspector(page: Page, botName: string): Promise<void> {
  // TODO: Click the brain icon next to the bot's name in the leaderboard
  // await page.click(`[data-testid="bot-inspector-${botName}"]`);
}

/**
 * Get the current turn number from the game UI.
 * Placeholder — will be implemented when game UI exposes turn number.
 */
export async function getCurrentTurnNumber(page: Page): Promise<number> {
  // TODO: Read from game UI element
  return 0;
}
