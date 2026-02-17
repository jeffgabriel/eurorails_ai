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

### 15. Heuristic cost estimates must account for terrain variation
A flat average cost per segment (e.g., 1.5M) systematically underestimates routes through expensive terrain (Alpine 5M, ferries 4-16M) and over-estimates flat routes. Sample terrain along the straight-line path to get route-specific averages.

### 16. Budget penalties must apply to ALL chains, including carried loads
Even when the bot is already carrying a load, the delivery route may be unaffordable. Skipping the budget penalty for hasLoad chains causes the bot to commit to expensive routes it can never complete.

### 17. Starting city selection requires demand-aware evaluation
When the bot has no track, using all major city outposts as "distance 0" start positions makes every chain appear equally reachable. The starting city should be chosen by evaluating which hub enables the cheapest first delivery.

### 18. Build targets must match chain strategy, not just load availability
When building toward a pickup city, the targets passed to pathfinding must be the specific city chosen by chain ranking, not all cities where that load is available. Pathfinding always picks the easiest-to-reach target, which may be geographically wrong for the chain (e.g., Iron near Kaliningrad instead of Iron at Birmingham near delivery city Antwerpen).

### 19. Every generated option type must be reachable from the decision engine
If an option type exists in OptionGenerator and Scorer but its ActionType is not included in the phase's action filter set, the bot can never choose it. Audit all ActionType sets when adding new option types.

---

## Investigation Log — 2026-02-16: Bot Strategic Decision Bugs

### Context
Game 843fa390: Bot picked London as starting city, built toward Birmingham (Steel→Venezia chain), then picked up 2x Tourists and committed to building toward Oslo (30M delivery). With only 37M cash and an estimated 48-80M build cost to Oslo, the bot got permanently stuck oscillating with 12M and 2 undeliverable Tourists.

### Bug 1: Ferry-unaware pathfinding (FIXED — `97ac695`)
**Severity**: Critical | **File**: `computeBuildSegments.ts`

`computeBuildSegments` Dijkstra only expanded via `getHexNeighbors()` — no concept of ferry crossings. The bot could build TO a ferry port but never cross to the other side. Affected all water-separated routes: England↔Ireland, English Channel, Denmark↔Sweden.

**Fix**: Built `ferryAdjacency` map from `getFerryEdges()`, expanded ferry partner ports in Dijkstra loop at zero crossing cost (port build cost already paid), added `ferryEdgeKeys` set to skip ferry edges in `extractSegments`/`countNewSegments`.

### Bug 2: extractSegments contiguity break (FIXED — `a152bc4`)
**Severity**: High | **File**: `computeBuildSegments.ts`

When extracting segments from a Dijkstra path, skipping built or ferry edges mid-sequence broke contiguity (`seg[n].to ≠ seg[n+1].from`). PlanValidator rejected these as invalid, consuming retry budget.

**Fix**: Changed `continue` to `break` when skipping built/ferry edges after segments have already been emitted — preserves the contiguous prefix.

### Bug 3: No minimum build budget threshold (FIXED — `a152bc4`)
**Severity**: Medium | **File**: `OptionGenerator.ts`

Bot attempted builds with 1-2M budget, producing single-segment stubs that wasted money without strategic progress.

**Fix**: Added `MIN_BUILD_BUDGET = 5` threshold. Returns infeasible if budget is below minimum.

### Bug 4: No movement reserve (FIXED — `a152bc4`)
**Severity**: Medium | **File**: `OptionGenerator.ts`

Bot spent all money on track, leaving 0M for track usage fees needed to move on opponent track. Got stuck unable to move.

**Fix**: Added `MOVEMENT_RESERVE = 8` (during active game) deducted from available build budget.

### Bug 5: Target city mislabeling (FIXED — `a152bc4`)
**Severity**: Low | **File**: `OptionGenerator.ts`

`identifyTargetCity` detected target by last segment endpoint, which was often a random milepost when budget was insufficient to reach the actual chain target. Caused wrong sticky target bonuses.

**Fix**: Chain target city takes priority over segment endpoint detection.

### Bug 6: Flat cost estimate ignores terrain (FIXED — `c624d5f`)
**Severity**: High | **File**: `OptionGenerator.ts:34`

`AVG_COST_PER_SEGMENT = 1.5` used for all chain cost estimates. Birmingham→Venezia crosses the Alps — actual average terrain cost is ~1.9M/segment (with Alpine hexes at 5M each), making the real build cost ~74M vs the estimated ~59M. Budget penalty never fired for routes that were actually unaffordable.

