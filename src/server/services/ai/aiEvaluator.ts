/**
 * AI Evaluator Service
 * State evaluation and threat assessment for AI players
 */

import { Player, TrackSegment, TerrainType } from '../../../shared/types/GameTypes';
import { DemandCard } from '../../../shared/types/DemandCard';
import { PositionScore, ThreatAssessment, AIGameState } from './types';
import { getAIPathfinder } from './aiPathfinder';
import { getMajorCityGroups, MajorCityGroup } from '../../../shared/services/majorCityGroups';

/** Victory requirements */
const VICTORY_CASH = 250;
const VICTORY_MAJOR_CITIES = 7;

export class AIEvaluator {
  private pathfinder = getAIPathfinder();

  /**
   * Score a demand card based on feasibility and value for the AI player
   * @param card The demand card to evaluate
   * @param player The AI player
   * @param gameState Current game state
   * @returns Score from 0-100 indicating desirability
   */
  scoreDemandCard(
    card: DemandCard,
    player: Player,
    gameState: AIGameState
  ): number {
    const playerTrack = gameState.allTrack.get(player.id) || [];

    // Get payout from first demand on the card
    const payout = card.demands[0]?.payment || 0;

    // Base score from payout value (normalize to 0-40 range)
    const payoutScore = Math.min(40, (payout / 50) * 40);

    // Distance penalty (0-30 points deducted based on distance)
    const distanceScore = this.calculateDistanceScore(card, player, playerTrack);

    // Load availability bonus (0-15 points)
    const availabilityScore = this.calculateAvailabilityScore(card, gameState);

    // Competition penalty (0-15 points deducted if others want same load)
    const competitionScore = this.calculateCompetitionScore(card, gameState);

    return Math.max(0, Math.min(100, payoutScore + distanceScore + availabilityScore - competitionScore));
  }

  /**
   * Evaluate the overall position of a player
   * @param player The player to evaluate
   * @param gameState Current game state
   * @returns Position score breakdown
   */
  evaluatePosition(
    player: Player,
    gameState: AIGameState
  ): PositionScore {
    const playerTrack = gameState.allTrack.get(player.id) || [];

    // Cash position (0-30 points based on progress to 250M)
    const cashPosition = Math.min(30, (player.money / VICTORY_CASH) * 30);

    // Network value (0-25 points based on track coverage and connectivity)
    const networkValue = this.calculateNetworkValue(playerTrack);

    // Delivery potential (0-25 points based on current hand and network)
    const deliveryPotential = this.calculateDeliveryPotential(player, gameState);

    // Progress to victory (0-20 points)
    const progressToVictory = this.calculateVictoryProgress(player, playerTrack);

    const overall = cashPosition + networkValue + deliveryPotential + progressToVictory;

    return {
      overall,
      cashPosition,
      networkValue,
      deliveryPotential,
      progressToVictory,
    };
  }

