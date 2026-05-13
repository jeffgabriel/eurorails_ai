# JIRA-14: Monday Bug List (2026-03-03)

Game: `f2954359-c1b2-408f-ad06-54df0a17689b`
Bot: `Bot 1` — Freight train, started with 50M

Bot's hand after first delivery:
- Card 78: Labor→Paris 25M, Beer→Hamburg 9M, Tourists→Venezia 19M
- Card 71: Oranges→Wien 42M, Oil→Antwerpen 20M, China→Oslo 30M
- Card 26: Oranges→Holland 33M, Iron→Praha 17M, Machinery→Dublin 25M

Game: `6a1d421e-5f09-441a-8913-953544a1f3c9`
Bot route: pickup(Cattle@Bern) → deliver(Cattle@London)

---

## Triage: JIRA-16 overlap

JIRA-16 (Geographic Strategy) is being implemented first. It removes `secondaryBuildTarget`, adds geographic/hand-evaluation/upgrade strategy to the route planning prompt, and restructures demand context by card. This fully or partially addresses bugs 1, 7, and 8 below.

| Bug | JIRA-16 coverage | Remaining work for JIRA-14 |
|-----|-----------------|---------------------------|
| 1 | **Fully fixed** — secondaryBuildTarget removed | None |
| 7 | **Largely fixed** — geographic strategy + hand evaluation teach the LLM why Iron→Praha beats China→Oslo; capital velocity concept directly addresses this | Verify after JIRA-16 — may need explicit "reference the demand ranking" instruction if LLM still ignores it |
| 8 | **Prompt-side fixed** — ferry cost awareness in GEOGRAPHIC STRATEGY | **Code bug remains**: `computeBuildSegments` pathfinding doesn't treat ferry ports as mandatory waypoints. Needs a separate code fix. |

**Remaining JIRA-14 bugs after JIRA-16**: 2, 3, 4, 5, 6, 8 (code side), 9, 10, 12

---

## ~~Bug 1: Bot builds a spur to Ruhr with no matching demand cards~~ → Fixed by JIRA-16

During initial build, the bot spends 5M connecting to Ruhr. It has no demand cards that deliver to Ruhr and no demand cards for any of Ruhr's resources. The 5M is wasted capital in the early game when every ECU matters.

After the primary route stops are connected, the bot automatically builds toward a "secondary build target" chosen for victory progress (connecting 7 major cities). This happens regardless of whether the bot has any near-term use for that city.

**Fix**: ~~Remove the secondary build target feature.~~ Done in JIRA-16 — `secondaryBuildTarget` removed from prompt, response format, ResponseParser, PlanExecutor, and TurnComposer.

---

## Bug 2: Bot returns to Szczecin on turn 5 after already picking up

Turn-by-turn:
- Turn 4: Bot moves to Szczecin, picks up Potatoes, moves west — correct
- Turn 5: Bot reverses direction and moves BACK to Szczecin — wastes entire turn
- Turn 6: Bot finally heads west toward Antwerpen

After picking up Potatoes and correctly heading west, the bot inexplicably reverses and returns to the pickup city on the next turn. One full turn of movement is wasted.

**Likely cause**: Route state not advancing `currentStopIndex` after pickup, so PlanExecutor still thinks it needs to go to Szczecin. Or the LLM re-plans the route from scratch each turn and doesn't realize it already picked up.

---

## Bug 3: Debug overlay demand ranking shows demands from discarded cards

After delivering Potatoes to Antwerpen (fulfilling card 117), the debug overlay demand ranking still shows "Chocolate to Glasgow" as the #1 option. That demand was on card 117, which was discarded upon delivery. The bot's actual hand no longer contains that card.

The ranking displayed reflects the bot's hand at the START of the turn, before delivery happened. It is never refreshed after a delivery changes the hand.

**Likely cause**: Client-side `StrategyInspectorModal` caches the demand ranking from the turn start and doesn't re-fetch after mid-turn deliveries.

---

## Bug 4: Pickup actions not recorded in turn history

The bot picked up Potatoes at Szczecin (confirmed by later delivering them), but no pickup event appears in the turn_actions table. Only moves and deliveries are recorded. This makes it difficult to trace bot decisions from the database.

**Likely cause**: TurnExecutor's pickup handler doesn't insert into `turn_actions`. JIRA-12 BE-009 added logging but not DB recording.

---

## Bug 5: Bot wastes 8 of 9 movement points after delivering at Antwerpen

Turn 8: Bot moves 1 milepost to Antwerpen, delivers Potatoes for 17M. Turn ends immediately. The Freight train has 9 speed — 8 movement points go unused. No BUILD action happens either, despite the bot having 39M cash.

After a delivery completes the route, the bot has no idea where to go next. The newly drawn demand card isn't visible to the rest of the turn's decision-making. The bot also skips building because it thinks it's still mid-route.

