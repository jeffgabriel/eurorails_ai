# JIRA-207 — Technical fix plan

Companion to `jira-207-behavioral.md`.

## Root causes

Four distinct defects collide on a single turn. Each has a different fix surface and can ship independently, but they share one trait: the trip-planner LLM is being asked to do strategic reasoning over a prompt that is simultaneously under-specified about action grammar and over-loaded with noise.

### 1. Same-city `PICKUP`-before-`DELIVER` is not enforced in the prompt or the validator's recovery path, AND `systemPrompts.ts:188` is misleading the LLM into thinking ON-NETWORK demands skip pickup

`src/server/services/ai/prompts/systemPrompts.ts:255-264` builds the demand card section. It tells the LLM what loads are available and where, but never states the action grammar invariant: **every load delivered in a candidate must be either already on the train OR picked up earlier in the same candidate's stop sequence**. The validator catches the violation, but the LLM has no way to recover except by retrying — and the retry path (issue #3) doesn't tell it which rule it broke.

This particularly bites for *same-city multi-load* plays. The mental model "I pick up X at city A and deliver it to city B" generalizes naturally to one pickup per delivery, but the game allows (and rewards) picking up multiple instances of the same load type from a single supply city in one stop sequence.

**Compounding cause from `systemPrompts.ts:188`:**

```
8. ON-NETWORK DEMAND REQUIRED AS CANDIDATE: If any demand card is marked [ON-NETWORK]
   in your context (meaning both its supply and delivery cities are already on your rail
   network, requiring zero build cost), you MUST include the highest net-value such demand
   as an explicit candidate — even if a higher-payout off-network demand exists.
   Mentioning it only in reasoning text is NOT sufficient; it must appear as a complete
   candidate with stops.
```

The phrase "**a complete candidate with stops**" is intended to mean "a fully-formed candidate object with a `stops` array, as opposed to merely mentioning the demand in your `reasoning` text." The LLM, however, parses "complete" as "self-contained, no other steps required" and concludes that an ON-NETWORK card can be a candidate consisting of just `DELIVER` — no PICKUP. The T10 chosen-candidate reasoning literally cites this hallucinated rule: *"staying compliant with the rule that ON-NETWORK demands must appear as a complete candidate."*

