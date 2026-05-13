# JIRA-32: NDJSON Game Log for Fast Bot Turn Debugging

## Problem

Debugging bot AI decisions across a full game (50+ turns) is too slow:
- **DB queries** (`bot_turn_audits`): Slow to extract, requires SQL
- **Server stdout** (`DecisionLogger`): Buried in console output, not persisted
- **Socket events** (`bot:turn-complete`): Client-only, ephemeral
- **TurnComposer internals**: Only `console.log`, not structured or persisted

Key debugging areas lack structured capture:
- Turn composition (how MOVE + PICKUP + DELIVER + MOVE + BUILD get assembled)
- Demand ranking with efficiency/cost breakdown
- Strategic decisions (train upgrades, discard hand, route abandonment)
- LLM response attempts including failures and retries

## Solution

Create a single **NDJSON file per game** (`logs/game-{gameId}.ndjson`) with one JSON line per bot turn. This allows:
- Full-file `Read` in one shot (~100-150KB for 50 turns)
- `Grep` for any field across the entire game
- No DB access or log parsing required

## Schema (One Line Per Turn)

```jsonc
{
  "turn": 12,
  "playerId": "bot-1",
  "timestamp": "2026-03-04T12:00:00Z",

  // --- LLM Decision ---
  "action": "MOVE_TRAIN",
  "reasoning": "Delivering wine to Berlin...",
  "planHorizon": "Pick up wine -> deliver Berlin -> build toward Hamburg",
  "model": "claude-sonnet-4-20250514",
  "llmLatencyMs": 1200,
  "tokenUsage": { "input": 3400, "output": 280 },
  "llmLog": [
    {
      "attemptNumber": 1,
      "status": "success",
      "responseText": "{ ... first 500 chars ... }",
      "latencyMs": 1200
    }
  ],

  // --- Turn Composition Trace (NEW) ---
  "composition": {
    "inputPlan": ["MOVE_TRAIN"],
    "outputPlan": ["MOVE_TRAIN", "PICKUP_LOAD", "MOVE_TRAIN", "DELIVER_LOAD", "BUILD_TRACK"],
    "moveBudget": { "total": 12, "used": 11, "wasted": 1 },
    "opportunitiesScanned": 4,
    "opportunitiesAccepted": 2,
    "buildTarget": "Hamburg",
    "buildCost": 8,
    "upgradeConsidered": false
  },

  // --- Demand Ranking (enriched) ---
  "demandRanking": [
    {
      "load": "Wine", "from": "Bordeaux", "to": "Berlin",
      "payout": 18, "score": 42, "rank": 1,
      "efficiencyPerTurn": 4.5, "estimatedTurns": 4,
      "trackCostToSupply": 0, "trackCostToDelivery": 6,
      "supplyRarity": "LIMITED", "isStale": false
    }
  ],

  // --- Strategic Context (NEW) ---
  "handQuality": { "score": 72, "staleCards": 0, "assessment": "good" },
  "gamePhase": "Midgame (3/7 cities connected)",
  "cash": 85,
  "train": "Fast Freight",
  "upgradeAdvice": "Consider Heavy Freight for 3-load capacity",

  // --- Execution Results ---
  "results": [
    { "action": "MOVE_TRAIN", "success": true, "mileposts": 7 },
    { "action": "PICKUP_LOAD", "success": true, "load": "Wine", "city": "Bordeaux" },
    { "action": "DELIVER_LOAD", "success": true, "load": "Wine", "city": "Berlin", "payment": 18 },
    { "action": "BUILD_TRACK", "success": true, "segments": 3, "cost": 8 }
  ]
}
```

## Implementation Tasks

### 1. Create `GameLogger` service
- Append-only NDJSON writer
- `appendTurn(gameId, turnData)` — serialize + append one line
- File path: `logs/game-{gameId}.ndjson`
- Ensure `logs/` directory exists on startup
- **File:** New file `src/server/services/ai/GameLogger.ts`

### 2. Add `CompositionTrace` to TurnComposer
- Return a `CompositionTrace` alongside the `TurnPlan`
- Track: input plan actions, output plan actions, move budget (total/used/wasted)
- Track: opportunities scanned vs accepted, build target + cost, upgrade considered
- **File:** `src/server/services/ai/TurnComposer.ts`

### 3. Enrich demand ranking emission
- Add fields already computed in `DemandContext` but not currently emitted:
  - `efficiencyPerTurn` (M/turn ROI)
  - `estimatedTurns`
  - `trackCostToSupply` / `trackCostToDelivery`
- **File:** `src/server/services/ai/BotTurnTrigger.ts` (where demandRanking is built)
- **Source data:** `src/server/services/ai/ContextBuilder.ts` (demand scoring)

### 4. Add game phase + strategic context
- Emit `gamePhase` string (already in `GameContext`)
- Emit `cash`, `train` type, `upgradeAdvice`
- **File:** `src/server/services/ai/BotTurnTrigger.ts`

### 5. Wire into BotTurnTrigger
- After existing `flushTurnLog()`, call `GameLogger.appendTurn()`
- Assemble the full turn record from:
  - `LLMDecisionResult` (reasoning, planHorizon, model, llmLog, tokenUsage)
  - `CompositionTrace` (from TurnComposer)
  - `demandRanking` (enriched)
  - `GameContext` (gamePhase, cash, train, upgradeAdvice)
  - Execution results (from TurnExecutor)
- **File:** `src/server/services/ai/BotTurnTrigger.ts`

### 6. Add `logs/` to `.gitignore`
- Game log files should not be committed

## Data Already Computed But Not Currently Emitted

These fields exist in `DemandContext` (ContextBuilder.ts) and just need piping:

| Field | Source | Currently Emitted |
|-------|--------|-------------------|
| `demandScore` | DemandContext | Yes (as `score`) |
| `efficiencyPerTurn` | DemandContext | No |
| `estimatedTurns` | DemandContext | No (inferred from isStale) |
| `trackCostToSupply` | DemandContext | No |
| `trackCostToDelivery` | DemandContext | No |
| `networkCitiesUnlocked` | DemandContext | No |
| `victoryMajorCitiesEnRoute` | DemandContext | No |
| `loadChipCarried` / `loadChipTotal` | DemandContext | No |

## Key Files

- `src/server/services/ai/BotTurnTrigger.ts` — Pipeline entry, audit persistence, socket emission
- `src/server/services/ai/AIStrategyEngine.ts` — Decision orchestration
- `src/server/services/ai/LLMStrategyBrain.ts` — LLM calls, llmLog construction
- `src/server/services/ai/TurnComposer.ts` — Plan enrichment (move splitting, opportunities)
- `src/server/services/ai/DecisionLogger.ts` — Current console-based logger
- `src/server/services/ai/ContextBuilder.ts` — Demand scoring, game context assembly

## Expected Outcome

- One `Read` of `logs/game-{gameId}.ndjson` gives full game history
- `Grep` for `"action":"DISCARD_HAND"` finds every discard across the game
- `Grep` for `"wasted"` finds turns with unused movement budget
- `Grep` for `"upgradeConsidered":true` finds upgrade decision points
- Typical file size: ~100-150KB for 50 turns (easily fits in context)
