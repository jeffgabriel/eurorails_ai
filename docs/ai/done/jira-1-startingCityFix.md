# JIRA-1: LLM-Driven Initial Build Strategy

## The Problem

The bot gets 2 build-only turns at the start of the game. No movement, no pickups — just laying track. With a 20M budget per turn (40M total), these turns determine where the bot's network begins and which delivery it can complete first.

Currently the bot **skips the LLM entirely** during these turns. A heuristic sorts all 9 demands by payout and builds toward the highest-paying city. The starting major city is chosen randomly by seeding Dijkstra from ALL major cities at once.

This produces bad results because high-payout demands are almost always long-distance, expensive routes that can't be built in 2 turns.

## What Makes a Good First Delivery

The first delivery isn't about maximizing payout — it's about **getting the engine running**. A quick, cheap delivery earns cash to fund bigger routes later. Four factors determine whether a demand is a good opening move:

### 1. Supply near a major city

Track building must start from a major city milepost. If the supply city IS a major city, you start right at the pickup point — zero track needed to reach the goods. If it's a nearby small city (like Frankfurt, 2 mileposts from Ruhr), you spend very little. If it's far from any major city (like Kaliningrad in the northeast corner), you burn most of your 40M budget just reaching the supply.

**Best supply locations** (at or next to a major city):
- Steel from **Ruhr** (major city — start here, pick up immediately)
- Flowers from **Holland** (major city)
- Cheese from **Holland** (major city)
- Tourists from **London** or **Ruhr** (major cities)
- Wine from **Wien** (major city)
- Chocolate from **Zurich** or **Bruxelles** (medium cities near Ruhr/Paris/Holland)
- Beer from **Munchen** or **Frankfurt** (medium/small cities in central Europe)

**Worst supply locations** (far from any major city):
- Tobacco from **Napoli** (southern Italy, far from Milano)
- Cork from **Lisboa** or **Sevilla** (Iberian peninsula edge)
- Hops from **Cardiff** (western Britain, behind a ferry)
- Potatoes from **Belfast** (Ireland, double ferry crossing)

### 2. Central Europe starting position

The 8 major cities are: Berlin, Holland, London, Madrid, Milano, Paris, Ruhr, Wien. Six of these cluster in central Europe (Ruhr, Paris, Holland, Berlin, Wien, Milano). Starting here puts you within reach of the most medium and small cities for future deliveries.

Starting in Madrid (southwest corner) or London (island, ferry-locked) limits your expansion options. You can reach fewer cities cheaply and need ferries to access the continent.

### 3. No ferry crossings

Ferry crossings are devastating in the early game. They cost extra money (8M for Dublin, 4M for Belfast, plus standard ferry costs) AND they burn time — you must stop at the ferry port for a full turn, then cross at half speed on the next turn. With only 2 build turns and 40M total budget, a ferry route is almost never worth it as a first delivery.

### 4. Short total route distance

Payout roughly scales with difficulty. A 6M demand usually means the supply and delivery cities are close together. A 63M demand means they're on opposite sides of the map. In the opening, you want the 6M demand — it can actually be completed with your limited budget and gives you cash flow.

## Example: How Card Hands Shape the Decision

### The bot is dealt these 3 cards (9 demands):

| Card | Demand a | Demand b | Demand c |
|------|----------|----------|----------|
| **22** | Steel -> Paris (6M) | Wheat -> Marseille (8M) | Cattle -> Bordeaux (7M) |
| **7** | Hops -> Ruhr (16M) | Tobacco -> Stockholm (63M) | Imports -> Porto (36M) |
| **38** | Sheep -> Paris (19M) | Tobacco -> Hamburg (35M) | Cork -> Oslo (73M) |

### What the heuristic does (wrong)

The heuristic sorts by payout and picks **Cork -> Oslo (73M)**. This is the worst possible choice:

- Cork sources: **Lisboa** and **Sevilla** — the Iberian peninsula, the far southwest corner of the map
- Oslo: Scandinavia, the far north
- That's nearly the full length of Europe. Estimated track cost: 60M+
- The bot can only spend 40M in the initial build phase — it can't even get halfway there
- It would need 3+ more build turns before the route connects, earning nothing the whole time

### What the LLM should choose (right)

**Steel -> Paris (6M)** from Card 22, starting at **Ruhr**:

- Steel source cities: Birmingham, Luxembourg, **Ruhr**. Ruhr is a major city — the bot starts here and can pick up Steel on its first movement turn with zero extra track to reach the supply.
- Paris is a major city ~8 mileposts southwest of Ruhr, through Bruxelles (medium city, costs 3M to build into).
- Estimated build cost: ~12-15M. Well within the 40M budget. Both build turns connect the route.
- On turn 3 (first movement turn), the bot picks up Steel at Ruhr, moves toward Paris, and delivers for 6M within 1-2 movement turns.

**Why this is better despite the low payout:**

1. **First delivery on turn 4-5** instead of turn 10+. The bot starts earning immediately.
2. **Central position**: Ruhr->Paris track also passes through (or near) Bruxelles and Holland — useful for many future demands.
3. **Budget surplus**: Only ~15M spent on track leaves 25M for turn 2 building. The bot can start extending toward the next delivery (e.g., Wheat -> Marseille from Lyon, building south from Paris).
4. **Unlocks a second quick delivery**: Card 22 is discarded and other payload can be considered

### What happens after the opening

After delivering Steel->Paris (6M), the bot has:
- Track from Ruhr through Bruxelles to Paris
- Cash: ~41M (50M starting - 15M track + 6M payout)
- Position: central Europe, connected to 2 major cities (Ruhr, Paris) and 1 medium city (Bruxelles)

