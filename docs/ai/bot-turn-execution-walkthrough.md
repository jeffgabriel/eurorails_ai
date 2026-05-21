# Bot Turn Execution: Step-by-Step Code Walkthrough

This document traces exactly what the code does during a single bot turn, from
the moment the game signals "it's the bot's turn" to the moment the turn
advances to the next player. Every step references the actual function that
runs. No interpretation or intent — just what happens.

---

## 1. Entry Point: `BotTurnTrigger.onTurnChange()`

**File:** `src/server/services/ai/BotTurnTrigger.ts`

Called by `emitTurnChange()` as a side effect after the `turn:change` socket
event is emitted. Receives `gameId`, `currentPlayerIndex`, and
`currentPlayerId`.

### 1.1 Gate checks (lines 66–100)

The function runs these checks sequentially. If any fails, it returns
immediately and the bot does nothing.

1. **Feature flag:** `isAIBotsEnabled()` reads `ENABLE_AI_BOTS` env var.
   Returns early if false.
2. **Is-bot check:** Queries `players` table for `is_bot`. Returns early if the
   current player is not a bot.
3. **Game status check:** Queries `games` table for `status`. If
   `completed` or `abandoned`, calls `clearMemory()` and returns.
4. **Double-execution guard:** Checks the in-memory `pendingBotTurns` Set. If
   the gameId is already in the set (another bot turn is running for this game),
   the turn is queued into `queuedBotTurns` Map and the function returns.
5. **Human-connected check:** `hasConnectedHuman()` checks Socket.IO room
   membership. If no human is connected, the turn is queued into
   `queuedBotTurns` and the function returns.

### 1.2 Pre-execution housekeeping (lines 102–128)

The gameId is added to `pendingBotTurns`. Then:

1. **Delay:** Awaits a 1500ms setTimeout (`BOT_TURN_DELAY_MS`). This is a
   fixed pause to give the UI time to animate the previous turn.
2. **Turn number read:** Queries `current_turn_number` from the `players`
   table.
3. **Socket emit:** Emits `bot:turn-start` to all clients in the game room.
4. **Turn number increment:** `UPDATE players SET current_turn_number =
   COALESCE(current_turn_number, 0) + 1`.
5. **Build cost reset:** `UPDATE player_tracks SET turn_build_cost = 0` for
   this bot in this game.

All housekeeping is wrapped in a try/catch — failures log but do not abort the
turn.

### 1.3 Pipeline execution (line 132)

Calls `AIStrategyEngine.takeTurn(gameId, currentPlayerId)` and awaits the
result (a `BotTurnResult`).

### 1.4 Post-execution (lines 136–300)

After the pipeline returns:

1. **Audit persist:** Writes LLM decision metadata (reasoning, model, latency,
   tokens, guardrail overrides) to `bot_turn_audits` table. Best-effort.
2. **Socket emit:** Emits `bot:turn-complete` with the full result payload
   (action, segments built, cost, loads picked up/delivered, movement path,
   reasoning, demand ranking, debug overlay data, action timeline, etc.).
3. **NDJSON game log:** Calls `appendTurn()` to write a structured log entry
   to a per-game NDJSON file on disk.
4. **Victory check:** Calls `checkBotVictory()` which:
   - Reads `VictoryService.getVictoryState()` — skips if already triggered.
   - Reads bot money and debt from DB, computes net worth.
   - If net worth >= threshold: reads track segments, calls
     `getConnectedMajorCities()`, checks if >= 7 connected.
   - If both conditions met: calls `VictoryService.declareVictory()`, emits
     `victoryTriggered` socket event.
5. **Final turn resolution:** Calls `checkAndResolveFinalTurn()` which checks
   `VictoryService.isFinalTurn()`. If true, calls
   `VictoryService.resolveVictory()` and emits `gameOver` or `tieExtended`.
   This runs BEFORE advancing the turn index.
6. **Turn advancement:** Calls `advanceTurnAfterBot()`:
   - If game status is `initialBuild`: delegates to
     `InitialBuildService.advanceTurn()`.
   - If game status is `active`: computes
     `(current_player_index + 1) % playerCount` and calls
     `PlayerService.updateCurrentPlayerIndex()`.
   - If `completed` or `abandoned`: does nothing.

