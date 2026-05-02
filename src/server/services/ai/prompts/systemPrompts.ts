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

import { BotSkillLevel, GameContext, BotMemoryState, StrategicRoute, CorridorMap, FerryConnection, TrackSegment, GridPoint } from '../../../../shared/types/GameTypes';
import { UPGRADE_DELIVERY_THRESHOLD, UPGRADE_OPERATING_BUFFER } from '../context/UpgradeGatingConstants';

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
  [BotSkillLevel.Easy]: 'You are a competent player. Think 1-2 turns ahead.',
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

// ── Trip Planning Prompt (JIRA-126, JIRA-207B, JIRA-210B) ──

const TRIP_PLANNING_SYSTEM_SUFFIX = `
Plan one route — the best multi-stop trip for this turn.
Your route should consider all OPTIONS simultaneously.

SCORING: trip_score = (total payout - build costs - usage fees) / estimated turns
A 30M trip in 4 turns (7.5M/turn) beats a 60M trip in 12 turns (5M/turn).

ACTION GRAMMAR RULES — every stop must conform to these rules:
- DELIVER requires a prior PICKUP in the same stop sequence, OR the load must already be in your CURRENT PLAN carried loads. You cannot emit a DELIVER without first establishing how the load reached your train.
- Same-city same-load multi-load pickups must be written as SEPARATE PICKUP stops — one stop per load unit. You cannot pick up two loads with a single PICKUP stop.
- Total PICKUP stops plus carried loads (from CURRENT PLAN) must not exceed train capacity.

WORKED EXAMPLE — Cardiff×2 Hops → Holland + Ruhr (capacity 2, no loads carried):
  CORRECT (two separate PICKUPs, each for one Hops unit):
    stop 1: { "action": "PICKUP", "load": "Hops", "supplyCity": "Cardiff" }  -- picks up first Hops
    stop 2: { "action": "PICKUP", "load": "Hops", "supplyCity": "Cardiff" }  -- picks up second Hops (use the correct demandCardId per delivery below)
    stop 3: { "action": "DELIVER", "load": "Hops", "deliveryCity": "Holland", "demandCardId": 10, "payment": 16 }
    stop 4: { "action": "DELIVER", "load": "Hops", "deliveryCity": "Ruhr", "demandCardId": 7, "payment": 16 }
  WRONG (two DELIVERs with no PICKUPs — validator rejects because Hops is not in carried loads):
    stop 1: { "action": "DELIVER", "load": "Hops", "deliveryCity": "Holland", ... }
    stop 2: { "action": "DELIVER", "load": "Hops", "deliveryCity": "Ruhr", ... }

REASONING RULES:
- When arguing against a demand card based on cost, you MUST cite the exact "Build cost" M figure shown in the prompt (e.g., "supply ~12M, delivery ~8M"). Qualitative descriptions ("expensive", "significant", "substantial") without citing the specific M figure are not allowed. If you cannot cite a specific figure, do not argue against the card on cost grounds.

TRIP RULES:
1. CARRIED LOADS: Loads in your CURRENT PLAN (carried loads section) are already in your possession. Do NOT emit a PICKUP for a carried load.
2. COMBINE CORRIDORS: Two deliveries on one route beat two separate routes.
3. EXISTING TRACK FIRST: On-network stops are essentially free.
4. RUNNING CASH: Deliveries mid-trip pay out immediately. Later pickups and builds can be funded by earlier delivery income in the same trip. Evaluate affordability at the point of the action, not at turn start.
5. Keep trips to 2-6 stops.
6. PICKUP and DELIVER stops MUST reference the exact supplyCity or deliveryCity of a demand card listed in OPTIONS. If no demand card has a supply/delivery pair you need, do not emit that stop.

GEOGRAPHIC STRATEGY: Bias toward the core cluster (Paris — Ruhr — Holland — Berlin — Wien) when short on cash or cities; otherwise optimize by corridor efficiency.

CAPITAL VELOCITY: Ask "how many turns until I get PAID?" not "which pays the most?"

UPGRADE OPTIONS (20M each):
- Freight → Fast Freight: +3 speed. Best first upgrade after 1+ deliveries with 50M+ cash.
- Fast Freight/Heavy Freight → Superfreight: The endgame train.
Include "upgradeOnRoute" in your top-level response if upgrading.

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
{
  "stops": [
    { "action": "DELIVER", "load": "<carried load>", "deliveryCity": "<city name from demand card>", "demandCardId": <card number>, "payment": <payout> },
    { "action": "PICKUP", "load": "<load type>", "supplyCity": "<city name from demand card>" },
    { "action": "DELIVER", "load": "<load type>", "deliveryCity": "<city name from demand card>", "demandCardId": <card number>, "payment": <payout> }
  ],
  "reasoning": "<why this route is the best play>",
  "upgradeOnRoute": "<FastFreight|HeavyFreight|Superfreight — ONLY if upgrading, omit if not>"
}`;

