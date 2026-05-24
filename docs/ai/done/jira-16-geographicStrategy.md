# JIRA-16: Strategic Intelligence — Teach the LLM How to Play

## Problem

The route planning system prompt (`ROUTE_PLANNING_SYSTEM_SUFFIX`) teaches the LLM game mechanics but not game strategy. It knows what actions are legal but doesn't understand:

- Central Europe is cheap to build in and has high track reuse
- Peripheral regions (Spain, Scandinavia, UK/Ireland, deep Italy) are capital traps in early game
- Fast cheap deliveries beat slow expensive ones (capital velocity)
- When to expand beyond the core is a complex risk evaluation
- How demand CARDS work strategically (3 demands per card, only 1 fulfillable — when to discard a bad hand)
- How to fill cargo slots with secondary pickups from different cards
- When to upgrade the train and which upgrade path to choose

This leads to the bot picking routes like China→Oslo (30M, requires ferry, ranked near bottom of demand scoring) over Iron→Praha (17M, cheap to reach, ranked #1) — because the LLM has no strategic intelligence.

### Related Bugs (JIRA-14)

- **Bug 1**: Bot builds spur to Ruhr with no matching demand cards (secondary build target + victory routing)
- **Bug 7**: Bot ignores demand ranking when planning routes (system prompt never references it)
- **Bug 8**: Bot wastes 2M building past Hirtshals ferry (no geographic awareness of ferry costs)

## Proposal

Replace the current `INITIAL BUILD STRATEGY` and `SECONDARY BUILD TARGET` sections in `ROUTE_PLANNING_SYSTEM_SUFFIX` with a unified `GEOGRAPHIC STRATEGY` section that teaches the LLM how experienced players think about the map.

**Philosophy**: Provide information and strategic frameworks — NOT prescriptive rules. The LLM should make complex risk evaluations itself, not follow our heuristic. Our demand ranking is often wrong (too heavily weighted toward big payouts that force bankruptcy). The LLM needs geographic intelligence to override bad heuristic recommendations.

## Draft: GEOGRAPHIC STRATEGY Section

```
GEOGRAPHIC STRATEGY:
The map has a cheap, dense core and expensive peripheral regions. Understanding this geography is critical to not going bankrupt.

CORE NETWORK (cheap to build, high track reuse):
Paris — Ruhr — Holland — Berlin form a tight rectangle in northwest Europe, mostly clear terrain (1M/segment). Wien is reachable southeast of Berlin through moderate terrain. The northwest rectangle (Paris-Ruhr-Holland-Berlin) costs ~15-20M to interconnect; extending to Wien adds another ~15-20M. Track built here serves dozens of future deliveries because most demand cards route through central Europe.

PERIPHERAL REGIONS (expensive, low early reuse):
- London/Britain: Requires English Channel ferry (8M+). Island track only serves British deliveries.
- Madrid/Spain: Mountain and Alpine terrain through the Pyrenees. 20-30M to connect from Paris. Isolated — track only serves Iberian deliveries.
- Scandinavia (Oslo, Stockholm): Requires ferry from Denmark. 15-25M to connect. Very few loads originate here.
- Italy south of Milano: Alpine passes from Wien or France cost 5M/segment. Milano itself is reachable but Roma/Napoli are deep extensions.
- Ireland (Dublin, Belfast): Requires TWO ferry crossings — Channel ferry (continent→Britain) then Irish Sea ferry (Britain→Ireland). Each ferry burns a full turn of movement. Almost never worth it before mid-game.

EXPANSION PHILOSOPHY:
- Early game (under 80M cash, under 4 major cities connected): Stay in the core. Build the Paris-Ruhr-Holland-Berlin-Wien rectangle. Make fast, cheap deliveries to accumulate capital. A 17M delivery in the core completed in 4 turns is far better than a 42M delivery to Oslo that takes 12 turns and costs 30M in track.
- Mid game (80-180M cash, 4-5 major cities connected): Expand to ONE peripheral region when you have (a) 80M+ cash, (b) 2+ demand cards pointing to that region, and (c) the track would connect a major city you still need for victory. Don't expand to two peripheral regions simultaneously.
- Late game (180M+ cash, 5-6 major cities connected): You need 7 of 8 major cities connected. Plan your remaining expansions around which 1 city you can skip (usually Madrid or London, whichever is most expensive to reach from your network).

CAPITAL VELOCITY:
A 9M delivery completed on turn 4 generates capital that funds the NEXT delivery, which funds the next. A 42M delivery that takes until turn 12 means 8 turns of zero income. Always ask: "How many turns until I get PAID?" not "Which demand pays the most?"

WHEN TO BREAK THESE GUIDELINES:
- A peripheral demand is your ONLY affordable option (all core demands need track you can't afford)
- You already have partial track toward a peripheral region from a previous route
- A corridor of 2-3 demands all point to the same peripheral region, making the total payout justify the investment
- You're in late game and MUST connect London or Madrid for victory
```

## Draft: HAND EVALUATION Section

```
HAND EVALUATION — THINK IN CARDS, NOT DEMANDS:
You hold 3 demand cards with 3 demands each (9 total), but only 1 demand per card can ever be fulfilled. When you deliver a load, that card is discarded and replaced. This changes everything about how you evaluate your options.

EVALUATE EACH CARD'S BEST OPTION:
For each of your 3 cards, identify the single best demand — the one that's cheapest to reach, fits within your budget, and ideally stays in the core network. Ignore the other 2 demands on that card. Your real choice is between 3 options (one per card), not 9.

Example: If Card A's best demand is Steel→Paris (9M, core), Card B's best is Wheat→Ruhr (13M, core), and Card C's best is Iron→Praha (17M, near-core) — that's a strong hand. But if Card A's only affordable demand is Machinery→Dublin (25M, double ferry) and Card B's only affordable demand is Tourists→Sevilla (48M, deep Spain) — those cards are dead weight.

WHEN TO DISCARD YOUR ENTIRE HAND:
Discarding costs a full turn but gives you 3 fresh cards. Consider it when:
- 2 or more cards have NO affordable demand in or near the core network
- Your best available demand requires 25M+ in track building with cash under 40M
- All demands point to peripheral regions you have no track toward
- You've just completed a delivery and the new hand is terrible
A bad hand played stubbornly wastes 5-10 turns. A discard wastes 1 turn. Compare that 1 lost turn against the estimated turns shown for your best available demand — if your best option takes 8+ turns to complete, discarding is almost certainly better.

SECONDARY DELIVERY — FILL YOUR CARGO SLOTS:
Your train carries 2 loads (Freight/Fast Freight) or 3 loads (Heavy Freight/Superfreight). Picking up and carrying loads is FREE — no movement cost, no money cost. Dropping a load at any city is also free.

After choosing your primary delivery (Card X), ALWAYS look for a secondary pickup from a DIFFERENT card (Card Y or Z). The primary card gets discarded on delivery, so the secondary must come from a card that stays in your hand.

Look for secondary pickups that are:
- On or very near the primary route (zero or minimal detour)
- From a supply city you'll pass through anyway
- For a demand you can deliver after the primary, or carry until a future route
Even if you can't deliver the secondary load immediately, carrying it costs nothing. You can deliver it later or drop it at any city. An empty cargo slot is a wasted opportunity.

Pick up a load with no matching demand card if it's at a remote city you're already passing through AND your train has a free slot. Eg you are in Porto so pickup an extra fish load! Oranges in Sevilla! Tobacco in Napoli. Oil in Aberdeen.
```

## Draft: TRAIN UPGRADE STRATEGY Section

```
TRAIN UPGRADE STRATEGY:
Upgrading costs 20M and takes your entire build phase (no track building that turn). There are two upgrade paths from the starting Freight train:

UPGRADE OPTIONS:
- Freight (9 speed, 2 cargo) → Fast Freight (12 speed, 2 cargo) — 20M
  Best when: Your routes are long. Fast Freight's +3 speed means any route over 15 mileposts takes 1 fewer turn. Over 5 deliveries that's 5 extra turns of income.
- Freight (9 speed, 2 cargo) → Heavy Freight (9 speed, 3 cargo) — 20M
  Best when: You have corridor routes where you can carry 3 loads simultaneously. The extra slot means delivering 3 loads per route instead of 2.
- Either → Superfreight (12 speed, 3 cargo) — another 20M
  The endgame train. 12 speed + 3 cargo is dominant. Plan to reach Superfreight by mid-game.

WHEN TO UPGRADE:
- DON'T upgrade before your first delivery. You need cash flow first.
- DON'T upgrade when you have less than 30M — you'll be unable to build track afterward.
- DO upgrade when you have 60M+ cash and your current routes involve long travel distances (Fast Freight) or you consistently have 3 viable pickups (Heavy Freight).
- DO upgrade when spending 20M on track this turn wouldn't meaningfully advance your route — upgrading might be better value.
- The upgrade pays for itself quickly: Fast Freight saves 1 turn on any route over 15 mileposts; Heavy Freight earns an extra delivery payout per route when corridors are available.

CROSSGRADE:
You can switch between Fast Freight and Heavy Freight for only 5M (and still build up to 15M of track that turn). Consider this when your strategy shifts from long routes to corridor routes or vice versa.
```

## What Gets Removed

### SECONDARY BUILD TARGET section (lines 128-135)

The entire section and `secondaryBuildTarget` field from the response format. This drove Bug 1 — the bot spending 5M to connect Ruhr for "victory progress" with no demand cards supporting it.

Remove from system prompt:
```
SECONDARY BUILD TARGET:
After your route stops are connected, where should the bot build next? ...
```

Remove from response format:
```
"secondaryBuildTarget": {
    "city": "...",
    "reasoning": "..."
}
```

Remove from the example too.

### INITIAL BUILD STRATEGY section (lines 115-126)

Folded into the new GEOGRAPHIC STRATEGY. The 6 criteria (supply near major city, delivery near major city, low build cost, no ferry, central position, shared delivery areas) are captured by the core network and capital velocity concepts.

## What Stays

- `ROUTE PLANNING CRITERIA` (rules 1-11) — these are mechanical, not strategic
- `RESPONSE FORMAT` — same structure minus the `secondaryBuildTarget` field
- Skill level modifiers — unchanged

## The 8 Major Cities

For reference, the map's major cities and their geographic classification:

**Core (cheap to interconnect):**
- Paris, Ruhr, Holland, Berlin — the northwest rectangle, mostly clear terrain
- Wien — southeast extension through moderate terrain

**Peripheral (expensive to reach from core):**
- Milano — Alpine passes from Wien or through Switzerland
- London — English Channel ferry
- Madrid — Pyrenees mountains from France

## Implementation

### System Prompt Changes (`systemPrompts.ts`)

1. Replace `INITIAL BUILD STRATEGY` and `SECONDARY BUILD TARGET` sections with three new sections:
   - `GEOGRAPHIC STRATEGY` — core network, peripheral regions, expansion philosophy, capital velocity
   - `HAND EVALUATION` — per-card best option, when to discard, secondary delivery / cargo slot filling
   - `TRAIN UPGRADE STRATEGY` — upgrade paths, timing, crossgrade option
2. Remove `secondaryBuildTarget` from route planning response format and example
3. Add secondary pickup guidance to route planning response format (route should include secondary PICKUP stops from different cards)

### Code Changes

4. Remove `secondaryBuildTarget` handling from `ResponseParser.parseStrategicRoute()`
5. Remove secondary build target logic from `PlanExecutor` (lines 128-146)
6. Update `TurnComposer.tryAppendBuild()` secondary target fallback (line 379-382)

### Context Builder Changes

7. In `serializeRoutePlanningPrompt()`, group demands by card and label the per-card best option — so the LLM sees the card structure, not a flat list of 9 demands
8. Add a "HAND QUALITY" summary line: e.g. "Card 1: best=Sheep→Paris 19M (core). Card 2: best=Wheat→Ruhr 13M (core). Card 3: best=Machinery→Dublin 25M (peripheral, ferry). Hand quality: 2/3 cards playable in core."

## Relationship to Other Tickets

- **JIRA-14 Bug 1**: Fixed by removing secondary build target
- **JIRA-14 Bug 7**: Partially addressed — the LLM now has geographic context to make better route choices. Combined with JIRA-15 (city card counting) and demand ranking enhancements, the LLM has the information it needs.
- **JIRA-15**: City Value Index provides the quantitative data; this ticket provides the qualitative strategic framework. They complement each other.
