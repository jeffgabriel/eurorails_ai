# JIRA-179: LLM + Dijkstra collaborative track builder

## How it works today

1. **LLM** picks a list of waypoints for a pre-computed target city.
2. **Dijkstra (`computeBuildSegments`)** draws the track, one leg per waypoint pair: frontier → wp1 → wp2 → … → target.

The LLM doesn't just suggest — it *constrains* Dijkstra. When a waypoint sits off the cheap line, Dijkstra has to bend toward it, producing the one- or two-milepost spurs we see. Dijkstra never gets to show what it would have drawn without that constraint.

Two failure modes matter:
- **LLM-guided (today)**: bad waypoint → spur.
- **Dijkstra-unconstrained (the old planner we retired)**: cheapest-first tunnel vision → redundant network → bankruptcy.

Neither is safe alone.

## The change — three candidates, one rule

Every build turn produces three candidate paths:

1. **LLM-guided.** As today.
2. **Dijkstra-direct.** Same target, same budget, same opponent-track rules — but with the LLM waypoints dropped entirely.
3. **Merged.** Keep only the LLM waypoints that land on a named city (a ferry port counts). Drop the unnamed-coordinate waypoints. Re-run Dijkstra through the kept anchors. Preserves *where to go*, lets Dijkstra pick *how to get there*.

Then one selection rule, applied in order:

1. **Drop any candidate that doesn't reach the target.** If none reach, build the one whose endpoint is closest to the target (Dijkstra distance).
2. **Among reaching candidates, if all are within a cost ratio of each other (e.g. cheapest × 1.15):** pick the one that hits the most named-city anchors. Tiebreaker: cheapest.
3. **Otherwise:** pick the cheapest.

That's the whole resolver. No LLM defence call, no outcome enumeration — the cost+anchor rule handles the cases the 8-outcome table used to describe.

## Rollback

One config flag. Off = today's behavior exactly (no extra Dijkstra calls, no resolver). On = the three-candidate resolver runs and builds whatever it picks.

## Logging — what every build turn captures

A single structured log line per build turn with:

- `gameId`, `turn`, `playerId`, target city, budget.
- For each of the three candidates: total cost, segment count, reaches-target (bool), endpoint distance to target, named-city anchors hit, list of segments (compact form — start, end).
- `selected`: which candidate was built.
- `reason`: which rule branch fired (`only-reacher`, `ratio-band-anchor-winner`, `ratio-band-cost-tiebreak`, `cheapest`, `closest-to-target-fallback`).
- `costDelta`: cost of the selected candidate minus the cheapest reaching candidate (zero when cheapest won, positive when anchors won over cost).
- `anchorClassification`: per waypoint, `{coord, namedCity, kept}`.

With this we can answer: how often does each candidate win, how often does the merge actually help, is the ratio band right, are the anchors right, are we paying much to preserve anchors that don't matter.

## What does NOT change

- Target-city resolution (still the trip planner + build-target resolver).
- The solvency retry loop (runs on whichever candidate was selected).
- The post-build parallel-track / region-duplication guards (stay on the LLM-guided arm as a safety net during the experiment; revisit for removal once decision logs prove them unnecessary).
- The LLM's authority over strategy (it still owns the target, the soft constraints, and the anchor waypoints).

## Success measure

On the same game seeds, with the resolver live:

- Fewer mileposts per delivery.
- Lower bankruptcy rate.
- Logs show a healthy mix across rule branches — if one branch never fires, something upstream is wrong.
- Merged wins should be meaningful but not dominant (if Merged wins most turns, the LLM's waypoints are mostly noise; if it never wins, the anchor idea isn't earning its keep).

## Decisions (from review)

- **Anchor classification:** waypoint sits on a named city → high-signal (a ferry port also qualifies).
- **Similar-cost band:** ratio, not flat. Start at 1.15× the cheapest reaching candidate; tune from shadow-mode data.
- **No LLM defence call.** Second-guessing the LLM with another LLM call doesn't buy new information — the resolver trusts the LLM on intent and distrusts it on coordinates.
- **Merge failure fallback:** if the merged candidate doesn't reach the target, treat it the same as any other non-reacher — the closest-to-target tiebreaker handles it.
- **Scope:** one build turn at a time. No cross-turn resolver.
