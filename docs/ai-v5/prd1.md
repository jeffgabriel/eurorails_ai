# Section 1: Bot Player Identity — Lobby, Database, and Game Start

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

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

## Related User Journeys

### Journey 1: Pre-Game — Lobby → Game Start

**Setup:** 1 human player ("Alice"), 1 bot ("Heinrich" — Easy difficulty, backbone_builder archetype)

**Alice creates a lobby:**
1. Alice clicks "Create Game" → `POST /api/lobby/games` creates a game with `status: 'setup'`
2. Alice sees the lobby page with her name, color, and an "Add Bot" button
3. Alice clicks "Add Bot" → `BotConfigPopover` opens with skill level (Easy/Medium/Hard), archetype selector (random default), and optional name
4. Alice picks Easy difficulty with Random archetype, clicks Add
5. Server: `LobbyService.addBot()` *(⚠️ to be created)* resolves `'random'` to a concrete archetype (e.g., `backbone_builder`), creates a synthetic `users` row (`password_hash='BOT_NO_LOGIN'`, `email='bot-{uuid}@bot.internal'`), creates a `players` row with `is_bot=true`, `bot_config={skillLevel:'easy', archetype:'backbone_builder', botName:'Heinrich'}`
6. Socket: `lobby-updated` event fires → Alice sees "Heinrich (Bot)" appear in the player list with a brain icon and archetype color badge

**Alice clicks "Start Game":**
1. Client: `POST /api/lobby/games/{id}/start`
2. Server: `LobbyService.startGame()` → validates Alice is the creator, game is in `'setup'` status, and has 2+ players
3. Server: `InitialBuildService.initPhase()` *(⚠️ to be created — currently `LobbyService.startGame()` at `lobbyService.ts:581` sets status directly to `'active'`, skipping the initial build phase)*:
   - Queries players ordered by `created_at ASC` → `[Alice, Heinrich]`
   - Updates: `status='initialBuild'`, `initial_build_round=1`, `initial_build_order=[Alice.id, Heinrich.id]`, `current_player_index=0`
4. Socket: `game-started` event emitted to `lobby-{gameId}` room
5. Client: Both the button click handler and the socket listener trigger navigation to `/game/{gameId}`
6. Client: `SetupScene` loads → fetches `GET /api/game/{gameId}` → sees `status='initialBuild'` → starts `GameScene` with full game state

**What Alice sees on screen:**
- The EuroRails map fills the screen (hex grid of mileposts, major cities labeled)
- Upper-right leaderboard shows: "Alice" (highlighted, green "Next Player" button) and "Heinrich 🧠" (brain icon for bot)
- Bottom: PlayerHandScene shows Alice's 3 demand cards face-up, her Freight train card, and ECU 50M cash
- No track exists anywhere. No trains are placed on the map.
- **The game is in `initialBuild` phase — players can ONLY build track (no movement, no deliveries)**

### Journey 1: Turn 1 — Alice's First Initial Build Turn (Round 1)

```
[GAME START → TURN 1: Alice (Human)]
Server: status='initialBuild', initial_build_round=1, current_player_index=0
Client: handleTurnChange(0) → "It's your turn!" notification (4000ms)
UI: Green "Next Player" button is interactive. Leaderboard highlights Alice.
```

**What Alice can do:**
- She has 3 demand cards (e.g., Deliver Oil to Berlin for 12M, Deliver Wine to Paris for 8M, Deliver Coal to London for 10M)
- She examines her cards and decides to build toward Hamburg (a major city near Oil sources)
- She clicks the **crayon button** (🖍️) on her PlayerHandScene to enter drawing mode

**Track building interaction:**
1. Alice clicks on Hamburg (a major city milepost) — this becomes her starting point. Per rules, first track must start from a major city.
2. She hovers toward an adjacent milepost — a **green preview line** appears showing the path, with cost updating in real-time in the PlayerHandScene: "Build Cost: 1M"
3. She clicks to place the segment. A line draws in her color from Hamburg to the adjacent clear milepost. Cost: 1M.
4. She continues clicking adjacent mileposts, building southward. Each click adds a segment. The cost display updates: "Build Cost: 5M", "Build Cost: 8M"...
5. She approaches a mountain milepost — the preview shows cost 2M for that segment. She clicks through.
6. She reaches 18M spent. One more clear milepost would be 19M. She clicks it. "Build Cost: 19M"
7. She has 1M left in her 20M turn budget. She could build one more clear terrain segment, but decides to stop.
8. She clicks the crayon button again to exit drawing mode → `TrackDrawingManager.saveCurrentTracks()` fires:
   - `POST /api/tracks/save` with payload: `{ gameId, playerId, trackState: { segments: [...], totalCost: 19, turnBuildCost: 19 } }`
   - Server: `TrackService.saveTrackState()` upserts into `player_tracks`
   - Socket: `track:updated` emitted to game room (Heinrich's client would see it if connected, but bots don't have a client)

**Alice ends her turn:**
9. Alice clicks the green **"Next Player"** button in the leaderboard
10. Client: `GameScene.nextPlayerTurn()`:
    - Exits drawing mode if still active
    - Deducts build cost from money: `50M - 19M = 31M` → `POST /api/players/updatePlayerMoney`
    - Calls `trackManager.endTurnCleanup(playerId)` → resets `turnBuildCost = 0`
    - Increments turn number
    - Calls `gameStateService.nextPlayerTurn()` → `POST /api/players/updateCurrentPlayer` with `currentPlayerIndex: 1`
11. Server: `PlayerService.updateCurrentPlayerIndex(gameId, 1)`:
    - Updates `games.current_player_index = 1`
    - Calls `emitTurnChange(gameId, 1, Heinrich.id)`

```
[TURN 1 → TURN 2: Alice → Heinrich (Bot)]
Server: current_player_index changes from 0 to 1
Socket: turn:change({ currentPlayerIndex: 1, currentPlayerId: Heinrich.id }) emitted
Client: handleTurnChange(1) → leaderboard updates to highlight Heinrich
BotTurnTrigger: onTurnChange() → player at index 1 is a bot → schedule execution
```

### Journey 2: Pre-Game with Multiple Bots

**Setup:** 1 human player ("Alice"), 3 bots ("Heinrich", "Marie", "Paolo")

Same as Journey 1, except `InitialBuildService.initPhase()` *(⚠️ to be created)* creates order: `[Alice, Heinrich, Marie, Paolo]`.

**Round 1:** Alice builds → Heinrich builds → Marie builds → Paolo builds
**Round 2:** Paolo builds → Marie builds → Heinrich builds → Alice builds
**Transition to active phase**
