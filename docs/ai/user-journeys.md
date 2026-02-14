# Game Session User Journeys â€” EuroRails Online with AI Bots

> Turn-by-turn walkthroughs of complete game sessions from the human player's perspective, describing **planned behavior** once the AI bot system is implemented per the [master plan](./ai-bot-v5-master-plan.md).
>
> ⚠️ **Implementation status:** The AI bot pipeline (BotTurnTrigger, AIStrategyEngine, OptionGenerator, Scorer, PlanValidator, TurnExecutor, WorldSnapshotService), `InitialBuildService`, `LobbyService.addBot()`, bot socket events (`bot:turn-start`, `bot:turn-complete`, `bot:action`), and bot-related database columns (`is_bot`, `bot_config`) **do not exist yet** on the current branch. The existing human gameplay code paths referenced here (PlayerService, TrackService, LoadService, socket events) are accurate. The actual load pickup path is `LoadService.pickupDroppedLoad()` via `POST /api/loads/pickup` (there is no `PlayerService.pickupLoadForUser()`).

---

## Table of Contents

1. [Journey 1: First Game with One Bot (~10 Turns)](#journey-1-first-game-with-one-bot)
2. [Journey 2: Multiple Bots â€” The Rapid-Fire Turn Problem](#journey-2-multiple-bots)
3. [Journey 3: Mid-Game Complexity](#journey-3-mid-game-complexity)
4. [Journey 4: Edge Cases and Failure Modes](#journey-4-edge-cases-and-failure-modes)

---

## Journey 1: First Game with One Bot

**Setup:** 1 human player ("Alice"), 1 bot ("Heinrich" â€” Easy difficulty, backbone_builder archetype)

### Pre-Game: Lobby â†’ Game Start

**Alice creates a lobby:**
1. Alice clicks "Create Game" â†’ `POST /api/lobby/games` creates a game with `status: 'setup'`
2. Alice sees the lobby page with her name, color, and an "Add Bot" button
3. Alice clicks "Add Bot" â†’ `BotConfigPopover` opens with skill level (Easy/Medium/Hard), archetype selector (random default), and optional name
4. Alice picks Easy difficulty with Random archetype, clicks Add
5. Server: `LobbyService.addBot()` *(⚠️ to be created)* resolves `'random'` to a concrete archetype (e.g., `backbone_builder`), creates a synthetic `users` row (`password_hash='BOT_NO_LOGIN'`, `email='bot-{uuid}@bot.internal'`), creates a `players` row with `is_bot=true`, `bot_config={skillLevel:'easy', archetype:'backbone_builder', botName:'Heinrich'}`6. Socket: `lobby-updated` event fires â†’ Alice sees "Heinrich (Bot)" appear in the player list with a brain icon and archetype color badge

**Alice clicks "Start Game":**
1. Client: `POST /api/lobby/games/{id}/start`
2. Server: `LobbyService.startGame()` â†’ validates Alice is the creator, game is in `'setup'` status, and has 2+ players
3. Server: `InitialBuildService.initPhase()` *(⚠️ to be created — currently `LobbyService.startGame()` at `lobbyService.ts:581` sets status directly to `'active'`, skipping the initial build phase)*:
   - Queries players ordered by `created_at ASC` â†’ `[Alice, Heinrich]`
   - Updates: `status='initialBuild'`, `initial_build_round=1`, `initial_build_order=[Alice.id, Heinrich.id]`, `current_player_index=0`
4. Socket: `game-started` event emitted to `lobby-{gameId}` room
5. Client: Both the button click handler and the socket listener trigger navigation to `/game/{gameId}`
6. Client: `SetupScene` loads â†’ fetches `GET /api/game/{gameId}` â†’ sees `status='initialBuild'` â†’ starts `GameScene` with full game state

**What Alice sees on screen:**
- The EuroRails map fills the screen (hex grid of mileposts, major cities labeled)
- Upper-right leaderboard shows: "Alice" (highlighted, green "Next Player" button) and "Heinrich ðŸ§ " (brain icon for bot)
- Bottom: PlayerHandScene shows Alice's 3 demand cards face-up, her Freight train card, and ECU 50M cash
- No track exists anywhere. No trains are placed on the map.
- **The game is in `initialBuild` phase â€” players can ONLY build track (no movement, no deliveries)**

---

### Turn 1: Alice's First Initial Build Turn (Round 1)

```
[GAME START â†’ TURN 1: Alice (Human)]
Server: status='initialBuild', initial_build_round=1, current_player_index=0
Client: handleTurnChange(0) â†’ "It's your turn!" notification (4000ms)
UI: Green "Next Player" button is interactive. Leaderboard highlights Alice.
```

**What Alice can do:**
- She has 3 demand cards (e.g., Deliver Oil to Berlin for 12M, Deliver Wine to Paris for 8M, Deliver Coal to London for 10M)
- She examines her cards and decides to build toward Hamburg (a major city near Oil sources)
- She clicks the **crayon button** (ðŸ–ï¸) on her PlayerHandScene to enter drawing mode

**Track building interaction:**
1. Alice clicks on Hamburg (a major city milepost) â€” this becomes her starting point. Per rules, first track must start from a major city.
2. She hovers toward an adjacent milepost â€” a **green preview line** appears showing the path, with cost updating in real-time in the PlayerHandScene: "Build Cost: 1M"
3. She clicks to place the segment. A line draws in her color from Hamburg to the adjacent clear milepost. Cost: 1M.
4. She continues clicking adjacent mileposts, building southward. Each click adds a segment. The cost display updates: "Build Cost: 5M", "Build Cost: 8M"...
5. She approaches a mountain milepost â€” the preview shows cost 2M for that segment. She clicks through.
6. She reaches 18M spent. One more clear milepost would be 19M. She clicks it. "Build Cost: 19M"
7. She has 1M left in her 20M turn budget. She could build one more clear terrain segment, but decides to stop.
8. She clicks the crayon button again to exit drawing mode â†’ `TrackDrawingManager.saveCurrentTracks()` fires:
   - `POST /api/tracks/save` with payload: `{ gameId, playerId, trackState: { segments: [...], totalCost: 19, turnBuildCost: 19 } }`
   - Server: `TrackService.saveTrackState()` upserts into `player_tracks`
   - Socket: `track:updated` emitted to game room (Heinrich's client would see it if connected, but bots don't have a client)

**Alice ends her turn:**
9. Alice clicks the green **"Next Player"** button in the leaderboard
10. Client: `GameScene.nextPlayerTurn()`:
    - Exits drawing mode if still active
    - Deducts build cost from money: `50M - 19M = 31M` â†’ `POST /api/players/updatePlayerMoney`
    - Calls `trackManager.endTurnCleanup(playerId)` â†’ resets `turnBuildCost = 0`
    - Increments turn number
    - Calls `gameStateService.nextPlayerTurn()` â†’ `POST /api/players/updateCurrentPlayer` with `currentPlayerIndex: 1`
11. Server: `PlayerService.updateCurrentPlayerIndex(gameId, 1)`:
    - Updates `games.current_player_index = 1`
    - Calls `emitTurnChange(gameId, 1, Heinrich.id)`

```
[TURN 1 â†’ TURN 2: Alice â†’ Heinrich (Bot)]
Server: current_player_index changes from 0 to 1
Socket: turn:change({ currentPlayerIndex: 1, currentPlayerId: Heinrich.id }) emitted
Client: handleTurnChange(1) â†’ leaderboard updates to highlight Heinrich
BotTurnTrigger: onTurnChange() â†’ player at index 1 is a bot â†’ schedule execution
```

---

### Turn 2: Heinrich's First Initial Build Turn (Round 1)

**What Alice sees:**
1. The leaderboard now highlights "Heinrich ðŸ§ ". The "Next Player" button grays out and reads "Wait Your Turn"
2. After ~1500ms delay (`BOT_TURN_DELAY_MS`), server emits `bot:turn-start`:
   - Alice sees: brain icon (ðŸ§ ) next to Heinrich's name starts **pulsing** (alpha fading 1.0â†’0.3, 600ms cycle)
   - Toast notification appears top-right: **"Heinrich is thinking..."** (2000ms)
3. **On the server**, `AIStrategyEngine.takeTurn()` executes:
   - `WorldSnapshotService` captures game state â†’ Heinrich has no track, no position
   - `AIStrategyEngine` detects Heinrich has no position â†’ auto-places at best major city for his demand cards: sets all 4 position columns (`position_row`, `position_col`, `position_x`, `position_y`)
   - `OptionGenerator.generate()` â†’ sees `gamePhase: 'initialBuild'` â†’ only generates `BuildTrack`, `BuildTowardMajorCity`, and `PassTurn` options   - Dijkstra seeds from Heinrich's position (major city) since he has no track   - `Scorer` evaluates options by `backbone_builder` archetype weights
   - `PlanValidator` validates the chosen plan
   - `TurnExecutor` builds track segments via `TrackService.saveTrackState()`
4. Server emits `track:updated` â†’ Alice's client calls `loadExistingTracks()` â†’ **Heinrich's track segments appear on the map in Heinrich's color**
5. Server emits `bot:turn-complete`:
   - Brain icon stops pulsing
   - Toast: **"Heinrich finished their turn."** (1500ms)
6. `BotTurnTrigger.advanceTurnAfterBot()`:
   - Checks `game.status === 'initialBuild'` â†’ calls `InitialBuildService.advanceTurn(gameId)`   - Round 1, index 1 = last player â†’ **transition to Round 2**
   - Round 2 order = reversed: `[Heinrich.id, Alice.id]`
   - Updates: `initial_build_round=2`, `initial_build_order=[Heinrich.id, Alice.id]`, `current_player_index=0`
   - Emits `turn:change(gameId, 0, Heinrich.id)` â€” Heinrich goes first in Round 2

**What could go wrong here (and what the design prevents):**
- **Phase-unaware option generation:** Heinrich might try to UpgradeTrain or move during initialBuild → server rejects → retry exhaustion → PassTurn (wastes the build turn). **Prevention:** OptionGenerator only generates BuildTrack/BuildTowardMajorCity/PassTurn during initialBuild.
- **Empty track network:** Heinrich has no track, Dijkstra has no seed nodes → empty build options → PassTurn forever. **Prevention:** When track network is empty, seed Dijkstra from the bot's position (a major city).
- **Incomplete position writes:** Heinrich gets placed but only `position_row/col` set, not `position_x/y` → `PlayerService.getPlayers()` sees `position_x === null` → position is `undefined`. **Prevention:** Always set all 4 position columns together.
- **Wrong turn advancement method:** `advanceTurnAfterBot` uses `PlayerService.updateCurrentPlayerIndex()` instead of `InitialBuildService.advanceTurn()` → Round 2 never starts → game stuck. **Prevention:** Check `game.status` and use phase-appropriate advancement method.

---

### Turn 3: Heinrich's Second Initial Build Turn (Round 2)

```
[TURN 2 â†’ TURN 3: Heinrich (Bot) â€” Round 2 starts]
Server: initial_build_round=2, current_player_index=0, order=[Heinrich, Alice]
Socket: turn:change(0, Heinrich.id) emitted
BotTurnTrigger: onTurnChange() â†’ Heinrich is a bot â†’ schedule after 1500ms
```

**What Alice sees:**
- The "Wait Your Turn" button stays grayed out
- Heinrich's brain icon starts pulsing again
- Toast: "Heinrich is thinking..." â†’ Heinrich builds more track (extending his network)
- Track segments appear on Alice's map in Heinrich's color
- Toast: "Heinrich finished their turn."
- `InitialBuildService.advanceTurn()`: Round 2, index 0 â†’ advance to index 1 â†’ Alice's turn

```
[TURN 3 â†’ TURN 4: Heinrich â†’ Alice â€” Round 2]
Server: current_player_index changes from 0 to 1 (Alice in round 2 order)
Socket: turn:change(1, Alice.id) emitted
Client: handleTurnChange(1) â†’ "It's your turn!" notification (4000ms, top-right)
UI: Green "Next Player" button becomes interactive again
```

---

### Turn 4: Alice's Second Initial Build Turn (Round 2)

Alice builds more track (extending from her existing network), spending up to 20M more. Same interaction as Turn 1: crayon button â†’ click segments â†’ exit drawing mode â†’ "Next Player" button.

After Alice clicks "Next Player":
- `GameScene.nextPlayerTurn()` â†’ `gameStateService.nextPlayerTurn()`
- Server: `InitialBuildService.advanceTurn()` detects Round 2 is complete (Alice was last in round 2 order)
- **Transition to active phase:**
  - `status = 'active'`, `initial_build_round = 0`, `initial_build_order = NULL`
  - `current_player_index` = index of last player in round 2 order (Alice, who just went)
  - Actually per the code: the first active player is `order[order.length - 1]` = Alice (last in reversed order)
- Emits `turn:change` + `state:patch` with `status: 'active'`

```
[INITIAL BUILD COMPLETE â†’ ACTIVE PHASE]
Server: status changes from 'initialBuild' to 'active'
Socket: state:patch({ status: 'active', currentPlayerIndex }) + turn:change
Client: gameState.status = 'active' â€” movement/delivery UI now available
```

---

### Turn 5: Alice's First Active Turn

**What changes for Alice now:**
- **Movement is unlocked.** But Alice has no train position yet â€” she hasn't placed her train.
- `handleTurnChange()` detects `player.position === null` â†’ prompts starting city selection
- Alice sees a prompt: "Select a starting city" â€” she clicks on Hamburg (where her track starts)
- Client sets her train position at Hamburg â†’ train pawn sprite appears on the map
- She now has 9 movement points (Freight train speed)

**Alice's turn options (active phase):**
1. **Move train** â€” click on connected mileposts along her track. Movement points decrease per milepost.
2. **Pick up loads** â€” if she passes through a city with available commodities, `LoadDialogScene` opens with "Available for Pickup" section
3. **Deliver loads** â€” if at a city matching a demand card, "Can be Delivered" section appears
4. **Build more track** â€” click crayon button, spend up to 20M
5. **Upgrade train** â€” via "More actions..." modal (costs 20M, can't also build track)
6. **"Next Player"** button to end turn

Alice moves her train 5 mileposts along her track toward an oil source city. She arrives, and `LoadDialogScene` appears. She clicks "Oil" in the "Available for Pickup" section â†’ oil load chip appears on her train. She has 4 movement points remaining, keeps moving. She builds a few more track segments (crayon button), spending 8M.

She clicks "Next Player" â†’ turn advances to Heinrich.

---

### Turn 6: Heinrich's First Active Turn

```
[TURN 5 â†’ TURN 6: Alice â†’ Heinrich (Bot)]
Server: current_player_index advances to Heinrich's index
Socket: turn:change emitted
BotTurnTrigger: schedules after 1500ms
```

**What Alice sees:**
1. "Wait Your Turn" (grayed out)
2. ~1500ms later: brain icon pulses, "Heinrich is thinking..."
3. Heinrich's AI pipeline runs:
   - `OptionGenerator` generates ALL option types (BuildTrack, PickupLoad, DeliverLoad, MoveToCity, UpgradeTrain, PassTurn) â€” game is now `active`
   - If Heinrich has no position, `AIStrategyEngine` auto-places him at a major city
   - Scorer evaluates options with `backbone_builder` weights (prioritizes track network connectivity)
   - TurnExecutor executes the plan: maybe builds track, possibly moves, picks up a load
4. Server emits `state:patch` updates as Heinrich's money, position, and loads change â†’ Alice's client merges patches
5. If Heinrich builds track: `track:updated` â†’ Alice sees new colored track appear
6. If Heinrich moves: `state:patch` with updated position â†’ Heinrich's train sprite slides to new location
7. "Heinrich finished their turn." â†’ turn:change â†’ "It's your turn!"

**Note:** `bot:action` events are defined but NOT currently emitted by the server. The human sees the results (track appearing, train moving) via `state:patch` and `track:updated`, but there are no per-action animations yet. This is a known gap.

---

### Turns 7-10: Rhythm Established

The game settles into a rhythm:

**Alice's turns (odd-numbered):**
- Move train along track toward delivery cities
- Pick up loads when passing through source cities
- Build track to extend network toward demand destinations
- Eventually deliver first load â†’ demand card discarded, new card drawn, payment received
- Click "Next Player" when done

**Heinrich's turns (even-numbered):**
- 1500ms pause â†’ brain pulse â†’ "thinking..." toast
- AI builds track/moves/delivers (visible through state patches and track updates)
- "finished their turn" toast â†’ "It's your turn!" toast
- Typical bot turn takes 1-3 seconds of server-side processing

**By Turn 10:**
- Both players have ~10-15 track segments, extending from their starting major cities
- Alice may have delivered 1-2 loads (ECU +8-20M)
- Heinrich has been building toward his demand destinations
- Alice can see Heinrich's track on the map (different color) and his train position
- Track networks may begin overlapping near popular major cities

---

## Journey 2: Multiple Bots

**Setup:** 1 human player ("Alice"), 3 bots ("Heinrich", "Marie", "Paolo")

### The Rapid-Fire Bot Turn Problem

This journey focuses on what happens when Alice ends her turn and 3 bots execute in sequence.

### Pre-Game and Initial Build

Same as Journey 1, except `InitialBuildService.initPhase()` *(⚠️ to be created)* creates order: `[Alice, Heinrich, Marie, Paolo]`.

**Round 1:** Alice builds â†’ Heinrich builds â†’ Marie builds â†’ Paolo builds
**Round 2:** Paolo builds â†’ Marie builds â†’ Heinrich builds â†’ Alice builds
**Transition to active phase**

During initial build, each bot turn has a 1500ms delay before execution. Between bot turns, `InitialBuildService.advanceTurn()` fires, which emits `turn:change`, which triggers `BotTurnTrigger.onTurnChange()` for the next bot. So the sequence is:

```
Alice clicks "Next Player" (Round 1)
  â†’ turn:change(1, Heinrich) [0ms]
  â†’ BotTurnTrigger: 1500ms delay
  â†’ Heinrich executes (~1-2s)
  â†’ InitialBuildService.advanceTurn()
  â†’ turn:change(2, Marie) [~3s total]
  â†’ BotTurnTrigger: 1500ms delay
  â†’ Marie executes (~1-2s)
  â†’ InitialBuildService.advanceTurn()
  â†’ turn:change(3, Paolo) [~6s total]
  â†’ BotTurnTrigger: 1500ms delay
  â†’ Paolo executes (~1-2s)
  â†’ InitialBuildService.advanceTurn() â†’ Round 2 starts
  â†’ turn:change(0, Paolo) [~9s total, Round 2]
  â†’ ... 3 more bot turns ...
  â†’ turn:change(3, Alice) [~18s total]
```

**What Alice sees during this ~18-second sequence:**
1. "Wait Your Turn" button stays grayed
2. Bot 1 brain pulses â†’ "Heinrich is thinking..." â†’ track appears â†’ "Heinrich finished their turn."
3. ~1.5s pause
4. Bot 2 brain pulses â†’ "Marie is thinking..." â†’ track appears â†’ "Marie finished their turn."
5. ~1.5s pause
6. Bot 3 brain pulses â†’ "Paolo is thinking..." â†’ track appears â†’ "Paolo finished their turn."
7. Round 2 starts, same 3 bots again (reversed order)
8. Finally: "It's your turn!" (4000ms notification)

**What prevents double-execution:**
- `BotTurnTrigger.onTurnChange()` checks `pendingBotTurns.has(gameId)` — if a bot turn is already executing for this game, the call returns immediately
- `emitTurnChange()` is called ONCE per turn advancement (from `InitialBuildService.advanceTurn()` or `PlayerService.updateCurrentPlayerIndex()`)
- The route handler does NOT emit a redundant `turn:change` — only the service method emits it

### Active Phase: Turn 5 â€” Alice Ends Turn, 3 Bots Execute

```
Alice clicks "Next Player"
  â””â”€ Server: updateCurrentPlayerIndex(gameId, 1)
     â””â”€ emitTurnChange(gameId, 1, Heinrich.id)
```

**Sequential execution chain:**

```
[TURN 5 â†’ 6: Alice â†’ Heinrich]  t=0s
  Socket: turn:change(1, Heinrich.id)
  Client: handleTurnChange(1) â€” leaderboard updates
  BotTurnTrigger: pendingBotTurns.add(gameId), setTimeout(1500ms)

[t=1.5s] Heinrich starts executing
  Server: bot:turn-start â†’ Client: brain pulse, "Heinrich is thinking..."
  AIStrategyEngine.takeTurn() runs (~1-2s)
  Server: state:patch (money, position, loads change)
  Server: track:updated (if track built)
  Server: bot:turn-complete â†’ Client: "Heinrich finished their turn."

[TURN 6 â†’ 7: Heinrich â†’ Marie]  tâ‰ˆ3.5s
  advanceTurnAfterBot: updateCurrentPlayerIndex(gameId, 2)
  emitTurnChange(gameId, 2, Marie.id)
  pendingBotTurns.delete(gameId) [from .finally()]
  BotTurnTrigger.onTurnChange(): pendingBotTurns.add(gameId), setTimeout(1500ms)

[tâ‰ˆ5s] Marie starts executing
  Server: bot:turn-start â†’ Client: brain pulse, "Marie is thinking..."
  ... same pattern ...

[TURN 7 â†’ 8: Marie â†’ Paolo]  tâ‰ˆ7s
  ... same pattern ...

[TURN 8 â†’ 9: Paolo â†’ Alice]  tâ‰ˆ10.5s
  advanceTurnAfterBot: updateCurrentPlayerIndex(gameId, 0)
  emitTurnChange(gameId, 0, Alice.id)
  BotTurnTrigger.onTurnChange(): player at index 0 is NOT a bot â†’ return

  Client: handleTurnChange(0) â†’ "It's your turn!" (4000ms)
  UI: Green "Next Player" button becomes interactive
```

**Client-side state during bot turns:**
- `handleTurnChange()` fires for EACH turn:change event (indices 1, 2, 3, then 0)
- Each call runs `refreshPlayerData()` â†’ fetches latest player state from server
- `gameState.currentPlayerIndex` updates each time
- Leaderboard re-renders with the new active player highlighted
- **Key invariant:** Alice's local position, movement history, and ferry state are preserved during refresh (client-managed state is not overwritten by server data)

**What Alice sees:**
- Her money display may have changed (if bots used her track and paid fees)
- 3 sets of colored track appeared on the map (one per bot)
- 3 train sprites appeared/moved to new positions
- The whole sequence takes ~10-12 seconds

**What the design prevents:**
- **Double execution:** Without the `pendingBotTurns` guard + single-emit rule, each bot could execute twice, duplicating all side effects (double track, double money deductions)
- **Wrong turn advancement:** During initialBuild, using `PlayerService.updateCurrentPlayerIndex()` instead of `InitialBuildService.advanceTurn()` would break round progression — Round 2 would never start, and the game would be stuck in initialBuild forever

---

### Later Turns: The Rhythm with 3 Bots

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

---

## Journey 3: Mid-Game Complexity

**Setup:** Turn 20+. Alice has ~15 track segments connecting Hamburg to Berlin. Heinrich has track connecting MÃ¼nchen to Wien. Both have delivered 2-3 loads. Alice has ECU 85M, Heinrich has ECU 72M. Both still have Freight trains.

### Scenario A: Bot Delivers a Load

```
[Heinrich's Turn â€” Mid-Game Delivery]
```

**What the server does:**
1. `OptionGenerator` generates a `DeliverLoad` option: Heinrich is at Berlin with Wine, has demand card for Wineâ†’Berlin (12M)
2. `Scorer` rates this highly (immediate cash)
3. `TurnExecutor.handleDeliverLoad()`:
   - Calls `PlayerService.deliverLoadForUser(gameId, heinrichUserId, 'Berlin', 'Wine', cardId)`
   - Server: validates card in hand, load on train, player at city
   - Updates: `money += 12M` (minus debt if any), `loads` removes Wine, `hand` replaces card
   - `DemandDeckService`: discards fulfilled card, draws replacement
   - Emits `state:patch` with updated player data

**What Alice sees:**
1. Brain icon pulses, "Heinrich is thinking..."
2. `state:patch` arrives â†’ Alice's client updates Heinrich's entry in the leaderboard:
   - Money: 72M â†’ 84M
   - Train shows one fewer load
3. Heinrich's demand cards (face-up per rules) update â€” old card gone, new card drawn
4. "Heinrich finished their turn."

### Scenario B: Bot Builds Track

1. `TurnExecutor.handleBuildTrack()` saves segments via `TrackService.saveTrackState()`
2. Route emits `track:updated` socket event
3. Alice's client receives `track:updated` â†’ calls `trackManager.loadExistingTracks()` â†’ `drawAllTracks()`
4. **New track segments appear on the map in Heinrich's color** (e.g., blue lines from MÃ¼nchen toward Praha)
5. Alice can see the bot's strategy developing â€” which cities it's connecting

### Scenario C: Bot Upgrades Train

1. `TurnExecutor.handleUpgradeTrain()` calls `PlayerService.purchaseTrainType(gameId, userId, 'upgrade', 'FastFreight')`
2. Server: validates Freightâ†’FastFreight is legal, deducts 20M, no track building this turn
3. `state:patch` updates Heinrich's train type and money
4. Alice sees in the leaderboard: Heinrich's train icon changes, money decreases by 20M

### Scenario D: Human Uses Bot's Track (Track Usage Fees)

Alice wants to reach Wien, which is connected by Heinrich's track but not hers.

1. Alice moves her train toward Wien. The path goes through Heinrich's track segments.
2. Client: `computeTrackUsageForMove()` detects opponent track in path
3. **Confirmation dialog appears:** "Using Heinrich's track. Fee: ECU 4M. Continue?"
4. Alice clicks "Yes"
5. `POST /api/players/move-train` includes the movement
6. Server: deducts 4M from Alice, adds 4M to Heinrich
7. `state:patch` updates both players' money
8. Both players' leaderboard entries update simultaneously

### Scenario E: Strategy Inspector

After Heinrich's turn completes, Alice clicks Heinrich's brain icon (ðŸ§ ) in the leaderboard.

**Strategy Inspector Modal opens showing:**
- **Archetype:** "Backbone Builder" with blue badge
- **Philosophy:** Description of the backbone_builder strategy
- **Skill Level:** "Easy" badge
- **Current Plan:** e.g., "Build track toward Wien to deliver Steel"
- **Options Considered:** Table of scored options:
  | Option | Score | Bar |
  |--------|-------|-----|
  | BuildTowardMajorCity(Wien) | 0.85 | â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–‘â–‘ |
  | DeliverLoad(Steelâ†’Wien) | 0.72 | â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–‘â–‘â–‘ |
  | PickupLoad(Coal) | 0.45 | â–ˆâ–ˆâ–ˆâ–ˆâ–‘â–‘â–‘â–‘â–‘â–‘ |
  | PassTurn | 0.10 | â–ˆâ–‘â–‘â–‘â–‘â–‘â–‘â–‘â–‘â–‘ |
- **Selected option** marked with âœ“
- **Rejected options** (collapsible): options that failed validation, with rejection reasons
- **Bot Status:** Cash: 72M, Train: Freight, Loads: [Steel], Cities: 2, Turn: 20, Think time: 847ms

---

## Journey 4: Edge Cases and Failure Modes

### Edge Case 1: Bot's Planned Actions Are All Invalid

**Scenario:** Heinrich has no available loads at reachable cities, can't afford to build track (0 ECU), and his demand cards require cities far from his network.

**Server behavior:**
1. `OptionGenerator.generate()` produces options, but `PlanValidator` rejects them all
2. `AIStrategyEngine` retry logic: tries next-best option (up to 3 retries)
3. All retries fail â†’ **PassTurn fallback**: executes `discardHandForUser()` or equivalent pass action
4. Bot's turn ends gracefully

**What Alice sees:**
- Brain icon pulses briefly
- "Heinrich is thinking..." (2000ms)
- Bot turn completes quickly (no track/movement changes visible)
- "Heinrich finished their turn." (1500ms)
- Alice's turn starts normally â€” **game is NOT stuck**

### Edge Case 2: Game with 5 Bots (1 Human + 5 Bots)

**During initial build:**
- Round 1: Alice builds â†’ 5 bot turns in sequence (~15s)
- Round 2: 5 bot turns in reverse â†’ Alice builds (~15s before Alice's turn)
- Total initialBuild time: ~30s of bot turns + Alice's 2 build turns

**During active phase:**
- Each human turn cycle: ~25-30s of bot turns
- The `BOT_TURN_DELAY_MS = 1500ms` provides minimum pacing
- 5 Ã— (1500ms delay + 1-2s execution) = ~12-17s of bot execution

**What Alice sees:**
- Rapid succession of brain pulses and thinking notifications for each bot
- Track segments appearing in 5 different colors across the map
- 5 trains moving around the map
- "It's your turn!" signals clearly when Alice can act again

### Edge Case 3: Human Disconnects During Bot Turn

**Scenario:** Alice closes her browser tab while Heinrich (bot) is executing.

**Server-side:**
1. Heinrich's turn continues to completion (server-side execution, no client needed)
2. `advanceTurnAfterBot()` advances to next player
3. If next player is Alice (human), `BotTurnTrigger.onTurnChange()` calls `hasConnectedHuman(gameId)`
4. `hasConnectedHuman()` returns `false` (Alice disconnected)
5. If next player is ALSO a bot â†’ bot executes (bots run server-side, no human needed for computation)
6. If only human players remain: `queuedBotTurns.set(gameId, { ... })` â€” bot turn queued

**Alice reconnects:**
1. Socket.IO reconnects automatically
2. Client sends `join` event with gameId
3. Server handler calls `BotTurnTrigger.onHumanReconnect(gameId)`
4. If a bot turn was queued: dequeues and triggers `onTurnChange()` â†’ bot executes
5. If it's Alice's turn: she gets `state:init` with full current game state â†’ UI rebuilds from authoritative server state
6. All track, positions, money reflect the completed bot turns

### Edge Case 4: Bot Achieves Victory Condition

**Scenario:** Heinrich connects 7 major cities and has ECU 250M.

**What happens:**
1. After Heinrich's turn, `AIStrategyEngine` checks victory conditions
2. Calls `VictoryService.declareVictory(gameId, heinrichPlayerId, claimedCities)`
3. Server validates: 7 unique cities in track network, money >= 250M
4. Sets `victory_triggered = true`, records trigger player index
5. Determines `final_turn_player_index` â€” all remaining players get equal turns
6. Socket: `victory:triggered` event emitted

**What Alice sees:**
1. Toast notification: "Heinrich has declared victory! Remaining players get equal turns."
2. The game continues â€” Alice gets her final turn(s)
3. Alice can try to also reach victory conditions (tie scenario)
4. After all players have had equal turns:
   - If Alice also met conditions: `victory:tie-extended` â†’ threshold rises to 300M, play continues
   - If only Heinrich met conditions: `game:over` event â†’ `WinnerScene` launches
5. **WinnerScene:** Full-screen overlay with "GAME OVER", "Heinrich Wins!", final standings sorted by money, confetti animation, "Leave Game" button

### Edge Case 5: Bot Turn During Event Cards

**Current status:** Event cards are NOT implemented in the codebase. The database schema includes an `event_cards` table (migration 001, with columns for `type`, `effect` JSONB, `status`, `expires_at`), but no event card logic exists in server or client code. This is a future feature.

When implemented, event cards would need to:
- Be drawn when demand cards are drawn (event cards mixed into the deck)
- Take immediate effect (storms, strikes, derailments)
- Affect bot pathfinding and option generation (e.g., blocked routes, half-speed regions)
- The `WorldSnapshot` would need to include active event effects
- `OptionGenerator` and `Scorer` would need to account for temporary route blockages