The intent of the rule is to force the LLM to PROPOSE the ON-NETWORK option (so it doesn't get reasoned-away into reasoning text only). The LLM is mis-applying it as "ON-NETWORK options skip pickup."

### 2. Stated build costs get re-interpreted qualitatively in the LLM's reasoning step

The prompt provides numeric `Build cost: supply ~XM, delivery ~YM` for every demand card (`systemPrompts.ts:262`) and a per-card `Estimated turns / Efficiency` line (`systemPrompts.ts:263`). But the LLM's free-form `reasoning` field, which it writes alongside each candidate, does not have to ground its statements in those numbers. The observed T9 output for candidate 2 says *"significant delivery build cost"* for Ruhr — the prompt said `~6M`. The LLM is not lying; it is generating natural-language plausibility-text that doesn't reference the structured numbers it was given.

There is no mechanism telling the LLM "you must cite the exact `Build cost` figure when arguing against a card based on cost."

### 3. Retry feedback is a single sentence, not a per-candidate diagnostic

`src/server/services/ai/TripPlanner.ts:286-298` (the no-route fallback path) and the surrounding retry construction emit `PREVIOUS ATTEMPT FAILED: All candidates failed validation` to the next prompt iteration. There is no per-candidate breakdown ("candidate 2 was missing PICKUP for Hops at Cardiff before delivering to Ruhr") because the upstream `selectionDiagnostic` (`TripPlannerSelectionDiagnostic`) tracks *which* candidate the LLM chose and *what fallback* fired, but does not track *why each rejected candidate failed*.

The result: when the LLM's retry receives the failure message, it cannot localize the bug to a specific candidate or a specific stop. It defends the entire response shape away.

### 4. The prompt shows demand cards the bot cannot afford this turn, advertises an upgrade option that's strategically wrong to take, and decorates demands with redundant `[FERRY]` tags

Three distinct prompt-noise issues in the same construction site:

- **Unaffordable cards** (`systemPrompts.ts:258`): every demand card is listed unconditionally. Cards tagged `[UNAFFORDABLE]` cannot be acted on this turn (their build cost exceeds the bot's cash). They consume LLM attention and chain-of-thought tokens for no benefit. In the T9 example, 4 of the 9 listed demands were `[UNAFFORDABLE]` — that's almost half the prompt's demand section devoted to noise.

- **Upgrade advertisement gating** (`systemPrompts.ts:286-291`): the gate today is just `context.canUpgrade`, set in `src/server/services/ai/context/BuildContext.ts:56-...` (`checkCanUpgrade`). For a Freight train the only requirement is `money >= 20`. At T9 with 37M cash and 2 deliveries completed, the bot technically *can* upgrade, but doing so would leave 17M — below the 20M-per-turn build budget, with no operating buffer for opponent-track fees or unforeseen builds. The upgrade option is being surfaced to the LLM at exactly the moment it's the wrong play, and the LLM picked up on it (`"upgradeOnRoute": "FastFreight"` in both call's responses).

  **Note on scope:** the prompt has additional upgrade references beyond line 286-291 — the action-type listing at `systemPrompts.ts:34`, the strategic patterns at `:41-43`, the full `UPGRADE OPTIONS (20M each)` sections at `:101-104` and `:194-197`, and the response-schema fields `"upgradeOnRoute"` at `:113` and `:213`. Gating ONLY line 286-291 hides the advertise-it-now line but leaves the LLM with full awareness that upgrading is an option (and the schema still accepts `upgradeOnRoute`). See **Product Decision 5** below for the in-scope-now / follow-up boundary.

- **Redundant `[FERRY]` tag** (`systemPrompts.ts:260`): every demand card whose route involves a ferry crossing gets a `[FERRY]` tag appended. The information is already encoded in the per-card `Build cost`, `Estimated turns`, and `Efficiency` figures — `DemandEngine` factors ferry costs and ferry-induced turn delays into those numbers. The tag invites the LLM to apply *additional* defensive reasoning on top of numbers that already account for ferries. Removing the tag does not lose information; it removes an opportunity for the LLM to double-count the ferry penalty.

## Fix plan

Each fix is independently shippable. Recommended sequence: 4 first (smallest diff, biggest noise reduction), then 1 (highest leverage on the actual missed play), then 3 (improves all multi-stop quality), then 2 (longest-tail, least concrete).

### Fix 4 — Filter the prompt to actionable signal only

**4a. Drop `[UNAFFORDABLE]` cards from the prompt entirely.**

In `systemPrompts.ts:255-264`, filter `context.demands` before iterating:

```
const actionable = context.demands.filter(d => d.isAffordable);
```

Render only `actionable`. If `actionable.length === 0`, append a single explicit line: `(no actionable demand cards this turn — consider discarding the hand)`. This is more useful than listing 3 cards the bot can't act on.

**Rationale:** the LLM does not need to consider unaffordable demands when planning *this turn's* trip. The cards remain in the bot's hand; on a future turn when cash is higher, they will become affordable and reappear. Filtering them out preserves all information the LLM actually needs for *this* decision.

**Edge case:** demands tagged `[UNAFFORDABLE]` that are also `[ON-NETWORK]` are extremely rare (the build cost is what makes them unaffordable; on-network demands have ~0M build cost). Treat the filter as `isAffordable === true`, no special case.

**4b. Drop the `[FERRY]` tag from rendered demand cards.**

In `systemPrompts.ts:260-261`, remove the `[FERRY]` tag from the rendered card line. The `Build cost`, `Estimated turns`, and `Efficiency` figures already account for ferry costs and ferry-induced turn delays via `DemandEngine`. Surfacing the tag in addition to those numbers invites the LLM to double-count the ferry penalty in its qualitative reasoning.

```
// Before:
const ferry = d.ferryRequired ? ' [FERRY]' : '';
lines.push(`  Card ${d.cardIndex}: ${d.loadType} from ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M)${onNetwork}${affordable}${available}${ferry}`);

// After:
lines.push(`  Card ${d.cardIndex}: ${d.loadType} from ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M)${onNetwork}${affordable}${available}`);
```