**Fix**: Added `sampleAvgTerrainCost()` that walks the straight line between source and target, samples actual terrain at each hex, returns route-specific average. Catches Alpine corridors, mountains, cities, ferry ports. Raised fallback from 1.5 to 2.0.

### Bug 7: No budget penalty for hasLoad chains (FIXED — `c624d5f`)
**Severity**: Critical | **File**: `OptionGenerator.ts:940`

When bot carries a load, `rankDemandChains` computed chainScore without ANY affordability check (comment: "must deliver them"). Tourists→Oslo scored 5.0 unchecked while Wine→Paris scored lower. Bot committed all resources to an unaffordable route.

**Fix**: Applied proportional budget penalty `(money/cost)²` when `estimatedBuildCost > bot.money` for hasLoad chains. Originally flat 0.4x, upgraded to proportional in Bug 12 fix.

### Bug 8: Starting city has no demand awareness — FIXED `c624d5f`
**Severity**: Critical | **File**: `OptionGenerator.ts:962-990`

When bot has no track, `rankDemandChains` builds `networkPositions` from ALL 48 major city outposts. `minEuclidean` returns ~0 for ANY major city, making chain ranking blind to which starting city is optimal.

**Fix**: `evaluateHubScore()` picks the hub with best achievable chain score. Applied in commit `c624d5f`.

### Bug 9: Phase 0 eager pickup without affordability check — FIXED `c624d5f`
**Severity**: High | **File**: `Scorer.ts:361-393`

Phase 0 `executeLoadActions` auto-executes pickup options before movement without checking if delivery is affordable.

**Fix**: Scorer's `calculatePickupScore` applies 0.05x penalty when delivery is unreachable AND unaffordable. Applied in commit `c624d5f`.

### Bug 10: pickupTargets includes ALL cities — builds toward wrong city (FIXED — `9ad717e`)
**Severity**: Critical | **File**: `OptionGenerator.ts:1034-1083`

For chain "Iron@Birmingham→Antwerpen", `rankDemandChains` collected grid points from EVERY city where Iron is available into `pickupTargets`. When `computeBuildSegments` received these targets, it picked the path closest to ANY target — which was near Kaliningrad (a source close to an existing start position) instead of Birmingham (the strategically correct choice near delivery city Antwerpen). Bot built 13 segments toward Kaliningrad, then got auto-placed at Berlin, stranding it far from both pickup and delivery cities.

**Root cause**: `pickupTargets` collected ALL cities with the needed load type, not just the best one. The Dijkstra path selection picks the target closest to any reachable endpoint, so it trivially chose the "free" target near Kaliningrad start positions.

**Fix**: For each available city, compute total chain distance (network→pickup + pickup→delivery). Keep only the best city's grid points as `pickupTargets`. Same fix applied to `evaluateHubScore`.

### Bug 11: DiscardHand missing from Phase 2 action types (FIXED — `9ad717e`)
**Severity**: High | **File**: `AIStrategyEngine.ts:190`

Phase 2 `buildActions` set was `[BuildTrack, UpgradeTrain, PassTurn]` — DiscardHand was never included. Bot could never discard hand even when stuck with 11M, no loads, and demand cards requiring cities far from its track. Instead it oscillated endlessly with PassTurn.

**Root cause**: `AIActionType.DiscardHand` was omitted from the Phase 2 action type filter.

**Fix**: Added `AIActionType.DiscardHand` to the `buildActions` set.

---

## Investigation Log — 2026-02-16: Bot Decision-Making Bugs (Game fd7dd66a)

### Context
Game fd7dd66a: Bot started at Szczecin, built toward it (2 hexes away), picked up 2x Potatoes (only 1 demand card), delivered Potatoes→Ruhr for 11M, then got stuck. Picked up Tourists→Valencia (unaffordable), wasted turns discarding hand repeatedly, and spiraled into bankruptcy at 11-12M cash oscillating between discard and build.

### Bug 12: Flat budget penalty too gentle (FIXED — `9ad717e`)
**Severity**: Critical | **File**: `OptionGenerator.ts`

Budget penalty was a flat `0.4x` multiplier regardless of HOW over-budget a chain was. A chain costing 60M with 22M cash got the same 0.4x as one costing 21M with 20M cash. This meant wildly unaffordable chains (3x over budget) still scored competitively, causing the bot to commit to routes it could never complete.

