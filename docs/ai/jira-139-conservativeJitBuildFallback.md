# JIRA-139: Conservative JIT Build Fallback When LLM Advisor Fails

## Problem

When the LLM Build Advisor fails (timeout, parse error, waypoint validation failure), the current fallback in `TurnComposer.tryAppendBuild` (lines 983-1020) is aggressively erratic. It loops over **every** unreached route stop and calls `ActionResolver.resolve('BUILD', ...)` for each one, spending as much of the 20M build budget as possible per turn. This produces:

- **Speculative track**: builds toward stops the bot may never visit (route could change next turn)
- **Cash drain**: bots spend 20M/turn on track they don't need yet, leaving them unable to upgrade or recover from bad positions
- **Scattered networks**: track sprawls in multiple directions instead of forming a coherent path to the next delivery

Game logs show bots frequently going bankrupt or near-bankrupt after consecutive fallback turns where 20M is spent building toward 3-4 different cities simultaneously.

## Behavioral Change

Replace the aggressive multi-stop fallback with a **conservative just-in-time (JIT) heuristic**:

### Before (current behavior)
```
Advisor fails → loop over ALL unreached route stops → build toward each until budget exhausted
```

### After (new behavior)
```
Advisor fails → check track runway to FIRST unreached stop → only build if runway < 2 turns
```

### Decision logic

1. **No active route?** → Don't build. Fall through to victory/generic tiers.
2. **No unreached stops?** → Don't build. All stops are already on the network.
3. **Track runway >= 2 turns?** → Don't build. Bot has enough existing track to keep moving toward the delivery for at least 2 more turns. Save the 20M.
4. **Track runway < 2 turns?** → Build toward the **first** unreached stop only. Spend up to the remaining build budget on that single target.

### What "track runway" means

`calculateTrackRunway` (already exists at line 1332) does a BFS from the bot's position along existing track toward the destination city. It counts how many mileposts of connected track exist and divides by train speed. A runway of 2 means the bot can travel ~2 full turns before running out of track toward that destination.

### What stays the same

- **Victory build tier** (lines 1024-1053): When cash >= 250M and < 7 major cities connected, unconditional build toward unconnected major cities. Unchanged.
- **Generic major-city fallback** (lines 1072-1095): When cash > 230M and no route needs building, opportunistic build toward unconnected major cities. Unchanged.
- **LLM Build Advisor path**: When the advisor succeeds, its result is used as before. This change only affects the `advisorResult === null` fallback.

## Expected Impact

- **Fewer bankrupt bots**: Bots conserve cash when the advisor fails instead of spending 20M/turn on speculative track
- **More coherent networks**: When building does happen, it's toward a single target the bot actually needs next turn
- **Better recovery**: Bots with sufficient track runway skip building and save budget for when they actually need it
- **Reduced erratic behavior**: No more building in 3-4 directions simultaneously during advisor outages

## Trade-off

The JIT heuristic is deliberately conservative. A bot may occasionally waste a turn moving to the end of its existing track and then building, when it could have built proactively the turn before. This is acceptable because:

1. The advisor handles proactive building when it works — this is only the failure fallback
2. Wasting 1 turn of movement is far cheaper than wasting 20M on speculative track
3. The runway threshold of 2 turns provides a buffer — the bot starts building before it's completely stuck

## Files Changed

- `src/server/services/ai/TurnComposer.ts` — lines 983-1020 (pre-advisor fallback block)
