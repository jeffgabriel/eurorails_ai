# Section 3: Bot Turn Skeleton — Pass Turn Correctly

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

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

## Related User Journeys

### Journey 1: Turn 2 — Heinrich's First Initial Build Turn (Round 1)

**What Alice sees:**
1. The leaderboard now highlights "Heinrich 🧠". The "Next Player" button grays out and reads "Wait Your Turn"
2. After ~1500ms delay (`BOT_TURN_DELAY_MS`), server emits `bot:turn-start`:
   - Alice sees: brain icon (🧠) next to Heinrich's name starts **pulsing** (alpha fading 1.0→0.3, 600ms cycle)
   - Toast notification appears top-right: **"Heinrich is thinking..."** (2000ms)
3. **On the server**, `AIStrategyEngine.takeTurn()` executes:
   - `WorldSnapshotService` captures game state → Heinrich has no track, no position
   - `AIStrategyEngine` detects Heinrich has no position → auto-places at best major city for his demand cards
   - `OptionGenerator.generate()` → sees `gamePhase: 'initialBuild'` → only generates `BuildTrack`, `BuildTowardMajorCity`, and `PassTurn` options
   - `Scorer` evaluates options by `backbone_builder` archetype weights
   - `PlanValidator` validates the chosen plan
   - `TurnExecutor` builds track segments via `TrackService.saveTrackState()`
4. Server emits `track:updated` → Alice's client calls `loadExistingTracks()` → **Heinrich's track segments appear on the map in Heinrich's color**
5. Server emits `bot:turn-complete`:
   - Brain icon stops pulsing
   - Toast: **"Heinrich finished their turn."** (1500ms)
6. `BotTurnTrigger.advanceTurnAfterBot()`:
   - Checks `game.status === 'initialBuild'` → calls `InitialBuildService.advanceTurn(gameId)`
   - Round 1, index 1 = last player → **transition to Round 2**
   - Round 2 order = reversed: `[Heinrich.id, Alice.id]`
   - Updates: `initial_build_round=2`, `initial_build_order=[Heinrich.id, Alice.id]`, `current_player_index=0`
   - Emits `turn:change(gameId, 0, Heinrich.id)` — Heinrich goes first in Round 2

**What could go wrong here (and what the design prevents):**
- **Phase-unaware option generation:** Heinrich might try to UpgradeTrain or move during initialBuild → server rejects → retry exhaustion → PassTurn (wastes the build turn). **Prevention:** OptionGenerator only generates BuildTrack/BuildTowardMajorCity/PassTurn during initialBuild.
- **Empty track network:** Heinrich has no track, Dijkstra has no seed nodes → empty build options → PassTurn forever. **Prevention:** When track network is empty, seed Dijkstra from the bot's position (a major city).
- **Incomplete position writes:** Heinrich gets placed but only `position_row/col` set, not `position_x/y` → `PlayerService.getPlayers()` sees `position_x === null` → position is `undefined`. **Prevention:** Always set all 4 position columns together.
- **Wrong turn advancement method:** `advanceTurnAfterBot` uses `PlayerService.updateCurrentPlayerIndex()` instead of `InitialBuildService.advanceTurn()` → Round 2 never starts → game stuck. **Prevention:** Check `game.status` and use phase-appropriate advancement method.

### Journey 1: Turns 3-4 — Round 2 and Transition to Active Phase

**Turn 3: Heinrich's Second Initial Build Turn (Round 2)**

```
[TURN 2 → TURN 3: Heinrich (Bot) — Round 2 starts]
Server: initial_build_round=2, current_player_index=0, order=[Heinrich, Alice]
Socket: turn:change(0, Heinrich.id) emitted
BotTurnTrigger: onTurnChange() → Heinrich is a bot → schedule after 1500ms
```

**What Alice sees:**
- The "Wait Your Turn" button stays grayed out
- Heinrich's brain icon starts pulsing again
- Toast: "Heinrich is thinking..." → Heinrich builds more track (extending his network)
- Track segments appear on Alice's map in Heinrich's color
- Toast: "Heinrich finished their turn."
- `InitialBuildService.advanceTurn()`: Round 2, index 0 → advance to index 1 → Alice's turn

**Turn 4: Alice's Second Initial Build Turn (Round 2)**