**Root cause**: `chainScore *= 0.4` applied uniformly to all over-budget chains in both hasLoad and non-hasLoad branches of `rankDemandChains`, plus `evaluateHubScore`.

**Fix**: Replaced with proportional penalty `(money/cost)²`. Examples: 20M/21M → 0.91x (barely over), 22M/60M → 0.13x (wildly over), 37M/80M → 0.21x. Applied in all 3 locations.

### Bug 13: Duplicate load pickup — 2x load with 1 demand card (FIXED — `9ad717e`)
**Severity**: High | **File**: `OptionGenerator.ts:549`

`generatePickupOptions` generated one option per available load TYPE, but the Phase 0 pickup loop re-generates options each iteration. After picking up Potatoes once, the same demand card still matched, generating another Potatoes pickup. Bot carried 2x Potatoes with only 1 demand card, wasting a cargo slot.

**Root cause**: No check comparing carried load count against matching demand card count per load type.

**Fix**: Count demand cards needing each load type, subtract already-carried count, skip if `carriedCount >= demandCount`.

### Bug 14: Phase 0 eager pickup of unaffordable loads (FIXED — `9ad717e`, regressed, re-fixed `114cef7`)
**Severity**: High | **File**: `AIStrategyEngine.ts:418`

`executeLoadActions` auto-executed ANY pickup with a positive score. Unaffordable pickups (e.g., Tourists→Valencia with estimated 60M build cost vs 22M cash) scored ~3.5 after the 0.05x penalty — still positive. Bot eagerly grabbed loads it couldn't deliver, filling cargo with dead weight.

**Root cause**: No minimum score threshold in the pickup execution loop.

**Fix**: Added `MIN_PICKUP_SCORE = 10` gate. Pickups scoring below 10 (heavily penalized unreachable/unaffordable loads) are skipped with a log message.

### Bug 15: Build budget waste — pickup close, delivery far (FIXED — `9ad717e`, regressed, re-fixed `114cef7`)
**Severity**: Medium | **File**: `OptionGenerator.ts:795`

When the top-ranked chain's pickup city was close (e.g., Szczecin 2 hexes away), `computeBuildSegments` used only 4M of a 20M budget. The remaining 16M went unused — the bot could have continued building toward the delivery city.

**Root cause**: `generateBuildTrackOptions` called `computeBuildSegments` once per chain, toward either pickup OR delivery, never both.

**Fix**: After the primary build, if cost < 50% of budget AND building toward pickup (not delivery), do a continuation build toward delivery with remaining budget using extended start positions that include the new segment endpoints.

### Bug 16: Discard death spiral — unlimited consecutive discards (FIXED — `9ad717e`, regressed, re-fixed `114cef7`)
**Severity**: Medium | **Files**: `Scorer.ts:580`, `GameTypes.ts:BotMemoryState`, `AIStrategyEngine.ts`

After delivering Potatoes and getting stuck with unaffordable/unreachable demand cards, bot scored DiscardHand at 20 (desperate). Drew new cards, still bad, discarded again. Repeated 5+ times, losing 5+ turns to pure discarding while never building or moving.

**Root cause**: No limit on consecutive discards. `calculateDiscardScore` didn't check history.

