# JIRA-189: Nano Pipeline-Error Loop, DB Position-Column Drift, and canDeliver Resolver Disagreement

**Status:** SHELVED — observed once in game `faf86a5f-afc5-4343-b38d-e8791c304d91` after a server+game restart mid-stuck-state. Park and watch for recurrence during normal gameplay before investing in fixes.

**Split from:** [JIRA-188](./jira-188-nanoCattleLossAndStuckPipeline.md). JIRA-188's "Issue 2" (stuck-state pipeline-error loop) turned out to be a downstream symptom of the bugs below, which are independent of JIRA-188's root cause (LLM hallucination in trip planning). Keeping them separate so JIRA-188's scope stays on the hallucination/validator gap.

**Game:** `faf86a5f-afc5-4343-b38d-e8791c304d91`, Nano, turns 64–76+
**Key log:** T76 diagnostic output (2026-04-22T12:26:36Z) produced by the JIRA-188 logging commit `6e4f96f`

---

## Symptom

From T64 onward, every Nano turn aborts with:

```
error: "Demand does not match delivery"
decisionSource: pipeline-error
```

11+ consecutive turns, identical payload, no position / activeRoute / demand fields logged. User restarted the server and game between T75 and T76; the loop persisted.

## What the JIRA-188 logging revealed at T76

```
[TurnExecutor.handleDeliverLoad] JIRA-188 delivery attempt:
  loadType:"Cattle", cardId:32, targetCity:"Antwerpen",
  derivedCityName:"Ijmuiden",           ← from loadGridPoints().get("19,38").name
  posKey:"19,38",
  position:{row:19, col:38},
  loads:["Cattle"],
  cardDemands: card 32 = [
    {city:"Wien",       resource:"Wheat",   payment:21},
    {city:"Antwerpen",  resource:"Cattle",  payment:11},
    {city:"Krakow",     resource:"Tobacco", payment:33}
  ],
  resolvedDemandCardIds:[37,35,32]
```

The server call was `deliverLoadForUser(..., "Ijmuiden", "Cattle", 32)`. Card 32 has no `{city:"Ijmuiden", resource:"Cattle"}` demand → throws at `playerService.ts:866`.

## Three distinct underlying bugs

### Bug A — DB position columns are out of sync

Direct DB query after T76:

```
 name  | position_x | position_y | position_row | position_col
-------|------------|------------|--------------|--------------
 Nano  |       1970 |       1200 |           24 |           37
```