### 1.5 Cleanup (lines 288–301)

In the `finally` block:

1. Removes gameId from `pendingBotTurns`.
2. Checks `queuedBotTurns` for a chained turn. If found, deletes it from the
   map and calls `onTurnChange()` again (fire-and-forget via `.catch()`).

---

## 2. The AI Pipeline: `AIStrategyEngine.takeTurn()`

**File:** `src/server/services/ai/AIStrategyEngine.ts`

This is the core orchestrator. It runs a 5-stage pipeline and returns a
`BotTurnResult`.

### 2.1 Setup (lines 182–205)

1. **Load bot memory:** `getMemory(gameId, botPlayerId)` returns the
   in-memory state object for this bot (active route, turn count, delivery
   count, no-progress turns, last reasoning, etc.).
2. **Initialize decision logger:** `initTurnLog()` sets up structured logging
   for this turn.

### Stage 1: Capture World Snapshot (line 193)

Calls `WorldSnapshotService.capture(gameId, botPlayerId)`.

**File:** `src/server/services/ai/WorldSnapshotService.ts`

Executes a single SQL query joining `games`, `players`, and `player_tracks`.
Builds a `WorldSnapshot` containing:
- Game status
- Bot player data: money, position (row/col), train type, hand (demand card
  IDs), loads (carried cargo), bot config, existing track segments
- Resolved demands: for each card ID in the bot's hand, looks up the card from
  `DemandDeckService` and resolves load type, delivery city, and payment
- Opponent snapshots: position, loads, track segments for all other players
- All player tracks (for track usage fee calculations)
- Hex grid (full map data)

WHY? **Auto-placement:** If the bot has no position but has track, and the game is
not in `initialBuild`, calls `autoPlaceBot()` which places the bot at an
optimal position on its track network.

### Stage 2: Build Game Context (lines 216–254)

Calls `ContextBuilder.build(snapshot, skillLevel, gridPoints)`.

This derives decision-relevant data from the snapshot:
- `canDeliver`: loads the bot is carrying that match a demand card for the city
  the bot is currently at
- `canPickup`: loads available at the bot's current city
- `canBuild`: whether the bot has money and track budget remaining
- `canUpgrade`: whether an upgrade is available and affordable
- `reachableCities`: cities the bot can reach this turn within movement budget
- `citiesOnNetwork`: cities connected to the bot's track network
- `connectedMajorCities`: major cities in the bot's connected network
- `demands`: scored list of all demand card opportunities with estimated costs,
  travel turns, efficiency per turn, supply rarity, etc.
- `position`: bot's current position with city name
- `speed` / `capacity`: from train type
- `phase`: victory phase assessment (early/mid/late/victory-ready)
- `upgradeAdvice`: computed recommendation for train upgrades
- `isInitialBuild`: true if game status is `initialBuild`

Post-build adjustments:
- Injects `deliveryCount` from memory
- Recomputes `upgradeAdvice` with delivery count (gate for early-upgrade
  prevention)
- Injects `enRoutePickups` from active route
- Injects `previousTurnSummary` from memory (last action, reasoning, plan)

### Stage 3: Decision Gate (lines 256–706)

This is the largest section. It has three branches based on the bot's state:

#### Branch A: Initial Build (no active route yet)

**Condition:** `context.isInitialBuild && (!activeRoute || activeRoute.phase !== 'build')`

1. Calls `InitialBuildPlanner.planInitialBuild(snapshot, gridPoints,
   demandScores)` — a purely heuristic planner (no LLM). Evaluates all demand
   card combinations, scores by efficiency (payout / estimated turns /
   build cost), and selects the best single or double delivery route.
2. Creates an `activeRoute` object with phase `'build'`, the chosen stops, and
   a starting city.
3. Calls `TurnExecutorPlanner.execute()` to compute the actual build segments
   for this turn (Phase B).
4. Wraps the result into a `decision` object (no LLM was called — model is
   `'initial-build-planner'`).

#### Branch B: Active Route Exists

**Condition:** `activeRoute` is truthy (set in memory from a previous turn or
from Branch A/C this turn)

1. Logs the current stop index and phase.
2. Calls `TurnExecutorPlanner.execute(activeRoute, snapshot, context, brain,
   gridPoints)` which returns a `TurnExecutorResult` with plans, updated
   route, and a composition trace. (See Section 3 below for details.)
