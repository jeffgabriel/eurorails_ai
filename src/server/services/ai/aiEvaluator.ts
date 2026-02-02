/**
 * AI Evaluator Service
 * State evaluation and threat assessment for AI players
 */

import { Player, TrackSegment } from '../../../shared/types/GameTypes';
import { DemandCard } from '../../../shared/types/DemandCard';
import { PositionScore, ThreatAssessment, AIGameState } from './types';
import { getAIPathfinder } from './aiPathfinder';

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

    let overallThreat = 0;

    for (const opponent of opponents) {
      // Calculate threat from this opponent
      const cashThreat = this.calculateCashThreat(opponent);
      const positionThreat = this.calculatePositionThreat(player, opponent);

      overallThreat += (cashThreat + positionThreat) / opponents.length;

      // Check for blocking threats
      // TODO: Implement detailed blocking analysis in BE-002
    }

    // Analyze load competition
    // TODO: Implement load competition analysis in BE-002

    return {
      overallThreat: Math.min(100, overallThreat),
      blockingThreats,
      competitionForLoads,
    };
  }

  /**
   * Calculate score based on distance to pickup and delivery
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

    // TODO: Calculate actual distance using pathfinder in BE-002
    // For now, return a moderate score
    return 20;
  }

  /**
   * Calculate score based on load availability
   */
  private calculateAvailabilityScore(
    card: DemandCard,
    gameState: AIGameState
  ): number {
    // Check if the load is available at any pickup city
    // TODO: Implement in BE-002 when load availability data is accessible
    return 10; // Default moderate availability
  }

  /**
   * Calculate penalty based on competition for the load
   */
  private calculateCompetitionScore(
    card: DemandCard,
    gameState: AIGameState
  ): number {
    // Check how many other players might want this load
    // TODO: Implement by checking opponent hands in BE-002
    return 5; // Default low competition
  }

  /**
   * Calculate value of a player's track network
   */
  private calculateNetworkValue(track: TrackSegment[]): number {
    if (track.length === 0) {
      return 0;
    }

    // Basic value from track coverage
    const coverageValue = Math.min(15, track.length * 0.5);

    // Bonus for major city connections
    // TODO: Calculate actual major city connections in BE-002
    const cityBonus = 5;

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

    // Major city progress (0-10 points)
    // TODO: Calculate actual major city connections in BE-002
    const cityProgress = 5;

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
   */
  private calculatePositionThreat(player: Player, opponent: Player): number {
    // TODO: Implement detailed position threat analysis in BE-002
    // Consider overlapping routes, competition for cities, etc.
    return 25; // Default moderate threat
  }

  /**
   * Count major cities connected by a track network
   */
  countConnectedMajorCities(track: TrackSegment[]): number {
    // TODO: Implement by checking track against major city list in BE-002
    return 0;
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
