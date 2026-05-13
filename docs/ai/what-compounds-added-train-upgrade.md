# Case study — CLI-only vs. full Compounds workflow

> A real bug fix in an AI-driven game. The same engineer (Claude) drafted a fix using just the Compounds CLI, then ran the same change through the full Compounds planning workflow. This is the side-by-side.
>
> **Important framing.** Both paths used Compounds. The question is what the **workflow** (`plan_change` → impact report → pattern detection → spec → validation) adds over **just the CLI** (semantic search and structural queries).

## The bug

In an AI-driven board game, a bot's planning brain repeatedly decided it should upgrade its train — a one-time investment that makes the rest of the game faster. Across one 90-turn game, the bot asked to upgrade **19 times**. The system honored **0** of those requests. Bots ended games on the slowest train type even while sitting on more than five times the upgrade's cost in cash.

Diagnosis: the bot's brain was emitting upgrade decisions correctly. One code path consumed those decisions and turned them into actions. A second code path — which produced most of the decisions — silently dropped them.

## Two ways to plan the fix

### Path A — CLI-only

Investigate by conversation. Use the Compounds CLI to search the codebase semantically (*"where does the bot decide to upgrade?"*, *"where does an active plan get re-evaluated?"*). The CLI surfaces the right files. Read them. Write a plan in markdown listing root cause and a sequence of code changes.

Output: one markdown file, ~80 lines.

### Path B — Full Compounds workflow

Same CLI underneath, but layered with structured planning steps:

- `plan_change` initiates a tracked workflow
- An impact report records affected components and codebase signals
- Pattern detection matches the change against a catalog of design patterns and anti-patterns
- A reference architecture is matched (in this case, "LLM-driven game agent")
- The change is scored across six complexity dimensions
- A spec is generated against a scenario template
- The spec is validated against the original scope, with explicit checks for call-path completeness

Output: a structured spec with numbered requirements, acceptance criteria bound to verifiable tests, a design-pattern reference table with diagnostics, and an executable task prompt.

## What both paths agreed on

Same root cause. Same fix shape. Same five core moves. A skilled implementing agent following either path would have ended up at roughly the same code change.

## Where the paths diverged

The fix touched several internal layers — the bot's decision turns into typed data, gets passed up through a stack of services, and eventually becomes an executed action. The CLI-only plan correctly identified the bug and the high-level structure of the fix, but it **missed two of those layers** when describing the pass-through chain.

The workflow caught them. Specifically, its pattern-detection step flagged the bug as an instance of a known anti-pattern (*silently swallowing a decision the upstream system emitted*), and its call-path validation forced an explicit trace through every hop in the chain. That trace surfaced the missing layers.

## Would the CLI-only plan have shipped a bug?

No runtime bug — but the type system would have stopped a coding agent partway through, forcing a fork:

- **Option A**: add the missing layers (clean, converges on the same final fix the workflow shipped)
- **Option B**: route the decision around the missing layers as a side-channel (compiles, works today, but quietly violates an architectural invariant the codebase had deliberately established)

Option B is the failure mode. A coding agent under time pressure could plausibly take it. The plan didn't close that exit ramp.

The workflow closed it before any code was written, by tracing the call chain explicitly during planning rather than letting the implementing agent discover it.

## What the CLI gives you, and what it doesn't

The CLI is a **lookup tool**: search, query, read. It surfaces the right files based on what you ask. That alone is a meaningful improvement over raw grep — you can ask in natural language and get architecturally relevant results.

But nothing in the CLI forces you to:

- trace every hop in a call chain
- match the change against a pattern catalog
- score the work's complexity before committing to a plan
- bind every requirement to a verifiable test
- validate the plan against the original scope

The CLI-only plan was opportunistic: search until something useful surfaced, write the plan. Layers that didn't surface naturally stayed invisible. The CLI doesn't know what you forgot to ask.

The workflow doesn't replace human judgment — it enforces the discipline that produces a plan with no exit ramps.

## The capability delta

| Capability | CLI alone | Full workflow |
|---|:-:|:-:|
| Semantic codebase search | ✓ | ✓ |
| Structural queries (callers, importers, inheritance) | ✓ | ✓ |
| Surfaces relevant entities by intent | ✓ | ✓ |
| Forces an explicit impact / call-path trace | ✗ | ✓ |
| Pattern catalog matching with diagnostics | ✗ | ✓ |
| Reference-architecture variant matching | ✗ | ✓ |
| Complexity scoring (6 dimensions) | ✗ | ✓ |
| Spec validation against scope | ✗ | ✓ |
| Numbered acceptance criteria bound to tests | ✗ | ✓ |
| Task prompts that compile-check on first read | ✗ | ✓ |

## Verdict

The CLI-only plan was directionally correct. A skilled implementing agent would likely have arrived at the same fix — most likely after hitting a compile error and choosing the right of two forks under that pressure.

The full workflow didn't replace the plan; it **completed** it. It forced the call-path trace that surfaced the missing layers, named the pattern the bug belonged to, and bound each requirement to a verifiable acceptance criterion. The implementing agent had no exit ramps left to take.

The honest framing is therefore not "Compounds vs. no Compounds" — both paths used Compounds. It's **CLI vs. CLI plus workflow**. The CLI is the floor. The workflow is the discipline that makes the floor reliable.

## Methodological note

This is a single case study with a known confound: the same engineer (Claude) wrote both artifacts and had full prior context of the bug when writing the CLI-only plan. A cleaner comparison — fresh agents on bugs neither has seen, with and without the workflow — is the next study to run.
