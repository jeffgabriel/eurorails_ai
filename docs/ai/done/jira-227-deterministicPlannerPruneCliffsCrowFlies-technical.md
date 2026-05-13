# JIRA-227 — Deterministic planner spatial-prune cliffs use crow-flies geometry (technical)

Companion to `jira-227-deterministicPlannerPruneCliffsCrowFlies-behavioral.md`. Read that first for game evidence and acceptance criteria.

## Current implementation

### Constants (`DeterministicTripPlanner.ts:118-120`)

```ts
export const PRUNE_MAX_TURNS = 12;
export const PRUNE_MAX_BUILD_M = 130;
export const HOP_AVG_COST_M = 1.3;
```

### `cheapPrune` (`DeterministicTripPlanner.ts:539-558`)

```ts
export function cheapPrune(
  candidate: Candidate,
  startPos: GridCoord,
  speed: number,
  opts: ResolvedOptions,
): { keep: boolean; estTurns: number; estBuild: number } {
  const cityToCoords = buildCityToCoords();
  let totalHops = 0;
  let cur = startPos;
  for (const s of candidate.stops) {
    const dest = nearestCityCoord(s.city, cur, cityToCoords);
    if (!dest) return { keep: false, estTurns: 999, estBuild: 999 };
    totalHops += hexDistance(cur.row, cur.col, dest.row, dest.col);
    cur = dest;
  }
  const estTurns = Math.max(1, Math.ceil(totalHops / speed));
  const estBuild = totalHops * opts.hopAvgCostM;
  const keep = estTurns <= opts.pruneMaxTurns && estBuild <= opts.pruneMaxBuildM;
  return { keep, estTurns, estBuild };
}
```

The prune loop in `planTripDeterministic` at lines 887-911 runs `cheapPrune` per candidate and reports `prunedByTurns` / `prunedByBuild` counters. Both counters key off the same `totalHops` value.

### Inputs available to `cheapPrune`

- `candidate.stops`: ordered list of `RouteStop` objects with `city` field.
- `startPos`: bot's current grid position.
- `speed`: train speed in mileposts per turn.
- `opts.pruneMaxTurns` / `opts.pruneMaxBuildM` / `opts.hopAvgCostM`: thresholds.

What `cheapPrune` does NOT receive but COULD receive without restructuring:

- The bot's existing track segments (already on `snapshot.bot.existingSegments` — passed to `scoreCandidate` but not to `cheapPrune`).
- All players' tracks (already on `snapshot.allPlayerTracks` — same).
- The bot's current cash (`snapshot.bot.money`).

The `planTripDeterministic` orchestrator at line 877 has both `snapshot` and `cheapPrune` in scope; passing more state into `cheapPrune` is purely a signature change.

## Fix plan

Two independent improvements. Either can ship alone; both compose cleanly.

### Fix A — Cost-aware build estimate

Subtract hops on the bot's existing track (build cost = 0) from `totalHops` before multiplying by `HOP_AVG_COST_M`. Hops on opponent track also have zero build cost (they incur usage fees, paid out of operating cash, not build budget) — but those should NOT be subtracted from the `estTurns` calculation, since the bot still has to traverse them.

**Signature change** (`DeterministicTripPlanner.ts:539`):

```ts
export function cheapPrune(
  candidate: Candidate,
  startPos: GridCoord,
  speed: number,
  opts: ResolvedOptions,
  trackOwnership?: { botTrackHops: Set<string>; opponentTrackHops: Set<string> },
): { keep: boolean; estTurns: number; estBuild: number; ... }
```

Where `botTrackHops` is a precomputed set of "row,col→row,col" edge keys covering the bot's existing segments, and `opponentTrackHops` covers all other players' segments.

**Algorithm change**:

```ts
// Inside the per-stop loop, replace `totalHops += hexDistance(...)` with:
const segmentHops = hexDistance(cur.row, cur.col, dest.row, dest.col);
totalHops += segmentHops;

// Track which hops along this segment are on existing track.
// Cheap approximation: if the straight-line path between cur and dest
// passes through the bot's existing graph (Dijkstra-free check), assume
// those hops are zero-build.
const onBotTrack = countHopsOnExistingTrack(cur, dest, trackOwnership?.botTrackHops);
totalHopsOnBotTrack += onBotTrack;
```

```ts
// At the bottom:
const billableHops = totalHops - totalHopsOnBotTrack;
const estBuild = billableHops * opts.hopAvgCostM;
```

The `countHopsOnExistingTrack` helper is intentionally a cheap approximation — the goal is to avoid pruning a candidate when its real new-track spend is well under the cap. False positives (estimating fewer hops on track than reality) are conservative — they preserve the original prune behavior for that candidate. False negatives (estimating MORE hops on track than reality) would loosen prune incorrectly — guard against this by only counting hops where both endpoints lie on existing track.

**Precomputation**: build `trackOwnership` once per `planTripDeterministic` call from `snapshot.bot.existingSegments` and `snapshot.allPlayerTracks`, pass it down to every `cheapPrune` invocation. O(segments) one-time cost; per-candidate overhead is O(stops × hops_per_segment) lookup against a hash set.

**Test**: regression scenario where a candidate's stops fully traverse the bot's network — `estBuild` should be ≤ 0 (clamped to 0), and the candidate must survive the build cap regardless of `totalHops`. A second scenario: half the route on track, half off — `estBuild` reflects only the off-network half.

### Fix B — Cash-aware (or phase-aware) build threshold

The static 130M cap binds even at 161M cash. Two flavors:

**B.1 (simpler — shipped as commit 1)**: Raise the cap to track cash when cash exceeds the static value. Static cap remains the floor.

```ts
// In planTripDeterministic, before opts is constructed:
const baseBuildCap = options?.pruneMaxBuildM ?? PRUNE_MAX_BUILD_M;
const dynamicBuildCap = options?.pruneMaxBuildM != null
  ? options.pruneMaxBuildM   // explicit caller override bypasses cash logic
  : Math.max(baseBuildCap, snapshot.bot.money);
```

This is the simplest formulation. No reserve buffer (per `feedback_no_cash_reserves` discipline — let the bot spend to zero). Behavior:

| Bot cash | Cap |
|---------:|----:|
| 50M  | 130 (static floor) |
| 100M | 130 (static floor) |
| 161M | 161 (cash) |
| 300M | 300 (cash) |

The cap is conservative because `estBuild` = totalHops × 1.3 itself overstates real new-track spend (existing-network hops are billed). Even when the cap relaxes to match cash, real spend stays well under cash for routes that traverse the bot's existing network. If a wider real spend ever becomes feasible, JIRA-227 Fix A would tighten the build estimate to the truthful number; the cash-aware cap then only matters for genuinely all-new-track trips.

(Original draft had `Math.min(opts.pruneMaxBuildM, ...)` which would cap at the static value forever — the formula above is the corrected version that actually relaxes the cap.)

**B.2 (phase-aware)**: Match `OCPT_BY_PHASE`:

```ts
export const PRUNE_MAX_BUILD_BY_PHASE = {
  early: 80,    // tight: bot has little cash, needs to be selective
  mid: 130,    // current value
  late: 200,   // looser: bot has accumulated cash, runway shortens
} as const;
```

B.1 and B.2 can compose: take the min of the cash-aware value and the phase-aware ceiling.

**Test**: regression scenario reproducing T78 (cash=161M, late phase) — a candidate with `estBuild = 145M` must survive the prune (would have failed under the static 130M cap). The same candidate at cash=80M (early phase) must still be pruned — affordability bites differently across cash levels.

### Combined effect

With both fixes: a pair candidate spanning the bot's own track + a peripheral leg has `estBuild` reflecting only the off-network hops, AND the cap reflects the bot's actual affordability. The T78 Copper-on-track + Oranges-peripheral scenarios that currently die at the prune will reach the simulator and be scored truthfully.

### What does NOT change

- `cheapPrune`'s position in the pipeline (still runs before `simulateTrip`, still exists to filter the obviously infeasible).
- The `estTurns` calculation. Turn pruning continues to use raw `totalHops / speed` — bot still has to traverse those hops even on existing track. (A more aggressive Fix C — also accounting for "existing track is faster" doesn't apply here; track ownership doesn't make movement faster, only cheaper.)
- `simulateTrip` behavior. The simulator already truthfully accounts for existing-track build cost.

## Tests

### Unit (`DeterministicTripPlanner.cheapPrune.test.ts` extensions)

- **AC1** (Fix A): Candidate with a 50-hop route where 30 hops are on `snapshot.bot.existingSegments` — `estBuild` MUST equal `(50 − 30) × 1.3 = 26M`, not `50 × 1.3 = 65M`. Survives a `pruneMaxBuildM = 50` threshold.
- **AC2** (Fix A): Candidate with zero hops on bot track — `estBuild` MUST equal `totalHops × 1.3`. Existing prune behavior preserved.
- **AC3** (Fix B.1): With `snapshot.bot.money = 161M` and a candidate of `estBuild = 145M` — candidate MUST survive (under cash-aware cap of `min(130, 161 − reserve)`). With `snapshot.bot.money = 50M` and the same candidate — candidate MUST be pruned.
- **AC4** (Fix B.2): With phase=late and `estBuild = 180M` — survives (cap=200). With phase=early and `estBuild = 90M` — pruned (cap=80).

### Game-replay regression (`DeterministicTripPlanner.game3612bf42T78.test.ts`)

Reproduce the T78 hand and bot state from `logs/game-3612bf42-68ef-47d4-8bac-cb86d5dd453b.ndjson`. Without the fix: 25 survivors of 90 raw, no pair candidates among them. With the fix: at least one pair candidate that includes a stop on the bot's existing network MUST survive the prune.

## Risk

- **Loosening the prune** could let infeasible candidates reach `scoreCandidate`, where they'd be feasibility-checked anyway. Cost: per-candidate `simulateTrip` is more expensive than `cheapPrune`. Mitigation: only candidates that previously failed the build cap by ≤30M should newly survive; the volume increase is bounded.
- **Track-ownership subtraction approximation**: if `countHopsOnExistingTrack` overstates on-track hops, `estBuild` underestimates real build cost, more candidates survive than should. Mitigation: implement conservatively (only count hops where both endpoints have explicit entries in the track set), and add a unit test asserting the function returns 0 for any segment with at least one off-network endpoint.
- **Phase-aware caps need calibration**. Pulling Fix B.2 values out of intuition risks regression in early-phase trip selection. Mitigation: ship Fix B.1 first (cash-aware bound applies the same logic across phases via the bot's actual cash); revisit B.2 only if early-phase still over-selects.

## Confirmation

After both fixes, the T78 prune output line should look something like:

```
Survivors after spatial prune: 45 of 90 raw.
Discarded by prune: 12 (turns > 12) | 18 (build > 161M [cash-aware]).
```

Where the build cap reflects current cash and counts only billable (off-network) hops in the build estimate. The original `composition.reasoning` format stays the same; only the cap reported and the survivor count change.
