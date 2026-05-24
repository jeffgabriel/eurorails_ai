# JIRA-182: BuildRouteResolver strands the mainland network when the bot is on an island cluster

## What happened in game `189a6327`, Flash turn 60

Flash was mid-delivery (Hops @ Cardiff → Madrid) and spent the full 20M building a 13-segment greenfield spur from `(25,29)` south to `(38,24)` without reaching Madrid. Turn 62 built a disjoint 10-segment path from Bilbao `(42,21)` into Madrid for 15M. The T60 spur is ~20M of dead-end waste.

Resolver log for T60:

> `ruleBranch: "closest-to-target-fallback"`
> `reasonText: "No candidate reached target. Selected llmGuided with shortest endpoint distance (13)."`

Pre-T60, Flash already owned 101 segments including `(41,21)` Bilbao (7 hex from Madrid, built T16) and `(48,27)` south Spain (11 hex, built T47). These were the correct anchors — and exactly the anchors T62 used. The resolver at T60 saw none of them.

## Root cause: `filterConnectedSegments` is not ferry-aware

`ActionResolver.ts:258` filters the bot's existing segments to only those BFS-reachable from `snapshot.bot.position`. The BFS inside `filterConnectedSegments` (`ActionResolver.ts:1413–1509`) traverses direct segment edges plus **major-city red-area edges** — it does **not** traverse ferry ports.

At T60 the bot was at Cardiff `(17,26)`. BFS from Cardiff reaches only the 6-node UK cluster; the mainland (95 nodes including Bilbao, Lyon, Barcelona, Paris) is filtered out. `startPositions` from `getTrackFrontier` still lists every frontier, but without the mainland segments in `connectedSegments` there are no free-cost edges to ride — Dijkstra sees every mainland anchor as a zero-track island. No candidate reaches Madrid within budget, so the resolver falls through to `closest-to-target-fallback` (which is correct behavior for a genuine cold-start — wrong outcome here only because the filter lied about the cold start).

T62 works because the bot is at Paris, a major city; red-area adjacency expands BFS into the mainland spine and Bilbao becomes visible.

## The fix: ferry-aware connectivity in `filterConnectedSegments`

Extend the BFS adjacency in `ActionResolver.ts:1413–1509` to traverse the bot's own track across ferry ports:

- Identify ferry-port pairs from `gridPoints.json` / map topology.
- For each pair `(A, B)`, if the bot has segments touching both `A` and `B`, add an adjacency edge `A ↔ B`.
- If only one side has track, do not add the edge — the bot can't legitimately cross for free yet.

Applied to Flash T60: BFS from Cardiff now crosses the English Channel ferry into the mainland spine. Bilbao is visible; Dijkstra finds a reaching path for ~15M.

The rule is symmetric (works mainland→UK too) and generic — it iterates every ferry-port pair in the map topology, so Channel, Irish Sea, Scandinavian (Kobenhavn↔Malmo, Oslo↔Frederikshavn, …), Baltic (Stockholm↔Helsinki, Stockholm↔Turku), and Mediterranean crossings all benefit. Multi-hop chains (Ireland→UK→mainland) work automatically: each ferry adds its own `A↔B` edge and BFS chains them. The "track on both sides" gate correctly fails closed for mid-build states where only one landing is built — the far cluster isn't legitimately free-cost yet.

### Diagnostic additions

Extend `composition.buildResolver` log with:
- `connectedSegmentCount` pre- and post-filter
- `ferryCrossingsIncluded` (count)

So island-strand regressions are obvious in replay without reconstructing from segment geometry.

## Success measure

Replay game `189a6327` and verify:

- T60 resolver selects a reaching candidate (`ruleBranch` ≠ `closest-to-target-fallback`), anchored on mainland (row ≥ 40). No `(25,29)→(38,24)` segments built.
- Flash delivers Hops at Madrid by T61 or T62. Total T60→delivery build spend ≤ 20M (down from 35M).
- Flash T82 (Arhus), Nano T24–T27 (Aberdeen), Nano T38 (Goteborg) — all fallback-branch cases in this game share the island-strand shape and should resolve to reaching candidates once Fix 0 reveals their mainland anchors.

### Unit tests

- `filterConnectedSegments`: bot at Cardiff, track both sides of Channel ferry → mainland included.
- `filterConnectedSegments`: bot at Cardiff, track only on UK side → mainland excluded.
- `filterConnectedSegments`: bot at Paris (mainland), track both sides of Channel ferry → UK cluster included. (Reverse direction symmetry.)
- `filterConnectedSegments`: bot in Ireland, track on both sides of Irish Sea ferry AND both sides of Channel ferry → mainland cluster reachable via the two-ferry chain. (Multi-hop.)
- `filterConnectedSegments`: bot at Kobenhavn, track both sides of Kobenhavn↔Malmo → Swedish cluster included. (Non-Channel ferry.)
- Replay (T60 snapshot): resolver returns a reaching candidate from Bilbao, cost ≤ 20M.
- Replay (synthetic cold-start: UK track only, no mainland): resolver still fires `closest-to-target-fallback` — confirming the branch remains correct for genuine cold-start builds.

