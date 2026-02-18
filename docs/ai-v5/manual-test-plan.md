# AI Bot Players v5 — Manual Test Plan

**For each section, complete ALL tests before proceeding to the next section.**
**Use the notation: PASS / FAIL / N/A for each test case.**

---

## Section 1: Bot Player Identity — Lobby, Database, and Game Start

**Prereqs:** Dev server running (`npm run dev`). Logged in as a user.

### Test 1.1: Add a single bot to lobby
1. Create a new game from the lobby
2. Click "Add Bot"
3. **Verify:** A popover/modal appears with:
   - Skill level selector (Easy / Medium / Hard)
   - Archetype selector (5 named archetypes + Random)
   - Optional name text input
4. Select Easy, Random archetype, leave name blank
5. Click Add/Submit
6. **Verify:** Bot appears in the player list with:
   - A robot icon (or similar bot indicator)
   - An auto-generated name
   - An archetype badge (NOT "Random" — must be one of the 5 concrete archetypes)
   - An assigned player color

### Test 1.2: Add multiple bots (max capacity)
1. In the same lobby, click "Add Bot" 4 more times (total 5 bots + 1 human = 6 players)
2. **Verify:** Each bot gets a unique name, unique color, and a concrete archetype
3. Try to add a 6th bot
4. **Verify:** Addition is rejected (max 6 players total)

### Test 1.3: Remove a bot
1. On a bot entry in the lobby player list, click the remove/X button
2. **Verify:** Bot disappears from the player list
3. **Verify:** The color the bot had is now available (add another bot — it can get that color)

### Test 1.4: Random archetype resolution
1. Add 5 bots, all with "Random" archetype selected
2. **Verify:** Each bot shows one of the 5 concrete archetypes in the lobby — NONE show "Random"
3. (Repeat if all 5 happen to get the same archetype — this is very unlikely but valid)

### Test 1.5: Start game with 1 human + 1 bot
1. Create a new game, add 1 bot
2. Click "Start Game"
3. **Verify:** Game starts, navigates to the game view
4. **Verify:** Game is in `initialBuild` phase (not `active`)
5. **Verify:** Leaderboard shows both players — human and bot (bot has a bot indicator)
6. **Verify:** It is the human's turn first

### Test 1.6: Human takes first turn, game freezes on bot's turn
1. In the game from Test 1.5, build some track as the human
2. Click "Next Player"
3. **Verify:** Leaderboard highlights the bot's name
4. **Verify:** The "Next Player" button is disabled / grayed / shows "Wait Your Turn"
5. **Verify:** The game is STUCK on the bot's turn (expected — no bot turn logic yet)
6. **Verify:** No errors in the browser console

### Test 1.7: Human-only game regression check
1. Create a new game with NO bots (just human players, or solo if allowed)
2. Start the game
3. **Verify:** Game starts and plays normally — identical to pre-bot behavior
4. Build track, click Next Player — everything works as before

### Test 1.8: Database integrity
1. After adding a bot and starting a game, check the server logs
2. **Verify:** No 500 errors, no FK constraint violations
3. (Optional) Query the database: `SELECT * FROM players WHERE is_bot = true`
4. **Verify:** Bot has a valid `user_id` pointing to a `users` row
5. **Verify:** `bot_config` contains `{ skillLevel, archetype, botName }` with a concrete archetype

---

## Section 2: Debug Overlay Foundation

**Prereqs:** Section 1 complete. A game with 1 human + 1 bot (game will be stuck on bot turn).