3. If the route was completed: sets `routeWasCompleted = true`.
4. If the route was abandoned: sets `routeWasAbandoned = true`.
5. Otherwise: saves the updated route (advanced stop index, etc.).
6. Wraps into a `decision` — model is `'route-executor'`.

#### Branch C: No Active Route, LLM Available

**Condition:** No active route AND bot has an LLM API key configured

**Pre-step — Auto-deliver (JIRA-170):** If `context.canDeliver` has entries,
the bot delivers each load immediately via `TurnExecutor.executePlan()` before
consulting the LLM. Then re-captures snapshot and rebuilds context so the
TripPlanner sees fresh demand cards.

1. Creates a `TripPlanner` with the LLM brain.
2. Calls `tripPlanner.planTrip(snapshot, context, gridPoints, memory)` — this
   calls the LLM to evaluate demand card combinations and produce a multi-stop
   strategic route.
3. If a route is returned:
   - Calls `RouteEnrichmentAdvisor.enrich()` to add corridor map data.
   - Checks for `upgradeOnRoute` flag from LLM — if set, calls
     `tryConsumeUpgrade()` to validate and queue an upgrade action.
   - **Dead load check:** `TurnExecutorPlanner.findDeadLoads()` identifies
     carried loads with no matching demand card. If found and bot is at a city,
     creates `DropLoad` plans.
   - **Cargo conflict check:** If planned pickups exceed free train capacity
     and skill level is not Easy:
     - First tries upgrade-before-drop: if a capacity-increasing upgrade is
       available and affordable, asks the LLM whether to upgrade instead of
       dropping.
     - If not upgrading: identifies carried loads not in route delivery stops
       and asks the LLM which to drop.
   - Calls `TurnExecutorPlanner.execute()` to plan the first step of the new
     route.
   - Prepends any dead load drops to the plan.
   - Wraps into a `decision` — model is from the LLM.
4. If route planning failed:
   - Calls `ActionResolver.heuristicFallback()` as a last resort.
   - If heuristic also fails: passes the turn.

#### Branch D: No LLM Key

Creates a PassTurn decision with model `'no-api-key'`.

### Stage 3b: Validate Plan (lines 720–770)

Calls `TurnValidator.validate(decision.plan, context, snapshot)`.

**File:** `src/server/services/ai/TurnValidator.ts`

Checks 7 hard gates (synchronous, no LLM):
1. **BUILD_UPGRADE_EXCLUSION:** Cannot have both BuildTrack and UpgradeTrain in
   one turn.
2. **PHASE_B_BUDGET_CAP:** Total build + upgrade cost cannot exceed 20M.
3. **MAJOR_CITY_BUILD_LIMIT:** Cannot build more than 2 track sections from a
   major city milepost in one turn.
4. **CITY_ENTRY_LIMIT:** Cannot exceed track limits for small (2 players) or
   medium (3 players) cities.
5. **FERRY_STOP_RULE:** Train must stop at ferry port (movement ends).
6. **SAME_CARD_DOUBLE_DELIVERY:** Cannot deliver two loads from the same demand
   card in one turn.
7. **CASH_SUFFICIENCY:** Bot must have enough cash for build cost plus track
   usage fees.

If a violation is found: strips Phase B actions (BUILD/UPGRADE) from the plan
and re-validates. If still invalid, proceeds with the best-effort plan.

### Stage 3c: Route State Tracking (lines 772–815)

- Scans composed steps for deliveries — sets `hasDelivery` flag.
- If a delivery occurred and route is still active, preserves remaining stops
  for LLM context continuity.
- If route was completed, simulates plan effects on a cloned snapshot and runs
  `ActionResolver.heuristicFallback()` to fill remaining budget (but blocks
  speculative BuildTrack per JIRA-97).

### Stage 3e: Dead Load Drops (lines 818–823)

If `deadLoadDropActions` were created earlier (Branch C), prepends them to the
final plan.

### Stage 4: Guardrail Enforcement (lines 825–848)

Calls `GuardrailEnforcer.checkPlan(decision.plan, context, snapshot,
noProgressTurns, hasActiveRoute)`.

**File:** `src/server/services/ai/GuardrailEnforcer.ts`

Checks guardrails in priority order:

