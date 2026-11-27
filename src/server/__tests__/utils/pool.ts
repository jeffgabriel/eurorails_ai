import type { PoolClient } from 'pg';
import { db } from '../../db';

/**
 * Runs `action` while every pooled connection but one is held. A transaction
 * that reads through the pool as well as its own connection would wait on
 * the pool forever here, so the action is given a deadline.
 */
export async function withOneFreeConnection<T>(action: () => PromiseLike<T>): Promise<T> {
  const poolSize = parseInt(process.env.DB_MAX_CONNECTIONS || '10');
  const held: PoolClient[] = [];
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<T> | undefined;
  try {
    for (let i = 0; i < poolSize - 1; i++) {
      held.push(await db.connect());
    }
    pending = Promise.resolve(action());
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Request needed more than one pooled connection')), 3000);
    });
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
    held.forEach(client => client.release());
    // Let a stalled request finish now that connections are free.
    await pending?.then(() => undefined, () => undefined);
  }
}
