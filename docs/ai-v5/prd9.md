# Section 9: Robust Error Handling and Turn Recovery

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
Make the bot turn pipeline bulletproof. Any failure during a bot turn results in graceful recovery (retry or safe fallback), never a game freeze. All failures are visible in the debug overlay.

### Depends On
Section 6 (bot executes real game actions that can fail).

### Human Validation
1. Play extended games (50+ bot turns) and verify zero freezes
2. Intentionally create edge cases: bot tries to pick up unavailable loads, build beyond $20M limit, move to unreachable cities
3. Debug overlay shows any retries or fallbacks clearly: "Retry 1/3: PickupSteel failed (unavailable), trying next option"
4. Even if all options fail, the bot passes its turn and the game continues

### Requirements

1. **Server: Retry pipeline**:
   - If an action fails during execution, catch the error
   - Remove the failed option from the candidate list
   - Re-select from remaining feasible options (up to 3 retries)
   - If all retries exhausted: execute safe fallback (build cheapest track segment if possible, otherwise PassTurn)
   - All failures logged with context

2. **Server: Pre-execution validation**:
   - Before each action in a turn plan, re-validate that it's still feasible
   - An earlier action in the same turn may have changed state (e.g., picking up a load reduces capacity)
   - If pre-execution check fails, skip that action and continue with remaining actions

3. **Server: State integrity check**:
   - After each bot turn, compare expected state changes vs actual DB state
   - Log discrepancies as warnings in the debug overlay
   - Expected: money changed by delivery_payment - build_cost - fees, loads changed by pickups - deliveries

4. **Server: Turn timeout**:
   - Bot turns must complete within 30 seconds
   - If timeout: force PassTurn, log timeout context
   - Emit `bot:turn-complete` with timeout flag

5. **Client: Debug overlay — error and recovery display**:
   - Show retries: "Attempt 1/3 failed: {reason}. Retrying with next option."
   - Show fallbacks: "All options exhausted. Falling back to PassTurn."
   - Show integrity checks: "State integrity OK" or "WARNING: Expected money $85M, actual $83M"
   - Color-code: green for success, yellow for retry, red for fallback

### Acceptance Criteria

- [ ] 50+ consecutive bot turns with zero game freezes
- [ ] Failed actions trigger retry (visible in debug overlay)
- [ ] All retries exhausted → safe fallback → turn completes
- [ ] Turn timeout (30s) forces PassTurn
- [ ] State integrity checks pass on normal turns
- [ ] Debug overlay clearly shows any errors and recovery steps
- [ ] No `[BOT:ERROR]` that results in a stuck game

---

## Related User Journeys

### Journey 4: Edge Case 1 — Bot's Planned Actions Are All Invalid

**Scenario:** Heinrich has no available loads at reachable cities, can't afford to build track (0 ECU), and his demand cards require cities far from his network.

**Server behavior:**
1. `OptionGenerator.generate()` produces options, but `PlanValidator` rejects them all
2. `AIStrategyEngine` retry logic: tries next-best option (up to 3 retries)
3. All retries fail → **PassTurn fallback**: executes `discardHandForUser()` or equivalent pass action
4. Bot's turn ends gracefully

**What Alice sees:**
- Brain icon pulses briefly
- "Heinrich is thinking..." (2000ms)
- Bot turn completes quickly (no track/movement changes visible)
- "Heinrich finished their turn." (1500ms)
- Alice's turn starts normally — **game is NOT stuck**

### Journey 4: Edge Case 3 — Human Disconnects During Bot Turn

**Scenario:** Alice closes her browser tab while Heinrich (bot) is executing.

**Server-side:**
1. Heinrich's turn continues to completion (server-side execution, no client needed)
2. `advanceTurnAfterBot()` advances to next player
3. If next player is Alice (human), `BotTurnTrigger.onTurnChange()` calls `hasConnectedHuman(gameId)`
4. `hasConnectedHuman()` returns `false` (Alice disconnected)
5. If next player is ALSO a bot → bot executes (bots run server-side, no human needed for computation)
6. If only human players remain: `queuedBotTurns.set(gameId, { ... })` — bot turn queued

**Alice reconnects:**
1. Socket.IO reconnects automatically
2. Client sends `join` event with gameId
3. Server handler calls `BotTurnTrigger.onHumanReconnect(gameId)`
4. If a bot turn was queued: dequeues and triggers `onTurnChange()` → bot executes
5. If it's Alice's turn: she gets `state:init` with full current game state → UI rebuilds from authoritative server state
6. All track, positions, money reflect the completed bot turns
