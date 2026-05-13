# How Compounds Helped During the JIRA-195 Refactor Plan

**Context:** Matt asked me to audit the bot's turn-orchestration architecture and write a plain-English refactor plan (`jira-195-turnOrchestrationRefactor.md`). He then had a second AI peer-review the plan (`jira-195-critique.md`), which caught eight substantive errors. He then asked me to run my own plan back through Compounds to verify.

This note is an honest report for the Compounds team — what helped, and what I'd ask for next.

## Summary

Compounds helped **confirm and locate** the refactor's largest targets and gave a useful project-shape overview at session start. The plan's structural errors were mostly my own fault — I used a grep-based subagent for call-graph work where a `compounds query … -r calls` would have been faster and more correct. The specific things I'd ask the team for below are genuine product asks, not workarounds for outages.

## Where Compounds clearly helped

1. **Entity location and project status.** `compounds status` confirmed the repo was indexed (8,323 entities). `compounds query "RouteOptimizer" --type structural --show-code` cleanly returned the class definition with source, which was enough to confirm the file and shape. This is the base case and it works reliably.

2. **Community map + bridge entities at session start.** The startup codebase report (14 communities, top bridge entities, high-connectivity list like `computeBuildSegments:34`, `hexDistance:34`) gave me a useful mental map before I wrote anything. The "services/ai" community at 224 entities with 0.03 cohesion accurately predicted that the AI layer is large and weakly modular — which is exactly what the refactor ticket is about. This was a genuinely valuable framing tool I wouldn't have had from grep.

3. **Disambiguating "TurnComposer."** Matt asked about "turn composer." No file has that name — it was replaced during JIRA-156. The semantic search returned `BotTurnTrigger`, `TurnExecutor`, `TurnExecutorPlanner` ranked by score, which was enough to realise the term was historical. A text-only `find` would have returned nothing. This is the kind of question where Compounds is strictly better than grep.

4. **Post-critique verification.** When I needed to check the critique's claims, Compounds entity lookup plus targeted reads validated all eight points quickly. The `ContextBuilder` size (3063 LOC), five prompt serializers at specific line numbers, two re-snapshot sites — all confirmed with a mix of Compounds queries and targeted file reads. The semantic layer made it fast to know *where* to look.

## Product asks

These are things that would have caught more of my plan's errors on the first pass.

1. **`-r calls` returning complete results for indexed entities.** `compounds query "RouteOptimizer" --type structural -r calls --show-code` returned "No results found," but `RouteOptimizer.orderStopsByProximity` is in fact called from `TripPlanner.ts:332`. This was the single query that would have prevented my plan's biggest error — claiming `TurnExecutorPlanner` invoked `RouteOptimizer` when it doesn't. If the call-graph extraction is partial for a given project or language, surfacing that as a "partial graph — consider falling back to text search" hint would be hugely valuable; right now an empty result is indistinguishable from "no callers exist."

2. **A first-class way to list a class's members.** To find the five prompt serializers in `ContextBuilder.ts` (`serializePrompt`, `serializeRoutePlanningPrompt`, `serializeSecondaryDeliveryPrompt`, `serializeCargoConflictPrompt`, `serializeUpgradeBeforeDropPrompt`) I fell back to `grep -n "serialize" ContextBuilder.ts`. `compounds query "ContextBuilder"` returns the class itself, not its methods. A `--show-members` or `--methods` flag would turn god-object audits from grep work into a single structural query — and god-object audits are exactly the kind of architectural question Compounds should own.

3. **Actionable guidance for the entity/embedding mismatch warning.** `compounds status` showed `⚠ Inconsistency: 8323 entities vs 6954 embeddings`. Helpful to know, but the message doesn't tell me what's affected — can semantic search still rank reliably? Does it explain empty relationship results? A one-line "this may affect X queries; run `compounds clean && compounds index` to resolve" would let me make a better triage decision mid-investigation.

## What I would have done differently

With hindsight, the ~3-minute investigation that would have saved me from shipping a flawed plan was:

```bash
compounds query "RouteOptimizer" -r calls
compounds query "BuildAdvisor" -r calls
compounds query "RouteEnrichmentAdvisor" -r calls
compounds query "ContextBuilder" --show-code
compounds query "TurnExecutorPlanner" -r calls
```

Five queries. Had I run all five, the plan would have been structurally correct on the first pass — advisor locations, prompt serializers in `ContextBuilder`, and the nested `TripPlanner` call inside `TurnExecutorPlanner`'s Phase A would all have been visible from the graph. I jumped to a grep-based subagent when I should have stayed in Compounds. That's on me, not the tool.

## Net value

Compounds provided real value in this session:

- Semantic search finding the right entities when the user's term ("turn composer") didn't match any filename.
- Fast, reliable confirmation of entity definitions and file locations.
- Community/bridge map gave useful project-shape context at session start — a view I'd have no way to build from grep.
- Post-hoc verification of the critique was quick.

The areas above (complete `-r calls` results, a class-members query, clearer status warnings) are the product gaps I'd flag. None of them are dealbreakers; all three would move Compounds from "great for locating entities" to "strictly better than grep for every architectural question." The foundation is solid; these are polish items on top of it.

## One honest note on my own usage

The reason my plan had errors is not that Compounds was missing anything fundamental — it's that I didn't lean on it as hard as I should have. CLAUDE.md is explicit that Compounds is the first-choice tool for architectural questions, and I spent part of this session in grep-first habits. The critiquing AI apparently did the call-graph work that I skipped, and caught me. Next time I have a question like "where is this advisor called from," my first move is `compounds query … -r calls` — not grep, not a subagent.
