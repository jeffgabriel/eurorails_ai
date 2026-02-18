# Section 12: Train Upgrades and Advanced Actions

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
The bot can upgrade its train (Freight → Fast Freight / Heavy Freight → Super Freight) when strategically beneficial, and handle edge cases like crossgrades, ferry crossings, and the discard-hand action.

### Depends On
Section 6 (bot has the core gameplay loop working).

### Human Validation
1. Watch a bot over a long game — at some point it upgrades its train
2. After upgrading to Fast Freight (speed 12), the bot moves farther per turn
3. The upgrade decision is visible in the Strategy Inspector (scored against alternatives)
4. The bot correctly handles the mutually exclusive constraint: can't build track and upgrade in the same turn

### Requirements

1. **Server: Upgrade option generation and execution**:
   - Generate `UpgradeTrain` options with valid transitions (Freight→Fast/Heavy, Fast/Heavy→Super)
   - Check: sufficient money, no track building this turn (for upgrades; crossgrades allow up to $15M building)
   - Execute via `PlayerService.purchaseTrainType()` — the same function humans use
   - Score upgrades using the Trunk Sprinter's high `Upgrade ROI` multiplier (for that archetype) or lower for others

2. **Server: Discard hand action**:
   - When the bot's demand cards are all terrible (no good deliveries possible), generate a `DiscardHand` option
   - Execute via `PlayerService.discardHandForUser()` — draws 3 new cards
   - Score low (last resort before PassTurn)

3. **Server: Ferry handling**:
   - Detect when movement path crosses a ferry
   - Handle ferry movement rules: lose remainder of movement, start next turn at half speed on the other side
   - Track ferry state in the bot's turn context

### Acceptance Criteria

- [ ] Bot upgrades train when strategically beneficial
- [ ] Upgrade follows valid transition paths
- [ ] Can't upgrade and build track in same turn (except crossgrade + ≤$15M build)
- [ ] Bot discards hand when cards are poor
- [ ] Ferry crossings handled correctly (if applicable to bot's routes)
- [ ] All actions use shared player service functions

---

## Related User Journeys

### Journey 3: Scenario C — Bot Upgrades Train

1. `TurnExecutor.handleUpgradeTrain()` calls `PlayerService.purchaseTrainType(gameId, userId, 'upgrade', 'FastFreight')`
2. Server: validates Freight→FastFreight is legal, deducts 20M, no track building this turn
3. `state:patch` updates Heinrich's train type and money
4. Alice sees in the leaderboard: Heinrich's train icon changes, money decreases by 20M

### Journey 4: Edge Case 5 — Bot Turn During Event Cards

**Current status:** Event cards are NOT implemented in the codebase. The database schema includes an `event_cards` table (migration 001, with columns for `type`, `effect` JSONB, `status`, `expires_at`), but no event card logic exists in server or client code. This is a future feature.

When implemented, event cards would need to:
- Be drawn when demand cards are drawn (event cards mixed into the deck)
- Take immediate effect (storms, strikes, derailments)
- Affect bot pathfinding and option generation (e.g., blocked routes, half-speed regions)
- The `WorldSnapshot` would need to include active event effects
- `OptionGenerator` and `Scorer` would need to account for temporary route blockages
