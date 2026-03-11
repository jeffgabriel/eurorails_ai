# LLM-as-Strategy-Brain: Product Requirements Document

**Replacing the heuristic Scorer with LLM API calls**
February 2026 | v1.2

**Companion documents:**
- [prompt-catalog.md](./prompt-catalog.md) — System prompts, user prompt template, examples, pre-computation table
- [technical-spec.md](./technical-spec.md) — Code specs (LLMStrategyBrain, ResponseParser, GuardrailEnforcer, GameStateSerializer, StrategyAudit)
- [llm-interaction-diagram.md](./llm-interaction-diagram.md) — Sequence diagram and data flow

---

## 1. The Problem This Solves

The current architecture has a 4-stage pipeline: WorldSnapshot → OptionGenerator → **Scorer** → TurnExecutor. The Scorer is a heuristic system with 12 scoring dimensions × 5 archetype multipliers × 3 skill level profiles × 6 game phases. In theory it produces 15 distinct play personalities. In practice, tuning ~1,080 interacting numerical weights to produce coherent, non-stupid play across all game situations is intractable.

**This spec replaces Stage 3 (Scorer) with an LLM API call.** Everything else stays the same. The OptionGenerator still produces feasible options with pre-computed costs and paths. The TurnExecutor still calls the same shared human-player functions. The only change is *how the bot picks which feasible option to execute*.

### What stays the same

- WorldSnapshot (Stage 1) — **minor extension**: add opponent money, position, loads, trainType to snapshot (the SQL query already fetches this data for all players but currently discards it for non-bot rows)
- OptionGenerator with feasibility checking (Stage 2) — unchanged
- PlanValidator — unchanged
- TurnExecutor with rollback and retry (Stage 4) — unchanged
- Bot identity, lobby flow, turn triggering, debug overlay — all unchanged
- Hard guardrails (never go bankrupt, always complete the turn) — still enforced as post-processing
- **Phase 0/1.5 load actions** (deliver, pickup, drop) — stay heuristic using existing Scorer. These are deterministic enough that "always deliver if possible, always pick up matching loads" is correct behavior.

### What changes

- The `Scorer` module is **demoted, not deleted**: it still powers Phase 0/1.5 load action scoring (deliver/pickup/drop). It is replaced by `LLMStrategyBrain` for Phase 1 (movement) and Phase 2 (build/upgrade) decisions.
- Archetype behavior is defined by system prompts, not multiplier tables
- Skill levels are controlled by information filtering and temperature, not random suboptimality
- The Strategy Inspector shows the LLM's natural-language reasoning instead of score breakdowns
- `BotMemory` state (build target, turns on target, delivery count, etc.) is serialized into the prompt for strategic continuity

---

## 2. Architecture

```
AIStrategyEngine.takeTurn()
  │
  ├─ 1. WorldSnapshot.capture()                    ← snapshot₀
  │
  ├─ 2. Auto-place bot / ferry crossing check      ← unchanged
  │
  ├─ 3. PHASE 0: Heuristic load actions             ← Scorer (unchanged)
  │     ├─ OptionGenerator.generate({Deliver,Pickup,Drop})
  │     ├─ Scorer.score() → auto-execute all feasible deliveries, drops, pickups
  │     └─ Re-capture snapshot if state changed      → snapshot₁
  │
  ├─ 4. LLM DECISION POINT (single API call)        ← NEW: replaces Scorer for Phase 1+2
  │     │
  │     ├─ a. OptionGenerator.generate(snapshot₁, {MoveTrain})       → moveOptions
  │     ├─ b. OptionGenerator.generate(snapshot₁, {Build,Upgrade,Pass}) → buildOptions
  │     │
  │     ├─ c. GameStateSerializer.serialize(snapshot₁, moveOptions, buildOptions, botMemory)
  │     │     → produces structured prompt with pre-computed data
  │     │
  │     ├─ d. ProviderAdapter.chat(systemPrompt, userPrompt)
  │     │     → model resolved from BotConfig.provider + BotConfig.model (or skill-level default)
  │     │     → returns: { moveOption, buildOption, reasoning, planHorizon }
  │     │
  │     ├─ e. ResponseParser.parse(llmResponse)
  │     │     → validates both indices are legal
  │     │     → extracts reasoning for Strategy Inspector
  │     │
  │     └─ f. GuardrailEnforcer.check(moveChoice, buildChoice, snapshot₁)
  │           → hard rules override (never go bankrupt, etc.)
  │           → if override triggered: log it, use guardrail choice instead
  │
  ├─ 5. PHASE 1: Execute LLM-chosen movement        ← PlanValidator + TurnExecutor (unchanged)
  │     ├─ PlanValidator.validate(moveOptions[moveIndex])
  │     ├─ TurnExecutor.execute(moveOptions[moveIndex])
  │     └─ On failure: try moveOptions[moveIndex+1..2], up to 3 retries
  │
  ├─ 6. Re-capture snapshot                          → snapshot₂
  │
  ├─ 7. PHASE 1.5: Heuristic load actions            ← Scorer (unchanged)
  │     ├─ Same as Phase 0 but at new position
  │     └─ Re-capture snapshot if state changed       → snapshot₃
  │
  └─ 8. PHASE 2: Execute LLM-chosen build/upgrade    ← PlanValidator + TurnExecutor (unchanged)
        ├─ Re-validate buildOptions[buildIndex] against snapshot₃
        │   (money may have changed from usage fees / Phase 1.5 deliveries)
        ├─ PlanValidator.validate(buildOptions[buildIndex], snapshot₃)
        ├─ TurnExecutor.execute(buildOptions[buildIndex], snapshot₃)
        └─ On failure: try buildOptions[buildIndex+1..2], fallback to PassTurn
```

