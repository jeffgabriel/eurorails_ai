# Defect Log — AI Adversaries v4

## Defects Found During Integration Testing

### DEF-001: Missing DB migration for is_bot and bot_config columns
- **Severity:** P0 — Server 500 on addBot
- **Commit:** `8e1c8aa`
- **Root Cause:** `createPlayer` INSERT included `is_bot` and `bot_config` columns but no migration existed to add them to the `players` table.
- **Fix:** Created `db/migrations/033_add_bot_columns_to_players.sql`
- **Lesson:** Always check that new columns referenced in queries have corresponding migrations.

### DEF-002: Bot user_id used invalid UUID format
- **Severity:** P0 — Server 500 on addBot
- **Commit:** `250a9f3`
- **Root Cause:** Generated `bot-{uuid}` as the bot's `user_id`, but the `players.user_id` column is UUID type in Postgres. The `bot-` prefix makes it an invalid UUID.
- **Fix:** Switched to plain `uuidv4()` for bot user_id.
- **Lesson:** Check column types in the actual DB schema, not just the TypeScript types.

### DEF-003: Bot user_id violates FK constraint on users table
- **Severity:** P0 — Server 500 on addBot
- **Commit:** `82e0201`
- **Root Cause:** `players.user_id` has `FOREIGN KEY REFERENCES users(id)` (migration 012). A random UUID doesn't exist in the `users` table. Setting to NULL was attempted but would break ~30 queries that use `WHERE user_id = $X`.
- **Fix (reverted):** Initially set `user_id = NULL`, but this was incorrect.
- **Commit:** `ccbf646`
- **Fix (final):** Create a synthetic `users` row per bot (`BOT_NO_LOGIN` password, `bot-*@bot.internal` email). Clean up user row on bot removal.
- **Lesson:** Audit all downstream consumers of a column before changing its semantics. The tech spec's `bot-{uuid}` suggestion didn't account for the FK constraint or the 30+ `WHERE user_id = $X` queries throughout the codebase.

### DEF-004: Double bot turn execution
- **Severity:** P1 — Every bot turn executes twice, duplicating all side effects
- **Root Cause:** `playerRoutes.ts:297` calls `emitTurnChange()` redundantly after `PlayerService.updateCurrentPlayerIndex()` which already emits the same event internally (playerService.ts:666). Both emissions invoke `BotTurnTrigger.onTurnChange()` via dynamic import in socketService, and due to microtask timing both can pass the `pendingBotTurns` guard.
- **Fix:** Removed redundant `emitTurnChange` call in `playerRoutes.ts:297`.
- **Status:** Fixed
- **Lesson:** Trace the full call chain before emitting events — the callee may already emit.

### DEF-005: Bots don't respect initialBuild game phase
- **Severity:** P1 — Bots take regular turns (UpgradeTrain, PassTurn) during build-only phase
- **Root Cause:** `OptionGenerator.generate()` generates ALL option types regardless of `snapshot.gamePhase`. No component in the AI pipeline checks the game phase. The WorldSnapshot correctly includes `gamePhase: 'initialBuild'` but nothing reads it.
- **Fix:** Added early return in `OptionGenerator.generate()` — during `initialBuild`, only calls `generateBuildTrackOptions()`, `generateBuildTowardMajorCityOptions()`, and `generatePassTurnOption()`.
- **Status:** Fixed
- **Lesson:** When a game phase field exists in the snapshot, every pipeline stage should respect it.

### DEF-006: UpgradeTrain attempted during initialBuild causes "Illegal upgrade transition"
- **Severity:** P2 — Bots waste retries on invalid upgrades, drain money on repeated attempts
- **Root Cause:** Re-investigation showed `VALID_UPGRADES` config is correct (FastFreight↔HeavyFreight already marked as `crossgrade`). The errors occurred because bots attempted UpgradeTrain during initialBuild after already building track, triggering `turnBuildCost !== 0` guard in `PlayerService.purchaseTrainType()`.
- **Fix:** Resolved by DEF-005 fix — UpgradeTrain options are no longer generated during initialBuild.
- **Status:** Fixed (by DEF-005)
- **Lesson:** Trace the full error scenario before assuming config mismatch — the root cause was option generation during the wrong game phase.

### DEF-007: Human player movement rejected during active game
- **Severity:** P1 — Human unable to play
- **Root Cause:** Cascading effect of DEF-004 (double execution) and DEF-005 (initialBuild not enforced). Double bot turns advance the turn counter incorrectly, and bots not building track during initialBuild means the phase may not transition properly to active.
- **Fix:** Expected to resolve with DEF-004 + DEF-005 fixes. Requires live retest.
- **Status:** Pending verification

### DEF-008: 'random' archetype not resolved server-side, crashes client
- **Severity:** P0 — Cannot add a bot (client crash on render)
- **Root Cause:** `BotConfigPopover` default archetype is `'random'`. Server stores it as-is in `bot_config.archetype`. Client's `getArchetypeColors('random')` returns `undefined` (only 5 concrete archetypes mapped), causing `colors.bg` to throw.
- **Fix:** Resolve `'random'` to a concrete `ArchetypeId` in `LobbyService.addBot()` before storing. Also fixed bot name fallback to use display names instead of raw archetype IDs.
- **Status:** Fixed
- **Lesson:** When a UI offers a meta-option like "random", the server must resolve it to a concrete value before storage.

### DEF-009: Bot turn advancement uses wrong mechanism during initialBuild
- **Severity:** P0 — Game stuck after bot's first turn
- **Root Cause:** `BotTurnTrigger.advanceTurnAfterBot()` always uses `PlayerService.updateCurrentPlayerIndex()` which is the active-game turn mechanism. During `initialBuild`, turn advancement must use `InitialBuildService.advanceTurn()` which handles round transitions (clockwise → counter-clockwise) and the phase transition to `active`.
- **Fix:** Added game status check in `advanceTurnAfterBot()` — calls `InitialBuildService.advanceTurn()` during initialBuild, and the existing `PlayerService.updateCurrentPlayerIndex()` during active phase.
- **Status:** Fixed
- **Lesson:** Game phase affects turn mechanics — any code that advances turns must be phase-aware.

### DEF-010: Bot can't build track when it has no existing track
- **Severity:** P1 — Bot always passes during initialBuild, never builds track
- **Root Cause:** `computeBuildSegments` Dijkstra seeds from `networkNodes` (existing track endpoints). On the first build turn, `snapshot.trackSegments` is empty → `networkNodes` is empty → Dijkstra has no source nodes → returns `[]` → no build options generated → PassTurn fallback.
- **Fix:** When `networkNodes` is empty and `snapshot.position` exists, seed the Dijkstra with the bot's current position (a major city milepost). Per rules, players start building track from any major city milepost.
- **Status:** Fixed
- **Lesson:** Pathfinding algorithms need a "cold start" case — when there's no existing network, the bot's position is the seed.

## Patterns to Watch For
- **Missing migrations:** Any new column in an INSERT/UPDATE must have a migration.
- **FK constraints:** Check migrations for REFERENCES before assuming a column can hold arbitrary values.
- **NULL semantics in SQL:** `WHERE col = $X` never matches NULL — always audit callers if considering NULL as a value.
