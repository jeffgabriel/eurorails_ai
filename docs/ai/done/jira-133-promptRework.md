# JIRA-133: LLM Prompt Rework

_Analysis of 8 prompt samples across Initial Build, Early Game, and Mid Game phases for both Flash (Gemini) and Haiku (Claude). The user prompt is bloated with repeated static instructions, opaque scores, geographic nonsense, and conflicting signals. This is a holistic rework._

## Fixes

### 1. Remove opaque scores from demand ranking

Drop the `score` field. Keep the human-readable breakdown. Round M/turn to 1 decimal.

Before:
```
#1 Steel Ruhr→Krakow (Card 3): score 5.300000000000001 (payout: 20M, build: ~9M, ROI: 11M, ~5 turns, 2.2M/turn, network: +10 cities, victory: +2 major) ```

After:
```
#1 Steel Ruhr→Krakow: payout 20M, build ~9M, ROI 11M, ~5 turns, 2.2M/turn ```

### 2. Remove RECOMMENDED tag and pre-sorted ranking

Stop telling the LLM which demand to pick. Present the data unsorted (or sorted by card) and let the LLM reason from the breakdown. Our scoring has been wrong before (JIRA-123, game `eb69a74e` analysis) — when we pre-rank and tag a recommendation, we steer the LLM toward our mistakes.

### 3. Filter to top 3-5 viable demands, show card conflicts inline

Stop listing all 9 demands. Show the top 3-5 (positive ROI or closest to positive). Collapse the rest into a single summary line. Tag mutual exclusivity inline.

Before:
```
#1 Potatoes OnTrain→Milano (Card 1): score 8 #2 Cattle Bern→Berlin (Card 3): score 1.8
...
#8 Wood Sarajevo→Praha (Card 1): score -0.6 (low priority)
#9 Iron Birmingham→Goteborg (Card 3): score -0.96 (low priority)
```

After:
```
YOUR DEMANDS:
Potatoes OnTrain→Milano [Card 1]: 24M, no build needed, ~3 turns, 8.0M/turn
Cattle Bern→Berlin [Card 3]: 17M, build ~13M, ~6 turns, 0.7M/turn — routes near Berlin (unconnected)
Oil Beograd→Zurich [Card 3]: 25M, build ~21M, ~9 turns, 0.4M/turn
  ↳ NOTE: Cattle→Berlin and Oil→Zurich are on the same card — delivering one discards the other.
Beer Praha→London [Card 2]: 11M, build ~14M, ~8 turns — routes near London (unconnected)
4 other demands require 24-142M of new track (not viable).
```

Card conflicts stated in plain English immediately after the relevant demands, with the consequence spelled out. No symbols, no back-references to rank numbers.

### 3. Remove STRATEGIC PRIORITY text

It contradicts the ranking and confuses the LLM. The ranking already incorporates victory city proximity via the `routes near X (unconnected)` annotation. Remove:

```
- STRATEGIC PRIORITY: Connect Wien (cheapest) while pursuing deliveries through that corridor.
- MID-GAME DIRECTIVE: Start routing deliveries through unconnected major cities when possible.
```

The victory progress section already shows which cities are unconnected and their costs. The demand ranking annotations call out when a demand routes near one. That's sufficient.

### 4. Replace track summary with geographic description

Before:
```
Track network: 126 mileposts: Antwerpen–Beograd, Beograd–Cardiff, Cardiff–Firenze, Firenze–Hamburg...
```

After:
```
Track network: 126 mileposts. Backbone: Ruhr → Berlin → Wien (central). Spurs: Milano (south), London via Holland (west), Cardiff (ferry).
```

Build this from the connected major cities + the track graph topology. The LLM needs to understand the shape, not an alphabetical city-pair list.

### 5. Move static instructions to system prompt

These appear in every user prompt and never change:

- `PLAN PERSISTENCE: You MUST continue your existing plan unless...` (5 lines)
- `IMPORTANT: Only use DELIVER if a delivery is listed above...`
- `REMINDER: Use ALL N movement points each turn...`
- `TIP: Use MOVE to travel along your track...`
- `TIP: You can PICKUP then BUILD in the same turn...`

