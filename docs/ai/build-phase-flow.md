# Build Phase (Phase B) — Decision Flow Diagram

## Entry Points

```
AIStrategyEngine.takeTurn()
    |
    +--[line 557]--> TurnComposer.compose(plan, snapshot, context, activeRoute, brain, gridPoints)
    |
    +--[line 782]--> TurnComposer.tryAppendBuild()  (post-delivery re-plan path)
                     Skipped if re-composed plan already has BUILD or upgrade pending
```

## Phase B Gate (inside compose())

```
compose()
    |
    v
+---------------------------+
| Original plan has BUILD   |---YES--> [SKIP Phase B]
| or UPGRADE?               |
+---------------------------+
    | NO
    v
+---------------------------+
| Enriched plan has         |---YES--> [SKIP Phase B]
| UPGRADE step?             |
+---------------------------+
    | NO
    v
tryAppendBuild()
```

## tryAppendBuild() — Full Decision Tree

```
tryAppendBuild(snapshot, context, activeRoute, trace, brain, gridPoints)
    |
    v
+-------------------------------+
| remainingBudget =             |
|   min(20M - turnBuildCost,    |
|       bot.money)              |
| remainingBudget <= 0?         |---YES--> [RETURN empty — no budget]
+-------------------------------+
    | NO
    v
+-------------------------------+
| Collect unreachedRouteStops:  |
| route stops where city is     |
| NOT on bot's track network    |
+-------------------------------+
    |
    v
+-------------------------------+
| Route complete? (currentStop  |
| null or index >= stops.length)|---YES--> [RETURN empty — route done]
+-------------------------------+
    | NO
    v
+-------------------------------+
| VICTORY CHECK:                |
| bot.money >= 250M AND         |
| connectedMajorCities < 7?     |
| (bot can win but needs more   |
|  major city connections)      |
+-------------------------------+
    |                      |
    | YES                  | NO
    v                      v
Filter routeStops     routeStopsForBuild =
to major cities only  unreachedRouteStops
    |                      |
    +----------+-----------+
               |
               v
+-------------------------------+
| ADVISOR ELIGIBILITY:          |
| brain exists?                 |
| gridPoints exists?            |
| NOT initial build phase?      |
| NOT victory conditions?       |
| remainingBudget > 0?          |
+-------------------------------+
    |                      |
    | ALL TRUE             | ANY FALSE
    v                      |
                           |
=============================  |
   PATH A: LLM ADVISOR        |
=============================  |
    |                          |
    v                          |
BuildAdvisor.advise()          |
  - getTargetCoord()           |
  - getNetworkFrontier()       |
  - MapRenderer.renderCorridor |
  - LLM call (structured out)  |
  - validateWaypoints()        |
    |                          |
    v                          |
+------------------+           |
| advise() result? |           |
+------------------+           |
    |           |              |
    | non-null  | null         |
    v           |              |
+-------------------+          |
| action type?      |          |
+-------------------+          |
  |        |       |           |
  v        v       v           |
                               |
[useOpponent] [replan] [build/buildAlt]
  |             |         |    |
  v             v         v    |
Use alt-     Validate   resolveAdvisorBuild()
Build or     new route    |    |
skip         via Route    v    |
             Validator  SolvencyCheck.check()
               |          |    |
               v          v    |
          Build toward  +----------+
          first stop    | Solvent? |
          of new route  +----------+
                        YES |  | NO
                            |  v
                            | retryWithSolvencyFeedback()
                            |   (2nd LLM call, up to 2 retries)
                            |     |
                            |     +--solvent?--> accept segments
                            |     |
                            |     +--exhausted--> use if within
                            |                     raw budget
                            v
                     Accept segments
                            |
    +----------<------------+------------>---------+
    |                                              |
    | (segments produced)             (no segments |
    |                                  or null)    |
    v                                              v
[Skip to Victory Tier]                             |
                                                   |
               +---<-------------------------------+
               |
               v
=============================
   PATH B: JIT FALLBACK
   (JIRA-139)
=============================
               |
               v
Condition: no segments built AND
           (advisor not used OR returned null)
               |
               v
+-------------------------------+
| routeStopsForBuild            |
| has entries?                  |
+-------------------------------+
    |                      |
    | YES                  | NO
    v                      v
jitCity =              [LOG "no unreached stops"]
  routeStopsForBuild[0]   [Skip — no build]
    |
    v
trainSpeed = TRAIN_PROPERTIES[bot.trainType].speed
runway = calculateTrackRunway(snapshot, jitCity, trainSpeed, context)
    |
    v
+-------------------------------+
| runway >= 2 turns?            |
+-------------------------------+
    |                      |
    | YES                  | NO
    v                      v
[LOG "deferring build"]  [LOG "building"]
[Skip — enough track]   ActionResolver.resolve(
                           BUILD toward jitCity)
                             |
                             v
                        Accept segments
                             |
    +----------<-------------+------------>---------+
    |                                               |
    v                                               v
(segments built)                           (no segments)


=============================
   PATH C: VICTORY BUILD
   (JIRA-125)
=============================
               |
               v
Condition: victoryConditionsMet
           (money >= 250M AND connectedMajorCities < 7)
               |
               v
+-------------------------------+
| Unconnected major cities      |
| exist AND victoryBudget > 0?  |
+-------------------------------+
    |                      |
    | YES                  | NO
    v                      v
Find cheapest            [Skip]
unconnected major
city NOT in routeStops
    |
    v
ActionResolver.resolve(BUILD toward it)
    |
    v
Accept segments (stacks with earlier paths)


=============================
   PATH D: SPECULATIVE
   MAJOR CITY FALLBACK
=============================
               |
               v
Condition: NOT victoryConditionsMet
           AND no segments built yet
               |
               v
+-------------------------------+
| No route needs build?         |
| Not mid-route (travel/act)?   |
| bot.money > 230M?             |
| Unconnected major cities?     |
+-------------------------------+
    |                      |
    | ALL TRUE             | ANY FALSE
    v                      v
Build toward first       [RETURN empty — no build]
unconnected major city
via ActionResolver.resolve()


=============================
   RETURN RESULT
=============================
               |
               v
+-------------------------------+
| allBuildSegments.length > 0?  |
+-------------------------------+
    |                      |
    | YES                  | NO
    v                      v
Return BuildResult       [RETURN empty]
  { plan: BuildTrack,
    segments,
    targetCity,
    advisorAction?,
    advisorWaypoints?,
    advisorReasoning?,
    advisorLatencyMs?,
    solvencyRetries? }
```

