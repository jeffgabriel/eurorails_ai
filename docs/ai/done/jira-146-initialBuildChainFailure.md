# JIRA-146: Initial Build Chain Failure — Game bbc1a21d

## Summary
Two root bugs cause the bot to (1) pick a terrible opening route and (2) waste both initial build turns. Fixing these two issues eliminates the downstream symptoms (PassTurn on initial turns, null build targets, sprawling track in Sweden).

## Game Context
- **Game ID:** bbc1a21d-7a74-44c1-aec4-637a03376677
- **Bot:** Haiku, starting at Berlin with 50M
- **Demand Hand:**
  - Card 81: Steel from Ruhr → Berlin (8M) — **trivial 1-turn delivery, Ruhr is adjacent to Berlin**
  - Card 81: Labor from Zagreb → Manchester (36M)
  - Card 81: Ham from Warszawa → Zagreb (18M)
  - Card 58: Marble from Firenze → Holland (25M)
  - Card 58: Coal from Wroclaw → Hamburg (12M) — **short, nearby**
  - Card 58: Wood from Stockholm → Bilbao (44M)
  - Card 107: Sheep from Cork → Lisboa (17M)
  - Card 107: Potatoes from Szczecin → Stockholm (29M) — **requires ferry to Sweden**
  - Card 107: Beer from Praha → Szczecin (9M)

## Bug 1: InitialBuildPlanner route selection ignores proximity and feasibility

**What happened:** The planner chose Potatoes: Szczecin → Stockholm (29M, requires ferry to Sweden) as the initial delivery route.

**What should have happened:** Steel: Ruhr → Berlin is an 8M delivery requiring almost zero track (Ruhr is adjacent to Berlin). Coal: Wroclaw → Hamburg is 12M and nearby. Beer: Praha → Szczecin is 9M and reachable. Any of these are dramatically better opening routes than one requiring a ferry crossing to Scandinavia.

**Root cause:** `InitialBuildPlanner.planInitialBuild` scoring algorithm over-weights raw payout (29M) and doesn't adequately penalize route complexity (ferry crossings, distance, number of build turns required). A 29M delivery that takes 8+ turns and requires a ferry is worse than an 8M delivery that takes 1 turn.

**Where to look:**
- `src/server/services/ai/InitialBuildPlanner.ts` — `scorePairing()` and `planInitialBuild()`
- The scoring should heavily weight: (1) proximity to starting city, (2) build cost relative to 40M initial budget, (3) feasibility within first few turns, (4) avoid ferries in initial route

## Bug 2: BuildAdvisor should not be called during initial build phase

**What happened:** During initial build turn 1, TurnComposer invoked BuildAdvisor (an LLM call) to determine build waypoints. The LLM-generated waypoints resolved to 3 segments from Berlin, violating the 2-segment major city limit. TurnValidator caught this, but recomposition stripped all build actions → PassTurn. This happened on both initial build turns — the bot built nothing.

**Evidence from log:**
```
Turn 1: action=PassTurn, segs=0, cost=0, recomposeCount=1
         advisorAction=build, advisorLatencyMs=4730, advisorWaypoints=[[20,47],[21,58]]
         firstViolation="Cannot build more than 2 track sections from major city Berlin (attempted 3)"
Turn 2: action=PassTurn, segs=0, cost=0, recomposeCount=1
         firstViolation="Cannot build more than 2 track sections from major city Berlin (attempted 3)"
```

**What should have happened:** BuildAdvisor should NOT be called during the initial game phase. There is no existing track to complicate path planning — a simple Dijkstra pathfinding algorithm from starting city → supply city → delivery city is all that's needed. No LLM required.

**Required behavior during initial build:**
1. Use Dijkstra shortest path from start city → first route stop → second route stop
2. Follow the established fallback build logic (same as when BuildAdvisor fails): no speculative building, no wasting budget, only build enough track to fulfill planned routes
3. Build only enough track for the next 2 turns or less — don't try to build the entire route in one shot
4. Respect the 2-segment major city limit inherently (Dijkstra path produces ordered segments that can be capped per turn)

**Root cause:** TurnComposer Phase B calls BuildAdvisor unconditionally regardless of game phase. During initial build, the LLM adds no value — it's a cold start with no network, and the pathfinding problem is trivial.

**Downstream bugs this eliminates:**
- TurnValidator recomposition stripping all build → PassTurn (never triggers if segments respect limits)
- Null build target on turn 3 (bot has track from initial build, so build target resolves correctly)
- Sprawling track in Sweden (consequence of Bug 1's bad route, but Bug 2 fix ensures building is disciplined regardless)

**Where to look:**
- `src/server/services/ai/TurnComposer.ts` — Phase B build logic, should bypass BuildAdvisor during initial build
- `src/server/services/ai/computeBuildSegments.ts` — Dijkstra pathfinding already exists here, use it directly
- `src/server/services/ai/PlanExecutor.ts` — `findInitialBuildTarget()` and `executeInitialBuild()` for reference on how initial build was handled before BuildAdvisor existed
