# JIRA-166: Friday Bug Roundup — Game 3b19796d

## Game at a glance

23 turns logged (T2-T15), Haiku (claude-haiku-4-5) vs Nano (gpt-5.4-nano). Haiku goes broke at T11 and drifts toward off-network Barcelona for 4+ turns. Nano discards a $44M hand on T8 — an LLM decision, not a heuristic fallback. 38 LLM calls total (logged in separate llm transcript, not game log).

| | Haiku | Nano |
|---|---|---|
| Deliveries | 2 (19M) | 1 (17M) |
| Cash at T15 | $0 | $21M |
| Track cost | 69M (363% of income) | 46M (270% of income) |
| Connected cities | 1 (Paris) | 2 (Holland, Berlin) |
| Model | claude-haiku-4-5-20251001 | gpt-5.4-nano |
| Train | Freight (no upgrade) | Freight (no upgrade) |

---

## Bug 1: JIRA-165 oscillation fix doesn't catch "traveling but stuck" — CRITICAL

### What happens
Haiku hits $0 at T11, carrying Coal, route idx=1 (deliver Coal@Barcelona). Barcelona is off-network. Bot moves 5-9mp per turn from T12-T15 but can never reach Barcelona — remaining track can't be built at $0. Will oscillate indefinitely.

### Why JIRA-165 doesn't catch it
The JIRA-165 oscillation detection checks `noProgressTurns >= 3 && money < 5`. But `noProgressTurns` is never >= 3 because of how "progress" is defined:

**AIStrategyEngine.ts:819-821:**
```typescript
const isActivelyTraveling = activeRoute != null;
const madeProgress = hadDelivery || hadCashIncrease || hadNewTrack || isActivelyTraveling || hadDiscard;
```

`isActivelyTraveling` is `true` whenever `activeRoute != null`. Haiku HAS an active route, so `madeProgress = true` every turn, `noProgressTurns` resets to 0, and the oscillation detection never fires.

**The bot is "making progress" by the code's definition (has active route) but making zero actual progress (can't reach destination, can't build, no income).**

### Root cause
`isActivelyTraveling` is too broad — it treats "having a route" as progress, even when the bot can't advance toward the next stop. Progress should require actual delivery, income, or track built — not just route existence.

### Fix
Remove `isActivelyTraveling` from the progress definition, or narrow it: only count as progress if the bot moved closer to the next stop city AND the next stop is reachable (on-network or bot can afford to build to it).

Simpler fix: `isActivelyTraveling` should require `hadMovement && nextStopIsOnNetwork` — if the next stop requires building and bot has $0, traveling doesn't count as progress.

---

## Bug 2: Route scoring ignores geographic spread — HIGH

### What happens
Haiku T8 route: `pickup:Coal@Cardiff → deliver:Coal@Barcelona → pickup:Flowers@Holland → deliver:Flowers@Valencia`

This zigzags: Wales → southern Spain → Netherlands → eastern Spain. Massive backtracking across the entire map.

### Root cause
**TripPlanner.ts:343-345** — routes scored by `netValue / estimatedTurns`:
```typescript
const netValue = totalPayout - totalBuildCost;
const score = netValue / estimatedTurns;
```

No consideration of:
- Total travel distance (sum of all legs)
- Geographic backtracking penalty
- Whether the bot's current network is anywhere near the stops

Coal→Barcelona pays 32M, Flowers→Valencia pays 34M — high individual payouts. But the combined route requires building track across most of Europe from Paris with only $35M starting cash.

### Additional factor
`RouteValidator.reorderStopsByProximity()` (line 371) uses greedy nearest-neighbor to reorder stops, but reordering happens AFTER scoring. The scorer evaluates the LLM's original stop order, not the optimized one.

### Fix options
1. Add geographic spread penalty to score: multiply by `1 / totalDistanceTraveled` or similar
2. Reorder stops BEFORE scoring so the scorer evaluates the optimized path
3. Add a budget feasibility check: reject routes whose total build cost exceeds current cash

---

## Bug 3: Nano (gpt-5.4-nano) discards excellent hand — LLM decision quality — MEDIUM

### What happens
Nano at T8 discards a hand containing Sheep→Sarajevo ($44M), Iron→Roma ($40M), Imports→Beograd ($31M), Oil→Torino ($24M). Gets a worse hand back.

**Correction**: LLM transcript shows 38 calls — both bots have working API keys. Haiku uses claude-haiku-4-5-20251001, Nano uses gpt-5.4-nano. The game analysis script only reads `llmLog` from the game log (which is empty), not the separate LLM transcript file. This discard was an LLM decision by gpt-5.4-nano, not a heuristic fallback.

