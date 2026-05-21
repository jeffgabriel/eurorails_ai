# JIRA-5: Help the Bot Plan Smarter Routes

## The Problem

When the bot finishes a delivery and needs to plan its next route, it asks the LLM to look at its 9 demand card options and pick the best multi-stop route. The LLM is only called once per route — then the bot auto-executes that route for several turns without consulting the LLM again. Early in the game when routes require building track, this means the LLM might be called every 7-15 turns. Later when the track network is built out, simple on-network deliveries might complete in 2-3 turns, so the LLM is called more frequently. Either way, a bad route choice locks the bot into a losing plan for multiple turns before it gets another chance.

The problem: the bot sees its demands as a flat list of independent options with no spatial awareness. It's like asking someone to plan a road trip by handing them a list of destinations with no map.

## Observed Bad Behavior

### Example 1: Bot ignores obvious route combinations

**Game state**: Bot is in central Europe with track through Wien. Its demands include:
- Coal from Krakow to Roma (29M)
- Ham from Warszawa to Roma (35M)
- Oranges from Valencia to London (34M)

**What the bot did**: Planned a single-stop route for Coal Krakow to Roma, ignoring Ham.

**What a human would do**: Immediately notice that Coal and Ham both deliver to Roma from nearby sources in eastern Poland. A human would combine them into one route — pick up Coal at Krakow, pick up Ham at Warszawa (right next door), deliver both to Roma. Same track, double the payout.

**Why it happened**: The bot's prompt shows each demand as a separate line item. It has no way to know that Krakow and Warszawa are neighbors, or that both routes converge on Roma through the same Wien corridor. It would need to mentally simulate European geography from city names alone.

### Example 2: Bot misses a free pickup along its route

**Game state**: Bot plans a route from Krakow through Wien and Munchen to Roma. Its demand cards include Chocolate from Zurich to Munchen (7M).

**What the bot did**: Drove right through Munchen without picking up or delivering anything, focused solely on the Roma delivery.

**What a human would do**: Notice that Munchen is directly on the route. Pick up Chocolate at Zurich (tiny detour), deliver it at Munchen for 7M free money while passing through.

**Why it happened**: The bot doesn't know Munchen is "on the way" between Wien and Roma. There's no signal that says "this demand can be fulfilled at near-zero cost because the delivery city is on your planned path."

### Example 3: Bot plans a route for a load that's almost gone

**Game state**: 3 out of 4 Ham chips are currently on other players' trains. Bot plans a 6-turn route to pick up Ham at Warszawa.

**What the bot did**: Built 12M of track toward Warszawa, arrived, and found no Ham available. Wasted 3 turns and 12M.

**What a human would do**: See that only 1 Ham chip remains and it could be picked up by another player at any moment. Choose a safer demand where the load is abundant.

**Why it happened**: The bot only sees "Ham is available: yes/no" (a binary). It doesn't know that 3 of 4 chips are already taken and the last one is at risk.

### Example 4: Bot has no idea how long a route will take

**Game state**: Bot has 45M cash and is choosing between:
- Flowers from Holland to Cork (24M payout, needs ~30M track, ~10 turns)
- Chocolate from Zurich to Berlin (13M payout, needs ~0M track, ~3 turns)

**What the bot did**: Chose Flowers to Cork for the higher payout.

**What a human would do**: Quick math — Flowers takes 10 turns for 24M (2.4M/turn). Chocolate takes 3 turns for 13M (4.3M/turn). Chocolate is almost twice as efficient. Plus the 10-turn commitment to Cork locks the bot into western Ireland, far from future opportunities.

**Why it happened**: The bot sees payout amounts but has no turn estimates. It can't compare efficiency (payout per turn) across demands.

### Example 5: Bot sees irrelevant warnings during route planning

**What the bot sees**: "You MUST continue your existing plan unless circumstances have fundamentally changed."

**Why it's confusing**: Route planning only happens when there IS no active plan. The bot just finished its last route or the previous one was abandoned. This warning wastes tokens and could cause the LLM to be overly conservative about picking a new direction.

## Desired Behavior

### 1. Bot should combine demands that share geography

When two or more demands travel in the same direction or share pickup/delivery cities, the bot should recognize this and plan a combined route.

**What the bot should see in its prompt:**
```
DEMAND CORRIDORS (demands sharing routes - combine for efficiency):
  Corridor A (Eastern Poland -> Roma): Coal Krakow->Roma + Ham Warszawa->Roma
    - Same destination, nearby sources
    - Combined new track needed: ~17M (vs ~27M individually)
    - Combined payout: 64M
    - On-the-way pickup: Chocolate Zurich->Munchen (7M, 0 extra track)
  Standalone: Oranges Valencia->London - different direction, 20M track, 34M payout
```

**Expected outcome**: Bot picks multi-stop corridor routes instead of single deliveries. Combined routes earn more money per turn of track building.

### 2. Bot should know when a demand is "on the way"

When a demand's pickup or delivery city falls along the path of another planned route, the bot should see this flagged.

**What the bot should see:**
```
  Chocolate from Zurich -> Munchen (7M) - ON THE WAY on Corridor A
```

**Expected outcome**: Bot adds cheap bonus deliveries to its routes, earning extra money with little or no detour.

### 3. Bot should know how long each demand takes

Each demand should show an estimated turn count so the bot can compare efficiency.

