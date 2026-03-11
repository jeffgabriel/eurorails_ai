# PRD Phase 1 — Manual Test Plan

**Goal:** Validate that a single Backbone Builder bot can play a complete game without crashing, going bankrupt, looping, or making incoherent decisions.

**Reference:** `docs/ai/prd-rewrite-plan.md` — Phase 1 acceptance criteria and known issues.

**Prereqs:** Dev server running (`npm run dev`). All Section 1–6 tests from `docs/ai/manual-test-plan.md` passing (bot can build, move, pick up, deliver).

**Notation:** PASS / FAIL / BLOCKED for each test. Record observations in the Notes column.

---

## Section 1: 50-Turn Endurance — Can the Bot Survive?

**Setup:** Create a game with 1 human + 1 bot (Balanced archetype = Backbone Builder). Play through initial build. Then play 50+ active-phase turns.

### Test 1.1: No crashes or freezes
1. Play 50 active turns (human takes turn, bot takes turn = 1 round)
2. **Verify:** Zero game freezes — every bot turn completes and control returns to human
3. **Verify:** No error modals, broken UI, or server 500s
4. **Verify:** No browser console errors related to bot actions
5. **Verify:** Server terminal shows no `[BOT:ERROR]` or unhandled exceptions

| Result | Notes |
|--------|-------|
|        |       |

### Test 1.2: No bankruptcy
1. Open debug overlay and monitor bot's money every ~5 turns
2. Record money at turns 5, 10, 15, 20, 30, 40, 50
3. **Verify:** Money never drops below 0
4. **Verify:** Bot doesn't spend its last ECU on track when it needs to pay usage fees

| Turn | Money | Action | Notes |
|------|-------|--------|-------|
| 5    |       |        |       |
| 10   |       |        |       |
| 15   |       |        |       |
| 20   |       |        |       |
| 30   |       |        |       |
| 40   |       |        |       |
| 50   |       |        |       |

### Test 1.3: No action loops (same action 5+ turns)
1. In the debug overlay or server logs, track the bot's Phase 2 action each turn
2. Record action type for 10 consecutive turns
3. **Verify:** Bot does NOT repeat the exact same action 5+ turns in a row
4. Acceptable: building toward the same target city for several turns is fine — building the exact same segments or passing 5x in a row is not

| Turn | Phase 2 Action | Target City | Notes |
|------|----------------|-------------|-------|
| 1    |                |             |       |
| 2    |                |             |       |
| 3    |                |             |       |
| 4    |                |             |       |
| 5    |                |             |       |
| 6    |                |             |       |
| 7    |                |             |       |
| 8    |                |             |       |
| 9    |                |             |       |
| 10   |                |             |       |

### Test 1.4: No indefinitely held loads (>10 turns without delivering)
1. When the bot picks up a load, note the turn number
2. Track how many turns the bot holds each load before delivering or dropping
3. **Verify:** No load is held for more than 10 turns
4. If a load IS held >10 turns, note: was the bot building toward the delivery city? Or stuck?

| Load Type | Picked Up (turn) | Delivered/Dropped (turn) | Held For | Notes |
|-----------|------------------|--------------------------|----------|-------|
|           |                  |                          |          |       |
|           |                  |                          |          |       |
|           |                  |                          |          |       |

### Test 1.5: No aimless track building
1. After 50 turns, zoom out and visually inspect the bot's track network
2. **Verify:** Track forms a connected, purposeful network (not scattered fragments)
3. **Verify:** Track connects to at least 2 major cities
4. **Verify:** No isolated "islands" of track disconnected from the main network
5. Take a screenshot of the track network for reference

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 2: Positive Achievement — Can the Bot Play Well?

**Setup:** Same 50-turn game from Section 1 (or a fresh game if needed).

### Test 2.1: At least 3 deliveries in 50 turns
1. Count total deliveries from server logs or debug overlay
2. **Verify:** Bot completed >= 3 deliveries
3. Record each delivery: load type, origin city, destination city, payment

| # | Load Type | From | To | Payment | Turn |
|---|-----------|------|----|---------|------|
| 1 |           |      |    |         |      |
| 2 |           |      |    |         |      |
| 3 |           |      |    |         |      |
| 4 |           |      |    |         |      |