  /**
   * Assess threats from opponent players
   * @param player The AI player
   * @param opponents List of opponent players
   * @returns Threat assessment
   */
  assessOpponentThreats(
    player: Player,
    opponents: Player[]
  ): ThreatAssessment {
    const blockingThreats: ThreatAssessment['blockingThreats'] = [];
    const competitionForLoads: ThreatAssessment['competitionForLoads'] = [];

    if (opponents.length === 0) {
      return {
        overallThreat: 0,
        blockingThreats,
        competitionForLoads,
      };
    }

    let overallThreat = 0;

    // Analyze load competition across all opponents
    const loadDemandCounts = new Map<string, number>();

    for (const opponent of opponents) {
      // Calculate threat from this opponent
      const cashThreat = this.calculateCashThreat(opponent);
      const positionThreat = this.calculatePositionThreat(player, opponent);

      overallThreat += (cashThreat + positionThreat) / opponents.length;

      // Check opponent's hand for loads they want
      if (opponent.hand) {
        for (const card of opponent.hand) {
          for (const demand of card.demands) {
            const loadType = demand.resource;
            loadDemandCounts.set(loadType, (loadDemandCounts.get(loadType) || 0) + 1);
          }
        }
      }
    }

    // Identify blocking threats based on major cities with limited entry
    // (Small cities: 2 players, Medium cities: 3 players)
    const majorCityGroups = getMajorCityGroups();
    for (const cityGroup of majorCityGroups) {
      // Check if opponents are already building toward this city
      // This is a simplified check - a full implementation would track
      // how many players have built into each city
      const cityKey = `${cityGroup.center.row},${cityGroup.center.col}`;

      // For each opponent near a city we need, flag as potential block
      // (Simplified: just flag if opponent has high cash and is close to winning)
      for (const opponent of opponents) {
        if (opponent.money > 200) {
          blockingThreats.push({
            playerId: opponent.id,
            cityBlocked: cityGroup.cityName,
            impact: Math.min(30, opponent.money / 10),
          });
          break; // Only flag one blocking threat per city
        }
      }
    }

    // Build competition for loads list
    for (const [loadType, count] of loadDemandCounts) {
      if (count > 0) {
        competitionForLoads.push({
          loadType,
          competitorCount: count,
          urgency: Math.min(10, count * 3),
        });
      }
    }

    // Sort competition by urgency
    competitionForLoads.sort((a, b) => b.urgency - a.urgency);

    return {
      overallThreat: Math.min(100, overallThreat),
      blockingThreats,
      competitionForLoads,
    };
  }

  /**
   * Calculate score based on distance to pickup and delivery
   * Higher score means easier/shorter delivery
   */
  private calculateDistanceScore(
    card: DemandCard,
    player: Player,
    playerTrack: TrackSegment[]
  ): number {
    // If train has no position, assume starting from a major city
    if (!player.trainState.position) {
      return 15; // Neutral score
    }

    // Get destination city from card
    const destinationCity = card.demands[0]?.city;
    if (!destinationCity) {
      return 10;
    }

    // Check if we have track near the destination
    const majorCityGroups = getMajorCityGroups();
    const destinationGroup = majorCityGroups.find(g => g.cityName === destinationCity);

    if (!destinationGroup) {
      return 10; // Unknown city, neutral score
    }

    // Check if any track connects to the destination city
    const destCityKeys = [
      `${destinationGroup.center.row},${destinationGroup.center.col}`,
      ...destinationGroup.outposts.map(o => `${o.row},${o.col}`)
    ];

    const trackKeys = new Set<string>();
    for (const segment of playerTrack) {
      trackKeys.add(`${segment.from.row},${segment.from.col}`);
      trackKeys.add(`${segment.to.row},${segment.to.col}`);
    }

    // If we already have track to the destination city, high score
    const hasTrackToDestination = destCityKeys.some(key => trackKeys.has(key));
    if (hasTrackToDestination) {
      return 30; // Excellent - already connected
    }

    // Calculate rough distance from current position to destination
    const trainPos = player.trainState.position;
    const destCenter = destinationGroup.center;

    // Estimate distance in grid units (row, col difference)
    const gridDistance = Math.abs(trainPos.row - destCenter.row) + Math.abs(trainPos.col - destCenter.col);

    // Score inversely proportional to distance (closer = higher score)
    // Normalize: 0 distance = 25 points, 50+ grid units = 5 points
    const distanceScore = Math.max(5, 25 - (gridDistance * 0.4));

    return distanceScore;
  }

