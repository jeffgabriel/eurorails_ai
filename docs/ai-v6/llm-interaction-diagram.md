# LLM Strategy Brain — Interaction Diagram

## Design Principle

**One LLM call per turn** covering both movement (Phase 1) and build (Phase 2).
Load actions (Phase 0 / 1.5) remain heuristic — they're deterministic enough
that "always deliver, always pick up matching loads" is correct.

---

## Sequence Diagram

```
  AIStrategyEngine          WorldSnapshot       Heuristic       OptionGenerator    GameStateSerializer     LLM API         PlanValidator    TurnExecutor
       │                        │               LoadEngine           │                    │                  │                  │               │
       │                        │                  │                 │                    │                  │                  │               │
  ┌────┤  takeTurn(gameId, botPlayerId)            │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├───capture()───────────>│                  │                 │                    │                  │                  │               │
  │    │<──────snapshot₀────────┤                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │   ┌─ auto-place bot if no position ───┐   │                 │                    │                  │                  │               │
  │    │   │  (finds nearest major city)        │   │                 │                    │                  │                  │               │
  │    │   └────────────────────────────────────┘   │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │   ┌─ ferry crossing check ─────────────┐   │                 │                    │                  │                  │               │
  │    │   │  (cross if demand city closer)      │   │                 │                    │                  │                  │               │
  │    │   └────────────────────────────────────┘   │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  ╔═══════════════════════════════════════════════════════╗   │                  │                  │               │
  │    │  ║  PHASE 0 — Heuristic load actions at current pos     ║   │                  │                  │               │
  │    │  ╚═══════════════════════════════════════════════════════╝   │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──generate(snapshot₀, {Deliver,Pickup,Drop})──────────────>│                    │                  │                  │               │
  │    │<────────────────────────loadOptions────────────────────────┤                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──autoScore(loadOptions)───────────────────>│                 │                    │                  │                  │               │
  │    │  │  1. Execute ALL feasible deliveries    │                 │                    │                  │                  │               │
  │    │  │  2. Execute drops (escape valve)        │                 │                    │                  │                  │               │
  │    │  │  3. Execute best pickup(s)             │                 │                    │                  │                  │               │
  │    │<─────────────actions executed──────────────┤                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  (if state changed: re-capture)           │                 │                    │                  │                  │               │
  │    ├───capture()───────────>│                  │                 │                    │                  │                  │               │
  │    │<──────snapshot₁────────┤                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  ╔═══════════════════════════════════════════════════════════════════════════════════════════╗      │               │
  │    │  ║  LLM DECISION POINT — Single API call for movement + build                              ║      │               │
  │    │  ╚═══════════════════════════════════════════════════════════════════════════════════════════╝      │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──generate(snapshot₁, {MoveTrain})─────────────────────────>│                    │                  │                  │               │
  │    │<────────────────────────moveOptions─────────────────────────┤                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──generate(snapshot₁, {BuildTrack,UpgradeTrain,PassTurn})──>│                    │                  │                  │               │
  │    │<────────────────────────buildOptions────────────────────────┤                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──serialize(snapshot₁, moveOptions, buildOptions, memory)──────────────────────>│                  │                  │               │
  │    │<─────────────────────────────────{ systemPrompt, userPrompt }──────────────────┤                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──────────────────────────────────────selectOption(systemPrompt, userPrompt)───>│                  │               │
  │    │                        │                  │                 │                    │         ┌────────┤                  │               │
  │    │                        │                  │                 │                    │         │ Claude │                  │               │
  │    │                        │                  │                 │                    │         │ Sonnet │                  │               │
  │    │                        │                  │                 │                    │         │ /Haiku │                  │               │
  │    │                        │                  │                 │                    │         └───┬────┤                  │               │
  │    │<──────────────────────────────────────────────────────────────────────────────────────────────┤                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │   { moveIndex: 2, buildIndex: 1, reasoning: "...", planHorizon: "..." }        │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──GuardrailEnforcer.check(moveChoice, buildChoice, snapshot₁)──────────────────────────────────────>│               │
  │    │<─────────────────────────────────(override if needed)──────────────────────────────────────────────┤               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  ╔═══════════════════════════════════════════════════════╗   │                  │                  │               │
  │    │  ║  PHASE 1 — Execute LLM-chosen movement               ║   │                  │                  │               │
  │    │  ╚═══════════════════════════════════════════════════════╝   │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──validate(moveOptions[moveIndex], snapshot₁)──────────────────────────────────────────────────────>│               │
  │    │<─────────────────────────────────{valid: true}─────────────────────────────────────────────────────┤               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──execute(moveOptions[moveIndex], snapshot₁)───────────────────────────────────────────────────────────────────────>│
  │    │<──────────────────────────────────{success, remainingMoney}────────────────────────────────────────────────────────┤
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  (if move failed: try moveOptions[moveIndex+1], up to 3 retries)              │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  ╔═══════════════════════════════════════════════════════╗   │                  │                  │               │
  │    │  ║  PHASE 1.5 — Heuristic load actions at new position  ║   │                  │                  │               │
  │    │  ╚═══════════════════════════════════════════════════════╝   │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├───capture()───────────>│                  │                 │                    │                  │                  │               │
  │    │<──────snapshot₂────────┤                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──autoScore(loadOptions at new pos)────────>│                 │                    │                  │                  │               │
  │    │  │  (same logic as Phase 0)               │                 │                    │                  │                  │               │
  │    │<─────────────actions executed──────────────┤                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  (if state changed: re-capture)           │                 │                    │                  │                  │               │
  │    ├───capture()───────────>│                  │                 │                    │                  │                  │               │
  │    │<──────snapshot₃────────┤                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  ╔═══════════════════════════════════════════════════════╗   │                  │                  │               │
  │    │  ║  PHASE 2 — Execute LLM-chosen build/upgrade          ║   │                  │                  │               │
  │    │  ╚═══════════════════════════════════════════════════════╝   │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │   Re-validate the LLM's Phase 2 choice against snapshot₃  │                    │                  │                  │               │
  │    │   (money may have changed from usage fees / deliveries)   │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──validate(buildOptions[buildIndex], snapshot₃)────────────────────────────────────────────────────>│               │
  │    │<─────────────────────────────────{valid}───────────────────────────────────────────────────────────┤               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │   ┌─ if invalid: try buildOptions[buildIndex+1..2] ────┐   │                    │                  │                  │               │
  │    │   │  (fallback within LLM-ranked order)                │   │                    │                  │                  │               │
  │    │   │  if all fail: heuristic fallback → PassTurn         │   │                    │                  │                  │               │
  │    │   └────────────────────────────────────────────────────┘   │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    ├──execute(buildOptions[buildIndex], snapshot₃)─────────────────────────────────────────────────────────────────────>│
  │    │<──────────────────────────────────{success, segmentsBuilt, cost}───────────────────────────────────────────────────┤
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │  ╔═══════════════════════════════════════════════════════╗   │                  │                  │               │
  │    │  ║  POST-TURN — Update memory, log, return result       ║   │                  │                  │               │
  │    │  ╚═══════════════════════════════════════════════════════╝   │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  │    │   updateMemory(buildTarget, deliveryCount, etc.)           │                    │                  │                  │               │
  │    │   flushTurnLog(reasoning, planHorizon)    │                 │                    │                  │                  │               │
  │    │                        │                  │                 │                    │                  │                  │               │
  └────┤  return BotTurnResult  │                  │                 │                    │                  │                  │               │
       │                        │                  │                 │                    │                  │                  │               │
```

