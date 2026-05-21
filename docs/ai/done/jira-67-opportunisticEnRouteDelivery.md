# JIRA-67: Bot Should Pursue Short-Haul Deliveries During Long Journeys

## Status: CLOSED — Duplicate of JIRA-64 Part 2

This feature is fully covered by **JIRA-64 Part 2 (Post-delivery LLM re-evaluation)**. See `docs/ai/jira-64-demandRankingStalAfterDelivery.md`, lines 54-68.

### Why This Is a Duplicate

The proposed "detour evaluation" is a less general version of JIRA-64's post-delivery LLM re-evaluation:

1. **`detectOnTheWay()`** (ContextBuilder:2282) already identifies demands near corridor cities at route planning time, surfacing them as `ON THE WAY` in the LLM prompt. The LLM can incorporate these when selecting a route.

2. The real gap is that **new demand cards drawn mid-route** (from a delivery) aren't re-evaluated — which is exactly what JIRA-64 Part 2 fixes. After each delivery, it refreshes `context.demands`, re-runs `ContextBuilder` (which calls `detectOnTheWay`), and re-invokes the LLM to **continue, amend, or abandon** the current route.

3. With JIRA-64 Part 2 implemented, the Flash example from game `be09cd45` would be handled naturally: after delivering at any stop, the LLM would see Cars Torino→Antwerpen as an on-the-way opportunity and could amend the route to include it.

### Evidence Preserved for JIRA-64

The game evidence below remains relevant to JIRA-64 testing:

- Game `be09cd45`, Flash, T20-T31: Flash committed to Warszawa→Roma (35M, 11+ turns) while holding Cars Torino→Antwerpen (12M, est 4 turns). Torino is near the route through Italy. Cars demand sat idle for 11+ turns instead of being picked up as a detour.
