/**
 * ContextSerializer — Prompt serializers for the bot's LLM context.
 *
 * Owns the five prompt-serialization methods and their format helpers,
 * extracted from ContextBuilder as part of JIRA-195 Slice 1 decomposition.
 *
 * Methods:
 *   - serializePrompt (main decision prompt)
 *   - serializeRoutePlanningPrompt (TripPlanner route selection prompt)
 *   - serializeSecondaryDeliveryPrompt (post-delivery opportunistic pickup prompt)
 *   - serializeCargoConflictPrompt (cargo conflict resolution prompt)
 *   - serializeUpgradeBeforeDropPrompt (upgrade vs drop evaluation prompt)
 *
 * Also exports format helpers used by the serializers:
 *   - formatDemandView (unified demand view for LLM prompts — JIRA-133)
 *   - isFerryOnRoute, countFerryCrossings (ferry route detection)
 *
 * JIRA-195: This module is now self-contained and does NOT import ContextBuilder.
 * ContextBuilder re-exports these methods for backward compatibility.
 */

import {
  GameContext,
  WorldSnapshot,
  BotSkillLevel,
  GridPoint,
  TrackSegment,
  RouteStop,
  StrategicRoute,
  DemandContext,
  EnRoutePickup,
  TrainType,
  TRAIN_PROPERTIES,
  TerrainType,
} from '../../../../shared/types/GameTypes';
import { hexDistance } from '../MapTopology';
import { estimateTrackCost } from '../context/DemandEngine';
import { MIN_DELIVERIES_BEFORE_UPGRADE } from '../AIStrategyEngine';

/** Major cities in the cheap, dense core of the map */
const CORE_CITIES = new Set(['Paris', 'Ruhr', 'Holland', 'Berlin', 'Wien']);

