# JIRA-2: Remove Archetypes — Manual Testing Guide

## Prerequisites

- `npm run build` compiles clean
- `npm test` passes all tests
- Local dev server running: `npm run dev`
- At least one LLM API key configured (Anthropic or OpenAI)

---

## 1. Lobby UI — Archetype Removal

### 1.1 Add Bot Dialog

1. Open the lobby, create or join a game
2. Click "Add Bot"
3. **Verify**: The "Play Style" dropdown is **gone**. Only "Skill Level" (Easy/Medium/Hard) and "Name" fields remain.
4. Select each skill level and add a bot
5. **Verify**: Bot is added successfully with no errors in the browser console

**Pass criteria**: No archetype selector visible. Bot creation works with just skill level + name.

### 1.2 Game Row — Bot Display

1. Add a bot to the lobby
2. Look at the game row where the bot appears
3. **Verify**: No archetype badge (colored pill like "Aggressive", "Balanced", etc.) appears next to the bot name
4. **Verify**: Skill level badge still displays correctly (Easy/Medium/Hard)

**Pass criteria**: Bot row shows name + skill level only. No archetype badge.

### 1.3 Strategy Inspector Modal

1. Start a game with a bot
2. After the bot takes at least one turn, open the Strategy Inspector (click the bot's turn audit)
3. **Verify**: No "Archetype" badge at the top of the modal
4. **Verify**: No "Philosophy" text block (e.g., "This bot prioritizes fast deliveries...")
5. **Verify**: Strategy details, action list, and build info still display correctly

**Pass criteria**: Inspector shows strategy without archetype philosophy section.

---

## 2. Bot Behavior — Prompt Correctness

### 2.1 Bot Takes Turns Successfully

1. Create a game with 1 human + 1 bot (any skill level)
2. Complete your first turn
3. **Verify**: Bot takes its 2 initial build turns without errors
4. **Verify**: Bot takes subsequent movement/delivery turns
5. Check server logs for any errors related to `archetype`, `getSystemPrompt`, or `undefined`

**Pass criteria**: Bot plays through at least 5 turns without crashing or passing every turn.

### 2.2 Skill Levels Produce Different Behavior

1. Start 3 separate games, each with a bot at a different skill level (Easy, Medium, Hard)
2. Let each bot play 3-5 turns
3. Check the Strategy Inspector for each
4. **Verify**: Easy bot's strategy audit shows simpler reasoning
5. **Verify**: Hard bot's strategy audit shows more complex multi-turn planning
6. **Verify**: The system prompt in logs does NOT contain any archetype personality text (no "chase the highest immediate payout", no "build safe networks", etc.)

**Pass criteria**: Skill level differentiation works. No archetype personality fragments in prompts.

### 2.3 Route Planning Works

1. Start a game with a Hard bot
2. After initial build turns, check strategy inspector
3. **Verify**: Bot produces a `StrategicRoute` with `startingCity`, `targetDemand`, and `buildSegments`
4. **Verify**: The route plan does not reference any archetype-specific reasoning

**Pass criteria**: `planRoute()` call succeeds. Route plan is based on game state analysis, not personality.

---

## 3. Edge Cases

### 3.1 Existing Games with Archetype Data

If the database has games where bots were created with archetype data in `bot_config` JSONB:

1. Load an existing game that has a bot with `archetype` in its `bot_config`
2. **Verify**: The game loads without errors
3. **Verify**: The bot continues playing (the stale `archetype` field in JSONB is ignored)
4. **Verify**: No "unknown archetype" or "invalid archetype" errors in server logs

**Pass criteria**: Old games with archetype data still work. Stale JSONB field is harmless.

### 3.2 API Backward Compatibility

1. Using curl or Postman, send a `POST /api/lobby/:lobbyId/bot` request **with** an `archetype` field in the body:
   ```bash
   curl -X POST http://localhost:3000/api/lobby/<lobbyId>/bot \
     -H "Content-Type: application/json" \
     -d '{"skillLevel": "medium", "archetype": "balanced", "name": "TestBot"}'
   ```
2. **Verify**: Request succeeds (200). The `archetype` field is silently ignored.
3. Send the same request **without** `archetype`:
   ```bash
   curl -X POST http://localhost:3000/api/lobby/<lobbyId>/bot \
     -H "Content-Type: application/json" \
     -d '{"skillLevel": "medium", "name": "TestBot"}'
   ```
4. **Verify**: Request succeeds (200).

**Pass criteria**: API accepts both old (with archetype) and new (without) request formats.

### 3.3 LLM Failure Fallback

1. Start a game with a bot but with an invalid/missing LLM API key (or disconnect network during bot turn)
2. **Verify**: Bot falls back to PassTurn (does not crash)
3. **Verify**: No errors reference `archetype` in the fallback path

**Pass criteria**: Heuristic fallback still works without archetype dependency.

---

## 4. Code-Level Verification

These are quick checks to run after implementation, before the manual tests above.

### 4.1 No Archetype References in Source

```bash
grep -r "BotArchetype\|archetype" src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v "__tests__"
```

**Expected**: Zero results (or only in comments/docs).

### 4.2 No Archetype References in Tests

```bash
grep -r "BotArchetype\|archetype" src/ --include="*.test.ts" --include="*.test.tsx"
```

**Expected**: Zero results.

### 4.3 ArchetypeBadge File Deleted

```bash
ls src/client/lobby/components/bot/ArchetypeBadge.tsx 2>&1
```

**Expected**: "No such file or directory"

### 4.4 Prompt Functions Have Correct Signatures

Check that the three prompt functions only take `skillLevel`:

```bash
grep -n "getSystemPrompt\|getRoutePlanningPrompt\|getPlanSelectionPrompt" src/server/services/ai/prompts/systemPrompts.ts
```

**Expected**: Each function takes `(skillLevel: BotSkillLevel)` — no `archetype` parameter.

### 4.5 Build and Test

```bash
npm run build && npm test
```

**Expected**: Clean build, all tests pass.

---

## 5. Regression Checklist

These existing features must still work after the refactor:

- [ ] Create a lobby
- [ ] Add a bot with Easy/Medium/Hard skill level
- [ ] Start a game with human + bot
- [ ] Bot completes 2 initial build turns
- [ ] Bot moves, picks up loads, delivers loads
- [ ] Bot earns money from deliveries
- [ ] Bot builds track during movement phase (post-move build)
- [ ] Strategy Inspector shows turn-by-turn audit
- [ ] Multiple bots in one game work
- [ ] Game with bots at different skill levels works
- [ ] Disconnecting/reconnecting during bot turn doesn't corrupt state
