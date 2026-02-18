# AI v6: LLM-as-Strategy-Brain — Manual Test Plan

**Goal:** Validate that a single LLM-powered bot (Opportunist archetype, Anthropic Sonnet) can play a complete game — proving the architecture works end-to-end before expanding to multiple archetypes, providers, and skill levels.

**Reference:** `docs/ai-v6/prd-aiLLM.md` — MVP acceptance criteria (Section 8), architecture (Section 2), fallback chain (Section 2).

**Companion docs:** `technical-spec.md` (module interfaces), `prompt-catalog.md` (system prompts), `llm-interaction-diagram.md` (sequence diagram).

**Prereqs:**
- Dev server running (`npm run dev`)
- `ANTHROPIC_API_KEY` environment variable set
- All v5 manual test plan sections passing (bot can build, move, pick up, deliver with heuristic Scorer)
- Bot configured with LLM provider (Anthropic) in lobby

**Notation:** PASS / FAIL / BLOCKED for each test. Record observations in the Notes column.

---

## Section 1: LLM Wiring — Does the Bot Call the LLM?

**Setup:** Create a game with 1 human + 1 bot. Configure bot as Opportunist archetype. Start the game and play through initial build turns.

### Test 1.1: LLM call fires on first active turn

1. Play the initial build turns (heuristic — LLM not involved yet)
2. On the first active-phase turn, check server logs
3. **Verify:** Log shows `LLMStrategyBrain.selectOptions()` being called (or equivalent log)
4. **Verify:** Log shows an API call to Anthropic (model name, latency)
5. **Verify:** Phase 0/1.5 still use heuristic Scorer (no LLM call for load actions)

| Result | Notes |
|--------|-------|
|        |       |

### Test 1.2: LLM returns both movement and build choices

1. Check server logs for the LLM response on any active turn
2. **Verify:** Response contains `moveOption` index (number or -1)
3. **Verify:** Response contains `buildOption` index (number)
4. **Verify:** Response contains `reasoning` (non-empty string)
5. **Verify:** Response contains `planHorizon` (string, may be empty)

| Result | Notes |
|--------|-------|
|        |       |

### Test 1.3: Model and token usage logged

1. Check server logs for LLM metadata on any turn
2. **Verify:** Model name is logged (e.g., `claude-sonnet-4-20250514`)
3. **Verify:** Latency in ms is logged
4. **Verify:** Token usage logged (input tokens, output tokens)

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 2: GameStateSerializer — Is the Prompt Correct?

**Setup:** Same game. Enable verbose/debug logging to see the serialized prompt.

### Test 2.1: Bot state is serialized correctly

1. On any active turn, inspect the user prompt sent to the LLM
2. **Verify:** Cash amount matches bot's actual money
3. **Verify:** Train type matches bot's actual train (Freight, Fast Freight, etc.)
4. **Verify:** Position is shown as a city name (not raw coordinates)
5. **Verify:** Loads carried are listed (or "empty" if none)
6. **Verify:** Connected major city count is accurate

| Result | Notes |
|--------|-------|
|        |       |

### Test 2.2: Demand cards are serialized with pre-computed data

1. Inspect the demand card section of the prompt
2. **Verify:** All 3 demand cards are shown
3. **Verify:** Each demand shows: load type, destination city, payment amount
4. **Verify:** Reachability info is included (e.g., "existing track", "needs XM track", "needs ferry")

| Result | Notes |
|--------|-------|
|        |       |

### Test 2.3: Movement options are described meaningfully

1. Inspect the movement options section of the prompt
2. **Verify:** Options use city names, not raw coordinates
3. **Verify:** Milepost distances are included
4. **Verify:** Track usage fees are noted where applicable
5. **Verify:** Load pickup opportunities at destination are mentioned

| Result | Notes |
|--------|-------|
|        |       |

### Test 2.4: Build options are described meaningfully

1. Inspect the build options section of the prompt
2. **Verify:** Build options show route description with city names
3. **Verify:** Cost in ECU is shown
4. **Verify:** What the build enables is noted (e.g., "enables Coal to Roma for 44M")
5. **Verify:** PassTurn is always listed as the last option
6. **Verify:** UpgradeTrain option shows new speed/capacity and cost

| Result | Notes |
|--------|-------|
|        |       |

### Test 2.5: BotMemory is included in the prompt

1. After a few turns, inspect the memory section of the prompt
2. **Verify:** Current build target is shown (if any)
3. **Verify:** Turns on current target is shown
4. **Verify:** Delivery count and total earnings are accurate
5. **Verify:** Last turn's plan horizon is included (if available)

