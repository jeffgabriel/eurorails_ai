# JIRA-129: Build Advisor — Strategic Oversight for Track Construction

_No component reviews track building holistically. Builds are locally rational but compose into poor networks — duplicates, aimless spending, and unaffordable commitments. An LLM Build Advisor replaces the current deterministic build logic with spatial reasoning._

## Goals (Priority Order)

### 1. Reduce Duplicate Track Builds

The bot builds new track through corridors where it already has track nearby. The post-build detector (`detectParallelPath`) misses corridor-level duplication where tracks are 3-4 hexes apart but serve the same route.

**Evidence** (confirmed across 5+ games):
- `f4f37c40`: *"duplicate rail path from london to lyon. you already have this track from holland to lyon. you were in holland! WTF?"*
- `a9a36784`: *"duplicate track to cardiff. could have reused the track to london"*
- `15d64904`: *"built track to lahavre ferry when harwich ferry was one segment away holland"*
- `fc8ecd8e`: *"duplicate track from the ferry and around paris"*
- `361153a6`: *"a lot of duplicate track west of berlin"*
- `10d07149`: Built 10M toward Manchester while reasoning said "Manchester is on-network via Newcastle."

### 2. Increase Smart Investments

Dijkstra finds the cheapest path, not the most valuable. It misses shortcuts, loop closures, and better connection points.

**Closing the loop**: The bot builds U/C-shaped networks where endpoints are 3 hexes apart on the map but 15 mileposts apart on the network. Dijkstra never proposes closing the gap because the existing path is "free." But a full loop is almost always a prerequisite for victory and saves enormous travel time.

**Better connection points**: Game `15d64904` — bot built multi-segment track to Le Havre ferry when Harwich was 1 segment from Holland.

### 3. Stop Building Without a Target

The bot builds with no delivery purpose — speculative ferry port spurs, spending money because budget is available. The near-miss scanner (`tryNearMissBuild`) builds toward anything nearby without checking the route. The JIT gate evaluates stale destinations after re-eval.

Build only toward the current or next delivery stop. Period. Both `tryNearMissBuild` and the JIT gate (`shouldDeferBuild`) are replaced by the LLM advisor.

### 4. Use Opponent Track When It Makes Sense

The bot never considers using opponent track (4M/turn fee). Rarely, fees are cheaper than building — end-game, short connection, one-off delivery. Lowest priority.

## Solution

### Pipeline

```
  Phase A (move, pickup, deliver)
      |
      v
  LLM Build Advisor                         ← NEW
    → "What is the best way to connect these locations?"
    → Replaces: tryNearMissBuild, shouldDeferBuild (JIT gate)
      |
      v
  computeBuildSegments (Dijkstra through LLM waypoints)
      |
      v
  Solvency Check                             ← NEW
    → Can the bot afford these actual segments?
    → If NO: retry LLM with real cost — cheaper path, replan route, or alternative build
    → Max 2 retries
      |
      v
  Commit build / Post-build parallel detection / Turn Validator
```

### LLM Build Advisor

A cheap LLM call every build turn. Asks an open question — **"What is the best way to connect these locations?"** — not "is this right?" (LLMs are predisposed to agree).

**Input** (~3-4K tokens):
1. Compact ~20x20 hex corridor map (terrain, bot track, opponent track, cities)
2. Connected major cities and track endpoints
3. Target city, cash, route stops, carried loads
4. Game phase (early/mid/late/endgame), turns remaining
5. Planned route — so LLM knows if bot returns along this corridor
6. Opponent track rules (4M per opponent per turn on their track)

```
Legend: .=clear(1) m=mountain(2) A=alpine(5) s=small(3) M=medium(3) *=major(5)
        B=bot track  O=opponent track  ~=river(+2)  T=target

     28  29  30  31  32  33  34
 19:  .   B   B   .   O   O   .
 20:  .   B   .   ~   O   .   .
 21:  .  *H   .   .   O>  .   .
 23:  .   .   .   .   T   .   .
```

**Output** — waypoints (strategic checkpoints), not full segment paths. LLM picks WHERE to route; Dijkstra finds the cheapest HOW between waypoints.

```json
{ "action": "build", "target": "Marseille", "waypoints": [[25,31],[23,33]],
  "reasoning": "Route through junction at (25,31)" }
```
```json
{ "action": "buildAlternative", "target": "close Wien-Holland loop",
  "waypoints": [[30,48],[28,45]],
  "reasoning": "Route leg too expensive. Close 3-hex gap — saves 10 mileposts/trip." }
```
```json
{ "action": "replan",
  "newRoute": [{"action":"pickup","load":"Wheat","city":"Lyon"},
               {"action":"deliver","load":"Wheat","city":"Manchester"}],
  "waypoints": [[32,38],[28,35]],
  "reasoning": "Original route costs 31M, bot has 8M. Wheat Lyon→Manchester is affordable." }
```
```json
{ "action": "useOpponentTrack",
  "reasoning": "Late game, one-off delivery, opponent covers the corridor." }
```

**No "skip" action.** Every turn is precious. If the planned build isn't feasible, build something else valuable — close a loop, extend toward victory, build a shortcut.

**Response handling**:
- `build` / `buildAlternative` → feed waypoints to `computeBuildSegments`
- `replan` → update active route in `BotMemoryState`, build toward new target
- `useOpponentTrack` → skip this corridor's build; LLM should also provide an alternative build if budget remains

**Exemptions**: Victory builds (cash > 250M) and initial build phase (turns 1-2) bypass the advisor.

**Cost**: Haiku-class, ~3-4K input + ~200 output. Fractions of a cent per call.

### Solvency Check

Runs AFTER Dijkstra produces real segment costs — not before, because pre-advisor estimates are often 3x wrong (JIRA-127).

```
actualBuildCost = sum of segment costs from Dijkstra
incomeBefore = payouts for carried loads whose delivery city IS already on network
canAfford = (cash + incomeBefore) >= actualBuildCost
```

No cash reserve — bot can spend to zero. Per-leg accounting: only count income that will be realized BEFORE the build is needed.

On failure, feed back to LLM with actual cost: "Path costs 22M, you have 8M." LLM retries with cheaper waypoints, replans the route, or proposes an alternative build. Max 2 retries.

**Evidence**: Game `361153a6` — $46M route, $39M cash, broke at T23. Game `10d07149` — 5M wasted on Marseille segments, abandoned next turn. Game `10d07149` — Flash built 15M at T43, 1M left, stuck for 4 turns.

## What This Replaces

- **`tryNearMissBuild`** — LLM handles near-miss opportunities with route awareness
- **`shouldDeferBuild` (JIT gate)** — LLM makes better timing decisions with full map context

## What This Does NOT Do

- Does not replace TripPlanner (JIRA-126) — but can replan routes inline when builds are unaffordable
- Does not replace post-build `NetworkBuildAnalyzer` — still needed as geometric safety net
- Does not change `computeBuildSegments` Dijkstra — advisor provides waypoints, Dijkstra executes

## Prerequisite: Re-Eval Build Bypass Bug

Builds triggered during post-delivery re-eval (Stage 3d) bypass Phase B gates. The re-eval produces a new route mid-turn but builds execute without solvency or advisor checks.

**Evidence**: Game `10d07149` — Haiku T8 (built toward Manchester without checks), T28 (20M toward Madrid without affordability check), Flash T39/T42 (builds despite stale gate context).

**Fix**: When re-eval produces a new route mid-turn, all Phase B gates must run against the new route before building.