### Test 2.2: At least 1 train upgrade
1. Track bot's train type over the game
2. **Verify:** Bot upgraded from Freight at least once (to Fast Freight or Heavy Freight)
3. Note when the upgrade happened — was it at a reasonable time? (not turn 3 or turn 49)

| Turn | Train Type Before | Train Type After | Money Before | Money After |
|------|-------------------|------------------|--------------|-------------|
|      |                   |                  |              |             |

### Test 2.3: At least 100M ECU earned
1. Track bot's cumulative earnings from deliveries (not current balance — total earned)
2. Server logs show payment amounts for each delivery
3. **Verify:** Total delivery income >= 100M ECU

| Delivery | Payment | Cumulative Total |
|----------|---------|------------------|
| 1        |         |                  |
| 2        |         |                  |
| 3        |         |                  |
| Total    |         |                  |

### Test 2.4: Coherent track network
1. After 50 turns, evaluate the track network visually
2. **Verify:** Track connects supply cities to demand cities on the bot's demand cards
3. **Verify:** Track grows outward from a central hub (Backbone Builder pattern)
4. **Verify:** Bot doesn't build toward cities that serve no demand

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 3: Multi-Delivery Sequencing (Known Issue #1)

The bot historically fails after the first delivery — it either can't find a second delivery target or the 4-phase turn coordination breaks down.

### Test 3.1: Second delivery after first
1. Watch closely when the bot completes its first delivery
2. On subsequent turns, verify the bot:
   - Draws a new demand card (replacing the fulfilled one)
   - Picks a new build/move target based on updated demands
   - Eventually picks up and delivers a second load
3. **Verify:** Bot doesn't stall after first delivery (no 10+ consecutive PassTurns)

| Result | Notes |
|--------|-------|
|        |       |

### Test 3.2: Phase sequencing after delivery
1. After a Phase 0 or Phase 1.5 delivery, verify Phase 2 still executes
2. Check server logs: after `"Phase 1.5: delivered..."` you should see Phase 2 build
3. **Verify:** Snapshot is re-captured between phases (money/loads update correctly)
4. **Verify:** Phase 2 build targets account for the newly drawn demand card

| Result | Notes |
|--------|-------|
|        |       |

### Test 3.3: Third and fourth deliveries
1. Continue playing until the bot attempts a 3rd and 4th delivery
2. **Verify:** Each delivery cycle works: build → move → pickup → deliver → repeat
3. **Verify:** No degradation in behavior over multiple delivery cycles

| Delivery | Turn Started | Turn Completed | Issues? |
|----------|-------------|----------------|---------|
| 1        |             |                |         |
| 2        |             |                |         |
| 3        |             |                |         |
| 4        |             |                |         |

---

## Section 4: Scoring Constants Validation (Known Issue #2)

Scoring constants are unvalidated guesses. These tests check that the constants produce sensible behavior, not that the numbers are "correct."

### Test 4.1: BuildTrack vs PassTurn — bot almost always builds
1. Over 20 turns where the bot has money (>5M), count:
   - Turns where bot built track
   - Turns where bot passed
2. **Verify:** Bot builds track on >= 80% of affordable turns (PassTurn should be rare)

| Turns with money >5M | Built track | Passed | Build % |
|-----------------------|-------------|--------|---------|
|                       |             |        |         |

### Test 4.2: DeliverLoad always beats BuildTrack
1. Watch for a turn where the bot is at a delivery city with a matching load
2. **Verify:** Bot delivers the load (score ~130+) rather than building (score ~25)
3. This should be automatic — delivery score (100 + payment*2) >> build score

| Result | Notes |
|--------|-------|
|        |       |

### Test 4.3: MoveTrain prioritizes deliverable destinations
1. When the bot has a load AND the delivery city is on its network, check movement
2. **Verify:** Bot moves toward the delivery city (not some other city)
3. Check server logs for move target — should match the load's demand destination

| Load | Delivery City | Bot Moved Toward | Correct? |
|------|---------------|------------------|----------|
|      |               |                  |          |

### Test 4.4: Chain scoring — short cheap chains beat long expensive ones
1. Watch the bot's early build decisions (turns 1-10)
2. **Verify:** Bot doesn't chase a 50M delivery across the map (e.g., Fish Aberdeen→Krakow)
3. **Verify:** Bot prefers nearby, cheaper chains (e.g., 20M delivery 5 segments away > 50M delivery 30 segments away)
4. Check server logs for `chainScore` values — higher chainScore = better payment/distance ratio

| Result | Notes |
|--------|-------|
|        |       |

### Test 4.5: UpgradeTrain timing
1. Check whether the bot upgrades too early (before any deliveries, <20 segments) or too late (never)
2. **Verify:** Bot does NOT upgrade on turn 3 with only 5 segments built
3. **Verify:** Bot DOES upgrade eventually when it has track network + deliveries
4. Reference: score = 2 (early/few segments) vs 8+ with bonuses (late/many segments)

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 5: Drop Load Logic (Known Issue #3)

The bot should drop loads intelligently — not hold undeliverable loads forever, but not drop valuable loads prematurely.

### Test 5.1: Bot drops undeliverable load
1. Scenario: bot picks up a load whose delivery city is far from its network
2. After several turns of the bot not building toward that city, check if it drops the load
3. **Verify:** Bot eventually drops loads it can't deliver (within ~8-10 turns)

| Result | Notes |
|--------|-------|
|        |       |

### Test 5.2: Bot keeps high-value reachable load
1. Scenario: bot has a 30M+ load and the delivery city is on its network
2. **Verify:** Bot does NOT drop this load (proximity penalty in drop scoring should prevent it)
3. Instead, bot should move toward the delivery city

| Result | Notes |
|--------|-------|
|        |       |

### Test 5.3: Bot drops to make room for better pickup
1. Scenario: bot's train is full (2 loads on Freight) and it arrives at a city with a useful load
2. **Verify:** If the bot carries a low-value undeliverable load, it drops that and picks up the better one
3. Check the Phase 0/1.5 sequence: drop first, then pickup

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 6: State Continuity / Bot Memory (Known Issue #4)

BotMemory was added to prevent the bot from re-evaluating everything from scratch each turn. These tests verify it works.

### Test 6.1: Build target persistence
1. Watch server logs for `buildTargetCity` across consecutive turns
2. **Verify:** Bot builds toward the same target city for multiple consecutive turns (not switching every turn)
3. Check BotMemory: `currentBuildTarget` should remain stable for 2-5+ turns

| Turn | Build Target | Same as last turn? |
|------|--------------|--------------------|
| 1    |              |                    |
| 2    |              |                    |
| 3    |              |                    |
| 4    |              |                    |
| 5    |              |                    |

### Test 6.2: Memory survives across turns
1. Check server logs for BotMemory state (deliveryCount, totalEarnings, turnNumber)
2. **Verify:** `deliveryCount` increments after each delivery and persists
3. **Verify:** `totalEarnings` accumulates correctly
4. **Verify:** `turnNumber` increments each turn

| Turn | deliveryCount | totalEarnings | turnNumber |
|------|---------------|---------------|------------|
|      |               |               |            |
|      |               |               |            |

### Test 6.3: Consecutive PassTurn detection
1. If the bot passes multiple turns in a row, check `consecutivePassTurns` counter
2. **Verify:** Counter increments on each PassTurn
3. **Verify:** Counter resets to 0 when the bot takes a real action
4. (Future: high consecutivePassTurns should trigger recovery behavior)

| Result | Notes |
|--------|-------|
|        |       |

### Test 6.4: Loyalty bonus prevents target oscillation
1. When the bot has been building toward City X for 3+ turns, check if it switches to City Y
2. **Verify:** Loyalty bonus (1.5x chainScore for current target) keeps the bot focused
3. If the bot DOES switch, check: did a much better chain appear (new demand card)?

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 7: Build Direction Oscillation (Known Issue #5)

Chain ranking may produce different top chains each turn as distances change, causing the bot to switch targets.

### Test 7.1: Stable build direction over 10 turns
1. Record the bot's top build target for 10 consecutive turns
2. **Verify:** Bot doesn't switch targets more than 2 times in 10 turns
3. Acceptable: switching after reaching a target or after a delivery (new demand card)
4. Not acceptable: alternating between City A and City B every other turn

| Turn | Top Build Target | Changed? | Reason if changed |
|------|------------------|----------|--------------------|
| 1    |                  |          |                    |
| 2    |                  |          |                    |
| 3    |                  |          |                    |
| 4    |                  |          |                    |
| 5    |                  |          |                    |
| 6    |                  |          |                    |
| 7    |                  |          |                    |
| 8    |                  |          |                    |
| 9    |                  |          |                    |
| 10   |                  |          |                    |

### Test 7.2: No ping-pong movement
1. Track the bot's position (row, col) every turn for 10 turns
2. **Verify:** Bot doesn't move back and forth between the same two positions
3. Movement should show progress toward a destination

| Turn | Position (row, col) | Moving toward |
|------|---------------------|---------------|
| 1    |                     |               |
| 2    |                     |               |
| 3    |                     |               |
| 4    |                     |               |
| 5    |                     |               |

---

## Section 8: Decision Logging Verification

DecisionLogger was added to enable post-game analysis. Verify it captures useful data.

### Test 8.1: Turn log captures all phases
1. Check server console output during a bot turn
2. **Verify:** Log shows Phase 0, Phase 1, Phase 1.5, and Phase 2 entries
3. **Verify:** Each phase shows options considered, option chosen, and result

| Result | Notes |
|--------|-------|
|        |       |

### Test 8.2: Turn summary is readable
1. Look at the one-line turn summary in server logs (e.g., `Turn complete: Move→12,5(6mi), Deliver→Wine@Paris/$25M, Build→3seg/$8M→Berlin`)
2. **Verify:** Summary captures all actions taken in the turn
3. **Verify:** Money before → money after is logged

| Result | Notes |
|--------|-------|
|        |       |

### Test 8.3: Failed options are logged
1. When a bot's first attempt fails validation or execution, check logs
2. **Verify:** Failed attempts are logged with reason (e.g., "Move attempt 0 threw: ...")
3. **Verify:** Retry attempts are visible (attempt 0, attempt 1, etc.)

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 9: Ferry and Water Crossing Behavior

### Test 9.1: Bot builds across water correctly
1. Over a long game, check if the bot builds across any rivers
2. **Verify:** Water crossing cost is applied correctly (river = +2M, lake/inlet = +3M)
3. **Verify:** Bot pays the correct combined cost (terrain + water)

| Result | Notes |
|--------|-------|
|        |       |

### Test 9.2: Ferry port behavior
1. If the bot reaches a ferry port, verify:
   - Bot stops at the port (ends movement for that turn)
   - Next turn: bot crosses at half speed (Freight: 5 mileposts)
   - Bot only crosses if a demand city is closer from the other side
2. Check server logs for "Crossing ferry" or "At ferry port... staying"

| Result | Notes |
|--------|-------|
|        |       |

### Test 9.3: Bot pays ferry build cost
1. If the bot builds track to a ferry port, check money deduction
2. **Verify:** Correct ferry cost charged (4-16M depending on the ferry line)
3. **Verify:** Bot doesn't build to a ferry port when it can't afford the cost

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 10: Track Usage Fees

### Test 10.1: Bot pays opponent track fees
1. Build human track near the bot's route
2. Watch for the bot to use your track
3. **Verify:** Bot pays 4M per turn when using human track
4. **Verify:** Money deduction appears in server logs

| Result | Notes |
|--------|-------|
|        |       |

### Test 10.2: Bot prefers own track over opponent track
1. When the bot has a choice between its own track and a shorter path on your track
2. **Verify:** Bot prefers its own track (no fee) over opponent track (4M fee)
3. Movement scoring should penalize track usage fees

| Result | Notes |
|--------|-------|
|        |       |

### Test 10.3: Bot doesn't move if it can't afford usage fee
1. Get the bot to a low-money state (<4M) where its only movement options cross opponent track
2. **Verify:** Bot does NOT move onto opponent track it can't pay for
3. Instead, bot should build track or pass

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 11: Edge Cases and Recovery

### Test 11.1: Bot with no affordable build options
1. Scenario: bot has <2M money and no clear terrain adjacent to its track
2. **Verify:** Bot doesn't attempt to build (fails validation) and falls back to PassTurn
3. **Verify:** No crash or freeze — graceful fallback

| Result | Notes |
|--------|-------|
|        |       |

### Test 11.2: Bot with empty demand hand (all cards fulfilled simultaneously)
1. This is rare but possible if the bot delivers and draws new cards in the same phase
2. **Verify:** Bot always has exactly 3 demand cards at end of turn
3. **Verify:** New demand cards are drawn immediately after delivery

| Result | Notes |
|--------|-------|
|        |       |

### Test 11.3: Bot at position with no reachable cities
1. Scenario: bot's track network is a dead end with no reachable demand cities
2. **Verify:** Bot continues building track to extend its network
3. **Verify:** Bot doesn't get stuck oscillating or passing every turn

| Result | Notes |
|--------|-------|
|        |       |

### Test 11.4: Server restart during game
1. Start a game, play 10 turns with a bot
2. Restart the dev server (`Ctrl+C`, `npm run dev`)
3. Resume the game
4. **Verify:** Bot memory is lost (expected — in-memory Map) but bot recovers
5. **Verify:** Bot continues playing with default memory state
6. **Verify:** No crash on first bot turn after restart

| Result | Notes |
|--------|-------|
|        |       |

### Test 11.5: Multiple bots competing for same loads
1. Create a game with 1 human + 3 bots
2. Play 20 turns
3. **Verify:** When two bots try to pick up the same load, only one succeeds
4. **Verify:** The other bot doesn't crash — it adapts (picks different load or passes)
5. **Verify:** Load availability is correctly reflected in each bot's snapshot

| Result | Notes |
|--------|-------|
|        |       |

---

## Section 12: Multi-Bot Game (Extended Play)

### Test 12.1: 1 human + 3 bots for 30+ turns
1. Create a game with 1 human + 3 bots (all Balanced archetype)
2. Play 30+ active turns
3. **Verify:** All 3 bots play independently (different track networks, different strategies)
4. **Verify:** No bot goes bankrupt
5. **Verify:** At least 1 bot completes 2+ deliveries

| Bot | Deliveries | Money at Turn 30 | Track Segments | Issues? |
|-----|------------|-------------------|----------------|---------|
| 1   |            |                   |                |         |
| 2   |            |                   |                |         |
| 3   |            |                   |                |         |

### Test 12.2: Turn timing with multiple bots
1. Time how long each round takes (1 human turn + 3 bot turns)
2. **Verify:** Total round time is reasonable (<15 seconds for 3 bots)
3. **Verify:** No single bot turn takes >10 seconds

| Round | Bot 1 (ms) | Bot 2 (ms) | Bot 3 (ms) | Total (ms) |
|-------|------------|------------|------------|------------|
| 1     |            |            |            |            |
| 5     |            |            |            |            |
| 10    |            |            |            |            |

---

## Summary Scorecard

Fill this out after completing all sections.

### Phase 1 Definition of Done

| Criterion | Target | Actual | PASS/FAIL |
|-----------|--------|--------|-----------|
| Plays 50+ turns without crash/freeze | 0 crashes | | |
| No bankruptcy (money < 0) | Never | | |
| No action loops (5+ identical turns) | 0 loops | | |
| No indefinitely held loads (>10 turns) | 0 stuck loads | | |
| No aimless track building | Connected network | | |
| At least 3 deliveries in 50 turns | >= 3 | | |
| At least 1 train upgrade | >= 1 | | |
| At least 100M ECU earned | >= 100M | | |
| Coherent track network | Visual check | | |

### Known Issues Status

| Issue | Validated? | Severity | Notes |
|-------|-----------|----------|-------|
| #1 Multi-delivery sequencing | | | |
| #2 Scoring constants sensible | | | |
| #3 Drop load logic | | | |
| #4 State continuity (BotMemory) | | | |
| #5 Build direction oscillation | | | |
| #6 Upgrade timing | | | |
| #7 DiscardHand usage | | | |
| #8 Victory tracking (deferred to Phase 3) | N/A | | |

### Overall Phase 1 Verdict

- [ ] **PASS** — Bot plays a full game competently. Ready for Phase 2 work.
- [ ] **CONDITIONAL PASS** — Bot plays but with notable issues. List blockers below.
- [ ] **FAIL** — Bot cannot complete a full game. List critical failures below.

**Blockers / Critical Failures:**

1.
2.
3.
