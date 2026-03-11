# AI Bot Players v5 — Master Implementation Plan

**EuroRails Online | February 2026 | Author: Matt Everard + Claude**
**Status: Plan | Approach: Iterative with human validation at each increment**

---

## Philosophy

AI bot implementation is complex — it touches every layer of the stack (database, server services, socket events, client rendering). The risk is building too much before validating anything.

This plan takes an incremental approach. Each section delivers a **testable, observable increment** that builds on the last. Nothing proceeds until the previous increment works in the actual UI. The human developer validates each increment by playing the game and observing bot behavior before moving on.

**Key principles:**
- **Validate before you elaborate.** A bot that correctly passes its turn is worth more than a bot that "plans" brilliant moves but freezes the game.
- **Use existing code paths.** The game already works for humans. Bots must go through the same server-side functions, the same socket events, the same database writes. AI-specific code handles ONLY decision-making.
- **Make failures visible.** A debug overlay (backtick key) is built in Section 2 and evolves with every section. Silent failures are the biggest risk.
- **One archetype, one skill level first.** Opportunist at Medium difficulty. Add the other 14 combinations only after the core loop works end-to-end.

---

## Document Conventions

Each section below is **self-contained** — it can be pasted into Compounds independently to generate a development plan with coding tasks. Each section includes:

- **Goal**: What this increment achieves
- **Depends On**: Which previous sections must be complete
- **Human Validation**: How the developer confirms it works in the UI
- **Technical Context**: Key files, services, and patterns from the existing codebase
- **Requirements**: What to build
- **Warnings**: Potential pitfalls and common mistakes to avoid
- **Acceptance Criteria**: Concrete pass/fail conditions

---

## Section 1: Bot Player Identity — Lobby, Database, and Game Start

### Goal
A human player can add a bot to the game lobby, start the game, and see the bot listed as a player. The bot does nothing during its turn — the game simply freezes on the bot's turn. This is the expected behavior for this section. The point is to validate that bot player records are created correctly and the game starts normally with a bot present.

### Depends On
Nothing — this is the foundation.

### Human Validation
1. Create a new game in the lobby
2. Click "Add Bot" — a popover appears with skill level selector (Easy/Medium/Hard), archetype selector (show all 5 + Random option), and optional name field
3. Bot appears in lobby player list with a 🤖 icon and archetype badge
4. Click "Start Game" — game starts normally, initial build phase begins
5. The human player takes their first initial build turn (builds track, clicks Next Player)
6. **Expected: the game now shows it's the bot's turn, and the UI is stuck there.** The leaderboard highlights the bot's name. The human cannot act. This is correct — the bot has no turn logic yet.

### Technical Context

**Database requirements for bot players:**
- Bot players need a row in the `users` table. The `players.user_id` column has a FOREIGN KEY constraint referencing `users(id)`. Creating a player without a valid user row will cause a 500 error.
- Create a synthetic user for each bot: `password_hash = 'BOT_NO_LOGIN'`, `email = 'bot-{uuid}@bot.internal'`, `username = 'Bot-{shortId}'`.
- Add columns to the `players` table via migration: `is_bot BOOLEAN NOT NULL DEFAULT false`, `bot_config JSONB` (stores `{ skillLevel, archetype, botName }`).

**Archetype resolution:**
- The "Random" archetype option must be resolved to one of the 5 concrete archetypes (`backbone_builder`, `freight_optimizer`, `trunk_sprinter`, `continental_connector`, `opportunist`) BEFORE writing to `bot_config`. Client-side rendering code maps archetype IDs to display properties (colors, icons, labels). If `'random'` is stored as-is, the client will crash when trying to look up display properties for an unknown archetype.

**Existing lobby flow:**
- Game creation: `POST /api/lobby/games` → creates game with `status: 'setup'`
- Game start: `POST /api/lobby/games/{id}/start` → `LobbyService.startGame()` → currently sets `status = 'active'` directly (see `lobbyService.ts:581`). ⚠️ **`InitialBuildService` does not exist yet** — the `initialBuild` phase, player ordering, and round management described in this plan must be implemented as a prerequisite (see Section 3).
- Socket: `game-started` event emitted → clients navigate to `/game/{gameId}`