**What the bot should see:**
```
  Coal from Krakow -> Roma (29M) - ~7 turns (1 build, 5 travel, 1 deliver)
  Chocolate from Zurich -> Berlin (13M) - ~3 turns (0 build, 2 travel, 1 deliver)
```

**Expected outcome**: Bot prefers high-efficiency demands (payout per turn) over raw payout amount. Avoids committing to long, slow routes when faster alternatives exist.

### 4. Bot should know when a load is scarce

When most copies of a load chip are already on other players' trains, the bot should see a warning.

**What the bot should see:**
```
  Ham from Warszawa -> Roma (35M) - SCARCE: 3/4 Ham chips carried by other players
```

**Expected outcome**: Bot avoids planning routes that depend on scarce loads, especially when the route requires expensive track building to reach the supply city.

### 5. Route planning prompt should be tailored, not recycled

The route planning prompt currently reuses the same per-turn prompt, which includes irrelevant sections (plan persistence warnings, immediate pickup/deliver opportunities for the current position). Route planning needs its own focused prompt.

**Expected outcome**: Cleaner, more focused LLM input. No confusing "continue your plan" warnings when there's no plan to continue. Route-specific context (corridors, turn estimates) included instead of single-turn context.

## Example: Current Prompt vs Desired Prompt

### Current (what the LLM sees today)
```
YOUR DEMAND CARDS:
Card 6 (pick at most one):
  a) Cattle from Bern -> Paris (7M) - Supply at Bern (reachable). Delivery needs ~3M track.
  b) Coal from Krakow -> Roma (29M) - Supply not reachable (~15M track needed).
  c) Cheese from Kobenhavn -> Oslo (14M) - Supply not reachable (~20M track needed).
Card 25 (pick at most one):
  a) Chocolate from Zurich -> Berlin (13M) - Supply at Zurich (reachable). ON YOUR TRACK.
  b) Ham from Warszawa -> Roma (35M) - Supply not reachable (~12M track needed).
  c) Flowers from Holland -> Cork (24M) - Supply at Holland (reachable). Delivery ~30M track.
Card 3 (pick at most one):
  a) Oranges from Valencia -> London (34M) - Supply not reachable (~20M track needed).
  b) Chocolate from Zurich -> Munchen (7M) - Supply at Zurich (reachable). ON YOUR TRACK.
  c) Iron from Stockholm -> Lyon (21M) - Supply not reachable (~25M track needed).
```

Nine independent options, no spatial relationships. The LLM cannot tell that [6b] and [25b] share a corridor, that [3b] is on the way, or that [25c] goes in a completely different direction than everything else.

### Desired (what the LLM should see)
```
YOUR DEMAND CARDS:
Card 6 (pick at most one):
  a) Cattle from Bern -> Paris (7M) - reachable, ~3M track, ~2 turns
  b) Coal from Krakow -> Roma (29M) - ~15M track, ~7 turns
  c) Cheese from Kobenhavn -> Oslo (14M) - ~20M track, ~9 turns
Card 25 (pick at most one):
  a) Chocolate from Zurich -> Berlin (13M) - ON YOUR TRACK, ~3 turns
  b) Ham from Warszawa -> Roma (35M) - ~12M track, ~6 turns. SCARCE: 3/4 carried
  c) Flowers from Holland -> Cork (24M) - ~30M track, ~10 turns
Card 3 (pick at most one):
  a) Oranges from Valencia -> London (34M) - ~20M track, ~8 turns
  b) Chocolate from Zurich -> Munchen (7M) - ON YOUR TRACK, ~2 turns. ON THE WAY on Corridor A
  c) Iron from Stockholm -> Lyon (21M) - ~25M track, ~9 turns

DEMAND CORRIDORS (demands sharing routes - combine for efficiency):
  Corridor A (Eastern Poland -> Roma): [6b] Coal Krakow->Roma + [25b] Ham Warszawa->Roma
    - Same destination (Roma), nearby sources (Krakow & Warszawa)
    - Combined new track: ~17M (vs ~27M individually)
    - Combined payout: 64M in ~8 turns
    - On-the-way: [3b] Chocolate Zurich->Munchen (7M, 0 extra track)
  Standalone: [3a] Oranges Valencia->London - opposite direction, 20M track, 34M payout
```

## Success Criteria

1. **Combined routes**: When demands share a corridor, the bot plans a multi-stop route that serves both instead of picking one
2. **On-the-way pickups**: Bot adds bonus deliveries when they're on its planned path at near-zero cost
3. **Efficiency over raw payout**: Bot prefers a 13M delivery in 3 turns over a 24M delivery in 10 turns
4. **Scarcity avoidance**: Bot doesn't commit 5+ turns of track building toward a load where 3/4 chips are already taken
5. **No wasted tokens**: Route planning prompt doesn't include per-turn noise (plan persistence, immediate opportunities)

## Scope

- This is a prompt/context change only. No changes to how routes are executed, validated, or abandoned.
- All corridor and turn-estimate data is computed from existing game state. No new LLM calls.
- The per-turn prompt (used during route execution) is unchanged. Only the route planning prompt is affected.
- No hardcoded European geography. Corridors are computed from hex distances between cities on the game board.

## Note on Initial Build

JIRA-1 (Starting City Fix) is already implemented — the bot calls `planRoute()` during the initial build phase and the prompt includes basic initial build guidance (40M budget, prefer cheap/short routes, avoid ferries, prefer central Europe). The route planning prompt improvements in this ticket (corridors, turn estimates, scarcity) will also benefit the initial build decision since it uses the same prompt path.