**Likely cause**: When PlanExecutor returns `routeComplete: true`, the pipeline stops without attempting a continuation move or build with remaining movement/budget. TurnComposer Phase A2 (chain continuation move) may not fire when the route completes mid-turn.

---

## Bug 6: Bot passes turn 9 entirely after route completion

Turn 9 is a complete PASS — no movement, no building, nothing. The bot sits at Antwerpen doing nothing for an entire turn.

After the route completed on turn 8, the bot needs to plan a new route. When the LLM route planning call fails, the bot falls back to PASS with no recovery attempt. It doesn't try any heuristic like moving toward a demand city or building toward the cheapest demand.

**Likely cause**: AIStrategyEngine's retry logic exhausts 3 attempts on LLM route planning, then falls back to PassTurn. Needs a heuristic fallback that picks the highest-ranked demand and builds/moves toward it without LLM involvement.

---

## ~~Bug 7: Bot ignores demand ranking when planning routes~~ → Largely fixed by JIRA-16

The demand ranking scores Iron→Praha as #1 (cheap to reach, good ROI). The bot instead picks China→Oslo, which is ranked near the bottom — requiring expensive track through Denmark and a ferry crossing. This drains the bot from 39M down to 5M.

The demand ranking data IS included in the context the LLM sees, but the route planning instructions never tell the LLM to use it. The ranking is treated as informational, not prescriptive.

**JIRA-16 fix**: Geographic Strategy teaches the LLM that Oslo is peripheral (ferry + 15-25M), Praha is near-core, and capital velocity matters. Hand Evaluation teaches the LLM to evaluate per-card best options. Combined, this gives the LLM the strategic intelligence to prefer Iron→Praha over China→Oslo without needing a prescriptive "follow the ranking" rule.

**Verify after JIRA-16**: If the LLM still picks bad routes despite geographic context, add an explicit instruction to reference demand ranking scores in route selection.

---

## Bug 8: Bot builds 2M of wasted track past the Hirtshals ferry

When building toward Oslo, the bot builds 2 segments (2M) going northwest past the Hirtshals ferry port, then separately builds to the actual ferry port for 8M. The 2 northwest segments serve no purpose — the ferry was the correct stopping point.

**Two-part fix**:
1. **Prompt-side (JIRA-16)**: Geographic Strategy teaches ferry costs and peripheral region awareness. The LLM should avoid Oslo routes entirely in early game, making this bug less likely to manifest.
2. **Code-side (JIRA-14)**: `computeBuildSegments` pathfinding doesn't recognize ferry ports as mandatory waypoints when building toward a cross-water destination. When the target is across a ferry, the pathfinder should route TO the ferry port, not past it. This is a Dijkstra termination condition bug.

---

## Bug 9: Bot fails to use full movement on turn 12

On turn 12 the bot moves only 3 of 9 mileposts before building. The bot should be using its full movement allowance every turn, especially when carrying loads toward a delivery destination.

**Likely cause**: ActionResolver's `resolveMove` path computation returns a short path (possibly due to track network gaps or pathfinding hitting a dead end), and the bot doesn't attempt to extend movement along the best available direction.

---

## Bug 10: PlanExecutor stop index never advances after mid-move pickup

**Game**: `6a1d421e-5f09-441a-8913-953544a1f3c9`

Turn-by-turn:
- Turn 4: Bot auto-placed, moves toward Bern
- Turn 5: Bot moves to Bern, picks up Cattle mid-move (TurnComposer chains PICKUP onto MOVE)
- Turn 6: Bot has Cattle loaded but route is STILL at `currentStopIndex=0` (pickup@Bern). Bot moves toward Bern AGAIN.

After picking up Cattle while passing through Bern during a MOVE, the route's `currentStopIndex` never advances to stop 1 (deliver@London). The bot loops back to the pickup city indefinitely.

**Root cause**: `PlanExecutor.execute()` only advances `currentStopIndex` inside `executeAction()`, which only runs when `isBotAtCity()` returns `true` — i.e., the bot must be AT the city at the START of the turn. When TurnComposer chains a PICKUP onto a MOVE mid-turn, PlanExecutor never runs `executeAction()` for that stop, so the index stays at 0.

**Fix**: At the start of `PlanExecutor.execute()`, before the "Am I there?" question, check if the current stop is a PICKUP and the load is already on the train. If so, advance `currentStopIndex` immediately. Similarly for DELIVER stops where the load has already been delivered.

**Files**: `src/server/services/ai/PlanExecutor.ts` — `execute()` method (line 50-85), `isBotAtCity()` (line 416-420), `advanceStop()` (line 394-400)

---

## ~~Bug 11: LLM returns prose analysis instead of JSON for route planning~~ → Fixed by JIRA-17