`d.ferryRequired` may still be useful internally to other systems, so leave the field on the demand model — only the rendered prompt loses the tag.

**4c. Gate the `UPGRADE AVAILABLE` advertisement behind two additional conditions beyond `canUpgrade`, sourced from a new constants module.**

**4c-i. Define a constants module.** Create `src/server/services/ai/constants/UpgradeGating.ts` (or extend an existing AI-tunables file if one is the established home — e.g., the file where `GEMINI3_THINKING_RESERVE` lives could host these too). Export:

```ts
/**
 * Minimum number of completed deliveries before the trip-planner prompt
 * advertises the upgrade option to the LLM. Tunable.
 */
export const UPGRADE_DELIVERY_THRESHOLD = 2;

/**
 * Minimum cash the bot must retain *after* paying the upgrade cost in order
 * for the upgrade option to be advertised in the trip-planner prompt. Tunable.
 *
 * Example: at UPGRADE_OPERATING_BUFFER=30M and Freight upgrade cost=20M,
 * the bot must have money >= 50M for the upgrade option to surface.
 */
export const UPGRADE_OPERATING_BUFFER = 30;  // ECU millions
```

These values are intentionally tunable. Do NOT inline the numbers anywhere — both the prompt-render gate and any unit tests must import from the constants module so a single edit re-tunes the system.

**4c-ii. Apply the gate.** In `systemPrompts.ts:286-291`, change the gate from:

```
if (context.canUpgrade) { ... }
```

to require all three of:

1. `context.canUpgrade === true` (the existing check — bot has enough cash for the upgrade itself)
2. `context.deliveriesCompleted >= UPGRADE_DELIVERY_THRESHOLD` — bot is past the early-game phase where each delivery is critical
3. `context.bot.money - upgradeCost >= UPGRADE_OPERATING_BUFFER` — taking the upgrade leaves enough cash to fund a full build turn (and then some) afterward

`context.deliveriesCompleted` is already surfaced in the prompt's `CURRENT STATE` block as `Deliveries completed: N` — confirm it is also exposed on the `context` object passed to the prompt builder; surface it if not.

**4c-iii. Scope: full omission of all upgrade references when the bot doesn't qualify (Decision 5 = B, LOCKED).**

When the gate at 4c-ii fails (any of `canUpgrade`, `deliveriesCompleted`, or `money - upgradeCost` thresholds not met), every upgrade reference visible to the LLM must be suppressed:

| Site | File:Line | Today's content | Gating approach |
|---|---|---|---|
| Turn-action listing | `systemPrompts.ts:21` | `Move → Pick up/deliver → Build track OR Upgrade train (20M) → End turn` | Conditionally render two variants: with upgrade (qualifying) and without (non-qualifying) |
| Action-type description | `systemPrompts.ts:34` | `UPGRADE: Buy a better train for 20M (no track building this turn)` | Suppress this line when gate fails |
| Strategic pattern bullets | `systemPrompts.ts:41-43` | `MOVE → DELIVER → UPGRADE`; `PICKUP → MOVE → UPGRADE`; constraints | Suppress these three lines when gate fails |
| Schema comment | `systemPrompts.ts:60` | `// UPGRADE: { "to": "<train type>" }` | Suppress when gate fails |
| `UPGRADE OPTIONS` block | `systemPrompts.ts:101-104` | Full upgrade options + advice | Suppress entire block when gate fails |
| Schema field `upgradeOnRoute` | `systemPrompts.ts:113` | `"upgradeOnRoute": "<...>"` schema example | **Cannot be removed from the schema.** When gate fails, inject a hard suppression rule (see below). |
| `UPGRADES` block (alt prompt) | `systemPrompts.ts:194-197` | Upgrade options + advice | Suppress entire block when gate fails |
| Schema field `upgradeOnRoute` (alt prompt) | `systemPrompts.ts:213` | Schema example | Same hard suppression rule |
| `UPGRADE AVAILABLE` line | `systemPrompts.ts:286-291` | Already gated in 4c-ii | (No change beyond 4c-ii) |