/** Corridor of demands sharing pickup/delivery routes */
interface Corridor {
  demandIndices: number[];
  sharedDeliveryArea: string;
  combinedPayout: number;
  combinedTrackCost: number;
  onTheWayDemands: number[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CORRIDOR_DELIVERY_THRESHOLD = 8;
const CORRIDOR_SUPPLY_THRESHOLD = 12;
const ON_THE_WAY_THRESHOLD = 5;
const CORRIDOR_RADIUS = 5;
const PROXIMITY_THRESHOLD = 5;
const MAX_NEARBY_PER_STOP = 5;

// ── Geographic region constants ─────────────────────────────────────────────
const BRITAIN_CITIES = new Set([
  'Aberdeen', 'Birmingham', 'Cardiff', 'Dover', 'Glasgow', 'Harwich',
  'Liverpool', 'London', 'Manchester', 'Newcastle', 'Plymouth',
  'Portsmouth', 'Southampton', 'Stranraer',
]);
const IRELAND_CITIES = new Set([
  'Belfast', 'Cork', 'Dublin',
]);
const SCANDINAVIA_CITIES = new Set([
  'Oslo', 'Stockholm', 'Goteborg', 'Kobenhavn', 'Arhus',
]);

function getCityRegion(cityName: string): 'britain' | 'ireland' | 'scandinavia' | 'continent' {
  if (BRITAIN_CITIES.has(cityName)) return 'britain';
  if (IRELAND_CITIES.has(cityName)) return 'ireland';
  if (SCANDINAVIA_CITIES.has(cityName)) return 'scandinavia';
  return 'continent';
}

export function isFerryOnRoute(
  supplyCity: string | null,
  deliveryCity: string,
  gridPoints: GridPoint[],
): boolean {
  for (const gp of gridPoints) {
    if (gp.terrain === TerrainType.FerryPort || (gp as { isFerryCity?: boolean }).isFerryCity) {
      const cityName = gp.city?.name;
      if (cityName === supplyCity || cityName === deliveryCity) return true;
    }
  }
  if (!supplyCity) return false;
  return getCityRegion(supplyCity) !== getCityRegion(deliveryCity);
}

export function countFerryCrossings(
  supplyCity: string | null,
  deliveryCity: string,
  _gridPoints: GridPoint[],
): number {
  if (!supplyCity) return 0;
  const supplyRegion = getCityRegion(supplyCity);
  const deliveryRegion = getCityRegion(deliveryCity);
  if (supplyRegion === deliveryRegion) return 0;
  const regions = new Set([supplyRegion, deliveryRegion]);
  if (regions.has('continent') && regions.has('ireland')) return 2;
  return 1;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function cityRegionTag(city: string): 'core' | 'peripheral' {
  return CORE_CITIES.has(city) ? 'core' : 'peripheral';
}

function formatDemandVictoryNote(
  d: DemandContext,
  unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>,
): string {
  const unconnected = unconnectedMajorCities.filter(
    u => u.cityName === d.supplyCity || u.cityName === d.deliveryCity,
  );
  if (unconnected.length === 0) return '';
  const names = unconnected.map(u => u.cityName);
  return ` — routes near ${names.join(', ')} (unconnected)`;
}

function formatVictoryBonus(
  d: DemandContext,
  unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>,
): string {
  const unconnected = unconnectedMajorCities.filter(
    (u) => u.cityName === d.supplyCity || u.cityName === d.deliveryCity,
  );
  if (unconnected.length === 0) return '';
  const parts = unconnected.map(
    (u) => `route passes near ${u.cityName} (unconnected, ~${u.estimatedCost}M to connect)`,
  );
  return `VICTORY BONUS: ${parts.join('; ')}`;
}

function bestDemandForCard(demands: DemandContext[]): DemandContext {
  if (demands.length === 1) return demands[0];
  const scored = demands.map((d) => {
    let score = 0;
    if (d.isSupplyOnNetwork && d.isDeliveryOnNetwork) score += 1000;
    else if (d.isSupplyOnNetwork || d.isDeliveryOnNetwork) score += 500;
    score -= (d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery);
    if (d.supplyCity && CORE_CITIES.has(d.supplyCity)) score += 20;
    if (CORE_CITIES.has(d.deliveryCity)) score += 20;
    if (d.ferryRequired) score -= 50;
    if (!d.isLoadAvailable) score -= 200;
    return { d, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].d;
}

export function formatReachabilityNote(d: DemandContext, skillLevel: BotSkillLevel): string {
  if (!d.isLoadAvailable) {
    return `UNAVAILABLE — all ${d.loadType} copies on other trains.`;
  }
  if (d.supplyCity === 'NoSupply') {
    return `UNAVAILABLE — no ${d.loadType} available at any supply city.`;
  }
  const scarcitySuffix = (d.loadChipCarried >= d.loadChipTotal - 1 && d.isLoadAvailable)
    ? `. SCARCE: ${d.loadChipCarried}/${d.loadChipTotal} carried`
    : '';
  const ferry = d.ferryRequired ? ' Requires ferry crossing (movement penalty).' : '';
  const affordabilityTag = (cost: number): string => {
    if (cost <= 0) return '';
    const turnsNeeded = Math.ceil(cost / 20);
    if (turnsNeeded > 1) return ` (~${cost}M track needed, ${turnsNeeded} build turns)`;
    return ` (~${cost}M track needed)`;
  };
  if (d.isLoadOnTrain) {
    if (d.isDeliveryReachable) return `DELIVERABLE NOW for ${d.payout}M${ferry}${scarcitySuffix}`;
    if (d.isDeliveryOnNetwork) return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} ON YOUR TRACK — MOVE toward it!${ferry}${scarcitySuffix}`;
    if (skillLevel === BotSkillLevel.Easy) return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} not reachable.${ferry}${scarcitySuffix}`;
    return `${d.loadType} ON YOUR TRAIN. ${d.deliveryCity} needs track${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
  }
  if (d.isSupplyReachable && d.isDeliveryReachable) return `Supply at ${d.supplyCity} (reachable). Delivery reachable.${ferry}${scarcitySuffix}`;
  if (d.isSupplyReachable && !d.isDeliveryReachable) {
    if (d.isDeliveryOnNetwork) return `Supply at ${d.supplyCity} (reachable). Delivery at ${d.deliveryCity} ON YOUR TRACK (multi-turn MOVE).${ferry}${scarcitySuffix}`;
    if (skillLevel === BotSkillLevel.Easy) return `Supply at ${d.supplyCity} (reachable). Delivery not reachable.${ferry}${scarcitySuffix}`;
    return `Supply at ${d.supplyCity} (reachable). Delivery needs${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
  }
  if (!d.isSupplyReachable && d.isSupplyOnNetwork) {
    if (d.isDeliveryOnNetwork) return `Supply at ${d.supplyCity} ON YOUR TRACK. Delivery at ${d.deliveryCity} ON YOUR TRACK (multi-turn MOVE).${ferry}${scarcitySuffix}`;
    if (skillLevel === BotSkillLevel.Easy) return `Supply at ${d.supplyCity} ON YOUR TRACK. Delivery not on track.${ferry}${scarcitySuffix}`;
    return `Supply at ${d.supplyCity} ON YOUR TRACK. Delivery needs${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
  }
  if (!d.isSupplyReachable && !d.isSupplyOnNetwork) {
    if (skillLevel === BotSkillLevel.Easy) return `Supply at ${d.supplyCity}. Delivery at ${d.deliveryCity}. Need track.${ferry}${scarcitySuffix}`;
    return `Supply at ${d.supplyCity} needs track${affordabilityTag(d.estimatedTrackCostToSupply)}. Delivery needs track${affordabilityTag(d.estimatedTrackCostToDelivery)}.${ferry}${scarcitySuffix}`;
  }
  return `Supply: ${d.supplyCity}, Delivery: ${d.deliveryCity}${ferry}${scarcitySuffix}`;
}

export function formatDemandView(
  demands: DemandContext[],
  context: { loads: string[]; unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }> },
): string {
  if (demands.length === 0) return 'YOUR DEMANDS:\n  No demand cards.';
  const viable: DemandContext[] = [];
  const excluded: DemandContext[] = [];
  for (const d of demands) {
    const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
    const roi = d.payout - buildCost;
    if (d.isLoadOnTrain || d.isSupplyReachable || d.isSupplyOnNetwork || roi > 0) {
      viable.push(d);
    } else {
      excluded.push(d);
    }
  }
  const shown = viable.slice(0, 5);
  const cappedExcluded = [...excluded, ...viable.slice(5)];
  const seenCards = new Map<number, number>();
  let cardCounter = 0;
  for (const d of demands) {
    if (!seenCards.has(d.cardIndex)) {
      cardCounter++;
      seenCards.set(d.cardIndex, cardCounter);
    }
  }
  const lines: string[] = ['YOUR DEMANDS:'];
  for (const d of shown) {
    const cardNum = seenCards.get(d.cardIndex) ?? 0;
    const buildCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
    const supplyNote = d.isLoadOnTrain ? '(already carried)' : d.supplyCity;
    let detail: string;
    if (d.isLoadOnTrain || buildCost === 0) {
      detail = `${d.payout}M, no build needed, ~${d.estimatedTurns} turns`;
    } else {
      const roi = d.payout - buildCost;
      detail = `${d.payout}M, build ~${buildCost}M, ROI ${roi}M, ~${d.estimatedTurns} turns, ${d.efficiencyPerTurn.toFixed(1)}M/turn`;
    }
    const victoryNote = formatDemandVictoryNote(d, context.unconnectedMajorCities);
    lines.push(`${d.loadType} ${supplyNote}→${d.deliveryCity} [Card ${cardNum}]: ${detail}${victoryNote}`);
  }
  const cardGroups = new Map<number, DemandContext[]>();
  for (const d of shown) {
    if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
    cardGroups.get(d.cardIndex)!.push(d);
  }
  for (const [, group] of cardGroups) {
    if (group.length >= 2) {
      const names = group.map(d => `${d.loadType}→${d.deliveryCity}`);
      lines.push(`  ↳ NOTE: ${names.join(' and ')} are on the same card — delivering one discards the other.`);
    }
  }
  if (cappedExcluded.length > 0) {
    const costs = cappedExcluded.map(d => d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const costRange = minCost === maxCost ? `${minCost}M` : `${minCost}-${maxCost}M`;
    lines.push(`${cappedExcluded.length} other demands need ${costRange} track (not viable).`);
  }
  if (context.loads.length > 0) {
    lines.push('');
    lines.push('CARGO:');
    for (const load of context.loads) {
      const matching = demands.find(d => d.loadType === load && d.isLoadOnTrain);
      if (matching) {
        const cardNum = seenCards.get(matching.cardIndex) ?? 0;
        const label = String.fromCharCode(96 + (demands.filter(dd => dd.cardIndex === matching.cardIndex).indexOf(matching) + 1));
        lines.push(`- ${load} → deliver at ${matching.deliveryCity} for ${matching.payout}M [Card ${cardNum}${label}] (~${matching.estimatedTurns} turns away)`);
      } else {
        lines.push(`- ${load} → no matching demand (consider dropping at next city)`);
      }
    }
  }
  return lines.join('\n');
}

// ── Corridor helpers ──────────────────────────────────────────────────────────

function computeCorridors(demands: DemandContext[], gridPoints: GridPoint[]): Corridor[] {
  if (demands.length < 2) return [];
  const cityPos = (cityName: string): { row: number; col: number } | null => {
    const gp = gridPoints.find(g => g.city?.name === cityName);
    return gp ? { row: gp.row, col: gp.col } : null;
  };
  const parent = demands.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number): void => { parent[find(a)] = find(b); };
  for (let i = 0; i < demands.length; i++) {
    for (let j = i + 1; j < demands.length; j++) {
      const di = demands[i]; const dj = demands[j];
      const delPosI = cityPos(di.deliveryCity); const delPosJ = cityPos(dj.deliveryCity);
      const supPosI = di.supplyCity ? cityPos(di.supplyCity) : null;
      const supPosJ = dj.supplyCity ? cityPos(dj.supplyCity) : null;
      if (!delPosI || !delPosJ || !supPosI || !supPosJ) continue;
      const deliveryDist = di.deliveryCity === dj.deliveryCity ? 0 : hexDistance(delPosI.row, delPosI.col, delPosJ.row, delPosJ.col);
      const supplyDist = hexDistance(supPosI.row, supPosI.col, supPosJ.row, supPosJ.col);
      if (deliveryDist <= CORRIDOR_DELIVERY_THRESHOLD && supplyDist <= CORRIDOR_SUPPLY_THRESHOLD) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < demands.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  const corridors: Corridor[] = [];
  for (const [, indices] of groups) {
    if (indices.length < 2) continue;
    const corridorDemands = indices.map(i => demands[i]);
    const combinedPayout = corridorDemands.reduce((sum, d) => sum + d.payout, 0);
    const maxSupplyCost = Math.max(...corridorDemands.map(d => d.estimatedTrackCostToSupply));
    const maxDeliveryCost = Math.max(...corridorDemands.map(d => d.estimatedTrackCostToDelivery));
    const combinedTrackCost = maxSupplyCost + maxDeliveryCost;
    const deliveryCities = [...new Set(corridorDemands.map(d => d.deliveryCity))];
    const supplyCities = [...new Set(corridorDemands.map(d => d.supplyCity))];
    const deliveryLabel = deliveryCities.length === 1 ? deliveryCities[0] : deliveryCities.join('/');
    const supplyLabel = supplyCities.join('/');
    const sharedDeliveryArea = `${supplyLabel} → ${deliveryLabel}`;
    corridors.push({ demandIndices: indices, sharedDeliveryArea, combinedPayout, combinedTrackCost, onTheWayDemands: [] });
  }
  return corridors;
}

function detectOnTheWay(corridors: Corridor[], demands: DemandContext[], gridPoints: GridPoint[]): void {
  const corridorIndices = new Set<number>();
  for (const c of corridors) { for (const idx of c.demandIndices) corridorIndices.add(idx); }
  const cityPos = (cityName: string): { row: number; col: number } | null => {
    const gp = gridPoints.find(g => g.city?.name === cityName);
    return gp ? { row: gp.row, col: gp.col } : null;
  };
  for (const corridor of corridors) {
    const corridorCityPositions: Array<{ row: number; col: number }> = [];
    for (const idx of corridor.demandIndices) {
      const d = demands[idx];
      const sp = d.supplyCity ? cityPos(d.supplyCity) : null;
      const dp = cityPos(d.deliveryCity);
      if (sp) corridorCityPositions.push(sp);
      if (dp) corridorCityPositions.push(dp);
    }
    for (let i = 0; i < demands.length; i++) {
      if (corridorIndices.has(i)) continue;
      if (corridor.onTheWayDemands.includes(i)) continue;
      const d = demands[i];
      const sp = d.supplyCity ? cityPos(d.supplyCity) : null;
      const dp = cityPos(d.deliveryCity);
      for (const cPos of corridorCityPositions) {
        let matched = false;
        if (sp) {
          const dist = hexDistance(sp.row, sp.col, cPos.row, cPos.col);
          if (dist <= ON_THE_WAY_THRESHOLD) { corridor.onTheWayDemands.push(i); matched = true; }
        }
        if (!matched && dp) {
          const dist = hexDistance(dp.row, dp.col, cPos.row, cPos.col);
          if (dist <= ON_THE_WAY_THRESHOLD) { corridor.onTheWayDemands.push(i); matched = true; }
        }
        if (matched) break;
      }
    }
  }
}

function computeResourceProximity(
  demands: DemandContext[],
  segments: TrackSegment[],
  gridPoints: GridPoint[],
): Array<{ loadType: string; supplyCity: string; distanceFromNetwork: number; estimatedCost: number }> {
  if (segments.length === 0) return [];
  const { buildTrackNetwork } = require('../../../../shared/services/TrackNetworkService');
  const network = buildTrackNetwork(segments);
  const results: Array<{ loadType: string; supplyCity: string; distanceFromNetwork: number; estimatedCost: number }> = [];
  const seen = new Set<string>();
  for (const d of demands) {
    if (d.isSupplyOnNetwork) continue;
    if (!d.supplyCity) continue;
    if (seen.has(d.supplyCity)) continue;
    const supplyPoints = gridPoints.filter(gp => gp.city?.name === d.supplyCity);
    if (supplyPoints.length === 0) continue;
    let minDist = Infinity;
    for (const sp of supplyPoints) {
      for (const nodeKey of network.nodes) {
        const [nRow, nCol] = nodeKey.split(',').map(Number);
        const dist = hexDistance(sp.row, sp.col, nRow, nCol);
        if (dist < minDist) minDist = dist;
      }
    }
    if (minDist <= PROXIMITY_THRESHOLD && minDist > 0) {
      seen.add(d.supplyCity);
      results.push({
        loadType: d.loadType,
        supplyCity: d.supplyCity,
        distanceFromNetwork: minDist,
        estimatedCost: estimateTrackCost(d.supplyCity, segments, gridPoints),
      });
    }
  }
  return results;
}

function computeUnconnectedDemandCosts(
  demands: DemandContext[],
  segments: TrackSegment[],
  gridPoints: GridPoint[],
): Array<{ demandIndex: number; city: string; estimatedCost: number; payout: number; isSupply: boolean }> {
  if (segments.length === 0) return [];
  const results: Array<{ demandIndex: number; city: string; estimatedCost: number; payout: number; isSupply: boolean }> = [];
  for (let i = 0; i < demands.length; i++) {
    const d = demands[i];
    if (d.isSupplyOnNetwork && d.isDeliveryOnNetwork) continue;
    if (!d.isSupplyOnNetwork && d.supplyCity) {
      results.push({ demandIndex: i, city: d.supplyCity, estimatedCost: estimateTrackCost(d.supplyCity, segments, gridPoints), payout: d.payout, isSupply: true });
    }
    if (!d.isDeliveryOnNetwork) {
      results.push({ demandIndex: i, city: d.deliveryCity, estimatedCost: estimateTrackCost(d.deliveryCity, segments, gridPoints), payout: d.payout, isSupply: false });
    }
  }
  return results;
}

// ── Serializer class ──────────────────────────────────────────────────────────

export class ContextSerializer {
  /**
   * Render GameContext into structured text for the LLM user prompt.
   * Follows PRD Section 4.3 template with skill-level-dependent detail.
   */
  static serializePrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
  ): string {
    const lines: string[] = [];
    if (
      context.trainType === 'Freight' &&
      context.turnNumber >= 15 &&
      context.money >= 60 &&
      (context.deliveryCount ?? 0) >= 5
    ) {
      lines.push(`STRONG RECOMMENDATION: You are still on Freight at turn ${context.turnNumber}. UPGRADE to FastFreight this turn.`);
      lines.push('Every turn on Freight costs you ~3 mileposts of wasted movement. Output UPGRADE as your Phase B action.');
      lines.push('');
    }
    lines.push(`TURN ${context.turnNumber} — GAME PHASE: ${context.phase}`);
    lines.push(`(Games typically last ~100 turns. Plan accordingly — upgrades and expensive track that cut travel time often pay off.)`);
    lines.push('');
    if (context.turnNumber >= 40 && !context.isInitialBuild) {
      lines.push(`TURN PRESSURE: You are past turn 40. Favor upgrades and expensive track that significantly cuts travel time over conservative play. The game will not go on forever.`);
      lines.push('');
    }
    if (context.previousTurnSummary) {
      lines.push('PREVIOUS TURN:');
      lines.push(`- ${context.previousTurnSummary}`);
      lines.push('');
    }
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${context.money}M ECU (minimum reserve: 5M)`);
    const loadsStr = context.loads.length > 0 ? context.loads.join(', ') : 'nothing';
    lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity}, carrying ${loadsStr})`);
    const posStr = context.position
      ? (context.position.city
        ? `${context.position.city} (${context.position.row},${context.position.col})`
        : `(${context.position.row},${context.position.col})`)
      : 'Not placed';
    lines.push(`- Position: ${posStr}`);
    lines.push(`- Major cities connected: ${context.connectedMajorCities.length}/${context.totalMajorCities} (${context.connectedMajorCities.join(', ') || 'none'})`);
    lines.push(`- Track network: ${context.trackSummary}`);
    lines.push(`- Build budget remaining this turn: ${20 - context.turnBuildCost}M`);
    lines.push('');
    const cashRemaining = Math.max(0, 250 - context.money);
    lines.push('VICTORY PROGRESS:');
    lines.push(`- Cash: ${context.money}M / 250M needed (${cashRemaining}M remaining)`);
    lines.push(`- Cities connected: ${context.connectedMajorCities.length}/7 needed (${context.connectedMajorCities.join(', ') || 'none'})`);
    if (context.unconnectedMajorCities.length === 0) {
      lines.push('- All cities connected! Earn more cash to win.');
    } else {
      const unconnectedStr = context.unconnectedMajorCities
        .map(u => `${u.cityName} (~${u.estimatedCost}M to connect)`)
        .join(', ');
      lines.push(`- Cities NOT connected: ${unconnectedStr}`);
      const nearest = context.unconnectedMajorCities[0];
      lines.push(`- Nearest unconnected city: ${nearest.cityName} (~${nearest.estimatedCost}M from your network)`);
      if (context.money >= 250 && context.connectedMajorCities.length < 7) {
        lines.push(`- ROUTE SELECTION: Prefer demands whose supply or delivery city IS an unconnected major city. Building track toward these cities happens automatically — choose routes that take you there. Do NOT chase high-payout deliveries to non-major cities.`);
      }
    }
    lines.push('');
    lines.push(formatDemandView(context.demands, context));
    lines.push('');
    lines.push('IMMEDIATE OPPORTUNITIES:');
    if (context.canDeliver.length > 0) {
      for (const opp of context.canDeliver) {
        lines.push(`- DELIVER ${opp.loadType} at ${opp.deliveryCity} for ${opp.payout}M! (DO THIS FIRST)`);
      }
    }
    if (context.canPickup.length > 0) {
      for (const opp of context.canPickup) {
        lines.push(`- PICKUP ${opp.loadType} here at ${opp.supplyCity} → deliver to ${opp.bestDeliveryCity} for ${opp.bestPayout}M`);
      }
    }
    if (context.canDeliver.length === 0 && context.canPickup.length === 0) {
      lines.push('- No deliveries or pickups available at your position.');
    }
    if (!context.isInitialBuild && context.canPickup.length > 0) {
      for (const opp of context.canPickup) {
        if (context.reachableCities.includes(opp.bestDeliveryCity)) {
          lines.push(`⚡ COMBO: PICKUP ${opp.loadType} here → MOVE to ${opp.bestDeliveryCity} → DELIVER for ${opp.bestPayout}M — all in ONE turn!`);
        }
      }
    }
    if (!context.isInitialBuild && context.loads.length > 0 && context.canDeliver.length === 0) {
      lines.push(`WARNING: You are carrying [${context.loads.join(', ')}] but cannot deliver here. MOVE toward a delivery city — do NOT pass your turn!`);
    }
    lines.push('');
    if (!context.isInitialBuild) {
      if (context.enRoutePickups && context.enRoutePickups.length > 0) {
        lines.push('EN-ROUTE PICKUPS (near your route):');
        for (const p of context.enRoutePickups) {
          const detour = p.onRoute ? 'on route' : `${p.detourMileposts} mp detour`;
          lines.push(`- ${p.city}: ${p.load} → ${p.demandCity} ${p.payoff}M (${detour})`);
        }
        lines.push('');
      }
      if (context.reachableCities.length > 1) {
        lines.push(`CITIES REACHABLE THIS TURN (within speed ${context.speed} on existing track):`);
        lines.push(context.reachableCities.join(', '));
        lines.push('');
      }
      const networkOnlyCities = context.citiesOnNetwork.filter(c => !context.reachableCities.includes(c));
      if (networkOnlyCities.length > 0) {
        lines.push('CITIES ON YOUR TRACK NETWORK (reachable by MOVE in multiple turns):');
        lines.push(networkOnlyCities.join(', '));
        lines.push('');
      }
    }
    const upgradeEligible = (context.deliveryCount ?? 0) >= MIN_DELIVERIES_BEFORE_UPGRADE && context.money >= 30;
    if (upgradeEligible && context.upgradeAdvice) {
      const strongUpgrade = context.trainType === 'Freight' && context.turnNumber >= 8;
      if (strongUpgrade) {
        lines.push(`RECOMMENDED PHASE B ACTION: UPGRADE to FastFreight — {"action": "UPGRADE", "details": {"to": "FastFreight"}}`);
        lines.push(`You've been on Freight for ${context.turnNumber} turns. +3 speed saves ~1 turn per delivery.`);
        lines.push(context.upgradeAdvice);
      } else {
        lines.push(`UPGRADE ADVICE: ${context.upgradeAdvice}`);
      }
    } else if (upgradeEligible && context.canUpgrade) {
      lines.push('YOU CAN UPGRADE: Check available train types (20M for upgrade, 5M for crossgrade).');
    }
    if (context.isInitialBuild) {
      lines.push('PHASE: Initial Build — build track only, no train movement. 20M budget this turn, 40M total over 2 turns.');
      lines.push('Apply the GEOGRAPHIC STRATEGY and CAPITAL VELOCITY principles from your instructions to choose where to build first.');
    }
    if (!context.canBuild) {
      lines.push('BUILD: Not available this turn (budget exhausted or no funds).');
    }
    if (context.opponents.length > 0) {
      lines.push('');
      lines.push('OPPONENTS:');
      for (const opp of context.opponents) {
        const parts = [`${opp.name}: ${opp.money}M, ${opp.trainType}`];
        if (opp.position) parts.push(`at ${opp.position}`);
        if (opp.loads.length > 0) parts.push(`carrying ${opp.loads.join(', ')}`);
        if (opp.trackCoverage) parts.push(`Track covers ${opp.trackCoverage}`);
        if ((opp as { recentBuildDirection?: string }).recentBuildDirection) parts.push(`building toward ${(opp as { recentBuildDirection?: string }).recentBuildDirection}`);
        lines.push(`- ${parts.join('. ')}.`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Render route-planning prompt with corridor data and turn estimates.
   * Used by planRoute() in TripPlanner.
   */
  static serializeRoutePlanningPrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
    segments: TrackSegment[] = [],
    lastAbandonedRouteKey?: string | null,
    previousRouteStops?: RouteStop[] | null,
  ): string {
    const lines: string[] = [];
    lines.push(`TURN ${context.turnNumber} — GAME PHASE: ${context.phase}`);
    lines.push(`(Games typically last ~100 turns. Prefer routes that cut travel time — expensive track that halves a route pays off.)`);
    if (context.turnNumber >= 40 && !context.isInitialBuild) {
      lines.push(`TURN PRESSURE: Past turn 40. Favor speed and expensive shortcuts.`);
    }
    lines.push('');
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${context.money}M ECU (minimum reserve: 5M)`);
    const loadsStr = context.loads.length > 0 ? context.loads.join(', ') : 'nothing';
    lines.push(`- Train: ${context.trainType} (speed ${context.speed}, capacity ${context.capacity}, carrying ${loadsStr})`);
    const posStr = context.position
      ? (context.position.city ? `${context.position.city} (${context.position.row},${context.position.col})` : `(${context.position.row},${context.position.col})`)
      : 'Not placed';
    lines.push(`- Position: ${posStr}`);
    lines.push(`- Major cities connected: ${context.connectedMajorCities.length}/${context.totalMajorCities} (${context.connectedMajorCities.join(', ') || 'none'})`);
    lines.push(`- Track network: ${context.trackSummary}`);
    lines.push('');
    lines.push(formatDemandView(context.demands, context));
    lines.push('You may ONLY plan deliveries for demands listed above. Do not reference loads or cities not shown here.');
    lines.push('');
    const corridors = computeCorridors(context.demands, gridPoints);
    detectOnTheWay(corridors, context.demands, gridPoints);
    if (corridors.length > 0) {
      lines.push('DEMAND CORRIDORS (demands sharing routes — combine for efficiency):');
      for (let ci = 0; ci < corridors.length; ci++) {
        const c = corridors[ci];
        const corridorLabel = String.fromCharCode(65 + ci);
        lines.push(`  Corridor ${corridorLabel} (${c.sharedDeliveryArea}):`);
        for (const idx of c.demandIndices) {
          const d = context.demands[idx];
          lines.push(`    - ${d.loadType} ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M)`);
        }
        lines.push(`    Combined payout: ${c.combinedPayout}M, shared track: ~${c.combinedTrackCost}M`);
        if (c.onTheWayDemands.length > 0) {
          for (const otwIdx of c.onTheWayDemands) {
            const d = context.demands[otwIdx];
            lines.push(`    ON THE WAY: ${d.loadType} ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M, near-zero extra cost)`);
          }
        }
      }
      lines.push('');
    }
    if (segments.length > 0) {
      const resourceProx = computeResourceProximity(context.demands, segments, gridPoints);
      if (resourceProx.length > 0) {
        lines.push('RESOURCE PROXIMITY (cheap pickups near your track):');
        for (const r of resourceProx) {
          lines.push(`  ${r.loadType} available at ${r.supplyCity}, ~${r.estimatedCost}M from your network (${r.distanceFromNetwork} hexes)`);
        }
        lines.push('');
      }
    }
    if (context.isInitialBuild) {
      lines.push('PHASE: Initial Build — build track only, no train movement. 20M budget this turn, 40M total over 2 turns.');
      lines.push('Use GEOGRAPHIC STRATEGY and HAND EVALUATION from the system prompt to choose your first demand. Prioritise capital velocity.');
      lines.push('STARTING CITY: You will place your train at any major city before moving.');
      lines.push('Choose your starting city AND first delivery together:');
      lines.push('- Start at or near a supply city so you can pick up immediately on turn 3');
      lines.push('- Prefer demands where supply→delivery is short and affordable within 40M total budget');
      lines.push('- A demand with supply at a major city lets you start there and pick up without traveling');
    }
    if (!context.canBuild) lines.push('BUILD: Not available this turn (budget exhausted or no funds).');
    if (context.opponents.length > 0) {
      lines.push('');
      lines.push('OPPONENTS:');
      for (const opp of context.opponents) {
        const parts = [`${opp.name}: ${opp.money}M, ${opp.trainType}`];
        if (opp.position) parts.push(`at ${opp.position}`);
        if (opp.loads.length > 0) parts.push(`carrying ${opp.loads.join(', ')}`);
        if (opp.trackCoverage) parts.push(`Track covers ${opp.trackCoverage}`);
        if ((opp as { recentBuildDirection?: string }).recentBuildDirection) parts.push(`building toward ${(opp as { recentBuildDirection?: string }).recentBuildDirection}`);
        lines.push(`- ${parts.join('. ')}.`);
      }
    }
    if (lastAbandonedRouteKey) {
      lines.push('');
      lines.push(`RECENTLY ABANDONED ROUTE: ${lastAbandonedRouteKey}`);
      lines.push('Avoid planning a route identical to this one — it was abandoned because it could not be completed.');
    }
    if (previousRouteStops && previousRouteStops.length > 0) {
      lines.push('');
      lines.push('PREVIOUS ROUTE (remaining stops from partially completed route):');
      for (const stop of previousRouteStops) {
        const paymentStr = stop.payment ? ` for ${stop.payment}M` : '';
        lines.push(`  - ${stop.action} ${stop.loadType} at ${stop.city}${paymentStr}`);
      }
      lines.push('Consider continuing this route if the stops are still valid with your current demand cards. You may also extend, modify, or abandon it.');
    }
    return lines.join('\n');
  }

  /**
   * JIRA-89: Render secondary delivery evaluation prompt.
   */
  static serializeSecondaryDeliveryPrompt(
    snapshot: WorldSnapshot,
    routeStops: RouteStop[],
    demands: DemandContext[],
    enRoutePickups: EnRoutePickup[],
  ): string {
    const lines: string[] = [];
    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push(`Cash: ${snapshot.bot.money}M | Train: ${snapshot.bot.trainType} | Loads: ${snapshot.bot.loads.join(', ') || 'none'}`);
    const capacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    lines.push(`Cargo capacity: ${snapshot.bot.loads.length}/${capacity} (${capacity - snapshot.bot.loads.length} free slots)`);
    lines.push('');
    lines.push('PLANNED ROUTE:');
    for (const stop of routeStops) {
      lines.push(`  ${stop.action.toUpperCase()} ${stop.loadType} at ${stop.city}${stop.payment ? ` (${stop.payment}M)` : ''}`);
    }
    lines.push('');
    const primaryLoadTypes = new Set(routeStops.filter(s => s.action === 'pickup').map(s => s.loadType));
    const remainingDemands = demands.filter(d => !primaryLoadTypes.has(d.loadType));
    lines.push('YOUR OTHER DEMAND CARDS (not part of primary route):');
    if (remainingDemands.length === 0) {
      lines.push('  (none — all demands are part of the primary route)');
    } else {
      for (const d of remainingDemands) {
        lines.push(`  ${d.loadType}: ${d.supplyCity} → ${d.deliveryCity} (${d.payout}M, ~${d.estimatedTurns} turns)`);
      }
    }
    lines.push('');
    lines.push('AVAILABLE LOADS NEAR YOUR ROUTE:');
    if (enRoutePickups.length === 0) {
      lines.push('  (none found within scan radius)');
    } else {
      for (const p of enRoutePickups) {
        lines.push(`  ${p.load} at ${p.city} → deliver to ${p.demandCity} (${p.payoff}M, ${p.onRoute ? 'ON ROUTE' : `${p.detourMileposts}mp detour`})`);
      }
    }
    lines.push('');
    lines.push('Should you add a secondary pickup to this route?');
    return lines.join('\n');
  }

  /**
   * JIRA-92: Render cargo conflict resolution prompt.
   */
  static serializeCargoConflictPrompt(
    snapshot: WorldSnapshot,
    plannedRoute: StrategicRoute,
    conflictingLoads: string[],
    demands: DemandContext[],
  ): string {
    const lines: string[] = [];
    const capacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    const freeSlots = capacity - snapshot.bot.loads.length;
    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push(`Train: ${snapshot.bot.trainType} (capacity ${capacity}, speed ${TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9})`);
    lines.push(`Cash: ${snapshot.bot.money}M`);
    lines.push(`Carried loads: ${snapshot.bot.loads.join(', ') || 'none'}`);
    lines.push(`Free slots: ${freeSlots} of ${capacity}`);
    lines.push('');
    const routeStops = plannedRoute.stops;
    const pickupCount = routeStops.filter(s => s.action === 'pickup').length;
    const totalPayout = routeStops.filter(s => s.action === 'deliver' && s.payment).reduce((sum, s) => sum + (s.payment ?? 0), 0);
    lines.push('PLANNED ROUTE:');
    for (const stop of routeStops) {
      lines.push(`  ${stop.action.toUpperCase()} ${stop.loadType} at ${stop.city}${stop.payment ? ` (${stop.payment}M)` : ''}`);
    }
    lines.push(`  Pickups needed: ${pickupCount} | Total payout: ${totalPayout}M`);
    lines.push('');
    lines.push('CARRIED LOADS BLOCKING THE ROUTE (not part of planned deliveries):');
    for (const loadType of conflictingLoads) {
      const demandCtx = demands.find(d => d.loadType === loadType && d.isLoadOnTrain);
      if (demandCtx) {
        const trackCost = demandCtx.estimatedTrackCostToDelivery;
        const netProfit = demandCtx.payout - trackCost;
        const onNetwork = trackCost === 0 ? 'YES — delivery on existing network' : 'NO — requires building track';
        lines.push(`  ${loadType} → ${demandCtx.deliveryCity}: ${demandCtx.payout}M payout, ~${trackCost}M track cost, ~${demandCtx.estimatedTurns} turns, net profit: ${netProfit}M`);
        lines.push(`    Delivery on network: ${onNetwork}`);
        lines.push(`    Efficiency: ${demandCtx.efficiencyPerTurn.toFixed(1)}M/turn`);
      } else {
        lines.push(`  ${loadType} → no matching demand card found`);
      }
    }
    lines.push('');
    lines.push(formatDemandView(demands, { loads: snapshot.bot.loads, unconnectedMajorCities: [] }));
    lines.push('');
    lines.push(`CARGO CONFLICT: Your planned route needs ${pickupCount} pickup slots but you only have ${freeSlots} free.`);
    lines.push('Should you DROP any of the carried loads listed above to free slots for the planned route?');
    return lines.join('\n');
  }

  /**
   * JIRA-105b: Render upgrade-before-drop evaluation prompt.
   */
  static serializeUpgradeBeforeDropPrompt(
    snapshot: WorldSnapshot,
    route: StrategicRoute,
    upgradeOptions: { targetTrain: string; cost: number }[],
    totalRoutePayout: number,
    demands: DemandContext[],
  ): string {
    const lines: string[] = [];
    const capacity = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.capacity ?? 2;
    const freeSlots = capacity - snapshot.bot.loads.length;
    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push(`Train: ${snapshot.bot.trainType} (capacity ${capacity}, speed ${TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9})`);
    lines.push(`Cash: ${snapshot.bot.money}M`);
    lines.push(`Carried loads: ${snapshot.bot.loads.join(', ') || 'none'}`);
    lines.push(`Free slots: ${freeSlots} of ${capacity}`);
    lines.push('');
    lines.push('PLANNED ROUTE:');
    for (const stop of route.stops) {
      lines.push(`  ${stop.action.toUpperCase()} ${stop.loadType} at ${stop.city}${stop.payment ? ` (${stop.payment}M)` : ''}`);
    }
    const pickupCount = route.stops.filter(s => s.action === 'pickup').length;
    lines.push(`  Pickups needed: ${pickupCount} | Total route payout: ${totalRoutePayout}M`);
    lines.push('');
    lines.push('AVAILABLE UPGRADES (capacity-increasing):');
    for (const opt of upgradeOptions) {
      const targetCap = TRAIN_PROPERTIES[opt.targetTrain as TrainType]?.capacity ?? 3;
      const targetSpeed = TRAIN_PROPERTIES[opt.targetTrain as TrainType]?.speed ?? 9;
      const netBenefit = totalRoutePayout - opt.cost;
      lines.push(`  ${opt.targetTrain} (capacity ${targetCap}, speed ${targetSpeed}) — cost: ${opt.cost}M, net benefit: ${netBenefit}M`);
    }
    lines.push('');
    const routeDeliveryLoads = new Set(route.stops.filter(s => s.action === 'deliver').map(s => s.loadType));
    const conflictingLoads = snapshot.bot.loads.filter(l => !routeDeliveryLoads.has(l));
    if (conflictingLoads.length > 0) {
      lines.push('LOAD THAT WOULD BE DROPPED IF NOT UPGRADING:');
      for (const loadType of conflictingLoads) {
        const demandCtx = demands.find(d => d.loadType === loadType && d.isLoadOnTrain);
        if (demandCtx) {
          lines.push(`  ${loadType} → ${demandCtx.deliveryCity}: ${demandCtx.payout}M payout, ~${demandCtx.estimatedTrackCostToDelivery}M track cost, ~${demandCtx.estimatedTurns} turns`);
        } else {
          lines.push(`  ${loadType} → no matching demand card found`);
        }
      }
      lines.push('');
    }
    lines.push(`DECISION: You need ${pickupCount} pickup slots but only have ${freeSlots} free.`);
    lines.push(`Upgrading costs ${upgradeOptions[0]?.cost ?? 20}M but lets you carry all ${pickupCount + snapshot.bot.loads.length} loads.`);
    lines.push('Should you UPGRADE your train or SKIP and drop a load instead?');
    return lines.join('\n');
  }
}
