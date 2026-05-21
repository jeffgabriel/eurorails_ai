# JIRA-113: Network Building Intelligence

_Merged from JIRA-113 (track usage fee blindness) and JIRA-119 (smarter building as network grows). The core issue is that the bot builds track one target at a time with no awareness of network shape, future needs, or reuse value._

## The Core Problem

The bot builds track like it's solving a series of independent shortest-path problems. Each time it needs to reach a new city, `computeBuildSegments` runs a Dijkstra from the nearest existing track endpoint and finds the cheapest path — **without considering what track already exists nearby**. The result is catastrophic: the bot builds parallel tracks through the same corridors over and over, wasting hundreds of millions over a game.

This is not a minor inefficiency. In game `7bf86af8`, **redundant track building was the primary reason Flash lost the game.**

## The Evidence: Game `7bf86af8`, Flash Bot

Flash spent **483M on track building across 305 segments**. Analysis of the build history reveals massive duplication:

### East-West Row 23-24 Corridor — Built 4 Times

The bot built through the same east-west band (row 23-24, cols 39-53) on four separate occasions:

| Turn | From | To | Segs | Cost | Purpose |
|------|------|----|------|------|---------|
| T7 | (23,42) | (24,51) Berlin | 4 | 10M | Initial build east |
| T55 | (23,48) | (24,39) | 15 | 20M | Parallel rebuild through same area |
| T85 | (24,52) Berlin | (23,40) | 15 | 20M | THIRD pass through same corridor |
| T105 | (22,53) | (23,42) | 16 | 20M | FOURTH pass, cols 53->42 again |

**75 segments, 130M** through essentially the same corridor. A connected network through this band should cost ~20-30M once.

### North-South Col 32-35 Region — Built 3 Times

| Turn | From | To | Segs | Cost |
|------|------|----|------|------|
| T37 | (47,26) | (36,33) | 7 | 10M |
| T86 | (23,40) | (32,35) | 16 | 20M |
| T106 | (23,42) | (27,32) | 16 | 20M |

Three separate north-south lines to the same area. **~50M wasted.**

### South to Spain — Built 2 Times

| Turn | From | To | Segs | Cost |
|------|------|----|------|------|
| T45-46 | (47,23) | (49,24) -> (40,31) | 16 | 21M |
| T86-88 | (23,40) | (32,35) -> (43,28) -> (51,21) | 45 | 57M |

Two separate routes to Spain. **~30-40M wasted.**

### The Esbjerg Ferry Miss

On ~turn 105, Flash needs to get from Kobenhavn to Aberdeen. Flash's track passes through Arhus(12,49), which is **3 segments (3M)** from the Esbjerg ferry port(12,46). The ferry costs 16M but lands at Newcastle(10,33), just ~10 mileposts from Aberdeen.

Instead, Flash builds overland — 40M+ across turns 105-106 heading the wrong direction through Berlin and Frankfurt, still many turns from Aberdeen. The ferry route would have cost 19M and saved 3-4 turns.

**Estimated total waste from duplicate/suboptimal building: 130-180M** — more than half the 250M victory threshold.

## Why This Happens: The Architectural Gap

### What `computeBuildSegments` does now

```
1. Get all endpoints of bot's existing track (extractTrackEndpoints)
2. Multi-source Dijkstra from all endpoints
3. Expand outward, paying terrain costs for NEW segments
4. Traverse existing track for free (builtEdges check)
5. Return cheapest path to target city
```

The pathfinder correctly avoids rebuilding edges that already exist. But it has a critical blind spot: **it doesn't know the shape of the network it's building FROM**.

When the bot at (23,42) needs to reach a city to the east, the Dijkstra starts from (23,42) and expands outward. It doesn't know that there's existing track at (24,50) just 2 hexes north that already goes east. It builds a new parallel path because that's the cheapest path from the starting endpoint — even though connecting to the existing eastern corridor (2 segments, ~2M) would be far cheaper than building a new one (15 segments, 20M).

### What's missing: a "network awareness" step before building

Before building toward a target, the bot should ask:
1. **Does my existing network already get close to this target?** If existing track at point X is within 3-5 segments of the target, build a short connector from X instead of a long new line from the current position.
2. **Am I about to build parallel to existing track?** If the proposed build path runs within 1-2 hexes of existing track for more than 3 segments, route through the existing track instead.
3. **Is there a ferry/shortcut nearby that dramatically reduces the build?** Check if existing track is within 1-4 segments of a ferry port that would shortcut the route.

### Where the check needs to happen

The gap is between route planning and pathfinding. Currently:

```
LLM plans route → PlanExecutor says "build toward City X" → computeBuildSegments finds cheapest path
```

Nobody asks "wait, before I build 15 new segments, is there existing track nearby that I could connect to?" This check needs to happen in **PlanExecutor** or a new pre-build analysis step, because:

- `computeBuildSegments` only knows about segments, not strategy
- The LLM doesn't see the network shape at hex level
- PlanExecutor has both the route context AND access to the track network

### The data is there, nobody uses it