| Result | Notes |
|--------|-------|
|        |       |

### Test 2.6: No opponent data in MVP

1. Inspect the full prompt
2. **Verify:** No OPPONENTS section is present (MVP scope excludes opponent analysis)

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 3: ResponseParser — Can We Parse LLM Output?

### Test 3.1: Clean JSON response is parsed correctly

1. Over 10 turns, check how many LLM responses parse successfully as JSON
2. **Verify:** Majority (>80%) parse cleanly
3. Record any parse failures and their fallback behavior

| Turn | Clean JSON? | Regex fallback? | Parse error? | Notes |
|------|-------------|-----------------|--------------|-------|
| 1    |             |                 |              |       |
| 2    |             |                 |              |       |
| 3    |             |                 |              |       |
| 4    |             |                 |              |       |
| 5    |             |                 |              |       |
| 6    |             |                 |              |       |
| 7    |             |                 |              |       |
| 8    |             |                 |              |       |
| 9    |             |                 |              |       |
| 10   |             |                 |              |       |

### Test 3.2: Indices are within valid range

1. Over 10 turns, check that parsed moveOption and buildOption indices are valid
2. **Verify:** `moveOption` is -1 (skip) or 0..N-1 where N = number of move options
3. **Verify:** `buildOption` is 0..M-1 where M = number of build options
4. If out-of-range, verify error handling (fallback to index 0 or heuristic)

| Result | Notes |
|--------|-------|
|        |       |

### Test 3.3: Markdown-fenced JSON is handled

1. If the LLM wraps its response in ` ```json ... ``` `, verify the parser strips the fences
2. **Verify:** Response still parses correctly
3. This may not occur with every response — note if it happens

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 4: GuardrailEnforcer — Are Hard Rules Enforced?

### Test 4.1: Delivery reachable but LLM skips movement

1. Set up a scenario: bot has a load, delivery city is reachable this turn
2. If the LLM picks moveOption = -1 (skip movement), check guardrail
3. **Verify:** Guardrail overrides to the delivery move option
4. **Verify:** Log shows "Guardrail: skipped movement but deliverable load reachable"

| Result | Notes |
|--------|-------|
|        |       |

### Test 4.2: Bankruptcy prevention

1. Get the bot to a low-money state (e.g., 8-15M)
2. If the LLM picks an expensive build option that would leave <5M
3. **Verify:** Guardrail overrides to a cheaper build option or PassTurn
4. **Verify:** Bot never ends a turn with <0M (bankrupt)

| Turn | Money Before | LLM Build Choice (cost) | Guardrail Override? | Money After | Notes |
|------|-------------|------------------------|---------------------|-------------|-------|
|      |             |                        |                     |             |       |
|      |             |                        |                     |             |       |

### Test 4.3: DiscardHand override

1. If the LLM ever chooses DiscardHand when buildable track is available
2. **Verify:** Guardrail overrides to BuildTrack
3. **Verify:** Log shows "Guardrail: DiscardHand overridden — buildable track available"

| Result | Notes |
|--------|-------|
|        |       |

### Test 4.4: Guardrail override rate under 50%

1. Over the course of a 50-turn game, count total guardrail overrides vs. total turns
2. **Verify:** Override rate < 50% (MVP acceptance criterion)
3. If >50%, the LLM is choosing poorly — prompts need tuning

| Total Turns | Guardrail Overrides | Override Rate | Notes |
|-------------|---------------------|---------------|-------|
|             |                     |               |       |

---

## Section 5: Fallback Chain — Does the Bot Survive API Failures?

### Test 5.1: Heuristic fallback on API timeout (simulated)

1. **If testable:** Temporarily set API timeout to 1ms (or block the API endpoint)
2. **Verify:** Bot logs "LLM unavailable — using heuristic fallback"
3. **Verify:** Bot still completes its turn (move + build)
4. **Verify:** No crash, no freeze, no error modal
5. **Verify:** Fallback model is logged as "heuristic-fallback"

| Result | Notes |
|--------|-------|
|        |       |

### Test 5.2: Retry with minimal prompt

1. **If testable:** Cause the first API call to fail (e.g., rate limit, bad response)
2. **Verify:** System retries with a shorter prompt (no opponents, shorter descriptions)
3. **Verify:** Log shows retry attempt before falling back to heuristic

| Result | Notes |
|--------|-------|
|        |       |

### Test 5.3: Missing API key at startup

1. Start the server without `ANTHROPIC_API_KEY` set
2. **Verify:** Warning is logged at startup
3. **Verify:** Bot uses heuristic Scorer for ALL decisions (no LLM calls attempted)
4. **Verify:** Game plays normally (falls back to v5 behavior)

