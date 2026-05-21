# HOLD JIRA-8: Ferry Build Gap, Train Movement Through Gap, LLM Demand Card Hallucination

## Motivation

Three related bugs observed in game `4fe3d579`. The bot builds track toward London (requires Channel ferry crossing), but only 1 of 4 segments is actually built — leaving a gap near Ruhr. The bot's train then travels through this gap, and separately the LLM repeatedly proposes routes to deliver loads at cities where no matching demand card exists.

### Observed Failures (game 4fe3d579)

**Turn 3 — Incomplete build across ferry:**
```
[computeBuild] best path: 6 nodes, cost=11, newSegments=4
[computeBuild] extracted 1 segments, totalCost=4
```
Dijkstra found a 4-new-segment path toward London costing 11M (budget was 20M), but extraction only returned 1 segment costing 4M. The remaining 3 segments were silently dropped.

**Turns 10-13 — Train travels through track gap:**
The bot's UI shows a 1-space gap east of Ruhr between the track and the city outpost. Despite this gap, the bot's train successfully moved through the area. The gap is outside Ruhr's red area (the user confirmed this is a recurring issue at the same map position).

**Turns 14-20 — LLM hallucinates demand card deliveries:**
```
[RouteValidator] deliver(Imports@London): INFEASIBLE: No demand card for delivering Imports to London.
[RouteValidator] deliver(Imports@Wien): INFEASIBLE: No demand card for delivering Imports to Wien.
[RouteValidator] deliver(Cheese@Torino): INFEASIBLE: No demand card for delivering Cheese to Torino.
```
The LLM proposes these invalid deliveries on 3 separate planning attempts. RouteValidator catches and prunes them, but the LLM wastes retries and the invalid reasoning appears in the debug overlay.

---

## Bug 1: `extractSegments` drops post-ferry segments

### Root Cause

`computeBuildSegments.ts:603-632` — The `connectedViaBuilt` set traces connectivity from `path[0]` by following **only built edges**. When the Dijkstra path crosses a ferry, the path structure is:

```
[network_node] → [new1] → [ferry_near] ~ferry~ [ferry_far] → [new2] → [new3] → [new4]
```

The edge from `network_node` to `new1` is a new segment (not yet built). `connectedViaBuilt` only follows built edges, so it never reaches `new1` or `ferry_near`. The ferry crossing check at line 622 (`connectedViaBuilt.has(fromKey)`) fails because `ferry_near` is not in the set. Therefore `ferry_far` is never added to `connectedFromPath`.

Result: Run 2 (the 3 post-ferry segments) has a `startKey` not in `connectedFromPath`, so it's filtered out at line 632. Only Run 1 (1 segment, 4M) survives.

The logic assumes connectivity is only through pre-existing track, but new segments from earlier runs WILL be built on the same turn, making the ferry port reachable.

### Fix

