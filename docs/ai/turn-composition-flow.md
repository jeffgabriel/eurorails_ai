# AI Bot Turn Composition — Behavioral Flow

How the bot decides what to do each turn and how a single turn gets composed into multiple actions.

---

## Game Rule Foundation

Per EuroRails rules, every turn has **two phases**:

1. **Operate the train** — Move along track (up to 9 or 12 mileposts depending on train type), picking up and delivering loads at any city passed through. Loading and unloading does not consume movement. The bot should keep moving until it runs out of movement budget, reaches a ferry port, or has no more track to travel on.
2. **Spend money** — Build track (up to 20M) OR upgrade the train. Not both.

A player may also **discard their entire hand** instead of taking a turn.

---

## Initial Build Phase (First Two Turns)

Per game rules, the first two turns are build-only. No train exists on the board. No movement, no loads, no deliveries. The bot spends up to 20M per turn laying track.

### What happens

1. **The LLM is called once** on the very first turn to plan a strategic route. The LLM sees each demand card with its payout, estimated build cost, and estimated turns to fulfill. It picks the cheapest, shortest route — not the highest payout. It also chooses a **starting city** — the major city where the bot will place its train when initial build ends.

   Example route (using real game data):
   > pickup Wine at Frankfurt → deliver Wine at Antwerpen (10M) → pickup Cheese at Holland → deliver Cheese at Berlin (10M)

2. **PlanExecutor builds track** from the starting city toward the first delivery city, then (if budget remains) toward the supply city. On the second turn it continues building. That's it — just lay track toward the route's cities.

### What doesn't happen

- **No TurnComposer enrichment.** During initial build, the composer returns the plan unchanged. There's no train to move, no loads to handle.
- **No train placement.** The bot has no position on the board. It gets auto-placed at its starting city when initial build ends.

---

## Normal Play (After Initial Build)

### The Decision

The first thing the bot checks: **do I already have a plan?**

If yes — the bot has an active strategic route from a previous turn — it skips straight to PlanExecutor. No snapshot, no context build, no LLM call. This is the fast path and handles the majority of turns.

If no — the bot needs a new plan. It captures a snapshot of the game state, builds a strategic context, and asks the LLM to plan a new multi-stop strategic route. The LLM sees:
- Each demand card with payout, estimated build cost, estimated travel turns, and a reachability note (e.g. "DELIVERABLE NOW", "needs ~8M track, 1 build turn", "⚠️ UNAFFORDABLE")
- Demand corridors — groups of demands that share routes for efficiency
- Victory progress — which major cities still need connecting
- Load scarcity — how many copies of each load are available vs. carried by other players

If the LLM fails, log an error to the debug overlay and pass the turn.

### PlanExecutor: Following the Route

A strategic route is a multi-stop plan like:
> pickup Oil at Aberdeen → deliver Oil at Antwerpen (20M) → pickup Cheese at Holland → deliver Cheese at Budapest (21M)

PlanExecutor works through each stop. For each stop, it asks two questions:

1. **Can I get there?** Is the target city reachable on my track network?
   - Yes → move toward it (operate the train)
   - No → build toward it (spend money) and try again next turn

2. **Am I there?** Once at the target city, execute the stop's action (pickup or deliver), then advance to the next stop.

PlanExecutor returns a **single action** — one move, one pickup, one deliver, or one build. It handles one thing per turn. TurnComposer's job is to fill out the rest.

### Turn Composition: The Two Phases

After PlanExecutor returns its single action, **TurnComposer** composes a complete two-phase turn. It never overrides the decision — it only fills in the parts PlanExecutor left on the table.

#### Phase 1: Operate the Train

The bot should use its full movement allowance every turn. Moving farther means more cities passed through, which means more opportunities to pick up and deliver.

**The movement loop:**
1. Move toward the route's next stop (or toward the best demand city)
2. At each city along the path, check: can I deliver a load here? Can I pick one up?
3. If yes — stop, act, then keep moving with remaining budget
4. Repeat until movement budget is exhausted

**When to stop moving:**
- All 9 (or 12) mileposts are used up
- The bot reaches a ferry port (must stop and cross next turn)
- The bot has run out of track (no more connected path toward the destination)
- There's nowhere useful to move toward

**Example — pickup and continue (real game data):**
Route says "deliver Cars at Nantes (51M)." Bot starts near Milano, moves 2 mileposts to Torino. Torino has Cars available and the bot has demand card #132 (Cars → Nantes, 51M). Bot picks up Cars at Torino. Bot has 7 mileposts remaining. Bot continues moving 7 more mileposts toward Nantes.

