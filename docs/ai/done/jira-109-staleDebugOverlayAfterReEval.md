JIRA-109: Debug Overlay Must Stay Current Throughout Turn Execution

Problem
- The debug overlay displays stale information during and after turn execution. Any game state change that occurs mid-turn (route re-evaluation, delivery, pickup, discard, upgrade) can leave the overlay showing outdated data.
- The overlay is the primary tool for debugging bot decision-making. If it doesn't reflect the current state, it's unreliable — developers can't tell whether a bug is in the bot logic or just stale display data.

Root Cause
- The debug overlay payload (planHorizon, route info, strategy text, etc.) is captured once — typically at the start of the turn or after the initial LLM call — and emitted via bot:turn-complete at the end.
- Turn execution is multi-step (movement, pickup, delivery, re-evaluation, build). Any step can mutate game state, but the overlay payload is never refreshed to reflect those mutations.
- This is a systemic issue, not limited to one field or one stage. Every mid-turn state change is a potential source of stale overlay data.

Known Examples
- Game 579b9389, player 6d720889 (Flash), t15: delivered Oil at Ruhr, re-evaluated to Flowers@Holland → Cork, but overlay still showed "Moving toward Ruhr" (old route's planHorizon).
- Same class of bug as JIRA-56 (stale demand ranking after discard) and JIRA-85 (stale demand ranking after non-delivery turns).

Fix
- The overlay payload must be rebuilt or incrementally updated after every state-mutating step during turn execution, not just captured once at the start.
- The bot:turn-complete event should always emit the final, current state — not a snapshot from before execution began.
- Consider emitting intermediate debug events during turn execution so the overlay can update in real-time as each step completes, rather than only at turn end.
