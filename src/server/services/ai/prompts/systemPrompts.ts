/**
 * System prompts for LLM bot skill levels.
 *
 * TRIMMING PRINCIPLES:
 * - Don't tell the LLM about things enforced by code (TurnValidator, GuardrailEnforcer,
 *   TurnComposer, PlanExecutor). The LLM's job is STRATEGY, not rules enforcement.
 * - Don't repeat game rules across prompts — each prompt gets only what it needs.
 * - Don't instruct on secondary pickups — TurnComposer Phase A1 handles opportunistic pickups.
 * - Don't instruct on DISCARD_HAND/PASS — broke-bot gate and stuck detection handle these.
 * - Don't instruct on cash sufficiency — TurnValidator enforces this.
 * - Don't instruct on movement budget — GuardrailEnforcer truncates paths.
 */

import { BotSkillLevel, GameContext, BotMemoryState, StrategicRoute, CorridorMap } from '../../../../shared/types/GameTypes';

// ── Common Suffix ─────────────────────────────────────────────────────

export const COMMON_SYSTEM_SUFFIX = `
GAME RULES REFERENCE:
- Victory: 250M+ ECU cash AND track connecting 7 of 8 major cities
- Turn actions (in order): Move train → Pick up/deliver loads → Build track OR Upgrade train (20M) → End turn
- Demand cards: 3 cards, 3 demands each, only 1 per card can be fulfilled
- Track building: up to 20M per turn. Terrain costs: Clear 1M, Mountain 2M, Alpine 5M
- Ferry penalty: Lose all remaining movement, start next turn at half speed
- Track usage fee: 4M to use opponent's track per opponent per turn
- First track must start from a major city.

AVAILABLE ACTIONS:
- DELIVER: Deliver a load you're carrying at a demand city you're currently at
- MOVE: Move your train along existing track (up to speed limit)
- PICKUP: Pick up a load at a supply city you're at (if available and you have capacity)
- DROP: Drop a load you're carrying at the current city (use when carrying a load you cannot deliver)
- BUILD: Build new track extending your network (up to 20M this turn)
- UPGRADE: Buy a better train for 20M (no track building this turn)

MULTI-ACTION TURNS — You SHOULD combine actions in a single turn to maximize efficiency:
- MOVE to a supply city → PICKUP a load → MOVE toward delivery city (use remaining speed)
- MOVE to a demand city → DELIVER for payout → BUILD track (up to 20M)
- MOVE to a supply city → PICKUP → continue MOVE to delivery city → DELIVER (if within speed)
- PICKUP at current city → MOVE to nearby delivery city → DELIVER
- MOVE to demand city → DELIVER for payout → UPGRADE train (20M, replaces BUILD this turn)
- PICKUP at current city → MOVE toward delivery → UPGRADE (when speed/cargo matters more than track)
UPGRADE replaces BUILD for this turn's Phase B (you still MOVE, PICKUP, DELIVER normally).
You CANNOT combine UPGRADE + BUILD, or DISCARD_HAND with anything.

DURING THE FIRST 10 TURNS:
. CHOOSE SHORT DELIVERIES THAT PAY < 25M and avoid ferries
. BUILD TRAIN NETWORK IN CENTRAL EUROPE FIRST, THEN EXPAND
. AVOID DELIVERIES TO UK, SPAIN, SOUTHERN ITALY, NORDIC COUNTRIES
. DELIVERY CHAIN: Plan routes with multiple pickup and deliveries at nearby locations

AFTER 4 DELIVERIES UPGRADE TRAIN ASAP

. Verify the destination city appears on one of your demand cards
. COMMIT TO YOUR PLAN
. Games typically last ~100 turns. Don't play as if the game goes on forever

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
For a single action:
{
  "action": "<ACTION_TYPE>",
  "details": {
    // BUILD: { "toward": "<city name>" }
    // MOVE: { "to": "<city name>" }
    // DELIVER: { "load": "<load type>", "at": "<city name>" }
    // PICKUP: { "load": "<load type>", "at": "<city name>" }
    // DROP: { "load": "<load type>" }
    // UPGRADE: { "to": "<train type>" }
  },
  "reasoning": "<1-2 sentences in character>",
  "planHorizon": "<what this sets up for next 2-3 turns>"
}

For multiple actions in one turn:
{
  "actions": [
    { "action": "MOVE", "details": { "to": "Vienna" } },
    { "action": "DELIVER", "details": { "load": "Wine", "at": "Vienna" } },
    { "action": "BUILD", "details": { "toward": "Budapest" } }
  ],
  "reasoning": "...",
  "planHorizon": "..."
}

PLAN PERSISTENCE:
You MUST continue your existing plan unless:
(a) The delivery was completed, or
(b) A dramatically better opportunity appeared.`;

