# JIRA-219 — Bot can monopolize all physical entry edges of a low-degree small/medium city (behavioral)

## Source

Surfaced via code inspection on 2026-05-08 while answering a question about how the no-blocking rule is enforced. **Not observed in a specific game log.** This ticket describes the rule gap; before scheduling implementation, confirm whether any small/medium city on the current map actually has few enough entry edges for this to be reachable in practice.

## Game rule

Eurorails rulebook (city entry caps):

- Small cities: **max 2 players** may build into them.
- Medium cities: **max 3 players** may build into them.
- **No-blocking:** track must not block a 2nd player from entering a small city, or a 3rd player from entering a medium city.

The "no-blocking" clause is separate from the player-count cap. It constrains the *physical layout* of track at the city: enough entry mileposts must remain unoccupied for the remaining allowable players to enter via some path.

## Current behavior

When the bot plans a build into a small or medium city, the validator counts how many *distinct other players* already touch the city, adds the bot, and rejects only if that total exceeds the cap.

This means: if the bot is the first to reach a small city, it can occupy every physical entry milepost on subsequent turns. The total-player count is still 1 ≤ 2 (small) or 1 ≤ 3 (medium), so the validator passes every build. When a future opponent tries to enter, every adjacent milepost-pair is already occupied, and the right-of-way rule (one section per milepost-pair) leaves them no path in.

The cap protects against *too many players entering*. It does not protect against *one player consuming all entry edges*.

## Expected behavior

A bot's build into a small or medium city must leave at least one entry path open per remaining allowable player. Concretely: after the proposed build, the count of *unoccupied entry mileposts adjacent to the city* must be ≥ (city cap − distinct players currently touching the city, including the bot if it would touch after the build).

A build that would close the last reservable entry for a future allowable player must be rejected as a hard gate failure, with the same severity as the existing player-count cap.

## Why this matters

A bot that monopolizes a low-degree city's entry edges silently breaks the rulebook. Beyond legality, it forces opponents into long detours or strands their demand cards for that city, which distorts game outcomes and makes bot vs. human play feel unfair in a way that's hard to attribute.

## Out of scope for this ticket

- The per-player section cap (rulebook: "no player may build more than 3 track sections to a medium or small city") — that's a separate gap and should be filed as its own ticket if observed.
- Major cities — they have their own entry rules (every player guaranteed at least one section).
- Variant rule overrides (Honeymoon 2-player, Challenge Game per-player limit of 2) — out of scope unless those variants are active in this implementation.
