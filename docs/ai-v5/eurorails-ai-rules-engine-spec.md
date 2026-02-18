# EuroRails AI Bot — Rules Engine Specification

**Strategy, Game Phases, and Archetype Design**
February 2026 | v1.1

---

## 1. Purpose and Scope

This document provides the complete specification for a rules engine that enables AI bots to play EuroRails Online. It is designed to be consumed by an AI coding agent building the implementation. The rules engine must accomplish three things:

- Make legal, strategically coherent decisions at every point in a game
- Produce visibly different play patterns across distinct archetypes
- Adapt its priorities as the game progresses through recognizable phases

The rules engine does NOT replace the game's existing validation and execution code. Bots use the same server-side functions as human players for all game actions. The rules engine is responsible only for ***deciding what to do***, not for executing the decision.

---

## 2. Core Game Rules Summary

The rules engine must internalize these constraints. Every decision the bot considers must be legal within these rules before it enters scoring.

### 2.1 Turn Structure

Each turn, a player may perform these actions in order:

- **Move train:** Along existing track, up to the train's speed limit in mileposts. During movement, the player may pick up loads at supply cities and deliver loads at demand cities.
- **Build track:** Extend the track network on the hex grid, up to 20M ECU per turn. Track is permanent and player-exclusive (others pay a 4M fee to traverse it).
- **OR Upgrade train:** Purchase a better engine for 20M. Mutually exclusive with track building, except crossgrades (5M, allows up to 15M additional building).
- **OR Discard hand:** Discard all 3 demand cards and draw 3 new ones. Ends the turn immediately. A mercy mechanism for terrible cards.
- **End turn:** Pass to the next player.

### 2.2 Demand Cards

Each player holds 3 demand cards at all times. Each card shows 3 possible deliveries (city/load/payment), but **only one demand per card can be fulfilled**. This means the bot evaluates up to 9 potential deliveries but can only complete 3 of them (one per card). When a demand is fulfilled, the card is replaced from the deck.

### 2.3 Terrain and Track Costs

| Terrain | Cost (M ECU) | Strategic Implication |
|---|---|---|
| Clear | 1 | Preferred corridor terrain |
| Mountain | 2 | Acceptable for trunk routes |
| Alpine | 5 | Avoid unless shortcut saves 3+ mileposts |
| Small/Medium City | 3 | Building through cities is expensive |
| Major City | 5 | Always worth it for victory condition |
| River crossing | +2 | Adds to base terrain cost |
| Lake/Ocean inlet | +3 | Adds to base terrain cost |
| Ferry | 4–16 (fixed) | Expensive; also costs movement (see 2.4) |

### 2.4 Trains

Players start with a Freight train (speed 9 mileposts/turn, capacity 2 loads). Upgrades:

| Train | Speed | Capacity | Cost |
|---|---|---|---|
| Freight (start) | 9 | 2 | — |
| Fast Freight | 12 | 2 | 20M (upgrade) |
| Heavy Freight | 9 | 3 | 20M (upgrade) |
| Superfreight | 12 | 3 | 20M (upgrade from FF or HF) |

**Ferry movement penalty:** When a train crosses a ferry, it loses all remaining movement for that turn and begins the next turn at half speed on the other side. This is a severe tempo cost and must be factored into route planning.

### 2.5 Victory Condition

A player wins by having **250M+ ECU cash AND a continuous line of track connecting seven major cities**. When a player declares victory, **play continues until the last player finishes their turn** (equal turns rule). If two or more players declare victory in the same turn, **the player with the most cash wins**. If still tied, the victory threshold raises to 300M and play continues with all tied players eligible.

Both conditions must be met simultaneously. A bot flush with cash but with a fragmented network cannot win. A bot with a continent-spanning network but only 200M cannot win. Only cash counts—money spent on building track does not count toward victory.

### 2.6 Train Movement Rules

- **Reversal restriction:** A train may only reverse direction at a **city** (major city mileposts, medium/small city mileposts, or ferry port mileposts). Mid-track reversal is not allowed during normal play.
- **Major city red area:** All players' tracks are connected across major cities by the red area (local rail system). Trains may travel across cities using the red area as their own track, including across rivers. Loads may be picked up or delivered at any major city milepost.
- **Load pickup/delivery during movement:** Picking up or unloading a load does **not** reduce movement. The player may continue moving at full allowance. Players may load, unload, and move in any order within their movement allowance.
- **Track usage fees:** A player pays nothing to run on their own track. To use an opponent's track, a player must pay **4M ECU per turn** to each opponent whose track is used. **A player cannot use an opponent's track unless they have enough cash to pay before moving onto it.**

### 2.7 Track Building Rules

- **Starting construction:** A player may start building track from any major city milepost OR any milepost already connected to the player's track.
- **Major city limit:** A player cannot build more than 2 track sections from a major city milepost in one turn. No track may be built within the red area of a major city.
- **Right of way:** Only one track section may be built between any two mileposts (one player owns each edge).
- **Small city limits:** Only 2 players may build track into a small city. No player may build more than 3 track sections to a small or medium city.
- **Medium city limits:** Only 3 players may build track into a medium city.
- **Ferry exclusivity:** Only 2 players may build to (and from) a single ferry line. The first player pays the full ferry cost; the other end can be built at no extra cost. Every player is guaranteed access to at least one English Channel ferry line.
- **No credit:** A player cannot build more track than they can immediately pay for. Unpaid track is immediately erased.

### 2.8 Load Availability

Loads are globally limited (3–4 copies per commodity type). If all copies are currently on trains, no one can pick up that load type. The rules engine must check global availability before planning a pickup. Load scarcity is also a competitive dimension: grabbing a scarce load denies it to opponents.

### 2.9 Load Dropping Rules

- A player may drop a load at any city without a payoff.
- If the load type is available in that city, it is returned to the tray (standard supply).
- If the load type is not normally available there, the load remains in that city as a temporary pickup.
- If there is already a temporary load at the city, the first load is returned to the tray and the newly dropped load remains.
- Only one demand per card can be fulfilled per delivery—dropping a load is not delivering it.