**Hard suppression rule for the schema field.** Since `"upgradeOnRoute"` is part of the structured-output schema and cannot be removed, instead inject a rule at the top of the user prompt when the gate fails:

```
UPGRADE STATUS: You do not qualify to upgrade this turn (insufficient cash buffer
or delivery count). Do NOT include "upgradeOnRoute" in your response. Treat all
upgrade-related sections of the system prompt as not applicable for this turn.
```

This rule overrides the schema field availability behaviorally without changing the schema. If the LLM populates `upgradeOnRoute` despite the rule, downstream code at `NewRoutePlanner.ts:475-501` already validates upgrade affordability and rejects it.

**Implementation pattern.** Many of these sites are inside the system prompt (static prose). Two viable patterns:

- **Pattern A (split):** maintain two variants of the system prompt (one with all upgrade content, one without) and select at construction time based on the gate. Cleaner but doubles maintenance surface for upgrade content.
- **Pattern B (template variables):** parameterize the system prompt with `{{upgrade_section}}` placeholders that are populated with full content or empty strings depending on the gate. Single source of truth; small templating engine needed.

Recommend Pattern B for maintainability — the upgrade prose lives in one place, gated rendering happens in one place. Confirm in implementation.

**Regression risk:** the affected prompts (`getInitialBuildPrompt`, `getRoutePlanningPrompt`, others) are consumed by `NewRoutePlanner` and `RouteEnrichmentAdvisor` in addition to `TripPlanner`. Verify that gating upgrade content in those callers' prompts doesn't break their own upgrade-decision logic. If their gate semantics differ from `TripPlanner`'s (e.g., `NewRoutePlanner` may want a different threshold), surface that as a follow-up — for this JIRA, apply the same gate uniformly and document deviations as out-of-scope.

### Fix 1 — Teach the multi-load same-city pattern in the prompt and require pickup-before-delivery

**1a. System prompt (or rules block in the user prompt) gains a worked example.**

In whichever prompt file the trip-planner system prompt lives (or a rules section near `systemPrompts.ts:255`), add:

```
ACTION GRAMMAR RULES (must be followed in every candidate):

- Every DELIVER stop must be preceded in the same candidate by either:
  (a) a PICKUP stop for the same load type at a supply city, OR
  (b) the load already on the train at the start of the turn (see "Carried loads")
- A single PICKUP stop picks up ONE load. To carry two loads of the same type from
  the same city in one trip, write TWO PICKUP stops at that city.
- The bot's train has a load-capacity limit (see CURRENT STATE). The total number of
  PICKUPs in a candidate (plus any carried loads) must not exceed capacity.

EXAMPLE (multi-load same-city pickup):
  Position: at Cardiff. Capacity: 2. Two demand cards both pick up Hops at Cardiff,
  one delivering to Holland, one to Ruhr.

  Correct candidate stops:
    1. PICKUP Hops at Cardiff (demandCardId: 7)
    2. PICKUP Hops at Cardiff (demandCardId: 10)
    3. DELIVER Hops to Holland (demandCardId: 10, payment: 16)
    4. DELIVER Hops to Ruhr (demandCardId: 7, payment: 16)

  WRONG (missing PICKUP actions — validator rejects this):
    1. DELIVER Hops to Ruhr
    2. DELIVER Hops to Holland
```

**1b. The schema validator should already catch this.** Verify in `TripPlanner.ts` (the candidate-validation pass) that any `DELIVER` whose load is not present in carried loads at that point in the candidate's simulated state requires a prior `PICKUP` of the same load type at an accessible supply city. If the validator's existing check is correct, this is a no-op verification step.

**1c. Per-stop demandCardId on PICKUP is preserved.** When the same load type is picked up twice from the same city for two different demand cards, each PICKUP must carry its own `demandCardId` so the validator can match each PICKUP to its corresponding DELIVER. The candidate format already supports this (the response example for T9 candidate 2 included `demandCardId` on PICKUPs in the second-call retry — see `responseText` on the second `planTrip` call); the prompt just needs to make the requirement explicit.

