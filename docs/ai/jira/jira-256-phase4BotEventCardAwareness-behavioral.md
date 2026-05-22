# JIRA-256 — Phase 4: bot ignores every active event card (behavioral)

Companion to `jira-256-phase4BotEventCardAwareness-technical.md`.

This is the umbrella ticket for Phase 4 event-card awareness. **It subsumes JIRA-251** (Rail Strike vertical slice) — instead of fixing one event type and filing follow-ons per symptom, we cover all 20 event cards in a single project.

## Symptom in one line

In any game where an event card is active, the bot keeps emitting moves, builds, pickups, and deliveries as if the card were not there. The server silently rejects each illegal action. The bot has no record of why its action was rejected and re-emits the same failing action next turn. From the outside, it looks like the bot is "stuck" or "frozen."

## What the user sees

- **Under Rail Strike**: bot keeps trying to move on its own track. 6+ consecutive turns of `MoveTrain` returning `success: false`. The bot's per-turn log records the failure but not the reason. (Verbatim repro from JIRA-251, game `d9d2433a`.)
- **Under Snow**: bot routes through Alpine/mountain mileposts in the snowed area; server rejects. Bot does not switch to a non-mountain detour or recognise the speed reduction.
- **Under Coastal Strike**: bot continues planning pickups and deliveries at port cities like Marseille, Genova, Hamburg. Server rejects each one.
- **Under Derailment**: bot loses a load and a turn without acknowledgement; on the lost turn, the bot still attempts to play, producing rejected actions for an entire turn.
- **Under Flood**: bot's bridges are erased server-side. The bot's planner doesn't notice — it tries to move across the missing bridge, gets rejected, re-emits the same plan, repeats.
- **Under Excess Profit Tax**: bot's cash drops mid-game. The bot may plan as if the deducted amount were still available, leading to "insufficient funds" build failures.

In every case the bot's NDJSON turn log carries the failure but **no rejection reason**, so an engineer looking at the log can see *that* the action failed but not *why* — the only signal is "what game state was active at the time of the failure," which requires cross-referencing server logs and the active-effect snapshot manually.

## Why this is an umbrella ticket

The bot is blind to **all** event-card effects, not just one. JIRA-251 (Rail Strike) was filed as a vertical slice that would establish a fix pattern; once we surveyed the codebase we confirmed that **the server already has a clean, normalised restriction model** that covers every event type uniformly. Fixing one event type means writing essentially the same wiring as fixing all five. We're doing the full sweep.

## Event-card rules (the rules the bot needs to obey)

The Eurorails deck has **20 event cards** mixed in with the demand cards. When drawn, an event card is placed face-up and takes effect immediately. Most cards remain in effect until the end of the drawing player's *next* turn (i.e., the active player draws the card, plays the rest of their turn under the card, takes their next full turn under the card, and the card is discarded at the end of that next turn). The exceptions are **Derailment** and **Excess Profit Tax**, which take effect once and are immediately discarded.

The five event-card types:

### 1. Coastal Strike (cards #121, #122 — 2 cards)

> No train may pick up or deliver any load at any city within 3 mileposts of any coast.

Affects **all players**. The "coastal band" is computed from the map: every milepost within 3 hexes of an Atlantic / English Channel / Mediterranean / Irish Sea coastline. Major coastal cities like Marseille, Hamburg, Lisboa, Sevilla, Athens, and Stockholm all fall inside the band; inland cities like Praha, Wien, Berlin are safe.

The bot can still **move through** coastal cities and pay track-use fees — only pickup and delivery are blocked. The bot can also still pick up or deliver at any inland city.

### 2. Rail Strike (card #123 — 1 card)

> No train may move on the drawing player's rail lines. The drawing player may not build track during this event.

