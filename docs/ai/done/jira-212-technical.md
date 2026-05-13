# JIRA-212 — Technical: victory-detection failures are silent, with no NDJSON breadcrumb to localize the failing path

See `docs/jira/jira-212-behavioral.md` for the observed behavior.

## Code paths reviewed

The end-of-turn victory pipeline:

1. `BotTurnTrigger.onTurnChange` (`src/server/services/ai/BotTurnTrigger.ts:61-303`) — the entry point invoked after `emitTurnChange`. After the bot's pipeline runs and the NDJSON entry is appended, it calls:
2. `checkBotVictory(gameId, playerId)` (`BotTurnTrigger.ts:387-442`) — checks net worth ≥ threshold (line 408), then `getConnectedMajorCities(trackState.segments).length >= 7` (line 414-415), then calls:
3. `VictoryService.declareVictory(gameId, playerId, claimedCities)` (`src/server/services/victoryService.ts:80-177`) — re-validates net worth (line 124), unique-city count (line 134), and that every claimed city's `(row, col)` is present in the player's track segments (line 147 → `validateCitiesInTrack`).
4. On success, `emitVictoryTriggered` fires (`BotTurnTrigger.ts:428`) and the game enters final-turn mode.
5. After `advanceTurnAfterBot`, `checkAndResolveFinalTurn` (`BotTurnTrigger.ts:449-465`) runs and — when `current_player_index === final_turn_player_index` — calls `VictoryService.resolveVictory`, which sets `status = 'completed'` and emits `gameOver`.

All of this is wired and looks correct in isolation. Yet on turn 121 in game `66e3eebc`, with Haiku at 259M and 7 connected cities, none of these emissions happened.

## Why we cannot pinpoint the failure from the existing log

Every failure mode in the pipeline above logs to the **server's stdout/stderr** (`console.log` / `console.warn`), not to the per-game NDJSON file:

- `BotTurnTrigger.ts:418` (success path): `console.log(...)`
- `BotTurnTrigger.ts:422` (declareVictory rejected): `console.warn(...)`
- `BotTurnTrigger.ts:439` (exception): `console.error(...)`

The NDJSON game log captures one entry per bot turn (via `appendTurn`); it has no field that records whether `checkBotVictory` ran for that turn or what it returned. The server stderr from this run is not retained, so we cannot tell which of these branches was taken on turn 121.

## Candidate root causes (ranked)

Without diagnostic data, three candidates remain. Adding the observability below (Fix step 1) is the prerequisite to choosing between them.

**A. `getConnectedMajorCities` returns < 7 server-side, even though the NDJSON `connectedMajorCities` field length is 7.** The NDJSON value (`appendTurn` at `BotTurnTrigger.ts:219`) is `result.connectedMajorCities` — populated by `AIStrategyEngine.takeTurn` from a snapshot taken during turn execution. The victory-side check (`checkBotVictory:411-414`) re-queries `TrackService.getTrackState` and recomputes via `getConnectedMajorCities`. If those two computations disagree (e.g. snapshot includes a just-built segment that the post-turn DB read does not, or the BFS / ferry-edge / city-group logic differs subtly), `checkBotVictory` returns false at line 415 with no NDJSON trace.

**B. `VictoryService.declareVictory` rejects the claim.** `validateCitiesInTrack` (`victoryService.ts:54-74`) walks `claimedCities` and requires every `(row, col)` to be present in the player's `segments`. `getConnectedMajorCities` returns one MP per city (line 126 of `connectedMajorCities.ts`), and that MP is selected from the BFS component which can include implicit intra-city and ferry edges. If a city is reachable only via implicit edges (i.e. its representative MP is not literally an endpoint of any built segment), `validateCitiesInTrack` returns false and `declareVictory` returns `success: false` with `console.warn` only.

**C. An earlier exception inside `onTurnChange` skipped the victory check.** Lines 137-269 (audit UPDATE, socket emit, NDJSON append) are mostly try/caught individually, but the outer `try` at line 103 catches at line 289. If anything in the action-pipeline path between the appendTurn and `checkBotVictory:275` throws, the `catch` logs to `console.error` and the victory check is skipped. Less likely (the bot kept playing turns afterward, suggesting no persistent error state), but cannot be ruled out without logs.

## Fix plan

### Step 1 — Add NDJSON breadcrumbs for the victory check (observability first)

Extend the per-turn NDJSON entry with a `victoryCheck` block recording: whether `checkBotVictory` ran, what it computed, and what it returned. This makes future occurrences self-diagnosing.

