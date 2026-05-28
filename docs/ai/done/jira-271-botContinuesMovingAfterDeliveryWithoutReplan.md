# JIRA-271 — After a delivery completes the active route, the bot consumes the remaining movement budget on auto-pilot instead of stopping to replan

When a delivery completes the active route, the bot should stop at the delivery city, draw the new demand card the delivery triggered, replan against the fresh hand, and let the new plan decide what to do with any remaining budget. Today it just keeps moving.

## Source

`logs/game-c73cccf8-919e-462c-8250-28b2199665a4.ndjson`, player s1, T23. Same game as JIRA-269/JIRA-270.

## Trace

T23 actionTimeline:

| Step | Action | Path / Effect |
|------|--------|---------------|
| 0 | Move | (36,48) → (32,44) Stuttgart, 6 mileposts |
| 1 | Deliver | Labor @ Stuttgart, +$16, route completes |
| 2 | Move | (32,44) → (36,48), 6 mileposts — exact reverse of step 0 |

End-of-turn: `activeRoute = None`, `positionEnd = (36,48)`, budget 12/12 used. After the route completed at step 1, the bot consumed the remaining 6 mileposts retracing its inbound path without any plan dictating the destination.

## Expected behavior

When a delivery completes the active route, the bot stops moving, replans, and only THEN decides what to do with whatever movement budget remains. The new plan may legitimately direct the bot to move back the way it came — that's fine — but the move must come from the plan, not from auto-piloting remaining budget.

Related but distinct from JIRA-270: that fix made the post-delivery replan call happen. This bug is that even when the replan happens, the bot keeps moving in the same turn instead of letting the plan be the source of the next move.