| Result | Notes |
|--------|-------|
|        |       |

### Test 5.4: Invalid response triggers heuristic fallback

1. **If testable:** Mock the LLM to return garbage text (not JSON, no extractable indices)
2. **Verify:** ResponseParser throws, system falls back to heuristic
3. **Verify:** Turn completes without crash

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 6: 50-Turn Endurance — MVP Acceptance Criteria

**Setup:** Create a game with 1 human + 1 bot (Opportunist archetype, Anthropic Sonnet). Play through initial build. Then play 50+ active-phase turns.

### Test 6.1: No crashes or freezes

1. Play 50 active turns (human takes turn, bot takes turn = 1 round)
2. **Verify:** Zero game freezes — every bot turn completes and control returns to human
3. **Verify:** No error modals, broken UI, or server 500s
4. **Verify:** No browser console errors related to bot actions
5. **Verify:** Server terminal shows no `[BOT:ERROR]` or unhandled exceptions

| Result | Notes |
|--------|-------|
|        |       |

### Test 6.2: No bankruptcy (guardrails working)

1. Open debug overlay and monitor bot's money every ~5 turns
2. Record money at turns 5, 10, 15, 20, 30, 40, 50
3. **Verify:** Money never drops below 0
4. **Verify:** Guardrail prevents spending last ECU

| Turn | Money | Action | Guardrail Override? | Notes |
|------|-------|--------|---------------------|-------|
| 5    |       |        |                     |       |
| 10   |       |        |                     |       |
| 15   |       |        |                     |       |
| 20   |       |        |                     |       |
| 30   |       |        |                     |       |
| 40   |       |        |                     |       |
| 50   |       |        |                     |       |

### Test 6.3: At least 3 deliveries in 50 turns

1. Count total deliveries from server logs or debug overlay
2. **Verify:** Bot completed >= 3 deliveries
3. Record each delivery: load type, origin city, destination city, payment

| # | Load Type | From | To | Payment | Turn |
|---|-----------|------|----|---------|------|
| 1 |           |      |    |         |      |
| 2 |           |      |    |         |      |
| 3 |           |      |    |         |      |
| 4 |           |      |    |         |      |
| 5 |           |      |    |         |      |

### Test 6.4: At least 100M ECU earned

1. Track bot's cumulative delivery earnings (not current balance — total earned)
2. Server logs show payment amounts for each delivery
3. **Verify:** Total delivery income >= 100M ECU

| Delivery | Payment | Cumulative Total |
|----------|---------|------------------|
| 1        |         |                  |
| 2        |         |                  |
| 3        |         |                  |
| Total    |         |                  |

### Test 6.5: Builds toward demand-relevant cities

1. After 50 turns, visually inspect the bot's track network
2. Cross-reference with the bot's demand cards over time
3. **Verify:** Track connects supply cities to demand cities (not random directions)
4. **Verify:** Track forms a connected, purposeful network
5. **Verify:** No isolated "islands" of track disconnected from the main network
6. Take a screenshot of the track network for reference

| Result | Notes |
|--------|-------|
|        |       |

### Test 6.6: Turn latency under 10s (p95)

1. Record total turn time (including API call) for 20+ turns
2. **Verify:** 95th percentile turn time < 10 seconds
3. Note: LLM API call is the dominant factor. Everything else should total <500ms.

| Turn | Total Turn Time (ms) | LLM API Time (ms) | Notes |
|------|---------------------|--------------------|-------|
| 1    |                     |                    |       |
| 5    |                     |                    |       |
| 10   |                     |                    |       |
| 15   |                     |                    |       |
| 20   |                     |                    |       |
| p95  |                     |                    |       |

---

## Section 7: LLM Decision Quality — Is the Bot Choosing Well?

### Test 7.1: Reasoning is coherent and game-relevant

1. Read the LLM's `reasoning` field for 5 turns
2. **Verify:** Reasoning references game concepts (demands, cities, track, money)
3. **Verify:** Reasoning explains WHY the chosen options were selected
4. **Verify:** Reasoning is not generic filler ("I picked option 1 because it's best")

| Turn | Reasoning Summary | Coherent? | Notes |
|------|-------------------|-----------|-------|
| 1    |                   |           |       |
| 5    |                   |           |       |
| 10   |                   |           |       |
| 15   |                   |           |       |
| 20   |                   |           |       |

### Test 7.2: Movement targets make strategic sense

1. When the bot has a load, check if it moves toward the delivery city
2. When the bot has no load, check if it moves toward a pickup city
3. **Verify:** Movement is purposeful, not random
4. **Verify:** Bot doesn't ping-pong between positions

