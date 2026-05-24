# JIRA-136: LLM Transcript Reader

## Summary
A CLI script that reads NDJSON game logs and outputs a clean, chronological transcript of just the LLM interactions — stripping away all the game state noise so you can quickly read what the bot "thought" each turn.

## Motivation
The NDJSON game logs have 50+ fields per turn. Reviewing a game's LLM decision-making requires mentally filtering out movement paths, demand rankings, composition traces, etc. This script extracts just the human-readable conversation flow.

## Usage
```bash
npx tsx scripts/llm-transcript.ts <game-id> [options]

# Options:
#   --player <name>    Filter to a single bot
#   --turns <range>    Filter to turn range (e.g., "5-15" or "10")
#   --no-prompts       Hide system/user prompts, show only reasoning
#   --full-prompts     Show full prompts (default: truncated to first 500 chars)
#   --out <file>       Write to file instead of stdout
```

## Output Format
```
══════════════════════════════════════════════
 Game: abc123 | 47 turns | Bot: Hans (claude-sonnet-4-6)
══════════════════════════════════════════════

── Turn 3 | Hans | Early Game | Cash: 42M | Train: Freight ──
   Position: Paris → Lyon | Carrying: [Wine]
   Connected Cities: Paris, Lyon

   [STRATEGY] model: claude-sonnet-4-6 | 1.2s | 1,847 in / 312 out
   Action: pick_up_and_deliver
   Reasoning: Wine delivery to Berlin pays 18M. Picking up Coal
   in Lyon for opportunistic delivery...
   Plan: Deliver Wine to Berlin (T5), then Coal to München (T7)

   [TRIP PLANNER] 0.8s | 920 in / 156 out
   Trigger: new_demand_card
   Chosen: Route 2 — Lyon→Berlin→München (score: 84, 5 turns, 8M build)
   Reasoning: Route 2 avoids Alpine terrain and leverages existing
   track to Berlin...

   [BUILD ADVISOR] 0.3s | 410 in / 89 out
   Action: build_toward
   Waypoints: Lyon → Dijon → Strasbourg
   Reasoning: Extending toward Strasbourg connects to existing
   track near Frankfurt...

   [VALIDATION] ✓ passed (0 recompositions)

── Turn 4 | Hans | Early Game | Cash: 34M | Train: Freight ──
   ...

══════════════════════════════════════════════
 Summary: 47 turns | 32 LLM calls | 58,420 tokens in / 9,841 out
 Avg latency: 1.1s | Retries: 3 | Failures: 1
══════════════════════════════════════════════
```

### What's shown per turn:
1. **Header**: Turn #, player, game phase, cash, train type
2. **Context line**: Start→End position, carried loads, connected cities
3. **Strategy LLM call**: Model, latency, tokens, action, reasoning, plan horizon
4. **Trip Planner** (if triggered): Latency, tokens, trigger reason, chosen route, reasoning
5. **Build Advisor** (if triggered): Action, waypoints, reasoning
6. **Turn Validation**: Pass/fail, recomposition count
7. **Retries/Errors** (if any): From `llmLog` array — attempt #, status, error message
8. **Execution result**: Loads picked up/delivered, segments built, track usage fees

### What's NOT shown:
- System/user prompts (hidden by default, `--full-prompts` to include)
- Demand ranking arrays
- Composition trace internals (moveBudget, a1/a2/a3 phases)
- Movement path coordinates
- Raw response text from llmLog
- Guardrail details (unless override happened)

## Scope

### Files to Create
- `scripts/llm-transcript.ts` — single self-contained script (~150-200 lines)

### Files to Modify
- None. Reads existing NDJSON logs, no changes to logging or game code.

### Existing Patterns to Follow
- `scripts/extract-prompt-samples.ts` — same NDJSON parsing pattern (`loadLog` function), same `npx tsx` runner
- Uses `GameTurnLogEntry` interface shape from `GameLogger.ts` (import or inline)

## Technical Design

### Core Logic
1. Parse args (game-id, filters)
2. Read `logs/game-{gameId}.ndjson`, parse each line as JSON
3. Filter by player/turn range if specified
4. For each turn entry, extract and format:
   - Header from `turn`, `playerName`, `gamePhase`, `cash`, `train`
   - Context from `positionStart`, `positionEnd`, `carriedLoads`, `connectedMajorCities`
   - Strategy from `model`, `llmLatencyMs`, `tokenUsage`, `action`, `reasoning`, `planHorizon`
   - Trip planning from `tripPlanning.*`
   - Build advisor from `advisorAction`, `advisorWaypoints`, `advisorReasoning`, `advisorLatencyMs`
   - Validation from `turnValidation.*`
   - Retries from `llmLog` (only show if retries > 0 or failures)
   - Execution from `loadsPickedUp`, `loadsDelivered`, `segmentsBuilt`, `trackUsageFee`
5. Print game summary footer with aggregate stats

### Edge Cases
- Turns with `model: 'heuristic-fallback'` or `'broke-bot-heuristic'` — show as `[HEURISTIC]` instead of `[STRATEGY]`
- Turns with `model: 'pipeline-error'` or `'llm-failed'` — show error prominently
- Turns with `guardrailOverride: true` — append guardrail reason
- Multiple bots in same game — interleave turns chronologically, color-code by player name if TTY

## Complexity
This is a trivial standalone script — no changes to existing code, reads existing log format, follows existing script conventions. ~2 hours of work.