/**
 * JIRA-207B: Evaluate the upgrade gate — must pass ALL three conditions.
 * Lives in the user-prompt builder so the system prompt stays byte-stable (R17).
 */
function canUpgradeThisTurn(context: GameContext, memory: BotMemoryState): boolean {
  if (!context.canUpgrade) return false;
  if (memory.deliveryCount < UPGRADE_DELIVERY_THRESHOLD) return false;
  const upgradeCost = 20; // ECU millions — standard upgrade cost
  if (context.money - upgradeCost < UPGRADE_OPERATING_BUFFER) return false;
  return true;
}

/**
 * Build the dynamic trip planning context from current game state.
 * JIRA-207B: Reframed as REPLAN prompt with CURRENT PLAN + OPTIONS sections.
 * OPTIONS filters out unaffordable cards and carry-load cards (commitments).
 * Upgrade prose is suppressed (with hard-suppression rule) when gate fails (Pattern B / R14-R17).
 * JIRA-210B: Renamed NEW OPTIONS → OPTIONS; fixed count semantics; removed chosenIndex guidance.
 */
function buildTripPlanningContext(context: GameContext, memory: BotMemoryState): string {
  const lines: string[] = [];

  // ── Upgrade gate (Pattern B — resolves here, not in system prompt) ──
  const upgradeQualified = canUpgradeThisTurn(context, memory);

  // ── Upgrade suppression rule (R15) — injected at top of user prompt when gate fails ──
  if (!upgradeQualified) {
    lines.push(`UPGRADE STATUS: You do not qualify to upgrade this turn (insufficient cash buffer or delivery count). Do NOT include "upgradeOnRoute" in your response. Treat all upgrade-related sections of the system prompt as not applicable for this turn.`);
    lines.push('');
  }

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

  // ── CURRENT PLAN block (R10a) ──
  // Build the set of demand card IDs that are "in flight" (carried load or active route stop).
  const carryLoadCardIds = new Set<number>();
  const activeRoute = memory.activeRoute;

  // Identify which demand cards correspond to loads already on the train
  const carriedLoadLines: string[] = [];
  for (const loadType of context.loads) {
    // Find the demand card for this carried load
    const matchingDemand = context.demands.find(d => d.loadType === loadType && d.isLoadOnTrain);
    if (matchingDemand) {
      carryLoadCardIds.add(matchingDemand.cardIndex);
      carriedLoadLines.push(`  Carried load: ${loadType} (card ${matchingDemand.cardIndex} → deliver to ${matchingDemand.deliveryCity} for ${matchingDemand.payout}M)`);
    } else {
      carriedLoadLines.push(`  Carried load: ${loadType} (demand card unresolved)`);
    }
  }

  // Render remaining stops of active route
  const remainingStopLines: string[] = [];
  if (activeRoute && activeRoute.stops.length > activeRoute.currentStopIndex) {
    const remaining = activeRoute.stops.slice(activeRoute.currentStopIndex);
    remaining.forEach((stop, i) => {
      const cardRef = stop.demandCardId != null ? ` (card ${stop.demandCardId})` : '';
      const paymentRef = stop.payment != null ? ` → ${stop.payment}M` : '';
      if (stop.action === 'pickup') {
        remainingStopLines.push(`  ${i + 1}. PICKUP ${stop.loadType} at ${stop.city}${cardRef}`);
      } else if (stop.action === 'deliver') {
        remainingStopLines.push(`  ${i + 1}. DELIVER ${stop.loadType} at ${stop.city}${cardRef}${paymentRef}`);
        if (stop.demandCardId != null) {
          carryLoadCardIds.add(stop.demandCardId);
        }
      }
    });
  }

  const hasPlan = remainingStopLines.length > 0 || carriedLoadLines.length > 0;
  lines.push(`CURRENT PLAN:`);
  if (!hasPlan) {
    lines.push(`(no current plan in flight)`);
  } else {
    if (remainingStopLines.length > 0) {
      lines.push(`  Remaining stops:`);
      remainingStopLines.forEach(l => lines.push(l));
    }
    if (carriedLoadLines.length > 0) {
      carriedLoadLines.forEach(l => lines.push(l));
    }
  }
  lines.push('');

  // ── OPTIONS block (JIRA-207B R10b, JIRA-210B: renamed from NEW OPTIONS) ──
  // Filter: include only cards that are (a) affordable AND (b) not already a carry-load commitment.
  const newOptionCards = context.demands.filter(d => {
    if (!d.isAffordable) return false;
    if (d.isLoadOnTrain) return false;
    return true;
  });

  const newOptionsCount = newOptionCards.length;
  const uniqueCardCount = new Set(newOptionCards.map(d => d.cardIndex)).size;
  lines.push(`OPTIONS (${newOptionsCount} supply→delivery row${newOptionsCount !== 1 ? 's' : ''} across ${uniqueCardCount} card${uniqueCardCount !== 1 ? 's' : ''}):`);
  if (newOptionsCount === 0) {
    lines.push(`(no actionable options this turn)`);
  } else {
    for (const d of newOptionCards) {
      const onNetwork = d.isSupplyOnNetwork && d.isDeliveryOnNetwork ? ' [ON-NETWORK]' : '';
      const available = d.isLoadAvailable ? '' : ' [UNAVAILABLE]';
      lines.push(`  Card ${d.cardIndex}: ${d.loadType} from ${d.supplyCity ?? '(on train)'} → ${d.deliveryCity} (${d.payout}M)${onNetwork}${available}`);
      lines.push(`    Build cost: supply ~${d.estimatedTrackCostToSupply}M, delivery ~${d.estimatedTrackCostToDelivery}M`);
      lines.push(`    Estimated turns: ${d.estimatedTurns} | Efficiency: ${d.efficiencyPerTurn.toFixed(1)}M/turn`);
    }
  }
  lines.push('');

  // Guidance: when both CURRENT PLAN and OPTIONS are non-empty, invite keep-or-replan decision
  if (hasPlan && newOptionsCount > 0) {
    lines.push(`If your current plan still represents the best play, keep it (your route's first stop should be the current plan's first remaining stop). Otherwise, propose a replan from OPTIONS.`);
    lines.push('');
  }

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

  // Upgrade info — only when gate passes (Pattern B / R16)
  if (upgradeQualified) {
    lines.push(`UPGRADE AVAILABLE: You can upgrade your train for 20M.`);
    if (context.upgradeAdvice) {
      lines.push(`Upgrade advice: ${context.upgradeAdvice}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get the system and user prompts for multi-stop trip planning (JIRA-126, JIRA-190, JIRA-207B, JIRA-210B).
 *
 * Returns { system, user } where system is byte-stable (cacheable — never varies across turns).
 * User prompt contains the dynamic game state context per turn.
 *
 * System prompt: static rules only (JIRA-210B: persona block removed; byte-stable across all skill levels)
 * User prompt: dynamic context built from current game state, including CURRENT PLAN + OPTIONS (R10),
 *              and conditional upgrade suppression rule when gate fails (R15, Pattern B).
 */
export function getTripPlanningPrompt(
  _skillLevel: BotSkillLevel,
  context: GameContext,
  memory: BotMemoryState,
): { system: string; user: string } {
  // JIRA-210B: persona block removed — system prompt is now byte-stable regardless of skill level.
  const system = TRIP_PLANNING_SYSTEM_SUFFIX;
  const dynamicContext = buildTripPlanningContext(context, memory);
  const user = `${dynamicContext}\n\nReview your CURRENT PLAN and OPTIONS. Keep the current plan if it is still optimal, or propose a replan using one or more cards from OPTIONS.`;
  return { system, user };
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
 * Build a FERRY CONNECTIONS section listing ferries fully within the corridor bounds.
 * Returns empty string if no ferry connections exist within corridor.
 */
function buildFerryConnectionsSection(
  ferryConnections: FerryConnection[],
  corridorMap: CorridorMap,
): string {
  const { minRow, maxRow, minCol, maxCol } = corridorMap;
  const inCorridor = ferryConnections.filter(fc => {
    const [a, b] = fc.connections;
    return (
      a.row >= minRow && a.row <= maxRow && a.col >= minCol && a.col <= maxCol &&
      b.row >= minRow && b.row <= maxRow && b.col >= minCol && b.col <= maxCol
    );
  });

  if (inCorridor.length === 0) return '';

  const lines = inCorridor.map(fc => {
    const [a, b] = fc.connections;
    return `  ${fc.Name}: (${a.row},${a.col}) ↔ (${b.row},${b.col}) — cost ${fc.cost}M`;
  });
  return `FERRY CONNECTIONS (within corridor):\n${lines.join('\n')}`;
}

/**
 * Build a YOUR TRACK NETWORK section showing connected chains of bot segments.
 * Returns empty string if no segments exist.
 */
function buildTrackNetworkSection(
  existingSegments: TrackSegment[],
  gridPoints: GridPoint[],
): string {
  if (existingSegments.length === 0) return '';

  // Build a city name lookup by row,col key
  const cityNameMap = new Map<string, string>();
  for (const gp of gridPoints) {
    if (gp.city?.name) {
      cityNameMap.set(`${gp.row},${gp.col}`, gp.city.name);
    }
  }

  // Walk segments adjacently to form connected chains
  // Each segment is from→to; chains share endpoints
  const remaining = [...existingSegments];
  const chains: Array<Array<{ row: number; col: number }>> = [];

  while (remaining.length > 0) {
    // Start a new chain from the first remaining segment
    const first = remaining.splice(0, 1)[0];
    const chain: Array<{ row: number; col: number }> = [
      { row: first.from.row, col: first.from.col },
      { row: first.to.row, col: first.to.col },
    ];

    // Try to extend chain at either end
    let extended = true;
    while (extended) {
      extended = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];

      for (let i = remaining.length - 1; i >= 0; i--) {
        const seg = remaining[i];
        const fromKey = `${seg.from.row},${seg.from.col}`;
        const toKey = `${seg.to.row},${seg.to.col}`;
        const headKey = `${head.row},${head.col}`;
        const tailKey = `${tail.row},${tail.col}`;

        if (fromKey === tailKey) {
          chain.push({ row: seg.to.row, col: seg.to.col });
          remaining.splice(i, 1);
          extended = true;
        } else if (toKey === tailKey) {
          chain.push({ row: seg.from.row, col: seg.from.col });
          remaining.splice(i, 1);
          extended = true;
        } else if (toKey === headKey) {
          chain.unshift({ row: seg.from.row, col: seg.from.col });
          remaining.splice(i, 1);
          extended = true;
        } else if (fromKey === headKey) {
          chain.unshift({ row: seg.to.row, col: seg.to.col });
          remaining.splice(i, 1);
          extended = true;
        }
      }
    }

    chains.push(chain);
  }

  // Format each chain with city annotations
  const chainLines = chains.map(chain => {
    const nodes = chain.map(pt => {
      const key = `${pt.row},${pt.col}`;
      const cityName = cityNameMap.get(key);
      return cityName ? `${cityName}(${pt.row},${pt.col})` : `(${pt.row},${pt.col})`;
    });
    return `  Chain: ${nodes.join(' → ')}`;
  });

  return `YOUR TRACK NETWORK:\n${chainLines.join('\n')}`;
}

/**
 * Generate system and user prompts for the Build Advisor LLM call.
 */
export function getBuildAdvisorPrompt(
  context: GameContext,
  activeRoute: StrategicRoute | null,
  corridorMap: CorridorMap,
  buildTarget?: string,
  ferryConnections: FerryConnection[] = [],
  existingSegments: TrackSegment[] = [],
  gridPoints: GridPoint[] = [],
): { system: string; user: string } {
  const targetDirective = buildTarget
    ? `Build track to connect your network to ${buildTarget}. Provide waypoints for the cheapest path.`
    : 'Build track to extend your network toward your next route stop. Provide waypoints for the cheapest path.';

  const system = `You are a railroad track building advisor for the board game Eurorails.

TRACK BUILDING RULES:
- Spend up to 20M ECU per turn. Terrain: Clear 1M, Mountain 2M, Alpine 5M, Small/Medium City 3M, Major City 5M.
- Water crossings: River +2M, Lake +3M, Ocean Inlet +3M.
- Water (~) is impassable — you CANNOT build across open water. Use ferry ports (F) to cross water.
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

  // Ferry connections section (omitted when empty)
  const ferrySection = buildFerryConnectionsSection(ferryConnections, corridorMap);
  if (ferrySection) {
    sections.push(ferrySection);
  }

  // Track network section (omitted when no segments)
  const trackSection = buildTrackNetworkSection(existingSegments, gridPoints);
  if (trackSection) {
    sections.push(trackSection);
  }

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
