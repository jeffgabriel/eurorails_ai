# JIRA-122: Just-In-Time Track Building & Existing Ferry Reuse

_Analysis of game `fc8ecd8e-9025-4739-92f9-851ac8e7408c`. Despite JIRA-113 network building intelligence being implemented, bots still over-commit to massive builds and ignore existing ferry connections._

## Two Core Problems

### Problem 1: No Concept of "Just In Time" Track Building

The bot treats every route plan as a commitment to build all required track immediately. When the LLM plans a multi-stop route that requires 100+ segments of new track to a distant destination (e.g., Belfast), the bot starts building all of it right away — even though:

- **The bot might draw new demand cards** mid-route and re-evaluate to a better plan, abandoning the Belfast delivery entirely.
- **The delivery is many turns away** — the bot has to move there, deliver, and come back. Sinking 136M into speculative track to a remote city is catastrophic if the plan changes.
- **The track may never be reused** — Belfast and other remote small cities are dead-ends. Building 100+ segments to reach one is only justified if the delivery actually happens.

The bot should build track **incrementally** toward distant targets — enough to make progress each turn, but not so much that changing plans mid-route wastes massive capital.

### Problem 2: Bot Ignores Existing Ferry Connections When Building to Nearby Destinations

Flash already had a ferry connection to Ireland via **Dublin** (built T8-T13, Dublin_Liverpool ferry at 8M). When the bot later needed to reach Belfast (T69-T78), it built an entirely new overland route from continental Europe through France and England instead of:

1. Using the **existing Dublin track** to get to Ireland
2. Building the short connector from Dublin (24,10) to the Belfast_Stranraer ferry port or directly to Belfast (26,7) — roughly 3-4 segments

The existing Dublin connection makes Belfast reachable with minimal new track (~3-7M), but the bot spent **~136M building 100+ new segments** overland across 8 turns.

## The Evidence: Game `fc8ecd8e`, Flash Bot

### Flash's Belfast Build (T69-T78) — 136M Over 8 Turns

Flash's LLM at T69 planned: Wine→Belfast (33M), Wheat→Cardiff (22M), Cars→Holland. The bot then committed fully:

| Turn | Segs | Cost | Train Position | Build Target |
|------|------|------|---------------|-------------|
| T69 | 14 | 20M | (45,61) Beograd area | Belfast |
| T70 | 13 | 17M | (34,60) → Berlin | Belfast |
| T71 | 13 | 17M | Berlin → (22,42) | Belfast |
| T72 | 13 | 17M | (22,42) → (28,34) Paris area | Belfast |
| T73 | 13 | 17M | (28,34) → (38,38) south France | Belfast |
| T74 | 13 | 17M | (38,38) → (36,37) | Belfast |
| T75 | 13 | 17M | (36,37) → (32,35) | Belfast |
| T76 | 3 | 3M | (32,35) → (19,38) | Belfast |
| T77 | 1 | 4M | (19,38) → (17,29) near London | Belfast |
| T78 | 1 | 1M | (17,29) → (14,32) | Belfast |

**Total: ~100 segments, ~130M** to build overland to Belfast.

**What should have happened:** Flash had Dublin connected since T13. Dublin (24,10) is ~3 segments from Belfast (26,7). Even accounting for the Belfast_Stranraer ferry (4M cost), the total should have been **~7-10M** — not 130M.

The bot also moved its train from Beograd through Berlin, through Paris, through France, and up to Belfast over those same turns. The train was heading to Torino for a pickup while the build phase was extending track in a completely different direction.

### Flash's Cardiff Build (T45) — Missed London Connection