---

## LLM Prompt Structure (Single Call)

The LLM sees both movement and build options in one prompt and returns both choices:

```
TURN 14 — GAME PHASE: Early Game

YOUR STATUS:
- Cash: 87M ECU (after Phase 0: delivered Wine to Paris for 25M)
- Train: Freight (speed 9, capacity 2)
- Position: Paris (arrived via Phase 0 delivery)
- Loads on train: empty (just delivered)
- Connected major cities: 2/8 (Paris, Milano)
- Track network: 18 mileposts covering Lyon–Paris, Lyon–Milano
- Memory: Building toward Wien for 2 turns. 1 delivery completed, 25M earned.

YOUR DEMAND CARDS:
Card 1: Steel → Barcelona (52M, needs 14M track) | Cheese → London (28M, needs ferry) | ...
Card 2: Coal → Roma (44M, 8 mileposts on existing track) | ...
Card 3: (newly drawn after delivery) Oranges → Hamburg (38M, needs 22M track) | ...

OPPONENTS: (Medium/Hard only)
- Alice: 95M, Fast Freight, at Berlin, carrying Coal. Track: Hamburg–Berlin–Wien.

──────────────────────────────────────────────
MOVEMENT OPTIONS (pick one, or "none" to stay):
[M0] Move to Lyon (3 mileposts). Pickup: Wine available. No fee.
[M1] Move to Milano (8 mileposts). Near Coal source for Roma delivery. No fee.
[M2] Move toward Roma via Milano (9 mileposts, stops at track end). No fee.
[M3] Move toward Barcelona (9 mileposts, stops at track end). Uses Alice's track (4M fee).

BUILD OPTIONS (pick one):
[B0] BUILD: Paris→Dijon→Lyon extension toward Zurich (6 segments, 9M). Opens route to Wien.
[B1] BUILD: Milano→Genova→toward Roma (5 segments, 11M). Enables Coal→Roma (44M).
[B2] BUILD: Paris→Rouen→toward Le Havre (4 segments, 6M). Toward London ferry.
[B3] UPGRADE: Fast Freight (speed 12, capacity 2) for 20M. No build this turn.
[B4] PASS: Do nothing.
──────────────────────────────────────────────
```

