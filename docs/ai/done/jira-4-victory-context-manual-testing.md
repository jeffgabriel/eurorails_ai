# JIRA-4: Victory-Aware Context — Manual Testing Guide

## Prerequisites

- `npm run build` compiles clean
- `npm test` passes (including ContextBuilder tests)
- Dev server running: `npm run dev`
- LLM API key configured (Anthropic or Google)
- Ability to inspect bot prompts (Strategy Inspector, server logs, or debug overlay)

---

## 1. Prompt Inspection — VICTORY PROGRESS Section

**Setup:** Start a game with 1 human + 1 bot. Play until the bot has track and at least one connected major city.

### 1.1 VICTORY PROGRESS appears after YOUR STATUS

1. On any active turn, open Strategy Inspector or inspect the user prompt sent to the LLM
2. **Verify:** A `VICTORY PROGRESS:` section exists
3. **Verify:** It appears after `YOUR STATUS` and before `YOUR DEMAND CARDS`
4. **Verify:** It includes "Cash: XM / 250M needed (YM remaining)"
5. **Verify:** It includes "Cities connected: N/7 needed" with city names

| Result | Notes |
|--------|-------|
|        |       |

### 1.2 Unconnected cities listed with costs

1. When the bot has fewer than 7 connected cities, inspect the prompt
2. **Verify:** "Cities NOT connected:" lists unconnected major cities
3. **Verify:** Each city shows estimated cost (e.g., "Wien (~8M to connect)")
4. **Verify:** "Nearest unconnected city:" names the cheapest one
5. **Verify:** STRATEGIC PRIORITY line is present

| Result | Notes |
|        |       |

### 1.3 All cities connected case

1. Use a debug/sandbox setup where the bot has 7+ cities connected (or inspect a late-game state)
2. **Verify:** "All cities connected! Earn more cash to win." appears
3. **Verify:** No "Cities NOT connected" or "Nearest unconnected city" lines

| Result | Notes |
|--------|-------|
|        |       |

---

## 2. Phase Directives

### 2.1 Early Game — no victory directive

1. Start a fresh game; on turns 3–5 (bot has 1–2 cities, &lt;80M cash)
2. Inspect the prompt
3. **Verify:** No "LATE-GAME DIRECTIVE", "MID-GAME DIRECTIVE", or "VICTORY IS IMMINENT" line
4. **Verify:** VICTORY PROGRESS section still appears with cash and cities

| Result | Notes |
|--------|-------|
|        |       |

### 2.2 Mid Game — MID-GAME DIRECTIVE

1. Play until bot has 3+ cities connected and 80M+ cash (or use sandbox)
2. Inspect the prompt
3. **Verify:** "MID-GAME DIRECTIVE:" appears
4. **Verify:** Text includes "routing deliveries through unconnected major cities"

| Result | Notes |
|--------|-------|
|        |       |

### 2.3 Late Game — LATE-GAME DIRECTIVE

1. Play until bot has 5+ cities and 150M+ cash (or use sandbox)
2. Inspect the prompt
3. **Verify:** "LATE-GAME DIRECTIVE:" appears
4. **Verify:** Text includes "more cities", "more cash", and a specific city to connect
5. **Verify:** "Victory is within reach" or similar phrasing

| Result | Notes |
|--------|-------|
|        |       |

### 2.4 Victory Imminent — VICTORY IS IMMINENT

1. Play until bot has 6+ cities and 230M+ cash (or use sandbox)
2. Inspect the prompt
3. **Verify:** "VICTORY IS IMMINENT" appears
4. **Verify:** Text includes "Do NOT discard hand or take unnecessary risks"
5. **Verify:** Names the last unconnected city and cash needed

| Result | Notes |
|--------|-------|
|        |       |

---

## 3. VICTORY BONUS on Demand Cards

### 3.1 Demand card with unconnected supply or delivery city

1. Play until the bot has some unconnected cities (e.g., Wien, Madrid)
2. Ensure at least one demand card has supply or delivery at an unconnected major city
3. Inspect the demand card section of the prompt
4. **Verify:** That demand line includes "VICTORY BONUS"
5. **Verify:** Text includes "route passes near [city]" and "unconnected, ~XM to connect"

| Result | Notes |
|--------|-------|
|        |       |

### 3.2 Demand card with no unconnected cities

1. When a demand's supply and delivery are both connected (or neither is a major city)
2. **Verify:** No VICTORY BONUS annotation on that demand line

| Result | Notes |
|--------|-------|
|        |       |

---

## 4. STRATEGIC PRIORITY Edge Cases

### 4.1 Cash-rich (250M+ but &lt;7 cities)

1. Use sandbox or play until bot has 250M+ cash and fewer than 7 cities
2. Inspect the prompt
3. **Verify:** STRATEGIC PRIORITY says "focus ALL building budget on connecting"
4. **Verify:** Lists the unconnected city names

| Result | Notes |
|--------|-------|
|        |       |

### 4.2 Unaffordable (cheapest connection &gt; cash)

1. Use sandbox: bot has &lt;30M cash, cheapest unconnected city costs ~50M+
2. Inspect the prompt
3. **Verify:** STRATEGIC PRIORITY says "Earn more before connecting"
4. **Verify:** Shows "cheapest unconnected city costs ~XM, you have YM"

| Result | Notes |
|--------|-------|
|        |       |

---

## 5. System Prompt Rules

### 5.1 VICTORY ROUTING in CRITICAL RULES

1. Inspect the system prompt (or prompt catalog) used for action decisions
2. **Verify:** Rule 13 or equivalent: "VICTORY ROUTING" or "prefer deliveries that pass through or near unconnected major cities when payouts are similar"

| Result | Notes |
|--------|-------|
|        |       |

### 5.2 VICTORY CONNECTIONS in route planning

1. Trigger route planning (e.g., bot needs a new route, planRoute called)
2. Inspect the route planning system prompt
3. **Verify:** Criterion 8 or equivalent: "VICTORY CONNECTIONS" or "detour through an unconnected city for ≤10M extra track cost"

| Result | Notes |
|--------|-------|

---

## 6. AI Behavior (Optional)

### 6.1 Late-game pivot toward connecting cities

1. Play a full game until the bot reaches Late Game (5+ cities, 150M+)
2. Observe the bot's next 5–10 turns
3. **Verify:** Bot builds track toward unconnected cities (not only toward high-payout deliveries)
4. **Verify:** Bot does not consistently ignore the cheapest unconnected city when it's on a reasonable route

| Result | Notes |
|--------|-------|
|        |       |

### 6.2 Victory Imminent — no discard

1. Play until bot reaches Victory Imminent (6+ cities, 230M+)
2. Observe the bot's turns
3. **Verify:** Bot does not discard its hand unless clearly stuck
4. **Verify:** Bot prioritizes connecting the last city and earning remaining cash

| Result | Notes |
|--------|-------|
|        |       |

---

## 7. Regression

### 7.1 Bot still plays normally

1. Create a game with 1 human + 1 bot
2. Play 10+ turns
3. **Verify:** Bot builds, moves, picks up, delivers without errors
4. **Verify:** No new console or server errors related to ContextBuilder, unconnectedMajorCities, or serializePrompt

| Result | Notes |
|--------|-------|
|        |       |