| Turn | Has Load? | Moved Toward | Correct Direction? | Notes |
|------|-----------|-------------|--------------------|-------|
|      |           |             |                    |       |
|      |           |             |                    |       |
|      |           |             |                    |       |

### Test 7.3: Build decisions are ROI-aware

1. Check build choices: does the bot prefer cheap builds for high-payment deliveries?
2. **Verify:** Bot doesn't build expensive track (20M+) for low-payment deliveries (<10M)
3. **Verify:** Bot prefers extending toward demand cities over random expansion
4. **Verify:** Bot passes when all build options have poor ROI (rather than building aimlessly)

| Turn | Build Choice | Cost | Enables What? | Reasonable? | Notes |
|------|-------------|------|---------------|-------------|-------|
|      |             |      |               |             |       |
|      |             |      |               |             |       |
|      |             |      |               |             |       |

### Test 7.4: Plan horizon shows multi-turn thinking

1. Read the `planHorizon` field for 5 turns
2. **Verify:** Plan horizon references future actions ("next turn I'll...", "build toward X then deliver Y")
3. **Verify:** Plan horizon is consistent across consecutive turns (not contradicting itself every turn)

| Turn | Plan Horizon | Consistent with Last? | Notes |
|------|-------------|----------------------|-------|
| 1    |             |                      |       |
| 2    |             |                      |       |
| 3    |             |                      |       |
| 4    |             |                      |       |
| 5    |             |                      |       |

---

## Section 8: Phase Sequencing — Does LLM Integrate Correctly?

### Test 8.1: Phase 0 executes before LLM call

1. On a turn where the bot can deliver at its starting position
2. **Verify:** Phase 0 delivery executes BEFORE the LLM is called
3. **Verify:** Snapshot is re-captured after Phase 0 (snapshot₁ reflects delivery)
4. **Verify:** LLM sees updated money and empty load slot in its prompt

| Result | Notes |
|--------|-------|
|        |       |

### Test 8.2: Phase 1.5 executes between LLM-chosen move and build

1. On a turn where the bot moves to a city with a pickup opportunity
2. **Verify:** Phase 1 (movement) executes first
3. **Verify:** Phase 1.5 (heuristic load actions at new position) executes next
4. **Verify:** Phase 2 (build) executes last, with re-validated budget
5. Check server logs for phase ordering

| Result | Notes |
|--------|-------|
|        |       |

### Test 8.3: Build option re-validated after Phase 1.5

1. On a turn where Phase 1 movement costs track usage fees (reducing money)
2. **Verify:** Phase 2 re-validates the LLM's build choice against updated snapshot₃
3. If the build is now too expensive, **verify:** system tries the next LLM-ranked option
4. If all fail, **verify:** PassTurn fallback

| Result | Notes |
|--------|-------|
|        |       |

### Test 8.4: Heuristic Scorer still used for Phase 0/1.5

1. Check server logs during Phase 0 and Phase 1.5
2. **Verify:** These phases call Scorer.score() (not LLMStrategyBrain)
3. **Verify:** Deliveries, pickups, and drops in Phase 0/1.5 use heuristic logic
4. **Verify:** LLM is called exactly once per turn (not per phase)

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 9: Initial Build Turns — LLM Not Involved

### Test 9.1: Initial build turns use heuristic (not LLM)

1. Start a fresh game and watch the 2 initial build turns
2. **Verify:** No LLM API calls during initial build turns
3. **Verify:** Bot builds track using existing heuristic Scorer + OptionGenerator
4. **Verify:** Bot places track near a demand-relevant major city

| Result | Notes |
|--------|-------|
|        |       |

### Test 9.2: Transition from initial build to LLM

1. After initial build turns complete, watch the first active turn
2. **Verify:** First active turn switches to LLM for Phase 1+2 decisions
3. **Verify:** No errors during the transition
4. **Verify:** LLM receives correct snapshot of post-initial-build state

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 10: Edge Cases

### Test 10.1: Bot with no valid movement options

1. Scenario: bot is at a dead-end with no reachable positions
2. **Verify:** LLM picks moveOption = -1 (skip movement), or the move options list is empty
3. **Verify:** Turn continues to Phase 1.5 and Phase 2 without crash

| Result | Notes |
|--------|-------|
|        |       |

### Test 10.2: Bot with only PassTurn as build option

1. Scenario: bot has <1M — cannot build or upgrade
2. **Verify:** LLM picks PassTurn (the only feasible option)
3. **Verify:** No crash, no guardrail override needed

