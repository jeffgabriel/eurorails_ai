# Section 2: Debug Overlay Foundation

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

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

## Related User Journeys

The debug overlay is used throughout all journeys as the primary tool for observing bot behavior. It does not have a dedicated user journey, but is referenced in:

- **Journey 1, Turn 2+**: The debug overlay shows bot turn start/complete events, track building details, money changes, and position updates during every bot turn.
- **Journey 2**: The socket event log in the debug overlay is critical for verifying that `turn:change` events fire correctly (no duplicates) during rapid-fire bot turns.
- **Journey 3, Scenario E**: The debug overlay evolves into the Strategy Inspector (Section 7), showing complete AI decision-making transparency.
- **Journey 4**: Error and recovery information displays in the debug overlay for edge cases and failure modes.
