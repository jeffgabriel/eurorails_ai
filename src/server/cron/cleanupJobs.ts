import cron from 'node-cron';
import { VerificationService } from '../services/verificationService';
import { rateLimitService } from '../services/rateLimitService';

/**
 * Initialize and schedule cleanup jobs
 */
export function initializeCleanupJobs(): void {
  console.log('[Cron] Initializing cleanup jobs...');

  // Run every hour: Clean up expired verification tokens
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('[Cron] Running expired token cleanup...');
      const deletedCount = await VerificationService.cleanupExpiredTokens();
      console.log(`[Cron] Expired token cleanup complete (${deletedCount} tokens removed)`);
    } catch (error) {
      console.error('[Cron] Error in expired token cleanup:', error);
    }
  });

  // Run every 6 hours: Clean up old rate limit data
  cron.schedule('0 */6 * * *', async () => {
    try {
      console.log('[Cron] Running rate limit data cleanup...');
      const deletedCount = await rateLimitService.cleanupOldData();
      console.log(`[Cron] Rate limit cleanup complete (${deletedCount} records removed)`);
    } catch (error) {
      console.error('[Cron] Error in rate limit cleanup:', error);
    }
  });

  console.log('[Cron] Cleanup jobs scheduled:');
  console.log('  - Expired tokens: Every hour (0 * * * *)');
  console.log('  - Rate limit data: Every 6 hours (0 */6 * * *)');
}

/**
 * Stop all cron jobs (for graceful shutdown)
 */
export function stopCleanupJobs(): void {
  cron.getTasks().forEach((task) => task.stop());
  console.log('[Cron] All cleanup jobs stopped');
}
