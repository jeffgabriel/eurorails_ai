/**
 * captureContextFixtures.ts — One-off script to capture (WorldSnapshot, BotMemoryState) triples
 * for use in ContextEquivalence.test.ts.
 *
 * This script connects to the game DB, queries for representative game states,
 * and serializes them as JSON fixture files under:
 *   src/server/__tests__/ai/fixtures/contextEquivalence/
 *
 * Fixture scenarios targeted:
 *   F1 — Initial build (turn 1-2, memory.deliveryCount=0, no activeRoute)
 *   F2 — Mid-game with active route (memory.deliveryCount > 0, activeRoute populated, lastReasoning populated)
 *   F3 — Post-auto-delivery (memory reflects a just-completed delivery, no activeRoute)
 *
 * Lifecycle: one-off. Run once to populate fixtures, then keep under scripts/ for future
 * fixture-rebuild needs.
 *
 * Usage:
 *   npx ts-node scripts/captureContextFixtures.ts
 *
 * Environment variables required:
 *   DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD — same as the server.
 *
 * JIRA-195: Slice 1 — ContextBuilder stage-ordering fix.
 */

import fs from 'fs';
import path from 'path';
import { WorldSnapshot, BotMemoryState } from '../src/shared/types/GameTypes';

// ── Output directory ────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(
  __dirname,
  '../src/server/__tests__/ai/fixtures/contextEquivalence',
);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

// ── Fixture shape ───────────────────────────────────────────────────────────

interface ContextFixture {
  _comment: string;
  snapshot: WorldSnapshot;
  memory: BotMemoryState;
}

// ── DB query helpers ────────────────────────────────────────────────────────

/**
 * Query the DB for bot player records and their memory state.
 * Returns raw rows; WorldSnapshotService must be used to reconstruct the full snapshot.
 *
 * NOTE: This script uses dynamic require so that ts-node can resolve the DB
 * module at runtime without needing the full build chain.
 */
async function captureFromDB(): Promise<void> {
  // Dynamic import to avoid build-time dependency on the server DB module
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { db } = require('../src/server/db/index');

  console.log('Querying DB for representative bot game states...');

  // F1: Find a game in initialBuild status with a bot that has no memory
  const f1Result = await db.query(`
    SELECT
      g.id AS game_id,
      p.id AS player_id,
      p.bot_memory
    FROM games g
    JOIN players p ON p.game_id = g.id AND p.is_bot = true
    WHERE g.status = 'initialBuild'
      AND (p.bot_memory IS NULL OR (p.bot_memory->>'deliveryCount')::int = 0)
    ORDER BY g.created_at DESC
    LIMIT 1
  `);

  if (f1Result.rows.length === 0) {
    console.warn('F1: No initialBuild game with zero-delivery bot found. Using synthetic fixture.');
    return;
  }

  // F2: Find a playing game with active route and deliveryCount > 0
  const f2Result = await db.query(`
    SELECT
      g.id AS game_id,
      p.id AS player_id,
      p.bot_memory
    FROM games g
    JOIN players p ON p.game_id = g.id AND p.is_bot = true
    WHERE g.status = 'playing'
      AND p.bot_memory IS NOT NULL
      AND (p.bot_memory->>'deliveryCount')::int > 0
      AND p.bot_memory->'activeRoute' IS NOT NULL
      AND p.bot_memory->'activeRoute' != 'null'::jsonb
    ORDER BY g.created_at DESC
    LIMIT 1
  `);

  // F3: Find a playing game where last action was DeliverLoad
  const f3Result = await db.query(`
    SELECT
      g.id AS game_id,
      p.id AS player_id,
      p.bot_memory
    FROM games g
    JOIN players p ON p.game_id = g.id AND p.is_bot = true
    WHERE g.status = 'playing'
      AND p.bot_memory IS NOT NULL
      AND (p.bot_memory->>'deliveryCount')::int >= 4
      AND p.bot_memory->>'lastAction' = 'DeliverLoad'
    ORDER BY g.created_at DESC
    LIMIT 1
  `);

  console.log(`F1 candidates: ${f1Result.rows.length}`);
  console.log(`F2 candidates: ${f2Result.rows.length}`);
  console.log(`F3 candidates: ${f3Result.rows.length}`);

  // For each candidate, use WorldSnapshotService to reconstruct the full snapshot
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WorldSnapshotService } = require('../src/server/services/ai/WorldSnapshotService');

  const service = new WorldSnapshotService(db);
  const scenarios = [
    { label: 'F1', row: f1Result.rows[0], comment: 'F1 — Initial build. Turn 1-2, memory empty, deliveryCount=0, no activeRoute.' },
    { label: 'F2', row: f2Result.rows[0], comment: 'F2 — Mid-game with active route. deliveryCount > 0, activeRoute populated, lastReasoning populated.' },
    { label: 'F3', row: f3Result.rows[0], comment: 'F3 — Post-auto-delivery. deliveryCount >= 4, lastAction=DeliverLoad, no activeRoute.' },
  ];

  for (const { label, row, comment } of scenarios) {
    if (!row) {
      console.warn(`${label}: No DB candidate found — skipping. Existing synthetic fixture preserved.`);
      continue;
    }

    try {
      const snapshot: WorldSnapshot = await service.capture(row.game_id, row.player_id);
      const memory: BotMemoryState = row.bot_memory ?? {
        currentBuildTarget: null,
        turnsOnTarget: 0,
        lastAction: null,
        consecutiveDiscards: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        turnNumber: 0,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        lastReasoning: null,
        lastPlanHorizon: null,
        previousRouteStops: null,
        consecutiveLlmFailures: 0,
      };

      const fixture: ContextFixture = { _comment: comment, snapshot, memory };
      const outPath = path.join(OUTPUT_DIR, `${label}.json`);
      fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
      console.log(`${label}: Written to ${outPath}`);
    } catch (err) {
      console.error(`${label}: Failed to capture snapshot —`, err);
    }
  }

  await db.end();
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDir(OUTPUT_DIR);

  try {
    await captureFromDB();
    console.log('Done. Review fixtures under:', OUTPUT_DIR);
  } catch (err) {
    console.error('captureContextFixtures failed:', err);
    process.exit(1);
  }
}

main();
