# JIRA-148: Haiku Route Selection & Build Advisor Speculative Building Bugs

## Source Game
`game-1b31e1a2` — Haiku bot, 9 turns, broke by T9

---

## Bug 1: Initial route selection picks worst demand

**Symptom**: The initial-build-planner chose `Cars@Stuttgart → Marseille (10M)` as the first delivery route despite it being ranked **#9 out of 9** in the demand ranking with a score of -1.15 and efficiency of -4.91M/turn.

**Better options available**:
- `China: Leipzig→Ruhr` — ranked #1, score 2.38, only 3 turns, delivery city already on-network (Ruhr is connected). Build cost to supply is 10M, delivery cost is 0M.
- `Wine: Frankfurt→London` — ranked #4, supply build cost only 3M (Frankfurt is near Ruhr)

**Demand ranking at T2**:
```
#1 China:     Leipzig→Ruhr        7M   score=2.38  eff=-1.00M/turn  3T  buildSupply=10M  buildDeliver=0M
#2 Hops:      Cardiff→Frankfurt  21M   score=-0.44 eff=-2.25M/turn  8T  buildSupply=36M  buildDeliver=3M
#3 Cork:      Sevilla→Wroclaw    59M   score=-0.56 eff=-3.14M/turn 14T  buildSupply=78M  buildDeliver=25M
#4 Wine:      Frankfurt→London   16M   score=-0.58 eff=-2.14M/turn  7T  buildSupply=3M   buildDeliver=28M
...
#9 Cars:      Manchester→Marseille 10M score=-1.15 eff=-4.91M/turn 11T  buildSupply=35M  buildDeliver=29M
```

**Root cause**: `InitialBuildPlanner` has its own simplified scoring formula that ignores the global demand ranking from `ContextBuilder.scoreDemand()`.

**Code path**:
1. `AIStrategyEngine.executeTurn()` (line 262-268) — when `isInitialBuild && !activeRoute`, calls `InitialBuildPlanner.planInitialBuild()`
2. `InitialBuildPlanner.planInitialBuild()` (line 54-102) — calls `expandDemandOptions()`, then picks `bestSingle` by max `.efficiency` (line 66)
3. `InitialBuildPlanner.expandDemandOptions()` (line 108-189) — iterates all demands, calculates local efficiency at **line 154**:
   ```typescript
   let efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns;
   ```
   This is raw ROI only — no corridor value, no victory bonus, no affordability penalty.

**Correct scoring** (`ContextBuilder.scoreDemand()`, lines 2327-2349) includes:
- `baseROI * (1 + corridorMultiplier)` — corridor bonus for network cities unlocked
- `+ victoryBonus` — major city connection value
- Affordability penalty for unaffordable routes

The global ranking uses `scoreDemand()` and puts China→Ruhr at #1 (score 2.38) because Ruhr is already connected (corridor bonus, zero delivery build cost). InitialBuildPlanner's simplified formula doesn't see these bonuses, so Cars→Marseille wins on raw `(payout - buildCost) / turns` even though it's objectively the worst option.

**Note**: Cars supply city in the global ranking is `Manchester` but the bot picked up at `Stuttgart` — `expandDemandOptions()` evaluates all supply cities where the load is available, which is why it found Stuttgart as a closer pickup point. The route `pickup(Cars@Stuttgart) → deliver(Cars@Marseille)` was chosen despite Stuttgart→Marseille being a long build through mountain/alpine terrain.

**Fix options**:
- (A) Have `InitialBuildPlanner` use `ContextBuilder.scoreDemand()` or the pre-computed `demandScore` from resolved demands
- (B) Pass the demand ranking into `InitialBuildPlanner` and let it pick from the top-N ranked demands
- (C) Replace the local efficiency formula with one that includes corridor and affordability factors

**Files**:
- `src/server/services/ai/InitialBuildPlanner.ts:54-102` (planInitialBuild), `108-189` (expandDemandOptions), `154` (efficiency formula)
- `src/server/services/ai/ContextBuilder.ts:2327-2349` (scoreDemand — the correct formula)
- `src/server/services/ai/AIStrategyEngine.ts:262-268` (entry point)

---

## Bug 2: Bot reverses direction after mid-path pickup at Stuttgart (T4)