| Result | Notes |
|--------|-------|
|        |       |

### Test 10.3: Server restart mid-game

1. Play 10 turns with LLM bot
2. Restart dev server (`Ctrl+C`, `npm run dev`)
3. Resume the game
4. **Verify:** Bot recovers and makes LLM calls on next turn
5. **Verify:** BotMemory state is reset but bot adapts (re-evaluates demands from scratch)

| Result | Notes |
|--------|-------|
|        |       |

### Test 10.4: Multiple LLM bots in same game

1. Create a game with 1 human + 2 LLM bots (both Opportunist)
2. Play 20 turns
3. **Verify:** Both bots make independent LLM calls
4. **Verify:** No shared state corruption between bots
5. **Verify:** Both bots play competently (not identical — different demand cards should produce different play)

| Bot | Deliveries | Money at Turn 20 | Track Segments | Notes |
|-----|------------|-------------------|----------------|-------|
| 1   |            |                   |                |       |
| 2   |            |                   |                |       |

---

## Section 11: Cost and Token Monitoring

### Test 11.1: Token usage per turn is reasonable

1. Record input/output token counts for 10 turns
2. **Verify:** Input tokens are in the 800-2500 range (per PRD Section 7 estimates)
3. **Verify:** Output tokens are in the 80-200 range
4. Flag any turn with >5000 input tokens (prompt may be bloated)

| Turn | Input Tokens | Output Tokens | Notes |
|------|-------------|---------------|-------|
| 1    |             |               |       |
| 2    |             |               |       |
| 3    |             |               |       |
| 4    |             |               |       |
| 5    |             |               |       |
| 6    |             |               |       |
| 7    |             |               |       |
| 8    |             |               |       |
| 9    |             |               |       |
| 10   |             |               |       |

### Test 11.2: Estimated cost per game is acceptable

1. After a 50-turn game, calculate total estimated cost
2. Formula: sum of (input_tokens * input_price + output_tokens * output_price) per turn
3. **Verify:** Total cost is within 2x of PRD estimate (~$0.30 for 50 turns of Sonnet)

| Total Turns | Total Input Tokens | Total Output Tokens | Estimated Cost | Notes |
|-------------|-------------------|---------------------|----------------|-------|
|             |                   |                     |                |       |

---

## Summary Scorecard

Fill this out after completing all sections.

### MVP Acceptance Criteria (PRD Section 8)

| # | Criterion | Target | Actual | PASS/FAIL |
|---|-----------|--------|--------|-----------|
| 1 | Bot completes 50-turn game without crash/stall | 0 crashes | | |
| 2 | Bot earns >100M ECU in 50 turns | >= 100M | | |
| 3 | Bot makes at least 3 deliveries | >= 3 | | |
| 4 | Bot builds toward demand-relevant cities | Visual check | | |
| 5 | Bot never goes bankrupt | Never < 0M | | |
| 6 | API failure triggers heuristic fallback | Game continues | | |
| 7 | Turn latency under 10s (p95) | < 10s | | |
| 8 | Guardrail overrides on <50% of turns | < 50% | | |

### Component Validation

| Component | Validated? | Critical Issues | Notes |
|-----------|-----------|-----------------|-------|
| LLMStrategyBrain (API call + response) | | | |
| GameStateSerializer (prompt quality) | | | |
| ResponseParser (JSON + regex fallback) | | | |
| GuardrailEnforcer (hard rules) | | | |
| ProviderAdapter (Anthropic) | | | |
| HeuristicLoadEngine (Phase 0/1.5) | | | |
| Heuristic fallback (API failure) | | | |
| Phase sequencing (0 → LLM → 1 → 1.5 → 2) | | | |

### Known Limitations (Not Tested in MVP)

| Feature | Deferred To | Notes |
|---------|-------------|-------|
| Multiple archetypes | Phase 2 | Only Opportunist tested |
| Skill level differentiation | Phase 2 | All levels use Sonnet |
| Google provider | Phase 2 | Only Anthropic tested |
| Opponent analysis in prompt | Phase 2 | No OPPONENTS section |
| Strategy Inspector UI | Phase 3 | Reasoning only in server logs |
| Lobby provider/model selectors | Phase 2 | Hardcoded in MVP |

### Overall MVP Verdict

- [ ] **PASS** — LLM bot plays a full game competently. Architecture works end-to-end. Ready for Phase 2.
- [ ] **CONDITIONAL PASS** — Bot plays but with notable issues. List blockers below.
- [ ] **FAIL** — Bot cannot complete a full game with LLM. List critical failures below.

**Blockers / Critical Failures:**

1.
2.
3.
