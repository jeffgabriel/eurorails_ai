/**
 * run-bot-harness.ts — Bot-vs-bot game harness (JIRA-262 / harness proposal).
 *
 * Runs N all-bot games end-to-end against the existing services. For each
 * game: createGame → addBot×4 → startGame → manually drive the bot-turn
 * cascade by polling current_player_index + calling onTurnChange per turn.
 * Captures per-game outcome to logs/harness-runs/<runId>/summary.json and
 * relies on the existing GameLogger/EventLogger to write the per-turn
 * NDJSON game-<id>.ndjson + events-<id>.ndjson under logs/.
 *
 * Usage:
 *   npx ts-node scripts/ai/run-bot-harness.ts [--games N] [--bots K]
 *                                             [--max-turns T]
 *
 * Defaults: 1 game (smoke test mode), 4 bots, 250-turn cap.
 *
 * Why manually drive onTurnChange (not the socket cascade): socketService
 * gates `triggerBotTurn` behind a non-null `io`. In a no-server harness,
 * `io` is never initialized — emitTurnChange early-returns and the
 * cascade dies after the first turn. The manual loop reads
 * current_player_index from the DB after each turn and re-fires
 * onTurnChange directly, which is also more deterministic to debug.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv();

import { db } from '../../src/server/db/index';
import { LobbyService } from '../../src/server/services/lobbyService';
import { onTurnChange, advanceTurnAfterBot } from '../../src/server/services/ai/BotTurnTrigger';
import { BotSkillLevel } from '../../src/shared/types/GameTypes';

// Stable harness-runner user id so repeated runs are idempotent
const HARNESS_USER_ID = '00000000-0000-0000-0000-000000000001';
const HARNESS_USER_EMAIL = 'harness@local.test';
const HARNESS_USER_NAME = 'harness-runner';

interface GameResult {
  gameId: string;
  status: 'completed' | 'abandoned' | 'stalled' | 'error';
  winnerId: string | null;
  winnerName: string | null;
  turns: number;
  durationMs: number;
  error?: string;
  perBotEndState?: Array<{
    playerId: string;
    name: string;
    cash: number;
    connectedMajorCityCount: number;
  }>;
}

interface HarnessArgs {
  games: number;
  bots: number;
  maxTurns: number;
}

function parseArgs(argv: string[]): HarnessArgs {
  // Default: 3 bots — matches the user's normal "play vs 3 Medium bots with
  // autorun" environment, where games complete with one bot winning. A 4-bot
  // all-bot game produces much higher contention for supply cities and
  // medium/small-city entry caps; bots get stuck in expensive detour-builds
  // and never accumulate cash. The harness retains the creator user as a
  // passive 4th player slot and skips their turn each round (mimicking
  // autorun's "advance only" behavior).
  //
  // maxTurns counts TOTAL iterations (bot turns + human skips), NOT per-bot
  // turns. With 3 bots + 1 skipped human, each round = 4 iterations. Real
  // games in this configuration take ~330 iterations to reach victory
  // (game 8350cffa: 247 logged bot turns / 3 bots ≈ 82 per bot, plus ~82
  // human skips ≈ 329 total rotations). Default 400 gives a margin.
  const args: HarnessArgs = { games: 1, bots: 3, maxTurns: 400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games' && argv[i + 1]) { args.games = parseInt(argv[++i], 10); }
    else if (a === '--bots' && argv[i + 1]) { args.bots = parseInt(argv[++i], 10); }
    else if (a === '--max-turns' && argv[i + 1]) { args.maxTurns = parseInt(argv[++i], 10); }
  }
  if (args.bots < 1 || args.bots > 5) throw new Error(`bots must be 1..5 (got ${args.bots})`);
  if (args.maxTurns < 1) throw new Error(`max-turns must be >= 1 (got ${args.maxTurns})`);
  if (args.games < 1) throw new Error(`games must be >= 1 (got ${args.games})`);
  return args;
}

/** Insert the synthetic harness-runner user if it doesn't already exist. */
async function ensureHarnessUser(): Promise<void> {
  await db.query(
    `INSERT INTO users (id, username, email, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [HARNESS_USER_ID, HARNESS_USER_NAME, HARNESS_USER_EMAIL, 'harness-no-login'],
  );
}

/**
 * Drive a single bot-vs-bot game from creation to completion. Manually
 * pumps onTurnChange after each turn since the harness doesn't initialize
 * socket.io. Returns a GameResult capturing outcome + per-bot end state.
 */
async function runOneGame(bots: number, maxTurns: number): Promise<GameResult> {
  const startTime = Date.now();

  // ── Create game + add bots + start ────────────────────────────────────
  // The creator (harness-runner user) is auto-added by LobbyService.createGame
  // as player #0. We KEEP that row to mirror the user's normal play
  // environment (4 players total: 3 bots + 1 autorun human). The main loop
  // below skips the creator's turns via advanceTurnAfterBot, matching what
  // autorun does to a real human player (no actions taken, turn just
  // advances).
  const game = await LobbyService.createGame({
    createdByUserId: HARNESS_USER_ID,
    isPublic: false,
    maxPlayers: bots + 1, // bots + creator slot
  });
  for (let i = 0; i < bots; i++) {
    await LobbyService.addBot(game.id, HARNESS_USER_ID, {
      skillLevel: BotSkillLevel.Medium,
      name: `bot${i}`,
    });
  }
  await LobbyService.startGame(game.id, HARNESS_USER_ID);

  // ── Drive the cascade ─────────────────────────────────────────────────
  let turnCount = 0;
  let stalled = false;
  while (turnCount < maxTurns) {
    const gameRow = await db.query(
      'SELECT status, current_player_index FROM games WHERE id = $1',
      [game.id],
    );
    if (gameRow.rows.length === 0) {
      throw new Error(`Game ${game.id} disappeared mid-run`);
    }
    const status = gameRow.rows[0].status as string;
    if (status === 'completed' || status === 'abandoned') break;
    const currentIdx = gameRow.rows[0].current_player_index as number;

    const playerRow = await db.query(
      'SELECT id, is_bot FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2',
      [game.id, currentIdx],
    );
    if (playerRow.rows.length === 0) {
      throw new Error(`No player at index ${currentIdx} in game ${game.id} (turn ${turnCount + 1})`);
    }
    const currentPlayerId = playerRow.rows[0].id as string;
    const isBot = playerRow.rows[0].is_bot as boolean;

    if (isBot) {
      await onTurnChange(game.id, currentIdx, currentPlayerId);
    } else {
      // Harness-runner human player on simulated autorun: skip the turn
      // without running any pipeline, mirroring socketService.ts:770-794.
      await advanceTurnAfterBot(game.id);
    }
    turnCount++;
  }
  if (turnCount >= maxTurns) stalled = true;

  // ── Capture outcome + per-bot end state ───────────────────────────────
  const finalGame = await db.query(
    'SELECT status, winner_id FROM games WHERE id = $1',
    [game.id],
  );
  const finalStatus = finalGame.rows[0].status as string;
  const winnerId = (finalGame.rows[0].winner_id as string) ?? null;

  const players = await db.query(
    `SELECT p.id, p.name, p.money, pt.segments
     FROM players p
     LEFT JOIN player_tracks pt ON pt.game_id = p.game_id AND pt.player_id = p.id
     WHERE p.game_id = $1
     ORDER BY p.created_at ASC`,
    [game.id],
  );
  const winnerName = winnerId
    ? (players.rows.find((r: any) => r.id === winnerId)?.name as string | undefined) ?? null
    : null;

  // For perBotEndState we lazy-count connected majors from the segments JSON;
  // this avoids importing the network code into a one-off harness script.
  // It's only an approximation — a value of `-1` indicates the segment
  // payload was null/empty.
  const perBotEndState = players.rows.map((r: any) => {
    let segCount = -1;
    try {
      const segs = typeof r.segments === 'string' ? JSON.parse(r.segments) : r.segments;
      segCount = Array.isArray(segs) ? segs.length : -1;
    } catch (_) { /* leave segCount as -1 */ }
    return {
      playerId: r.id as string,
      name: r.name as string,
      cash: r.money as number,
      connectedMajorCityCount: segCount, // approximation; refine later via getConnectedMajorCities if needed
    };
  });

  return {
    gameId: game.id,
    status: stalled ? 'stalled' : (finalStatus as 'completed' | 'abandoned'),
    winnerId,
    winnerName,
    turns: turnCount,
    durationMs: Date.now() - startTime,
    perBotEndState,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[harness] games=${args.games} bots=${args.bots} maxTurns=${args.maxTurns}`);

  await ensureHarnessUser();

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join('logs', 'harness-runs', runId);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`[harness] runId=${runId} outDir=${outDir}`);

  const results: GameResult[] = [];
  for (let i = 0; i < args.games; i++) {
    console.log(`\n[harness] === game ${i + 1}/${args.games} ===`);
    try {
      const r = await runOneGame(args.bots, args.maxTurns);
      console.log(
        `[harness] gameId=${r.gameId} status=${r.status} ` +
        `winner=${r.winnerName ?? '<none>'} turns=${r.turns} ` +
        `duration=${(r.durationMs / 1000).toFixed(1)}s`,
      );
      results.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[harness] game ${i + 1} errored: ${msg}`);
      results.push({
        gameId: 'unknown',
        status: 'error',
        winnerId: null,
        winnerName: null,
        turns: 0,
        durationMs: 0,
        error: msg,
      });
    }
  }

  await fs.writeFile(
    join(outDir, 'summary.json'),
    JSON.stringify({ args, runId, results }, null, 2),
  );
  console.log(`\n[harness] wrote ${join(outDir, 'summary.json')}`);
  console.log(`[harness] completed=${results.filter(r => r.status === 'completed').length} ` +
              `stalled=${results.filter(r => r.status === 'stalled').length} ` +
              `errored=${results.filter(r => r.status === 'error').length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[harness] fatal:', err);
    process.exit(1);
  });