### Root cause
gpt-5.4-nano decided to discard after completing its Ham→Hamburg delivery at T7. With no active route, the TripPlanner was consulted. The LLM chose DiscardHand over creating a new route from the existing hand.

Possible reasons:
- The prompt may not convey the value of the current hand clearly enough
- gpt-5.4-nano may not evaluate card quality as well as larger models
- Nano's network (Holland, Berlin) is far from the best cards (Sarajevo, Roma, Beograd) — the LLM may have judged the hand as unreachable

### Impact
New hand (T9): Cork→Budapest ($60M) is good but distant. Nano picks Flowers→Krakow ($23M) — lower than several discarded cards. Net result: traded $44M+$40M+$31M for $60M+$23M — questionable but not catastrophic.

### Fix
- Review the prompt sent at T8 — does it include hand value signals?
- Add explicit "hand value: top 3 payouts total $X" to the discard decision context
- Compare gpt-5.4-nano vs claude-haiku discard quality across games
- Consider adding a guardrail: warn when discarding a hand with total top-3 payout > $90M

---

## Bug 4: T5 action_failed — pickup succeeded but route abandoned — LOW

### What happens
Haiku T5: picks up Wheat@Lyon, moves to Marseille, but log shows `action_failed` with 2 wasted mileposts. Route idx stays at 0 (should advance).

### Root cause
**TurnExecutorPlanner.ts:213-223** — when any action in the execute loop fails, the entire route is abandoned:
```typescript
if (!actionResult.success) {
  trace.a2.terminationReason = 'action_failed';
  return { plans, updatedRoute: activeRoute, routeAbandoned: true, ... };
}
```

The pickup succeeded (Wheat is in `carriedLoads`), but something downstream failed — likely attempting the next action (deliver Wheat@Marseille or advance the stop) within the same turn's movement budget. The route is abandoned on any failure, even if partial progress was made.

### Impact
Minor — Haiku recovers by T6 (delivers Wheat and picks up Bauxite). The route abandonment triggered a replan that produced the same route. Only 2mp wasted.

### Fix (low priority)
On action_failed, preserve partial progress (pickups/deliveries already done) instead of abandoning the entire route. Only abandon if the failed action was the primary goal.

---

## Bug 5: Game analysis script doesn't read LLM transcript — TOOLING

### What happens
The game analysis script reports 0 LLM calls for both bots. But the LLM transcript log (`llm-3b19796d-*.ndjson`) contains 38 successful calls — Haiku on claude-haiku-4-5-20251001 and Nano on gpt-5.4-nano.

### Root cause
`scripts/game-analysis.ts` only reads the `llmLog` field embedded in game log entries (which is empty/missing). It doesn't read the separate LLM transcript file at `logs/llm-{gameId}.ndjson`.

### Impact
Game analysis reports misleadingly show "0 LLM calls" — makes it look like bots are running without LLM when they're not. Led to incorrect root cause analysis for Bug 3 in initial investigation.

### Fix
Update `game-analysis.ts` Section 10 (LLM Interaction Analysis) to also read `logs/llm-{gameId}.ndjson` and merge call data. The transcript has: turn, model, status, tokenUsage, latencyMs. Missing: playerName and purpose fields (should be added to the transcript logger).

---

## Bug interaction diagram

```
Bug 2 (bad route scoring) ──→ Haiku picks Cardiff→Barcelona→Holland→Valencia
                           └──→ Haiku goes broke building toward Barcelona

Bug 1 (stuck at $0 with active route) ──→ JIRA-165 oscillation fix doesn't fire
                                          (isActivelyTraveling masks stuck state)

Bug 3 (Nano discards good hand) ──→ Loses $44M+ cards, gets worse hand
                                    (gpt-5.4-nano decision quality)
```

---

## Fix priority

| # | Bug | Severity | Effort | Notes |
|---|-----|----------|--------|-------|
| 1 | Progress definition too broad — `isActivelyTraveling` masks stuck bots | CRITICAL | Small | Change 1 line in AIStrategyEngine.ts:819-821 |
| 2 | Route scoring ignores geographic spread | HIGH | Medium | Add distance/feasibility factor to TripPlanner scoring |
| 3 | Nano discards good hand (LLM decision quality) | MEDIUM | Small | Add hand value signals to prompt |
| 4 | T5 action_failed route abandonment | LOW | Small | Preserve partial progress on failure |
| 5 | Game analysis script misses LLM transcript | TOOLING | Small | Read llm-{gameId}.ndjson in addition to game log |

### Recommended approach
Fix Bug 1 first (1-line change to progress definition — makes JIRA-165 oscillation detection actually work). Bug 2 (route scoring) is the deeper issue for both bots. Bug 5 (tooling) prevents accurate game analysis and should be fixed to avoid future misdiagnosis.
