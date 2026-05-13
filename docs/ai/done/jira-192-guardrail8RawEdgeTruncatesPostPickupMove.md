# JIRA-192: Bot wastes movement after pickup when its path crosses a major city

## What you'll see in a game

The bot moves to a city, picks up a load, and then just... stops. It had movement left and its own track stretching toward the next destination, but the train sits where it picked up the load.

Concrete example from game `1c2dadeb`, turn 8, Haiku:
- Bot starts at (17,31) with a freight train (9 mileposts of movement).
- Moves 7 mileposts to Cardiff and picks up Hops.
- Sits in Cardiff. Did not use the remaining 2 mileposts toward Frankfurt, even though its own track was already built that direction.

The turn log even shows the planner intended to do more: the action sequence is `MoveTrain → PickupLoad → MoveTrain`, and the budget reads `9/9 used, wasted 0`. So the brain composed a 9-milepost plan. But only 7 mileposts of movement actually executed.

## Why it doesn't happen on a normal trip through a major city

A bot that moves a single time through a major city (no pickup mid-turn) is unaffected. It still feels the same underlying counting mismatch, but the safety check only knows how to "fix" the problem by chopping off a *trailing* movement step. With one movement step, there's nothing to chop, so the bot rolls through fine.

The problem only surfaces when the turn contains **two** movement steps — which is exactly what happens when a pickup or delivery splits the turn into "move → action → keep moving."

## What's actually broken

There are two ways the system measures movement:

- **Effective mileposts** — what the game rules actually charge you. Hops through a major city's red area are free, so they don't count.
- **Raw path edges** — the literal number of grid hops on the path, intra-city hops included.

Almost everything in the bot's planning code uses effective mileposts (which is correct). The trip planner, the route truncation, the post-turn "how far did I move" reporting — all aligned on effective mileposts.

One safety check did not get the memo. After all the planning is done, a final guardrail (`Guardrail 8` in `GuardrailEnforcer.ts`) takes one last look at the plan and asks: "is this asking the train to move farther than its speed allows?" It answers that question by counting *raw* edges. So a plan that's 9 effective mileposts but passes through a major city — say, 11 raw edges total because of two free intra-city hops — looks to the guardrail like an over-budget plan.

The guardrail then "fixes" the plan by trimming edges off the last movement step. Often the last movement step is short (the small post-pickup continuation), so trimming a few edges erases it entirely.

That's why the trace shows the second MoveTrain in the plan but the bot never moves it: the second MoveTrain was deleted between planning and execution.

## How we know that's the cause

Three things line up:

1. **A nearly identical bug existed before** in the old `TurnComposer.ts` and was fixed under JIRA-62 (`docs/ai/done/jira-62-a2ContinuationIntraCityTruncation.md`). That ticket spelled out the same raw-vs-effective confusion. The old composer was deleted, but the safety guardrail still has the bug.
2. **The math matches the symptom exactly.** First move: 7 effective mp / ~9 raw edges (Cardiff path passes through a major city's red area). Second move: 2 effective / 2 raw. Guardrail sees raw total of ~11 against a budget of 9, looks for 2 edges to strip, and finds them in the 2-edge second move — which it then removes outright.
3. **The composition trace is captured before the guardrail runs**, which explains why the trace cheerfully reports `9/9 used` and lists the second MoveTrain in the output, while the actual movement total reported by the executor is only 7. The two numbers come from before and after the guardrail mutation.

## Why this matters

This is a quiet but recurring loss of efficiency. Every turn where the bot picks up (or delivers) mid-turn AND its outbound path touches a major city's red area, it's likely losing 1–2 mileposts of movement. Over a game, that's wasted turns, slower deliveries, and worse cash flow — all of which directly hurt the bot's competitiveness against the win conditions (7 cities + ECU 250M).

It's also extra confusing to debug because the trace and the executed result disagree. Anyone reading the logs sees a plan that "worked" and a turn that didn't.

## What the fix needs to do

The guardrail needs to count movement the same way the rest of the system does — in effective mileposts, ignoring free hops through major city red areas. Two specific spots in `GuardrailEnforcer.ts` need updating:

1. The summing step that decides whether the plan is over budget at all.
2. The trimming step that walks the path backwards removing edges. It needs to skip free intra-city edges when deciding how many edges actually need to come off.

The reference implementation already exists in `ActionResolver.resolveMove` — it walks the path, only counting non-intra-city edges, and stops when the effective budget is hit. The same helper logic should be applied here.

After the fix:
- Plans that genuinely exceed the speed limit still get truncated correctly.
- Plans that look over-budget only because of free major-city hops are accepted as-is.
- Bots stop losing the post-pickup continuation move when their route happens to traverse a major city.

## Suggested test

Reproduce a scenario where the bot has a multi-step plan (move → pickup → move) whose first move passes through a major city. The plan should survive the guardrail intact, and the actual mileposts moved should match what the planner intended. A unit test on `GuardrailEnforcer.checkPlan` with a hand-constructed plan and a stubbed `majorCityLookup` is enough to lock in the behavior.

## Related work

- JIRA-62 — same bug class, fixed in the now-deleted `TurnComposer`. This is essentially "JIRA-62 part 2" for the guardrail layer.
- JIRA-110 (Bug 3) — `milepostsMoved` reporting was migrated to use effective lengths. This ticket finishes propagating that same correction into the guardrail.
