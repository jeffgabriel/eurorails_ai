/**
 * System prompts for LLM bot skill levels.
 *
 * The common suffix (game rules + response format) is appended to every prompt,
 * followed by a skill-level modifier.
 */

import { BotSkillLevel } from '../../../../shared/types/GameTypes';

// ── Common Suffix ─────────────────────────────────────────────────────

export const COMMON_SYSTEM_SUFFIX = `
GAME RULES REFERENCE:
- Victory: 250M+ ECU cash AND track connecting 7 of 8 major cities
- Turn actions (in order): Move train → Pick up/deliver loads → Build track → End turn
- OR instead of building: Upgrade train (20M) | Discard hand (draw 3 new cards, ends turn)
- Demand cards: 3 cards, 3 demands each, only 1 per card can be fulfilled
- Track building: up to 20M per turn. Terrain costs: Clear 1M, Mountain 2M, Alpine 5M
- Ferry penalty: Lose all remaining movement, start next turn at half speed
- Track usage fee: 4M to use opponent's track per opponent per turn
- Loads: Globally limited (3-4 copies). If all on trains, no one can pick up.
- First track must start from a major city.

AVAILABLE ACTIONS:
- DELIVER: Deliver a load you're carrying at a demand city you're currently at
- MOVE: Move your train along existing track (up to speed limit)
- PICKUP: Pick up a load at a supply city you're at (if available and you have capacity)
- BUILD: Build new track extending your network (up to 20M this turn)
- UPGRADE: Buy a better train for 20M (no track building this turn)
- DISCARD_HAND: Discard all 3 demand cards, draw 3 new ones, end turn immediately
- PASS: End turn without acting

MULTI-ACTION TURNS — You SHOULD combine actions in a single turn to maximize efficiency:
- MOVE to a supply city → PICKUP a load → MOVE toward delivery city (use remaining speed)
- MOVE to a demand city → DELIVER for payout → BUILD track (up to 20M)
- MOVE to a supply city → PICKUP → continue MOVE to delivery city → DELIVER (if within speed)
- PICKUP at current city → MOVE to nearby delivery city → DELIVER
The key insight: loading/unloading does NOT cost movement points. You can MOVE partway, PICKUP, then continue MOVE with remaining speed. Always use ALL your movement points — stopping early wastes your turn.
You CANNOT combine UPGRADE (20M) with BUILD, or DISCARD_HAND with anything.

CRITICAL RULES — ALWAYS FOLLOW:
1. NEVER pick PASS if a delivery can be completed this turn (load on train + at city)
2. NEVER recommend actions that would drop cash below 5M
3. NEVER chase a demand where track cost exceeds payout unless the track serves other demands
4. In early game (first 10 turns): prioritize first delivery speed over everything else
5. Ferry crossings before turn 15 are almost always a mistake
6. DELIVERY CHAIN: To earn a payout you must (a) pick up a load at its SOURCE city, (b) carry it to the DEMAND city on your card. Only pick up loads you have a matching demand card for.
7. CHECK YOUR CARDS: Before building track, verify the destination city appears on one of your demand cards. Do not build toward a city just because a load exists there.
8. COMMIT TO YOUR PLAN: Pick ONE delivery chain (pickup city → delivery city). Build track toward it. Pick up the load. Deliver it. Do NOT change your mind mid-execution. Only reassess AFTER completing a delivery.
9. NEVER discard your hand unless you have passed 3+ turns in a row with zero progress. Discarding is an ABSOLUTE LAST RESORT.
10. STARTING LOCATION: In the first 2 build turns, prefer starting from central Europe (Ruhr, Berlin, Paris, Holland) over peripheral cities.
11. TRACK REUSE: Prefer directions that serve MULTIPLE demand chains over a single high-payment chain.
12. BUDGET AWARENESS: Before committing to a chain, verify you can afford the build cost AND have 5M+ remaining.

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
For a single action:
{
  "action": "<ACTION_TYPE>",
  "details": {
    // BUILD: { "toward": "<city name>" }
    // MOVE: { "to": "<city name>" }
    // DELIVER: { "load": "<load type>", "at": "<city name>" }
    // PICKUP: { "load": "<load type>", "at": "<city name>" }
    // UPGRADE: { "to": "<train type>" }
    // DISCARD_HAND or PASS: {} (empty)
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
}`;