  /**
   * Calculate score based on load availability
   * Higher score if the load is readily available
   */
  private calculateAvailabilityScore(
    card: DemandCard,
    gameState: AIGameState
  ): number {
    const demand = card.demands[0];
    if (!demand) {
      return 5;
    }

    const loadType = demand.resource;

    // Check how many cities have this load available
    let availableCities = 0;
    for (const [, loads] of gameState.availableLoads) {
      if (loads.includes(loadType)) {
        availableCities++;
      }
    }

    // Also check dropped loads
    const droppedLoadCount = gameState.droppedLoads.filter(
      drop => drop.loadType === loadType
    ).length;

    // Score based on availability (more sources = higher score)
    // 0 sources = 0 points, 1 source = 8 points, 2+ sources = 12-15 points
    if (availableCities === 0 && droppedLoadCount === 0) {
      return 0; // Load is scarce or unavailable
    }

    const totalSources = availableCities + droppedLoadCount;
    return Math.min(15, 5 + totalSources * 4);
  }

  /**
   * Calculate penalty based on competition for the load
   * Higher penalty if many opponents want the same load type
   */
  private calculateCompetitionScore(
    card: DemandCard,
    gameState: AIGameState
  ): number {
    const demand = card.demands[0];
    if (!demand) {
      return 0;
    }

    const loadType = demand.resource;

    // Count opponents who have demand cards for the same load type
    let competitorCount = 0;
    for (const player of gameState.players) {
      if (player.id === gameState.currentPlayerId) continue; // Skip self

      // Check if opponent has any card demanding this load type
      const wantsLoad = player.hand?.some(opponentCard =>
        opponentCard.demands.some(d => d.resource === loadType)
      );

      if (wantsLoad) {
        competitorCount++;
      }
    }

    // Penalty based on competition (0-15 points)
    // 0 competitors = 0 penalty, 1 = 5, 2 = 10, 3+ = 15
    return Math.min(15, competitorCount * 5);
  }

  /**
   * Calculate value of a player's track network
   */
  private calculateNetworkValue(track: TrackSegment[]): number {
    if (track.length === 0) {
      return 0;
    }

    // Basic value from track coverage (0-10 points, caps at 20 segments)
    const coverageValue = Math.min(10, track.length * 0.5);

    // Bonus for major city connections (0-15 points based on progress to 7 cities)
    const connectedCities = this.countConnectedMajorCities(track);
    const cityBonus = Math.min(15, (connectedCities / VICTORY_MAJOR_CITIES) * 15);

    return coverageValue + cityBonus;
  }

  /**
   * Calculate delivery potential based on hand and network
   */
  private calculateDeliveryPotential(
    player: Player,
    gameState: AIGameState
  ): number {
    if (!player.hand || player.hand.length === 0) {
      return 0;
    }

    let potential = 0;
    for (const card of player.hand) {
      const cardScore = this.scoreDemandCard(card, player, gameState);
      potential += cardScore / player.hand.length * 0.25;
    }

    return Math.min(25, potential);
  }

  /**
   * Calculate progress toward victory conditions
   */
  private calculateVictoryProgress(
    player: Player,
    track: TrackSegment[]
  ): number {
    // Cash progress (0-10 points)
    const cashProgress = Math.min(10, (player.money / VICTORY_CASH) * 10);

    // Major city progress (0-10 points based on progress to 7 cities)
    const connectedCities = this.countConnectedMajorCities(track);
    const cityProgress = Math.min(10, (connectedCities / VICTORY_MAJOR_CITIES) * 10);

    return cashProgress + cityProgress;
  }

  /**
   * Calculate threat level from opponent's cash position
   */
  private calculateCashThreat(opponent: Player): number {
    // Higher threat if opponent is close to winning cash
    const cashRatio = opponent.money / VICTORY_CASH;
    return Math.min(50, cashRatio * 50);
  }

