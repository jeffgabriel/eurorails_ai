# LLM Prompt Architecture

This documents every LLM call the bot makes: what triggers it, what context it receives, what it returns, and how it fits into the turn flow.

## Turn Flow Overview

```
Has active route? ──yes──> TurnExecutorPlanner.execute()
       │                         │
       no                   (may call BuildAdvisor)
       │
       v
Initial Build Phase? ──yes──> InitialBuildPlanner (non-LLM)
       │                         │
       no                   (then BuildAdvisor for execution)
       │
       v
TripPlanner.planTrip()
       │
       v
RouteEnrichmentAdvisor.enrich()
       │
       v
Capacity conflict? ──yes──> evaluateUpgradeBeforeDrop()
       │                         │
       no                   upgrade rejected?
       │                         │
       v                         v
Execute route          evaluateCargoConflict()
       │                         │
       v                         v
TurnExecutorPlanner ──────> BuildAdvisor.advise()
```

---

## 1. Trip Planner

**File:** `src/server/services/ai/TripPlanner.ts`
**Trigger:** Bot has no active route and needs to decide what to do next
**Purpose:** Generate 2-3 candidate multi-stop trips, score them, pick the best

### System Prompt

Built by `getTripPlanningPrompt(skillLevel, context, memory)` in `systemPrompts.ts`. Includes:

- Skill level modifier (easy/medium/hard personality)
- Trip planning rules and scoring formula: `trip_score = (total_payout - build_costs - usage_fees) / estimated_turns`
- Dynamic context sections:
  - **CURRENT STATE:** Position, cash, train specs, carried loads, turn number, delivery count
  - **VICTORY PROGRESS:** Connected major cities, unconnected cities with estimated connection costs
  - **NETWORK TOPOLOGY:** Track summary, cities on network
  - **DEMAND CARDS (all 3):** Load type, supply->delivery, payout, flags (ON-NETWORK, UNAFFORDABLE, UNAVAILABLE, FERRY), build costs, turn estimates, efficiency/turn
  - **AVAILABLE PICKUPS:** At current location
  - **IMMEDIATE DELIVERIES:** Completable this turn
  - **UPGRADE INFO:** Available upgrades + advice

### Response Schema (TRIP_PLAN_SCHEMA)

```json
{
  "candidates": [
    {
      "stops": [
        { "action": "PICKUP|DELIVER", "load": "<type>", "city": "<name>", "demandCardId": 42, "payment": 25 }
      ],
      "reasoning": "..."
    }
  ],
  "chosenIndex": 0,
  "reasoning": "why this candidate wins",
  "upgradeOnRoute": "FastFreight|HeavyFreight|Superfreight"  // optional
}
```

### Post-Processing

- Converts candidates to TripCandidate objects
- Scores: `baseScore = netValue / estimatedTurns`
- Applies geographic distance penalty: `score / (1 + totalHopDistance / 20)`
- Falls back to legacy `LLMStrategyBrain.planRoute()` if all retries exhausted

### Config by Skill Level

| Skill | Max Tokens | Temperature | Thinking |
|-------|-----------|-------------|----------|
| Easy | 8,192 | 0.7 | off |
| Medium | 12,288 | 0.4 | adaptive (low) |
| Hard | 16,384 | 0.2 | adaptive (medium) |

---

## 2. Route Enrichment Advisor

**File:** `src/server/services/ai/RouteEnrichmentAdvisor.ts`
**Trigger:** Immediately after TripPlanner creates a new route
**Purpose:** Check if inserting an opportunistic stop along the corridor would improve the trip

### Prompt Content

- **System:** Task description + schema definition for keep/insert/reorder decisions
- **User prompt sections:**
  1. Current route stops (numbered, with action/load/city/payment)
  2. Demand cards (load type, supply->delivery, payout)
  3. Corridor map (ASCII) with annotations:
     - `T` = route stop, `D` = delivery city, `P` = pickup city
     - `B` = bot track, `O` = opponent track

