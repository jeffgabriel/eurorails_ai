# Section 4: Bot Builds Track — First Real Action

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

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

## Related User Journeys

### Journey 1: Turn 2 — Heinrich Builds Track (Initial Build)

**On the server**, `AIStrategyEngine.takeTurn()` executes:
- `WorldSnapshotService` captures game state → Heinrich has no track, no position
- `AIStrategyEngine` detects Heinrich has no position → auto-places at best major city for his demand cards: sets all 4 position columns (`position_row`, `position_col`, `position_x`, `position_y`)
- `OptionGenerator.generate()` → sees `gamePhase: 'initialBuild'` → only generates `BuildTrack`, `BuildTowardMajorCity`, and `PassTurn` options
- Dijkstra seeds from Heinrich's position (major city) since he has no track
- `Scorer` evaluates options by `backbone_builder` archetype weights
- `PlanValidator` validates the chosen plan
- `TurnExecutor` builds track segments via `TrackService.saveTrackState()`

Server emits `track:updated` → Alice's client calls `loadExistingTracks()` → **Heinrich's track segments appear on the map in Heinrich's color**

### Journey 3: Scenario B — Bot Builds Track (Mid-Game)

1. `TurnExecutor.handleBuildTrack()` saves segments via `TrackService.saveTrackState()`
2. Route emits `track:updated` socket event
3. Alice's client receives `track:updated` → calls `trackManager.loadExistingTracks()` → `drawAllTracks()`
4. **New track segments appear on the map in Heinrich's color** (e.g., blue lines from München toward Praha)
5. Alice can see the bot's strategy developing — which cities it's connecting
