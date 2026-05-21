# JIRA-23: Bot Builds Track Around Major Cities Instead of Through Them

Game: `b7bc501e-6c4a-491e-94f5-82fc5d76e8af`

---

## What Happened

The bot built track around London via water-adjacent mileposts (2-3M per segment) instead of building into London (5M entry) and using the free red-area traversal to exit the other side. This wastes money on multiple cheap segments when a single 5M entry would have been shorter and provided free connections to all of London's outposts.

The same problem applies to any major city the bot's route passes through — the pathfinder treats the city interior as a wall and routes around it.

## Rule Being Violated

Per EuroRails rules:
- All mileposts within a major city's red area are **connected for free** — they represent the local rail system
- A player only pays the **5M major city cost once** to build TO any outpost
- Once at any London milepost, the bot can reach **all other London mileposts at zero cost** — no track building needed inside
- Trains may travel across cities using the red area as their own track

This means entering London at one outpost for 5M effectively gives you **2+ free segments** through the interior. Building around London at 2-3M per water-adjacent segment costs more total and produces a longer, less useful route.

## Example from This Game

The bot's track network approached London from the east (Dover/Calais ferry corridor). When it needed to route through London toward Birmingham and Cardiff to the northwest, instead of entering London's red area and exiting out the northwest side, it built multiple segments around London's perimeter through water-adjacent and coastal mileposts.

The math:
- **Through London**: 5M to enter at one outpost → free traversal to any other outpost → exit northwest. Total: **5M, 1 segment**
- **Around London**: 2-3M per segment × several segments around the perimeter. Total: **more money, more segments, less useful track**

Going through London would also **connect London as a major city for victory** — which the bot needed anyway (it explicitly mentioned "securing London for victory" in turn 47 reasoning).

## What Should Happen

When the bot's route passes near or through a major city, the pathfinder should recognize that:

1. Entering a major city at any outpost (5M) gives free access to all other outposts
2. This makes the city interior a **shortcut**, not a barrier
3. Routes that pass through a major city should be preferred when they're cheaper than going around
4. Passing through also connects the city for victory — a significant strategic bonus

The pathfinder currently blocks all edges between mileposts within the same major city (`computeBuildSegments.ts:331-334`). This was intended to prevent building track inside the red area (which is correct — you can't own track there), but it also prevents the pathfinder from even considering the free traversal as a routing option.

## Bug 2: Movement Through Major Cities Costs Too Many Mileposts

### Rule

Per EuroRails rules:
- "The center milepost in a major city is treated as **a milepost** for movement."
- "To count mileposts from a major city, start counting from **the city center**, not the outer mileposts."

The entire red area (center + all outposts) represents **one hex on the physical board** — a single milepost. Moving between any outposts within the same city is free because you're still in the same hex. Entering the city from an adjacent hex = 1 milepost. Exiting to an adjacent hex = 1 milepost. Total to pass through = 2 mileposts (same as any other hex).

### What the code does

The digital board represents each major city as 7 grid points (1 center + 6 outposts). The movement pathfinder routes through these internal nodes and **charges 1 milepost per hop**:

- Path through London: `outside → outpost1 → center → outpost2 → outside`
- Code counts: 4 mileposts (4 edges, each = 1 milepost)
- Should be: 2 mileposts (enter city = 1, exit city = 1, internal hops = free)

This happens in multiple places:

1. **Server-side path length** (`ActionResolver.ts:276`): `pathLength = usage.path.length` counts every edge including internal city edges as 1 milepost
2. **Server-side movement budget** (`TurnComposer.ts:491`): `path.length - 1` counts every node in the path as a milepost used
3. **Client-side calculator** (`MovementCostCalculator.ts:320`): `city_internal` segments cost 1 instead of 0

### Consequence

The bot loses 1-2 mileposts per major city traversed per turn. Over a game that routes through London, Paris, Berlin, etc., this adds up to many wasted mileposts — effectively slowing the train below its rated speed and making deliveries take extra turns.

This also distorts the turn estimation in `ContextBuilder.ts` (JIRA-22) — routes through major cities appear to take more turns than they actually should, making the scoring even less accurate.

---

## Impact (both bugs combined)

- Bot wastes money building around major cities instead of through them
- Bot loses mileposts every time it passes through a major city
- Both bugs make deliveries take longer than they should
- Turn estimates are further distorted, compounding the scoring problem from JIRA-22
- Bot misses opportunities to connect major cities for victory as a side benefit