> **Why one LLM call for two decisions?** Build options are generated from `snapshot₁`
> (pre-movement) but executed against `snapshot₃` (post-movement). The LLM picks a
> movement AND a build *intention*. After movement completes and Phase 1.5 runs, the
> build choice is re-validated against the updated state. If it's no longer valid
> (e.g., usage fees reduced available cash), the engine falls through to the next
> LLM-ranked build option — identical to the current retry pattern. This keeps latency
> to a single API round-trip while covering both strategic decisions.

> **Where does Scorer still run?** Phases 0 and 1.5 call `Scorer.score()` for
> delivery/pickup/drop ranking — 4 of the 5 current call sites. These are
> deterministic enough that heuristic scoring is correct: always deliver if you can,
> pick up loads matching demand cards, drop undeliverable loads.

### Fallback Chain

If the LLM call fails (timeout, API error, unparseable response):

1. **Retry once** with a shorter prompt (drop opponent details, drop reasoning request)
2. If retry fails: **fall back to simple heuristic** — pick the feasible option with the highest immediate income, or the option that delivers a carried load, or PassTurn
3. Log the failure for debugging. The turn always completes.

---

## 3. Prompt Design

See **[prompt-catalog.md](./prompt-catalog.md)** for the full prompt catalog, including:

- 6 archetype system prompts (Backbone Builder, Freight Optimizer, Trunk Sprinter, Continental Connector, Opportunist, Blocker)
- Common system prompt suffix (game rules, critical rules, response format)
- User prompt template and fully rendered example
- Pre-computation table (what the serializer computes vs what the LLM sees)
- Skill-level prompt modifications (Easy/Medium/Hard)

---

## 4. Skill Level Implementation

Skill levels are no longer implemented through random suboptimality. Instead, they're controlled by what information the LLM receives and how strictly it's constrained.

### 4.1 Easy

- **Information**: Show only the top 4 feasible options (pre-ranked by simple income heuristic). No opponent data. No income velocity. No multi-turn plan horizon.
- **System prompt addition**: "You are a casual player. Pick whatever seems good. Don't overthink it."
- **Default model**: Anthropic Haiku / Google Flash (faster, cheaper, slightly less strategic). Configurable via `BotConfig.provider` and `BotConfig.model`.
- **Guardrails**: Same hard rules apply (never pass when delivery possible)

**Effect**: The LLM picks from a curated short list without competitive context, producing "okay but not great" decisions naturally — without artificial randomization.

### 4.2 Medium

- **Information**: Show up to 8 feasible options. Include basic opponent data (positions and cash only, not loads or track details). Include income velocity.
- **System prompt addition**: "You are a competent player. Think 2-3 turns ahead."
- **Default model**: Anthropic Sonnet / Google Pro. Configurable via `BotConfig.provider` and `BotConfig.model`.
- **Guardrails**: Same hard rules apply

### 4.3 Hard

