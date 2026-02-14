# Common Implementation Pitfalls — AI Bot Development

> Catalog of high-risk areas in AI bot implementation for EuroRails Online. Each pitfall describes what can go wrong, why, and how to prevent it. Organized by risk category.
>
> See also: [Implementation Invariants](./system-architecture.md#7-implementation-invariants) for the concise rule set derived from these pitfalls.

---

## Category 1: Client Race Conditions During Bot Turns

### Pitfall: Unguarded `handleTurnChange` with multiple rapid events

**Files**: `src/client/scenes/GameScene.ts:1025` (line numbers approximate — may shift)

When a human clicks "Next Player" and multiple bots execute in sequence, the server emits 3+ `turn:change` socket events within ~15ms. Each triggers `handleTurnChange()` **asynchronously**:

```typescript
private async handleTurnChange(currentPlayerIndex: number): Promise<void> {
    await this.refreshPlayerData();          // <-- ASYNC API CALL (variable latency)
    // ...
    this.gameState.currentPlayerIndex = currentPlayerIndex;
    // ...
    this.uiManager.setupUIOverlay();
}
```

Three concurrent `handleTurnChange(1)`, `handleTurnChange(2)`, `handleTurnChange(0)` calls run simultaneously. Each awaits `refreshPlayerData()` (an HTTP fetch). **The last one to resolve determines the final UI state.** If `handleTurnChange(1)` resolves last (its API response is slowest), the UI ends up showing `currentPlayerIndex = 1` (bot 1's turn) despite the server being at index 0 (human's turn).

**Prevention**: Add a sequence counter to `handleTurnChange`. Each invocation gets an incrementing ID. After async work completes, check if this invocation is still the latest — if not, discard the result.

### Pitfall: POST response triggers additional racing `handleTurnChange`

**Files**: `src/client/services/GameStateService.ts:74-109`

The "Next Player" click also makes a `POST /api/players/updateCurrentPlayer` request. When the response returns, it calls `notifyTurnChange()`, triggering YET ANOTHER `handleTurnChange` call — a 4th concurrent async invocation racing against the 3 from socket events.

**Prevention**: The sequence counter approach handles this too — the POST-triggered invocation races just like the socket-triggered ones, and only the latest wins.

### Pitfall: Redundant double-emit of `turn:change`

**Files**: `src/server/routes/playerRoutes.ts`, `src/server/services/playerService.ts`

`PlayerService.updateCurrentPlayerIndex()` already emits `turn:change`. If the route handler emits it **again**, the client receives 2 socket events for the same index. This creates extra `handleTurnChange` calls, worsening the race, and can cause `BotTurnTrigger` to fire twice for the same bot turn.

**Prevention**: Only emit `turn:change` from the service method, never from the route handler that calls it. Before adding any new `emitTurnChange()` call, trace the full call chain to ensure it's not already emitted downstream.

---

## Category 2: Strategic Intent vs. Executable Action

### Pitfall: OptionGenerator produces "what" without "how"

The OptionGenerator should produce *what* the bot should do ("build toward Paris") AND *how* to do it ("build these specific segments"). If the generated options contain high-level parameters but not concrete `TrackSegment[]` arrays, the TurnExecutor has nothing to execute.

```typescript
// BAD: Strategic intent only
options.push(makeFeasible(AIActionType.BuildTrack, {
    destination: city,        // e.g. "Paris"
    estimatedCost: 12,
    budget: 20,
}));

// GOOD: Includes concrete segments
options.push(makeFeasible(AIActionType.BuildTrack, {
    destination: city,
    estimatedCost: 12,
    budget: 20,
    segments: computedSegments,  // TrackSegment[] with real costs
}));
```

**Prevention**: The OptionGenerator must include a segment-computation step (e.g., `computeBuildSegments()` using Dijkstra) that translates strategic intent into concrete `TrackSegment[]` arrays. The PlanValidator should reject options without segments before they consume retry attempts.

### Pitfall: Silent no-ops in the executor

If the TurnExecutor receives an action with missing data (e.g., no segments for BuildTrack) and returns `null` instead of throwing, every action "succeeds" while doing nothing. The AI reports success while having taken no action.

**Prevention**: In pipelines with retry logic, prefer throwing over silent no-ops. The retry mechanism exists precisely to handle failures gracefully. The AIStrategyEngine catches errors, excludes the failed option, and retries with the next best option.

### Pitfall: No movement action type

The TurnExecutor must support a first-class `MoveTrain` action type. Movement cannot happen implicitly as part of DeliverLoad or PickupAndDeliver — the bot's position must be explicitly updated before attempting pickup/delivery at a target city. Adding a new `AIActionType` requires changes across all pipeline stages (OptionGenerator, Scorer, PlanValidator, TurnExecutor).

**Prevention**: Use exhaustive type checking (`Record<AIActionType, string>` and switch-case coverage) to ensure completeness. TypeScript will flag at compile time when a new action type is missing from any stage.

---

## Category 3: Turn Management

### Pitfall: Bot turn housekeeping omitted

When advancing past a bot's turn, the server must also:
- Increment `players.current_turn_number` for the bot that just finished
- Reset `player_tracks.turn_build_cost` for the bot

The human client's `nextPlayerTurn()` in GameScene handles these, but the bot path bypasses the client entirely. If these are omitted, the bot's `current_turn_number` stays at 1 forever.

**Prevention**: The `BotTurnTrigger.advanceTurnAfterBot()` method must handle all housekeeping that the human client normally does.

### Pitfall: No logging in critical turn advancement path

The bot turn advancement path is the most critical server-side code path. Without logging, it's impossible to confirm whether it runs, which player it advances to, or what errors occur.

**Prevention**: Log at entry, exit, and all decision points. Include game ID, player ID/name, turn number, and action taken.

### Pitfall: Bot turns fire after game ends

If the turn advancement method doesn't check `game.status`, bot turns can continue executing after a game is `completed` or `abandoned`.

**Prevention**: Check game status before executing any bot turn. Also check the `ENABLE_AI_BOTS` feature flag at turn time (not just at lobby endpoints).

---

## Category 4: Dijkstra Pathfinding — Cold Start and Overlap

### Pitfall: Multi-source Dijkstra start/target overlap

When `trackNetworkGraph.size === 0` (no track built yet), the multi-source Dijkstra starts from ALL major city mileposts. If the target city is also a major city, it immediately matches a start node at cost 0, producing a path with 0 edges — semantically useless for "build track FROM here TO there."

**Root cause chain:**
1. Target node is in the start set at cost 0
2. When popped from the PQ, it matches the target check immediately
3. Path has 0 edges → `return null`
4. All BuildTrack options get no segments → TurnExecutor throws → retry exhausted → PassTurn

**Prevention**: Exclude target nodes from the start set. This ensures targets are discovered through actual traversal (cost > 0) and the resulting path has at least one edge.

```typescript
for (const startKey of startNodes) {
  // Skip start nodes that are also targets — we need to DISCOVER these
  // through actual traversal, not initialize them at cost 0
  if (targetSet.has(startKey)) continue;
  // ... initialize at cost 0
}
```

**Important**: Do NOT use `cost > 0` as a target match guard instead. This appears to fix the overlap but actually prevents targets from ever being discovered — they get pre-initialized at cost 0 in the PQ, and when discovered through traversal at cost > 0, the update is rejected because the existing cost (0) is lower.

Also add `if (pq.length === 0) return null;` as a safety check for the edge case where ALL start nodes are also targets.

### Pitfall: `estimateBuildCost` returns 0 when network is empty

When `trackNetworkGraph.size === 0`, the heuristic fallback iterates `trackNetworkGraph.keys()` (empty) and finds no reference nodes, returning 0. Code using `if (estimatedCost > 0)` as a guard silently drops the option.

**Prevention**: When the track network is empty, use major city positions as reference points for cost estimation instead of returning 0.

### Pitfall: Segment-less options consume retry budget

If `computeBuildSegments()` returns null but the option is still marked as feasible with a heuristic cost estimate, these structurally invalid options score highest (build actions are prioritized), consume all 3 retry attempts, and force a PassTurn fallback.

**Prevention**: Mark options without concrete segments as `makeInfeasible()` at generation time. Infeasible options are filtered out before scoring, preserving retry budget for genuine transient failures.

### Pitfall: Bot has no track → no position → permanently stuck

Without track, `botPosition` stays null. Without a position, MoveTrain and DeliverLoad options can't be generated. The bot is permanently stuck in a build-only state that produces nothing.

**Prevention**:
1. When the bot has no track, seed Dijkstra from the bot's position (a major city) rather than from track endpoints
2. Provide a `buildInitialTrackSegments()` fallback that picks the closest major city to demand targets and builds hex-neighbor segments outward
3. When the bot has track but no position, auto-place at the best major city on the network before generating options

---

## Category 5: Coordinate System Divergence

### Pitfall: Position columns partially set

`PlayerService.getPlayers()` at `playerService.ts:495` uses `position_x !== null` as the sentinel for "player has a position." If only `position_row` and `position_col` are set (but not `position_x` and `position_y`), the player appears to have no position. This causes cascading failures: auto-place fires every turn, MoveTrain options are never generated, and the client never shows a train sprite.

**Prevention**: Always set ALL 4 position columns together (`position_row`, `position_col`, `position_x`, `position_y`). Compute pixel coordinates from grid using the deterministic formula: `x = col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`, `y = row * 45 + 120`.

### Pitfall: Track segments stored with x=0, y=0

The server-side `buildMapTopology()` may not load pixel coordinates from `gridPoints.json` (the raw data uses `GridX`/`GridY` for column/row, not pixel positions). If segments are created with `x: 0, y: 0`, the client's `drawAllTracks()` renders all tracks as invisible zero-length lines at the top-left corner.

```typescript
// BAD
segments.push({
  from: { x: 0, y: 0, row: fromPoint.row, col: fromPoint.col, terrain },
  to: { x: 0, y: 0, row: toPoint.row, col: toPoint.col, terrain },
  cost: stepCost,
});
```

**Prevention**: Compute pixel coordinates from grid coordinates using the deterministic formula for EVERY segment endpoint. Alternatively, have the client resolve pixel coordinates at render time from `gridPoints[row][col]` when stored x/y are 0.

### Pitfall: `track:updated` event not emitted from bot code path

The `track:updated` socket event is only emitted from the HTTP route handlers (human track building). If bot track building bypasses the route handler and calls `TrackService.saveTrackState()` directly, the client's `onTrackUpdated` listener never fires, and bot tracks are invisible even if the segments are correct.

**Prevention**: After any bot-initiated `TrackService.saveTrackState()`, emit `track:updated` to the game room. The pattern: after any database write that changes player-visible state, emit the same socket event that the equivalent human-triggered code path emits.

### Pitfall: `refreshPlayerData()` assumes pixel coordinates are correct

When updating train sprites for other players (including bots), `refreshPlayerData()` uses position x/y directly from the server. If the server stored `x: 0, y: 0` (because only row/col were set), the train sprite renders at the top-left corner.

**Prevention**: The client should resolve pixel coordinates from `gridPoints[row][col]` rather than trusting stored pixel values. The `state:patch` handler may already do this — ensure `refreshPlayerData()` does too.

---

## Design Principles (Lessons Learned)

### 1. Silent failures are worse than loud failures
In pipelines with retry logic, prefer throwing over silent no-ops. The retry mechanism exists to handle failures gracefully.

### 2. Strategic intent is not executable action
When a pipeline stage produces output that the next stage consumes, validate the contract at the consumer. The generator must translate intent into concrete data (segments, paths, positions).

### 3. Movement must be a first-class action
Don't assume movement happens implicitly. The bot's position must be explicitly updated before attempting pickup/delivery at a target city.

### 4. Test fixtures don't need to match production topology
New pathfinding/planning logic should degrade gracefully when topology is sparse. Let the executor validate and the retry loop handle edge cases.

### 5. Reuse existing utilities
Reuse battle-tested human player code (`computeTrackUsageForMove()`, `TrackService`, `PlayerService`) rather than reimplementing. This ensures bots and humans follow identical game rules.

### 6. Multi-source Dijkstra needs start/target disjointness
When start and target sets overlap, exclude targets from the start set. The invariant: a found target must have at least one traversed edge.

### 7. Heuristic fallbacks must handle the zero-data case
When the primary data source is empty, use a secondary source rather than returning a sentinel value that causes the caller to skip the operation entirely.

### 8. Validate contracts between pipeline stages
In a Generate → Validate → Execute pipeline, the validator should enforce the same constraints as the executor. Catch problems before they consume retry attempts.

### 9. AI agents need explicit lifecycle phases
Different game phases have different available actions and priorities. Don't use a single "do the best action" loop for all phases.

### 10. Don't patch symptoms — fix data structure invariants
When a graph algorithm produces wrong results, check whether the input data violates the algorithm's assumptions before adding output filters.

### 11. Feasibility should be determined at generation time
Mark structurally impossible options as infeasible at generation time. Preserve retry budget for genuine transient failures.

### 12. Server and client coordinate systems can diverge
When two systems produce the same data type through different paths, the consumer must handle the lowest common denominator. Grid coordinates are authoritative; pixel coordinates should be resolved at render time.

### 13. Audit all readers when adding a new writer
When adding a new code path that writes to shared state, audit all readers. They may have assumptions that hold for the original code path but not the new one.

### 14. Socket events are the client's only signal
After any database write that changes player-visible state, emit the same socket event that the equivalent human-triggered code path emits. If you miss one, the client will never know the state changed.