### Fix 3 — Per-candidate, per-rule retry feedback

**3a. Track per-candidate failure reasons during validation.**

Where validation iterates over the LLM's `candidates[]` array (in `TripPlanner.ts`), accumulate a structured failure list:

```
type CandidateFailure = {
  candidateIndex: number;
  failedRule: 'missing_pickup' | 'capacity_exceeded' | 'city_not_on_route' | 'load_not_at_supply' | ...;
  detail: string;  // e.g., "DELIVER Hops to Ruhr at stop 0 has no preceding PICKUP and no carried Hops load"
};
```

Replace the current single-line `PREVIOUS ATTEMPT FAILED: All candidates failed validation` with a structured per-candidate breakdown:

```
PREVIOUS ATTEMPT — VALIDATION FEEDBACK:

Candidate 0: VALID (you may keep this exact stops list)
Candidate 1: INVALID — missing_pickup: DELIVER Potatoes to Wien (stop 2) requires
             PICKUP Potatoes at Szczecin earlier in the candidate, but no such PICKUP
             was present and Potatoes is not in the bot's carried loads.
Candidate 2: INVALID — missing_pickup: DELIVER Hops to Ruhr (stop 0) requires
             PICKUP Hops at Cardiff earlier in the candidate. Same issue for
             DELIVER Hops to Holland (stop 1).

To fix candidate 2: prepend two PICKUP Hops at Cardiff stops (one per demandCardId).
Capacity is 2; this fits.
```

The "To fix" suggestion is optional but cheap to generate when the rule is `missing_pickup` — the structured failure already names the missing actions.

**3b. The `tripPlannerSelection` diagnostic logged at `TripPlanner.ts:286-298` and `:360-368` should grow a sibling `candidateFailures: CandidateFailure[]` field** so the same per-candidate breakdown is captured in the LLM transcript. This serves both the retry prompt and post-game debugging.

### Fix 5 — Selection fallback: when the LLM-chosen candidate fails validation but another candidate in the same response is valid, use the next-best valid candidate instead of returning no-route

**Defect location:** `src/server/services/ai/TripPlanner.ts:258-307`. The `chosen_not_in_validated` branch (introduced under JIRA-206 ADR-2) deliberately returns `route: null` when `chosenIndex` doesn't survive validation. The intent of ADR-2 was "respect the LLM's intent — don't silently substitute a different candidate the LLM didn't pick." The unintended consequence: when the LLM picks an *invalid* candidate (e.g., missing PICKUP) and the same response contains a *valid* candidate the LLM ranked lower, no-route propagates → heuristic fallback fires → bot DiscardHand → the demand card the valid candidate was about to deliver is destroyed. T10 of game `5302ee21` shows this exact failure: candidate 0 invalid, candidate 1 viable, system returned no-route, heuristic chose DiscardHand, Card 7 lost.

**Fix:** when `chosenIndex` fails validation BUT `affordableCandidates.length > 0` (there is at least one validated candidate in the same response), select the next-best validated candidate (i.e., the existing `bestIdx` fallback path that is currently used for `chosen_zero_stops`). Emit a new `selectionDiagnostic.fallbackReason` value, e.g., `'chosen_invalid_alternative_used'`, so the override is auditable in the LLM transcript.

**Concretely, in `TripPlanner.ts:258-307`:** replace the no-route return with a fallback-to-bestIdx path, gated on `affordableCandidates.length > 0`. Only return no-route when there is *no* valid candidate in the response at all.