### 2.10 Event Cards

The deck contains 20 Event cards mixed with Demand cards. When drawn, Event cards take effect immediately, are shown to all players, and the drawing player continues drawing until they have 3 Demand cards. Most events remain in effect until the end of the drawing player's next turn, then are discarded.

Key event types for AI awareness:

| Event Type | Effect | AI Implication |
|---|---|---|
| **Derailment** | Trains within 3 mileposts of specified cities lose 1 turn and 1 load | Position awareness; avoid clustering near affected cities |
| **Strike** | Various: no pickup/delivery near coasts, or no movement on drawing player's track | May block planned deliveries; need contingency |
| **Snow/Weather** | Trains in affected area move at half rate; no movement/building on mountain/alpine mileposts | Route planning must account for weather-prone corridors |
| **Flood** | Bridges crossing affected river are erased; can be rebuilt after event ends | Track may need emergency rebuilding |
| **Excess Profit Tax** | All players pay tax based on event chart | Cash reserves may be reduced unexpectedly |

### 2.11 Selling and Trading Track

Instead of building track, a player may purchase track from another player for any mutually agreed price. Trades (track for track, no money) are also allowed. The selling player's colored lines are replaced with the buyer's color. Purchases may only occur during the purchasing player's turn.

### 2.12 Mercy Rules

For trapped or struggling players, the game provides recovery mechanisms:

- **Borrowing:** A player may borrow 1–20M ECU from the bank during their turn. Debt is incurred at **2× the borrowed amount** (borrow 10M → owe 20M). 100% of future delivery payoffs go toward debt repayment first. Debt affects victory: net worth (cash minus debt) must meet the victory threshold.
- **Backtracking:** A train may reverse direction at any milepost (not just cities), but it costs 1 full turn. The train may move in any direction on the next turn. Cannot backtrack if the player discarded Demand cards the same turn. Track usage fees still apply when backtracking on opponent track.
- **Restart:** A player may completely restart: discard all cards, return loco/loads/money, erase track, receive fresh Freight + 50M + 3 new cards, and build up to 20M on the restart turn.

---

## 3. Game Phase Model

A critical failure mode in naive bot design is treating every turn identically. EuroRails has distinct phases with different optimal strategies. The rules engine must recognize which phase it is in and adjust priorities accordingly. Making a "late game" decision in the opening (or vice versa) will produce bots that look stupid.

| Phase | Turns | Primary Goal | Key Constraint | Risk Tolerance |
|---|---|---|---|---|
| Initial Build | 1–2 | Establish starting network from a major city | No movement; build-only | Low—mistakes are permanent |
| Opening | 3–10 | First delivery + fund next actions | Starting cash 50M; speed 9 | Very low—cash is survival |
| Early Game | 11–25 | Build income engine; establish core routes | Limited network; Freight train | Moderate—invest in future payoff |
| Mid Game | 26–50 | Maximize delivery throughput | Upgrade timing; network gaps | Higher—take calculated risks |
| Late Game | 50+ | Close victory conditions | Major city connections | Variable—depends on position |
| Victory Push | Varies | Cross 250M + connect cities | Opponent awareness critical | High—sprint to the finish |

### 3.1 Initial Build Phase (Turns 1–2)

**What happens:** The game starts with 2 build-only turns. No train movement, no pickups, no deliveries. Players lay down their initial track network from a major city. Each player may spend up to 20M ECU per build turn. Turn order: first turn clockwise, second turn counter-clockwise (last player from turn 1 builds first in turn 2). The last player from the second build turn becomes the first player for the rest of the game.

#### Rules Engine Decisions

- **Starting city selection:** Choose the major city that is closest (in aggregate hex distance) to the supply and delivery cities on the bot's 3 demand cards. Weight nearby high-value demands more heavily. If two cities are close, prefer the one in central Europe (more future route options) over a peripheral location.
- **Track direction:** Build toward the supply city of the best available demand. "Best" in this phase means the demand that requires the least total track investment to complete a full pickup-and-deliver cycle. Do NOT build toward a delivery city that is far away—build toward a nearby supply city first.
- **Terrain avoidance:** With only 20M/turn, every ECU matters. Route through clear terrain (1M/milepost) wherever possible. Avoid alpine (5M) unless it saves 4+ mileposts of detour. Never plan a ferry crossing during initial build.

#### Anti-Pattern: The Aberdeen-to-Krakow Trap

Consider a bot that draws a high-value demand: Fish from Aberdeen to Krakow for 55M. A naive rules engine sees 55M and gets excited. But this delivery requires:

- Track from a starting major city to Aberdeen (Scotland, peripheral)
- A ferry crossing from Britain to continental Europe (8–16M + movement penalty)
- Track across nearly all of northern Europe to reach Krakow (Poland, far east)
- Total track investment: 60–80M+ across multiple turns

With only 50M starting cash and 20M/turn build limit, the bot would spend 4–5 turns building track, cross a ferry (losing a turn of movement), and arrive at Krakow having spent more on track than the delivery pays. Meanwhile, opponents are completing 2–3 deliveries.

**The rules engine must calculate a demand's ROI as: (payment − estimated track cost − ferry penalties) / turns to complete.** A 55M delivery that takes 6 turns and costs 65M in track is catastrophic. A 28M delivery that takes 2 turns and costs 10M in track is excellent.

However, a sophisticated bot (Trunk Sprinter at Hard skill) *might* take this delivery if it has a gameplan: build toward London as the backbone and plan to ferry later, using the early turns to complete a shorter delivery first while building track in the right direction. The key is that the bot must have a multi-turn plan, not just chase the highest payout number.

### 3.2 Opening Phase (Turns 3–10)

**What happens:** The active game begins. The bot places its train at its starting major city and can now move, pick up, and deliver. The critical goal is to complete the first delivery as quickly as possible to generate income.

#### Rules Engine Priorities

