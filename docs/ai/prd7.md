# Section 7: Strategy Inspector — Full Debug and Decision Transparency

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
Upgrade the debug overlay into a comprehensive Strategy Inspector that shows complete AI decision-making transparency: all options considered, scores, rejection reasons, and the selected plan. This is the primary tool for tuning bot behavior in later sections.

### Depends On
Section 6 (bot makes meaningful decisions to inspect).

### Human Validation
1. Start a game with 1 human + 1 bot
2. Press backtick (`) to open the debug overlay
3. After the bot completes a turn, the Bot Turn section now shows:
   - **Selected Plan**: What the bot chose to do and why, in plain English
   - **All Options Considered**: A ranked table of every feasible option with scores
   - **Rejected Options**: A collapsible section showing options that failed feasibility checks, with specific reasons
   - **Scoring Breakdown**: For the selected option, show each scoring dimension and its contribution
   - **Turn Timeline**: A step-by-step execution log (moved to X, picked up Y, built Z)
4. Historical turns: toggle between "Latest Turn" and previous turns (last 10 turns stored)
5. All data updates automatically when the bot completes a turn

### Requirements

1. **Server: Complete StrategyAudit data**:
   - Each bot turn produces a `StrategyAudit` object containing:
     - `snapshotSummary`: key snapshot data (position, money, loads, demands)
     - `feasibleOptions[]`: each with type, parameters, score, scoring breakdown by dimension
     - `infeasibleOptions[]`: each with type, parameters, rejection reason
     - `selectedPlan`: the chosen option with rationale
     - `executionResults[]`: step-by-step execution (action, result, duration)
     - `durationMs`: total turn time
   - Store in `bot_turn_audits` table and emit in `bot:turn-complete` socket event

2. **Client: Enhanced debug overlay — Strategy Inspector**:
   - **Selected Plan panel**: Plain-English description: "Delivered Wine to Vienna for $48M. Chose this because it was the highest-scoring option (score: 87)."
   - **Options table**: Sortable/ranked table with columns: Rank, Type, Description, Score, Status (✅ selected, feasible, ❌ rejected)
   - **Rejected options**: Collapsible section, each with specific rejection reason: "Steel pickup at Birmingham — REJECTED: All 3 Steel loads on other trains"
   - **Scoring breakdown**: For the selected option, show each dimension (immediate income, income per milepost, network expansion, etc.) with weight × value = contribution
   - **Turn timeline**: Chronological list of execution steps with timing
   - **History navigation**: Arrow buttons to view previous turns (last 10 stored per bot)

3. **Client: Multi-bot support in overlay**:
   - If multiple bots exist, show tabs or a selector for each bot
   - Each bot's data is independent

### Acceptance Criteria

- [ ] Strategy Inspector shows complete decision data for each bot turn
- [ ] All feasible options listed with scores in ranked order
- [ ] Rejected options listed with specific reasons
- [ ] Scoring breakdown shows dimension-level detail for selected option
- [ ] Turn timeline shows step-by-step execution
- [ ] Can navigate between last 10 turns per bot
- [ ] Multi-bot games show data for each bot independently
- [ ] Data updates automatically when bot completes a turn

---

## Related User Journeys

### Journey 3: Scenario E — Strategy Inspector

After Heinrich's turn completes, Alice clicks Heinrich's brain icon (🧠) in the leaderboard.

**Strategy Inspector Modal opens showing:**
- **Archetype:** "Backbone Builder" with blue badge
- **Philosophy:** Description of the backbone_builder strategy
- **Skill Level:** "Easy" badge
- **Current Plan:** e.g., "Build track toward Wien to deliver Steel"
- **Options Considered:** Table of scored options:
  | Option | Score | Bar |
  |--------|-------|-----|
  | BuildTowardMajorCity(Wien) | 0.85 | █████████░ |
  | DeliverLoad(Steel→Wien) | 0.72 | ███████░░░ |
  | PickupLoad(Coal) | 0.45 | ████░░░░░░ |
  | PassTurn | 0.10 | █░░░░░░░░░ |
- **Selected option** marked with ✓
- **Rejected options** (collapsible): options that failed validation, with rejection reasons
- **Bot Status:** Cash: 72M, Train: Freight, Loads: [Steel], Cities: 2, Turn: 20, Think time: 847ms