**Game**: `6a1d421e-5f09-441a-8913-953544a1f3c9`

On turn 1, the LLM returns a long prose analysis of the game state instead of the required JSON format. `ResponseParser.parseStrategicRoute()` throws "Unexpected token" errors. This happens on 2 of 3 retry attempts before the third succeeds.

**Root cause**: Two compounding issues:
1. **System prompt encourages analysis**: JIRA-16 added ~80 lines of strategic guidance (GEOGRAPHIC STRATEGY, HAND EVALUATION, CAPITAL VELOCITY). The LLM interprets this as an invitation to write analytical prose before/instead of the JSON response.
2. **ResponseParser has no JSON extraction fallback**: `parseStrategicRoute()` does `JSON.parse(clean)` with zero tolerance for surrounding text. Unlike `parseActionIntent()`, which has regex fallback patterns to extract JSON from prose, the route parser has no recovery path.

**Fix**:
1. Strengthen the response format instruction — move it to the END of the system prompt (recency bias) and add "DO NOT include any text before or after the JSON."
2. Add JSON extraction fallback to `parseStrategicRoute()` — regex to find `{...}` within prose text, matching what `parseActionIntent()` already does.
3. In retry prompts, explicitly state "Respond with ONLY JSON. No analysis, no explanation."

**Files**: `src/server/services/ai/ResponseParser.ts` — `parseStrategicRoute()` (line 266-329); `src/server/services/ai/prompts/systemPrompts.ts` — response format section; `src/server/services/ai/LLMStrategyBrain.ts` — retry logic

---

## Bug 12: Ferry movement wastes an extra turn — no teleportation to opposite port

**Game**: `6a1d421e-5f09-441a-8913-953544a1f3c9`

Turn-by-turn at Calais-Dover ferry:
- Turn 8: Bot moves to Calais (33,23) — stops at ferry port. **Correct** per game rules.
- Turn 9: Bot at Calais, moves to Dover (33,22) ONLY. Entire turn used for one milepost. **WRONG** — bot should START at Dover with 5 mileposts of half-rate movement remaining.
- Turn 10: Bot at Dover, moves to London at half-speed (5 mileposts). **WRONG** — bot should be at full speed since the crossing turn was Turn 9.

The ferry costs 3 turns (approach + cross + half-speed departure) instead of the correct 2 turns (stop at port + start at opposite port at half rate). This makes ferry routes ~50% slower than they should be.

**Root causes** (three separate bugs):

### 12a: No ferry teleportation
The code treats the ferry crossing as a regular movement step. Per game rules, the bot should START its turn at the opposite port (free teleportation). Instead, the pathfinder plots a path from Calais through Dover and the ferry truncation loop (ActionResolver.ts line 263-276) truncates at Dover because it's also a FerryPort. The bot "moves" one milepost from Calais to Dover and stops.

**Fix**: When the bot starts a turn at a FerryPort, detect the paired ferry port, teleport the bot's starting position to the opposite port, then pathfind from there at half speed. The "crossing" should not consume any movement.

### 12b: Ferry truncation fires at both ports (double-stop)
The ferry truncation loop at ActionResolver.ts line 267-275 iterates the path and truncates at ANY FerryPort terrain. On the crossing turn, the path goes Calais→Dover→...→London, and the loop finds Dover at index 1 (it's also TerrainType.FerryPort). The bot is truncated to just [Calais, Dover]. The loop needs to skip the FIRST FerryPort in the path when the bot is starting from a FerryPort (the opposite port is expected in the path and shouldn't trigger truncation).

**Fix**: When the bot starts at a FerryPort, skip the paired ferry port in the truncation loop. Only truncate at OTHER FerryPorts encountered further along the path.

### 12c: ferryHalfSpeed flag persists incorrectly
`WorldSnapshotService.ts` (line 151-162) sets `ferryHalfSpeed=true` whenever the bot IS at a FerryPort terrain, regardless of whether the bot actually crossed a ferry. So on Turn 10, the bot starts at Dover (a FerryPort) and gets half-speed AGAIN, even though the crossing already happened on Turn 9.

**Fix**: `ferryHalfSpeed` should only be true on the turn the bot actually crosses the ferry — i.e., when the bot was at a FerryPort on the PREVIOUS turn and is now being teleported to the opposite port. A simple approach: track `usedFerryLastTurn` as a boolean on the player state, set it when the ferry teleportation happens, and clear it after one turn.

**Files**: `src/server/services/ai/ActionResolver.ts` — `resolveMove()` ferry truncation (line 263-276), `getBotSpeed()` (line 1079-1084); `src/server/services/ai/WorldSnapshotService.ts` — `ferryHalfSpeed` flag (line 151-162); `src/shared/types/GameTypes.ts` — WorldSnapshot.bot type may need `usedFerryLastTurn` field