// ── Route Planning Suffix ────────────────────────────────────────────

export const ROUTE_PLANNING_SYSTEM_SUFFIX = `
You are planning a MULTI-STOP delivery route. This route will be auto-executed across multiple turns.

ROUTE PLANNING RULES:
1. COMBINE LOADS: Look for 2+ demands that share pickup/delivery corridors. Two 20M deliveries on the same route beat one 40M delivery on a separate route.
2. PICKUP BEFORE DELIVER: Always pick up a load before you can deliver it. Sequence matters.
3. EXISTING TRACK: Prefer routes that leverage your existing network — zero-cost pickups/deliveries are the best.
4. ACHIEVABLE ROUTES: Keep routes to 2-4 stops. Overly ambitious routes risk failure.
5. VICTORY CONNECTIONS: Prefer routes that pass through unconnected major cities. Connecting major cities is required for victory (7 of 8).
6. STARTING CITY: Your train MUST start at one of the 8 major cities. Prefer central Europe (Ruhr, Berlin, Paris, Wien, Milano, Holland) over London and Madrid. Pick the major city nearest to your first planned pickup.

GEOGRAPHIC STRATEGY:
CORE NETWORK (cheap, high reuse): Paris — Ruhr — Holland — Berlin — Wien. Mostly clear terrain (1M/segment). Build here first.
PERIPHERAL (expensive, low reuse): London (ferry 8M+), Madrid (mountains), Scandinavia (ferry), deep Italy (alpine). Expand only with 80M+ cash and 2+ demands pointing there.

CAPITAL VELOCITY: A 9M delivery in 4 turns beats a 42M delivery in 12 turns. Ask "how many turns until I get PAID?" not "which pays the most?"

UPGRADE OPTIONS (20M each):
- Freight → Fast Freight: +3 speed. Almost always the right first upgrade.
- Fast Freight/Heavy Freight → Superfreight: 12 speed + 3 cargo. The endgame train.
To upgrade, include "upgradeOnRoute" in your response.

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
{
  "route": [
    { "action": "PICKUP", "load": "<load type>", "city": "<city name>" },
    { "action": "DELIVER", "load": "<load type>", "city": "<city name>" }
  ],
  "startingCity": "<major city to start building from, if no track yet>",
  "upgradeOnRoute": "<FastFreight|HeavyFreight|Superfreight — ONLY if upgrading, omit if not>",
  "reasoning": "<1-2 sentences explaining why this route>",
  "planHorizon": "<estimated turns: Build X→Y (N turns), pickup, deliver (N turns)>"
}`;

// ── Plan Selection Suffix ────────────────────────────────────────────

export const PLAN_SELECTION_SYSTEM_SUFFIX = `
Pick the BEST delivery chain to pursue next from the ranked options shown.

AFTER 10 TURNS LOOK FOR:
1. POSITIVE ROI  
2. Two demand cards with the same demand type (eg potatoes)
3. Two demand cards that have the same demand city

RESPONSE FORMAT (JSON only, no markdown):
{
  "chainIndex": <integer index of the chain to pursue, 0-based>,
  "reasoning": "<1-2 sentences explaining why this chain>"
}`;

// ── Skill Level Modifiers ─────────────────────────────────────────────

const SKILL_LEVEL_TEXT: Record<BotSkillLevel, string> = {
  [BotSkillLevel.Easy]: 'You are a casual player. Pick whatever seems good. Don\'t overthink it.',
  [BotSkillLevel.Medium]: 'You are a competent player. Think 2-3 turns ahead.',
  [BotSkillLevel.Hard]: 'You are an expert player. Think 5+ turns ahead. Consider what opponents are doing and whether you can exploit or deny their plans.',
};

/**
 * Get the full system prompt for a bot skill level.
 *
 * Combines: common game rules suffix + skill-level modifier.
 */
export function getSystemPrompt(skillLevel: BotSkillLevel): string {
  return `${COMMON_SYSTEM_SUFFIX}\n\n${SKILL_LEVEL_TEXT[skillLevel]}`;
}

/**
 * Get the system prompt for route planning (plan-then-execute architecture).
 *
 * Combines: route planning suffix + skill-level modifier.
 * Used when the bot needs to plan a new multi-stop delivery route via LLM.
 */
export function getRoutePlanningPrompt(skillLevel: BotSkillLevel): string {
  return `${ROUTE_PLANNING_SYSTEM_SUFFIX}\n\n${SKILL_LEVEL_TEXT[skillLevel]}`;
}