- **Information**: Show ALL feasible options. Full opponent data (positions, cash, loads, track coverage, build direction). Include income velocity, network reuse analysis, and victory gap analysis.
- **System prompt addition**: "You are an expert player. Think 5+ turns ahead. Consider what opponents are doing and whether you can exploit or deny their plans."
- **Default model**: Anthropic Sonnet / Google Pro (same tier as Medium — more information = better decisions). Configurable via `BotConfig.provider` and `BotConfig.model`.
- **Guardrails**: Same hard rules apply, plus the LLM is asked to explain opponent-aware reasoning

### Skill Level Summary

| Aspect | Easy | Medium | Hard |
|---|---|---|---|
| Default model (Anthropic) | Haiku | Sonnet | Sonnet |
| Default model (Google) | Flash | Pro | Pro |
| Max options shown | 4 | 8 | All |
| Opponent info | None | Position + cash | Full (loads, track, direction) |
| Income velocity | No | Yes | Yes |
| Victory gap analysis | No | No | Yes |
| Multi-turn planning | No | 2-3 turns | 5+ turns |
| Estimated latency | 0.5-1s | 1-2s | 2-4s |
| Estimated cost/turn | ~$0.001 | ~$0.005 | ~$0.01 |

---

## 5. Conversation Context and Memory

### 5.1 No Multi-Turn Conversation

Each turn is a **single-shot API call** — no conversation history. The LLM does not remember previous turns. This is intentional:

- Keeps token count low and latency predictable
- Avoids context window accumulation over 50+ turn games
- The system prompt + current game state contains everything needed for a good decision
- The WorldSnapshot already captures the consequences of all previous decisions (cash, track, position)

### 5.2 Turn Summary Line (Optional Enhancement)

For Hard skill, include a single line of context from the previous turn:

```text
LAST TURN: You delivered Wine to Vienna for 48M. You now have 135M and are at Vienna.
```

This is generated from the StrategyAudit of the previous turn, not from LLM memory. It helps the LLM maintain strategic continuity without the cost of full conversation history.

### 5.3 Multi-Turn Planning via Prompt, Not Memory

When the LLM responds with `planHorizon: "Build toward Wien next turn to enable Oil→Paris delivery"`, this is **not stored as a binding plan**. Next turn, the LLM receives fresh game state and may choose differently. The `planHorizon` field exists for:

1. Strategy Inspector display (humans can see what the bot is "thinking")
2. A soft nudge — if included in the next turn's summary line, it reminds the LLM of its stated intention, making play more coherent without being rigid

---

## 6. Technical Implementation

See **[technical-spec.md](./technical-spec.md)** for the full code-level specification, including:

- `LLMStrategyBrain` class with provider adapter pattern
- `LLMStrategyConfig` and `LLMSelectionResult` interfaces
- Provider adapter abstraction (Anthropic + Google)
- `ResponseParser` with JSON + regex fallback
- `GuardrailEnforcer` with move and build rule checking
- `GameStateSerializer` design (track summary, option descriptions, demand formatting, opponent sections)
- `LLMStrategyAudit` object for Strategy Inspector

---

## 7. Cost and Latency Analysis

### 7.1 Per-Turn Costs

The prompt includes: system prompt (~200 tokens), world snapshot with bot state + opponent summary (~300-500 tokens), BotMemory state (~50 tokens), movement options (5-15 options × ~30 tokens = ~150-450 tokens), build options (3-10 options × ~40 tokens = ~120-400 tokens), plus formatting. Total input is 2-3x higher than a single-option-list design.

**Anthropic (default):**

| Skill | Default Model | Avg Input Tokens | Avg Output Tokens | Cost/Turn |
|---|---|---|---|---|
| Easy | Haiku | ~800 | ~100 | ~$0.001 |
| Medium | Sonnet | ~1500 | ~120 | ~$0.006 |
| Hard | Sonnet | ~2500 | ~150 | ~$0.010 |

**Google:**

| Skill | Default Model | Avg Input Tokens | Avg Output Tokens | Cost/Turn |
|---|---|---|---|---|
| Easy | Flash | ~800 | ~100 | ~$0.0001 |
| Medium | Pro | ~1500 | ~120 | ~$0.003 |
| Hard | Pro | ~2500 | ~150 | ~$0.005 |

> **Note:** Hard bots receive more context (opponent analysis, BotMemory history, fuller game state) which increases input token count. Costs vary by provider and model — the `BotConfig.model` override allows experimenting with any model. Google Flash is significantly cheaper for Easy bots.

