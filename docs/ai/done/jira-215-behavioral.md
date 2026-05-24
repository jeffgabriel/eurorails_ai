# JIRA-215 — Pickup-time advisor only sees loads AT the current city; misses corridor opportunities along the next leg

## Game evidence

- Game: `c2a4df33-...` (full ID per most recent log file)
- Bot: Flash, turn 8
- Position: Warszawa, picking up Ham as the planned first stop
- Planned route at this moment: `PICKUP Ham @ Warszawa → DELIVER Ham @ Stuttgart`
- In Flash's demand hand at the same moment: a Potatoes → Ruhr demand card (Potatoes is supplied at Lodz)

## What happened

After Flash committed the Ham pickup at Warszawa, the JIRA-214 advisor fired (post-action-at-each-city in Phase A). The pre-LLM filter ran across Flash's demand cards. The Potatoes → Ruhr demand was dropped at filter condition 1: the advisor requires `demand.supplyCity == currentCity`, and Potatoes is supplied at Lodz, not at Warszawa. No other demand cards were available at Warszawa. The candidate list was empty, so the LLM call was skipped (per JIRA-214 R8). Flash moved toward Stuttgart, passed Lodz on the way, and delivered Ham at Stuttgart without ever picking up Potatoes. The Potatoes → Ruhr demand stayed in hand.

## What we wanted

Lodz sits on the natural path from Warszawa to Stuttgart. Lodz supplies Potatoes. Flash already holds the Potatoes → Ruhr demand. The marginal detour to insert PICKUP Potatoes @ Lodz between Warszawa and Stuttgart, plus DELIVER Potatoes @ Ruhr after Stuttgart, is small relative to the 30M+ Potatoes payout — Stuttgart and Ruhr are close, and Lodz is essentially on the way. A human player would see this at a glance and add the second pickup before leaving Warszawa.

This is the canonical "drive-by pickup on the way to your real destination" scenario — exactly what the old corridor-based route-enrichment advisor was supposed to catch, before we replaced it with the per-city advisor in JIRA-214 because its prompt was noisy and produced bad calls.

## Current behavior

The JIRA-214 advisor fires only at supply cities the bot has a planned reason to visit (a planned PICKUP/DELIVER/DROP commits, then the advisor scans for additional loads at *that exact city*). Cities the bot will pass through unplanned — like Lodz when going Warszawa → Stuttgart — never trigger an advisor fire and never get scanned. The pre-LLM filter explicitly rejects demand cards whose supply city differs from the bot's current city.

Net effect: the JIRA-214 advisor handles the "now that I'm here, what else can I grab" case correctly. It does **not** handle the "on this trip, what should I plan to grab along the way" case at all. That case is the more common high-value case in real gameplay.

## Desired behavior

When the advisor fires at a city, it should additionally scan the path from that city to the bot's next route stop. For any demand card whose supply city sits on (or close to) that path, the advisor should consider inserting both a PICKUP at that supply city and a DELIVER at the matching delivery city, with marginal cost (build M and extra turns) computed against the bot's actual planned trip — same quality of detour data that JIRA-214 introduced for same-city candidates.

The LLM keeps its existing schema (`keep | insert | reorder`); the prompt's candidate block grows by a few rows per fire. The bot grabs en-route opportunities the JIRA-214 advisor structurally cannot see today.

## Player-visible impact

The user explicitly flagged this gap from the c2a4df33 game. In observable bot behavior:

- Bot picks up multiple loads per trip when supply cities lie on its planned path. Today it picks up only the supply at its own start position.
- Double deliveries become routine instead of accidental.
- The income-velocity gap between winning and losing bots narrows (per JIRA-214 behavioral doc, the gap is largely driven by multi-load trips).

## Out of scope

- Multi-leg corridor scanning (the advisor evaluates only the **next** leg per fire; opportunities on later legs surface when the bot fires at the start of those legs). Single-leg scope is per JIRA-214 design and is preserved here.
- Reorder of existing route stops (schema option exists but expected to remain rarely used).
- Pre-route advisor at `NewRoutePlanner` / `PostDeliveryReplanner` time (deferred — see Option 1 in the design discussion; not chosen).
- Drop-existing-load and upgrade-train decisions when capacity is full (deliberately deferred per JIRA-214 ADR-5).