```ts
// BotTurnTrigger.ts — augment checkBotVictory to return diagnostic detail
export interface VictoryCheckResult {
  ran: boolean;
  netWorth?: number;
  threshold?: number;
  connectedCityCount?: number;
  connectedCityNames?: string[];
  declaredVictory: boolean;
  rejectionReason?: string;   // populated when declareVictory.success === false
  earlyReturnReason?: 'already-triggered' | 'no-player' | 'insufficient-funds' | 'no-track' | 'too-few-cities';
  errorMessage?: string;
}
```

Have `checkBotVictory` return `VictoryCheckResult` instead of `boolean`, then attach the result to the NDJSON entry written in `BotTurnTrigger.ts:208-269` as a new `victoryCheck` field. The existing call sites (`BotTurnTrigger.ts:275-279`, tests) need to be updated to read `.declaredVictory` for the boolean signal.

This change alone is non-behavioral — it only adds observability — but it is the prerequisite for any subsequent fix.

### Step 2 — Replay the bug with the new instrumentation

Run a fresh game (or replay a saved game state if available) until a bot crosses the victory threshold. The NDJSON `victoryCheck` field will reveal whether the bot's turn took candidate A, B, or C.

### Step 3 — Fix the identified failure mode

The fix branches on what Step 2 reveals:

- **If A (snapshot vs. post-turn DB disagreement on connected cities):** unify the count. The simplest fix is to have `checkBotVictory` reuse the same source the NDJSON line reports — i.e. trust `result.connectedMajorCities` from the strategy pipeline rather than re-querying. Alternatively, make `getConnectedMajorCities` deterministic across both call sites by passing the same `TrackSegment[]` input.

- **If B (`validateCitiesInTrack` rejecting cities reachable via implicit edges):** in `connectedMajorCities.getConnectedMajorCities`, prefer a representative MP that is *literally* a track endpoint (i.e. one that appears in `segment.from` or `segment.to`), not just any MP in the BFS component. Or — equivalently — relax `validateCitiesInTrack` to accept any MP from the city group whose component-membership matches.

- **If C (earlier exception):** harden the pre-victory section so a non-fatal failure (e.g. NDJSON write, socket emit) cannot skip the victory check. Move `checkBotVictory` and `checkAndResolveFinalTurn` into a `finally`-equivalent block that always runs after the strategy pipeline, regardless of audit/log/emit failures.

### Step 4 — Backstop: route-executor must respect victory state

Independent of the root cause above, add a guard at the top of `BotTurnTrigger.onTurnChange` (after the `status === 'completed'` check at line 82) that also short-circuits when `victory_triggered === true` AND `current_player_index === final_turn_player_index` has already passed (i.e. resolution is overdue). If the resolution path ever fails to fire, this prevents indefinite autoplay. Concretely:

```ts
// Inside onTurnChange, after the status check
const victoryState = await VictoryService.getVictoryState(gameId);
if (victoryState?.triggered) {
  const isFinal = await VictoryService.isFinalTurn(gameId);
  if (!isFinal) {
    // Final turn not yet reached — proceed normally
  } else {
    // Final turn IS this turn — let it run, resolution happens after via checkAndResolveFinalTurn
  }
  // If victory has been triggered for many turns and we're still not at final-turn-player-index,
  // something is wrong — surface a console.error and do not advance further.
}
```

This is a safety net, not a substitute for fixing the actual detection failure.

## Affected code

- `src/server/services/ai/BotTurnTrigger.ts:387-442` (`checkBotVictory` — return type change + diagnostic detail)
- `src/server/services/ai/BotTurnTrigger.ts:208-269` (NDJSON `appendTurn` payload — add `victoryCheck` field)
- `src/server/services/ai/GameLogger.ts` (NDJSON entry type — add `victoryCheck?: VictoryCheckResult`)
- `src/server/services/ai/connectedMajorCities.ts:78-133` — *only if* candidate B is the cause (representative-MP selection)
- `src/server/services/victoryService.ts:54-74` — *only if* candidate B is the cause and we relax `validateCitiesInTrack` instead of changing the producer
- `src/server/__tests__/ai/BotTurnTrigger.test.ts` — update existing `checkBotVictory` tests to assert the new return shape; add a regression test that reproduces the no-victory-event scenario from this game

## Out of scope (per behavioral)

- Capping route-executor autoplay at a turn count as a general fail-safe (separate concern).
- The `"Victory Imminent"` `gamePhase` heuristic — its threshold (5 cities + 250M) is intentionally permissive and unrelated to this bug.
- Client-side victory rendering — the server never emitted, so the client never had a chance to render.
- Improving LLM/strategy-layer behavior in late-game positions where victory is plausible.