### Response Schema (ROUTE_ENRICHMENT_SCHEMA)

```json
{
  "decision": "keep|insert|reorder",
  "insertions": [
    { "afterStopIndex": 1, "action": "pickup", "loadType": "Coal", "city": "Essen", "reasoning": "..." }
  ],
  "reorderedStops": [ ... ],
  "reasoning": "..."
}
```

### Config

- Max tokens: 1,024
- Temperature: 0
- Timeout: 30s
- Max 1 retry; any failure returns original route unchanged

---

## 3. Upgrade-Before-Drop Evaluation

**File:** `src/server/services/ai/LLMStrategyBrain.ts` (`evaluateUpgradeBeforeDrop()`)
**Trigger:** Planned route needs more cargo slots than current train capacity
**Purpose:** Decide if upgrading the train is better than dropping a load

### Prompt Content

- **System:** `getUpgradeBeforeDropPrompt()` — criteria for when upgrading makes sense vs. skipping
- **User:** Built by `ContextBuilder.serializeUpgradeBeforeDropPrompt()` — upgrade options, route payout, current loads, cost analysis

### Response Schema (UPGRADE_BEFORE_DROP_SCHEMA)

```json
{ "action": "upgrade|skip", "targetTrain": "FastFreight", "reasoning": "..." }
```

### Config

- Max tokens: 1,024
- Temperature: 0
- Timeout: 8s
- Returns null on failure (falls through to cargo conflict)

---

## 4. Cargo Conflict Evaluation

**File:** `src/server/services/ai/LLMStrategyBrain.ts` (`evaluateCargoConflict()`)
**Trigger:** After upgrade is rejected and bot is still over capacity
**Purpose:** Decide which carried load to drop to make room

### Prompt Content

- **System:** `getCargoConflictPrompt()` — drop decision criteria
- **User:** Built by `ContextBuilder.serializeCargoConflictPrompt()` — conflict scenario with route details, carried loads, and alternative demand analysis

### Response Schema (CARGO_CONFLICT_SCHEMA)

```json
{ "action": "drop|keep", "dropLoad": "Wine", "reasoning": "..." }
```

### Config

- Max tokens: 1,024
- Temperature: 0
- Timeout: 8s
- Returns null on failure (bot keeps all cargo)

---

## 5. Build Advisor

**File:** `src/server/services/ai/BuildAdvisor.ts`
**Trigger:** Phase B (build phase) of turn execution when bot needs to lay track
**Purpose:** Given a corridor map, pick the best waypoints to build toward the next route stop

### Prompt Content

- **System:** `getBuildAdvisorPrompt()` — terrain costs, water crossing rules, opponent track usage (4M/turn), target directive
- **User prompt sections:**
  1. **CORRIDOR MAP** (ASCII rendered grid)
  2. **CONNECTED MAJOR CITIES**
  3. **CITIES ON NETWORK**
  4. **ACTIVE ROUTE** (stops with action/load/city/payment, current stop marked)
  5. **CASH**
  6. **CARRIED LOADS**
  7. **GAME PHASE** and turn number

Note: Demand cards intentionally excluded (JIRA-148) — BuildAdvisor is tactical pathfinding, not strategic planning.

### Response Schema (BUILD_ADVISOR_SCHEMA)

```json
{
  "action": "build|buildAlternative|replan|useOpponentTrack",
  "target": "Berlin",
  "waypoints": [[45, 32], [44, 33], [43, 34]],
  "newRoute": [ ... ],           // optional, for replan
  "alternativeBuild": { ... },   // optional
  "reasoning": "..."
}
```

### Solvency Retry

If initial recommendation costs more than available cash, `retryWithSolvencyFeedback()` appends budget constraint to the prompt and asks for a cheaper path.

### Two-Pass Extraction Fallback

If JSON parsing fails, a second LLM call extracts structured waypoints from the prose response.

### Config

- Max tokens: 2,048
- Temperature: 0
- Timeout: 30s
- Max 1 retry on parse failure

---

