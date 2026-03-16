# JIRA-110: Bot Stops 1 Milepost Short of Ferry Port — Wasted Turn

## Problem

Game `44bdcc48`, player `57aeaba1` (Haiku, Freight), t4:

- Bot moves London→Birmingham (pickup Iron) → continues toward Dover but stops at `(22,32)`, 1 milepost short of Dover `(22,33)`.
- Composition reports `moveBudget={total:9, used:8, wasted:1}`, consistent with reaching Dover (Move1=3eff + Move2=5eff = 8).
- But DB position after t4 is `(22,32)`, not `(22,33)`.
- t5: bot moves 1mp to Dover `(22,33)`, ferry truncation stops it. `used:1, wasted:8`. Entire turn wasted.
- Net cost: **1 full turn of movement lost**.

## Track Layout at t4

9 segments total:
- **London→Birmingham**: `(19,30)→(18,31)→(17,30)→(16,30)` — 3 segments, 5M
- **London→Dover**: `(21,31)→(22,32)→(22,33)` — 2 segments, 5M
- **Calais→Antwerpen**: `(23,33)→(23,34)→(23,35)→(23,36)→(24,37)` — 4 segments, 6M

Route: `pickup(Iron@Birmingham) → deliver(Iron@Antwerpen)`

## Composition Flow (correct)

1. **A1 MOVE**: Start `(19,30)` → Birmingham `(16,30)`. 3 raw edges, 3 effective.
2. **A1 split**: PICKUP Iron at Birmingham.
3. **A2 continuation**: `findMoveTargets` returns "Antwerpen" (next route stop).
4. **ActionResolver.resolveMove("Antwerpen")**: Pathfinds Birmingham→London→Dover→ferry→Calais→Antwerpen. Full path = 12 raw, 10 effective.
5. **Speed truncation** (effectiveSpeed=9, full speed — `remainingSpeed` not passed): truncates to 9 effective.
6. **Ferry truncation**: Stops at Dover `(22,33)`. Final path = 7 raw, 5 effective.
7. **TurnComposer budget check**: chainEffective=5 ≤ remaining=6. No further truncation.
8. **Result**: Path ends at Dover `(22,33)`. Total used=8. **Correct.**

## Execution Discrepancy (unexplained)

- Composition produces Move2 path ending at Dover `(22,33)`.
- `handleMoveTrain` extracts `destination = movePath[last] = (22,33)`.
- `moveTrainForUser({to: (22,33)})` should update DB to `(22,33)`.
- But DB shows `(22,32)` after t4. t5 confirms bot starts at `(22,32)`.

**Status**: Root cause of composition→execution divergence not yet identified. Likely requires runtime logging to trace the exact `moveTrainForUser` call and its outcome.

## Confirmed Bugs (4)

### Bug 1: `findCityMilepost` excludes FerryPort terrain

**File**: `ActionResolver.ts:1072`
**Code**: `if (point.name === cityName && point.terrain !== 7 /* FerryPort */)`
**Impact**: Bots cannot target ferry port cities (Dover, Calais, Belfast, Dublin ferry ports) as MOVE destinations. When a route stop is at a ferry port, `resolveMove` fails, forcing the A2 loop to fall through to alternate targets (e.g., Antwerpen), which produces a longer path that gets ferry-truncated anyway.
**Fix**: Remove the `&& point.terrain !== 7` condition. Ferry ports ARE valid destinations — the ferry truncation in `resolveMove` (lines 339-354) already handles the stop-at-ferry-port rule.

```typescript
// Before
if (point.name === cityName && point.terrain !== 7 /* FerryPort */) {

// After
if (point.name === cityName) {
```

### Bug 2: `computeReachableCities` excludes FerryPort cities

**File**: `ContextBuilder.ts:199-287`
**Impact**: `computeReachableCities` uses BFS on bot's own track network and checks `neighborPoint?.city?.name` to identify cities. FerryPort GridPoints have `name` (e.g., "Dover") but no `city` property, so they're excluded from the reachable cities list. This means ferry port cities never appear in `context.reachableCities`, affecting `findMoveTargets` Priority 4 fallback targets.
**Fix**: Check `point.name` in addition to `point.city?.name` when identifying reachable cities.

Also: every edge is treated as 1 milepost (no intra-city discounting), which overestimates distances through major cities.

### Bug 3: `milepostsMoved` display bug

**File**: `AIStrategyEngine.ts:1024`
**Code**: `milepostsMoved = (milepostsMoved ?? 0) + (step.path.length > 0 ? step.path.length - 1 : 0)`
**Impact**: Uses raw `path.length - 1` instead of `computeEffectivePathLength`. Reports 9 mileposts moved when only 8 effective mileposts were used (intra-city London hops counted).
**Fix**: Use `computeEffectivePathLength(step.path, getMajorCityLookup())`.

### Bug 4: `truncatePathToEffectiveBudget` ignores ferry ports

**File**: `TurnComposer.ts:873-892`
**Impact**: When truncating a path to remaining budget, this function only counts effective mileposts. It does not check for ferry port boundaries. If the budget-truncated path lands past a ferry port, the bot could be composed to a position beyond the ferry port — which violates the game rule that trains must stop at ferry ports.
**Fix**: After truncating to budget, scan the result for ferry port nodes (same logic as ActionResolver lines 339-354) and further truncate if needed.

## Severity

**High** — Costs 1 full turn of movement in ferry approach scenarios. The `findCityMilepost` FerryPort exclusion (Bug 1) is the most impactful: it prevents bots from ever directly targeting ferry port cities, affecting any route that involves ferry crossings.

## Affected Files

| File | Lines | Bug |
|------|-------|-----|
| `ActionResolver.ts` | 1072 | Bug 1: FerryPort exclusion in findCityMilepost |
| `ContextBuilder.ts` | 199-287 | Bug 2: FerryPort exclusion in computeReachableCities |
| `AIStrategyEngine.ts` | 1024 | Bug 3: milepostsMoved display bug |
| `TurnComposer.ts` | 873-892 | Bug 4: truncatePathToEffectiveBudget ferry blindspot |

## Recommended Fix Order

1. **Bug 1** — Highest impact, simplest fix (one line change)
2. **Bug 3** — Simple display fix
3. **Bug 2** — Moderate complexity, improves context accuracy
4. **Bug 4** — Defensive fix, prevents edge-case violations
5. **Execution discrepancy** — Add diagnostic logging to `handleMoveTrain` and `moveTrainForUser` to capture the exact destination and DB outcome for future debugging