### Test 2.1: Toggle overlay
1. During a game, press the backtick key (`)
2. **Verify:** A semi-transparent overlay appears on the right side of the screen
3. Press backtick again
4. **Verify:** Overlay disappears
5. Press backtick a third time
6. **Verify:** Overlay reappears (toggle works reliably)

### Test 2.2: Overlay does not capture game input
1. With overlay open, click on the game map (try to interact with mileposts, buttons)
2. **Verify:** Clicks pass through to the game — the overlay doesn't block interaction
3. **Verify:** You can build track, click buttons, etc. with the overlay open

### Test 2.3: Game state panel content
1. Open the overlay
2. **Verify** header shows:
   - Game ID (can be truncated)
   - Game status (e.g., "initialBuild" or "active")
   - Current player index
   - Current player name
3. **Verify** players table shows ALL players with columns:
   - Name
   - Bot indicator (yes/no)
   - Money (e.g., 50M)
   - Position (row,col or "none")
   - Train type
   - Loads carried
   - Turn number

### Test 2.4: Bot player visual distinction
1. In the players table, find the bot row
2. **Verify:** Bot row has a distinct background color or highlight compared to human rows

### Test 2.5: Current player highlight
1. Check which player's turn it is
2. **Verify:** That player's row is visually highlighted in the table (different from the bot-highlight)

### Test 2.6: Real-time updates
1. Open the overlay before your turn
2. Note your current money value
3. Build some track (spending money)
4. **Verify:** The money value in the overlay updates in real-time as you spend
5. Click "Next Player" (or take any action that changes state)
6. **Verify:** Current player index and player highlights update

### Test 2.7: Socket event log
1. Open the overlay and find the socket events section
2. Take an action (build track, click Next Player)
3. **Verify:** Socket events appear in the log with:
   - Event name (e.g., `track:updated`, `turn:change`)
   - Truncated payload
   - Timestamp
4. **Verify:** Newest events appear at the top

### Test 2.8: Bot turn section placeholder
1. Open the overlay
2. Find the "Bot Turn" section
3. **Verify:** Shows placeholder text like "No bot turn data yet"

### Test 2.9: Overlay persistence
1. Open the overlay (press backtick)
2. Navigate away from the game and back (if possible via browser back/forward or refresh)
3. **Verify:** Overlay state persists (still open or remembers last state)

### Test 2.10: Backtick key in text inputs
1. Open the chat input (or any text field in the game)
2. Type a backtick character
3. **Verify:** The overlay does NOT toggle — the backtick goes into the text field

---

## Section 3: Bot Turn Skeleton — Pass Turn Correctly

**Prereqs:** Sections 1-2 complete.

### Test 3.1: 1 human + 1 bot — bot passes turn (initial build)
1. Create a game with 1 human + 1 bot, start the game
2. Build some track as the human, click "Next Player"
3. **Verify:** Within ~2-3 seconds, the turn automatically advances back to the human
4. **Verify:** The leaderboard briefly showed the bot's name highlighted, then switched to the human
5. Open debug overlay
6. **Verify:** `bot:turn-start` and `bot:turn-complete` events appear in the socket log
7. **Verify:** Bot turn section shows: "Bot {name} turn completed: PassTurn ({duration}ms)"

### Test 3.2: Full initial build cycle (1 human + 1 bot)
1. Round 1: Human builds track → bot passes → (round 1 complete)
2. Round 2: Bot passes → human builds track → (round 2 complete)
3. **Verify:** Round 2 order is reversed (bot goes first in round 2)
4. **Verify:** After both rounds, game transitions to `active` phase
5. **Verify:** Debug overlay shows status change from `initialBuild` to `active`

### Test 3.3: Active phase — bot continues passing
1. After initial build completes, take your turn in active phase
2. Click "Next Player"
3. **Verify:** Bot's turn passes automatically (~2 seconds), returns to human
4. Repeat for several turns
5. **Verify:** No freezing, turns advance reliably every time

### Test 3.4: 1 human + 3 bots — sequential passes
1. Create a game with 1 human + 3 bots, start the game
2. Build track, click "Next Player"
3. **Verify:** All 3 bot turns pass in sequence (~5-6 seconds total)
4. **Verify:** Leaderboard highlights each bot in sequence before returning to human
5. **Verify:** No freezing or skipped turns
6. Open debug overlay socket log
7. **Verify:** 3 `turn:change` events fired (one per bot), no duplicates

### Test 3.5: 1 human + 5 bots — maximum bots
1. Create a game with 1 human + 5 bots, start the game
2. Build track, click "Next Player"
3. **Verify:** All 5 bot turns pass in sequence (~8-10 seconds total)
4. **Verify:** Game does not freeze — returns to human turn
5. **Verify:** No duplicate `turn:change` events in the socket log

### Test 3.6: Bot turn number increments
1. Open debug overlay during a game with a bot
2. Note the bot's turn number in the players table
3. Let the bot take a turn (pass)
4. **Verify:** Bot's turn number incremented by 1
5. Repeat for several turns — each time the turn number goes up

### Test 3.7: Human-only regression
1. Create a game with only human players (no bots)
2. Play several turns
3. **Verify:** Game works identically to before — no behavioral changes

### Test 3.8: Disconnect and reconnect during bot turns
1. Start a game with 1 human + 3 bots
2. Take your turn, click "Next Player"
3. Immediately close the browser tab (during bot turn sequence)
4. Reopen the game URL
5. **Verify:** Game state is consistent — it's either mid-bot-turns or waiting for human
6. **Verify:** Game is not stuck — bot turns complete and human can play

### Test 3.9: Check server logs
1. After several bot turns, check the server terminal output
2. **Verify:** Log entries show bot turn execution (game ID, bot ID, turn number, action: PassTurn)
3. **Verify:** No `[BOT:ERROR]` entries in the logs

---

## Section 4: Bot Builds Track — First Real Action

**Prereqs:** Section 3 complete.

### Test 4.1: Bot builds track during initial build
1. Create a game with 1 human + 1 bot, start the game
2. Build some track as the human, click "Next Player"
3. **Verify:** Within a few seconds, colored track segments appear on the map in the bot's color
4. **Verify:** The track starts from a major city (zoom in to confirm)
5. **Verify:** 2-3 new segments appeared (short initial build)

### Test 4.2: Track position accuracy
1. Zoom in on the bot's new track segments
2. **Verify:** Segments are at correct map positions (on mileposts, connecting adjacent hexes)
3. **Verify:** Segments are NOT clustered at the top-left corner (position 0,0) or other incorrect location

### Test 4.3: Money deduction
1. Open the debug overlay
2. Note the bot's money before its turn
3. Let the bot take a turn (builds track)
4. **Verify:** Bot's money decreased by the correct amount
5. **Verify:** The cost makes sense (e.g., 2-3 clear terrain segments = ~$2-3M)

### Test 4.4: Track persists across turns
1. After the bot builds track, take your turn and come back
2. **Verify:** The bot's track is still visible on the map
3. Let the bot take another turn
4. **Verify:** New track extends from the existing track (not a disconnected island)

### Test 4.5: Full initial build — accumulated track
1. Play through all 4 bot turns of initial build (2 rounds x 2 turns)
2. **Verify:** The bot has built ~8-12 total track segments
3. **Verify:** Track forms a connected network from a major city outward

### Test 4.6: Active phase — bot continues building
1. After initial build completes (active phase), play several turns
2. **Verify:** Bot continues building track on its turns
3. **Verify:** Track network grows turn over turn

### Test 4.7: $20M/turn build limit
1. Open debug overlay
2. Watch a bot's turn — check the build cost in the Bot Turn section
3. **Verify:** Bot never spends more than $20M on track in a single turn

### Test 4.8: track:updated socket events
1. Open debug overlay socket log
2. Let the bot take a turn that builds track
3. **Verify:** `track:updated` event appears in the log for the bot's build

### Test 4.9: Bot turn audit data
1. Open debug overlay Bot Turn section
2. After a bot turn, check for audit details
3. **Verify:** Shows: segments built (count), total cost, segment details (from/to coordinates, terrain, cost)

### Test 4.10: Human can use bot's track
1. Build your own track toward the bot's track network
2. Move your train onto the bot's track
3. **Verify:** You are charged $4M for using the bot's track
4. **Verify:** Movement along bot's track works correctly

### Test 4.11: Human-only regression
1. Play a game with no bots
2. **Verify:** Track building, saving, and rendering work identically to before

---

## Section 5: Bot Gets a Position — Train Placement and Movement

**Prereqs:** Section 4 complete.

### Test 5.1: Bot train sprite appears
1. Create a game with 1 human + 1 bot
2. Play through initial build rounds into active phase
3. **Verify:** Bot's train sprite appears on the map at a major city
4. **Verify:** The train is at a correct map position (on a major city that the bot has track at)
5. **Verify:** Train sprite is NOT at position (0,0) / top-left corner

### Test 5.2: Bot moves each turn
1. Continue playing into active phase
2. Take your turn, click "Next Player"
3. Watch the bot's turn
4. **Verify:** Bot's train sprite moves to a new position along its track
5. Open debug overlay
6. **Verify:** Bot's position (row, col) updated from previous turn

### Test 5.3: Movement over multiple turns
1. Play 5-10 active turns
2. **Verify:** Bot's train moves each turn (position changes in debug overlay)
3. **Verify:** Bot appears to move toward cities on its demand cards (check demand cards in debug overlay if visible)

### Test 5.4: No movement during initialBuild
1. Start a new game with 1 human + 1 bot
2. During initial build phase, open debug overlay
3. **Verify:** Bot's position shows "none" throughout initial build
4. **Verify:** Bot does NOT attempt to move during initial build (only builds track)

### Test 5.5: Mixed turns (move + build)
1. In active phase, watch a bot's turn
2. Open debug overlay
3. **Verify:** Bot both moves AND builds track in the same turn
4. **Verify:** Movement happens first, then building (per game rules)

### Test 5.6: position updates via state:patch
1. Open debug overlay socket log
2. Let the bot take a turn
3. **Verify:** `state:patch` event appears with position data for the bot

### Test 5.7: Multiple bots — all have visible trains
1. Create a game with 1 human + 3 bots
2. Play into active phase
3. **Verify:** All 3 bot trains are visible on the map at different locations
4. **Verify:** Each train is at a plausible position on its own track network

### Test 5.8: Train sprite rendering accuracy
1. Zoom in on the bot's train
2. **Verify:** Train sprite is positioned on a milepost (not floating between mileposts or off the grid)
3. Take several turns and watch it move
4. **Verify:** Train always lands on valid mileposts

---

## Section 6: Bot Picks Up and Delivers Loads — Completing the Game Loop

**Prereqs:** Section 5 complete.

### Test 6.1: Bot picks up a load
1. Create a game with 1 human + 1 bot
2. Play into active phase and let the bot take ~5-10 turns (building track and moving)
3. Open debug overlay
4. **Verify:** At some point the bot picks up a load (debug shows "Bot picked up {loadType} at {city}")
5. **Verify:** Bot's "Loads" column in the player table shows the carried load

### Test 6.2: Bot delivers a load for payment
1. Continue playing
2. **Verify:** The bot eventually delivers a load (debug shows "Bot delivered {loadType} to {city} for ${X}M")
3. **Verify:** Bot's money increases by the delivery payment amount
4. **Verify:** The delivered load disappears from the bot's carried loads

### Test 6.3: Demand card replacement after delivery
1. After a bot delivery, check the debug overlay
2. **Verify:** Bot's demand cards changed (old card removed, new card drawn)
3. **Verify:** Bot still has exactly 3 demand cards

### Test 6.4: Train capacity respected
1. Watch the bot over many turns
2. Note the bot's train type (Freight = 2 load capacity)
3. **Verify:** Bot never carries more loads than its train capacity allows
4. If the bot has 2 loads on a Freight train, it does NOT pick up a 3rd

### Test 6.5: Complete gameplay loop over 20+ turns
1. Play a long game (20+ active turns)
2. **Verify:** Bot builds track, moves, picks up loads, delivers them, earns money
3. **Verify:** Bot's money trends upward over time (not just spending on track)
4. **Verify:** Bot's track network grows to connect supply and demand cities

### Test 6.6: Load availability — racing the bot
1. Identify a load type the bot wants to pick up (check its demand cards in debug overlay)
2. Rush to that city and pick up all copies of that load type before the bot gets there
3. **Verify:** Bot does NOT pick up the now-unavailable load
4. **Verify:** Bot adapts — chooses a different action instead

### Test 6.7: Turn narrative in debug overlay
1. Open debug overlay, let the bot take a turn
2. **Verify:** The Bot Turn section shows a complete narrative of what happened:
   - Movement: where it went
   - Pickups: what it picked up and where
   - Deliveries: what it delivered and for how much
   - Track building: what it built

### Test 6.8: No pickups during initialBuild
1. Start a new game with 1 human + 1 bot
2. Open debug overlay during initial build
3. **Verify:** Bot does not attempt to pick up or deliver loads during initialBuild

### Test 6.9: Human-only regression
1. Play a game with no bots
2. Pick up loads, deliver them, earn money
3. **Verify:** All load/delivery mechanics work identically to before

---

## Section 7: Strategy Inspector — Full Debug and Decision Transparency

**Prereqs:** Section 6 complete.

### Test 7.1: Selected plan display
1. Start a game with 1 human + 1 bot
2. Open debug overlay (backtick)
3. Let the bot take a turn
4. **Verify:** Bot Turn section shows "Selected Plan" with:
   - Plain-English description of what the bot chose
   - Score of the selected option

### Test 7.2: All options table
1. After a bot turn, find the options table in the overlay
2. **Verify:** Shows a ranked list of all feasible options with:
   - Rank number
   - Option type (BuildTrack, MoveToCity, PickupLoad, DeliverLoad, etc.)
   - Description
   - Score
   - Status indicator (selected vs. feasible)

### Test 7.3: Rejected options
1. Find the rejected options section (may be collapsible)
2. **Verify:** Shows options that were considered but rejected
3. **Verify:** Each rejected option has a specific reason (e.g., "Steel at Birmingham — all 3 loads on other trains")

### Test 7.4: Scoring breakdown
1. Find the scoring breakdown for the selected option
2. **Verify:** Shows individual scoring dimensions with:
   - Dimension name (e.g., "immediate income", "network expansion")
   - Weight
   - Value
   - Contribution to total score

### Test 7.5: Turn timeline
1. After a bot turn, find the execution timeline
2. **Verify:** Shows step-by-step actions with timing:
   - e.g., "Moved to Hamburg (1.2s)" → "Picked up Wine (0.3s)" → "Built 3 segments (0.8s)"

### Test 7.6: History navigation
1. Let the bot take 3+ turns
2. Find the history navigation (arrow buttons or similar)
3. **Verify:** Can browse back to previous bot turns
4. **Verify:** Each historical turn shows its full decision data
5. **Verify:** Can navigate forward back to the latest turn

### Test 7.7: Multiple bots
1. Create a game with 1 human + 3 bots
2. Open the overlay
3. **Verify:** Can view strategy data for each bot independently (tabs, dropdown, or similar)
4. **Verify:** Each bot's data is separate (different options, different scores)

### Test 7.8: Auto-update on new turn
1. Keep the overlay open
2. Watch as the bot takes a turn
3. **Verify:** Overlay updates automatically when `bot:turn-complete` fires (no manual refresh needed)

---

## Section 8: Victory Condition — Bot Can Win (or Lose) the Game

**Prereqs:** Section 6 complete.

### Test 8.1: Victory progress in debug overlay
1. Start a game with 1 human + 1 bot
2. Open debug overlay
3. **Verify:** Player table shows "Major Cities Connected: X of Y" for the bot
4. Play several turns
5. **Verify:** The count increases as the bot's track network expands

### Test 8.2: Bot declares victory (accelerated test)
1. To test quickly, either:
   - Modify the bot's starting money to ~$240M (DB edit), OR
   - Lower the victory threshold temporarily, OR
   - Play a very long game
2. **Verify:** When the bot reaches ≥$250M AND has connected ≥7 major cities, a victory event fires
3. **Verify:** Human sees "Bot has declared victory!" or equivalent message
4. **Verify:** Human gets equal turn(s) to match/exceed

### Test 8.3: Game ends properly
1. After victory is declared and equal turns play out
2. **Verify:** Game status changes to `completed`
3. **Verify:** Winner is displayed (bot's name if it won)
4. **Verify:** No further turns can be taken

### Test 8.4: Victory-aware strategy
1. Get the bot close to victory (e.g., 6 of 7 major cities connected, $230M)
2. Open Strategy Inspector
3. **Verify:** Bot prioritizes actions that advance toward victory:
   - Building track toward unconnected major cities
   - Delivering highest-value loads

### Test 8.5: Human wins before bot
1. Play aggressively and reach $250M + 7 major cities before the bot
2. Declare victory
3. **Verify:** Bot gets its equal turn(s)
4. **Verify:** If bot also meets conditions, tie-breaking applies ($300M threshold)
5. **Verify:** Game resolves correctly

---

## Section 9: Robust Error Handling and Turn Recovery

**Prereqs:** Section 6 complete.

### Test 9.1: Extended play — no freezes
1. Start a game with 1 human + 3 bots
2. Play for 50+ active turns (each bot turn counts separately)
3. **Verify:** Zero game freezes — every bot turn completes and advances
4. **Verify:** No error modals or broken UI states

### Test 9.2: Retry visibility in debug overlay
1. Play many turns and watch the debug overlay
2. **Verify:** If any retries occur, they are visible:
   - "Attempt 1/3 failed: {reason}. Retrying with next option."
3. **Verify:** Color coding: green = success, yellow = retry, red = fallback

### Test 9.3: Fallback to PassTurn
1. Play until a bot is in a difficult position (no good options)
2. **Verify:** If the bot exhausts all options, it falls back to PassTurn
3. **Verify:** Debug overlay shows: "All options exhausted. Falling back to PassTurn."
4. **Verify:** Turn still advances — game does not freeze

### Test 9.4: Turn timeout (30s)
1. This is hard to trigger organically — check server logs for any timeout references
2. **Verify:** No bot turn takes longer than 30 seconds (check timing in debug overlay)
3. If a turn approaches 30s, **verify** it force-completes with PassTurn

### Test 9.5: State integrity
1. After several bot turns, check the debug overlay
2. **Verify:** "State integrity OK" messages (or no integrity warnings)
3. Spot-check: does the bot's money match expected (starting money - track costs - fees + delivery income)?

### Test 9.6: Server logs clean
1. After an extended play session, check server logs
2. **Verify:** No unhandled exceptions
3. **Verify:** Any `[BOT:ERROR]` entries are paired with successful recovery (retry or fallback)
4. **Verify:** No errors result in a game freeze

### Test 9.7: Multiple bot errors in sequence
1. Play a game with 5 bots
2. Play for many turns
3. **Verify:** Even if multiple bots encounter issues in the same round, all recover
4. **Verify:** Turn order is maintained correctly throughout

---

## Section 10: Archetype and Skill System

**Prereqs:** Sections 7 and 9 complete.

### Test 10.1: Backbone Builder behavior
1. Create a game with 1 human + 1 Backbone Builder (Hard)
2. Play 15-20 turns, watch Strategy Inspector
3. **Verify:** Bot builds a central trunk line before branching
4. **Verify:** Scoring breakdown shows high weight on "network connectivity" or similar
5. **Verify:** Bot avoids building isolated/disconnected track segments

### Test 10.2: Freight Optimizer behavior
1. Create a game with 1 human + 1 Freight Optimizer (Hard)
2. Play 15-20 turns
3. **Verify:** Bot plans multi-stop trips (picks up multiple loads, delivers along a route)
4. **Verify:** Strategy Inspector shows "load combination" or efficiency scores

### Test 10.3: Trunk Sprinter behavior
1. Create a game with 1 human + 1 Trunk Sprinter (Hard)
2. Play 15-20 turns
3. **Verify:** Bot upgrades its train relatively early (within ~10-15 turns)
4. **Verify:** Bot builds direct routes even through expensive terrain (mountains/alpine)
5. **Verify:** After upgrade, bot moves farther per turn (12 instead of 9)

### Test 10.4: Continental Connector behavior
1. Create a game with 1 human + 1 Continental Connector (Hard)
2. Play 15-20 turns
3. **Verify:** Bot prioritizes connecting to major cities even when deliveries pay less
4. **Verify:** Bot's major city count grows faster than other archetypes typically

### Test 10.5: Opportunist behavior
1. Create a game with 1 human + 1 Opportunist (Hard)
2. Play 15-20 turns
3. **Verify:** Bot chases the highest-paying delivery available each turn
4. **Verify:** Bot may pivot strategy frequently as new demand cards are drawn
5. **Verify:** Strategy Inspector shows "immediate income" weighted heavily

### Test 10.6: Easy vs Hard comparison
1. Create a game with 1 human + 1 Easy Opportunist + 1 Hard Opportunist
2. Play 20+ turns
3. **Verify:** Hard bot earns money faster and makes better decisions
4. **Verify:** Easy bot occasionally makes suboptimal choices (visible in Strategy Inspector as "random selection" or similar notes)
5. **Verify:** Both bots function without errors

### Test 10.7: All 15 combinations functional
1. For each archetype (5) at each skill level (3), create a quick game and verify:
   - Bot takes turns without errors
   - No crashes or freezes
2. (This can be done across multiple short sessions — doesn't need to be one marathon test)

### Test 10.8: Archetype display in Strategy Inspector
1. Open Strategy Inspector during a bot turn
2. **Verify:** Archetype name and philosophy/description shown
3. **Verify:** Archetype multipliers are visible in the scoring breakdown
4. **Verify:** Skill-level effects shown (e.g., "Easy: 20% random choices applied")

---

## Section 11: Turn Animations and UX Polish

**Prereqs:** Section 6 complete.

### Test 11.1: Thinking indicator
1. Start a game with 1 human + 1 bot
2. Take your turn, click "Next Player"
3. **Verify:** Bot's name/icon in the leaderboard pulses or animates (thinking indicator)
4. **Verify:** A toast notification appears: "Bot is thinking..." (or similar)

### Test 11.2: Track building animation
1. Watch the bot's turn
2. **Verify:** Track segments animate in (draw sequentially, not all at once)
3. **Verify:** Track draws in the bot's assigned color
4. **Verify:** Animation looks like the same crayon-drawing effect humans get

### Test 11.3: Train movement animation
1. Watch the bot move its train
2. **Verify:** Train sprite slides/animates along the path (not instant teleportation)
3. **Verify:** Movement follows the track (not a straight line through empty space)

### Test 11.4: Turn completion feedback
1. After the bot finishes its turn
2. **Verify:** Thinking animation stops
3. **Verify:** A toast appears: "Bot finished their turn." (or similar)
4. **Verify:** Brief pause (~0.5-1s) before the next turn starts

### Test 11.5: Natural pacing
1. Watch a complete bot turn with all actions (move + build + pickup/delivery)
2. **Verify:** Total turn feels natural — approximately 2-4 seconds
3. **Verify:** Actions are sequenced visually (not all simultaneous):
   - Thinking → movement → pickup/delivery → track building → done

### Test 11.6: Multiple bots pacing
1. Create a game with 1 human + 3 bots
2. Watch the sequence of 3 bot turns
3. **Verify:** Each bot's turn is visually distinct (clear start/end per bot)
4. **Verify:** Total time for 3 bots is reasonable (~8-12 seconds with animations)

### Test 11.7: Fast bot turns setting
1. Find the game settings (gear icon or settings menu)
2. Enable "Fast Bot Turns" (or equivalent toggle)
3. Watch bot turns
4. **Verify:** All animations are skipped — turns complete near-instantly
5. **Verify:** Game state still updates correctly (track appears, train moves, money changes)

### Test 11.8: Debug overlay during animations
1. Open the debug overlay
2. Watch a bot turn with animations
3. **Verify:** Debug overlay remains functional and readable during animations
4. **Verify:** Socket events log in real-time during the animated sequence

---

## Section 12: Train Upgrades and Advanced Actions

**Prereqs:** Section 6 complete.

### Test 12.1: Bot upgrades its train
1. Play a long game with 1 human + 1 bot (or a Trunk Sprinter archetype for faster testing)
2. **Verify:** At some point the bot upgrades from Freight to Fast Freight or Heavy Freight
3. **Verify:** Debug overlay shows train type changed
4. **Verify:** Bot paid $20M for the upgrade (money decreased)

### Test 12.2: Post-upgrade behavior
1. After the bot upgrades to Fast Freight
2. **Verify:** Bot now moves 12 mileposts/turn instead of 9
3. **Verify:** Strategy Inspector reflects the new train capabilities in option scoring

### Test 12.3: Upgrade vs build mutual exclusion
1. Watch the bot on the turn it upgrades
2. **Verify:** Bot did NOT also build track on that same turn
3. (Exception: crossgrade allows up to $15M building — verify if applicable)

### Test 12.4: Valid upgrade paths
1. Over a long game, track all the bot's upgrades
2. **Verify:** Upgrades follow valid paths:
   - Freight → Fast Freight OR Heavy Freight ($20M each)
   - Fast Freight OR Heavy Freight → Super Freight ($20M)
3. **Verify:** No invalid transitions (e.g., Freight → Super Freight directly)

### Test 12.5: Upgrade strategy in Strategy Inspector
1. When the bot upgrades, check Strategy Inspector
2. **Verify:** UpgradeTrain option was scored against alternatives
3. **Verify:** The bot chose to upgrade because it scored higher than building/moving/delivering

### Test 12.6: Discard hand action
1. This is rare — watch for it over many turns
2. If it occurs, **verify:** Bot discards all 3 demand cards and draws 3 new ones
3. **Verify:** Debug overlay shows "Bot discarded hand — drew 3 new cards"
4. **Verify:** Bot still has exactly 3 demand cards after discarding

### Test 12.7: Ferry crossing (if applicable)
1. If the bot's route crosses a ferry port:
2. **Verify:** Bot stops at the ferry port (loses remaining movement)
3. **Verify:** On the next turn, bot crosses at half speed
4. **Verify:** Movement rules are followed correctly

### Test 12.8: All actions use shared services
1. Check server logs for bot upgrade/discard/ferry actions
2. **Verify:** No errors or FK violations
3. **Verify:** Actions use the same service functions that humans use

---

## Quick Regression Checklist (Run After Every Section)

After completing testing for a section, run these quick checks:

- [ ] Create a human-only game (no bots) — start and play 2-3 turns — everything works normally
- [ ] Create a game with 1 human + 1 bot — start and play through initial build into active phase
- [ ] No errors in browser console
- [ ] No unhandled exceptions in server logs
- [ ] Track building works for the human
- [ ] Turn advancement works for the human
- [ ] Debug overlay (if available) shows accurate data

---

## Test Environment Notes

- **Browser:** Use Chrome DevTools console (F12) to watch for JavaScript errors
- **Server logs:** Watch the terminal running `npm run dev` for server-side errors
- **Database:** If needed, connect to the database to verify data (e.g., `psql` or a GUI client)
- **Debug overlay:** After Section 2, always have this open during testing — it's your primary diagnostic tool
- **Multiple browser tabs:** For multi-human games, open multiple tabs/incognito windows