After Alice clicks "Next Player":
- `GameScene.nextPlayerTurn()` → `gameStateService.nextPlayerTurn()`
- Server: `InitialBuildService.advanceTurn()` detects Round 2 is complete (Alice was last in round 2 order)
- **Transition to active phase:**
  - `status = 'active'`, `initial_build_round = 0`, `initial_build_order = NULL`
  - `current_player_index` = index of last player in round 2 order (Alice, who just went)
- Emits `turn:change` + `state:patch` with `status: 'active'`

```
[INITIAL BUILD COMPLETE → ACTIVE PHASE]
Server: status changes from 'initialBuild' to 'active'
Socket: state:patch({ status: 'active', currentPlayerIndex }) + turn:change
Client: gameState.status = 'active' — movement/delivery UI now available
```

### Journey 2: Multiple Bots — The Rapid-Fire Turn Problem

**Setup:** 1 human player ("Alice"), 3 bots ("Heinrich", "Marie", "Paolo")

During initial build, each bot turn has a 1500ms delay before execution. Between bot turns, `InitialBuildService.advanceTurn()` fires, which emits `turn:change`, which triggers `BotTurnTrigger.onTurnChange()` for the next bot. So the sequence is:

```
Alice clicks "Next Player" (Round 1)
  → turn:change(1, Heinrich) [0ms]
  → BotTurnTrigger: 1500ms delay
  → Heinrich executes (~1-2s)
  → InitialBuildService.advanceTurn()
  → turn:change(2, Marie) [~3s total]
  → BotTurnTrigger: 1500ms delay
  → Marie executes (~1-2s)
  → InitialBuildService.advanceTurn()
  → turn:change(3, Paolo) [~6s total]
  → BotTurnTrigger: 1500ms delay
  → Paolo executes (~1-2s)
  → InitialBuildService.advanceTurn() → Round 2 starts
  → turn:change(0, Paolo) [~9s total, Round 2]
  → ... 3 more bot turns ...
  → turn:change(3, Alice) [~18s total]
```

**What Alice sees during this ~18-second sequence:**
1. "Wait Your Turn" button stays grayed
2. Bot 1 brain pulses → "Heinrich is thinking..." → track appears → "Heinrich finished their turn."
3. ~1.5s pause
4. Bot 2 brain pulses → "Marie is thinking..." → track appears → "Marie finished their turn."
5. ~1.5s pause
6. Bot 3 brain pulses → "Paolo is thinking..." → track appears → "Paolo finished their turn."
7. Round 2 starts, same 3 bots again (reversed order)
8. Finally: "It's your turn!" (4000ms notification)

**What prevents double-execution:**
- `BotTurnTrigger.onTurnChange()` checks `pendingBotTurns.has(gameId)` — if a bot turn is already executing for this game, the call returns immediately
- `emitTurnChange()` is called ONCE per turn advancement (from `InitialBuildService.advanceTurn()` or `PlayerService.updateCurrentPlayerIndex()`)
- The route handler does NOT emit a redundant `turn:change` — only the service method emits it

### Journey 2: Active Phase — Sequential Bot Execution

```
Alice clicks "Next Player"
  └─ Server: updateCurrentPlayerIndex(gameId, 1)
     └─ emitTurnChange(gameId, 1, Heinrich.id)
```

**Sequential execution chain:**

```
[TURN 5 → 6: Alice → Heinrich]  t=0s
  Socket: turn:change(1, Heinrich.id)
  Client: handleTurnChange(1) — leaderboard updates
  BotTurnTrigger: pendingBotTurns.add(gameId), setTimeout(1500ms)

[t=1.5s] Heinrich starts executing
  Server: bot:turn-start → Client: brain pulse, "Heinrich is thinking..."
  AIStrategyEngine.takeTurn() runs (~1-2s)
  Server: state:patch (money, position, loads change)
  Server: track:updated (if track built)
  Server: bot:turn-complete → Client: "Heinrich finished their turn."

[TURN 6 → 7: Heinrich → Marie]  t≈3.5s
  advanceTurnAfterBot: updateCurrentPlayerIndex(gameId, 2)
  emitTurnChange(gameId, 2, Marie.id)
  pendingBotTurns.delete(gameId) [from .finally()]
  BotTurnTrigger.onTurnChange(): pendingBotTurns.add(gameId), setTimeout(1500ms)

[t≈5s] Marie starts executing
  Server: bot:turn-start → Client: brain pulse, "Marie is thinking..."
  ... same pattern ...

[TURN 7 → 8: Marie → Paolo]  t≈7s
  ... same pattern ...

[TURN 8 → 9: Paolo → Alice]  t≈10.5s
  advanceTurnAfterBot: updateCurrentPlayerIndex(gameId, 0)
  emitTurnChange(gameId, 0, Alice.id)
  BotTurnTrigger.onTurnChange(): player at index 0 is NOT a bot → return

  Client: handleTurnChange(0) → "It's your turn!" (4000ms)
  UI: Green "Next Player" button becomes interactive
```