  /**
   * Calculate threat from opponent's position relative to player
   * Considers overlapping goals, similar destinations, and victory proximity
   */
  private calculatePositionThreat(player: Player, opponent: Player): number {
    let threat = 0;

    // Check how close opponent is to winning (cash-wise)
    const opponentCashProgress = opponent.money / VICTORY_CASH;
    threat += Math.min(25, opponentCashProgress * 30);

    // Check for overlapping demand cards (competing for same deliveries)
    if (player.hand && opponent.hand) {
      let overlappingDemands = 0;
      for (const playerCard of player.hand) {
        for (const opponentCard of opponent.hand) {
          // Check if they want the same load type
          const playerLoads = playerCard.demands.map(d => d.resource);
          const opponentLoads = opponentCard.demands.map(d => d.resource);
          const overlap = playerLoads.some(load => opponentLoads.includes(load));
          if (overlap) {
            overlappingDemands++;
          }
        }
      }
      // More overlapping demands = higher threat
      threat += Math.min(20, overlappingDemands * 5);
    }

    // Check if opponent has more money than us (they're ahead)
    if (opponent.money > player.money) {
      const moneyGap = opponent.money - player.money;
      threat += Math.min(10, moneyGap / 20);
    }

    return Math.min(50, threat);
  }

  /**
   * Count major cities connected by a track network
   * Builds a graph from track segments and finds which major cities are in the same connected component
   */
  countConnectedMajorCities(track: TrackSegment[]): number {
    if (track.length === 0) {
      return 0;
    }

    // Build adjacency graph from track segments using row,col as keys
    const graph = new Map<string, Set<string>>();
    const addEdge = (key1: string, key2: string) => {
      if (!graph.has(key1)) graph.set(key1, new Set());
      if (!graph.has(key2)) graph.set(key2, new Set());
      graph.get(key1)!.add(key2);
      graph.get(key2)!.add(key1);
    };

    for (const segment of track) {
      const fromKey = `${segment.from.row},${segment.from.col}`;
      const toKey = `${segment.to.row},${segment.to.col}`;
      addEdge(fromKey, toKey);
    }

    // Get major city groups
    const majorCityGroups = getMajorCityGroups();

    // Add implicit connections within major cities (all outposts connected to center)
    for (const cityGroup of majorCityGroups) {
      const centerKey = `${cityGroup.center.row},${cityGroup.center.col}`;
      const allCityKeys = [centerKey, ...cityGroup.outposts.map(o => `${o.row},${o.col}`)];

      // Find which city points are in the track graph
      const cityNodesInGraph = allCityKeys.filter(key => graph.has(key));

      // Connect all city nodes to each other (internal city rail network)
      for (let i = 0; i < cityNodesInGraph.length; i++) {
        for (let j = i + 1; j < cityNodesInGraph.length; j++) {
          addEdge(cityNodesInGraph[i], cityNodesInGraph[j]);
        }
      }
    }

    // Find the largest connected component
    const visited = new Set<string>();
    let largestComponent = new Set<string>();

    for (const startKey of graph.keys()) {
      if (visited.has(startKey)) continue;

      // BFS to find connected component
      const component = new Set<string>();
      const queue = [startKey];
      component.add(startKey);
      visited.add(startKey);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const neighbors = graph.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            component.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      if (component.size > largestComponent.size) {
        largestComponent = component;
      }
    }

    // Count how many major cities have at least one milepost in the largest component
    let connectedCityCount = 0;
    for (const cityGroup of majorCityGroups) {
      const centerKey = `${cityGroup.center.row},${cityGroup.center.col}`;
      const outpostKeys = cityGroup.outposts.map(o => `${o.row},${o.col}`);
      const allCityKeys = [centerKey, ...outpostKeys];

      // Check if any milepost of this city is in the connected component
      if (allCityKeys.some(key => largestComponent.has(key))) {
        connectedCityCount++;
      }
    }

    return connectedCityCount;
  }

  /**
   * Check if player meets victory conditions
   */
  checkVictoryConditions(player: Player, track: TrackSegment[]): boolean {
    const hasCash = player.money >= VICTORY_CASH;
    const hasCities = this.countConnectedMajorCities(track) >= VICTORY_MAJOR_CITIES;
    return hasCash && hasCities;
  }
}

// Singleton instance
let instance: AIEvaluator | null = null;

export function getAIEvaluator(): AIEvaluator {
  if (!instance) {
    instance = new AIEvaluator();
  }
  return instance;
}