**Lobby UI:**
- The existing lobby page shows player names, colors, and a ready status.
- Add an "Add Bot" button that opens a configuration popover.
- Bot entries in the player list show a 🤖 icon, the bot's name, and an archetype badge (colored label).
- The host can remove bots before starting.
- Bots auto-ready (they don't need to click a ready button).
- Player colors are auto-assigned from an available color pool via `getAvailableColors(gameId)`.

### Requirements

1. **Database migration**: Add `is_bot` (BOOLEAN, NOT NULL, DEFAULT false) and `bot_config` (JSONB, nullable) columns to the `players` table.

2. **Server: LobbyService.addBot()**: New method that:
   - Validates the game exists, is in `setup` status, and has < 6 players
   - Validates the requesting user is the game creator
   - Resolves `'random'` archetype to a concrete archetype (random selection from the 5)
   - Creates a synthetic `users` row (`password_hash='BOT_NO_LOGIN'`, `email='bot-{uuid}@bot.internal'`)
   - Creates a `players` row with `is_bot=true`, `bot_config = { skillLevel, archetype, botName }`
   - Auto-assigns a color from available colors
   - Emits `lobby-updated` socket event
   - Returns the created player

3. **Server: LobbyService.removeBot()**: New method that removes a bot player and its synthetic user row. Emits `lobby-updated`.

4. **Server: API routes**: `POST /api/lobby/games/{id}/bots` (add bot), `DELETE /api/lobby/games/{id}/bots/{playerId}` (remove bot). Protected by auth middleware. Only the game creator can add/remove bots.

5. **Client: BotConfigPopover component**: UI for configuring a bot before adding. Fields: skill level (Easy/Medium/Hard dropdown), archetype (6 options: 5 named + Random), optional name (text input, default auto-generated). Submit button calls the add-bot API.

6. **Client: Lobby player list**: Bot entries display with 🤖 icon and archetype badge. Remove button (X) appears for the host.

7. **Client: Archetype display utilities**: A mapping from archetype ID to display properties: `{ label: string, icon: string, color: string }` for each of the 5 archetypes. Used in lobby, leaderboard, and later in the debug overlay.

### Warnings

- **Do NOT set `user_id = NULL` for bot players.** There are 30+ queries in the codebase using `WHERE user_id = $X`. SQL `NULL != NULL`, so all of them would silently fail to match bot players. Bots must have a real user_id pointing to a real users row.
- **Do NOT store `'random'` as the archetype value.** Resolve it to a concrete archetype before writing to the database.
- **Do NOT modify any shared game logic in this section.** The goal is purely to add bot player records. The game will freeze on the bot's turn — that's expected and correct.

### Acceptance Criteria

- [ ] Human can add 1-5 bots to a lobby
- [ ] Each bot appears in the lobby with 🤖 icon, name, archetype badge, and assigned color
- [ ] Human can remove a bot from the lobby
- [ ] "Random" archetype resolves to a concrete archetype (not stored as 'random')
- [ ] Game starts normally with bots present — `InitialBuildService.initPhase()` (⚠️ to be created) includes bots in the player order
- [ ] Bot player has valid `users` row (no FK violations)
- [ ] Game reaches `initialBuild` phase and the human can take their first build turn
- [ ] After human's turn, the game shows it's the bot's turn (leaderboard highlights bot) — game is stuck, which is expected
- [ ] Human-only games (no bots) still work exactly as before — zero regressions

---

## Section 2: Debug Overlay Foundation

### Goal
Press the backtick key (`) during a game to toggle a debug overlay that shows raw game state. This overlay is available from this point forward and evolves with every subsequent section. It is the primary debugging tool for the entire AI implementation.

### Depends On
Section 1 (bot players exist in the game).

### Human Validation
1. Start a game (with or without bots)
2. Press backtick (`) — a semi-transparent overlay appears on the right side of the screen
3. The overlay shows: current game phase, current player index, whose turn it is, and a table of all players with their key state (name, is_bot, money, position, train type, loads, turn number)
4. Press backtick again — overlay disappears
5. Play a turn as human — overlay updates in real-time as state changes (money decreases when building track, position updates when moving)

### Technical Context

**Client architecture:**
- The game runs in Phaser 3. The main game scene is `GameScene` (`src/client/scenes/GameScene.ts`).
- Game state is stored in `GameScene.gameState: GameState` — a mutable object that is the single source of truth during gameplay.
- State updates arrive via socket events: `state:patch` (incremental updates), `turn:change` (turn advancement), `track:updated` (track changes).
- The overlay should be a Phaser DOM element or an HTML overlay positioned above the Phaser canvas, so it can display structured data (tables, JSON) without fighting with Phaser's rendering.

**State available in `gameState`:**
- `id` (game ID), `status` (setup/initialBuild/active/completed), `currentPlayerIndex`
- `players[]`: each with `id`, `name`, `money`, `trainState.position` (nullable), `trainState.type`, `trainState.loads[]`, `hand[]` (demand card IDs), `color`, `isBot`, `botConfig`
- `victoryTriggered`, `victoryThreshold`

### Requirements

1. **Client: DebugOverlay component**: A toggleable overlay activated by the backtick key. Implementation approach:
   - Listen for keydown event on the backtick key (keyCode 192 / key `` ` ``)
   - Toggle visibility of an HTML div positioned absolutely over the Phaser canvas
   - The overlay is semi-transparent (background `rgba(0,0,0,0.85)`), positioned on the right side, scrollable, monospace font
   - Z-index above the Phaser canvas but below any modal dialogs

2. **Overlay content — Game State panel**:
   - **Header**: Game ID (truncated), game status, current player index, current player name
   - **Players table**: One row per player, columns: Name, Bot?, Money, Position (row,col or "none"), Train, Loads, Turn#
   - Bot players highlighted with a distinct background color
   - Current player's row highlighted

3. **Overlay content — Socket Events log**:
   - A scrollable log of the last 50 socket events received (event name, truncated payload, timestamp)
   - New events appear at the top
   - This becomes invaluable for debugging turn advancement issues

4. **Overlay content — Bot Turn section** (placeholder for now):
   - Text: "No bot turn data yet — bot turn execution not implemented"
   - This section will be populated in later sections

5. **Real-time updates**: The overlay re-renders whenever `gameState` changes (hook into `state:patch` and `turn:change` handlers).

6. **Persistence**: The overlay's open/closed state persists across scene changes (store in a global variable or localStorage).

### Warnings

- **Do NOT use Phaser Graphics or Text objects for the overlay.** HTML is far better for structured data display (tables, scrollable logs). Use an HTML div overlay positioned above the canvas.
- **Do NOT capture the backtick key if the user is typing in a text input** (e.g., chat). Check `document.activeElement` before toggling.

### Acceptance Criteria

- [ ] Backtick key toggles the overlay on/off
- [ ] Overlay shows correct game state: phase, current player, all player data
- [ ] Player data updates in real-time as the human plays (money changes, position changes)
- [ ] Socket event log shows events as they arrive
- [ ] Bot players are visually distinguished in the player table
- [ ] Overlay does not interfere with normal gameplay (clicks pass through to the game, no input capture issues)
- [ ] Overlay is readable (monospace font, good contrast, reasonable sizing)

---

## Section 3: Bot Turn Skeleton — Pass Turn Correctly

### Goal
When it becomes a bot's turn, the server automatically detects this, waits briefly, then passes the turn on the bot's behalf. The game advances to the next player without freezing. This is the most critical section — it establishes the bot turn lifecycle that every subsequent section builds on.

### Depends On
Section 1 (bot players exist), Section 2 (debug overlay for observing behavior).

### Human Validation
1. Start a game with 1 human + 1 bot
2. Human takes their initial build turn (builds track, clicks Next Player)
3. **Within 2-3 seconds, the turn automatically advances past the bot back to the human**
4. The debug overlay shows: bot's turn started, bot's turn completed (PassTurn), turn advanced to human
5. The leaderboard briefly highlights the bot's name during the bot's turn, then switches back to the human
6. Repeat through both initial build rounds — all turns advance correctly
7. Game transitions from `initialBuild` to `active` phase correctly
8. In active phase, the same pattern continues — bot turns pass automatically
9. Test with 1 human + 3 bots — all 3 bot turns pass in sequence (~4-5 seconds total), then it's the human's turn again
10. Test with 1 human + 5 bots — all 5 bot turns pass in sequence, game doesn't freeze

### Technical Context

**Turn advancement flow (how humans end turns):**
- Human clicks "Next Player" → client calls `POST /api/players/updateCurrentPlayer` with `currentPlayerIndex: nextIndex`
- Server: `PlayerService.updateCurrentPlayerIndex(gameId, nextIndex)` → updates `games.current_player_index` → calls `emitTurnChange(gameId, nextIndex, nextPlayerId)`
- `emitTurnChange()` in `socketService.ts` emits the `turn:change` socket event to the game room
- Client: `handleTurnChange(currentPlayerIndex)` fires → refreshes player data, updates UI, resets movement points

**Turn advancement during initialBuild (critical difference):**
- ⚠️ **`InitialBuildService` does not exist yet.** Currently `LobbyService.startGame()` sets `status = 'active'` directly (`lobbyService.ts:581`) — there is no `initialBuild` phase. The service described below must be created as part of this plan.
- Once implemented: during `initialBuild`, turn advancement MUST use `InitialBuildService.advanceTurn(gameId)`, NOT `PlayerService.updateCurrentPlayerIndex()`.
- `InitialBuildService.advanceTurn()` must handle: round 1 clockwise order, round 2 reverse order, and the transition from `initialBuild` to `active` status.
- Using the wrong advancement method will break round progression — the game will be stuck in initialBuild forever or skip rounds.

**Socket event for turn changes:**
- Event: `turn:change` with payload `{ currentPlayerIndex, currentPlayerId, gameId, timestamp }`
- This event is received by ALL clients in the game room
- The `turn:change` handler on the client (`handleTurnChange`) is async and calls `refreshPlayerData()` which makes an HTTP request

**Race condition warning:**
- When multiple bots play in sequence, multiple `turn:change` events fire rapidly (one per bot turn)
- The client's `handleTurnChange` is async (it awaits `refreshPlayerData()` which is an HTTP fetch)
- If 3 `turn:change` events arrive within 15ms, three concurrent async handlers run simultaneously
- The last one to resolve determines the final UI state — if an earlier event's handler resolves last, the UI shows the wrong player's turn
- **Solution: Add a sequence counter to `handleTurnChange`.** Each invocation gets an incrementing ID. After the async work completes, check if this invocation is still the latest. If not, discard the result.

**Bot turn housekeeping:**
- When a bot's turn ends, the bot's `current_turn_number` in the `players` table must be incremented (the human client does this in `GameScene.nextPlayerTurn()`, but bots don't have a client)
- The bot's `player_tracks.turn_build_cost` must be reset to 0 (the human client does this via `trackManager.endTurnCleanup()`)

### Requirements

1. **Server: BotTurnTrigger module** (`src/server/services/ai/BotTurnTrigger.ts`):
   - Exports a function `onTurnChange(gameId, currentPlayerIndex, currentPlayerId)` that is called by `emitTurnChange()` in `socketService.ts`
   - Checks if the player at `currentPlayerIndex` is a bot (`is_bot = true`)
   - If not a bot, returns immediately (no-op for human turns)
   - If a bot: adds a guard to prevent double execution (use a `Set<string>` of gameIds currently executing bot turns). If this game already has a bot turn in progress, return immediately.
   - Checks that at least one human player is connected to the game room (via Socket.IO room membership). If no humans are connected, queue the bot turn for later (store the pending turn info and execute when a human reconnects).
   - After a delay (`BOT_TURN_DELAY_MS = 1500`), executes the bot turn
   - For this section, "execute" means: log the turn, increment the bot's `current_turn_number`, then advance to the next player
   - After execution, calls `advanceTurnAfterBot(gameId)` which checks game status:
     - If `initialBuild`: calls `InitialBuildService.advanceTurn(gameId)` (⚠️ to be created — see Section 1 prerequisites)
     - If `active`: calls `PlayerService.updateCurrentPlayerIndex(gameId, nextIndex)` where nextIndex is `(currentIndex + 1) % playerCount`
   - Removes the game from the pending set in a `finally` block (even if errors occur)

2. **Server: Hook BotTurnTrigger into emitTurnChange**:
   - In `socketService.ts`, after emitting the `turn:change` event, dynamically import and call `BotTurnTrigger.onTurnChange(gameId, currentPlayerIndex, currentPlayerId)`
   - **CRITICAL: Do NOT emit `turn:change` from the route handler if the service method already emits it.** Trace the call chain before adding any new `emitTurnChange()` calls. Duplicate emissions cause duplicate bot triggers. The callee (`updateCurrentPlayerIndex` or `advanceTurn`) already emits `turn:change` — the route handler must NOT emit again.

3. **Server: Bot turn housekeeping**:
   - Increment `players.current_turn_number` for the bot whose turn just completed
   - Check game status (`completed`, `abandoned`) before advancing — don't advance turns in a finished game
   - Check the `ENABLE_AI_BOTS` feature flag (environment variable) — if disabled, don't trigger bot turns even if bot players exist

4. **Server: Bot turn socket events**:
   - Emit `bot:turn-start` with `{ botPlayerId, turnNumber }` when the bot's turn begins (after the delay)
   - Emit `bot:turn-complete` with `{ botPlayerId, turnNumber, action: 'PassTurn', durationMs }` when the turn ends
   - These events are for the debug overlay and future UI animations

5. **Client: Guard handleTurnChange against race conditions**:
   - Add an incrementing sequence counter (e.g., `private turnChangeSeq = 0`)
   - At the start of `handleTurnChange`, increment the counter and capture the value: `const mySeq = ++this.turnChangeSeq`
   - After all async work (especially `refreshPlayerData()`), check: `if (mySeq !== this.turnChangeSeq) return` — this discards stale invocations
   - This prevents the scenario where `handleTurnChange(1)` resolves after `handleTurnChange(0)`, leaving the UI showing the wrong player

6. **Client: Debug overlay updates**:
   - Add listeners for `bot:turn-start` and `bot:turn-complete` socket events
   - Display in the Bot Turn section of the debug overlay: "Bot {name} turn started at {time}" → "Bot {name} turn completed: PassTurn ({duration}ms)"
   - Show a running count: "Bot turns this game: {n}"

7. **Client: Handle human reconnection**:
   - When a human joins a game room (socket `join` event), the server should check if there are any queued bot turns for this game and execute them

### Warnings

- **Turn advancement is phase-aware.** During `initialBuild`, you MUST use `InitialBuildService.advanceTurn()` (⚠️ to be created — see Technical Context above). During `active`, you MUST use `PlayerService.updateCurrentPlayerIndex()`. Using the wrong one will break the game — either the initial build rounds won't progress correctly, or the transition to active phase won't happen.
- **Do NOT emit `turn:change` redundantly.** Both `InitialBuildService.advanceTurn()` (once created) and `PlayerService.updateCurrentPlayerIndex()` already emit `turn:change` internally. If you also emit it from the caller, you get duplicate events, which trigger duplicate bot turns (both can pass the guard if they arrive in the same microtask).
- **The `handleTurnChange` race condition is the #1 cause of "game stuck on bot turn" bugs.** Multiple bot turns fire rapidly, each producing a `turn:change` event. Without a sequence counter, the async handlers race and the UI can end up showing a bot's turn even though the server has advanced to the human's turn.
- **Do NOT skip bot turn housekeeping.** The human's `nextPlayerTurn()` method increments turn number, resets turn build cost, and deducts build cost from money. Bots don't have a client, so these must be done server-side during the bot turn.

### Acceptance Criteria

- [ ] 1 human + 1 bot: after human's turn, bot's turn passes automatically within ~2 seconds, then it's human's turn again
- [ ] 1 human + 3 bots: all 3 bot turns pass in sequence (~5 seconds total), no freezing
- [ ] 1 human + 5 bots: all 5 bot turns pass in sequence (~8-10 seconds), no freezing
- [ ] Initial build phase: both rounds complete correctly (clockwise, then counter-clockwise), game transitions to `active` phase
- [ ] Debug overlay shows bot turn start/complete events with timing
- [ ] Debug overlay socket log shows `turn:change` events firing correctly (no duplicates)
- [ ] Bot's `current_turn_number` increments each turn (verify in debug overlay player table)
- [ ] Game with no bots (human-only) still works identically — zero regressions
- [ ] Human disconnecting and reconnecting during bot turns doesn't break the game
- [ ] Server logs show bot turn execution (game ID, bot ID, turn number, action taken)
- [ ] No `[BOT:ERROR]` entries in server logs during normal play

---

## Section 4: Bot Builds Track — First Real Action

### Goal
During its turn, the bot builds a small amount of track instead of just passing. The bot picks a major city near one of its demand card destinations and builds 2-3 track segments outward from it. The track appears on the map in the bot's color. This is the first time the bot modifies game state beyond turn advancement.

### Depends On
Section 3 (bot turn lifecycle works — turns advance correctly).

### Human Validation
1. Start a game with 1 human + 1 bot
2. After the human's first initial build turn, watch the bot's turn
3. **Track segments appear on the map in the bot's color** (2-3 segments radiating from a major city)
4. The debug overlay shows: the bot's money decreased (by the track building cost), and track building details (which segments, cost)
5. The bot's track persists — it's visible on subsequent turns
6. Over the initial build rounds (4 bot turns total — 2 rounds × 2 turns), the bot builds ~8-12 segments of track
7. In the active phase, the bot continues building track on its turns (still no movement or deliveries)
8. The human can see the bot's track and can use it (paying the $4M fee)

### Technical Context

**How humans build track (the code path bots must use):**
- Client draws segments → `POST /api/tracks/save` with `{ gameId, playerId, trackState: { segments, totalCost, turnBuildCost } }`
- Server: `TrackService.saveTrackState(gameId, playerId, trackState)` → UPSERT into `player_tracks`
- Route handler emits `track:updated` socket event → all clients re-fetch and redraw tracks
- Money is deducted separately: client calls `POST /api/players/updatePlayerMoney` at turn end

**TrackSegment format:**
```typescript
{
  from: { x: number, y: number, row: number, col: number, terrain: TerrainType },
  to:   { x: number, y: number, row: number, col: number, terrain: TerrainType },
  cost: number
}
```

**Both coordinate systems (grid AND pixel) must be present in every segment.** The client renders tracks using pixel coordinates (`from.x`, `from.y`). If pixel coordinates are `0, 0`, tracks render at the top-left corner of the map (invisible). Pixel coordinates are computed from grid coordinates: `x = col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`, `y = row * 45 + 120`.

**Track cost rules:**
- Clear terrain: $1M, Mountain: $2M, Alpine: $5M, Small/Medium city: $3M, Major city: $5M
- Water crossings add extra: River +$2M, Lake +$3M, Ocean Inlet +$3M
- Turn limit: $20M per turn
- First track segment must start from a major city

**Map topology:**
- The hex grid is defined in `configuration/gridPoints.json`. Each point has `GridX` (column), `GridY` (row), `Type` (terrain), `Name` (city name, if any).
- Hex adjacency uses an even-q offset grid. Odd rows shift right by half a column.

**Socket event for track updates:**
- `track:updated` with `{ gameId, playerId, timestamp }` — payload does NOT include segments
- Client listener fetches all tracks via `GET /api/tracks/{gameId}` then redraws

**Money deduction for track building:**
- The human client deducts build cost from money at turn end (`POST /api/players/updatePlayerMoney`). This is client-side logic.
- Bots must deduct money server-side as part of their turn execution.

### Requirements

1. **Server: AIStrategyEngine module** (`src/server/services/ai/AIStrategyEngine.ts`):
   - The top-level orchestrator for bot turns. Called by `BotTurnTrigger` instead of directly passing.
   - For this section, it implements a simple strategy: pick a starting major city, build 2-3 track segments outward along cheap terrain.
   - Flow: load game state → pick a target major city → compute buildable segments → save track → deduct money → emit socket events → return audit data

2. **Server: Map topology loader**:
   - Load and parse `configuration/gridPoints.json` on the server side
   - Build an in-memory lookup: `gridPoints[row][col] → { terrain, cityName?, cityType?, etc. }`
   - Provide hex adjacency computation: given a `{row, col}`, return all 6 adjacent hex neighbors that are valid (non-water) grid points
   - This is used by the bot to find buildable segments

3. **Server: Track segment computation**:
   - Given a starting point (major city) and the map topology, find 2-3 adjacent mileposts to build toward
   - Prefer cheap terrain (clear > mountain > alpine)
   - Build outward from the major city, extending the bot's existing track
   - If the bot has no track yet, start from the major city closest to the bot's demand card destinations
   - Compute the cost of each segment based on destination terrain
   - Enforce the $20M/turn limit
   - **For each segment, compute BOTH grid and pixel coordinates**. Use the formula: `x = col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`, `y = row * 45 + 120`.

4. **Server: Track saving and money deduction**:
   - Call `TrackService.saveTrackState()` with the bot's accumulated segments (existing + new)
   - Deduct the build cost from the bot's money: `UPDATE players SET money = money - $cost WHERE id = $botPlayerId`
   - Emit `track:updated` socket event so human clients see the new track
   - Emit `state:patch` with updated money so the leaderboard updates

5. **Server: Bot turn audit data**:
   - Create a `bot_turn_audits` table (migration) to store decision data for each bot turn
   - Record: game_id, player_id, turn_number, action taken (BuildTrack), segments built, cost, duration_ms
   - Emit this audit data in the `bot:turn-complete` socket event

6. **Client: Debug overlay — track building data**:
   - When `bot:turn-complete` arrives with BuildTrack action, display in the Bot Turn section:
     - "Bot {name} built {n} segments, cost: {cost}M, remaining money: {money}M"
     - List each segment: "{from.row},{from.col} → {to.row},{to.col} (terrain: {type}, cost: {cost}M)"

### Warnings

- **Track segments MUST include valid pixel coordinates (x, y).** It's easy to accidentally store `x: 0, y: 0` if the server-side map topology doesn't include pixel data. The client renders tracks using `(from.x, from.y)` to `(to.x, to.y)` — if these are zero, all track draws as invisible dots at the top-left corner. Compute pixel from grid using the deterministic formula.
- **Emit `track:updated` after saving track.** The client only redraws tracks when it receives this socket event. If you save to the database but don't emit the event, the human player will never see the bot's track. The route handler emits this event for human track saves — bots must emit it too since they bypass the route handler.
- **Money deduction happens at turn end for humans (client-side), but must happen server-side for bots.** The human client calls a separate API to deduct money after saving track. The bot must deduct money as part of its turn execution. Don't forget this or the bot will build track for free.
- **First track must start from a major city.** This is a game rule enforced by the client for humans. The bot must also follow this rule.

### Acceptance Criteria

- [ ] Bot builds 2-3 track segments during its initial build turns
- [ ] Track appears on the human's map in the bot's assigned color
- [ ] Track segments are at correct map positions (not at position 0,0)
- [ ] Bot's money decreases by the correct amount (visible in debug overlay)
- [ ] Track persists across turns (visible on all subsequent turns)
- [ ] Bot respects the $20M/turn build limit
- [ ] Bot's first track starts from a major city
- [ ] `track:updated` socket event fires for each bot build (visible in debug overlay socket log)
- [ ] Bot turn audit data shows in debug overlay (segments, cost, timing)
- [ ] Human can use bot's track (paying $4M fee) — existing track usage fee logic works
- [ ] Human-only games unaffected — zero regressions

---

## Section 5: Bot Gets a Position — Train Placement and Movement

### Goal
The bot places its train at a major city on its track network and can move along its track. The bot's train sprite appears on the map and moves each turn. No load pickup or delivery yet — the bot just moves toward interesting destinations.

### Depends On
Section 4 (bot has track to move on).

### Human Validation
1. Start a game with 1 human + 1 bot
2. After initial build rounds, game transitions to active phase
3. Bot's train sprite appears on the map at a major city (the bot placed itself)
4. On subsequent turns, the bot's train moves along its track (sprite animates or jumps to new position)
5. Debug overlay shows bot's position updating each turn (row, col)
6. The bot moves toward cities that appear on its demand cards (even though it can't deliver yet)
7. The bot continues to build track on turns where it moves (mixed movement + building turns)

### Technical Context

**How human train position works:**
- Position is stored in 4 database columns: `position_row`, `position_col`, `position_x`, `position_y`
- **All 4 columns must be set together.** The read path in `PlayerService.getPlayers()` uses `position_x !== null` as the check for "player has a position". If only row/col are set (and x/y are null), the player appears to have no position.
- Position is updated via `PlayerService.moveTrainForUser()` which writes all 4 columns in a transaction
- The client renders train sprites at `(position.x + offsetX, position.y + offsetY)` using `TrainSpriteManager`

**Movement rules:**
- Movement is along existing track only (player's own track or opponent's track with $4M fee)
- Speed limit: Freight = 9 mileposts/turn, FastFreight = 12
- No reversal of direction except at cities or ferry ports
- Movement is blocked during `initialBuild` phase (server enforces this in `moveTrainForUser()`)
- Track usage fees: $4M per opponent whose track you use during a turn (flat fee, not per milepost)

**Client rendering of other players' trains:**
- `refreshPlayerData()` in `GameScene.ts` fetches all player data from server
- For other players (including bots), it uses `player.trainState.position` to place sprites
- **The position must have valid pixel coordinates.** If x/y are 0, the sprite renders at the top-left corner.
- When a position update arrives via `state:patch`, `UIManager.updateTrainPosition()` moves the sprite

**Socket events for position updates:**
- `state:patch` with `{ players: [{ id, position, money, ... }] }` — sent when player state changes
- The client's `state:patch` handler updates sprites for other players

### Requirements

1. **Server: Train placement**:
   - In `AIStrategyEngine.takeTurn()`, before generating options, check if the bot has a position
   - If no position and bot has track: auto-place at the best major city on the bot's network (closest to demand card destinations)
   - Set ALL 4 position columns: `position_row`, `position_col`, `position_x`, `position_y`
   - Pixel coordinates computed from grid: `x = col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`, `y = row * 45 + 120`
   - Emit `state:patch` with the updated position so the client renders the train sprite

2. **Server: Movement execution**:
   - Call `PlayerService.moveTrainForUser()` (the same function humans use) to move the bot
   - This ensures track usage fees are computed and paid correctly
   - The function validates game status, turn ownership, and updates all 4 position columns
   - It emits `state:patch` with updated player data

3. **Server: Simple movement strategy**:
   - For this section, the bot's movement strategy is simple: move toward the city on its demand cards that is closest along its existing track
   - Use pathfinding on the bot's track network to find a path from current position to the nearest demand city
   - Move up to the speed limit along that path
   - If no demand city is reachable on existing track, stay in place (will build track toward it instead)

4. **Server: Mixed turns (move + build)**:
   - In the active phase, the bot should both move and build track in the same turn
   - Movement happens first (as per game rules), then building
   - The turn sequence: place train (if needed) → move train → build track → end turn

5. **Client: Debug overlay — position and movement data**:
   - Show current bot position in the player table (row, col)
   - When bot moves, show: "Bot {name} moved from ({fromRow},{fromCol}) to ({toRow},{toCol}), {distance} mileposts, {feesOrNone}"
   - Show movement path if available in audit data

### Warnings

- **Set ALL 4 position columns.** If you only set `position_row` and `position_col` (which are the logical coordinates the server cares about), the read path will see `position_x === null` and conclude the player has no position. This will cause the bot to try to auto-place every turn, and the client will never show the bot's train sprite.
- **Compute pixel coordinates deterministically from grid.** Use `x = col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`, `y = row * 45 + 120`. Don't try to look up pixel coordinates from `gridPoints.json` — the JSON file uses `GridX`/`GridY` which are column/row (not pixel coordinates).
- **Movement during `initialBuild` is blocked server-side.** The bot must not attempt movement during `initialBuild`. Only generate movement options when `game.status === 'active'`.
- **Use `PlayerService.moveTrainForUser()` for movement**, not direct SQL updates. This ensures track usage fees are computed, turn actions are recorded, and the function validates all preconditions. Bypassing this means bots won't pay fees and won't follow movement rules.

### Acceptance Criteria

- [ ] Bot's train sprite appears on the map after initial build rounds
- [ ] Bot's train is positioned at a major city on its track network (not at 0,0)
- [ ] Bot moves along its track each active turn (sprite moves to new position)
- [ ] Bot's money decreases by $4M when using opponent track (if applicable)
- [ ] Debug overlay shows bot's current position (row, col) updating each turn
- [ ] Bot does NOT attempt movement during initialBuild phase
- [ ] Bot combines movement and track building in the same turn
- [ ] Human can see bot's train sprite at correct map position
- [ ] Position updates arrive via `state:patch` (visible in debug overlay socket log)
- [ ] All 4 position columns are set in database (verify via debug overlay)

---

## Section 6: Bot Picks Up and Delivers Loads — Completing the Game Loop

### Goal
The bot can pick up loads at supply cities and deliver them at demand cities for payment. This completes the core gameplay loop: build track → move to supply city → pick up load → move to demand city → deliver load → earn money → draw new card. The bot can now play a meaningful (if simple) game of EuroRails.

### Depends On
Section 5 (bot can move along track).

### Human Validation
1. Start a game with 1 human + 1 bot
2. Play through initial build and into active phase
3. Watch the bot over 10-15 turns — it should:
   - Build track toward cities on its demand cards
   - Move its train to supply cities and pick up loads
   - Move to demand cities and deliver loads for payment
   - Bot's money increases noticeably after deliveries
   - Bot draws replacement demand cards after deliveries
4. Debug overlay shows: load pickups ("Bot picked up Wine at Bordeaux"), deliveries ("Bot delivered Wine to Vienna for $48M"), demand card changes
5. The bot's loads appear in the debug overlay player table
6. The human can race the bot for loads — if the bot picks up all available copies of a load type, the human can't pick it up (and vice versa)

### Technical Context

**How humans pick up loads:**
- ⚠️ **`PlayerService.pickupLoadForUser()` does not exist.** The actual pickup path is: `POST /api/loads/pickup` → `loadRoutes.ts` handler → `LoadService.pickupDroppedLoad(city, loadType, gameId)` (`loadService.ts:77`)
- Load availability is checked via `LoadService.isLoadAvailableAtCity(city, loadType, gameId)`
- Global load limit: each load type has 3-4 copies total in the game. If all are on trains, no more can be picked up.

**How humans deliver loads:**
- `PlayerService.deliverLoadForUser(gameId, userId, city, loadType, cardId)` — validates card in hand, load on train, player at demand city
- Calculates payment with debt repayment: `repayment = min(payment, debt_owed)`, `netPayment = payment - repayment`
- Removes load from train, replaces demand card (discard + draw from `DemandDeckService`)
- Updates money, hand, loads, debt_owed

**Demand cards:**
- Each player holds exactly 3 demand cards (the `hand` column is `INTEGER[]` of card IDs)
- Each card has 3 demands: `{ city, loadType, payment }`
- Only ONE demand per card can be fulfilled
- After fulfillment, the card is discarded and a replacement is drawn from `DemandDeckService`
- `DemandDeckService` is an in-memory singleton — it manages the deck per game

**Load availability:**
- Source cities supply specific load types (defined in game configuration / gridPoints data)
- `LoadService.isLoadAvailableAtCity(city, loadType, gameId)` checks both static sources and dropped loads
- Dropped loads are in the `load_chips` table with `is_dropped = true` and a city name

### Requirements

1. **Server: WorldSnapshot** (`src/server/services/ai/WorldSnapshot.ts`):
   - Capture a read-only snapshot of all game state needed for AI decision-making
   - Contains: bot position, track network, cash, demand cards (all 3 cards with all 9 demands), carried loads, train type, all other players' positions and loads, global load availability, map topology, major city connection status
   - Immutable — the AI pipeline reads from the snapshot, never from live state
   - This prevents race conditions where state changes during AI computation

2. **Server: Option generation — pickup and delivery**:
   - Scan all 9 demands across the bot's 3 cards
   - For each demand: check if the load type is available at its source city, check if the source city is reachable on existing track, check if the demand city is reachable
   - Generate `PickupLoad` options (move to source, pick up) and `DeliverLoad` options (if already carrying the right load and at/near the demand city)
   - Check train capacity before generating pickup options
   - Check global load availability before generating pickup options

3. **Server: Execution — pickup and delivery**:
   - Call `LoadService.pickupDroppedLoad(city, loadType, gameId)` for pickups (`loadService.ts:77`) — same function the human route handler uses
   - Call `PlayerService.deliverLoadForUser()` for deliveries — same function humans use
   - These functions handle all validation, state mutation, and debt repayment
   - After delivery, the bot's hand changes (new card drawn). Update the world snapshot if planning further actions this turn.

4. **Server: Simple Opportunist strategy**:
   - Evaluate all 9 demands by immediate income potential
   - If carrying a load that matches a reachable demand city: deliver it (highest priority)
   - If at a city with a pickupable load matching a demand: pick it up
   - If neither: move toward the nearest supply city for the highest-paying reachable demand
   - Build track toward unreachable supply/demand cities
   - This is the Opportunist archetype at Medium skill — reactive, chases the best available payout

5. **Server: Turn action sequencing**:
   - A complete bot turn in active phase: move → pick up loads along the way → deliver if at demand city → build track → end turn
   - Movement may involve multiple stops (pass through a supply city, pick up, continue to demand city, deliver)
   - Track building happens after movement
   - The bot must check feasibility at each step (e.g., after picking up a load, check capacity before trying to pick up another)

6. **Client: Debug overlay — load and delivery data**:
   - Show loads carried in the player table
   - When bot picks up: "Bot picked up {loadType} at {city}"
   - When bot delivers: "Bot delivered {loadType} to {city} for ${payment}M (card replaced)"
   - Show the bot's current demand card targets (anonymized card IDs with demand summaries)

### Warnings

- **Only ONE demand per card can be fulfilled.** A common mistake is attempting to fulfill multiple demands from the same card. After delivering a load that matches one demand on a card, that card is discarded and replaced. The other 2 demands on that card are gone.
- **Load availability is global.** If all 3 copies of Wine are on players' trains, no one can pick up more Wine. The bot must check availability before planning a pickup.
- **Don't pick up loads during `initialBuild`.** The server blocks this. Only generate pickup/delivery options when `game.status === 'active'`.
- **Debt repayment is automatic.** If the bot has debt and makes a delivery, part of the payment goes to debt repayment. Don't double-deduct.

### Acceptance Criteria

- [ ] Bot picks up loads at supply cities (visible in debug overlay)
- [ ] Bot delivers loads at demand cities and receives payment (money increases)
- [ ] Bot's demand cards change after delivery (new card drawn)
- [ ] Bot respects train capacity (doesn't pick up more loads than capacity allows)
- [ ] Bot respects global load availability (doesn't pick up unavailable loads)
- [ ] Only one demand per card is fulfilled
- [ ] Bot plays meaningfully over 20+ turns: builds, moves, picks up, delivers, earns money
- [ ] Debug overlay shows complete turn narrative: what the bot did and why
- [ ] The human player can race the bot for scarce loads
- [ ] Bot's money increases over time from deliveries (not building for free)
- [ ] Human-only games unaffected — zero regressions

---

## Section 7: Strategy Inspector — Full Debug and Decision Transparency

### Goal
Upgrade the debug overlay into a comprehensive Strategy Inspector that shows complete AI decision-making transparency: all options considered, scores, rejection reasons, and the selected plan. This is the primary tool for tuning bot behavior in later sections.

### Depends On
Section 6 (bot makes meaningful decisions to inspect).

### Human Validation
1. Start a game with 1 human + 1 bot
2. Press backtick (`) to open the debug overlay
3. After the bot completes a turn, the Bot Turn section now shows:
   - **Selected Plan**: What the bot chose to do and why, in plain English
   - **All Options Considered**: A ranked table of every feasible option with scores
   - **Rejected Options**: A collapsible section showing options that failed feasibility checks, with specific reasons
   - **Scoring Breakdown**: For the selected option, show each scoring dimension and its contribution
   - **Turn Timeline**: A step-by-step execution log (moved to X, picked up Y, built Z)
4. Historical turns: toggle between "Latest Turn" and previous turns (last 10 turns stored)
5. All data updates automatically when the bot completes a turn

### Requirements

1. **Server: Complete StrategyAudit data**:
   - Each bot turn produces a `StrategyAudit` object containing:
     - `snapshotSummary`: key snapshot data (position, money, loads, demands)
     - `feasibleOptions[]`: each with type, parameters, score, scoring breakdown by dimension
     - `infeasibleOptions[]`: each with type, parameters, rejection reason
     - `selectedPlan`: the chosen option with rationale
     - `executionResults[]`: step-by-step execution (action, result, duration)
     - `durationMs`: total turn time
   - Store in `bot_turn_audits` table and emit in `bot:turn-complete` socket event

2. **Client: Enhanced debug overlay — Strategy Inspector**:
   - **Selected Plan panel**: Plain-English description: "Delivered Wine to Vienna for $48M. Chose this because it was the highest-scoring option (score: 87)."
   - **Options table**: Sortable/ranked table with columns: Rank, Type, Description, Score, Status (✅ selected, feasible, ❌ rejected)
   - **Rejected options**: Collapsible section, each with specific rejection reason: "Steel pickup at Birmingham — REJECTED: All 3 Steel loads on other trains"
   - **Scoring breakdown**: For the selected option, show each dimension (immediate income, income per milepost, network expansion, etc.) with weight × value = contribution
   - **Turn timeline**: Chronological list of execution steps with timing
   - **History navigation**: Arrow buttons to view previous turns (last 10 stored per bot)

3. **Client: Multi-bot support in overlay**:
   - If multiple bots exist, show tabs or a selector for each bot
   - Each bot's data is independent

### Acceptance Criteria

- [ ] Strategy Inspector shows complete decision data for each bot turn
- [ ] All feasible options listed with scores in ranked order
- [ ] Rejected options listed with specific reasons
- [ ] Scoring breakdown shows dimension-level detail for selected option
- [ ] Turn timeline shows step-by-step execution
- [ ] Can navigate between last 10 turns per bot
- [ ] Multi-bot games show data for each bot independently
- [ ] Data updates automatically when bot completes a turn

---

## Section 8: Victory Condition — Bot Can Win (or Lose) the Game

### Goal
The bot tracks its progress toward the victory condition ($250M cash + track connecting all-but-one major cities) and can declare victory when conditions are met. The game can reach a proper conclusion with a bot winner.

### Depends On
Section 6 (bot can earn money through deliveries).

### Human Validation
1. Play a long game (or modify bot's starting money for faster testing) until the bot approaches $250M
2. The bot connects its track to major cities as a secondary goal
3. When both conditions are met (≥$250M and ≥7 of 8 major cities connected), the bot declares victory
4. `victory:triggered` event fires — human sees "Bot has declared victory!"
5. Equal turns play out — human gets their final turn(s)
6. Game ends with `game:over` — winner is displayed
7. Verify in debug overlay: bot's major city count, money, victory progress

### Requirements

1. **Server: Major city connectivity tracking**:
   - Count how many major cities are connected in the bot's track network using BFS/DFS traversal
   - A city is "connected" if there is a continuous path of the bot's own track segments from that city to any other connected city
   - This must use graph traversal on the bot's track segments, not just checking if a major city appears in any segment

2. **Server: Victory condition check**:
   - After each bot turn, check: `money >= victoryThreshold` AND `connectedMajorCities >= totalMajorCities - 1`
   - If met: call `VictoryService.declareVictory(gameId, botPlayerId, connectedCities)`
   - The existing victory flow handles equal turns and tie-breaking

3. **Server: Victory-aware turn strategy**:
   - When the bot is close to victory (e.g., needs 1-2 more major cities or $20-50M more), prioritize actions that advance toward victory
   - Build toward unconnected major cities even if no demand justifies it
   - Deliver highest-value loads to cross the money threshold

4. **Client: Debug overlay — victory progress**:
   - Show in player table: major cities connected (X of Y)
   - Show victory progress bar or indicator
   - Flag when bot is close to victory conditions

### Acceptance Criteria

- [ ] Bot tracks major city connectivity correctly
- [ ] Bot declares victory when conditions are met
- [ ] Victory flow works correctly (equal turns, tie-breaking)
- [ ] Debug overlay shows major city count and victory progress
- [ ] Game reaches proper conclusion (game:over event, winner displayed)
- [ ] Bot prioritizes victory when close to winning

---

## Section 9: Robust Error Handling and Turn Recovery

### Goal
Make the bot turn pipeline bulletproof. Any failure during a bot turn results in graceful recovery (retry or safe fallback), never a game freeze. All failures are visible in the debug overlay.

### Depends On
Section 6 (bot executes real game actions that can fail).

### Human Validation
1. Play extended games (50+ bot turns) and verify zero freezes
2. Intentionally create edge cases: bot tries to pick up unavailable loads, build beyond $20M limit, move to unreachable cities
3. Debug overlay shows any retries or fallbacks clearly: "Retry 1/3: PickupSteel failed (unavailable), trying next option"
4. Even if all options fail, the bot passes its turn and the game continues

### Requirements

1. **Server: Retry pipeline**:
   - If an action fails during execution, catch the error
   - Remove the failed option from the candidate list
   - Re-select from remaining feasible options (up to 3 retries)
   - If all retries exhausted: execute safe fallback (build cheapest track segment if possible, otherwise PassTurn)
   - All failures logged with context

2. **Server: Pre-execution validation**:
   - Before each action in a turn plan, re-validate that it's still feasible
   - An earlier action in the same turn may have changed state (e.g., picking up a load reduces capacity)
   - If pre-execution check fails, skip that action and continue with remaining actions

3. **Server: State integrity check**:
   - After each bot turn, compare expected state changes vs actual DB state
   - Log discrepancies as warnings in the debug overlay
   - Expected: money changed by delivery_payment - build_cost - fees, loads changed by pickups - deliveries

4. **Server: Turn timeout**:
   - Bot turns must complete within 30 seconds
   - If timeout: force PassTurn, log timeout context
   - Emit `bot:turn-complete` with timeout flag

5. **Client: Debug overlay — error and recovery display**:
   - Show retries: "Attempt 1/3 failed: {reason}. Retrying with next option."
   - Show fallbacks: "All options exhausted. Falling back to PassTurn."
   - Show integrity checks: "State integrity OK" or "WARNING: Expected money $85M, actual $83M"
   - Color-code: green for success, yellow for retry, red for fallback

### Acceptance Criteria

- [ ] 50+ consecutive bot turns with zero game freezes
- [ ] Failed actions trigger retry (visible in debug overlay)
- [ ] All retries exhausted → safe fallback → turn completes
- [ ] Turn timeout (30s) forces PassTurn
- [ ] State integrity checks pass on normal turns
- [ ] Debug overlay clearly shows any errors and recovery steps
- [ ] No `[BOT:ERROR]` that results in a stuck game

---

## Section 10: Archetype and Skill System

### Goal
Add the full archetype and skill level system. The Opportunist at Medium (already implemented) becomes one of 15 combinations (5 archetypes × 3 skill levels). Each archetype produces visibly different play patterns.

### Depends On
Section 7 (Strategy Inspector for observing archetype differences), Section 9 (robust error handling).

### Human Validation
1. Play 5 games, each with a different Hard-level archetype bot
2. Observe in the Strategy Inspector that each archetype makes different choices given similar cards:
   - **Backbone Builder**: Builds a central trunk line before branching; avoids isolated routes
   - **Freight Optimizer**: Combines multiple loads into efficient multi-stop trips
   - **Trunk Sprinter**: Upgrades train early; builds direct routes even through expensive terrain
   - **Continental Connector**: Prioritizes connecting major cities over maximum income
   - **Opportunist**: Chases highest immediate payout; pivots frequently
3. Play games with Easy vs Hard bots — Easy bots should make noticeably worse decisions (random suboptimality, shorter planning horizon)

### Requirements

1. **Server: ArchetypeProfile configuration**:
   - Define scoring multiplier tables for each archetype (per PRD Section 5.4.1.1)
   - Each archetype adjusts the weight of scoring dimensions (immediate income, network expansion, victory progress, etc.)
   - Archetype-specific bonus dimensions: Upgrade ROI (Trunk Sprinter), Backbone alignment (Backbone Builder), Load combination score (Freight Optimizer), Major city proximity (Continental Connector)

2. **Server: SkillProfile configuration**:
   - Easy: 20% random choices, misses 30% of best options, current-turn-only planning
   - Medium: 5% random choices, misses 10%, 2-3 turn planning horizon
   - Hard: 0% random, 0% misses, 5+ turn planning, opponent awareness

3. **Server: Scorer module**:
   - Score = Σ(base_weight × skill_modifier × archetype_multiplier × dimension_value)
   - Each feasible option scored across all dimensions
   - Highest score wins (subject to skill-level randomization)

4. **Server: Multi-turn planning (Medium and Hard)**:
   - Medium: evaluate whether current action sets up a delivery in 2-3 turns
   - Hard: evaluate all 9 demands holistically, compute optimal multi-stop routes

5. **Update Strategy Inspector**:
   - Show archetype name and philosophy in the Strategy Inspector
   - Show archetype multipliers applied to scores
   - Show skill-level effects (randomization applied, suboptimality percentage)

### Acceptance Criteria

- [ ] All 5 archetypes produce visibly different play patterns (observable in Strategy Inspector)
- [ ] Easy bots play noticeably worse than Hard bots
- [ ] Each archetype's scores reflect its multipliers (visible in scoring breakdown)
- [ ] Backbone Builder builds trunk lines; Freight Optimizer combines loads; Trunk Sprinter upgrades early; Continental Connector reaches major cities; Opportunist chases highest payouts
- [ ] All 15 combinations (5×3) are functional and don't crash
- [ ] Skill-level randomization visible in Strategy Inspector (Easy shows "random selection" notes)

---

## Section 11: Turn Animations and UX Polish

### Goal
Bot turns feel natural and readable. Instead of instant state changes, bot actions animate on the map so the human can follow what happened.

### Depends On
Section 6 (bot performs multiple action types to animate).

### Human Validation
1. Watch a bot's turn — see the thinking animation, then track building animation, then train movement
2. The pacing feels natural (not instant, not too slow)
3. "Fast Bot Turns" setting skips animations
4. The human can still open the debug overlay during bot turns

### Requirements

1. **Client: Bot turn visual feedback**:
   - On `bot:turn-start`: bot's name in leaderboard pulses, "thinking" indicator appears (1-2 seconds)
   - Track segments animate drawing in bot's color (same crayon animation as human track building)
   - Train sprite animates movement along the path (same animation as human movement)
   - On `bot:turn-complete`: pulsing stops, brief pause before next turn
   - Toast notifications: "Bot is thinking..." → "Bot finished their turn"

2. **Server: Per-action events**:
   - Emit `bot:action` events for each action in the turn plan: `{ type: 'buildTrack' | 'moveTrain' | 'pickupLoad' | 'deliverLoad', details }`
   - Client uses these to sequence animations (build first, then move, then pickup/deliver)
   - Each action has a delay between it (500ms-1000ms) for readability

3. **Client: Fast mode**:
   - Toggle in game settings: "Fast Bot Turns"
   - When enabled: skip all animations and delays, bot turns complete instantly
   - Debug overlay still shows all data regardless of fast mode

### Acceptance Criteria

- [ ] Bot turns have visible thinking indicator, track animation, movement animation
- [ ] Pacing feels natural (2-4 seconds for a typical turn with animations)
- [ ] Fast mode skips all animations
- [ ] Human can interact with debug overlay during bot turns
- [ ] Toast notifications appear for bot turn start/end

---

## Section 12: Train Upgrades and Advanced Actions

### Goal
The bot can upgrade its train (Freight → Fast Freight / Heavy Freight → Super Freight) when strategically beneficial, and handle edge cases like crossgrades, ferry crossings, and the discard-hand action.

### Depends On
Section 6 (bot has the core gameplay loop working).

### Human Validation
1. Watch a bot over a long game — at some point it upgrades its train
2. After upgrading to Fast Freight (speed 12), the bot moves farther per turn
3. The upgrade decision is visible in the Strategy Inspector (scored against alternatives)
4. The bot correctly handles the mutually exclusive constraint: can't build track and upgrade in the same turn

### Requirements

1. **Server: Upgrade option generation and execution**:
   - Generate `UpgradeTrain` options with valid transitions (Freight→Fast/Heavy, Fast/Heavy→Super)
   - Check: sufficient money, no track building this turn (for upgrades; crossgrades allow up to $15M building)
   - Execute via `PlayerService.purchaseTrainType()` — the same function humans use
   - Score upgrades using the Trunk Sprinter's high `Upgrade ROI` multiplier (for that archetype) or lower for others

2. **Server: Discard hand action**:
   - When the bot's demand cards are all terrible (no good deliveries possible), generate a `DiscardHand` option
   - Execute via `PlayerService.discardHandForUser()` — draws 3 new cards
   - Score low (last resort before PassTurn)

3. **Server: Ferry handling**:
   - Detect when movement path crosses a ferry
   - Handle ferry movement rules: lose remainder of movement, start next turn at half speed on the other side
   - Track ferry state in the bot's turn context

### Acceptance Criteria

- [ ] Bot upgrades train when strategically beneficial
- [ ] Upgrade follows valid transition paths
- [ ] Can't upgrade and build track in same turn (except crossgrade + ≤$15M build)
- [ ] Bot discards hand when cards are poor
- [ ] Ferry crossings handled correctly (if applicable to bot's routes)
- [ ] All actions use shared player service functions

---

## Section Overview — Delivery Order

| Section | What It Delivers | Key Validation |
|---------|-----------------|----------------|
| **1** | Bot identity in lobby and database | Bot appears in lobby, game starts normally |
| **2** | Debug overlay (backtick key) | Real-time game state visible |
| **3** | Bot passes turn correctly | Turns advance, no freezing, works with 1-5 bots |
| **4** | Bot builds track | Track appears on map in bot's color |
| **5** | Bot places train and moves | Train sprite visible and moves |
| **6** | Bot picks up and delivers loads | Complete gameplay loop, money earned |
| **7** | Strategy Inspector | Full decision transparency |
| **8** | Victory condition | Game can end with bot winner |
| **9** | Error handling and recovery | 50+ turns without freezes |
| **10** | Archetypes and skill levels | 15 distinct bot personalities |
| **11** | Turn animations and UX | Smooth, readable bot turns |
| **12** | Train upgrades and advanced actions | Complete action set |

**Sections 1-6 are the critical path.** After Section 6, you have a bot that can play a meaningful game of EuroRails. Sections 7-12 add polish, robustness, and variety. The order of 7-12 is flexible — they can be reordered based on priorities.