Now Card 22 is discarded and replaced. But the bot also has:
- Card 38: Sheep -> Paris (19M). Sheep sources: Bilbao, Cork, Glasgow. Bilbao is in northern Spain — the bot could build south from Paris toward Bilbao, pick up Sheep, deliver right back to Paris. That's another 19M.
- Card 7: Hops -> Ruhr (16M). Hops source: Cardiff (Britain). Needs a ferry — skip for now.

The 6M opening delivery set up a cascade of quick follow-up deliveries from a central position. The 73M cork delivery to Oslo? That can wait until the bot has money and track reach.

## Second Example: When the Supply City Isn't a Major City

### Cards dealt:

| Card | Demand a | Demand b | Demand c |
|------|----------|----------|----------|
| **14** | Wine -> Paris (11M) | Copper -> Birmingham (29M) | Steel -> Venezia (19M) |
| **62** | Coal -> Paris (13M) | Fish -> Munchen (38M) | Flowers -> Kaliningrad (25M) |
| **43** | Marble -> London (31M) | Iron -> Munchen (26M) | Wine -> Szczecin (12M) |

The heuristic picks **Fish -> Munchen (38M)** or **Marble -> London (31M)**.

Fish sources: Aberdeen, Oslo, Porto — all on the periphery, far from Munchen. Marble source: Firenze — in Italy, south of the Alps. London is an island behind a ferry. Both are bad openers.

**Better choice: Wine -> Paris (11M)** from Card 14.

Wine sources: Bordeaux, **Frankfurt**, Porto, **Wien**. Frankfurt is a small city just 2 mileposts south of **Ruhr** (major city). Wien is itself a major city, but it's farther from Paris.

- Start at **Ruhr**
- Build turn 1: Ruhr -> Frankfurt (2 mileposts, ~3M). Now the bot can pick up Wine at Frankfurt.
- Build turn 2: Continue building southwest toward Paris (~10M more of track)
- Movement turns: Pick up Wine at Frankfurt, deliver to Paris for 11M

The bot could also pursue **Coal -> Paris (13M)** from Card 62 as a near-simultaneous delivery. Coal sources: Cardiff (ferry — skip), **Krakow**, **Wroclaw**. Krakow and Wroclaw are in eastern Poland, far from the Ruhr->Paris route. So Coal->Paris is better saved for later when the network extends east.

But notice: **both** Card 14 and Card 62 have demands delivering to Paris. After the Wine->Paris delivery, the bot is already AT Paris. Card 62's Coal->Paris could be the second delivery once eastward track is built. This kind of overlapping delivery city is exactly what the LLM should spot.

## The Decision Framework

When choosing the opening strategy, the LLM should evaluate each of the 9 demands across these criteria:

| Criterion | Why it matters | Example (good) | Example (bad) |
|-----------|---------------|----------------|---------------|
| Supply at/near major city | Can start building from it immediately | Steel from **Ruhr** | Tobacco from **Napoli** |
| Delivery at/near major city | Short route, useful track for future | -> **Paris** (major, central) | -> **Kaliningrad** (small, corner) |
| Low total build cost | Fits in 40M initial budget | Ruhr->Paris (~15M) | Lisboa->Oslo (~80M) |
| No ferry required | Ferries cost money + burn turns | All mainland Europe routes | Anything involving Britain/Ireland |
| Central position for growth | Track built now is useful later | Ruhr/Paris/Holland triangle | Madrid->Lisboa corridor |
| Other demands share the area | Enables quick second delivery | Two demands deliver to Paris | Demands scattered across 3 regions |

The LLM should prefer demands scoring well across multiple criteria, even if the payout is the lowest on the card. A 6M delivery completed on turn 4 is worth far more than a 73M delivery that takes until turn 15.

## Current Behavior vs Desired Behavior

### Current (heuristic, no LLM)
1. Sort all 9 demands by payout (descending)
2. Pick the highest-payout demand
3. Seed Dijkstra from ALL major cities — random starting point
4. Build toward the delivery city (ignoring that the supply city needs to be reachable too)

**Result**: Bot chases 73M Cork->Oslo, starts building from a random major city, runs out of budget, and spends 5+ turns unable to complete any delivery.

### Desired (LLM-driven)
1. LLM sees all 9 demands with source cities, delivery cities, build costs, and ferry flags
2. LLM picks a short, cheap demand with supply near a major city
3. LLM specifies a `startingCity` (e.g., "Ruhr") as part of the route plan
4. Build starts from that specific major city toward the supply/delivery
5. Route is saved — turn 2 continues building the same route without another LLM call

**Result**: Bot delivers Steel->Paris for 6M on turn 4-5, earns cash, and has a central European network to build on.

## Technical Approach

Wire `planRoute()` into the initial build phase instead of the heuristic. The existing `StrategicRoute` response already includes `startingCity`, and `ActionResolver.resolveBuild()` already handles build targets — it just needs to constrain its Dijkstra start positions to the chosen starting city instead of all major cities.

### Key changes
| Area | What changes |
|------|-------------|
| **ContextBuilder** | Enrich initial build prompt with supply city details, build cost estimates, and the decision criteria above |
| **AIStrategyEngine** | Turn 1: call `planRoute()` instead of heuristic; Turn 2: read saved route from memory, no LLM call |
| **ActionResolver** | When `startingCity` is specified and no track exists, seed Dijkstra from only that city's mileposts |
| **autoPlaceBot()** | Prefer placing the train at the route's `startingCity` when entering the movement phase |

### Fallback
If there's no LLM key or the LLM call fails, fall back to the existing heuristic (unchanged).

### Verification
1. All existing tests pass (`npm test`)
2. Manual: start a game with a bot, verify the initial build uses `planRoute()`, check that `startingCity` appears in build details, and confirm the train is placed at the chosen starting city