```ts
// Replacement for the chosen_not_in_validated branch (TripPlanner.ts:258-307):
} else if (chosenCandidateIdx < 0 && llmProvidedChosenIndex) {
  if (affordableCandidates.length > 0) {
    // NEW: chosenIndex was invalid, but a valid candidate exists in the same response.
    // Use the highest-scoring valid candidate. This avoids cascading to no-route → heuristic
    // → DiscardHand when the LLM-provided alternatives include a viable plan.
    selectedIdx = bestIdx;
    selectionDiagnostic = {
      llmChosenIndex: ci,
      actualSelectedLlmIndex: affordableCandidates[bestIdx].llmIndex,
      fallbackReason: 'chosen_invalid_alternative_used',  // NEW enum value
      candidates: /* same diag candidates construction as today's no-route branch */,
    };
    console.log(`[TripPlanner] chosen_invalid_alternative_used: chosenIndex ${ci} failed validation; falling back to bestIdx ${bestIdx} (llmIndex ${affordableCandidates[bestIdx].llmIndex})`);
  } else {
    // No valid alternative in the response — preserve existing no-route behavior.
    // (the current chosen_not_in_validated diagnostic and return route: null path)
  }
}
```

**Rationale for overriding ADR-2 in this case:** the original ADR-2 reasoning was "respect the LLM's intent — don't substitute a candidate the LLM didn't pick." That reasoning assumes the LLM's chosen candidate is *valid but suboptimal*. When the chosen candidate is *invalid*, the LLM's intent is unrealizable as stated; respecting "the LLM's intent" by failing the entire turn destroys more value than substituting the LLM's own lower-ranked validated candidate. ADR-2 should be amended: respect chosenIndex when it validates; substitute when it does not AND a sibling validates.

**Diagnostic fidelity:** the new `fallbackReason: 'chosen_invalid_alternative_used'` keeps the override fully auditable. Post-hoc analysis can identify cases where the LLM's chosenIndex would have been invalid, evaluate whether the substitute play was strategically sensible, and use that signal to prioritize prompt improvements.

### Fix 2 — Cite-the-number reasoning constraint

**2a. Add to the system prompt's reasoning rules:**

```
REASONING RULES:

- When you argue against a demand card based on cost, you MUST cite the exact
  Build cost figure shown for that card. Use the "Build cost: supply ~XM,
  delivery ~YM" line as your authority.
- Do NOT use qualitative words ("significant", "substantial", "expensive") to
  describe a build cost without first stating the actual M figure from the prompt.
```

**2b. (Optional, lower priority)** A post-hoc check on the LLM's `reasoning` strings could flag candidates whose reasoning contradicts the stated cost (e.g., "significant" used while the actual cost is < 10M). This is a heuristic and not strictly necessary; the prompt rule above is the lower-risk first move.

## Acceptance criteria