**Client-side state during bot turns:**
- `handleTurnChange()` fires for EACH turn:change event (indices 1, 2, 3, then 0)
- Each call runs `refreshPlayerData()` → fetches latest player state from server
- `gameState.currentPlayerIndex` updates each time
- Leaderboard re-renders with the new active player highlighted
- **Key invariant:** Alice's local position, movement history, and ferry state are preserved during refresh (client-managed state is not overwritten by server data)

**What the design prevents:**
- **Double execution:** Without the `pendingBotTurns` guard + single-emit rule, each bot could execute twice, duplicating all side effects (double track, double money deductions)
- **Wrong turn advancement:** During initialBuild, using `PlayerService.updateCurrentPlayerIndex()` instead of `InitialBuildService.advanceTurn()` would break round progression — Round 2 would never start, and the game would be stuck in initialBuild forever

### Journey 2: Later Turns — The Rhythm with 3 Bots

Each human turn is followed by ~10 seconds of bot turns. The human must wait, but:
- Visual feedback (brain pulse, toast notifications) tells them what's happening
- Track and train position updates render in real-time via socket patches
- The "It's your turn!" notification clearly signals when they can act again

**Timing breakdown per full cycle (1 human + 3 bots):**
| Phase | Duration | What Happens |
|-------|----------|-------------|
| Alice's turn | 30-120s | Human plays (variable) |
| Delay before Bot 1 | 1.5s | `BOT_TURN_DELAY_MS` |
| Bot 1 executes | 1-2s | AI pipeline + DB writes |
| Delay before Bot 2 | 1.5s | `BOT_TURN_DELAY_MS` |
| Bot 2 executes | 1-2s | AI pipeline + DB writes |
| Delay before Bot 3 | 1.5s | `BOT_TURN_DELAY_MS` |
| Bot 3 executes | 1-2s | AI pipeline + DB writes |
| **Total bot time** | **~10-12s** | 3 bot turns with pacing delays |

### Journey 4: Edge Case 2 — Game with 5 Bots (1 Human + 5 Bots)

**During initial build:**
- Round 1: Alice builds → 5 bot turns in sequence (~15s)
- Round 2: 5 bot turns in reverse → Alice builds (~15s before Alice's turn)
- Total initialBuild time: ~30s of bot turns + Alice's 2 build turns

**During active phase:**
- Each human turn cycle: ~25-30s of bot turns
- The `BOT_TURN_DELAY_MS = 1500ms` provides minimum pacing
- 5 × (1500ms delay + 1-2s execution) = ~12-17s of bot execution

**What Alice sees:**
- Rapid succession of brain pulses and thinking notifications for each bot
- Track segments appearing in 5 different colors across the map
- 5 trains moving around the map
- "It's your turn!" signals clearly when Alice can act again

### Journey 4: Edge Case 3 — Human Disconnects During Bot Turn

**Scenario:** Alice closes her browser tab while Heinrich (bot) is executing.

**Server-side:**
1. Heinrich's turn continues to completion (server-side execution, no client needed)
2. `advanceTurnAfterBot()` advances to next player
3. If next player is Alice (human), `BotTurnTrigger.onTurnChange()` calls `hasConnectedHuman(gameId)`
4. `hasConnectedHuman()` returns `false` (Alice disconnected)
5. If next player is ALSO a bot → bot executes (bots run server-side, no human needed for computation)
6. If only human players remain: `queuedBotTurns.set(gameId, { ... })` — bot turn queued

**Alice reconnects:**
1. Socket.IO reconnects automatically
2. Client sends `join` event with gameId
3. Server handler calls `BotTurnTrigger.onHumanReconnect(gameId)`
4. If a bot turn was queued: dequeues and triggers `onTurnChange()` → bot executes
5. If it's Alice's turn: she gets `state:init` with full current game state → UI rebuilds from authoritative server state
6. All track, positions, money reflect the completed bot turns