Affects the **drawing player only** (and any player whose train is moving on the drawing player's track). For the bot:
- If the bot drew the card, the bot cannot move on segments it owns AND cannot build track this turn. The bot can move on opponent track (paying the ECU 4M usage fee) and can pick up / deliver / pass.
- If another player drew the card, the bot cannot move on that opponent's track (which it would normally pay to use). The bot's own track is fine.

### 3. Excess Profit Tax (card #124 — 1 card)

> All players pay tax based on the Event card chart.

One-shot effect. All players pay a sliding-scale tax based on current cash (e.g., bracket structure: ECU 500M+ → 50M tax; 300M+ → 30M tax; etc. — exact brackets live in `configuration/event_cards.json`). Card is discarded immediately after.

For the bot: this is a passive cash deduction. The bot needs to plan with the **post-tax** cash balance, not the pre-tax one. The current snapshot already reflects post-tax cash by virtue of the snapshot being captured after the tax is applied, so the bot's only requirement is to **not over-commit cash based on a stale snapshot**.

### 4. Derailment! (cards #125–#129 — 5 cards)

> All trains within 3 mileposts of the specified cities lose 1 turn and 1 load.

One-shot effect. Each Derailment card lists a different epicenter city or cities. Any train currently in the 3-milepost radius:
- **Loses one load** — the player chooses which load is lost, and it returns to the load tray.
- **Loses one turn** — the player's *next* turn is skipped. The skipped turn is the player's whole turn (no movement, no build, no pickup, no deliver, no discard).

Trains that enter the affected area **after** the card is drawn are not affected.

For the bot: when the bot is in the affected radius at draw time, it loses a load (the server handles which one) and on its next turn must emit **only `PassTurn`**. Today the bot tries to play normally on the lost turn and produces a string of rejected actions.

**Load-choice note (documented deviation from rules).** The rulebook says the player picks which load is lost. Today's server implementation (`EventCardService.processDerailment` at `EventCardService.ts:271`) deterministically removes `loads[0]` — the first load in the player's load array — regardless of whether the player is human or bot. The code comment acknowledges this as a known deviation: `"Remove first load (deterministic; rulebook says player chooses — see ADR-2.5)"`. The bot has no decision to make here under the current API; it inherits the server's choice. If proper player-chosen load loss is wanted later, it requires a server-side change (extend `processDerailment` to accept a player callback, then human UI + bot heuristic both implement it). Out of scope for Phase 4 — file a separate ticket if pursued.

### 5. Snow! (cards #130, #131, #132 — 3 cards)

> All trains within 6 mileposts of Torino (#130, Alpine) / 4 mileposts of München (#131, Mountain) / 4 mileposts of Praha (#132, Mountain) move at half rate. No movement or railbuilding allowed in Alpine / mountain mileposts of the affected area.

Affects **all players** whose trains are inside the snow radius. The blocked-terrain restriction applies only to mileposts of the specified terrain type *and* inside the radius — Mountain mileposts outside the radius are fine; Clear/City mileposts inside the radius are fine for movement and build.

Half rate:
- Freights and Heavy Freights: 5 mileposts per turn (down from 9).
- Fast Freights and Superfreights: 6 mileposts per turn (down from 12).

If a train was already moving when the snow hit, the **remaining** movement is halved (rounding up).

### 6. Flood (8 cards, one per major river)

> Bridges crossing the affected river are immediately erased. Track may be rebuilt only after the Flood card is discarded.

Affects **all players**. The server runs `TrackService.removeSegmentsCrossingRiver` at draw time, deleting every segment that crosses the named river. While the card is in effect:
- No player can rebuild a bridge across that river.
- Trains can still move across the affected river through the red zone of a major city, but only after the card is discarded (within-major-city bridges are closed during the event).

For the bot: the next snapshot after a Flood will show fewer owned segments. The bot's planner needs to either route around the missing bridge or commit to rebuilding it **after** the Flood is discarded.

**Persistence semantics (server-side).** Flood has a unique split between what the *server* makes permanent and what's temporary:

- **Permanent (server)**: the player-owned track segments crossing the river are deleted from the database at draw time by `TrackService.removeSegmentsCrossingRiver` (`trackService.ts:225`). The Flood card discarding does NOT restore them server-side. They stay gone in the DB until somebody pays to rebuild them at standard river-crossing cost (ECU 2M + milepost).
- **Temporary**: only the rebuild block. While the Flood card is active in `ActiveEffectManager`, `isFloodRebuildBlocked` rejects any attempt to rebuild a segment across the affected river. When the card discards (end of drawing player's next turn), the block lifts and rebuilds are permitted at standard cost.

**Bot policy: eager unconditional rebuild.** The bot does NOT live with permanent damage. As soon as the Flood card discards, the bot rebuilds every segment it lost to that Flood — unconditionally, regardless of whether the segment is on its current planned route, regardless of whether the rebuild is cost-optimal. The rationale:

- The bot's downstream scoring algorithms (`DemandEngine.isCityOnNetwork`, `estimateTrackCost`, corridor scoring) are not connectivity-aware in the way a human looking at the board is. Letting the bot's network shape change unpredictably mid-game would produce a class of scoring bugs (e.g., over-confidently planning trips to orphaned cities) that aren't worth fixing for the rare Flood case.
- Eager rebuild keeps the bot's network shape stable across Flood events, so every other piece of bot logic continues working without modification.
- Cost is bounded: ECU 2-3M per bridge × the (usually 1-3) bridges affected per Flood. Acceptable for a bot typically carrying 100M+ in cash by mid-game.

**Rebuild scheduling.** When `pendingFloodRebuilds` is non-empty in the snapshot, the bot's build planner:
- **Blocks all other building** until the rebuild list is empty. The bot will not emit non-rebuild BuildTrack actions even if higher-value builds are available, until every lost segment has been restored.
- Spreads the work across turns if needed (the ECU 20M/turn build budget caps a multi-bridge rebuild at ~6-7 segments per turn).
- Movement, pickups, and deliveries continue normally during the rebuild — the block applies only to Phase B (building).

**Discarded option (for context):** an alternative was to fix the underlying connectivity-aware-scoring gap in `DemandEngine` (specifically that `isCityOnNetwork` reports orphaned-component cities as "on network" because `network.nodes` doesn't track connected components). That bug exists today and is exercised by Flood and post-restart scenarios. It is filed as known debt; this project mitigates it for the Flood case via the eager-rebuild policy rather than fixing it structurally.

### Visual board damage (out of bot scope, folded into JIRA-256 technical scope)

`TrackService.removeSegmentsCrossingRiver` does the database delete but emits no socket event today, so the client UI does not refresh erased track until something else (next snapshot, manual refresh) prompts it. The bot is unaffected (it reads tracks from snapshot, which queries the DB fresh) but humans see stale track during a Flood. This is folded into JIRA-256 technical scope as a one-line emit fix in `EventCardService.processFlood`.

## What the bot will do after this work

For each restriction class, "respects the rule" means: the bot does not generate candidate actions that would be rejected, the guardrail catches anything that slips through, and the server's rejection (in the rare case anything reaches it) is recorded with a structured reason code in the turn log.

| Active effect | Today | After this work |
|---|---|---|
| Coastal Strike | Bot attempts pickup / delivery at coastal cities; server rejects; no reason logged | Bot's pickup/deliver decisions skip coastal-band cities while the strike is active. Movement and through-traffic on coastal track unchanged. |
| Rail Strike (bot is drawer) | Bot moves on own track; server rejects every move for 1–2 turns | Bot routes via opponent track only (paying usage fee), or stays put. No BuildTrack actions emitted this turn. |
| Rail Strike (opponent is drawer) | Bot may attempt to move on that opponent's track; server rejects | Bot routes via other opponents' track or own track; skips that opponent's track. |
| Excess Profit Tax | Bot may over-commit cash based on stale numbers | Bot reads post-tax cash from the next snapshot; no special handling required. |
| Derailment | Bot loses load + turn; on lost turn, attempts to play normally | Bot detects "I have a pending lost turn" from the snapshot and emits `PassTurn` only. |
| Snow (blocked terrain) | Bot routes through Alpine/Mountain mileposts in the snow zone | Bot's path candidates exclude blocked-terrain mileposts inside the zone. |
| Snow (half rate) | Bot uses full speed; over-extends and gets rejected on later mileposts | Bot caps its movement budget to the half-rate value while inside the zone. |
| Flood | Bot tries to move across the deleted bridge; tries to rebuild before discard | Snapshot shows the segment is gone. Bot routes around it while Flood is active. After Flood discards, bot eagerly rebuilds **every** lost segment (blocking all other building until rebuild list is empty); network shape restored to pre-Flood state within 1-3 turns. |
| Mid-turn event draw | Bot finishes the turn under stale assumptions | Bot re-snapshots and re-plans the remainder of the turn against the new active-effect set. |

## Why this matters

Event-card-active play is the broken half of the bot's current behavior. Closing it removes the largest single source of "the bot is stuck" reports from smoke testing and unlocks the bot as a credible opponent for full-rules play. It also makes the bot's per-turn log self-explanatory: every rejected action will carry a structured `rejectionReason` code, eliminating the "why did the bot just do nothing for six turns" mystery class of bug.

## Out of scope

- **LLM-prompt changes.** The deterministic gates are sufficient. Bot models that drive turn decisions via LLM will get the same restriction filtering at the planner layer, but `ContextSerializer` is not modified to describe active effects in natural language.
- **Strategic adaptation.** The bot does not learn to *avoid* drawing event cards into bad situations (e.g., planning around the Snow zone before drawing it). V1 is reactive only.
- **Circus / variant cards.** Out of scope for V1. Same data model would extend.

## Smoke-test acceptance

After this work lands, running a full game with the Medium-skill bot against a deck containing the standard 20 event cards should produce:
- Zero turns where the bot emits ≥3 consecutive actions all returning `success: false` for the same rejection reason.
- Every `success: false` action in the per-turn NDJSON log carries a `rejectionReason: { code, message }` field.
- `PassTurn` is emitted (rather than re-tried failing actions) whenever the bot is in `pendingLostTurns` or has no legal action available under the active restrictions.