## Path Priority & Stacking

Paths cascade — they are NOT mutually exclusive:

| Priority | Path | When it runs | Can stack? |
|----------|------|-------------|------------|
| 1 | A: LLM Advisor | Advisor eligible and returns result | No — if segments produced, B is skipped |
| 2 | B: JIT Fallback | Advisor not used or returned null, no segments yet | No — produces segments or skips |
| 3 | C: Victory Build | money >= 250M, < 7 major cities connected | YES — adds on top of A or B |
| 4 | D: Speculative | No victory, no segments, money > 230M, no route needs | Only if A+B+C produced nothing |

## Key Supporting Functions

| Function | File:Line | Purpose |
|----------|-----------|---------|
| `calculateTrackRunway()` | TurnComposer:1332 | BFS from bot along existing track toward destination. Returns `mileposts / trainSpeed` = turns of track remaining |
| `shouldDeferBuild()` | TurnComposer:1273 | Full JIT gate (route + commitment + runway check). Defined but NOT called — Path B does inline check |
| `tryNearMissBuild()` | TurnComposer:1156 | Scans ferry/demand spurs near network. Defined but NOT called |
| `resolveAdvisorBuild()` | TurnComposer:1103 | Wraps ActionResolver with advisor waypoints |
| `SolvencyCheck.check()` | SolvencyCheck:25 | Checks affordability including projected delivery income. Bot can spend to zero (no cash reserve) |
| `ActionResolver.resolveBuild()` | ActionResolver:113 | Multi-source Dijkstra, waypoint chaining, ferry support, parallel path detection |
| `computeBuildSegments()` | computeBuildSegments:206 | Core Dijkstra with proximity penalty, dead-end pruning, early termination |
| `BuildAdvisor.advise()` | BuildAdvisor:36 | LLM call with corridor map, structured output, waypoint validation/snapping |
| `BuildAdvisor.retryWithSolvencyFeedback()` | BuildAdvisor:119 | 2nd LLM call with cost feedback when first suggestion is too expensive |

## Game Rules Governing Build Phase

- **Budget cap**: 20M ECU per turn for building OR upgrading (mutually exclusive)
- **Victory condition**: >= 7 connected major cities AND >= 250M cash
- **Track building costs**: Clear 1M, Mountain 2M, Alpine 5M, Small/Medium city 3M, Major city 5M, plus water crossing surcharges
- **Right of Way**: Only one track section between any two mileposts
- **No credit**: Cannot build more track than immediately payable