`WorldSnapshot.bot.existingSegments` contains the full network. `buildTrackNetwork()` in `TrackNetworkService.ts` converts it to an adjacency graph. `computeBuildSegments` already builds a `builtEdges` set and `onNetwork` set. But these are used defensively (don't rebuild, traverse for free) — never offensively ("where does my network already go that I should leverage?").

## The Cost-Per-Turn Heuristic

To evaluate whether a building investment is worthwhile, the bot needs a sense of **what a turn is worth**. This varies by game phase:

| Phase | Typical delivery value | Turns to complete | Value per turn | Build investment tolerance |
|-------|----------------------|-------------------|----------------|---------------------------|
| Early (turns 1-20) | 15-20M payouts | Many turns building | ~2-3M/turn | Low — cash is scarce, network is small |
| Mid (turns 30-60) | 20-30M payouts | Faster deliveries | ~5-8M/turn | Moderate — corridors and spurs pay off quickly |
| Late (turns 60+) | 25-40M payouts | Fast on mature network | ~8-15M/turn | High — saving 1 turn is worth 10M+ |

When evaluating a build option (spur, shortcut, ferry connection):
1. Estimate turns saved: `(overland_distance - shortcut_distance) / speed`
2. Estimate build cost: terrain costs for the new segments
3. Calculate: `turns_saved * value_per_turn` vs `build_cost`
4. If `turns_saved * value_per_turn > build_cost`, build it

## Implementation Plan

### Part 1: Pre-Build Network Analysis (highest impact — prevents parallel tracks)

Before `computeBuildSegments` runs, add a network analysis step:

1. **Nearest-existing-track check**: For the target city, find the closest point on the existing network (BFS from target inward toward network nodes). If existing track is within N segments of the target, build a short connector from that point instead of a full path from the bot's current position.

2. **Parallel track detection**: After `computeBuildSegments` proposes a build path, check if the path runs parallel to existing track (within 1-2 hexes for 3+ segments). If so, re-run the pathfinder with a waypoint through the existing track to create a connection instead of a parallel line.

3. **Network connectivity audit**: Before building, compute which parts of the network are disconnected "islands." If building the proposed path would NOT connect to an existing island that's near the target, check if a short detour would merge networks instead of extending a dead-end branch.

### Part 2: Near-Miss Detection (spurs, shortcuts, ferries)

Before each build phase, scan for high-value small investments:
1. **Spurs**: Is the existing network within 1-5 segments of a useful city (supply/delivery/major)? Calculate `turns_saved * value_per_turn` vs build cost.
2. **Shortcuts**: Compare network travel distance vs direct distance between frequently-paired cities. If a shortcut saves >= 4 mileposts and the cost/turn-saved ratio is favorable, flag it.
3. **Ferry connections**: Is the existing network within 1-4 segments of a ferry port? Would crossing the ferry dramatically shorten the route to a current destination? Compare `spur_cost + ferry_cost` vs overland alternative using the cost-per-turn heuristic.

### Opponent Track Fees — Not Addressed Here

The bot occasionally hemorrhages cash renting opponent track (game `7aa39254`: 32M in fees for a 25M delivery). But if Parts 1 and 2 work well — the bot builds corridors, spurs, and ferry connections proactively — it rarely ends up needing long stretches of opponent track. The remaining edge cases (small city at max connections, end-game speed) are genuinely rare and not worth engineering for separately. Revisit only if the problem persists after Parts 1 and 2 ship.

## Files

- `src/server/services/ai/computeBuildSegments.ts` — Core pathfinder; needs pre-build analysis wrapper
- `src/server/services/ai/ActionResolver.ts` — Calls computeBuildSegments; pass network context
- `src/server/services/ai/TurnComposer.ts` — `tryAppendBuild()` spur/ferry integration
- `src/server/services/ai/PlanExecutor.ts` — Best place for pre-build network analysis; knows route + network
- `src/shared/services/TrackNetworkService.ts` — `buildTrackNetwork()` produces the adjacency graph
- `src/server/services/ai/WorldSnapshotService.ts` — `bot.existingSegments` is the source of truth
- `src/server/__tests__/computeBuildSegments.test.ts` — Existing pathfinder tests

## Acceptance Criteria

- [ ] Bot does NOT build parallel tracks through the same corridor — existing nearby track is leveraged via connectors
- [ ] Before building, bot checks if existing track already reaches near the target and builds a short connector instead
- [ ] Proposed build paths are checked for parallelism with existing track and re-routed if detected
- [ ] Bot detects nearby ferry ports and evaluates ferry routes using cost-per-turn heuristic
- [ ] Bot builds spurs to nearby useful cities when the main path passes close
- [ ] Cost-per-turn threshold scales with game phase (low early, high late)
- [ ] When no existing track is nearby, building behavior is unchanged (backward compatible)
- [ ] Budget constraints always respected
- [ ] Decisions are logged for observability

## Priority

CRITICAL — this is the #1 reason bots lose games. In game `7bf86af8`, Flash wasted an estimated 130-180M on redundant track — more than half the 250M victory threshold. Part 1 (preventing parallel tracks) is the single highest-impact improvement available.