Move all of these to the system prompt. This doesn't save tokens (system + user prompt are both sent on every call), but it separates concerns: rules in the system prompt, turn-specific state in the user prompt. Makes prompts easier to read, debug, and maintain. The actual token savings come from fixes #3, #7, and #9 which shrink the user prompt content.

### 6. Suppress irrelevant sections by phase

**Initial Build:** Suppress movement reminders, reachable cities, en-route pickups, cargo warnings. The bot can only build track.

**No cargo:** Suppress `WARNING: You are carrying [X] but cannot deliver here` and cargo-related tips.

**Single reachable city:** Suppress `CITIES REACHABLE THIS TURN` when ≤1 city listed (adds no information).

### 8. Add cargo-to-demand cross-reference

When the bot is carrying loads, show which demands they fulfill directly:

```
CARGO:
- Marble → deliver at London for 31M [Card 3a] (2 turns away)
- Imports → no matching demand (consider dropping at next city)
```

This replaces the generic `WARNING: You are carrying [Imports, Marble] but cannot deliver here` with actionable information.

### 9. Unified demand view: merge card section and ranking

Before (9 demands across 3 cards, most "Supply not reachable"):
```
Card 1 (pick at most one):
  a) Wine from Wien → Paris (11M) — Supply at Wien ON YOUR TRACK
  b) Copper from Wroclaw → Birmingham (29M) — Supply at Wroclaw ON YOUR TRACK
  c) Steel from Ruhr → Venezia (19M) — Supply at Ruhr (reachable).
Card 2 (pick at most one):
  a) Cheese from Holland → Birmingham (12M) — Supply not reachable.
  b) Hops from Cardiff → Lodz (35M) — Supply at Cardiff ON YOUR TRACK
  c) Potatoes from Lodz → Bern (21M) — Supply at Lodz ON YOUR TRACK
Card 3 (pick at most one):
  a) Marble from OnTrain → London (31M) — Marble ON YOUR TRAIN.
  b) Iron from Birmingham → Munchen (26M) — Supply not reachable.
  c) Wine from Wien → Szczecin (12M) — Supply at Wien ON YOUR TRACK
```

After — merge with the filtered ranking (fix #3). The card section and ranking are redundant. Show one unified view:
```
YOUR DEMANDS:
Marble OnTrain→London [Card 3]: 31M, no build needed, ~2 turns
Hops Cardiff→Lodz [Card 2]: 35M, no build needed, ~7 turns (ferry penalty)
Steel Ruhr→Venezia [Card 1]: 19M, build ~3M, ~4 turns
Wine Wien→Szczecin [Card 3]: 12M, build ~9M, ~6 turns — routes near Berlin (unconnected)
  ↳ NOTE: Marble→London and Wine→Szczecin are on the same card — delivering one discards the other.
4 other demands need 7-20M track (not viable).
```

No rank numbers, no recommendation tags, no pre-sorting. Plain English card conflicts with consequences stated. The LLM sees the facts and decides.

## Implementation

All fixes target `ContextBuilder.serializePrompt()` and the system prompt templates in `prompts/systemPrompts.ts`. No changes to the decision pipeline, route planning, or turn composition.

| Fix | File | Effort |
|-----|------|--------|
| 1. Remove scores, round M/turn | `ContextBuilder.ts` (demand ranking section) | Small |
| 2. Remove RECOMMENDED tag, don't pre-sort | `ContextBuilder.ts` (demand ranking section) | Small |
| 3. Filter to top 3-5, card conflicts inline | `ContextBuilder.ts` (demand ranking section) | Small |
| 4. Remove strategic priority text | `ContextBuilder.ts` (victory progress section) | Trivial |
| 5. Geographic track summary | `ContextBuilder.ts` (computeTrackSummary) | Medium |
| 6. Move statics to system prompt | `systemPrompts.ts` + `ContextBuilder.ts` | Medium |
| 7. Phase-aware section suppression | `ContextBuilder.ts` (serializePrompt) | Small |
| 8. Cargo-to-demand cross-reference | `ContextBuilder.ts` (new section) | Small |
| 9. Unified demand view (merge cards + ranking) | `ContextBuilder.ts` (merge two sections) | Medium |