### LLM Response Format

```json
{
  "moveOption": 1,
  "buildOption": 1,
  "reasoning": "Moving to Milano positions me near Coal for the 44M Roma delivery. Building toward Roma from Milano makes that delivery completable in 2 more turns. 44M for 11M track cost is excellent ROI.",
  "planHorizon": "Next turn: pick up Coal at source city near Milano, continue building toward Roma."
}
```

---

## Why This Works

### The Stale-Build-Options Problem

Build options are generated from `snapshot₁` (pre-movement) but executed against `snapshot₃` (post-movement, post-Phase-1.5). This means the LLM's build choice might be invalid by execution time. The design handles this with **re-validation + ordered fallback**:

```
LLM ranked build options: [B1, B0, B2, B4]

Phase 2 execution:
  1. validate(B1, snapshot₃) → valid? → execute → done ✓
  2. validate(B1, snapshot₃) → invalid (spent 4M on usage fees, can't afford 11M)
     → try B0 (9M) → validate → valid → execute → done ✓
  3. All fail → PassTurn fallback (turn always completes)
```

This is **identical to the current retry pattern** in AIStrategyEngine — the only difference is the LLM provides the ranking instead of the Scorer.

### What Changes vs. Current Pipeline

```
                    CURRENT                           PROPOSED
                    ───────                           ────────
Phase 0:     OptionGen → Scorer → execute       OptionGen → HeuristicLoad → execute
             (per delivery/drop/pickup)          (same logic, just renamed)

Phase 1:     OptionGen → Scorer → try top 3     OptionGen ──┐
                                                             ├→ Serializer → LLM → try top 3
Phase 2:     OptionGen → Scorer → try top 3     OptionGen ──┘

Phase 1.5:   OptionGen → Scorer → execute       OptionGen → HeuristicLoad → execute
             (per delivery/drop/pickup)          (same logic, just renamed)
```

### Component Responsibilities

```
┌─────────────────────┬──────────────────────────────────────────────────┐
│ Component           │ Change                                          │
├─────────────────────┼──────────────────────────────────────────────────┤
│ WorldSnapshotService│ EXTEND: add opponent money, position, loads,    │
│                     │ trainType to snapshot (data already fetched)     │
├─────────────────────┼──────────────────────────────────────────────────┤
│ OptionGenerator     │ UNCHANGED: still produces FeasibleOption[]      │
├─────────────────────┼──────────────────────────────────────────────────┤
│ Scorer              │ DEMOTED: only used by HeuristicLoadEngine       │
│                     │ for Phase 0/1.5 load actions. Not deleted.      │
├─────────────────────┼──────────────────────────────────────────────────┤
│ HeuristicLoadEngine │ NEW (extract): Phase 0/1.5 logic pulled out of  │
│                     │ AIStrategyEngine.executeLoadActions(). Uses      │
│                     │ Scorer internally for delivery/pickup/drop.     │
├─────────────────────┼──────────────────────────────────────────────────┤
│ GameStateSerializer │ NEW: converts snapshot + options + memory into   │
│                     │ human-readable prompt. City names, route descs,  │
│                     │ income velocity, opponent summary.              │
├─────────────────────┼──────────────────────────────────────────────────┤
│ LLMStrategyBrain    │ NEW: API call + response parsing + guardrails.  │
│                     │ Returns { moveIndex, buildIndex, reasoning }.   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ GuardrailEnforcer   │ NEW: hard rules override (never pass when       │
│                     │ delivery reachable, never go bankrupt).         │
├─────────────────────┼──────────────────────────────────────────────────┤
│ PlanValidator       │ UNCHANGED                                       │
├─────────────────────┼──────────────────────────────────────────────────┤
│ TurnExecutor        │ UNCHANGED                                       │
├─────────────────────┼──────────────────────────────────────────────────┤
│ BotMemory           │ EXTENDED: add lastReasoning, lastPlanHorizon    │
│                     │ fields. Serialize into prompt for continuity.   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ DecisionLogger      │ EXTENDED: log LLM reasoning, token usage,       │
│                     │ latency, guardrail overrides.                   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ AIStrategyEngine    │ REFACTORED: orchestration stays, but Phase 1+2  │
│                     │ scoring replaced with LLMStrategyBrain call.    │
│                     │ Phase 0/1.5 delegated to HeuristicLoadEngine.  │
└─────────────────────┴──────────────────────────────────────────────────┘
```