Flash planned at T45: "picking up high-value Copper from Wroclaw to deliver to Cardiff **via my existing London connection**" (the LLM's own words). But the actual build went from Wien area toward Berlin (9 segs, 13M), building from the continental side.

Flash had London connected since T8-T10. London (31,20) is ~6 segments from Cardiff (26,17). Building a short connector from London would have cost ~6-8M vs the 13M spent building from the wrong direction — and the London connector would have been reusable.

### Haiku's Sassnitz→Lyon Spur (T48-50) — 60M Dead End

Haiku's LLM planned Wood Stockholm→Lyon (28M payout). Haiku built southward from Stockholm through the Sassnitz ferry area:

| Turn | From | To | Segs | Cost | Direction |
|------|------|----|------|------|-----------|
| T48 | (3,60) Stockholm | (6,57) | 15 | 20M | South through Scandinavia |
| T49 | (6,57) | (15,52) | 15 | 20M | South past Sassnitz toward Berlin |
| T50 | (15,52) | (23,50) | 15 | 20M | South into Leipzig/Berlin area |

After spending 60M, Haiku was at (23,50) — near Leipzig/Berlin. **Lyon is at (34,39)** — still 20+ segments southwest. The build headed south-southeast when it should have gone south-southwest.

Haiku already had Paris connected (T37). Paris (32,29) is only ~10 segments from Lyon (34,39). Building a short connector from Paris would have cost ~12-15M total, not 60M from the wrong end of the network.

Then at T78-80, Haiku built **again** toward Lyon spending another 51M, likely duplicating parts of the corridor.

**Total Lyon investment: ~111M** for a 28M delivery payout.

### Haiku Duplicate Segments Near Szczecin/Leipzig

Haiku built through the Szczecin (53,21) / Leipzig (50,27) corridor multiple times:

- **T6**: 9 segs, 13M toward Szczecin — initial build from Wien corridor northward
- **T12**: 13 segs, 15M toward Beograd — builds through Berlin/Szczecin area
- **T20**: 10 segs, 18M toward Paris — cuts through central corridor near Leipzig
- **T28-29**: 8 segs toward Cardiff — through the same central area

The parallel path detection (JIRA-113) should catch corridors within 1-2 hexes, but these paths cross the same region at different angles rather than running strictly parallel, so the geometric heuristic misses them.

## Why JIRA-113 Isn't Preventing This

### Near-Miss Optimization Never Fired

The composition logs show **zero `nearMiss` entries** across the entire game. The `tryNearMissBuild()` in TurnComposer either isn't being called or its search depths are too shallow:

- **Ferry port search depth**: 4 segments — too shallow. Belfast is reachable from existing Dublin track, but Dublin→Belfast might be 4+ segments depending on the grid topology. More importantly, the bot needs to reason that "I have Dublin, Dublin gets me to Ireland, Belfast is in Ireland" — a 2-hop inference the current BFS doesn't make.
- **Spur search depth**: 3 segments — too shallow for ferry-adjacent opportunities.
- **Nearest network search depth**: 8 segments — adequate for direct connections but doesn't account for ferry shortcuts.

### Build Starts From Wrong Network Frontier

When `computeBuildSegments` runs multi-source Dijkstra from all track endpoints, it finds the cheapest path to the target. But "cheapest from the network" can still be catastrophically wrong when the **nearest useful frontier** is on the other side of a ferry crossing.

For Belfast: the Dijkstra starts from all endpoints and expands outward. The continental endpoints are geometrically closer to Belfast on the grid (ignoring water), so the pathfinder builds overland from Europe. It doesn't realize that Dublin — on the other side of a ferry — is actually 3 segments from Belfast.

For Lyon: the Dijkstra expands from the Stockholm/Sassnitz frontier because the bot is at Stockholm and just built from there. It doesn't realize Paris is 10 segments from Lyon vs 45+ from Stockholm.

### Composition-Appended Builds Skip Network Analysis

When builds are appended during TurnComposer's Phase B (after the primary MOVE plan), the build target comes from `PlanExecutor` or the route's next stop. The `NetworkBuildAnalyzer` checks in `ActionResolver.resolveBuild()` run on the build, but the nearest-network-point check may not consider ferry-connected parts of the network as "near."

## Implementation Plan

### Part 1: Just-In-Time Track Building

A human player doesn't build track toward a distant city the moment they plan a delivery. They wait until the delivery is certain and the train is about to run out of track. The key insight: **you can build 20M of track per turn but can only travel 12 mileposts max**. There's no reason to build track 5 turns before you need it — you're locking up capital on a plan that might change when you draw new demand cards.

The bot should **defer track building until the train will need it next turn**:

1. **Build-when-needed gate**: Don't build track toward a delivery destination unless the train is currently en route to that destination AND will exhaust existing track within 1-2 turns of movement. If the train is still 5+ turns of movement away on existing track, skip the build phase entirely — save the cash.

2. **Delivery certainty check**: Before committing to any new track construction, verify that:
   - The train is actively moving toward this delivery (not heading somewhere else)
   - No shorter alternative exists via existing network + ferry
   - The bot actually has the load on board or is within 1-2 turns of pickup

This prevents the Flash Belfast scenario: the bot planned a 5-stop route at T69 and immediately started pouring 17M/turn into Belfast track while the train was still at Beograd heading to Torino. By the time the train reaches Ireland (10+ turns later), the bot could have drawn completely different demand cards and pivoted. Instead, 130M was locked into a speculative build.

### Part 2: Existing Ferry Connection Reuse

Before building toward any destination, check if the existing network already reaches the destination's **landmass** via a ferry:

1. **Landmass connectivity check**: Determine which landmass the target city is on. Check if any existing ferry connection already bridges to that landmass. If yes, calculate the build cost from the ferry's far endpoint to the target vs. building overland.

2. **Ferry-aware nearest point**: When running the nearest-network-point BFS from a target city, treat ferry connections as zero-cost edges. This way, if existing track reaches Dublin and Dublin has a ferry to Liverpool, Belfast's "nearest network point" becomes the Dublin side of the ferry rather than continental Europe.

3. **Increase ferry search depth**: Bump from 4 to 8 segments, or make it dynamic based on the target's distance from the network.

### Part 3: Build-From-Nearest-To-Target

When `computeBuildSegments` starts Dijkstra from all endpoints, it should **weight starting points by proximity to the target**, not just by expansion cost:

1. **Target-biased source selection**: Instead of equal-weight multi-source Dijkstra, prefer starting from network points that are closer to the target. Paris should be the preferred start point for Lyon, not Stockholm.

2. **Two-phase build**: First, find the nearest network point to the target (BFS from target). Second, build from that network point toward the target. This ensures builds extend from the optimal frontier.

### Part 4: Strengthen Parallel Path Detection

The current detection looks for 3+ consecutive segments within 1-2 hexes. This misses:
- Paths that cross the same corridor at different angles
- Paths that pass through the same city but on different entry/exit mileposts

Add a **region-based** duplication check: divide the map into ~10x10 grid regions. If a proposed build passes through a region where the bot already has track density > N segments, flag it for review and check if the existing track can be leveraged instead.

## Files

- `src/server/services/ai/computeBuildSegments.ts` — Multi-source Dijkstra; needs target-biased source selection
- `src/server/services/ai/NetworkBuildAnalyzer.ts` — Ferry search depth, ferry-aware BFS, landmass connectivity
- `src/server/services/ai/TurnComposer.ts` — `tryNearMissBuild()` search depths; build-when-needed gate
- `src/server/services/ai/ActionResolver.ts` — Pre-build network analysis integration; delivery certainty check
- `src/server/services/ai/PlanExecutor.ts` — Defer build until train needs track
- `src/shared/services/TrackNetworkService.ts` — Ferry-aware adjacency graph
- `configuration/ferryPoints.json` — Ferry topology data

## Acceptance Criteria

- [ ] Bot defers track building until train will run out of existing track within 1-2 turns
- [ ] Bot does not build toward a destination while the train is still many turns of movement away on existing track
- [ ] Before building to a destination, bot checks if existing ferry connections already reach that landmass
- [ ] Ferry-aware nearest-network-point BFS treats ferry crossings as traversable edges
- [ ] Ferry search depth increased from 4 to 8+ segments
- [ ] Build starts from the network point nearest to the *target*, not nearest to the bot's current position
- [ ] Parallel/duplicate detection catches region-level corridor reuse, not just geometric parallelism
- [ ] Near-miss optimization actually triggers (currently zero activations in this game)
- [ ] All decisions are logged for observability

## Priority

HIGH — In game `fc8ecd8e`, Flash wasted ~120M building overland to Belfast when existing Dublin track made it a ~10M connection. Haiku wasted ~111M building toward Lyon from the wrong end of the network when Paris was 10 segments away. These are game-losing mistakes that JIRA-113's network analysis should prevent but doesn't due to shallow search depths and missing ferry-awareness.