### 7.2 Per-Game Costs

Assuming a 60-turn game with 3 bots (1 of each skill):

| Bots | Turns | Total API Calls | Estimated Cost |
|---|---|---|---|
| 1 Easy | 60 | 60 | $0.06 |
| 1 Medium | 60 | 60 | $0.36 |
| 1 Hard | 60 | 60 | $0.60 |
| 1 of each | 60 | 180 | $1.02 |
| 5 Hard | 60 | 300 | $3.00 |

**Worst case (5 Hard bots, 100-turn game):** ~$5.00 per game. Still acceptable for a game that takes 30-60 minutes of human time — comparable to running a single complex Claude Code query.

### 7.3 Latency Budget

| Component | Easy | Medium | Hard |
|---|---|---|---|
| WorldSnapshot | 50ms | 50ms | 50ms |
| OptionGenerator | 200ms | 200ms | 200ms |
| Serialization | 20ms | 30ms | 50ms |
| **LLM API call** | **500-1000ms** | **1000-2000ms** | **2000-4000ms** |
| Response parsing | 5ms | 5ms | 5ms |
| Guardrails | 5ms | 5ms | 5ms |
| PlanValidator | 50ms | 50ms | 50ms |
| TurnExecutor | 200ms | 200ms | 200ms |
| **Total** | **~1-1.5s** | **~1.5-2.5s** | **~2.5-4.5s** |

These times fit within the existing 30-second turn timeout with massive margin. The 1500ms `BOT_TURN_DELAY_MS` for pacing means Easy bots will feel snappy, Hard bots will feel like they're "thinking" — which is actually good UX.

---

## 8. Product Phases

### MVP: Single-Brain Bot Plays a Full Game

**Goal:** One LLM-powered bot can join a game, make non-stupid decisions, and play to completion — proving the architecture works end-to-end.

**Scope:**
1. `LLMStrategyBrain` class with Anthropic provider adapter, response parsing, and guardrails
2. `GameStateSerializer` with bot state, demands, and option lists (no opponent analysis)
3. Wire into `AIStrategyEngine.takeTurn()` — replace `Scorer.score()` for Phase 1 + Phase 2 decisions
4. Single archetype: Opportunist system prompt only
5. Single model: Sonnet for all skill levels
6. Heuristic fallback for API failures (existing Scorer)
7. `BotMemory` serialized into prompt for cross-turn continuity

**Acceptance criteria — all must pass before moving to Phase 2:**
- [ ] Bot completes a 50-turn game without crashing or stalling
- [ ] Bot earns >100M ECU across those 50 turns (proves it delivers loads, not just wandering)
- [ ] Bot makes at least 3 successful deliveries
- [ ] Bot builds track toward demand-relevant cities (not random directions)
- [ ] Bot never goes bankrupt (guardrails working)
- [ ] API failure triggers heuristic fallback — game continues without player-visible error
- [ ] Turn latency stays under 10s (p95) including API call
- [ ] No guardrail overrides on >50% of turns (LLM is choosing reasonably)

**What's NOT in MVP:** Multiple archetypes, skill level differentiation, opponent analysis, Google provider, Strategy Inspector integration, lobby provider/model selectors.

---

### Phase 2: Personalities and Providers

**Goal:** Bots feel different from each other. Players can choose provider and model. Easy/Medium/Hard produce visibly different skill levels.

**Scope:**
1. All 5 archetype system prompts (Aggressive, Defensive, Balanced, Opportunistic, BuilderFirst)
2. Skill-level information filtering in `GameStateSerializer`:
   - Easy: top 4 options, no opponent data, no income velocity
   - Medium: up to 8 options, basic opponent data (position + cash)
   - Hard: all options, full opponent data (loads, track, build direction), victory gap analysis
3. Google provider adapter
4. Provider/model selectors in lobby UI (`BotConfigPopover`)
5. Default model tiers: Easy → Haiku/Flash, Medium/Hard → Sonnet/Pro
6. `lastTurnSummary` line for Hard skill
7. Opponent analysis for Hard skill (track direction inference, extending WorldSnapshot)