1. **G1 — Force Deliver:** If `canDeliver` has entries and the plan is not
   already a DeliverLoad, overrides the entire plan to deliver the
   highest-payout opportunity. Highest priority — trumps everything.
2. **Stuck Detection:** If `noProgressTurns >= 3` AND plan is not DiscardHand
   AND no active route AND no deliverable load on network, overrides to
   DiscardHand.
3. **G3 — Block Upgrade in Initial Build:** If game is in initialBuild and plan
   is UpgradeTrain, overrides to PassTurn.
4. **G8 — Movement Budget:** If total movement in a MultiAction plan exceeds
   `context.speed`, silently truncates the last MOVE steps. Does not set
   `overridden: true`.

If the guardrail overrode the plan, captures the original plan for
diagnostics.

### Stage 5: Execute Plan (line 851)

Calls `TurnExecutor.executePlan(finalPlan, snapshot)`.

**File:** `src/server/services/ai/TurnExecutor.ts`

#### Single-action plans

Converts the `TurnPlan` to a `FeasibleOption` via `planToOption()` and
dispatches to the appropriate handler based on `plan.type`:

- **BuildTrack:** Opens a DB transaction. UPSERTs `player_tracks` with the new
  segments appended to existing ones. Deducts cost from player money. Commits.
  Post-commit: inserts audit record, emits `track:updated` and `statePatch`
  socket events.
- **MoveTrain:** Calls `PlayerService.moveTrainForUser()` with the final
  destination pixel coordinates. PlayerService handles track usage fee
  deduction in its own transaction. Post-commit: audit record, socket emit
  with refreshed player data.
- **PickupLoad:** Checks train capacity (both in-memory and DB with
  `FOR UPDATE` lock). Appends load to `players.loads` array in a transaction.
  If the load was a dropped load at the city, clears it via
  `LoadService.pickupDroppedLoad()`. Post-commit: audit, socket emit,
  `turn_actions` record.
- **DeliverLoad:** Resolves city name from bot position. Calls
  `PlayerService.deliverLoadForUser()` which handles validation, payment (with
  debt repayment), demand card discard, new card draw, and DB update.
  Post-commit: audit, socket emit, refreshed demand ranking emit.
- **DropLoad:** Removes load from `players.loads` array in a transaction.
  Calls `LoadService` to either return the load to the tray (if native to the
  city) or set it as a dropped load at the city. Post-commit: audit, socket
  emit.
- **UpgradeTrain:** Updates `train_type` and deducts cost (20M for upgrade, 5M
  for crossgrade) in a transaction. Post-commit: audit, socket emit.
- **DiscardHand:** Discards all current demand cards via
  `DemandDeckService.discardCard()`. Draws 3 new cards. Updates `players.hand`
  in DB. Post-commit: audit, socket emit.
- **PassTurn:** Inserts an audit record only. No state changes.

#### MultiAction plans

Executes each step sequentially. Between steps:
- Updates `snapshot.bot.money` with the result's `remainingMoney`.
- For MoveTrain: updates `snapshot.bot.position` to the destination.
- For PickupLoad: appends load to `snapshot.bot.loads`.
- For DeliverLoad: removes load from `snapshot.bot.loads`.
- Concatenates movement paths across steps (deduplicating shared endpoints).

If any step fails, returns immediately with the aggregate cost/segments from
completed steps plus the error from the failed step. Already-committed DB
changes from earlier steps are NOT rolled back.

### Post-Execution (lines 856–1203)

After TurnExecutor returns:

1. **Memory update:**
   - Sets `lastAction` to the executed action type.
   - Updates `noProgressTurns`: resets to 0 if any progress was made
     (delivery, cash increase, new track, active travel, or discard);
     increments otherwise. "Active travel" is narrowed: if the bot is broke
     AND the next route stop is off-network, `isActivelyTraveling` is false.
   - Updates `consecutiveDiscards`, `consecutiveLlmFailures`,
     `deliveryCount`, `totalEarnings`, `turnNumber`.
   - Updates route state: if route completed/abandoned, pushes to
     `routeHistory` and clears `activeRoute`; otherwise saves updated route.
   - Saves `previousRouteStops` for LLM context continuity.
   - Calls `updateMemory()`.

