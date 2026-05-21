# JIRA-180: Stop building duplicate track across disconnected clusters (build-advisor LLM edition)

## How a build turn actually works today

Every bot's build turn has the same three steps:

1. **The build advisor LLM** — each bot consults its own LLM (Flash uses Gemini Flash, Haiku uses Claude Haiku, Nano uses Gemini Nano). The LLM is given a corridor map, the bot's existing track, the active route, and the pre-computed target city. It returns an `action` plus a list of **waypoints** (coordinate pairs) that the built track must pass through.
2. **Dijkstra chains track through those waypoints.** `computeBuildSegments` is called once per leg: frontier → waypoint 1 → waypoint 2 → ... → target. Each leg builds the cheapest path between two points, constrained to respect own-track dedup and opponent-track ownership.
3. **Post-build guards** check for parallel-track and dense-region duplication, rerouting when triggered.

Before handing the bot's own track to Dijkstra, the system applies `filterConnectedSegments`: it keeps only the segments in the connected component that contains the bot's pawn. The filter exists for a real reason — without it, Dijkstra can start its search from the wrong endpoint of a disconnected stub and waste budget — but the same filtered list is also what Dijkstra uses to decide "which edges have I already built?"

## JIRA-179 is shipped but off

JIRA-179 added a three-candidate resolver (LLM-guided / Dijkstra-direct / Merged) behind `ENABLE_BUILD_RESOLVER`. In this game — `bca8a719-dc7b-4a4e-a486-6aafb2c7deb2` — the flag is off. Every build turn ran the pre-resolver pipeline above. When the flag is later turned on, the resolver calls the same `computeBuildSegments` three times per turn; it inherits the same filter behavior unchanged.

## What actually happened in game `bca8a719`

Flash built **17 duplicate edges** (26 extra-segment instances) across its final track. Haiku and Nano built **zero** duplicates. Same code paths, same LLM prompts, different models. The bug is Flash-specific.

Look at turns 91 and 92. Flash's pawn was on the **continental** cluster (Bern / Ruhr / Berlin region). Its existing track also included a separate **UK cluster** (Glasgow → Manchester → Birmingham → London). The two clusters were not joined by any track Flash owned.

Flash's LLM asked to build toward **Aberdeen** on both turns. It returned waypoints sitting right on top of the UK cluster — (4,30), (3,29), (2,28) on turn 91; (5,29), (4,29), (3,29), (2,29), (2,28) on turn 92. Those coordinates are Glasgow-adjacent; finishing them off to Aberdeen is a short build.

The bot, though, was on the continent. So:

1. The filter dropped the UK cluster from the existingSegments list handed to Dijkstra.
2. Dijkstra saw only continental endpoints as valid sources.
3. Dijkstra drew a new 16-segment, 20 M (budget-max) chain from the continental frontier, through the UK cluster's coordinates, toward the Aberdeen waypoints.
4. Because the dedup set didn't know the UK cluster's edges existed, several of those 16 segments landed directly on top of edges Flash already owned — 32 new segments of duplicate or near-duplicate track across two turns.

Haiku and Nano don't trip this because their own LLMs (in the observed games) keep waypoints inside the connected cluster the bot is standing in. The filter never hides anything relevant from Dijkstra for those bots.

## Why the LLM matters here

The bug is in the filter's data flow — but what pushes Flash over the edge is that Gemini Flash reliably chooses waypoints in a cluster its pawn isn't part of, and does so aggressively (multi-turn 20 M max-budget builds aimed at a distant region). Haiku and Nano behave more conservatively. Fix the filter's data flow and Flash becomes safe too; leave it alone and every LLM that tries to "start a new front" from a disconnected cluster will hit the same leak.

## The change

Split the filter's two jobs:

- **For Dijkstra's source selection** (where should the search begin?): keep using the connected-component filter. The legitimate purpose is unchanged.
- **For Dijkstra's dedup check** (what edges have I already built?): show Dijkstra **every** segment the bot owns, across all clusters, not just the filtered list.

