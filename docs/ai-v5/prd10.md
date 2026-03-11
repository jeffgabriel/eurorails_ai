# Section 10: Archetype and Skill System

**Part of: [AI Bot Players v5 — Master Implementation Plan](./ai-bot-v5-master-plan.md)**

---

### Goal
Add the full archetype and skill level system. The Opportunist at Medium (already implemented) becomes one of 15 combinations (5 archetypes × 3 skill levels). Each archetype produces visibly different play patterns.

### Depends On
Section 7 (Strategy Inspector for observing archetype differences), Section 9 (robust error handling).

### Human Validation
1. Play 5 games, each with a different Hard-level archetype bot
2. Observe in the Strategy Inspector that each archetype makes different choices given similar cards:
   - **Backbone Builder**: Builds a central trunk line before branching; avoids isolated routes
   - **Freight Optimizer**: Combines multiple loads into efficient multi-stop trips
   - **Trunk Sprinter**: Upgrades train early; builds direct routes even through expensive terrain
   - **Continental Connector**: Prioritizes connecting major cities over maximum income
   - **Opportunist**: Chases highest immediate payout; pivots frequently
3. Play games with Easy vs Hard bots — Easy bots should make noticeably worse decisions (random suboptimality, shorter planning horizon)

### Requirements

1. **Server: ArchetypeProfile configuration**:
   - Define scoring multiplier tables for each archetype (per PRD Section 5.4.1.1)
   - Each archetype adjusts the weight of scoring dimensions (immediate income, network expansion, victory progress, etc.)
   - Archetype-specific bonus dimensions: Upgrade ROI (Trunk Sprinter), Backbone alignment (Backbone Builder), Load combination score (Freight Optimizer), Major city proximity (Continental Connector)

2. **Server: SkillProfile configuration**:
   - Easy: 20% random choices, misses 30% of best options, current-turn-only planning
   - Medium: 5% random choices, misses 10%, 2-3 turn planning horizon
   - Hard: 0% random, 0% misses, 5+ turn planning, opponent awareness

3. **Server: Scorer module**:
   - Score = Σ(base_weight × skill_modifier × archetype_multiplier × dimension_value)
   - Each feasible option scored across all dimensions
   - Highest score wins (subject to skill-level randomization)

4. **Server: Multi-turn planning (Medium and Hard)**:
   - Medium: evaluate whether current action sets up a delivery in 2-3 turns
   - Hard: evaluate all 9 demands holistically, compute optimal multi-stop routes

5. **Update Strategy Inspector**:
   - Show archetype name and philosophy in the Strategy Inspector
   - Show archetype multipliers applied to scores
   - Show skill-level effects (randomization applied, suboptimality percentage)

### Acceptance Criteria

- [ ] All 5 archetypes produce visibly different play patterns (observable in Strategy Inspector)
- [ ] Easy bots play noticeably worse than Hard bots
- [ ] Each archetype's scores reflect its multipliers (visible in scoring breakdown)
- [ ] Backbone Builder builds trunk lines; Freight Optimizer combines loads; Trunk Sprinter upgrades early; Continental Connector reaches major cities; Opportunist chases highest payouts
- [ ] All 15 combinations (5×3) are functional and don't crash
- [ ] Skill-level randomization visible in Strategy Inspector (Easy shows "random selection" notes)

---

## Related User Journeys

No dedicated user journey exists for the archetype and skill system. The behavior differences are observed through:

- **Journey 3, Scenario E (Strategy Inspector)**: The Strategy Inspector shows archetype-specific scoring weights and philosophy descriptions, making it the primary tool for validating that different archetypes produce different behavior.
- **All journeys**: The archetype system affects every bot decision. The example journeys use a `backbone_builder` archetype for Heinrich, which prioritizes track network connectivity over immediate income. Other archetypes would make visibly different choices in the same situations.
