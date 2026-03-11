# Section 6: Bot Picks Up and Delivers Loads — Completing the Game Loop

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
The bot can pick up loads at supply cities and deliver them at demand cities for payment. This completes the core gameplay loop: build track → move to supply city → pick up load → move to demand city → deliver load → earn money → draw new card. The bot can now play a meaningful (if simple) game of EuroRails.

### Depends On
Section 5 (bot can move along track).

### Human Validation
1. Start a game with 1 human + 1 bot
2. Play through initial build and into active phase
3. Watch the bot over 10-15 turns — it should:
   - Build track toward cities on its demand cards
   - Move its train to supply cities and pick up loads
   - Move to demand cities and deliver loads for payment
   - Bot's money increases noticeably after deliveries
   - Bot draws replacement demand cards after deliveries
4. Debug overlay shows: load pickups ("Bot picked up Wine at Bordeaux"), deliveries ("Bot delivered Wine to Vienna for $48M"), demand card changes
5. The bot's loads appear in the debug overlay player table
6. The human can race the bot for loads — if the bot picks up all available copies of a load type, the human can't pick it up (and vice versa)

### Technical Context

**How humans pick up loads:**
- ⚠️ **`PlayerService.pickupLoadForUser()` does not exist.** The actual pickup path is: `POST /api/loads/pickup` → `loadRoutes.ts` handler → `LoadService.pickupDroppedLoad(city, loadType, gameId)` (`loadService.ts:77`)
- Load availability is checked via `LoadService.isLoadAvailableAtCity(city, loadType, gameId)`
- Global load limit: each load type has 3-4 copies total in the game. If all are on trains, no more can be picked up.

**How humans deliver loads:**
- `PlayerService.deliverLoadForUser(gameId, userId, city, loadType, cardId)` — validates card in hand, load on train, player at demand city
- Calculates payment with debt repayment: `repayment = min(payment, debt_owed)`, `netPayment = payment - repayment`
- Removes load from train, replaces demand card (discard + draw from `DemandDeckService`)
- Updates money, hand, loads, debt_owed

**Demand cards:**
- Each player holds exactly 3 demand cards (the `hand` column is `INTEGER[]` of card IDs)
- Each card has 3 demands: `{ city, loadType, payment }`
- Only ONE demand per card can be fulfilled
- After fulfillment, the card is discarded and a replacement is drawn from `DemandDeckService`
- `DemandDeckService` is an in-memory singleton — it manages the deck per game

**Load availability:**
- Source cities supply specific load types (defined in game configuration / gridPoints data)
- `LoadService.isLoadAvailableAtCity(city, loadType, gameId)` checks both static sources and dropped loads
- Dropped loads are in the `load_chips` table with `is_dropped = true` and a city name

### Requirements

1. **Server: WorldSnapshot** (`src/server/services/ai/WorldSnapshot.ts`):
   - Capture a read-only snapshot of all game state needed for AI decision-making
   - Contains: bot position, track network, cash, demand cards (all 3 cards with all 9 demands), carried loads, train type, all other players' positions and loads, global load availability, map topology, major city connection status
   - Immutable — the AI pipeline reads from the snapshot, never from live state
   - This prevents race conditions where state changes during AI computation

2. **Server: Option generation — pickup and delivery**:
   - Scan all 9 demands across the bot's 3 cards
   - For each demand: check if the load type is available at its source city, check if the source city is reachable on existing track, check if the demand city is reachable
   - Generate `PickupLoad` options (move to source, pick up) and `DeliverLoad` options (if already carrying the right load and at/near the demand city)
   - Check train capacity before generating pickup options
   - Check global load availability before generating pickup options

3. **Server: Execution — pickup and delivery**:
   - Call `LoadService.pickupDroppedLoad(city, loadType, gameId)` for pickups (`loadService.ts:77`) — same function the human route handler uses
   - Call `PlayerService.deliverLoadForUser()` for deliveries — same function humans use
   - These functions handle all validation, state mutation, and debt repayment
   - After delivery, the bot's hand changes (new card drawn). Update the world snapshot if planning further actions this turn.

4. **Server: Simple Opportunist strategy**:
   - Evaluate all 9 demands by immediate income potential
   - If carrying a load that matches a reachable demand city: deliver it (highest priority)
   - If at a city with a pickupable load matching a demand: pick it up
   - If neither: move toward the nearest supply city for the highest-paying reachable demand
   - Build track toward unreachable supply/demand cities
   - This is the Opportunist archetype at Medium skill — reactive, chases the best available payout

5. **Server: Turn action sequencing**:
   - A complete bot turn in active phase: move → pick up loads along the way → deliver if at demand city → build track → end turn
   - Movement may involve multiple stops (pass through a supply city, pick up, continue to demand city, deliver)
   - Track building happens after movement
   - The bot must check feasibility at each step (e.g., after picking up a load, check capacity before trying to pick up another)

