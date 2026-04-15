/**
 * Integration Test Setup — Shared helpers for bot behavior integration tests.
 *
 * Provides factory functions for creating realistic game state objects
 * (DemandContext, GameContext, WorldSnapshot) used across all 7 behavior tests.
 */

import { DemandContext } from '../../../../shared/types/GameTypes';

// ── DemandContext Factory ───────────────────────────────────────────────────

export function makeDemandContext(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 10,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 5,
    estimatedTrackCostToDelivery: 3,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 4,
    demandScore: 0,
    efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 50,
    ...overrides,
  };
}

// ── scoreDemand replica ─────────────────────────────────────────────────────
// Replicates ContextBuilder.scoreDemand (private static) for test verification.
// Synced with production formula: routes with build cost > 50M are exponentially
// penalized. JIRA-174: corridor multiplier removed.

export function scoreDemand(
  payout: number,
  totalTrackCost: number,
  estimatedTurns: number,
  isAffordable: boolean = true,
  projectedFunds: number = Infinity,
): number {
  const baseROI = (payout - totalTrackCost) / estimatedTurns;
  const rawScore = baseROI;

  // Build cost ceiling: exponential penalty for routes > 50M
  // Bug #5 fix: divide negative scores by penalty (makes MORE negative = worse rank)
  const costPenaltyFactor = totalTrackCost > 50
    ? Math.exp(-(totalTrackCost - 50) / 30)
    : 1;
  const penalizedScore = rawScore >= 0
    ? rawScore * costPenaltyFactor
    : rawScore / Math.max(costPenaltyFactor, 0.01);

  if (!isAffordable && totalTrackCost > 0) {
    const shortfall = totalTrackCost - Math.max(projectedFunds, 0);
    const shortfallRatio = Math.min(shortfall / totalTrackCost, 1);
    const affordPenalty = Math.max(0.05, 0.3 * (1 - shortfallRatio));
    return penalizedScore >= 0
      ? penalizedScore * affordPenalty
      : penalizedScore / Math.max(affordPenalty, 0.01);
  }

  return penalizedScore;
}

// ── computeHandQuality replica ──────────────────────────────────────────────
// Replicates AIStrategyEngine.computeHandQuality (private static).

export function computeHandQuality(
  demands: DemandContext[],
  money: number = Infinity,
): { score: number; staleCards: number; assessment: string } {
  if (demands.length === 0) {
    return { score: 0, staleCards: 0, assessment: 'Poor' };
  }

  const cardGroups = new Map<number, DemandContext[]>();
  for (const d of demands) {
    if (!cardGroups.has(d.cardIndex)) cardGroups.set(d.cardIndex, []);
    cardGroups.get(d.cardIndex)!.push(d);
  }

  let totalBestScore = 0;
  let staleCards = 0;
  for (const [, cardDemands] of cardGroups) {
    const best = cardDemands.reduce((a, b) => a.demandScore > b.demandScore ? a : b);
    totalBestScore += best.demandScore;
    if (best.estimatedTurns >= 12) staleCards++;
  }

  const avgScore = totalBestScore / cardGroups.size;

  // JIRA-71: If bot is broke (cash < 5M) and no demand is affordable, clamp to "Poor"
  const isBroke = money < 5 && demands.every(d => !d.isAffordable);
  const assessment = isBroke ? 'Poor' : avgScore >= 3 ? 'Good' : avgScore >= 1 ? 'Fair' : 'Poor';

  return {
    score: isBroke ? 0 : Math.round(avgScore * 100) / 100,
    staleCards,
    assessment,
  };
}

// ── Supply Rarity replica ───────────────────────────────────────────────────
// Replicates the supply rarity computation from AIStrategyEngine.

