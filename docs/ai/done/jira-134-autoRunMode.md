# JIRA-134: Auto-Run Mode — Hands-Free Bot Game Observation

_Allow a human player to toggle "auto-run" so the server automatically advances their turn, enabling full unattended game completion. Designed for observing bot behavior over 100+ turn games without manual intervention._

## Problem

Observing bot games requires clicking "Next Player" every time it's the human's turn. A typical game is ~100 turns with 3 players, meaning ~33 manual clicks spaced minutes apart. You can't walk away — the game stalls on the human's turn indefinitely.

## Solution

Server-driven auto-run mode. When active, the server auto-advances the human's turn (equivalent to clicking "Next Player") whenever it's their turn. The human player takes no actions — just passes.

### Toggle

**Hotkey: `F9`** sends `autorun:toggle` socket event. Works from anywhere in the game scene.

### Server Behavior

1. In-memory `Map<string, Set<string>>` keyed by `gameId` → set of `playerId`s with auto-run enabled
2. In `emitTurnChange()`: after emitting `turn:change`, check if the current player has auto-run on
3. If yes, wait `AUTO_RUN_DELAY_MS` (2000ms — enough for the client to render the turn change), then call `nextPlayerTurn(gameId)` server-side
4. The next `emitTurnChange` fires, bot detection triggers as normal, cycle continues

### Auto-Stop Conditions

- Game completes or is abandoned → clear auto-run for all players in that game
- Player disconnects → clear their auto-run (reconnect requires re-enabling)
- Player manually sends any game action while auto-run is on → clear auto-run (they're taking control)

### UI Indicator

Small persistent badge in the top-right corner of the game scene (outside the debug overlay so it's visible with overlay closed):
- **ON**: Green pill badge — `AUTO-RUN` in white text on green background
- **OFF**: Badge hidden (no visual clutter)
- Badge appears/disappears on toggle with no animation

### Socket Events

| Event | Direction | Payload | Effect |
|-------|-----------|---------|--------|
| `autorun:toggle` | Client → Server | `{ gameId, playerId }` | Toggle auto-run for this player in this game |
| `autorun:status` | Server → Client | `{ enabled: boolean }` | Confirm toggle, client updates badge |

### Implementation Touch Points

| File | Change |
|------|--------|
| `src/server/services/socketService.ts` | Add `autorun:toggle` handler, auto-run state map, hook into `emitTurnChange` |
| `src/server/services/gameService.ts` | `nextPlayerTurn` — already exists, just call it from the auto-run hook |
| `src/client/scenes/GameScene.ts` | Add `F9` key listener, emit `autorun:toggle`, listen for `autorun:status` |
| `src/client/components/AutoRunBadge.ts` | New — small Phaser text object positioned top-right, show/hide on status |

### Edge Cases

- **Tab sleep**: Not a problem — server drives the auto-advance, client is passive
- **Multiple humans**: Each player toggles independently. Two humans can both auto-run.
- **Human is active player when toggled ON**: Auto-advance fires on next turn change, not immediately. The current turn still needs manual "Next Player" (or the auto-run kicks in on their _next_ turn).
- **Bot turn in progress**: No conflict — auto-run only fires for the flagged human player. Bot turns use `BotTurnTrigger` as usual.
- **`hasConnectedHuman` gate**: Auto-run humans are still connected via socket, so the bot turn gate passes normally.

### What This Does NOT Do

- Does not play the human's turn with AI (no track building, no deliveries). Just passes.
- Does not persist across server restarts (in-memory only — intentional for a dev/observation tool).
- Does not appear in production UI or lobby — hotkey only.