2. **Post-discard refresh:** If the action was DiscardHand, re-captures
   snapshot and rebuilds demands. Checks if active route references demand
   cards no longer in hand — if so, clears the route.

3. **Post-delivery refresh:** If a delivery occurred, re-captures snapshot and
   rebuilds demands. Same stale-route check as discard.

4. **Demand ranking rebuild:** Always captures a fresh snapshot and rebuilds
   demands for the debug overlay ranking (sorted by score, with supply rarity
   labels).

5. **Movement data extraction:** Scans the final plan steps to extract total
   mileposts moved, track usage fees, loads delivered, loads picked up, and
   the concatenated movement path.

6. **Action timeline build:** Calls `buildActionTimeline()` to create a
   structured timeline of move/deliver/pickup/build/upgrade/drop events for
   client animation.

7. **Actor metadata mapping:** `mapActorMetadata()` translates the decision
   model string into actor type (`llm`, `system`, `heuristic`, `guardrail`,
   `error`) and detail string.

8. **Return BotTurnResult** with all fields populated.

### Error Handling (lines 1204–1247)

If any exception is thrown during the pipeline:
- Updates memory with PassTurn action and increments `noProgressTurns`.
- Writes a pipeline-error audit record (best-effort).
- Returns a `BotTurnResult` with `success: false`, action PassTurn, and the
  error message.

---

## 3. Turn Planning: `TurnExecutorPlanner.execute()`

**File:** `src/server/services/ai/TurnExecutorPlanner.ts`

This is the unified planning service that produces the actual turn plan from
the active route and game state. It has two phases.

### Phase A: Movement Loop (lines 178–507)

A while loop that runs as long as `remainingBudget > 0` AND
`currentStopIndex < stops.length` AND `loopIter < 20` (safety cap).

Each iteration inspects the current route stop and takes one of three paths:

#### Path 1: Bot is already at the stop city

Calls `executeStopAction()`:

- **Pickup:** Calls `ActionResolver.resolve()` with action `PICKUP`. If it
  fails due to full capacity, calls `evaluateCargoForDrop()` to find the
  worst-scored load and returns a DropLoad plan instead.
- **Deliver:** Calls `ActionResolver.resolve()` with action `DELIVER`.

If the action succeeds:
- Adds the plan to the plans list.
- **For pickups:** Advances `currentStopIndex` by 1. Calls
  `skipCompletedStops()`. Asserts stops array was not mutated (AC13(c)).
  Continues the loop.
- **For deliveries:** Sets `hasDelivery = true`. Removes the delivered load
  from `context.loads` and `snapshot.bot.loads`. Filters the delivered demand
  from `context.demands` and `snapshot.bot.resolvedDemands`. Refreshes demands
  from DB (JIRA-165). Advances `currentStopIndex`. Triggers post-delivery
  replan via `TripPlanner.planTrip()` if brain is available — replaces the
  active route with the new plan. Falls back to
  `revalidateRemainingDeliveries()` if replan fails. Continues the loop.

If the action fails: abandons the route.

#### Path 2: Stop city is on the network (but bot is not there)

Calls `ActionResolver.resolveMove()` with the target city and remaining
budget. If movement succeeds:
- Adds the MoveTrain plan.
- Computes effective mileposts consumed (accounting for major city center
  nodes).
- Deducts from `remainingBudget`.
- Updates `context.position` and `snapshot.bot.position` to the destination.
- If budget exhausted: breaks. Otherwise: continues loop (may pickup/deliver
  at destination).

If movement fails: breaks to Phase B (need to build track).

#### Path 3: Stop city is NOT on the network

The bot needs track built to reach it. Before breaking to Phase B:

**A3 frontier approach:** If movement budget remains, attempts to move toward
the "construction frontier" — the dead-end node on the existing track network
closest to the build target city.
- Calls `getNetworkFrontier()` to get frontier nodes sorted by distance to
  target.
- Filters out current city (no self-move).
- Applies directional guard: only moves to frontier nodes that are closer to
  the target than the bot's current position.
- Tries each frontier node via `ActionResolver.resolveMove()`. On first
  success: adds the plan, deducts budget, breaks.

Then breaks out of the movement loop to enter Phase B.

### Phase B: Build (lines 533–747)