**Acceptance criteria — all must pass before moving to Phase 3:**
- [ ] 5 games played with different archetypes — each produces visibly different play patterns (e.g., BuilderFirst prioritizes track, Aggressive prioritizes high-payoff deliveries)
- [ ] Easy bot makes noticeably worse decisions than Hard bot in the same game
- [ ] Easy bot responds in <2s (p95), Hard bot in <5s (p95)
- [ ] Google provider plays a full game with no adapter-specific failures
- [ ] Lobby UI correctly passes provider/model to bot and defaults resolve correctly
- [ ] Hard bot demonstrates opponent-aware reasoning in at least 3 turns per game (visible in audit logs)
- [ ] Cost per game stays within 2x of Section 7 estimates

**What's NOT in Phase 2:** Strategy Inspector UI, prompt tuning dashboard, cost monitoring alerts, automated regression testing.

---

### Phase 3: Observability and Tuning

**Goal:** Developers and playtesters can see *why* the bot made each decision, and use that visibility to tune prompts and catch regressions.

**Scope:**
1. Update Strategy Inspector modal to show LLM reasoning instead of score tables
2. Display token usage, latency, and model name per turn in Strategy Inspector
3. Display guardrail overrides with reasons
4. Show BotMemory state (current build target, turns on target, delivery count)
5. Add per-game cost summary to game-end screen or debug overlay
6. Tune system prompts based on observed play across all archetypes × skill levels

**Acceptance criteria:**
- [ ] Strategy Inspector shows natural-language reasoning for each turn decision
- [ ] Strategy Inspector shows which options were presented and which was chosen
- [ ] Guardrail overrides are clearly flagged with explanation
- [ ] Full playtest matrix completed: 5 archetypes × 3 skill levels × 2 providers = 30 configurations, each playing at least 1 full game
- [ ] No archetype pair produces identical play patterns across 3+ games
- [ ] System prompts are finalized and documented

---

### Future: Competitive Play and Optimization

Not scoped for initial release, but worth tracking:

- **Bot-vs-bot automated testing** — headless game loop for regression testing prompt changes
- **Prompt versioning** — track which prompt version produced which results
- **Cost monitoring and alerts** — flag games that exceed cost thresholds
- **Model benchmarking** — compare play quality across models/providers systematically
- **Streaming responses** — reduce perceived latency for Hard bots
- **Fine-tuning** — if a small model consistently fails at specific game situations, fine-tune on successful play traces

---

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM makes bizarre decisions occasionally | Medium | Low | Guardrail enforcer catches the worst cases. Retry with fallback. |
| API latency spikes (>5s) | Low | Medium | 10-15s timeout with heuristic fallback. Turn always completes. |
| API outage | Low | High | Heuristic fallback produces playable (if dumb) behavior. Game doesn't break. |
| Cost scales unexpectedly | Low | Medium | Monitor token usage per game (Phase 3). Switch to Flash/Haiku for all levels if needed (~10x cheaper). |
| Archetypes feel too similar | Medium | Medium | Tune system prompts (Phase 3). Add more explicit behavioral rules. Test with Strategy Inspector. |
| LLM ignores game state details | Medium | Medium | Pre-compute everything. Include explicit "CRITICAL RULES" section. Test and iterate prompts. |
| Opponents reverse-engineer bot strategy from predictable play | Low | Low | Temperature 0.3 adds slight variation. Acceptable for a board game. |
| LLM response format breaks | Medium | Low | Robust parsing with regex fallback for index extraction. |
| Provider-specific quirks (response format, token counting) | Medium | Low | Provider adapter pattern isolates differences. Test both providers in Phase 2. |

---

## 10. What This Doesn't Solve

The LLM replaces the strategy layer, but these problems remain and still need the existing pipeline work:

- **OptionGenerator must produce correct feasible options.** If it generates infeasible options or misses valid ones, the LLM can only choose from what it's given.
- **TurnExecutor must execute correctly.** The LLM picks the strategy; execution still uses shared human-player functions.
- **WorldSnapshot must be accurate.** Garbage state in = garbage decision out.
- **Turn advancement, lobby flow, bot lifecycle** — all unchanged and still needed.
- **The coordinate system, database contracts, and socket events** — the plumbing problems from previous attempts are not strategy problems and still need to be solved.

In short: **this spec replaces the part that's hardest to get right (strategy) with something that works on day one, while preserving the parts you've already invested in (plumbing).** The plumbing still needs to be correct, but at least you're not debugging strategy multipliers AND database contracts simultaneously.