/**
 * Get the system prompt for plan selection (chain picking).
 *
 * Combines: plan selection suffix + skill-level modifier.
 * Used when the bot needs to pick a new delivery chain via LLM.
 */
export function getPlanSelectionPrompt(skillLevel: BotSkillLevel): string {
  return `${PLAN_SELECTION_SYSTEM_SUFFIX}\n\n${SKILL_LEVEL_TEXT[skillLevel]}`;
}

// ── Trip Planning Prompt (JIRA-126) ──

const TRIP_PLANNING_SYSTEM_SUFFIX = `
You are planning multi-stop TRIP CANDIDATES. Generate 2-3 candidate trips, then choose the best one.
Each candidate should consider ALL 3 demand cards simultaneously.

SCORING: trip_score = (total payout - build costs - usage fees) / estimated turns
A 30M trip in 4 turns (7.5M/turn) beats a 60M trip in 12 turns (5M/turn).

TRIP RULES:
1. PICKUP before DELIVER for each load. You must physically carry the load.
2. COMBINE CORRIDORS: Two deliveries on one route beat two separate routes.
3. EXISTING TRACK FIRST: On-network stops are essentially free.
4. VICTORY ROUTING: Prefer trips through unconnected major cities when payout differences are within 30%.
5. CARRIED CARGO: If you already carry loads, deliver them first if a matching demand exists.
6. Keep trips to 2-6 stops.

GEOGRAPHIC STRATEGY:
CORE (cheap, high reuse): Paris — Ruhr — Holland — Berlin — Wien. Build here first.
PERIPHERAL (expensive): London (ferry 8M+), Madrid (mountains), Scandinavia (ferry), deep Italy (alpine).
- Early game (<80M cash, <4 cities): Stay in core. Fast cheap deliveries.
- Mid game (80-180M, 4-5 cities): Expand to ONE peripheral region with 2+ demands pointing there.
- Late game (180M+, 5-6 cities): Connect remaining major cities for victory.

CAPITAL VELOCITY: Ask "how many turns until I get PAID?" not "which pays the most?"

UPGRADES (20M each):
- Freight → Fast Freight: +3 speed. Best first upgrade after 1+ deliveries with 50M+ cash.
- Fast Freight/Heavy Freight → Superfreight: The endgame train.
Include "upgradeOnRoute" in your top-level response if upgrading.

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
{
  "candidates": [
    {
      "stops": [
        { "action": "PICKUP", "load": "<load type>", "city": "<city name>" },
        { "action": "DELIVER", "load": "<load type>", "city": "<city name>", "demandCardId": <card number>, "payment": <payout> }
      ],
      "reasoning": "<why this trip is good>"
    }
  ],
  "chosenIndex": <0-based index of the best candidate>,
  "reasoning": "<why you chose this candidate over the others>",
  "upgradeOnRoute": "<FastFreight|HeavyFreight|Superfreight — ONLY if upgrading, omit if not>"
}

EXAMPLE:
{
  "candidates": [
    {
      "stops": [
        { "action": "PICKUP", "load": "Steel", "city": "Ruhr" },
        { "action": "DELIVER", "load": "Steel", "city": "Paris", "demandCardId": 31, "payment": 15 },
        { "action": "PICKUP", "load": "Wine", "city": "Paris" },
        { "action": "DELIVER", "load": "Wine", "city": "Wien", "demandCardId": 42, "payment": 22 }
      ],
      "reasoning": "Core double-delivery. Steel on-network, delivers to Paris, picks up Wine for Wien."
    },
    {
      "stops": [
        { "action": "PICKUP", "load": "Coal", "city": "Ruhr" },
        { "action": "DELIVER", "load": "Coal", "city": "Berlin", "demandCardId": 55, "payment": 9 }
      ],
      "reasoning": "Quick single delivery, all on-network. 2 turns."
    }
  ],
  "chosenIndex": 0,
  "reasoning": "37M in ~5 turns (7.4M/turn) beats 9M in 2 turns (4.5M/turn).",
  "upgradeOnRoute": "FastFreight"
}`;

/**
 * Build the dynamic trip planning context from current game state.
 */
