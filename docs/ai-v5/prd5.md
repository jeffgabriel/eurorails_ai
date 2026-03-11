# Section 5: Bot Gets a Position — Train Placement and Movement

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

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

## Related User Journeys

### Journey 1: Turn 5 — Alice's First Active Turn (Train Placement Context)

**What changes for Alice now:**
- **Movement is unlocked.** But Alice has no train position yet — she hasn't placed her train.
- `handleTurnChange()` detects `player.position === null` → prompts starting city selection
- Alice sees a prompt: "Select a starting city" — she clicks on Hamburg (where her track starts)
- Client sets her train position at Hamburg → train pawn sprite appears on the map
- She now has 9 movement points (Freight train speed)

**Alice's turn options (active phase):**
1. **Move train** — click on connected mileposts along her track. Movement points decrease per milepost.
2. **Pick up loads** — if she passes through a city with available commodities, `LoadDialogScene` opens with "Available for Pickup" section
3. **Deliver loads** — if at a city matching a demand card, "Can be Delivered" section appears
4. **Build more track** — click crayon button, spend up to 20M
5. **Upgrade train** — via "More actions..." modal (costs 20M, can't also build track)
6. **"Next Player"** button to end turn

### Journey 1: Turn 6 — Heinrich's First Active Turn (Bot Movement)

```
[TURN 5 → TURN 6: Alice → Heinrich (Bot)]
Server: current_player_index advances to Heinrich's index
Socket: turn:change emitted
BotTurnTrigger: schedules after 1500ms
```

**What Alice sees:**
1. "Wait Your Turn" (grayed out)
2. ~1500ms later: brain icon pulses, "Heinrich is thinking..."
3. Heinrich's AI pipeline runs:
   - `OptionGenerator` generates ALL option types (BuildTrack, PickupLoad, DeliverLoad, MoveToCity, UpgradeTrain, PassTurn) — game is now `active`
   - If Heinrich has no position, `AIStrategyEngine` auto-places him at a major city
   - Scorer evaluates options with `backbone_builder` weights (prioritizes track network connectivity)
   - TurnExecutor executes the plan: maybe builds track, possibly moves, picks up a load
4. Server emits `state:patch` updates as Heinrich's money, position, and loads change → Alice's client merges patches
5. If Heinrich builds track: `track:updated` → Alice sees new colored track appear
6. If Heinrich moves: `state:patch` with updated position → Heinrich's train sprite slides to new location
7. "Heinrich finished their turn." → turn:change → "It's your turn!"

**Note:** `bot:action` events are defined but NOT currently emitted by the server. The human sees the results (track appearing, train moving) via `state:patch` and `track:updated`, but there are no per-action animations yet. This is a known gap.