## 6. Strategy Action Decision (Legacy)

**File:** `src/server/services/ai/LLMStrategyBrain.ts` (`decideAction()`)
**Status:** Superseded by TripPlanner in the main turn flow. Still exists for fallback compatibility.

### System Prompt

Built by `getSystemPrompt(skillLevel)`. Includes COMMON_SYSTEM_SUFFIX:
- Victory conditions and turn action sequence
- Available actions: DELIVER, MOVE, PICKUP, DROP, BUILD, UPGRADE
- Multi-action turn guidance
- First 10 turns strategic guidance
- Response format spec

### User Prompt (serializePrompt)

The largest and most complex prompt. Sections in order:

1. **STRONG UPGRADE NUDGE** — conditional, when Freight train + turn >=15 + cash >=60M + deliveries >=5
2. **TURN/PHASE HEADER** — `TURN {N} — GAME PHASE: {phase}`
3. **TURN PRESSURE** — conditional, turn >=40, escalates risk tolerance
4. **PREVIOUS TURN** — context continuity
5. **YOUR STATUS** — cash, train, position, connected cities, track network, build budget
6. **VICTORY PROGRESS** — cash/cities toward win, unconnected cities with costs, nearest unconnected
7. **YOUR DEMANDS** — loads with supply->delivery, payout, build cost, ROI, turns, efficiency/turn, flags
8. **IMMEDIATE OPPORTUNITIES** — DELIVER (emphasized), PICKUP (with best delivery), combo hints
9. **EN-ROUTE PICKUPS** — cities near route with detour cost
10. **CITIES REACHABLE THIS TURN** — within speed limit on existing track
11. **CITIES ON YOUR TRACK NETWORK** — reachable in multiple turns
12. **UPGRADE OPTIONS** — conditional, with strong/general advice
13. **BUILD CONSTRAINTS** — budget info
14. **OPPONENTS** — per opponent: cash, train, position, loads, track, build direction

### Config by Skill Level

| Skill | Max Tokens | Temperature | Thinking |
|-------|-----------|-------------|----------|
| Easy | 2,048 | 0.7 | off |
| Medium | 4,096 | 0.4 | adaptive |
| Hard | 8,192 | 0.2 | adaptive |

---

## Non-LLM: Initial Build Planner

**File:** `src/server/services/ai/InitialBuildPlanner.ts`
**Trigger:** First 2 turns (pre-movement build phase)
**Type:** Pure computation, no LLM call
**Purpose:** Score all viable demand pairings and pick the best initial route deterministically
**Output:** `InitialBuildPlan` with route, startingCity, payout, buildCost, evaluated options

---

## Skill Level System

All LLM calls scale behavior by skill level:

| Parameter | Easy | Medium | Hard |
|-----------|------|--------|------|
| Temperature | 0.7 | 0.4 | 0.2 |
| Thinking | off | adaptive (low) | adaptive (medium) |
| Personality | "casual player" | "competent, 2-3 turns ahead" | "expert, 5+ turns ahead" |

Tactical calls (BuildAdvisor, RouteEnrichment, CargoConflict, UpgradeBeforeDrop) always use temperature=0 regardless of skill level.

---

## Source Files

| Component | File |
|-----------|------|
| Strategy Brain | `src/server/services/ai/LLMStrategyBrain.ts` |
| Trip Planner | `src/server/services/ai/TripPlanner.ts` |
| Route Enrichment | `src/server/services/ai/RouteEnrichmentAdvisor.ts` |
| Build Advisor | `src/server/services/ai/BuildAdvisor.ts` |
| Initial Build Planner | `src/server/services/ai/InitialBuildPlanner.ts` |
| Turn Orchestrator | `src/server/services/ai/AIStrategyEngine.ts` |
| System Prompts | `src/server/services/ai/prompts/systemPrompts.ts` |
| User Prompt Builder | `src/server/services/ai/ContextBuilder.ts` |
| Response Schemas | `src/server/services/ai/schemas.ts` |