- **First delivery speed:** The single most important metric. Every turn without income is a turn falling behind. The rules engine should prioritize the demand that can be fulfilled with the least additional track building, even if it's a low-value demand.
- **Build budget discipline:** Starting cash is 50M. The bot has already spent some on initial build. The rules engine must track remaining cash and ensure the bot doesn't build itself into bankruptcy. Maintain at least 10M reserve for track usage fees and contingencies.
- **Network reusability:** When choosing between two equally fast first deliveries, prefer the one whose track will be useful for future deliveries. Track near the center of Europe serves more future demands than track on the periphery.
- **Don't upgrade yet:** At speed 9 with minimal track, upgrading (20M) is wasted money. The bot needs more network before speed matters.

#### Demand Evaluation Formula for Opening

Score = (Payout × 0.6) + (Inverse Track Cost × 0.3) + (Network Reuse Value × 0.1)

Where Inverse Track Cost = max(0, 1 − (estimatedTrackCost / payout)). A demand where track cost exceeds payout scores 0 on this dimension.

### 3.3 Early Game (Turns 11–25)

**What happens:** The bot has completed 1–3 deliveries and has a modest network. This is the "income engine" building phase where the bot's archetype starts to differentiate its play.

#### Rules Engine Priorities

- **Route efficiency:** Start optimizing income per milepost rather than just chasing the highest payout. A 30M delivery that reuses existing track is better than a 50M delivery requiring 30M of new construction.
- **Multi-delivery planning:** Begin evaluating pairs of demands that share overlapping routes. Picking up Wine in Bordeaux and Oranges in Valencia on the same trip (since they're close together and deliver in the same direction) is dramatically more efficient than two separate trips.
- **Upgrade consideration:** Around turns 15–20, evaluate the upgrade: if the bot has 8+ mileposts of track between its common pickup/delivery cities, a speed upgrade from 9 to 12 saves roughly 1 turn per delivery. At 2–3 deliveries per upgrade payoff period, the math often works.
- **Major city awareness:** Start noting which major cities the network is near. Don't force connections yet, but prefer track routes that pass near or through major cities when the cost difference is modest (< 5M extra).

### 3.4 Mid Game (Turns 26–50)

**What happens:** The bot has 80–150M, a substantial network, and likely an upgraded train. This is the throughput maximization phase.

#### Rules Engine Priorities

- **High-value deliveries:** With an established network, the bot can now consider longer-range, higher-value demands that would have been foolish early on. A 55M delivery across the continent is viable when most of the track already exists.
- **Opponent awareness:** At Hard skill, track what opponents are building toward. If two players are converging on the same supply city for a scarce load, the bot should either race for it or pivot to an alternative.
- **Track usage:** Consider using opponents' track (4M fee) instead of building parallel routes. If an opponent has track connecting Berlin to Warsaw, paying 4M to use it is far cheaper than building 10+ mileposts of parallel track.
- **Victory planning begins:** Count connected major cities. If the bot has 3–4, start routing new track through or near the remaining major cities, even if it adds 5–10M to a route that would otherwise be cheaper going around.

### 3.5 Late Game (Turns 50+)

**What happens:** The bot is approaching or has crossed 200M. Victory condition planning becomes the primary driver.

#### Rules Engine Priorities

- **Victory gap analysis:** Calculate exactly what's needed: how many more major cities must be connected, and how much more cash is needed. These two numbers drive all decisions.
- **Purposeful track building:** If the bot needs 2 more major cities connected, every track-building turn should extend toward an unconnected major city, even if no demand justifies it. Victory track is an investment, not an expense.
- **Cash sprint:** If the bot has all cities connected but needs more money, prioritize the highest-value deliverable demand regardless of efficiency. Speed of income matters more than income per milepost at this stage.
- **Discard hand:** If current demands are all low-value and the bot is close to 250M, discarding and drawing fresh cards is a valid strategic play—new cards might offer a 40–60M delivery that crosses the finish line.

### 3.6 Victory Push

**What happens:** The bot is within 1–2 turns of meeting both victory conditions. This is a distinct decision mode.

#### Rules Engine Priorities

- **Declare immediately:** The moment both conditions are met (250M+ cash AND 7 major cities connected), declare victory. Do not wait for a "better" position.
- **Opponent awareness (Hard skill):** If an opponent also appears close to victory, the bot must evaluate whether to race for the finish or attempt to delay the opponent (by grabbing scarce loads they need, or building track toward cities they need).
- **Risk acceptance:** Take aggressive plays that have even a 60% chance of closing the game. A failed delivery attempt costs one turn; losing the game because someone else declared victory first is permanent.

### 3.7 Phase Detection Logic

The rules engine should determine the current phase using these heuristics:

| Phase | Detection Criteria | Transition Trigger |
|---|---|---|
| Initial Build | `game.status === 'initialBuild'` | Game engine handles |
| Opening | Active phase AND completedDeliveries === 0 AND money < 80M | First delivery completed |
| Early Game | completedDeliveries >= 1 AND money < 100M AND connectedMajorCities < 3 | Money > 100M or 3+ majors |
| Mid Game | money >= 100M AND money < 200M AND connectedMajorCities < 6 | Money > 200M or 6+ majors |
| Late Game | money >= 200M OR connectedMajorCities >= 6 | Both conditions within reach |
| Victory Push | money >= 220M AND connectedMajorCities >= 6 (within 1–2 turns of both) | Victory declared |

**Note:** These thresholds are starting points and should be tuned through playtesting. The transition from "Opening" to "Early Game" is the most important—it signals when the bot can begin longer-term planning instead of pure survival mode.

---

## 4. Strategy Archetypes

Each archetype represents a fundamentally different approach to winning EuroRails. The archetype determines **what** the bot tries to do; the skill level determines **how well** it executes. A Hard Backbone Builder and a Hard Opportunist both play competently but produce completely different track networks and game trajectories.

The rules engine implements archetypes through **scoring multipliers** applied to a common set of evaluation dimensions. This means all archetypes use the same decision pipeline but weight factors differently, producing emergent behavioral differences without requiring archetype-specific code paths.

### 4.1 The Backbone Builder

**Philosophy:** "Build the highway first, then add the on-ramps."

#### Core Behavior

The Backbone Builder invests heavily in a central trunk line through high-traffic European corridors (e.g., Ruhr–Zurich–Milano, or Paris–Lyon–Marseille) before branching. It prefers a hub-and-spoke topology radiating from this backbone, avoiding isolated branches. Demands are evaluated primarily by their proximity to the planned backbone—a lower-value demand near the backbone is preferred over a higher-value demand that requires building in a new direction.

#### Phase Adaptations

- **Initial Build:** Spend both build rounds laying track along the planned backbone corridor. Accept slower first income in exchange for positional advantage.
- **Opening:** Complete the first delivery only if it's backbone-adjacent. Otherwise, continue building the backbone and accept 1–2 turns of zero income.
- **Early Game:** Backbone should be established. Begin adding spurs to supply/delivery cities. Upgrade the train early—a fast train on a long backbone maximizes throughput.
- **Mid/Late Game:** The backbone pays dividends now. Most demands will partially overlap with existing track. Focus on efficiency and ensuring major cities near the backbone are connected.

#### Weakness

Slow early income. If the initial demand cards don't align with any viable central corridor, the Backbone Builder struggles. The rules engine should detect this case (no high-value demands within 5 mileposts of any central corridor) and temporarily adopt Opportunist-like behavior until better cards appear.

#### Key Scoring Multipliers

- Backbone alignment: 2.0× (heavily rewards building along the planned corridor)
- Network expansion value: 1.5× (values track that serves multiple future deliveries)
- Immediate income: 0.8× (willing to sacrifice short-term income)
- Upgrade ROI: 1.2× (favors early upgrade on long backbone)

### 4.2 The Freight Optimizer

**Philosophy:** "Never move empty; every milepost should earn money."

#### Core Behavior

The Freight Optimizer maximizes income-per-milepost by "combining loads"—finding 2+ demands with overlapping pickup/delivery routes. It evaluates all 9 demands by pairwise combination potential, not individual payout. It prefers capacity upgrades (2→3 loads) over speed upgrades, because carrying 3 loads at speed 9 generates more income per trip than 2 loads at speed 12.

#### Phase Adaptations

- **Initial Build:** Build toward the densest cluster of supply cities from current demands. A cluster of 2–3 supply cities within 4 mileposts of each other is the ideal starting position.
- **Opening:** Look for any two demands with supply cities within 3–4 mileposts. If found, build to serve both. If not, take the single best demand but remain alert for combination opportunities with each new card draw.
- **Early Game:** Prioritize capacity upgrade (Heavy Freight) over speed. With 3 slots, triple-load trips become possible. Score all 9 demands in all possible pairs and triples.
- **Mid Game:** Peak efficiency phase. The Freight Optimizer should be consistently running multi-load trips. Its network may look messy but it's optimized for the specific routes it runs.
- **Late Game:** Weakness emerges: the organic network may not connect major cities efficiently. Must spend late-game turns building "victory track" that doesn't serve any delivery.

#### Key Scoring Multipliers

- Load combination score: 2.0× (the defining dimension)
- Income per milepost: 1.5× (efficiency is king)
- Multi-delivery potential: 1.5×
- Network expansion value: 0.7× (doesn't care about network topology)
- Victory progress: 0.6× (tends to neglect this until late game)

### 4.3 The Trunk Sprinter

**Philosophy:** "Speed kills—the fastest train on the shortest route wins every time."

#### Core Behavior

The Trunk Sprinter maximizes deliveries per unit time. It invests aggressively in train upgrades and builds direct routes even through expensive terrain. An alpine pass that costs 15M but shortens a route by 4 mileposts is a bargain if the bot will traverse that route 3+ times—the time savings across future trips outweigh the one-time construction cost.

#### Phase Adaptations

- **Initial Build:** Build the shortest possible route to a nearby supply city, even through mountains. Time is the resource being optimized, not money.
- **Opening:** Complete 1–2 quick deliveries to fund an early engine upgrade. The Trunk Sprinter may complete a 28M delivery just to get cash for the 20M upgrade.
- **Early Game:** Upgrade at the earliest possible moment. Will skip a delivery to afford a speed upgrade. Once upgraded, the extra 3 mileposts/turn compound over every future delivery.
- **Mid Game:** High delivery throughput. The Trunk Sprinter completes more deliveries per game than other archetypes but may earn less per delivery due to expensive track construction.
- **Late Game:** Strong position—speed means it can react quickly to good demands and build victory track rapidly.

#### Weakness

Overspends on track and upgrades. If early cards offer poor payouts, the Trunk Sprinter can run critically low on cash. The rules engine should enforce a minimum cash reserve (10M) to prevent bankruptcy spirals.

#### Key Scoring Multipliers

- Upgrade ROI: 1.8× (always looking for the upgrade moment)
- Immediate income: 0.9× (slightly income-focused to fund upgrades)
- Risk/event exposure: 0.7× (higher risk tolerance—speed compensates)
- Income per milepost: 0.8× (less concerned about efficiency than speed)

### 4.4 The Continental Connector

**Philosophy:** "Victory is about the network, not the next delivery."

#### Core Behavior

The Continental Connector always prioritizes the victory condition (major city connections). It systematically expands toward unconnected major cities, using deliveries to fund expansion rather than as a goal in themselves. It builds a sprawling network that reaches into every region, preferring a ring topology connecting major cities in a circuit.

#### Phase Adaptations

- **Initial Build:** Start building toward the nearest 2–3 major cities from turn 1. Even if no demand justifies it, the early track investment toward major cities pays off for victory.
- **Opening:** Take deliveries that align with the expansion path. A 25M delivery in the direction of an unconnected major city is preferred over a 40M delivery in the wrong direction.
- **Early/Mid Game:** Route all new track through or near major cities, even at extra cost. Building into a major city (5M) is always worthwhile for this archetype.
- **Late Game:** Often the first archetype to meet the city connection requirement. May need to focus on cash accumulation to cross the 250M threshold.

#### Weakness

Spreads thin. Income efficiency suffers from building track to cities that may not have immediate demand. May reach 7 major cities connected but have only 180M cash, requiring several more delivery turns to win.

#### Key Scoring Multipliers

- Victory progress: 2.0× (the defining dimension)
- Major city proximity: 2.0×
- Network expansion value: 1.5×
- Immediate income: 0.7× (income is a means, not a goal)
- Load combination score: 0.7× (doesn't optimize trips)

### 4.5 The Opportunist

**Philosophy:** "Play the cards you're dealt, not the cards you wish you had."

#### Core Behavior

Reactive and adaptive. The Opportunist re-evaluates ALL demands every turn, is willing to abandon partial plans for a better card, and exploits opponents: it races for scarce loads, uses others' track (paying the 4M fee), and times card draws optimally. It chases the highest immediate payout and pivots frequently.

#### Phase Adaptations

- **Initial Build:** Build toward the single best available delivery. Don't over-plan—the Opportunist expects to change direction as new cards are drawn.
- **Opening:** Take the single highest-value delivery immediately. Speed of first income matters most.
- **Early Game:** Re-evaluate every turn. If a new card offers a better opportunity, pivot. Track left behind is a sunk cost—don't chase it.
- **Mid Game:** Exploit opponents' track aggressively. If an opponent has track connecting two cities the Opportunist needs, pay the 4M fee instead of building parallel track. Also grab scarce loads that opponents need, even if the payout is modest—denying an opponent a 50M delivery by grabbing their load first is worth a 30M payout.
- **Late Game:** Weakness emerges: inconsistent network topology may make major city connections expensive. Must assess whether to invest in victory track or continue chasing cash and hope for favorable card draws.

#### Weakness

Inconsistent network topology. The Opportunist's track network looks organic and chaotic. Late-game major city connections may require expensive track that doesn't serve any delivery. Also vulnerable to card variance—if several consecutive draws offer only low-value demands, the Opportunist has no "plan" to fall back on.

#### Key Scoring Multipliers

- Immediate income: 1.3× (cash now, always)
- Competitor blocking: 1.3× (actively exploits opponents)
- Load scarcity: 1.5× (grabs scarce loads)
- Backbone alignment: 0.3× (doesn't care about network shape)
- Network expansion value: 0.5× (doesn't plan ahead)
- Victory progress: 0.7× (neglects this until forced)

### 4.6 The Blocker (Proposed Additional Archetype)

**Philosophy:** "If you can't be the fastest, make everyone else slower."

#### Core Behavior

The Blocker is a defensive/disruptive archetype not present in the original 5 archetypes but emergent from competitive play. It combines moderate income strategy with active interference. The Blocker observes opponent positions and upcoming demands, then takes actions that deny opponents their best plays: grabbing scarce loads, building track to block optimal routes (forcing opponents to use the Blocker's track at 4M/use or build expensive detours), and positioning near contested supply cities.

**Implementation note:** Blocking is currently modeled as a scoring dimension (Competitor blocking) that all archetypes access at different weights. A dedicated Blocker archetype would elevate this to the primary strategy. This is recommended as a Phase 2 addition after the initial 5 archetypes are tuned and functional.

#### Phase Adaptations

- **Initial Build:** Build from a central major city to maximize the number of opponents whose routes must cross or approach the Blocker's territory.
- **Opening:** Complete the first delivery normally—the Blocker needs income to fund blocking operations.
- **Early Game:** Begin observing opponent build directions. Build short track stubs toward contested chokepoints (mountain passes, ferry approaches, narrow corridors between water bodies).
- **Mid Game:** Peak blocking phase. Position at supply cities opponents need. Build track that forces opponents to pay 4M/turn fees. Grab scarce loads defensively.
- **Late Game:** Pivot to own victory conditions. The Blocker has been earning fee income and denying opponents momentum; now it must convert to its own win.

#### Key Scoring Multipliers (Proposed)

- Competitor blocking: 2.0× (the defining dimension)
- Load scarcity: 1.8× (deny opponents their pickups)
- Immediate income: 1.0× (maintains reasonable income)
- Track usage fee income: 1.5× (NEW dimension: values track that opponents will pay to use)
- Victory progress: 0.8× (slightly delayed victory push)
- Network expansion value: 1.2× (values broad coverage for blocking)

#### Blocker Detection of Opponent Intent

For the Blocker to work at Hard skill, the rules engine needs an opponent modeling subsystem:

- Track opponent track building direction (last 3 turns of segments built)
- Infer probable destination by projecting the build trajectory
- Track which loads opponents have picked up (visible information)
- Track which supply cities opponents are moving toward
- Score blocking actions by: (probability opponent wants this resource) × (value of denying it)

---

## 5. Scoring Engine Specification

Every bot turn, the rules engine generates a set of feasible options, scores them, and selects the highest-scoring option. This section specifies the scoring formula and its components.

### 5.1 Scoring Formula

**Score = Σ(base_weight × skill_modifier × archetype_multiplier × dimension_value)**

Where:

- **base_weight:** The fundamental importance of this dimension (set per skill level; see section 5.3)
- **skill_modifier:** How well the bot evaluates this dimension (1.0 for Hard, reduced for Medium/Easy)
- **archetype_multiplier:** How much this archetype cares about this dimension (see section 4 per archetype)
- **dimension_value:** The computed value of this dimension for this specific option (0.0–1.0 normalized)

### 5.2 Scoring Dimensions

Each feasible option is evaluated across these dimensions:

| Dimension | How to Compute | Phase Relevance |
|---|---|---|
| Immediate income | Payment amount if this option completes a delivery this turn. Normalized to 0–1 against the max possible payout across all options. | All phases; dominant in Opening |
| Income per milepost | (delivery payout) / (mileposts traveled to complete delivery). Higher = more efficient route. | Early–Mid; less relevant in Victory Push |
| Multi-delivery potential | Does this action (track building, positioning) set up future deliveries? Count how many of the 9 demands become cheaper/closer after this action. | Early–Mid Game |
| Network expansion | How many new mileposts become reachable? Does this connect previously isolated segments? Measured as new-reachable-mileposts / total-track-mileposts. | All phases except Victory Push |
| Victory progress | Does this connect or move toward an unconnected major city? +1.0 if it connects a new major, +0.5 if it reduces distance to nearest unconnected major by 50%+. | Increasing: Low early, dominant Late/Victory |
| Competitor blocking | Does this deny an opponent a scarce resource? Does this force opponents onto the bot's track (earning 4M fees)? Requires opponent modeling at Hard skill. | Mid–Late Game; Hard only |
| Risk/event exposure | Does this route pass through storm-prone regions? Does this delivery depend on a scarce load that might be taken? Lower risk = higher score. (Inverted dimension.) | All phases; higher weight early |
| Load scarcity | Is the target load scarce (2 or fewer copies remaining globally)? Picking up a scarce load has defensive value even if the delivery isn't optimal. | Mid–Late Game |
| Upgrade ROI | For UpgradeTrain options: (speed gain × avg mileposts per delivery × estimated remaining deliveries) / upgrade cost. Higher = upgrade pays for itself faster. | Early–Mid Game |

### 5.3 Skill Level Weight Profiles

Skill levels modify how many dimensions the bot considers and how well it evaluates them:

| Behavior | Easy | Medium | Hard |
|---|---|---|---|
| Planning horizon | Current turn only | 2–3 turns ahead | 5+ turns ahead |
| Dimensions evaluated | Top 3 only | Top 6 | All dimensions |
| Random selection chance | 20% of turns | 5% of turns | 0% |
| Misses best option | 30% of the time | 10% of the time | Never |
| Opponent awareness | None | Avoids contested loads | Active competition |
| Phase awareness | No phase adaptation | Basic phase detection | Full phase model |
| Card evaluation | Highest single payout | Route efficiency | All 9 demands holistically |

**Easy skill "random selection":** When triggered, the bot picks a random feasible option instead of the highest-scored one. This simulates the kind of suboptimal play a beginner human would make—not maliciously bad, just occasionally unfocused.

**Easy skill "misses best option":** When triggered, the rules engine excludes the top-scored option from consideration. The bot picks the second-best, simulating a human who doesn't quite see the optimal play. This is more realistic than pure random—bad human players still make "okay" moves, they just miss the great ones.

---

## 6. Decision Pipeline

Every bot turn flows through this pipeline. Each stage has a clear contract with the next.

### 6.1 Pipeline Stages

#### Stage 1: WorldSnapshot

Create an immutable, deep-frozen copy of all game state relevant to the bot's decision. This prevents race conditions during computation.

The snapshot must include: bot position (grid coords), bot's track network (as a graph), cash, demand cards (3 cards × 3 demands = 9 options), carried loads, train type/speed/capacity, all other players' positions and visible loads, global load availability (how many of each type remain), active events, map topology, and major city connection status for the bot.

#### Stage 2: Phase Detection

Using the WorldSnapshot, determine the current game phase (per section 3.7). The phase affects which scoring dimensions are active and their relative weights.

#### Stage 3: Option Generation

**Critical rule: Feasibility is checked DURING generation, not after.** An option that fails feasibility is never added to the candidate list. This was the root cause of previous implementation failures—generating infeasible options that then failed during execution.

Option types:

- **DeliverLoad:** Move to demand city, deliver a carried load. Feasibility: load on train matches demand, city reachable within speed limit on existing track, demand card not yet fulfilled.
- **PickupAndDeliver:** Move to supply city, pick up, then deliver in a future turn. Feasibility: load available globally, supply city reachable, train has capacity, demand exists on held cards.
- **BuildTrack:** Extend track toward a strategic destination. Feasibility: sufficient funds (20M max/turn), valid hex path, terrain costs calculated.
- **BuildTowardMajorCity:** Extend network toward an unconnected major city. Feasibility: same as BuildTrack plus the target must be an unconnected major city.
- **UpgradeTrain:** Purchase a better engine. Feasibility: sufficient funds, upgrade path is legal, not during initialBuild.
- **PassTurn:** Do nothing. Always feasible—serves as the ultimate fallback.

#### Stage 4: Scoring

Only feasible options reach this stage. Each option is scored using the formula from section 5.1. The current game phase modifies dimension weights (e.g., Victory progress weight increases in Late Game). The archetype multipliers are applied. The highest-scoring option is selected.

For Easy skill, apply randomization after scoring: 20% chance of random selection, 30% chance of excluding the top option.

#### Stage 5: Plan Validation

The selected option is decomposed into a sequence of atomic game actions (the TurnPlan). A final validation pass ensures the complete plan is still legal. This catches edge cases where individual options are feasible but the sequence creates conflicts (e.g., building track + upgrading in the same turn, which is illegal).

#### Stage 6: Execution

Execute the TurnPlan by calling the same server-side functions that process human player actions. If any step fails, attempt the next-best option (up to 3 retries). If all retries fail, execute PassTurn as the safe fallback. The turn must always complete—a stuck bot is the worst failure mode.

---

## 7. Demand Evaluation Deep Dive

Demand evaluation is the single most important capability of the rules engine. A bot that picks the right demands wins; a bot that picks wrong demands loses. This section provides concrete evaluation logic.

### 7.1 The Demand Evaluation Pipeline

For each of the bot's 9 demands (3 cards × 3 options per card), compute:

| Factor | Computation | Weight |
|---|---|---|
| Net Profit | payout − newTrackCost − (ferryCount × ferryMovementPenaltyValue) − (opponentTrackSegments × 4M) | 0.35 |
| Turns to Complete | (distToSupply / speed) + 1 (pickup) + (distSupplyToDelivery / speed). Add 1 turn per ferry crossing. Add ceil(newTrackCost / 20) build turns. | 0.25 |
| Income Velocity | Net Profit / Turns to Complete. The core efficiency metric. | 0.20 |
| Network Reuse | What % of the new track needed also serves other demands on hand? Count how many other demands have supply/delivery cities within 3 mileposts of the new track. | 0.10 |
| Load Availability | Is the load currently available? 1.0 if available, 0.5 if 1 copy left (risky), 0.0 if none available. | 0.10 |

### 7.2 Demand Red Flags

The rules engine should automatically deprioritize or reject demands with these characteristics:

- **Net negative ROI:** If estimated track cost exceeds payout, the demand is destroying value. Score as 0 unless the track investment serves other high-value demands.
- **Multi-ferry crossing:** Any delivery requiring 2+ ferry crossings costs 2+ turns of movement penalties. Reject unless payout exceeds 50M.
- **Peripheral → Peripheral:** Deliveries between two peripheral locations (e.g., Aberdeen to Athens) require track across the entire continent. Only viable in Late Game with an established network.
- **Dependency on scarce loads:** If only 1 copy of the load remains globally and an opponent is closer to the supply city, score this demand at 50% of normal.
- **Conflicts with current plan:** If the bot is mid-delivery (has loads on train), a new demand that requires traveling in the opposite direction should be scored lower unless its value dramatically exceeds the current plan.

### 7.3 Worked Example: Aberdeen Fish to Krakow

Let's evaluate the trap demand from the introduction in concrete terms:

- **Demand:** Fish from Aberdeen to Krakow, 55M payout
- **Starting position:** Berlin (major city), turn 5, 38M remaining cash
- **Existing track:** Berlin to Hamburg (8 mileposts)

**Track cost estimate:**

- Berlin → London area: ~15 mileposts through clear/mountain terrain = ~20M
- Ferry: Britain (London area to Edinburgh area): 0M if track exists, but movement penalty
- Edinburgh area → Aberdeen: ~5 mileposts = ~5M
- Ferry back to continent: 8–12M + movement penalty
- Continental route to Krakow: ~20 mileposts from a North Sea port = ~25M
- Total track: ~55–65M across 4–5 build turns

**Turns to complete:** 3 build turns (track) + 1 ferry crossing turn + 2–3 movement turns = 6–7 turns minimum

**Net Profit:** 55M (payout) − 60M (track) = −5M. This demand LOSES money on track alone.

**Income Velocity:** −5M / 7 turns = −0.7M/turn. Catastrophic.

Compare with a modest demand: Cheese from Bern to London, 28M. If the bot already has track near Bern: ~8M new track, 2 turns to complete. Net Profit: 20M. Income Velocity: 10M/turn. **The "boring" 28M demand is 14× more valuable per turn than the "exciting" 55M demand.**

---

## 8. Archetype × Phase Interaction Matrix

This matrix shows how each archetype's priorities shift across game phases. Each cell describes the dominant behavior for that archetype in that phase. The rules engine should use this to dynamically adjust scoring weights as the game progresses.

| Phase | Backbone Builder | Freight Optimizer | Trunk Sprinter | Continental Connector | Opportunist |
|---|---|---|---|---|---|
| Initial Build | Build backbone corridor | Build toward supply cluster | Shortest route to supply | Build toward nearest majors | Best single delivery path |
| Opening | Backbone > income | Find load pair | Quick delivery for upgrade $ | Deliver toward major cities | Highest immediate payout |
| Early Game | Add spurs; upgrade train | Capacity upgrade; combo loads | Upgrade ASAP; direct routes | Route through majors | Re-evaluate every turn |
| Mid Game | Harvest backbone | Triple-load trips | High throughput | Fill major city gaps | Exploit opponent track |
| Late Game | Connect remaining majors | Build victory track | Sprint for victory | Cash accumulation | Assess victory vs. cash |
| Victory Push | Declare when ready | Declare when ready | Declare immediately | Declare when cash allows | Race or block |

---

## 9. Anti-Patterns and Guardrails

The rules engine must include explicit guardrails against known bad behaviors. These are not just "nice to have"—previous bot implementations failed specifically because these situations were not handled.

### 9.1 Hard Rules (Never Violate)

- **Never go bankrupt:** Maintain a minimum cash reserve of 5M at all times. If an action would reduce cash below 5M, score it at 0. Exception: if the action completes a delivery that provides enough income to stay above 5M after the delivery payout.
- **Never build track with no plan:** Every track segment built must serve at least one identified demand or connect toward an unconnected major city. Random track expansion is forbidden.
- **Never hold loads indefinitely:** If the bot has been carrying a load for 5+ turns without delivering it, force-evaluate whether to deliver or drop it. Loads on the train consume capacity and may block better opportunities.
- **Never pass when delivery is possible:** If the bot can complete a delivery this turn (load on train, at delivery city), it must do so. There is no scenario where passing is better than collecting payment.
- **Always complete the turn:** If all scored options fail execution, fall back to PassTurn. A stuck bot is an unacceptable failure mode.

### 9.2 Soft Rules (Prefer Not to Violate)

- **Avoid building track you'll use once:** Track is permanent and expensive. If a delivery requires 30M of track that doesn't serve any other demand, consider whether the payout justifies the permanent investment.
- **Avoid ferry crossings before turn 15:** Ferry movement penalties are devastating in the early game when every turn of movement matters. Delay cross-water deliveries until the bot has an established network on both sides.
- **Avoid upgrading before 8+ mileposts of track:** A speed 12 train on 5 mileposts of track gains nothing. The upgrade ROI requires enough track to leverage the speed increase across multiple deliveries.
- **Avoid carrying 2 loads to the same city:** This wastes one capacity slot on a load that doesn't generate separate income. Exception: if both loads deliver to the same city from the same direction, it's fine.

### 9.3 Phase-Specific Traps

- **Opening:** Don't build a 40M track network before making any deliveries. Cash flow is survival in the first 10 turns.
- **Early Game:** Don't over-invest in a single direction. If all 3 demand cards point to the same region, the bot will need to pivot when new cards arrive. Maintain some network breadth.
- **Mid Game:** Don't ignore major city connections because income is flowing. The bot that reaches 250M but can't declare victory because it needs 2 more major cities has wasted 5–10 turns.
- **Late Game:** Don't penny-pinch on victory track. If connecting the last major city costs 25M, that's 25M well spent—it's the difference between winning and losing.

---

## 10. Implementation Guidance

This section provides concrete guidance for an AI agent implementing the rules engine.

### 10.1 Data Structures

#### ArchetypeProfile

A configuration object containing scoring multipliers for each dimension. One instance per archetype. Immutable after initialization.

Example structure:

```json
{
  "archetype": "backbone_builder",
  "multipliers": {
    "immediateIncome": 0.8,
    "incomePerMilepost": 1.0,
    "multiDeliveryPotential": 1.2,
    "networkExpansion": 1.5,
    "victoryProgress": 1.2,
    "competitorBlocking": 0.8,
    "riskExposure": 1.0,
    "loadScarcity": 0.7,
    "upgradeROI": 1.2,
    "backboneAlignment": 2.0,
    "loadCombinationScore": 0.8,
    "majorCityProximity": 1.0
  }
}
```

#### PhaseConfig

A configuration object that adjusts base weights per game phase. Applied as an additional multiplier on top of archetype multipliers.

Example: in the Opening phase, immediateIncome weight is boosted by 1.5× and victoryProgress is reduced to 0.2× (nearly irrelevant). In the Victory Push, victoryProgress is boosted to 2.0× and incomePerMilepost drops to 0.5×.

#### GamePhaseDetector

A stateless function that takes a WorldSnapshot and returns the current game phase. Uses the criteria from section 3.7. Must be deterministic—same snapshot always produces the same phase.

### 10.2 Integration Points

The rules engine integrates with the existing codebase at specific points:

- **WorldSnapshot:** Reads from the game database (players, player_tracks, games, demand_cards, load_chips tables). Must fetch atomically (within a transaction) to avoid inconsistent state.
- **Option Generation:** Uses shared pathfinding (TrackNetworkService.findPath), cost calculation (terrain costs from gridPoints.json), and validation (TrackBuildingService.addPlayerTrack for feasibility checking).
- **Execution:** Calls existing server functions: PlayerService.moveTrainForUser, PlayerService.deliverLoadForUser, PlayerService.pickupLoadForUser, TrackService.saveTrackState, PlayerService.purchaseTrainType. These are the SAME functions human actions flow through.

### 10.3 Testing Strategy

The rules engine should be testable in isolation from the game engine:

- **Unit tests:** Given a crafted WorldSnapshot + ArchetypeProfile, assert that the scorer produces the expected option ranking. Test each archetype against the same snapshot and verify different options are top-ranked.
- **Phase detection tests:** Given various WorldSnapshots with known game states, assert correct phase identification.
- **Integration tests:** Run a bot against itself (2 bots, no human) for 100 turns. Assert: zero game freezes, zero rule violations, money is always ≥ 0, track is always valid, every turn completes.
- **Archetype differentiation tests:** Run 5 games with 5 different Hard-skill archetypes, same initial conditions. Assert: track network topology differs visibly, upgrade timing differs, delivery patterns differ.

---

## 11. Complete Scoring Multiplier Reference

This table consolidates all archetype scoring multipliers for quick reference during implementation.

| Dimension | Backbone | Freight Opt | Trunk Sprint | Continental | Opportunist | Blocker* |
|---|---|---|---|---|---|---|
| Immediate income | 0.8 | 1.0 | 0.9 | 0.7 | 1.3 | 1.0 |
| Income/milepost | 1.0 | 1.5 | 0.8 | 0.8 | 1.2 | 0.9 |
| Multi-delivery | 1.2 | 1.5 | 0.8 | 1.0 | 0.6 | 0.8 |
| Network expansion | 1.5 | 0.7 | 1.0 | 1.5 | 0.5 | 1.2 |
| Victory progress | 1.2 | 0.6 | 0.8 | 2.0 | 0.7 | 0.8 |
| Competitor blocking | 0.8 | 0.8 | 0.5 | 0.5 | 1.3 | 2.0 |
| Risk exposure | 1.0 | 1.0 | 0.7 | 1.0 | 1.2 | 0.9 |
| Load scarcity | 0.7 | 1.2 | 0.8 | 0.5 | 1.5 | 1.8 |
| Upgrade ROI | 1.2 | 0.8 | 1.8 | 0.9 | 0.7 | 0.8 |
| Backbone alignment | 2.0 | 0.5 | 1.0 | 0.8 | 0.3 | 0.5 |
| Load combination | 0.8 | 2.0 | 0.6 | 0.7 | 1.0 | 0.7 |
| Major city proximity | 1.0 | 0.5 | 0.7 | 2.0 | 0.5 | 0.8 |
| Track usage fee income* | 0.5 | 0.5 | 0.3 | 0.5 | 0.8 | 1.5 |

*\* Blocker archetype and Track usage fee income dimension are proposed additions (Phase 2).*

---

## 12. Glossary

| Term | Definition |
|---|---|
| **Backbone** | A central trunk line through high-traffic European corridors; the primary rail artery in the Backbone Builder strategy |
| **Demand Card** | A card showing 3 possible deliveries (city/load/payment); only one per card can be fulfilled |
| **FeasibleOption** | A candidate action that has passed all validation checks and can be legally executed |
| **Ferry** | A fixed-cost sea crossing between coastal mileposts; costs money and penalizes movement |
| **Income Velocity** | Net profit divided by turns to complete; the core efficiency metric for demand evaluation |
| **Load Combining** | Finding 2+ demands with overlapping pickup/delivery routes for efficient multi-stop trips |
| **Major City** | A city marked with a large hexagon on the board; connecting 7 is required for victory |
| **Milepost** | A single hex on the game board; the unit of distance and track building |
| **Net Profit** | Delivery payout minus track costs, ferry penalties, and opponent track fees |
| **TurnPlan** | The selected sequence of actions for a bot's turn, ready for execution |
| **WorldSnapshot** | An immutable copy of all game state used for AI decision-making |
