# Compounds Skill Missed Log

Tracks when the compounds skill was not used or was skipped even though it should have been used.

| Date | Task/Context | Why It Was Missed | What Would Have Helped |
|------|-------------|-------------------|----------------------|
| 2026-02-14 | Fix frontier move distance bonus in Scorer | Plan already identified exact file/function/lines; single-file 5-line edit with known fields on the type | N/A — direct file read was sufficient for this targeted fix |
| 2026-02-22 | Investigate what planRoute() receives — is it enough? | Read systemPrompts.ts, ContextBuilder.ts, LLMStrategyBrain.ts directly without first using compounds | Compounds could have immediately surfaced the old `demandProximityBonus`/`rankDemandChains` geographic clustering (deleted in v6.3) and confirmed it was never replaced in the LLM context. Used compounds after user reminded me. |
