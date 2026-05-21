# JIRA-165: Game 308d2270 Bug List

## Game Summary

| | Haiku | Flash |
|---|---|---|
| Turns | 59 | 59 |
| Deliveries | 4 (67M) | 7 (153M) |
| Final cash | $0 | $0 |
| Connected major cities | 2 (London, Wien) | 3 (Paris, Ruhr, Berlin) |
| Track cost | 117M (174% of income) | 203M (133% of income) |
| Train upgrades | None | None |
| Movement efficiency | 57.6% | 88.0% |

---

## Bug 1: ContextBuilder presents stale/wrong demand card to LLM (CRITICAL)

The trip planner prompt included a demand card that doesn't match the bot's actual hand. The LLM followed the prompt data correctly — the bug is upstream in ContextBuilder.

**Evidence — Flash T40:**

The system prompt presented to the LLM includes:
```
Card 79: Cork from Sevilla → Wroclaw (59M)
Card 79: Wheat from Lyon → Lisboa (26M)
```

But Flash's actual demand cards at T40 (from game log) are:
- Card #30: Potatoes, Fish, China
- Card #122: Wood, Oranges, Oil
- Card #67: Imports, Hops, Marble

**Card #79 does not exist in Flash's hand.** The LLM chose the Cork→Wroclaw route at 59M because the prompt told it that card existed. The LLM did exactly what the data said — the data was wrong.

**Impact:**
- Flash traveled 6 turns (T41-T46) to Sevilla, built 22M of track toward a Cork pickup
- T47: `action_failed` — Cork is available as a load at Sevilla but Flash has no demand card for it
- T48: route abandoned, 7 turns + 22M wasted

**Root cause:** ContextBuilder is presenting demand card data that doesn't match the bot's actual hand. Card #79 with Cork/Wheat is either stale (from a previous hand before delivery replaced a card), belongs to another player, or is computed from the wrong data source. The demand cards in the LLM prompt diverge from the demand cards in the game log.

**Fix:** Investigate why ContextBuilder's demand list includes card #79 when the bot's hand is cards #30, #122, #67. This is a data integrity issue — the demand cards presented to the LLM must exactly match the bot's current hand from the database.

---

## Bug 2: Haiku builds to $0 chasing Aberdeen instead of delivering carried load (HIGH — capital allocation)

Haiku picked up Imports at Antwerpen (T24) and needs to deliver to Lodz. Lodz is likely reachable via existing track (Wien→east). Instead, Haiku spent its remaining cash building toward Aberdeen:

| Turn | Build cost | Cash after | Target |
|---|---|---|---|
| T24 | 20M | 23M | Aberdeen |
| T26 | 17M | 6M | Aberdeen |
| T28 | 6M | 0M | Aberdeen |

After T28, Haiku has $0, is stuck at London, and oscillates London↔(22,33) for 33 turns with carried Imports that could have been delivered for income.

**Root cause:** The route has 4 stops: pickup Imports at Antwerpen → pickup Fish at Aberdeen → deliver Imports at Lodz → deliver Fish at Krakow. The current stop index is 1 (Aberdeen). The bot builds toward Aberdeen (stop 1) instead of skipping ahead to deliver Imports at Lodz (stop 2) which would generate income. The pipeline doesn't consider whether building toward the current stop will bankrupt the bot when a later stop could generate income first.

**This is the north star violation:** Every turn should advance toward victory. Spending 43M building toward Aberdeen when carrying a deliverable load worth 19M+ at Lodz is negative ROI. The bot should deliver first, earn income, then build.

---

## Bug 3: Ferry oscillation at $0 — London↔(22,33) for 33 turns (HIGH)

After going broke at T28, Haiku oscillates between London and (22,33) for 33 consecutive turns (T28-T60). The pattern:

- Odd turns: speed 5 (half rate = ferry crossing), position London
- Even turns: speed 9 (normal), position 22,33

The bot is crossing back and forth over the English Channel ferry every turn. Ferry rules: stop at port, next turn start from opposite port at half rate. The bot reaches London, tries to go toward Aberdeen (not on network), reverses back across the ferry, then tries again.

**This is the JIRA-162 bug (calculateTrackRunway) combined with the JIRA-164 $0 stuck state.** The bot has $0, an active route targeting Aberdeen (off-network), and the route executor oscillates because it can't reach the next stop. With JIRA-162 fixed, the JIT gate should correctly measure zero directional runway and allow building — but the bot has no money to build.

**With JIRA-164 applied**, the broke-bot-gate removal should prevent the $0 death spiral. But the oscillation itself is still a problem — the bot should recognize that oscillating across a ferry achieves nothing and switch to delivering the carried Imports.

---

## Bug 4: Route ordering doesn't prioritize deliverable loads (HIGH — capital allocation)

Haiku's route at T24: `[pickup Imports at Antwerpen, pickup Fish at Aberdeen, deliver Imports at Lodz, deliver Fish at Krakow]` with currentStopIndex=1 (Aberdeen).

The route forces the bot to pick up Fish at Aberdeen BEFORE delivering Imports at Lodz, even though:
- Imports is already carried
- Lodz may be reachable on existing track
- The Aberdeen pickup requires extensive track building (43M spent, not yet connected)
- Delivering Imports first would generate income to fund the Aberdeen build

The trip planner should consider: if a carried load is deliverable on the current network, deliver it BEFORE committing to expensive pickup stops that require building.

---

## Bug 5: Flash builds 22 segments toward Sevilla for a fabricated demand (MEDIUM)

After the fabricated Cork demand, Flash built 22 segments (T40: 18 segs, T41: 4 segs) toward Sevilla at a cost of ~22M. This track connects nothing useful — Sevilla is at the southern tip of Spain, far from Flash's network center (Paris/Ruhr/Berlin).

This is a consequence of Bug 1 — the fabricated route drove real track-building decisions. The build advisor followed the invalid route faithfully.

---

## Bug 6: Neither bot upgrades despite being movement-constrained (LOW)

- Haiku: 57.6% movement efficiency for 59 turns. Never upgrades from Freight (9 speed).
- Flash: 88% efficiency but 59 turns without upgrade. At T21 had 51M cash — could have upgraded to Fast Freight (12 speed) for 20M.
- Flash's 16-turn no-income streak (T41-T56) with long cross-map travel would have been shorter with +3 speed.

---

## Bug 7: No hand discard despite stale cards (LOW)

- Haiku holds card#128 for 59 turns and card#146 for 46 turns. Never discards.
- Flash holds card#122 for 59 turns. Never discards.
- Neither bot uses DiscardHand even once.

---

## Priority Order

1. **Bug 1 (stale demand card in prompt)** — CRITICAL — ContextBuilder presents Card #79 (Cork 59M) to the LLM but it's not in the bot's actual hand. LLM follows the bad data faithfully. Bot wastes 7 turns + 22M track. Data integrity issue in context building.
2. **Bug 2 (build to $0 instead of delivering)** — HIGH — capital allocation failure. Bot should deliver carried loads before committing to expensive builds.
3. **Bug 3 (ferry oscillation)** — HIGH — partially addressed by JIRA-162/164 but ferry-specific oscillation detection needed.
4. **Bug 4 (route ordering)** — HIGH — trip planner should prioritize delivering carried loads over new pickups requiring builds.
5. **Bug 5 (Sevilla track waste)** — MEDIUM — consequence of Bug 1.
6. **Bug 6 (no upgrades)** — LOW — existing issue, needs upgrade consideration outside build phase.
7. **Bug 7 (no discard)** — LOW — existing issue, needs stale-hand detection.