export function computeSupplyRarity(
  demands: DemandContext[],
): Map<string, string> {
  const supplyCityCounts = new Map<string, Set<string>>();
  for (const d of demands) {
    if (!supplyCityCounts.has(d.loadType)) supplyCityCounts.set(d.loadType, new Set());
    supplyCityCounts.get(d.loadType)!.add(d.supplyCity);
  }

  const rarity = new Map<string, string>();
  for (const [loadType, cities] of supplyCityCounts) {
    const count = cities.size;
    rarity.set(loadType, count <= 1 ? 'UNIQUE' : count === 2 ? 'LIMITED' : 'COMMON');
  }
  return rarity;
}

// ── Demand Ranking Builder replica ──────────────────────────────────────────
// Replicates AIStrategyEngine demand ranking builder.

export function buildDemandRanking(demands: DemandContext[]): Array<{
  loadType: string;
  supplyCity: string;
  deliveryCity: string;
  payout: number;
  score: number;
  rank: number;
  supplyRarity: string;
  isStale: boolean;
}> {
  const supplyCityCounts = new Map<string, Set<string>>();
  for (const d of demands) {
    if (!supplyCityCounts.has(d.loadType)) supplyCityCounts.set(d.loadType, new Set());
    supplyCityCounts.get(d.loadType)!.add(d.supplyCity);
  }

  return [...demands]
    .sort((a, b) => b.demandScore - a.demandScore)
    .map((d, i) => {
      const cityCount = supplyCityCounts.get(d.loadType)?.size ?? 1;
      const supplyRarity = cityCount <= 1 ? 'UNIQUE' : cityCount === 2 ? 'LIMITED' : 'COMMON';
      return {
        loadType: d.loadType,
        supplyCity: d.supplyCity,
        deliveryCity: d.deliveryCity,
        payout: d.payout,
        score: d.demandScore,
        rank: i + 1,
        supplyRarity,
        isStale: d.estimatedTurns >= 12,
      };
    });
}

// ── Build Budget Verification replica ───────────────────────────────────────
// Replicates the affordability check from ContextBuilder.computeSingleSupplyDemandContext.

export function isRouteAffordable(
  totalTrackCost: number,
  botMoney: number,
  projectedDeliveryIncome: number,
  payout: number,
): { affordable: boolean; reason?: string } {
  // Negative ROI: track cost exceeds payout
  if (totalTrackCost > payout) {
    return { affordable: false, reason: 'negative_roi' };
  }
  // Can't afford even with projected income
  if (totalTrackCost > botMoney + projectedDeliveryIncome) {
    return { affordable: false, reason: 'insufficient_funds' };
  }
  return { affordable: true };
}

// ── Zero-Money Gate replica ─────────────────────────────────────────────────
// Replicates AIStrategyEngine.zeroMoneyGate advisory logic.

export function zeroMoneyGateAction(
  money: number,
  loads: string[],
  canDeliver: Array<{ loadType: string; city: string }>,
): 'no_action' | 'deliver' | 'move_toward_delivery' | 'discard_hand' {
  if (money > 0) return 'no_action';
  if (canDeliver.length > 0) return 'deliver';
  if (loads.length > 0) return 'move_toward_delivery';
  return 'discard_hand';
}

// ── Upgrade Decision replica ────────────────────────────────────────────────
// Replicates TurnComposer Phase B upgrade preference logic.

export function shouldPreferUpgrade(
  canUpgrade: boolean,
  money: number,
  turnBuildCost: number,
  trainType: string,
  buildPlanFound: boolean,
): { preferUpgrade: boolean; reason?: string } {
  if (!canUpgrade) return { preferUpgrade: false, reason: 'cannot_upgrade' };
  if (trainType === 'Superfreight') return { preferUpgrade: false, reason: 'already_max' };
  if (money < 20) return { preferUpgrade: false, reason: 'cannot_afford' };

  const buildBudget = Math.min(20 - turnBuildCost, money);

  // Low build budget → prefer upgrade
  if (buildBudget < 5) {
    return { preferUpgrade: true, reason: 'low_build_budget' };
  }
  // No build target found → prefer upgrade
  if (!buildPlanFound) {
    return { preferUpgrade: true, reason: 'no_build_target' };
  }

  return { preferUpgrade: false, reason: 'build_preferred' };
}
