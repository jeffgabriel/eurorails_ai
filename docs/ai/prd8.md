# Section 8: Victory Condition — Bot Can Win (or Lose) the Game

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
The bot tracks its progress toward the victory condition ($250M cash + track connecting all-but-one major cities) and can declare victory when conditions are met. The game can reach a proper conclusion with a bot winner.

### Depends On
Section 6 (bot can earn money through deliveries).

### Human Validation
1. Play a long game (or modify bot's starting money for faster testing) until the bot approaches $250M
2. The bot connects its track to major cities as a secondary goal
3. When both conditions are met (≥$250M and ≥7 of 8 major cities connected), the bot declares victory
4. `victory:triggered` event fires — human sees "Bot has declared victory!"
5. Equal turns play out — human gets their final turn(s)
6. Game ends with `game:over` — winner is displayed
7. Verify in debug overlay: bot's major city count, money, victory progress

### Requirements

1. **Server: Major city connectivity tracking**:
   - Count how many major cities are connected in the bot's track network using BFS/DFS traversal
   - A city is "connected" if there is a continuous path of the bot's own track segments from that city to any other connected city
   - This must use graph traversal on the bot's track segments, not just checking if a major city appears in any segment

2. **Server: Victory condition check**:
   - After each bot turn, check: `money >= victoryThreshold` AND `connectedMajorCities >= totalMajorCities - 1`
   - If met: call `VictoryService.declareVictory(gameId, botPlayerId, connectedCities)`
   - The existing victory flow handles equal turns and tie-breaking

3. **Server: Victory-aware turn strategy**:
   - When the bot is close to victory (e.g., needs 1-2 more major cities or $20-50M more), prioritize actions that advance toward victory
   - Build toward unconnected major cities even if no demand justifies it
   - Deliver highest-value loads to cross the money threshold

4. **Client: Debug overlay — victory progress**:
   - Show in player table: major cities connected (X of Y)
   - Show victory progress bar or indicator
   - Flag when bot is close to victory conditions

### Acceptance Criteria

- [ ] Bot tracks major city connectivity correctly
- [ ] Bot declares victory when conditions are met
- [ ] Victory flow works correctly (equal turns, tie-breaking)
- [ ] Debug overlay shows major city count and victory progress
- [ ] Game reaches proper conclusion (game:over event, winner displayed)
- [ ] Bot prioritizes victory when close to winning

---

## Related User Journeys

### Journey 4: Edge Case 4 — Bot Achieves Victory Condition

**Scenario:** Heinrich connects 7 major cities and has ECU 250M.

**What happens:**
1. After Heinrich's turn, `AIStrategyEngine` checks victory conditions
2. Calls `VictoryService.declareVictory(gameId, heinrichPlayerId, claimedCities)`
3. Server validates: 7 unique cities in track network, money >= 250M
4. Sets `victory_triggered = true`, records trigger player index
5. Determines `final_turn_player_index` — all remaining players get equal turns
6. Socket: `victory:triggered` event emitted

**What Alice sees:**
1. Toast notification: "Heinrich has declared victory! Remaining players get equal turns."
2. The game continues — Alice gets her final turn(s)
3. Alice can try to also reach victory conditions (tie scenario)
4. After all players have had equal turns:
   - If Alice also met conditions: `victory:tie-extended` → threshold rises to 300M, play continues
   - If only Heinrich met conditions: `game:over` event → `WinnerScene` launches
5. **WinnerScene:** Full-screen overlay with "GAME OVER", "Heinrich Wins!", final standings sorted by money, confetti animation, "Leave Game" button