Composed turn (all actions executed in a single turn): Move(→Torino), Pickup(Cars@Torino), Move(→toward Nantes, 7 mileposts)

**Example — mid-movement delivery (real game data):**
Bot is carrying Wine and has demand card #14 (Wine → Paris, 11M). Moving from London toward Berlin, the path passes through Paris at milepost 4. Bot delivers Wine at Paris, earns 11M, then continues the remaining 5 mileposts toward Berlin.

Composed turn (all actions executed in a single turn): Move(→Paris), Deliver(Wine@Paris), Move(→Berlin)

#### Phase 2: Spend Money

After operating the train, the bot checks if it should build track or upgrade.

**Cash preservation is paramount.** Money is the victory condition (250M). Every ECU spent on track is an ECU that doesn't count toward winning. Build only when there is a specific, identified delivery that justifies the cost.

**When to spend money:**
- The bot's current route has a stop city that isn't on the track network yet — build toward it to complete the delivery
- The bot can afford a train upgrade and it would help

**When NOT to spend money:**
- The bot already built this turn (PlanExecutor's action was a build)
- The bot is mid-delivery (traveling to deliver a load it's carrying) — finish the delivery first, earn the payout, then build next turn
- There is no identified delivery that requires new track — do not build speculatively
- Budget is zero (already spent 20M or broke)
- Building toward major cities for victory: only do this when cash is greater than 230M (within striking distance of the 250M victory condition). Before that threshold, every ECU should go toward deliveries that earn money

**Example — build after move (real game data):**
Bot moves to Torino and picks up Cars, continues moving 7 mileposts toward Nantes. Still has 14M cash. Route's delivery city (Nantes) isn't on the network. Bot spends 14M building track toward Nantes.

Composed turn (all actions executed in a single turn): Move(→Torino), Pickup(Cars@Torino), Move(→7 more), Build(toward Nantes, 14M)

### Guardrails

Hard safety rules are applied after composition:
- No consecutive discards beyond the limit
- **No passing while carrying loads** — if the bot is carrying a load, it must do something productive (move toward a delivery city, deliver, pick up another load, build). Passing means the bot wasted a turn while sitting on cargo it could be delivering. If the pipeline produces a PassTurn while the bot has loads, the guardrail overrides it with a move or deliver action.
- No building beyond the 20M turn budget

If a guardrail is violated, the plan is overridden with a safer alternative.

### Re-planning After Delivery

When the bot delivers a load, the demand card is discarded and a new one is drawn. This changes the bot's strategic landscape — the new card might offer a better route, a closer pickup, or a higher payout than what the current route has planned.

After any delivery, the bot should **call the LLM to re-evaluate the route**. The current route may still be the best plan, but the LLM needs to see the new demand card to make that judgment. Without re-planning, the bot blindly follows a route that was optimized for cards it no longer holds.

### Execution and Memory

The final composed plan is executed against the database (build segments, move position, pick up loads, deliver and collect payment, etc.).

The bot's memory is updated: active route state, last action taken, LLM reasoning, and route history. This memory persists across turns.

---

## Summary: What Each Phase Can Do

| Capability | Initial Build | Normal Play |
|---|---|---|
| Build track (up to 20M) | Yes | Yes (after operating train) |
| Move train | No | Yes (up to 9 or 12 mileposts) |
| Pick up loads | No | Yes (at any city along movement path) |
| Deliver loads | No | Yes (at any city along movement path) |
| Upgrade train | No | Yes (instead of building) |
| Discard hand | No | Yes (instead of taking a turn) |
| TurnComposer enrichment | No | Yes |
| LLM route planning | Yes (first turn only) | Yes (when no active route) |

---

## Key Behaviors

- **Route executor is the fast path.** If the bot has an active route, no snapshot/context/LLM overhead.
- **The LLM plans full routes, not single actions.** It sees build costs, travel time estimates, load scarcity, and demand corridors.
- **Re-plan after delivery.** A new demand card changes the strategic landscape. Call the LLM to re-evaluate.
- **PlanExecutor returns one action per turn.** TurnComposer fills out the rest into a complete two-phase turn.
- **Every turn should have two phases.** Operate the train (move + pickup/deliver loop), then spend money (build or upgrade). If the bot isn't doing both, something is wrong.
- **Mid-movement opportunities are the key optimization.** Walking the move path and acting at every intermediate city keeps the bot productive.
- **Never build speculatively.** Only build track when there's an identified delivery that requires it. Cash is the victory condition.
- **Victory builds only above 230M.** Don't spend money connecting major cities until the bot is within striking distance of 250M.
- **Initial build is simple.** Build from starting city toward route cities. No movement, no composition.