---

## Data Flow: What the LLM Needs vs. What Exists

```
Data needed in prompt              Source today              Gap
─────────────────────              ────────────              ───
Bot cash, position, train          WorldSnapshot.bot         ✓ exists
Bot loads carried                  WorldSnapshot.bot.loads   ✓ exists
Bot demand cards (resolved)        WorldSnapshot.bot.resolvedDemands  ✓ exists
Bot track network summary          WorldSnapshot.bot.existingSegments → NEW: summarize as city corridors
Connected major city count         WorldSnapshot.bot.connectedMajorCityCount  ✓ exists
Connected major city names         connectedMajorCities.ts   ✗ returns count only, not names
Movement options (city names)      OptionGenerator → FeasibleOption.targetCity  ✓ exists
Movement options (mileposts)       FeasibleOption.mileposts   ✓ exists
Movement options (usage fees)      FeasibleOption.estimatedCost  ✓ exists
Build options (segments, cost)     FeasibleOption.segments, .estimatedCost  ✓ exists
Build options (target city)        FeasibleOption.targetCity   ✓ exists
Build options (chain score)        FeasibleOption.chainScore   ✓ exists
Build options (route description)  FeasibleOption.segments → NEW: convert coords to city names
Build options (what it enables)    ─                         ✗ must compute: "enables Coal→Roma (44M)"
Upgrade options                    FeasibleOption.targetTrainType  ✓ exists
Income velocity per option         ─                         ✗ must compute: (payment - cost) / turns
Opponent positions                 DB query fetches it        ✗ not in WorldSnapshot, easy to add
Opponent money                     DB query fetches it        ✗ not in WorldSnapshot, easy to add
Opponent loads                     DB query fetches it        ✗ not in WorldSnapshot, easy to add
Opponent train type                DB query fetches it        ✗ not in WorldSnapshot, easy to add
Opponent track summary             allPlayerTracks has segments  ✗ needs city-corridor summarization
Opponent build direction           ─                         ✗ must infer from recent segments
Bot memory (build target, turns)   BotMemory                 ✓ exists, needs serialization
Last turn summary                  BotTurnResult + BotMemory  ✗ must format from previous result
```

---

## Failure Modes and Fallbacks

```
Failure                          Handling
───────                          ────────
LLM timeout (>10s)         →     Retry once with minimal prompt (no opponents, shorter descriptions)
Retry timeout              →     Heuristic fallback: highest-income move + highest-chainScore build
Unparseable JSON           →     Regex extract moveOption/buildOption integers, use those
Invalid moveOption index   →     Use moveOptions[0] (highest income heuristic)
Invalid buildOption index  →     Use buildOptions[0] (highest chainScore heuristic)
Move validation fails      →     Try moveOptions[moveIndex+1], up to 3 attempts
Build validation fails     →     Try buildOptions[buildIndex+1], up to 3 attempts
All moves fail             →     Skip movement (bot stays put), proceed to Phase 1.5 + Phase 2
All builds fail            →     PassTurn (turn always completes)
API key missing            →     Log warning at startup, use heuristic Scorer for all decisions
```