function buildTripPlanningContext(context: GameContext, memory: BotMemoryState): string {
  const lines: string[] = [];

  // Position and cargo
  const posStr = context.position?.city
    ? `at ${context.position.city}`
    : context.position
      ? `at (${context.position.row},${context.position.col})`
      : 'unknown';
  lines.push(`CURRENT STATE:`);
  lines.push(`- Position: ${posStr}`);
  lines.push(`- Cash: ${context.money}M ECU`);
  lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity})`);
  lines.push(`- Carried loads: ${context.loads.length > 0 ? context.loads.join(', ') : 'none'}`);
  lines.push(`- Turn: ${context.turnNumber}`);
  lines.push(`- Deliveries completed: ${memory.deliveryCount}`);
  lines.push('');

  // Victory progress
  lines.push(`VICTORY PROGRESS:`);
  lines.push(`- Connected major cities (${context.connectedMajorCities.length}/${context.totalMajorCities}): ${context.connectedMajorCities.join(', ') || 'none'}`);
  if (context.unconnectedMajorCities.length > 0) {
    const unconnected = context.unconnectedMajorCities
      .map(c => `${c.cityName} (~${c.estimatedCost}M to connect)`)
      .join(', ');
    lines.push(`- Unconnected: ${unconnected}`);
  }
  lines.push('');

  // Network topology
  lines.push(`NETWORK TOPOLOGY:`);
  lines.push(`- Track summary: ${context.trackSummary}`);
  lines.push(`- Cities on network: ${context.citiesOnNetwork.length > 0 ? context.citiesOnNetwork.join(', ') : 'none'}`);
  lines.push('');

  // All 3 demand cards with details
  lines.push(`DEMAND CARDS (all 3 — evaluate simultaneously):`);
  for (const d of context.demands) {
    const onNetwork = d.isSupplyOnNetwork && d.isDeliveryOnNetwork ? ' [ON-NETWORK]' : '';
    const affordable = d.isAffordable ? '' : ' [UNAFFORDABLE]';
    const available = d.isLoadAvailable ? '' : (d.isLoadOnTrain ? ' [ON TRAIN]' : ' [UNAVAILABLE]');
    const ferry = d.ferryRequired ? ' [FERRY]' : '';
    lines.push(`  Card ${d.cardIndex}: ${d.loadType} from ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M)${onNetwork}${affordable}${available}${ferry}`);
    lines.push(`    Build cost: supply ~${d.estimatedTrackCostToSupply}M, delivery ~${d.estimatedTrackCostToDelivery}M`);
    lines.push(`    Estimated turns: ${d.estimatedTurns} | Efficiency: ${d.efficiencyPerTurn.toFixed(1)}M/turn`);
  }
  lines.push('');

  // Available pickups
  if (context.canPickup.length > 0) {
    lines.push(`AVAILABLE PICKUPS (at current location):`);
    for (const p of context.canPickup) {
      lines.push(`  - ${p.loadType} at ${p.supplyCity} (best payout: ${p.bestPayout}M → ${p.bestDeliveryCity})`);
    }
    lines.push('');
  }

  // Immediate deliveries
  if (context.canDeliver.length > 0) {
    lines.push(`IMMEDIATE DELIVERIES (can complete this turn):`);
    for (const d of context.canDeliver) {
      lines.push(`  - ${d.loadType} at ${d.deliveryCity} for ${d.payout}M (card ${d.cardIndex})`);
    }
    lines.push('');
  }

  // Upgrade info
  if (context.canUpgrade) {
    lines.push(`UPGRADE AVAILABLE: You can upgrade your train for 20M.`);
    if (context.upgradeAdvice) {
      lines.push(`Upgrade advice: ${context.upgradeAdvice}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get the system prompt for multi-stop trip planning (JIRA-126).
 *
 * Builds a rich context from game state and instructs the LLM to generate
 * 2-3 candidate trips scored by netValue/estimatedTurns.
 */
export function getTripPlanningPrompt(
  skillLevel: BotSkillLevel,
  context: GameContext,
  memory: BotMemoryState,
): string {
  const dynamicContext = buildTripPlanningContext(context, memory);
  return `${TRIP_PLANNING_SYSTEM_SUFFIX}\n\n${dynamicContext}\n\n${SKILL_LEVEL_TEXT[skillLevel]}`;
}

// ── Cargo Conflict Prompt (JIRA-92) ──

const CARGO_CONFLICT_SYSTEM_SUFFIX = `
Should the bot DROP a carried load to free cargo slots for a better planned route?

DECISION CRITERIA:
1. If the carried load's delivery is IMMINENT (1-2 turns away on existing track), KEEP it.
2. If the carried load's delivery is EXPENSIVE or DISTANT, dropping it for a better route is correct.
3. When in doubt, KEEP.

RESPONSE FORMAT (JSON only, no markdown):
{
  "action": "drop" | "keep",
  "dropLoad": "load type to drop (required if action is drop)",
  "reasoning": "Brief explanation"
}`;

/**
 * Get the system prompt for cargo conflict evaluation (JIRA-92).
 */
