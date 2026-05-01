/**
 * UpgradeGatingConstants — Single source of truth for upgrade-eligibility thresholds.
 *
 * All upgrade-gating consumers (BuildContext.checkCanUpgrade, ContextSerializer,
 * AIStrategyEngine) import from this module instead of inlining literals.
 * Change a value here and all three consumers update without further edits.
 *
 * JIRA-207A: Consolidates three previously fragmented gating sites.
 */

/**
 * Minimum number of completed deliveries before the bot is allowed to consider
 * upgrading its train. Tunable.
 *
 * Set to 2 so the bot must prove it can execute at least two full delivery cycles
 * before committing 20M to an upgrade. This prevents early-game cash-burn on upgrades
 * before the delivery pipeline is established.
 */
export const UPGRADE_DELIVERY_THRESHOLD = 2;

/**
 * Minimum cash the bot must retain *after* paying the upgrade cost.
 * Tunable. ECU millions.
 *
 * Example: at UPGRADE_OPERATING_BUFFER=30M and Freight upgrade cost=20M,
 * the bot needs money >= 50M for the upgrade gate to pass
 * (20M for upgrade + 30M operating reserve).
 *
 * This prevents the bot from upgrading into a cash-poor state where it cannot
 * afford track-use fees or JIT build opportunities.
 */
export const UPGRADE_OPERATING_BUFFER = 30;  // ECU millions