- `position_x/y = (1970, 1200)` → pixel coords that convert to grid **(19, 38) = Ijmuiden ferry port**. Stale since T56 (Nano's ferry crossing).
- `position_row/col = (24, 37)` → grid coords for **Antwerpen**. Matches the user's visual — this is the game-truth position.

At T76 execution time, the snapshot reported `{row:19, col:38}` — which means when T76 ran, the DB had `position_row=19, position_col=38`. Some time between T76 and the DB query (hours later), the row/col columns changed to `(24, 37)` without the pixel columns being touched. `WorldSnapshotService.capture` reads the row/col columns directly (`src/server/services/ai/WorldSnapshotService.ts:172–175`), so whichever value was there at capture time is what the pipeline saw.

**Hypotheses for why the columns drift:**
1. A movement commit path updates one pair without the other. `src/server/services/playerService.ts` has multiple position writes (`position_x = $6` at L260, etc.) — need to audit whether all writes are paired.
2. The server-restart reload or some reconciler writes only one pair, using a different source of truth.
3. Ferry-crossing handling mutates position in an unusual way (`ActionResolver.resolveFerryCrossing` returns a paired port but doesn't persist).

### Bug B — `ContextBuilder.computeCanDeliver` finds an opportunity that shouldn't exist at a Ferry Port

At T76 with snapshot position (19,38) (Ferry Port, not a city terrain), `context.canDeliver` still contained `{loadType:"Cattle", deliveryCity:"Antwerpen", cardIndex:32, payout:11}` — Guardrail 1 fired with this opportunity.

But `computeCanDeliver` starts with:

```typescript
// ContextBuilder.ts:1430
const cityName = ContextBuilder.getCityNameAtPosition(snapshot.bot.position, gridPoints);
if (!cityName) return [];
```

And `getCityNameAtPosition` returns `point?.city?.name`. `GridPoint.city` is only populated for terrain in `CITY_TERRAINS = {SmallCity, MediumCity, MajorCity}` (`WorldSnapshotService.ts:209–213`). Ferry Port is not in that set, so `city` should be `undefined` and `getCityNameAtPosition` should return `undefined` → empty canDeliver.

**It didn't.** Either:
1. There's another code path populating `canDeliver` that doesn't go through `getCityNameAtPosition` (needs trace).
2. The `GridPoint.city` attachment at (19,38) is somehow carrying `{name:"Antwerpen"}` despite the terrain guard (impossible per the code I read, but worth verifying at runtime).
3. `canDeliver` was populated on an earlier snapshot where position was different, then not re-cleared when position "reverted" to (19,38) via the Bug A drift.

Hypothesis 3 is the most likely in this specific incident: at T63 snapshot.position was probably (24,37) → canDeliver included Antwerpen legitimately. Between T63 and T64, position_row/col drifted to (19,38) (maybe via whatever restart reconciliation also swapped the columns), but canDeliver in memory or in a cached context was already built assuming (24,37). Still needs to be confirmed by running a repro.

### Bug C — Pipeline has no recovery from repeated errors

Independent of A and B, the pipeline-error catch (`AIStrategyEngine.ts:1213`) does:
- Log the error
- Write a `PassTurn` audit record
- Return a skeletal result

It does **not** clear `activeRoute`, does not force a replan, does not discard hand. So the next turn sees identical state → identical plan → identical throw → identical PassTurn. Infinite loop until a human intervenes.

Flash logged 46 turns in the same pattern in this game on a different error class (`INVARIANT VIOLATION: build direction disagrees with move direction` — JIRA-184 lineage). Same architectural gap.

---

## Why this is on the shelf

1. The trigger for Bug A (the DB column drift) happened around a **server+game restart during an already-stuck state**. It's not clear whether this reproduces during normal uninterrupted gameplay, or only when a human restarts into a mid-stuck game. If it's the latter, it's a rare operational edge case.
2. Bug B's mechanism is unclear from logs alone and requires a runtime repro to nail down. Spending time tracing it without a reliable repro is premature.
3. Bug C (recovery gap) is real and would compose with any pipeline error — but the blast radius depends on how often any such error fires. If Bug A+B are rare, Bug C's impact is proportionally low.

## Watch-list — what would re-open this

- Any new pipeline-error loop (≥3 consecutive turns with `decisionSource: pipeline-error` on the same bot) observed during normal gameplay, without a preceding server restart.
- Any DB query that shows `position_x/position_y` and `position_row/position_col` disagreeing on `players` rows for an active game.
- Any report of a bot's visual position disagreeing with server-rendered state.

## If it recurs, first-step diagnostics

1. **Confirm Bug A deterministically.** After any pipeline-error turn, query:
   ```sql
   SELECT id, name, position_x, position_y, position_row, position_col
   FROM players WHERE game_id = '<game-id>';
   ```
   If `(position_x, position_y)` doesn't convert to `(position_row, position_col)` via `pixelToGrid`, Bug A is live.

2. **Confirm Bug B.** Add a temporary log in `ContextBuilder.computeCanDeliver` printing `{position, cityName, opportunities.length}`. If `cityName` is `undefined` but `opportunities.length > 0`, Bug B is a distinct code path we haven't found yet. If `cityName === "Antwerpen"` at position (19,38), the `GridPoint.city` attachment has a bug at Ferry Port terrains.

3. **Audit position writes.** Grep `playerService.ts` for every `UPDATE players SET position_x = ...` — verify each co-updates `position_row/position_col` (and vice versa). A disciplined fix is to wrap position updates in a single helper that atomically writes all four columns from one source of truth.

## Related tickets

- **JIRA-188** — LLM hallucination leads to self-destructive DROP stop in trip plan. Parent ticket from which this was split.
- **JIRA-184** — Invariant-violation stuck loop (same Bug C pattern, different error class).
- **JIRA-185** — Post-delivery replan stale snapshot (sibling data-freshness bug).

## Diagnostic logging already in place

Commit `6e4f96f` added `[TurnExecutor.handleDeliverLoad] JIRA-188` and `[AIStrategyEngine.takeTurn] JIRA-188` console logs. If this recurs, those logs alongside a DB snapshot will tell us in one look whether Bug A, Bug B, or both fired.