export function getCargoConflictPrompt(): string {
  return CARGO_CONFLICT_SYSTEM_SUFFIX;
}

// ── Upgrade-Before-Drop Prompt (JIRA-105b) ──

const UPGRADE_BEFORE_DROP_SYSTEM_SUFFIX = `
Should the bot UPGRADE its train instead of DROPPING a load to resolve a cargo conflict?

DECISION CRITERIA:
1. If the upgrade lets the bot deliver ALL loads and net benefit is positive, upgrade.
2. Upgrading is permanent — 3 cargo slots for the rest of the game. Long-term value.
3. When in doubt, UPGRADE.

RESPONSE FORMAT (JSON only, no markdown):
{
  "action": "upgrade" | "skip",
  "targetTrain": "target train type (required if action is upgrade)",
  "reasoning": "Brief explanation"
}`;

/**
 * Get the system prompt for upgrade-before-drop evaluation (JIRA-105b).
 */
export function getUpgradeBeforeDropPrompt(): string {
  return UPGRADE_BEFORE_DROP_SYSTEM_SUFFIX;
}

// ── Build Advisor Prompt (JIRA-129) ────────────────────────────────────

/**
 * Generate system and user prompts for the Build Advisor LLM call.
 */
export function getBuildAdvisorPrompt(
  context: GameContext,
  activeRoute: StrategicRoute | null,
  corridorMap: CorridorMap,
  buildTarget?: string,
): { system: string; user: string } {
  const targetDirective = buildTarget
    ? `Build track to connect your network to ${buildTarget}. Provide waypoints for the cheapest path.`
    : 'Build track to extend your network toward your next route stop. Provide waypoints for the cheapest path.';

  const system = `You are a railroad track building advisor for the board game Eurorails.

TRACK BUILDING RULES:
- Spend up to 20M ECU per turn. Terrain: Clear 1M, Mountain 2M, Alpine 5M, Small/Medium City 3M, Major City 5M.
- Water crossings: River +2M, Lake +3M, Ocean Inlet +3M.
- Track must connect to your existing network or start from a major city.

OPPONENT TRACK: You may use an opponent's track for 4M ECU per opponent per turn.

${targetDirective}
Answer with waypoints (row, col coordinates) — the pathfinding algorithm determines the exact route.

Actions: "build", "useOpponentTrack"`;

  const sections: string[] = [];

  sections.push(`CORRIDOR MAP:\n${corridorMap.rendered}`);
  sections.push(`CONNECTED MAJOR CITIES: ${context.connectedMajorCities.join(', ') || 'None'}`);
  sections.push(`CITIES ON NETWORK: ${context.citiesOnNetwork.join(', ') || 'None'}`);

  if (activeRoute) {
    const stops = activeRoute.stops.map((s, i) => {
      const marker = i === activeRoute.currentStopIndex ? ' [CURRENT]' : '';
      return `  ${i + 1}. ${s.action} ${s.loadType} at ${s.city}${s.payment ? ` (${s.payment}M)` : ''}${marker}`;
    }).join('\n');
    sections.push(`ACTIVE ROUTE (phase: ${activeRoute.phase}):\n${stops}`);
  } else {
    sections.push('ACTIVE ROUTE: None');
  }

  sections.push(`CASH: ${context.money}M ECU`);
  sections.push(`CARRIED LOADS: ${context.loads.length > 0 ? context.loads.join(', ') : 'None'}`);
  sections.push(`GAME PHASE: ${context.phase} | Turn ${context.turnNumber}`);

  // JIRA-148: Demand cards intentionally omitted — BuildAdvisor is a tactical
  // pathfinding tool, not a strategic planner. Including demand cards caused
  // the LLM to override the computed build target with its own route selection.

  return { system, user: sections.join('\n\n') };
}

/**
 * Build a compact extraction prompt for two-pass structured extraction.
 */
export function getBuildAdvisorExtractionPrompt(
  rawText: string,
  targetCity: { row: number; col: number },
  frontier: Array<{ row: number; col: number }>,
): { system: string; user: string } {
  const frontierStr = frontier.slice(0, 5).map(f => `(${f.row},${f.col})`).join(', ');

  const system = `Extract structured data from a track building advisor's text response.

OUTPUT FORMAT (JSON):
- action: one of "build", "useOpponentTrack"
- target: city name string
- waypoints: array of [row, col] coordinate pairs (integers)
- reasoning: brief summary

Target city: (${targetCity.row},${targetCity.col}). Frontier: ${frontierStr || 'none'}.
If no coordinates mentioned, infer waypoints between frontier and target.`;

  return { system, user: rawText };
}
