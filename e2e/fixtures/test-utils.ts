import { test as base, expect, Page } from '@playwright/test';

/**
 * Test utilities and fixtures for EuroRails AI E2E tests.
 */

export interface TestUser {
  username: string;
  email: string;
  password: string;
}

/**
 * Generate a unique test user with timestamp-based credentials.
 */
export function generateTestUser(prefix: string = 'testuser'): TestUser {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return {
    username: `${prefix}_${timestamp}_${random}`,
    email: `${prefix}_${timestamp}_${random}@test.example.com`,
    password: 'TestPassword123!',
  };
}

/**
 * Login helper that navigates to login page and authenticates.
 */
export async function loginUser(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 10000 });

  // Fill email/username and password
  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

  await emailInput.fill(user.email);
  await passwordInput.fill(user.password);

  // Submit the form
  await page.locator('button[type="submit"]').click();

  // Wait for navigation to lobby
  await page.waitForURL(/\/lobby/, { timeout: 15000 });
}

/**
 * Register a new user.
 */
export async function registerUser(page: Page, user: TestUser): Promise<void> {
  await page.goto('/register');
  await page.waitForSelector('input[name="username"], input[name="email"]', { timeout: 10000 });

  // Fill registration form
  const usernameInput = page.locator('input[name="username"]').first();
  const emailInput = page.locator('input[name="email"]').first();
  const passwordInput = page.locator('input[name="password"]').first();

  if (await usernameInput.isVisible()) {
    await usernameInput.fill(user.username);
  }
  await emailInput.fill(user.email);
  await passwordInput.fill(user.password);

  // Confirm password if field exists
  const confirmPasswordInput = page.locator('input[name="confirmPassword"]');
  if (await confirmPasswordInput.isVisible()) {
    await confirmPasswordInput.fill(user.password);
  }

  // Submit
  await page.locator('button[type="submit"]').click();

  // Wait for redirect to lobby
  await page.waitForURL(/\/lobby/, { timeout: 15000 });
}

/**
 * Create a new game and return the join code.
 */
export async function createGame(page: Page, maxPlayers: number = 6): Promise<string> {
  // Click Create button
  await page.locator('button:has-text("Create")').click();

  // Wait for modal to appear
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // Set max players if field is visible
  const maxPlayersInput = page.locator('input[name="maxPlayers"]');
  if (await maxPlayersInput.isVisible()) {
    await maxPlayersInput.fill(String(maxPlayers));
  }

  // Submit the form
  await page.locator('[role="dialog"] button:has-text("Create")').click();

  // Wait for game lobby to load
  await page.waitForSelector('text="Game Lobby"', { timeout: 10000 });

  // Extract join code
  const joinCodeElement = page.locator('.font-mono.font-bold').first();
  const joinCode = await joinCodeElement.textContent();

  if (!joinCode) {
    throw new Error('Failed to get join code');
  }

  return joinCode.trim();
}

/**
 * Add an AI player to the current game.
 */
export async function addAIPlayer(
  page: Page,
  difficulty: 'easy' | 'medium' | 'hard',
  personality: 'optimizer' | 'network_builder' | 'opportunist' | 'blocker' | 'steady_hand' | 'chaos_agent'
): Promise<void> {
  // Click "Add AI Player" button
  await page.locator('button:has-text("Add AI Player")').click();

  // Wait for modal
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForSelector('text="Add AI Player"', { timeout: 5000 });

  // Select difficulty
  const difficultyLabel = page.locator(`label:has-text("${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}")`);
  await difficultyLabel.click();

  // Select personality - need to click on the label that contains the personality name
  const personalityLabels: Record<string, string> = {
    optimizer: 'Optimizer',
    network_builder: 'Network Builder',
    opportunist: 'Opportunist',
    blocker: 'Blocker',
    steady_hand: 'Steady Hand',
    chaos_agent: 'Chaos Agent',
  };

  const personalityLabel = page.locator(`label:has-text("${personalityLabels[personality]}")`);
  await personalityLabel.click();

  // Click Add Player button
  await page.locator('[role="dialog"] button:has-text("Add Player")').click();

  // Wait for modal to close
  await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 10000 });
}

/**
 * Wait for AI player to appear in the player list.
 */
export async function waitForAIPlayer(page: Page, timeout: number = 10000): Promise<void> {
  // Look for AI player indicators (bot icon or AI badge)
  await page.waitForSelector('[class*="Bot"], [data-testid="ai-player"]', { timeout });
}

/**
 * Start the game (as game creator).
 */
export async function startGame(page: Page): Promise<void> {
  // Click Start Game button
  await page.locator('button:has-text("Start Game")').click();

  // Wait for navigation to game page
  await page.waitForURL(/\/game\//, { timeout: 15000 });
}

/**
 * Wait for a specific player's turn.
 */
export async function waitForTurn(page: Page, isAITurn: boolean, timeout: number = 30000): Promise<void> {
  if (isAITurn) {
    // Wait for AI thinking indicator or AI turn complete
    await page.waitForSelector(
      'text="AI is thinking", [data-testid="ai-thinking"], [class*="thinking"]',
      { timeout }
    ).catch(() => {
      // AI might have already completed their turn
    });
  }
}

/**
 * Check if the Bot Strategy Panel is visible and contains expected content.
 */
export async function verifyBotStrategyPanel(page: Page): Promise<boolean> {
  const panel = page.locator('[aria-label*="Strategy panel"], [class*="BotStrategyPanel"]');
  if (await panel.isVisible()) {
    // Verify it has expected sections
    const hasTurnSummary = await panel.locator('text="Turn Summary"').isVisible();
    const hasStrategy = await panel.locator('text="Current Strategy"').isVisible();
    return hasTurnSummary || hasStrategy;
  }
  return false;
}

/**
 * Custom test fixture with authentication.
 */
export const test = base.extend<{
  authenticatedPage: Page;
  testUser: TestUser;
}>({
  testUser: async ({}, use) => {
    const user = generateTestUser();
    await use(user);
  },
  authenticatedPage: async ({ page, testUser }, use) => {
    // Register and login the test user
    await registerUser(page, testUser);
    await use(page);
  },
});

export { expect };
