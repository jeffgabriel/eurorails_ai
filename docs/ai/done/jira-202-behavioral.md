# JIRA-202 — Bot defers delivery when arriving at destination city on the last milepost

When a bot uses its full movement budget (9 or 12 mileposts) to arrive exactly at the delivery city for its current carried load, it does not execute the delivery that turn. The bot ends the turn parked at the destination city with the load still on board, then delivers on the *next* turn — wasting the income that could have been collected immediately and forfeiting the build/upgrade spend that could have been funded by it.

## Game evidence — `1e87e2aa-b177-4bf4-9a99-8666ab517e71`

Haiku, holding a Tourists demand card paying 19M to Torino:

| Turn | Start cash | Carried | Movement | End position | Delivered? | Built/Upgraded? |
|---|---|---|---|---|---|---|
| 5 | 26M | Tourists | 9/9 mileposts | **Torino** (deliver-stop city) | **No** | No build (had no cash income that turn) |
| 6 | 26M | Tourists | 9 mileposts | back at (33,37) | yes (paid 19M, cash → 45M, then 38M after build) | 7M build *after* delivery |

T5 ended with the bot parked at the delivery city, demand card matching, load on board, and zero income. The delivery shifted to T6, dragging the post-delivery build with it.

## Why it matters

A wasted turn is the highest-cost mistake a bot can make per the project's North Star: capital sits idle, the income-velocity loop stalls, and the build/upgrade spend that the delivery payout would have funded slips a turn. Across a game, a bot that hits this on every long-haul delivery could lose 5–10 turns of compounding spend.