- **AC1** — When `context.demands` contains demand cards with `isAffordable === false`, those cards are NOT included in the rendered `DEMAND CARDS` section of the trip-planner user prompt.
- **AC2** — When all `context.demands` are unaffordable, the rendered prompt includes the line `(no actionable demand cards this turn — consider discarding the hand)` instead of an empty section.
- **AC3** — The `[FERRY]` tag does NOT appear on any rendered demand-card line in the trip-planner user prompt.
- **AC4** — `UPGRADE_DELIVERY_THRESHOLD` and `UPGRADE_OPERATING_BUFFER` are exported from a single constants module (e.g., `src/server/services/ai/constants/UpgradeGating.ts`); both the prompt-rendering code and any tests import from there. No literal numeric value for either constant appears outside that module.
- **AC5** — Initial values: `UPGRADE_DELIVERY_THRESHOLD === 2` and `UPGRADE_OPERATING_BUFFER === 30` (ECU millions).
- **AC6** — The `UPGRADE AVAILABLE` line and its `Upgrade advice` companion line are rendered only when ALL of: `context.canUpgrade === true`, `context.deliveriesCompleted >= UPGRADE_DELIVERY_THRESHOLD`, AND `context.bot.money - upgradeCost >= UPGRADE_OPERATING_BUFFER`.
- **AC7** — The trip-planner system prompt contains an `ACTION GRAMMAR RULES` block stating that every `DELIVER` requires a prior `PICKUP` (or carried-load) of the same load type, and that two same-city same-load pickups must be written as two separate `PICKUP` stops.
- **AC8** — The trip-planner system prompt contains a `REASONING RULES` block requiring the LLM to cite the exact `Build cost` figure when arguing against a card based on cost.
- **AC9** — When the validator rejects one or more candidates, the retry prompt includes a per-candidate breakdown listing each failed candidate's index, the specific validation rule that failed, and a one-sentence detail naming the offending stop and load.
- **AC10** — The `tripPlannerSelection` diagnostic emitted to the LLM transcript includes a `candidateFailures` array matching the retry breakdown.
- **AC11** — Existing trip-planner unit tests continue to pass.
- **AC12** — A new unit test reproduces the JIRA-207 T9 scenario: bot at Cardiff, capacity 2, deliveries completed 2, cash 37M, two Hops cards (one to Holland on-network, one to Ruhr at 6M build cost) plus the unaffordable cards as in the actual game, and verifies that on a fresh prompt build (a) the unaffordable cards are filtered, (b) the `[FERRY]` tag does not appear, (c) the upgrade line is gated off (with `THRESHOLD=2`, `BUFFER=30`, the bot has 2 deliveries → meets threshold, but `37 - 20 = 17 < 30` → fails buffer), and (d) the action grammar example is present.
- **AC13** — A new unit test verifies that when an LLM response contains a candidate missing a `PICKUP`, the validator emits a `CandidateFailure` with `failedRule === 'missing_pickup'` and a detail string naming the missing pickup, and the retry prompt includes that detail.
- **AC14** — A new unit test verifies that adjusting `UPGRADE_DELIVERY_THRESHOLD` or `UPGRADE_OPERATING_BUFFER` in the constants module changes the gate behavior in the prompt builder without further code edits (i.e., the constants are not duplicated in the prompt builder).
- **AC15** — The `systemPrompts.ts:188` ON-NETWORK rule is rewritten to remove the misleading "complete candidate with stops" phrasing. The new wording must clearly state that the rule applies to *which demands must be proposed as candidates* and that the proposed candidate still requires the normal `PICKUP` → `DELIVER` action grammar.
- **AC16** — When the trip-planner LLM response provides a `chosenIndex` that fails validation BUT the response contains at least one other validated candidate, `TripPlanner` selects the highest-scoring validated candidate from the same response and emits `selectionDiagnostic.fallbackReason === 'chosen_invalid_alternative_used'`. The bot does NOT cascade to no-route or DiscardHand in this case.
- **AC17** — When the trip-planner LLM response provides a `chosenIndex` that fails validation AND the response contains NO other validated candidates, `TripPlanner` preserves the existing no-route behavior with `selectionDiagnostic.fallbackReason === 'llm_rejected_validated'`. (Regression guard for the no-valid-alternative case.)
- **AC18** — A new unit test reproduces the JIRA-207 T10 scenario: LLM response with three candidates where chosenIndex=0 is invalid (missing PICKUP) and candidate 1 is a valid Cardiff PICKUP → Ruhr DELIVER; verifies the fallback selects candidate 1 with `fallbackReason === 'chosen_invalid_alternative_used'`, and the resulting `route` is non-null.
- **AC19** — When the upgrade gate fails, the rendered system + user prompt for `TripPlanner` contains NONE of the following strings: `Upgrade train (20M)` (from `:21`), `UPGRADE: Buy a better train` (from `:34`), `MOVE to demand city → DELIVER for payout → UPGRADE` (from `:41`), `PICKUP at current city → MOVE toward delivery → UPGRADE` (from `:42`), `UPGRADE replaces BUILD for this turn's Phase B` (from `:43`), `UPGRADE OPTIONS (20M each)` (from `:101`), `UPGRADES (20M each)` (from `:194`), or `UPGRADE AVAILABLE` (from `:286`).
- **AC20** — When the upgrade gate fails, the rendered user prompt contains the exact suppression rule: `UPGRADE STATUS: You do not qualify to upgrade this turn (insufficient cash buffer or delivery count). Do NOT include "upgradeOnRoute" in your response. Treat all upgrade-related sections of the system prompt as not applicable for this turn.`
- **AC21** — When the upgrade gate passes (qualifying state), all upgrade references appear in the prompt as they do today, and the suppression rule is NOT present.
- **AC22** — A unit test verifies AC19 + AC20 + AC21 against the qualifying and non-qualifying states by toggling `context.deliveriesCompleted` and `context.bot.money` across the gate boundary.
- **AC23** — `NewRoutePlanner` and `RouteEnrichmentAdvisor` callers (which consume some of the same upgrade-prose blocks) continue to function: existing tests for those callers pass without modification, and an integration-level smoke test confirms a qualifying-state run still emits `upgradeOnRoute` in their flows when their own logic decides to upgrade.