1. **Resolve build target:** Calls `resolveBuildTarget(activeRoute, context)`
   from `routeHelpers.ts`. Returns the target city and whether it's a victory
   build. Returns null if no build is needed (all remaining stops are on
   network).

2. **Budget check:** Computes remaining budget as
   `min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money)`.
   Skips if <= 0.

3. **JIT gate:** For non-victory, non-initial builds with a brain available,
   calls `shouldDeferBuild()`. This checks whether the bot has enough "runway"
   (track already built toward future stops) that building more track this turn
   is not urgent. If deferred, skips build.

4. **BuildAdvisor (LLM):** If brain and grid points are available, calls
   `BuildAdvisor.advise()` which uses the LLM to determine optimal waypoints
   for track construction. Then calls `ActionResolver.resolve()` with action
   `BUILD` and the advisor's waypoints.
   - If build succeeds: returns the plan.
   - If build fails: attempts 1 solvency retry via
     `BuildAdvisor.retryWithSolvencyFeedback()` with the remaining budget.

5. **Heuristic fallback:** If BuildAdvisor fails or is unavailable, calls
   `ActionResolver.resolve()` with a simple `BUILD toward targetCity` action.

6. **No plans produced:** If neither Phase A nor Phase B produced any plans,
   emits a PassTurn.

### Runtime Invariants

The planner enforces three invariants:
- **AC13(a):** Stop index must never decrease.
- **AC13(b):** Build direction must agree with move direction (build target
  must be at same or later route stop index than move target).
- **AC13(c):** Route stops array must not be mutated after a pickup (only
  `currentStopIndex` may change).

---

## 4. DB Execution: `TurnExecutor`

**File:** `src/server/services/ai/TurnExecutor.ts`

Every handler follows the same pattern:

1. **Transaction:** Critical DB mutations (track save, money deduct, load
   array update) happen inside a `BEGIN`/`COMMIT` transaction. On error:
   `ROLLBACK`.
2. **Post-commit audit:** Best-effort INSERT into `bot_turn_audits`. Failure
   does not affect the turn outcome.
3. **Post-commit socket emit:** Best-effort emit of state patches to connected
   clients. Failure does not affect the turn outcome.

### Action handlers summary

| Action | DB Changes | Side Effects |
|--------|-----------|-------------|
| BuildTrack | UPSERT player_tracks, UPDATE players.money | Emit track:updated, statePatch |
| MoveTrain | Via PlayerService (position + money for fees) | Emit statePatch with affected players |
| PickupLoad | UPDATE players.loads (array_append), clear dropped load | Emit statePatch, insert turn_actions |
| DeliverLoad | Via PlayerService (loads, money, hand, debt) | Emit statePatch, emit demand ranking update |
| DropLoad | UPDATE players.loads (array_remove), LoadService placement | Emit statePatch |
| UpgradeTrain | UPDATE players.train_type + money | Emit statePatch |
| DiscardHand | Discard via DemandDeckService, draw 3, UPDATE players.hand | Emit statePatch |
| PassTurn | None | Audit record only |

---

## 5. Full Turn Sequence Diagram

