/**
 * AI Bot feature flag configuration.
 * Controls whether AI bot functionality is available across the application.
 */

/**
 * Returns whether AI bots are enabled.
 * Reads from ENABLE_AI_BOTS environment variable.
 * Accepts 'true' or '1' as truthy values; defaults to false.
 */
export function isAIBotsEnabled(): boolean {
  const value = process.env.ENABLE_AI_BOTS;
  if (value === undefined || value === '') return false;
  return value.toLowerCase() === 'true' || value === '1';
}
