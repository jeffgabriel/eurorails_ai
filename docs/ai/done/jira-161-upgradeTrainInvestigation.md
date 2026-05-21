LLM Prompting for Train Upgrades

  1. System Prompts — src/server/services/ai/prompts/systemPrompts.ts

  - Line 34: UPGRADE defined as a Phase B action in the base system prompt
  - Lines 41-44: Example action sequences showing UPGRADE usage
  - Line 52: "AFTER 4 DELIVERIES UPGRADE TRAIN ASAP" — hardcoded nudge
  - Lines 109, 205: Upgrade option listings in different prompt variants
  - Lines 322-324: Dynamic upgrade advice injected into the prompt when eligible
  - Lines 373-392: UPGRADE_BEFORE_DROP_SYSTEM_SUFFIX — dedicated system prompt suffix for the upgrade-vs-drop LLM call

  2. Context Building — src/server/services/ai/ContextBuilder.ts

  - computeUpgradeAdvice() (line 1831): Generates contextual upgrade advice based on turn number, money, train type, route lengths, and whether
  there's meaningful build work. Produces urgency-tiered messages ("URGENT", "WARNING", recommendations).
  - Lines 838-846: "STRONG UPGRADE NUDGE" for extreme cases (still on Freight at high turn numbers)
  - Lines 971-985: Injects upgrade advice into the route planning prompt when delivery count ≥ 4 and money ≥ 30
  - serializeUpgradeBeforeDropPrompt() (line 1768): Builds a dedicated prompt for the LLM when there's a cargo conflict — presents upgrade options
  vs dropping a load

  3. LLM Strategy Brain — src/server/services/ai/LLMStrategyBrain.ts

  - Line 541: Uses UPGRADE_BEFORE_DROP_SCHEMA for a structured output LLM call when deciding upgrade vs drop

  4. Schemas — src/server/services/ai/schemas.ts

  - Line 9: UPGRADE in the valid action enum
  - Line 119: UPGRADE_BEFORE_DROP_SCHEMA — structured output schema for the upgrade decision

  5. Guardrails & Gating

  - AIStrategyEngine.ts line 59: MIN_DELIVERIES_BEFORE_UPGRADE = 4 — gate constant
  - Lines 655-656, 1423-1424: JIRA-119 suppression — blocks upgrades before 4 deliveries
  - Lines 472-497: Detects cargo conflicts and triggers the upgrade-before-drop LLM call
  - GuardrailEnforcer.ts line 75: G3 blocks UPGRADE during initialBuild phase
  - TurnValidator.ts line 74: BUILD_UPGRADE_EXCLUSION — can't do both in one turn

  6. Execution

  - ActionResolver.ts line 790: resolveUpgrade() — validates upgrade path and funds
  - TurnExecutor.ts line 853: handleUpgradeTrain() — DB update + socket emit

  ---
  Debug Overlay — src/client/components/DebugOverlay.ts

  - Line 408: Players table shows trainType column for each player
  - Lines 44-45: upgradeAdvice field on turn entries
  - Lines 303-304: Captures upgradeAdvice from socket payload into turn history
  - Lines 588-589: Renders upgrade advice in the "Bot Turn" section as a yellow-bordered "Upgrade Path" card with the advice text

  ---

  ## Root Cause Analysis (2026-03-28)

  ### The Bug: Bots See "URGENT" Upgrade Advice But Never Upgrade

  The upgrade decision flow has a **redundant Gate 2** at `AIStrategyEngine.ts:651-658` that silently
  discards valid upgrade actions. The chain works like this:

  1. **Advice generated** (ContextBuilder) → "URGENT: Upgrade NOW" shown in debug overlay
  2. **LLM responds** with `upgradeOnRoute: "FastFreight"`
  3. **Gate 1** (`tryConsumeUpgrade` line 1423) → checks `deliveryCount` param → PASSES (correct data)
  4. **Gate 2** (line 655) → re-checks `memory.deliveryCount` (stale from previous turn) → **BLOCKS**
  5. `pendingUpgradeAction` silently set to `null` → upgrade never injected into turn plan
  6. Debug overlay shows the advice but no suppression reason → looks like bot ignores its own advice

  ### Three Redundant Delivery Count Gates

  | Gate | Location | Data Source | Issue |
  |------|----------|-------------|-------|
  | Gate 1 | `tryConsumeUpgrade()` line 1423 | `deliveryCount` parameter (from memory at call time) | Authoritative — works correctly |
  | Gate 2 | `takeTurn()` line 655 | `memory.deliveryCount` (stale from previous turn) | **REDUNDANT + STALE DATA** — silently blocks valid upgrades |
  | Advice gate | `serializePrompt()` line 973 | `context.deliveryCount` (from memory) | Correct gating — only shows upgrade options when eligible |

  ### Additional Issue: Advice Misaligned with Gating

  `computeUpgradeAdvice()` at line 1831 generates URGENT/WARNING messages **without checking**
  `MIN_DELIVERIES_BEFORE_UPGRADE`. This means bots see "URGENT: Upgrade NOW" even when the
  delivery count gate will block the upgrade. The advice is noise — it tells the LLM to upgrade
  when the system won't allow it.

  ### Fix Plan (Compounds project spec)

  1. **Remove Gate 2** (lines 652-658) — redundant with Gate 1
  2. **Add delivery count gate to upgrade-before-drop path** (line 468) — compensates for Gate 2 removal
  3. **Align advice with gating** — add `deliveryCount` param to `computeUpgradeAdvice()`, suppress when below threshold
  4. **Refactor `tryConsumeUpgrade` return type** — expose rejection reason for debug overlay
  5. **Add `upgradeSuppressionReason` to turn result** — thread through to debug overlay
  6. **Display suppression in debug overlay** — red-bordered card showing why upgrade was blocked

  See `.compounds/` project spec for full implementation details.