```
emitTurnChange()
  └─ onTurnChange(gameId, playerIndex, playerId)
       ├─ Gate checks (is bot? game active? not already running? human connected?)
       ├─ Add to pendingBotTurns
       ├─ Wait 1500ms
       ├─ Housekeeping (increment turn number, reset build cost)
       │
       ├─ AIStrategyEngine.takeTurn(gameId, playerId)
       │    ├─ Stage 1: WorldSnapshotService.capture()
       │    ├─ Auto-place bot if needed
       │    ├─ Stage 2: ContextBuilder.build()
       │    │    └─ Inject memory fields (deliveryCount, enRoutePickups, previousTurn)
       │    │
       │    ├─ Stage 3: Decision Gate
       │    │    ├─ Branch A: Initial Build → InitialBuildPlanner + TurnExecutorPlanner
       │    │    ├─ Branch B: Active Route → TurnExecutorPlanner.execute()
       │    │    │    ├─ Phase A: Movement loop (move/pickup/deliver with post-delivery replan)
       │    │    │    └─ Phase B: Build (JIT gate → BuildAdvisor → heuristic fallback)
       │    │    ├─ Branch C: No Route + LLM → auto-deliver → TripPlanner → execute route
       │    │    │    ├─ Dead load drops
       │    │    │    ├─ Cargo conflict resolution (upgrade-before-drop or LLM drop)
       │    │    │    └─ TurnExecutorPlanner.execute() for first step
       │    │    └─ Branch D: No LLM → PassTurn
       │    │
       │    ├─ Stage 3b: TurnValidator.validate() (7 hard gates)
       │    │    └─ On violation: strip Phase B, re-validate
       │    ├─ Route completion continuation (heuristic fallback, no speculative build)
       │    ├─ Dead load drop prepend
       │    │
       │    ├─ Stage 4: GuardrailEnforcer.checkPlan()
       │    │    ├─ G1: Force deliver (highest priority)
       │    │    ├─ Stuck: Force discard (3+ no-progress turns)
       │    │    ├─ G3: Block upgrade in initial build
       │    │    └─ G8: Truncate excess movement
       │    │
       │    ├─ Stage 5: TurnExecutor.executePlan()
       │    │    ├─ Single action → handler (BuildTrack/MoveTrain/etc.)
       │    │    └─ MultiAction → sequential execution with state updates between steps
       │    │
       │    └─ Post-execution
       │         ├─ Update bot memory (progress tracking, route state, delivery count)
       │         ├─ Post-discard demand refresh + stale route check
       │         ├─ Post-delivery demand refresh + stale route check
       │         ├─ Demand ranking rebuild
       │         └─ Build return result
       │
       ├─ Persist LLM metadata to bot_turn_audits
       ├─ Emit bot:turn-complete (full result payload)
       ├─ Append NDJSON game log
       ├─ checkBotVictory() → VictoryService.declareVictory()
       ├─ checkAndResolveFinalTurn() → VictoryService.resolveVictory()
       ├─ advanceTurnAfterBot() → increment player index
       │
       └─ finally: remove from pendingBotTurns, dequeue chained turn
```

---

## 6. Key State Containers

### WorldSnapshot (captured once per turn, mutated during planning)

The snapshot is captured at the start of the pipeline and mutated in-place
during planning:
- `bot.position` is updated after each MoveTrain step
- `bot.loads` is mutated after PickupLoad/DeliverLoad/DropLoad steps
- `bot.money` is updated from execution results
- `bot.resolvedDemands` is filtered after deliveries

This means later pipeline stages see the post-mutation state, not the original
captured state. `positionStart` is captured before mutations for logging.

### GameContext (derived from snapshot, also mutated)

Built by `ContextBuilder.build()` and mutated during the turn:
- `position` is updated after moves
- `loads` is updated after pickups/deliveries
- `demands` is filtered after deliveries and refreshed from DB

### BotMemory (persisted across turns, in-memory only)

Not persisted to the database. Lives in a module-level Map keyed by
`gameId:playerId`. Contains:
- `activeRoute`: the current strategic route being followed
- `turnsOnRoute`: how many turns the bot has been on this route
- `deliveryCount`: lifetime delivery counter
- `noProgressTurns`: consecutive turns with no progress
- `consecutiveDiscards`: consecutive turns where the bot discarded
- `lastAction`, `lastReasoning`, `lastPlanHorizon`: from the previous turn
- `routeHistory`: log of completed/abandoned routes
- `previousRouteStops`: remaining stops from a route that was interrupted by delivery

---

## 7. Error Boundaries

The pipeline has three layers of error handling:

1. **TurnExecutor handlers:** Each handler uses try/catch around its DB
   transaction. Post-commit operations (audit, socket emit) are individually
   wrapped and logged but never abort the turn.

2. **MultiAction execution:** If a step throws (not just returns
   `success: false`), the error is caught and a failure result is returned.
   Earlier steps' DB changes are already committed and NOT rolled back.

3. **AIStrategyEngine.takeTurn() catch block:** If any stage throws, the
   pipeline catches it, updates memory with PassTurn, writes an error audit
   record, and returns a failure BotTurnResult. The turn still advances
   normally via `advanceTurnAfterBot()` in BotTurnTrigger's finally block.

4. **BotTurnTrigger.onTurnChange() catch block:** If anything in the entire
   turn flow throws (including victory check or turn advancement), it's logged.
   The finally block always runs: removes from pendingBotTurns and dequeues
   any chained turn.