6. **Client: Debug overlay — load and delivery data**:
   - Show loads carried in the player table
   - When bot picks up: "Bot picked up {loadType} at {city}"
   - When bot delivers: "Bot delivered {loadType} to {city} for ${payment}M (card replaced)"
   - Show the bot's current demand card targets (anonymized card IDs with demand summaries)

### Warnings

- **Only ONE demand per card can be fulfilled.** A common mistake is attempting to fulfill multiple demands from the same card. After delivering a load that matches one demand on a card, that card is discarded and replaced. The other 2 demands on that card are gone.
- **Load availability is global.** If all 3 copies of Wine are on players' trains, no one can pick up more Wine. The bot must check availability before planning a pickup.
- **Don't pick up loads during `initialBuild`.** The server blocks this. Only generate pickup/delivery options when `game.status === 'active'`.
- **Debt repayment is automatic.** If the bot has debt and makes a delivery, part of the payment goes to debt repayment. Don't double-deduct.

### Acceptance Criteria

- [ ] Bot picks up loads at supply cities (visible in debug overlay)
- [ ] Bot delivers loads at demand cities and receives payment (money increases)
- [ ] Bot's demand cards change after delivery (new card drawn)
- [ ] Bot respects train capacity (doesn't pick up more loads than capacity allows)
- [ ] Bot respects global load availability (doesn't pick up unavailable loads)
- [ ] Only one demand per card is fulfilled
- [ ] Bot plays meaningfully over 20+ turns: builds, moves, picks up, delivers, earns money
- [ ] Debug overlay shows complete turn narrative: what the bot did and why
- [ ] The human player can race the bot for scarce loads
- [ ] Bot's money increases over time from deliveries (not building for free)
- [ ] Human-only games unaffected — zero regressions

---

## Related User Journeys

### Journey 1: Turns 7-10 — Rhythm Established

The game settles into a rhythm:

**Alice's turns (odd-numbered):**
- Move train along track toward delivery cities
- Pick up loads when passing through source cities
- Build track to extend network toward demand destinations
- Eventually deliver first load → demand card discarded, new card drawn, payment received
- Click "Next Player" when done

**Heinrich's turns (even-numbered):**
- 1500ms pause → brain pulse → "thinking..." toast
- AI builds track/moves/delivers (visible through state patches and track updates)
- "finished their turn" toast → "It's your turn!" toast
- Typical bot turn takes 1-3 seconds of server-side processing

**By Turn 10:**
- Both players have ~10-15 track segments, extending from their starting major cities
- Alice may have delivered 1-2 loads (ECU +8-20M)
- Heinrich has been building toward his demand destinations
- Alice can see Heinrich's track on the map (different color) and his train position
- Track networks may begin overlapping near popular major cities

### Journey 3: Scenario A — Bot Delivers a Load

**Setup:** Turn 20+. Alice has ECU 85M, Heinrich has ECU 72M.

```
[Heinrich's Turn — Mid-Game Delivery]
```

**What the server does:**
1. `OptionGenerator` generates a `DeliverLoad` option: Heinrich is at Berlin with Wine, has demand card for Wine→Berlin (12M)
2. `Scorer` rates this highly (immediate cash)
3. `TurnExecutor.handleDeliverLoad()`:
   - Calls `PlayerService.deliverLoadForUser(gameId, heinrichUserId, 'Berlin', 'Wine', cardId)`
   - Server: validates card in hand, load on train, player at city
   - Updates: `money += 12M` (minus debt if any), `loads` removes Wine, `hand` replaces card
   - `DemandDeckService`: discards fulfilled card, draws replacement
   - Emits `state:patch` with updated player data

**What Alice sees:**
1. Brain icon pulses, "Heinrich is thinking..."
2. `state:patch` arrives → Alice's client updates Heinrich's entry in the leaderboard:
   - Money: 72M → 84M
   - Train shows one fewer load
3. Heinrich's demand cards (face-up per rules) update — old card gone, new card drawn
4. "Heinrich finished their turn."

### Journey 3: Scenario D — Human Uses Bot's Track (Track Usage Fees)

Alice wants to reach Wien, which is connected by Heinrich's track but not hers.

1. Alice moves her train toward Wien. The path goes through Heinrich's track segments.
2. Client: `computeTrackUsageForMove()` detects opponent track in path
3. **Confirmation dialog appears:** "Using Heinrich's track. Fee: ECU 4M. Continue?"
4. Alice clicks "Yes"
5. `POST /api/players/move-train` includes the movement
6. Server: deducts 4M from Alice, adds 4M to Heinrich
7. `state:patch` updates both players' money
8. Both players' leaderboard entries update simultaneously