// ── Route Planning Suffix ────────────────────────────────────────────

export const ROUTE_PLANNING_SYSTEM_SUFFIX = `
GAME RULES REFERENCE:
- Victory: 250M+ ECU cash AND track connecting 7 of 8 major cities
- Turn actions (in order): Move train → Pick up/deliver loads → Build track → End turn
- Demand cards: 3 cards, 3 demands each, only 1 per card can be fulfilled
- Track building: up to 20M per turn. Terrain costs: Clear 1M, Mountain 2M, Alpine 5M
- Track usage fee: 4M to use opponent's track per opponent per turn
- Loads: Globally limited (3-4 copies). If all on trains, no one can pick up.
- First track must start from a major city.

ROUTE PLANNING:
You are planning a MULTI-STOP delivery route. This route will be auto-executed across multiple turns.
Think carefully about the optimal sequence of pickups and deliveries.

ROUTE PLANNING CRITERIA:
1. COMBINE LOADS: Look for 2+ demands that share pickup/delivery corridors. Two 20M deliveries on the same route beat one 40M delivery on a separate route.
2. PICKUP BEFORE DELIVER: Always pick up a load before you can deliver it. Sequence matters.
3. BUDGET CHECK: Estimate total track building cost for the route. Don't plan routes that cost more to build than they pay out.
4. EXISTING TRACK: Prefer routes that leverage your existing network — zero-cost pickups/deliveries are the best.
5. LOAD CAPACITY: Freight/Fast Freight carry 2 loads, Heavy Freight/Superfreight carry 3. Don't plan more simultaneous pickups than your capacity allows.
6. STARTING CITY: For initial builds with no track, specify which major city to start building from (prefer central Europe).
7. ACHIEVABLE ROUTES: Keep routes to 2-4 stops. Overly ambitious routes risk failure.

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
{
  "route": [
    { "action": "PICKUP", "load": "<load type>", "city": "<city name>" },
    { "action": "DELIVER", "load": "<load type>", "city": "<city name>" }
  ],
  "startingCity": "<major city to start building from, if no track yet>",
  "reasoning": "<1-2 sentences explaining why this route>",
  "planHorizon": "<estimated turns: Build X→Y (N turns), pickup, deliver (N turns)>"
}

EXAMPLE — efficient double-delivery route:
{
  "route": [
    { "action": "PICKUP", "load": "Potatoes", "city": "Szczecin" },
    { "action": "PICKUP", "load": "Potatoes", "city": "Szczecin" },
    { "action": "DELIVER", "load": "Potatoes", "city": "Paris" },
    { "action": "DELIVER", "load": "Potatoes", "city": "Ruhr" }
  ],
  "startingCity": "Berlin",
  "reasoning": "Two potato demands share a route through central Europe. Picking up 2x at Szczecin maximizes throughput.",
  "planHorizon": "Build Berlin→Szczecin (3 turns), pickup 2x, deliver Paris then Ruhr (2 turns each)"
}`;

// ── Plan Selection Suffix ────────────────────────────────────────────

export const PLAN_SELECTION_SYSTEM_SUFFIX = `
GAME RULES REFERENCE:
- Victory: 250M+ ECU cash AND track connecting 7 of 8 major cities
- Turn: Move train (up to speed limit) → Build track (up to 20M) → End turn
- Demand cards: 3 cards, 3 demands each, only 1 per card can be fulfilled
- Track usage fee: 4M to use opponent's track
- Loads: Globally limited (3-4 copies). If all on trains, no one can pick up.

CHAIN SELECTION CRITERIA:
1. BUDGET FIRST: Never commit to a chain you can't afford. If estimated build cost > your cash, pick a cheaper chain.
2. TRACK REUSE: Prefer chains that share track corridors with other demands. Shared track is the most valuable asset.
3. SHORT CHAINS WIN: A quick 15M delivery beats a slow 40M delivery. Income-per-turn matters more than raw payment.
4. EXISTING TRACK: Chains that leverage your existing network (low/zero build cost) are almost always the best choice.
5. PICKUP PROXIMITY: If two chains pay similarly, pick the one with a closer pickup city.

RESPONSE FORMAT:
You will see ranked delivery chains. Pick the BEST one to pursue next.
Respond with ONLY a JSON object, no markdown, no commentary:
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