**Symptom**: On turn 4, the bot starts at Ruhr (26,42), moves south to Stuttgart area (30,44), picks up Cars via A1 opportunistic split, then **reverses north** back to (29,43) instead of continuing south toward Marseille. Wastes 3 mileposts of movement.

**Movement path**:
```
(26,42) → (27,42) → (28,43) → (29,43) → (30,44) [Stuttgart area]
→ (31,43) → (32,44) [continues south briefly]
→ (31,43) → (30,44) → (29,43) [reverses north — wasted movement]
```

**Root cause**: A2 continuation has no directional awareness and `findMoveTargets` Priority 1.5 (frontier approach) has three compounding bugs.

After A1 splits the MOVE at Stuttgart and does the pickup, `currentStopIndex` advances to 1 (pointing at `deliver(Cars@Marseille)`). A2 kicks in and calls `findMoveTargets()`. The target cascade fails at every level:

1. **Priority 1** adds Marseille (deliver stop). `ActionResolver.resolve(MOVE to Marseille)` fails because Marseille is off-network — no track exists there yet.

2. **Priority 1.5** (frontier approach, `findMoveTargets` line 1462-1510) searches `citiesOnNetwork` for the city closest to Marseille by Manhattan distance. But it has three bugs:
   - **(a) No exclusion of the bot's current city.** The bot is standing at Stuttgart. Stuttgart is on-network. Stuttgart may be the closest on-network city to Marseille. `MOVE to Stuttgart` from Stuttgart produces a zero-length path, filtered out by `path.length > 1` at line 412. The frontier approach effectively returns nothing useful.
   - **(b) Searches all cities on network, not track endpoints.** It iterates every city on the network including interior nodes behind the bot. A city like Ruhr (far from Marseille but on-network) could be selected if hexagonal geometry makes it appear closer than Stuttgart. The search should target **track frontier nodes** — the endpoints of the bot's track segments where new track will be built from — not interior network cities the bot has already passed through.
   - **(c) Uses Manhattan distance on hex coordinates.** `|row - targetRow| + |col - targetCol|` is not hex distance. The test grid already has a proper `hexDistance` function. Using Manhattan distance on offset hex coordinates gives incorrect proximity results.

3. **Priority 2-4** kick in as fallback: demand delivery cities, demand supply cities, reachable cities. These have no relationship to the delivery direction and can point anywhere — including back north toward Ruhr.

4. **A2 has no directional filter.** Unlike A3 (which calls `filterByDirection` at line 475), A2 at line 393 calls `findMoveTargets` raw and accepts the first target that resolves, regardless of direction. But `filterByDirection` is also not the right fix — it assumes cardinal direction alignment and doesn't account for track topology.

**Fix**: Fix `findMoveTargets` Priority 1.5 to actually work:

1. **Exclude the bot's current city** from the frontier search. The bot is already there — moving to your own location is a no-op.

2. **Search track frontier nodes (segment endpoints), not all cities on network.** The frontier nodes are where new track will extend from. These are the points closest to the off-network destination in terms of network topology. Compute them from `snapshot.bot.existingSegments` — find segment endpoints that have only one connection (dead ends / track tips). `BuildAdvisor.getNetworkFrontier()` (line 364) already does this.

3. **Use hex distance instead of Manhattan distance.** `hexDistance()` from `MapTopology` gives correct proximity on the hex grid.

4. **Make Priority 1.5 the primary target when the delivery city is off-network**, not a supplement after Priority 1 already added the unreachable city. When the next stop is off-network, the frontier approach should be tried first — there's no point adding an off-network city as a MOVE target since it will always fail.

**Files**:
- `src/server/services/ai/TurnComposer.ts:1462-1510` — `findMoveTargets()` Priority 1.5 frontier approach (primary fix)
- `src/server/services/ai/TurnComposer.ts:393` — A2 continuation loop (consumer of `findMoveTargets`)
- `src/server/services/ai/BuildAdvisor.ts:364-395` — `getNetworkFrontier()` (reference implementation for frontier node computation)

---

## Bug 3: Build Advisor called unconditionally and builds speculatively toward unrelated cities

**Symptom**: The Build Advisor recommends building toward cities with no imminent pickup or delivery, and is called every single turn even when no building is needed — burning 20M/turn and driving bots broke:
- T5: "build toward Frankfurt" — no active demand at Frankfurt in the current route
- T6: "build toward Zurich" — Chocolate demand is 11 turns away, not imminent
- T8: "build toward London" — Wine delivery requires ~25M build cost (net negative: 16M payout - 25M build)