Behaviorally: Dijkstra still starts from the cluster containing the bot's pawn, but it refuses to lay an edge that already exists **anywhere** on the bot's network. A bot with a single connected network sees no change (filtered and full lists are identical). A bot like Flash, with multi-cluster networks, stops paying twice for the same edge.

## What the bot does on a build turn after this ships

1. The LLM is consulted exactly as today and returns waypoints exactly as today.
2. Dijkstra still begins its search from the pawn-containing cluster.
3. Dijkstra's "already built" set now includes every edge in every cluster the bot owns.
4. If a candidate path crosses a milepost already owned in a detached cluster, the edge is treated as pre-owned and Dijkstra routes around it, or — if the waypoint itself lies on an already-built node — it passes through for free instead of rebuilding.
5. For Flash's Turn 91/92 Aberdeen corridor, this means the 16-segment builds shrink dramatically (the UK cluster absorbs most of the path) and no duplicate edges are laid.

## Relationship to JIRA-179

JIRA-179's resolver is currently flag-off in production games, so the immediate win comes from fixing the pre-resolver path. However, the resolver's three candidates (LLM-guided, Dijkstra-direct, Merged) all call `computeBuildSegments` with the same filtered segment set and inherit the same bug. This fix must thread the unfiltered set through the resolver's input struct and into all three candidates, so:

- **Flag off (today's path):** bug fixed at the call site in the build-track resolver.
- **Flag on (JIRA-179 experiment):** all three candidates see the full bot network for dedup; the cost comparison between candidates becomes honest (no candidate can look cheap by virtue of duplicating track the bot already owns).

## What does NOT change

- The connected-component filter stays. Its source-selection job is correct.
- The build advisor LLM prompt, its schema, and its waypoint output are untouched.
- Post-build guards (parallel-track, region-duplication) stay on during the JIRA-179 experiment — belt and suspenders while decision logs are gathered.
- Opponents' track blocking (Right of Way) is unchanged.
- Database persistence is unchanged — it remains a JSONB blob replace, which is why the fix must be upstream of save, not at the data layer.
- Single-cluster bots see zero behavior change.

## Success measure

Run the same game seeds that produced this issue and check:

- Flash's final track has zero duplicate edges (currently 17 duplicate edges / 26 instances in the cited game).
- Total mileposts laid by Flash across the game drops substantially (Flash was 212 vs Haiku 108 / Nano 125 in the cited game — expect Flash to land in the same ballpark as the others).
- Haiku's and Nano's final track is byte-identical to pre-fix (they never triggered the bug; regression-free).
- JIRA-179 decision logs (when the flag is flipped on) show no candidate winning because of a lower cost that includes a duplicate-edge segment.

## Open question (for review before implementation)

Should the fix be a new dedicated input to `computeBuildSegments` (one parameter per concern — filtered for sources, unfiltered for dedup), or should the existing mid-turn-continuation parameter be overloaded to carry the full network too? Recommendation: dedicated input. The continuation parameter already has a specific meaning (segments built earlier in the current turn) and overloading it couples two unrelated concerns. A named parameter makes the split between source-selection and dedup obvious at every call site.

## Status: Not implementing (2026-04-20)

- **Decision:** JIRA-180 will not be implemented.
- **Reason:** The bot is expected to maintain a single connected network of track at all times (players always build across ferry terminals and keep one contiguous network). Under that invariant, `filterConnectedSegments` returns the full network, so the filtered source-selection set and the dedup "already built" set are identical — the bug described in this ticket cannot trigger.
- **Ferry edge case:** Handled separately by JIRA-182 (ferry-aware BFS in `filterConnectedSegments`) which merges island clusters joined by an owned ferry pair into one component.
- **Remaining risk:** The "always connected" invariant could be violated by (a) initial build phase using budget across multiple unconnected major-city starts, (b) flood events erasing bridges, or (c) opportunistic major-city-start builds mid-game. If these become observed real-world problems, revisit this decision; the cleaner fix path is to enforce the invariant upstream in the build advisor / initial build planner rather than patching dedup downstream.
- **No code changes required.** The ticket remains as a design record.