**Fix**: Added `consecutiveDiscards` field to `BotMemoryState`, tracked in all memory update paths. `calculateDiscardScore` returns -1 after 2 consecutive discards (must be below PassTurn's 0), forcing the bot to build/move before trying again.

---

### Design Principles (continued)

### 20. Budget penalties must be proportional to overspend
A flat penalty (e.g., 0.4x) for any over-budget chain treats "barely over" the same as "3x over." Use `(money/cost)²` so slightly over-budget chains remain viable while wildly unaffordable ones drop to near-zero.

### 21. Pickup count must not exceed demand card count
When generating pickup options, count matching demand cards per load type and limit pickups accordingly. The Phase 0 loop re-generates options after each pickup, so the same demand card can match repeatedly without this check.

### 22. Auto-execution needs a minimum confidence threshold
Any action that auto-executes in a loop (Phase 0 pickups, deliveries) needs a score floor. Heavily penalized options (unreachable, unaffordable) can still be positive — below-threshold options should be skipped.

### 23. Use the full budget — continuation builds
When a chain's primary build target is close and uses less than half the budget, continue building toward the chain's other endpoint (delivery city) with the remaining budget. Don't waste 80% of the build budget on a 2-hex path.

### 24. Limit consecutive identical actions to prevent death spirals
Actions that sacrifice a full turn (like DiscardHand) need consecutive-use limits. Without limits, a bot in a bad state can loop the same desperate action indefinitely, never recovering.

### 25. Continuation builds must preserve segment contiguity
When appending a second Dijkstra call's segments to a primary path, the second call must start ONLY from the last segment's endpoint — not from all endpoints of the combined existing track. Multi-source Dijkstra picks whichever source is closest to the target, which may be the FIRST segment of the primary path, breaking `seg[n].to === seg[n+1].from`.

### 26. Pickup score thresholds must account for free pickups
A minimum score threshold for auto-pickup must not block pickups that are free (bot is already at the city). Phase 0/1.5 pickups cost zero movement — even low-scoring pickups are worth taking when the alternative is wasting a cargo slot. Use `<= 0` (hard rejection only), not a positive threshold.

### 27. Tiebreaker scores must produce strict ordering
When a "blocked" action returns score 0 to prevent selection, it ties with other score-0 actions (like PassTurn). Sort order determines the winner, defeating the intent. Blocked actions must return -1 (or any value strictly below the lowest legitimate score) to ensure they always lose.

---

## Investigation Log — 2026-02-17: Regression Bugs from Game 43deb4a7

### Context
Game 43deb4a7: Bot started at Holland, built toward Antwerpen (Cars→Antwerpen chain), then bounced between Holland and Antwerpen for 8 turns with zero deliveries. Built toward Le Havre ferry port (not a bug — same total cost as Calais route), but never completed any chain. Orphaned track segments outside Antwerpen were a side effect of Bug 17.

### Bug 17: Continuation build produces non-contiguous segments (REGRESSION, FIXED — `114cef7`)
**Severity**: Critical | **File**: `OptionGenerator.ts:798`

Bug 15's continuation build fix passed `combinedExisting = [...existingSegments, ...segments]` to `computeBuildSegments`. At line 235, the function extracts ALL endpoints as Dijkstra sources. The Dijkstra picked whichever source was closest to the delivery target — often the FIRST segment of the primary path, not the LAST. Combined segments had a contiguity break (`seg[n].to ≠ seg[n+1].from`) → PlanValidator rejected → top option failed every turn.

**Root cause**: `computeBuildSegments` line 235: `const sources = trackEndpoints.length > 0 ? trackEndpoints : startPositions;` — when existingSegments has entries, explicit startPositions are IGNORED.

**Fix**: Changed continuation to start ONLY from last primary segment endpoint, passing empty existingSegments so `computeBuildSegments` uses the explicit startPositions.

### Bug 18: MIN_PICKUP_SCORE=10 blocks free pickups (REGRESSION, FIXED — `114cef7`)
**Severity**: Critical | **File**: `AIStrategyEngine.ts:418`

Bug 14's fix used `MIN_PICKUP_SCORE = 10` threshold. Phase 0/1.5 pickups are at the current city (free — zero movement cost). The 0.05x unaffordable penalty dropped Flowers→Belfast from 62.5 to 3.125, below the threshold. Bot sat at Holland with a 25M Flowers demand card but never picked up. No pickups → no income → no recovery.

**Root cause**: Threshold of 10 was too high for penalized-but-still-worth-taking free pickups.

**Fix**: Changed threshold from `< 10` to `<= 0`. Only score=0 (hard rejection from stacking unreachable loads) is blocked.

### Bug 19: DiscardHand score=0 ties with PassTurn=0 (REGRESSION, FIXED — `114cef7`)
**Severity**: Medium | **File**: `Scorer.ts:580`

Bug 16's fix returned 0 when `consecutiveDiscards >= 2`, intended to block further discards. But PassTurn also scored 0. DiscardHand appeared first in sort and won the tie. Bot discarded 4+ consecutive times despite the "limit of 2."

**Root cause**: Score 0 = PassTurn score 0 → tie broken by sort order, not intent.

**Fix**: Changed `calculateDiscardScore` from returning 0 to returning -1 when blocked, so PassTurn (0) always wins.

### Bug 20: Movement toward frontier instead of chain target (OPEN — not fixed)
**Severity**: Medium | **File**: `Scorer.ts` (movement scoring)

Turn 3 showed bot moving toward Zurich (frontier bonus, score 19.72) instead of Stuttgart (chain target, score 16.08). The movement scorer's frontier bonus (distance from existing track) outweighed chain-target relevance.

**Status**: Not fixed. Medium priority — does not cause stuck states, just suboptimal movement.