## Out of scope

- Adding a `cityConnectionBonus` to the per-card efficiency metric. The behavioral ticket flagged this as a contributing factor but the technical fix for the efficiency metric is **explicitly excluded from this JIRA per scope decision.** A separate ticket may follow.
- Auditing other LLM-driven advisors (BuildAdvisor, RouteEnrichmentAdvisor) for the same prompt-noise issues. Those have their own scope; this ticket is `TripPlanner` only.
- Changing `DemandEngine.estimatedTrackCostToSupply / estimatedTrackCostToDelivery` accuracy. If those numbers are wrong, that's a separate cost-model bug.
- Removing or repurposing the `d.ferryRequired` field on the demand model itself. Only the rendered prompt loses the `[FERRY]` tag (Fix 4b). Other systems that consume the field internally are unchanged.
- The full multi-stop validator's grammar — only the `missing_pickup` failure case needs the new structured-failure shape for this ticket. Other failure rules can adopt the same pattern in follow-ups.

## Product decisions

1. **`UPGRADE_DELIVERY_THRESHOLD` initial value.** Ship at **2**. The constant is exported from `src/server/services/ai/constants/UpgradeGating.ts` (or an equivalent tunables module) so it can be tweaked without code changes elsewhere. Alternatives: 0 (advertise from turn 1, useful only if combined with a strict `OPERATING_BUFFER`), or 5+ (defer upgrade option further into the game). Lower values surface the option sooner; higher values keep the bot focused on delivery throughput before optimizing speed.

2. **`UPGRADE_OPERATING_BUFFER` initial value.** Ship at **30** (ECU millions). With Freight upgrade cost = 20M, this means the bot needs `money >= 50M` for the upgrade option to surface. The constant is exported from the same tunables module. Alternatives: 20M (one build budget; bot at exactly 40M can upgrade and still afford one full build turn), or 40M+ (more conservative — bot must have substantial reserve before considering a non-revenue spend).

3. **Should the retry feedback include "To fix candidate N: ..." suggestions, or just the diagnostic?** Recommend including the fix suggestion when the rule is `missing_pickup` (cheap to generate from the same data). If other failure rules surface in practice, decide per-rule whether suggestions are tractable.

4. **Should `[UNAFFORDABLE]` cards be filtered from the prompt entirely (recommended), or filtered into a separate "future considerations" section?** Recommend full filter. A separate section reintroduces the noise problem under a different heading. The cards remain in the hand and reappear next turn if cash changes.

5. **Upgrade-omission scope (LOCKED = B).** All upgrade references in the LLM prompt are suppressed when the bot doesn't qualify. See Fix 4c-iii for the full site list and implementation patterns. Specifically: turn-action listing (`:21`), action-type description (`:34`), strategic-pattern bullets (`:41-43`), schema comment (`:60`), `UPGRADE OPTIONS` block (`:101-104`), `UPGRADES` block (`:194-197`), and the existing `UPGRADE AVAILABLE` block (`:286-291`). The `upgradeOnRoute` schema field at `:113` and `:213` cannot be removed from the schema; instead, a `UPGRADE STATUS: You do not qualify ... Do NOT include "upgradeOnRoute" ...` hard-suppression rule is injected at the top of the user prompt when the gate fails.

   This carries higher regression risk on `NewRoutePlanner` and `RouteEnrichmentAdvisor` paths that consume the same prompts. Verify each caller's upgrade-decision logic is preserved. Apply the same gate uniformly; surface any caller-specific gate-semantic deviations as follow-up tickets.