Lines 606-613: Change `connectedViaBuilt` to also follow new-segment edges (everything that isn't a ferry crossing), not just built edges:

```typescript
// Current (broken): only follows built edges
if (connectedViaBuilt.has(fromKey) && builtEdges.has(edgeKey)) {
  connectedViaBuilt.add(toKey);
}

// Fixed: follows built edges AND new segment edges (they will be built this turn)
if (connectedViaBuilt.has(fromKey) &&
    (builtEdges.has(edgeKey) || !ferryEdgeKeys.has(edgeKey))) {
  connectedViaBuilt.add(toKey);
}
```

This propagates connectivity through new segments so that when the path reaches `ferry_near` via new segments, the ferry crossing check succeeds and post-ferry runs are included.

### Files to Change

| File | Change |
|------|--------|
| `src/server/services/ai/computeBuildSegments.ts` | Fix `connectedViaBuilt` traversal (lines 606-613) |
| `src/server/__tests__/computeBuildSegments.test.ts` | Add test: path crossing ferry extracts segments on both sides |

---

## Bug 2: Bot train moves through track gap

### Root Cause

Two interacting issues:

1. **TurnExecutor discards the computed path.** `TurnExecutor.handleMoveTrain` (line 361-368) sends ONLY the final destination to `PlayerService.moveTrainForUser`. The pre-computed path from `ActionResolver.resolveMove` is thrown away. `moveTrainForUser` re-computes a path from scratch via `computeTrackUsageForMove`.

2. **Union track graph bridges gaps via major city internals.** `trackUsageFees.ts:84-93` adds ALL major city center↔outpost edges as public edges unconditionally. If the bot has track touching two different Ruhr outposts (one from the west, one from the east — potentially via Bug 1's incomplete builds), the pathfinder routes through Ruhr's internal edges even though the track sections aren't contiguously connected.

The visual result: the train appears to jump across the gap because the major city internal routing isn't rendered as track on the map.

### Fix

**Primary fix**: Bug 1 (complete track builds eliminate the gap).

**Secondary fix**: Add diagnostic logging to `moveTrainForUser` so movement paths can be audited:

```typescript
// After line 1226 in playerService.ts:
if (usage.path.length > 0) {
  console.log(`[moveTrainForUser] ${from.row},${from.col} → ${to.row},${to.col} via ${usage.path.length} edges`);
}
```

**Optional hardening**: In `TurnExecutor.handleMoveTrain`, pass the full pre-computed path to `moveTrainForUser` instead of just the destination, and validate that the path matches what the server computes. This prevents path divergence between the AI's resolution and the server's execution.

### Files to Change

| File | Change |
|------|--------|
| `src/server/services/ai/computeBuildSegments.ts` | Fix Bug 1 (primary) |
| `src/server/services/playerService.ts` | Add movement path logging |
| `src/server/services/ai/TurnExecutor.ts` | (Optional) Pass full path to moveTrainForUser |

---

## Bug 3: LLM confuses supply and delivery cities

### Root Cause

The demand card format in `ContextBuilder.ts:767` shows:

```
a) Imports from London → Budapest (45M)
```

The LLM reads "Imports... London" and constructs `deliver(Imports@London)` — confusing the **supply city** (London = where you PICKUP Imports) with the **delivery city** (Budapest = where you DELIVER for payout). This is an ambiguous format — "from London" could mean "originating from London" or "for London."

The `ROUTE_PLANNING_SYSTEM_SUFFIX` (`systemPrompts.ts:85-147`) explains PICKUP/DELIVER ordering but never explicitly states: "You can ONLY deliver to the delivery city shown on your card." The retry error message (`No demand card for delivering Imports to London`) doesn't explain the supply/delivery distinction, so the LLM repeats the mistake.

### Fix

**1. Reformat demand card display** — both `serializePrompt` (line 590) and `serializeRoutePlanningPrompt` (line 767):

```
// Current (ambiguous):
a) Imports from London → Budapest (45M)

// Fixed (explicit action labels):
a) PICKUP Imports at London, DELIVER to Budapest (45M)
```

**2. Add delivery constraint to route planning prompt** — `systemPrompts.ts`, add to ROUTE PLANNING CRITERIA:

```
12. DELIVERY CONSTRAINT: You can ONLY deliver a load to the DELIVERY city on your demand card.
    Do NOT deliver to the pickup/supply city. Each card line specifies exactly one valid
    pickup city and one valid delivery city.
```

**3. Improve retry error context** — `LLMStrategyBrain.planRoute()` line 193:

```typescript
userPrompt += `\n\nYOUR PREVIOUS ROUTE PLAN FAILED VALIDATION:\n${lastError}`;
userPrompt += `\nREMINDER: You can ONLY deliver loads to DELIVERY cities listed on your demand cards. Re-read your cards carefully.`;
userPrompt += `\nPlease provide a corrected route.`;
```

### Files to Change

| File | Change |
|------|--------|
| `src/server/services/ai/ContextBuilder.ts` | Reformat demand display (lines 590, 767) |
| `src/server/services/ai/prompts/systemPrompts.ts` | Add DELIVERY CONSTRAINT rule |
| `src/server/services/ai/LLMStrategyBrain.ts` | Improve retry error context |
| `src/server/__tests__/ai/ContextBuilder.test.ts` | Update snapshot tests for new format |

---

## Priority

| Bug | Severity | Impact |
|-----|----------|--------|
| Bug 1 (ferry extraction) | **High** | Every cross-ferry build is incomplete. Causes track gaps, wasted money. |
| Bug 3 (demand format) | **Medium** | LLM wastes 2-3 retries per route plan. Falls back to heuristic. No gameplay damage (RouteValidator catches it). |
| Bug 2 (movement through gap) | **Low** | Cosmetic/diagnostic. Resolves itself when Bug 1 is fixed. |

## Test Plan

- [ ] Unit test: `computeBuildSegments` path crossing ferry extracts segments on both sides
- [ ] Unit test: `computeBuildSegments` cold-start (no track) path crossing ferry still only builds pre-ferry run
- [ ] Unit test: demand card serialization uses PICKUP/DELIVER format
- [ ] Integration test: bot builds toward London from Holland — verify all path segments extracted
- [ ] Manual test: play a game where bot route crosses Channel — verify no track gaps
- [ ] Manual test: verify LLM no longer proposes deliver-at-supply-city routes
