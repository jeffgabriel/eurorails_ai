# Bot-vs-bot harness — proposal

**Status:** proposal (not yet implemented)
**Author:** drafted 2026-05-23, harness needed for data collection / bug-finding on the advanced bot player
**Owner:** Matt (decision); harness implementation TBD

## Goal

Run 100s of all-bot games on the existing full server stack to collect data about bot behavior — finding bugs (especially the kind we've been hitting recently: JIRA-258 log fidelity, JIRA-260 effect-lifecycle, JIRA-261 victory-route override) and surfacing optimization opportunities for the deterministic / Medium-skill planner.

Constraint: **all Medium skill, no LLM interaction** — Medium routes through `DeterministicTripPlanner` and pure deterministic helpers, so no LLM cost per turn. ~40-60s per game wall-clock on a typical machine.

## Architecture choice

Option 1 from the earlier discussion — **driver script against the full server stack**. The alternative shapes (in-process simulator bypassing sockets, pure logic simulator with mocked state) were ruled out because the bugs we want to find live in the cross-cutting paths (`BotTurnTrigger` turn-advance, NDJSON logging, socket emits) that those shortcuts skip over.

## Script

Single file: `scripts/ai/run-bot-harness.ts`. Reuses existing services (no HTTP layer needed — in-process imports).

### Per-game lifecycle

```
1. LobbyService.createGame({ name, ownerUserId })          → game row in `setup`
2. LobbyService.addBot(gameId, ownerUserId, {              × N (default 4)
     skillLevel: 'medium',
     name: `bot${i}`
   })
3. LobbyService.startGame(gameId, ownerUserId)             → status='initialBuild';
                                                              BotTurnTrigger cascade
                                                              starts automatically
4. Poll every 2s:
     SELECT status, current_player_index FROM games WHERE id = $1
5. Stop when:
     - status='completed'  → record winner via games.winner_id
     - status='abandoned'
     - max-turn cap reached (default 250) — abort and mark stalled
```

### Across N games

Output under `logs/harness-runs/<runId>/` (where `runId` is a timestamp + short uuid):
- **`summary.json`** — array of per-game records:
  ```json
  [{
    "gameId": "...", "winner": "bot2", "winnerCash": 259, "finalTurn": 83,
    "durationMs": 47000, "outcome": "completed",
    "endState": {
      "bot0": { "cash": 181, "majors": 4, "deliveries": 12 },
      "bot1": { "cash": 232, "majors": 5, "deliveries": 14 },
      ...
    }
  }, ...]
  ```
- **`aggregate.csv`** — flat rows for spreadsheet / analysis:
  ```
  gameId,winner,finalTurn,durationMs,outcome,bot0_cash,bot0_majors,bot0_deliveries,bot1_cash,...
  ```
- NDJSON logs at the existing `logs/game-<gameId>.ndjson` path — no change to the log writer; the harness only adds the summary/aggregate layer on top.

## Defaults (will ship unless redirected)

| Setting | Default | Rationale |
|---|---|---|
| Bots per game | 4 | Canonical Eurorails count; matches the test games we've been analyzing |
| Skill level | All Medium | User constraint — no LLM cost |
| Concurrency | Sequential | Each game is ~40-60s; parallel adds DB-pool stress + harder debugging for marginal speedup. Can revisit if data-collection rate becomes the bottleneck. |
| Max-turn safety cap | 250 turns | Longer than any organic game observed (game `8350cffa` ended at T83); aborts stalled games (e.g., JIRA-260-style infinite Derailment loops if a new bug appears). |
| Run invocation | `npx ts-node scripts/ai/run-bot-harness.ts --games 100` | Mirrors existing `scripts/ai/*.ts` invocation pattern |

## Caveats decided before writing

### 1. DB isolation (recommended: separate scratch DB per run)

100 games each leave game / player / player_tracks / NDJSON-mirrored rows. Two options:
- **Append to existing `eurorails_claude` dev DB** — fastest setup but pollutes the user's dev DB with hundreds of finished games.
- **Create scratch DB per run** — harness accepts `--db-name harness-<runId>` flag, runs `CREATE DATABASE` + applies migrations, runs games, optionally drops it at end.

Recommendation: scratch DB per run. Adds ~5s of setup but keeps the dev DB clean.

### 2. Synthetic owner user

`LobbyService.createGame` requires `creatorUserId`. The harness inserts a `harness-runner` user once at startup (no-op if already present). User ID is hardcoded e.g. `00000000-0000-0000-0000-000000000001` to make repeated runs idempotent.

### 3. Error isolation per game

All-bot games already exhibit lifecycle bugs (JIRA-260 Derailment loop, JIRA-261 victory-route lock-in). When the harness hits one in a new form mid-run, the goal is to log the failed game + outcome ("stalled at turn 250" or "uncaught exception in turn N") and **continue the run**, not abort. Each game runs inside a try/catch; failures land in `summary.json` with `outcome: "error" | "stalled"` + the error message.

### 4. Concurrency: deferred

Sequential is the right starting point. If 100 games × 60s = 100 min becomes the bottleneck, revisit with either `worker_threads` (shared server, parallel game lifecycles) or separate Node processes (multiple servers on different ports + DBs). Worth measuring actual per-game time first before optimizing.

### 5. What we measure / collect

Beyond the per-game outcome, the existing `logs/game-<id>.ndjson` already captures every turn's decision trace (composition, demand ranking, victoryCheck, etc.). The harness doesn't change that. The summary / aggregate layer is just a navigation index — "which games stalled? which bot config tends to win? which turn ranges have the longest decision latency?"

For deeper queries the user runs ad-hoc `jq` against the NDJSON logs, same workflow as today.

## Open questions

1. **Should the harness support a `--bot-config` matrix flag** to vary bot configs per game (e.g., Medium-baseline vs Medium-with-experimental-flag-X)? Out of scope for v1 unless explicitly requested — single-config runs first, then add A/B once we know what we want to compare.
2. **Should `--games N` accept a hard time budget instead** (e.g., `--minutes 60`)? Lower priority; sequential makes it predictable enough.
3. **Discovery question:** does the existing `LobbyService.startGame` work cleanly for all-bot games (no human players, no client connections)? If not, the harness may need to invoke `InitialBuildService.setupInitialBuild` directly. **Worth verifying via a single-game test run before committing to the full harness.**

## Next step

Pending Matt's decision on:
- Defaults vs redirects (concurrency, DB isolation, output format)
- Whether to spike a single-game test first (resolves open question 3)
- Implementation slot — file under `scripts/ai/` next to existing analysis tools, or treat as a one-time scratch script