**Root cause — three compounding failures:**

### 3a. `shouldDeferBuild` is dead code — Build Advisor has no build gate

`TurnComposer.tryAppendBuild()` (line 845) calls the Build Advisor on every normal turn with only these guards:
```typescript
const useAdvisor = brain && gridPoints && !victoryConditionsMet && remainingBudget > 0 && !context.isInitialBuild;
```

There is **no check for whether the next destination is already on the network**. A fully-implemented JIT build gate exists at `TurnComposer.shouldDeferBuild()` (line 1297) with exactly the right logic:
- Destination already on network → runway = 10 → defer (don't build)
- No active route → defer
- Target not in route → defer
- Sufficient track runway (>= 2 turns) → defer

But `shouldDeferBuild` is **never called from production code**. It's defined, tested (`jira122-JITBuildGate.test.ts`), and completely dead. The bot calls the LLM-based Build Advisor every turn regardless, and the advisor always recommends building something — burning cash when the bot should be saving for deliveries or running on existing track.

### 3b. Demand cards leak strategy into a tactical tool

`getBuildAdvisorPrompt()` (`systemPrompts.ts:439-443`) dumps all 9 demand cards into the user prompt. The Build Advisor's role is purely tactical — find the best waypoints from the network frontier to a target city. The target is computed deterministically by `BuildAdvisor.getTargetCoord()` (`BuildAdvisor.ts:325-358`) from the active route's first unreached stop. But the LLM — especially Haiku — sees `Chocolate 40M` and `Wine 16M` alongside the actual target and gets distracted, overriding the intended target with speculative builds toward high-value cards.

### 3c. The returned target is never validated

`BuildAdvisor.advise()` computes `targetCity` at line 49 and uses it for corridor map rendering, but the LLM's response `parsed.target` (line 91) is never checked against it. The LLM can return `"target": "Frankfurt"` with waypoints heading in a completely different direction, and it passes through `validateWaypoints()` (which only checks that waypoints are valid grid coordinates, not that they're headed toward the right city).

**Build Advisor reasoning examples** (showing the LLM ignoring the computed target):
- T5: "Frankfurt is a major city that connects to multiple lucrative routes: Wine to London (16M)"
- T6: "building toward Zurich is strategically optimal. Zurich connects to the Chocolate demand (40M)"
- T8: "building directly north from the current network toward London is the priority"

**Fix (all three are required):**

1. **Wire in `shouldDeferBuild` before calling Build Advisor** (`TurnComposer.ts`, before line 856). Call `shouldDeferBuild()` and skip the advisor entirely when it returns `deferred: true`. This is the primary fix — the bot should only build when the next destination is off-network and track runway is insufficient. The logic already exists and is tested; it just needs to be called.

2. **Remove demand cards from the Build Advisor prompt** (`systemPrompts.ts:439-443`). The advisor does pathfinding, not strategy — it doesn't need demand cards to route between the frontier and the target. The active route section already tells it what the current delivery is. **This is a requirement, not optional.** Demand cards are strategy context that has no place in a tactical pathfinding prompt.

3. **Validate the returned target matches the computed target** (`BuildAdvisor.ts`, after line 104). If `parsed.target !== targetCityName`, either:
   - (a) Override `parsed.target` with `targetCityName` and keep the waypoints (if they're directionally reasonable), or
   - (b) Reject the response and return null (falling through to the deterministic Dijkstra fallback), or
   - (c) Log a warning and override — prefer (a) so the advisor still contributes waypoint intelligence even if it hallucinated the target name.

**Files**:
- `src/server/services/ai/TurnComposer.ts:845-856` — wire `shouldDeferBuild()` into `tryAppendBuild()` before the advisor call
- `src/server/services/ai/TurnComposer.ts:1297-1348` — `shouldDeferBuild()` (already correct, just dead code)
- `src/server/services/ai/prompts/systemPrompts.ts:439-443` — remove `DEMAND CARDS` section from `getBuildAdvisorPrompt()`
- `src/server/services/ai/BuildAdvisor.ts:49` — `targetCity` computation (already correct)
- `src/server/services/ai/BuildAdvisor.ts:88-109` — add target validation after parse/validate, before returning result
