# Section 11: Turn Animations and UX Polish

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
Bot turns feel natural and readable. Instead of instant state changes, bot actions animate on the map so the human can follow what happened.

### Depends On
Section 6 (bot performs multiple action types to animate).

### Human Validation
1. Watch a bot's turn — see the thinking animation, then track building animation, then train movement
2. The pacing feels natural (not instant, not too slow)
3. "Fast Bot Turns" setting skips animations
4. The human can still open the debug overlay during bot turns

### Requirements

1. **Client: Bot turn visual feedback**:
   - On `bot:turn-start`: bot's name in leaderboard pulses, "thinking" indicator appears (1-2 seconds)
   - Track segments animate drawing in bot's color (same crayon animation as human track building)
   - Train sprite animates movement along the path (same animation as human movement)
   - On `bot:turn-complete`: pulsing stops, brief pause before next turn
   - Toast notifications: "Bot is thinking..." → "Bot finished their turn"

2. **Server: Per-action events**:
   - Emit `bot:action` events for each action in the turn plan: `{ type: 'buildTrack' | 'moveTrain' | 'pickupLoad' | 'deliverLoad', details }`
   - Client uses these to sequence animations (build first, then move, then pickup/deliver)
   - Each action has a delay between it (500ms-1000ms) for readability

3. **Client: Fast mode**:
   - Toggle in game settings: "Fast Bot Turns"
   - When enabled: skip all animations and delays, bot turns complete instantly
   - Debug overlay still shows all data regardless of fast mode

### Acceptance Criteria

- [ ] Bot turns have visible thinking indicator, track animation, movement animation
- [ ] Pacing feels natural (2-4 seconds for a typical turn with animations)
- [ ] Fast mode skips all animations
- [ ] Human can interact with debug overlay during bot turns
- [ ] Toast notifications appear for bot turn start/end

---

## Related User Journeys

The animation system is referenced throughout the user journeys. Key moments:

### Journey 1: Turn 2 — Bot Turn Animations

**What Alice sees during Heinrich's turn:**
1. The leaderboard now highlights "Heinrich 🧠". The "Next Player" button grays out and reads "Wait Your Turn"
2. After ~1500ms delay (`BOT_TURN_DELAY_MS`), server emits `bot:turn-start`:
   - Alice sees: brain icon (🧠) next to Heinrich's name starts **pulsing** (alpha fading 1.0→0.3, 600ms cycle)
   - Toast notification appears top-right: **"Heinrich is thinking..."** (2000ms)
3. Track segments appear on the map in Heinrich's color
4. Server emits `bot:turn-complete`:
   - Brain icon stops pulsing
   - Toast: **"Heinrich finished their turn."** (1500ms)

**Note:** `bot:action` events are defined but NOT currently emitted by the server. The human sees the results (track appearing, train moving) via `state:patch` and `track:updated`, but there are no per-action animations yet. This is a known gap that Section 11 addresses.
