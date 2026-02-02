/**
 * AI Planner Service
 * Strategic decision-making for AI players
 */

import { AIDifficulty, AIPersonality, Player, TrainType, TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import {
  AIConfig,
  AITurnPlan,
  TurnOption,
  RankedOption,
  AIGameState,
  PersonalityParams,
  DifficultyParams
} from './types';
import { AI_DIFFICULTY_CONFIG, AI_PERSONALITY_CONFIG, AI_BUILD_BUDGET_PER_TURN } from './aiConfig';
import { getAIPathfinder } from './aiPathfinder';
import { getAIEvaluator } from './aiEvaluator';

export class AIPlanner {
  /**
   * Plan the AI's turn based on current game state and configuration
   * @param gameState Current game state including all players and board
   * @param player The AI player making decisions
   * @param config AI configuration (difficulty + personality)
   * @returns A plan for the turn including actions to take
   */
  planTurn(
    gameState: AIGameState,
    player: Player,
    config: AIConfig
  ): AITurnPlan {
    // Get all possible options for this turn
    const options = this.generateOptions(gameState, player, config);

    // Evaluate and rank options based on difficulty and personality
    const rankedOptions = this.evaluateOptions(
      options,
      player.aiDifficulty || 'easy',
      player.aiPersonality || 'optimizer'
    );

    // Select the best option(s) based on evaluation depth
    const selectedActions = this.selectActions(rankedOptions, config);

    return {
      actions: selectedActions.map(opt => ({
        type: opt.type as 'build' | 'move' | 'pickup' | 'deliver' | 'drop' | 'upgrade',
        description: opt.reasoning,
        details: opt.details,
      })),
      expectedCashChange: selectedActions.reduce((sum, opt) => sum + opt.expectedValue, 0),
      reasoning: this.generatePlanReasoning(selectedActions, config),
      alternativesConsidered: options.length,
    };
  }

  /**
   * Evaluate and rank turn options based on difficulty and personality
   * @param options List of possible turn options
   * @param difficulty AI difficulty level
   * @param personality AI personality type
   * @returns Ranked and scored options
   */
  evaluateOptions(
    options: TurnOption[],
    difficulty: AIDifficulty,
    personality: AIPersonality
  ): RankedOption[] {
    const difficultyConfig = AI_DIFFICULTY_CONFIG[difficulty];
    const personalityConfig = AI_PERSONALITY_CONFIG[personality];

    // Score each option based on personality weights and difficulty depth
    const scoredOptions: RankedOption[] = options.map(option => {
      const baseScore = this.calculateBaseScore(option, personalityConfig);
      const adjustedScore = this.adjustForDifficulty(baseScore, option, difficultyConfig);
      const riskAdjustedScore = this.adjustForRisk(adjustedScore, option, personalityConfig.riskTolerance);

      return {
        ...option,
        score: riskAdjustedScore,
        reasoning: this.generateOptionReasoning(option, personalityConfig),
      };
    });

    // Sort by score descending
    scoredOptions.sort((a, b) => b.score - a.score);

    // Apply evaluation depth filter
    return this.applyEvaluationDepth(scoredOptions, difficultyConfig.evaluationDepth);
  }

  /**
   * Generate all possible options for the current turn
   */
  private generateOptions(
    gameState: AIGameState,
    player: Player,
    config: AIConfig
  ): TurnOption[] {
    const options: TurnOption[] = [];
    const pathfinder = getAIPathfinder();
    const evaluator = getAIEvaluator();

    // 1. Generate delivery options (highest priority if we have loads)
    const deliveryOptions = this.generateDeliveryOptions(player, gameState, evaluator);
    options.push(...deliveryOptions);

    // 2. Generate pickup options (if we have capacity)
    const pickupOptions = this.generatePickupOptions(player, gameState, evaluator);
    options.push(...pickupOptions);

    // 3. Generate movement options (if not at optimal location)
    const movementOptions = this.generateMovementOptions(player, gameState, config);
    options.push(...movementOptions);

    // 4. Generate build options (if we have money and it's strategic)
    const buildOptions = this.generateBuildOptions(player, gameState, pathfinder, config);
    options.push(...buildOptions);

    // 5. Generate upgrade options (if beneficial)
    const upgradeOptions = this.generateUpgradeOptions(player, config);
    options.push(...upgradeOptions);

    // 6. Always add pass option as fallback
    options.push({
      type: 'pass',
      priority: 0,
      expectedValue: 0,
      details: {
        reason: 'No better options available',
      },
    });

    return options;
  }

  /**
   * Generate delivery options based on current loads and demand cards
   */
  private generateDeliveryOptions(
    player: Player,
    gameState: AIGameState,
    evaluator: ReturnType<typeof getAIEvaluator>
  ): TurnOption[] {
    const options: TurnOption[] = [];
    const loads = player.trainState.loads || [];

    if (loads.length === 0) {
      return options;
    }

    // Check each demand card for deliverable loads
    for (const card of player.hand || []) {
      for (const demand of card.demands) {
        // Check if we have the required load
        if (loads.includes(demand.resource)) {
          const cardScore = evaluator.scoreDemandCard(card, player, gameState);

          options.push({
            type: 'deliver',
            priority: 10, // High priority
            expectedValue: demand.payment,
            details: {
              loadType: demand.resource,
              destinationCity: demand.city,
              payout: demand.payment,
              roi: demand.payment, // Already have the load
              cardScore,
              immediatePayout: demand.payment,
            },
          });
        }
      }
    }

    return options;
  }

  /**
   * Generate pickup options based on available loads and train capacity
   */
  private generatePickupOptions(
    player: Player,
    gameState: AIGameState,
    evaluator: ReturnType<typeof getAIEvaluator>
  ): TurnOption[] {
    const options: TurnOption[] = [];
    const currentLoads = player.trainState.loads || [];
    const capacity = TRAIN_PROPERTIES[player.trainType].capacity;

    // Check if we have capacity
    if (currentLoads.length >= capacity) {
      return options;
    }

    // Find loads we need based on demand cards
    const neededLoads = new Set<string>();
    for (const card of player.hand || []) {
      for (const demand of card.demands) {
        if (!currentLoads.includes(demand.resource)) {
          neededLoads.add(demand.resource);
        }
      }
    }

    // Check available loads at current location or nearby
    for (const [cityName, availableLoads] of gameState.availableLoads) {
      for (const loadType of availableLoads) {
        if (neededLoads.has(loadType)) {
          // Find the demand card that wants this load
          const relevantCard = (player.hand || []).find(card =>
            card.demands.some(d => d.resource === loadType)
          );
          const relevantDemand = relevantCard?.demands.find(d => d.resource === loadType);
          const payout = relevantDemand?.payment || 0;

          options.push({
            type: 'pickup',
            priority: 8,
            expectedValue: payout * 0.5, // Discount for not yet delivered
            details: {
              loadType,
              sourceCity: cityName,
              potentialPayout: payout,
              flexibility: 1.2,
            },
          });
        }
      }
    }

    return options;
  }

  /**
   * Generate movement options based on goals
   */
  private generateMovementOptions(
    player: Player,
    gameState: AIGameState,
    config: AIConfig
  ): TurnOption[] {
    const options: TurnOption[] = [];

    if (!player.trainState.position) {
      return options;
    }

    // Movement toward delivery destinations
    for (const card of player.hand || []) {
      for (const demand of card.demands) {
        const hasLoad = player.trainState.loads?.includes(demand.resource);
        if (hasLoad) {
          // Move toward delivery destination
          options.push({
            type: 'move',
            priority: 7,
            expectedValue: demand.payment * 0.3, // Partial value for moving closer
            details: {
              destination: demand.city,
              purpose: 'delivery',
              distance: 10, // Placeholder
            },
          });
        }
      }
    }

    // Movement toward pickup locations
    for (const [cityName, loads] of gameState.availableLoads) {
      const hasCapacity = (player.trainState.loads?.length || 0) <
        TRAIN_PROPERTIES[player.trainType].capacity;
      if (hasCapacity) {
        options.push({
          type: 'move',
          priority: 5,
          expectedValue: 5,
          details: {
            destination: cityName,
            purpose: 'pickup',
            distance: 10, // Placeholder
          },
        });
      }
    }

    return options;
  }

  /**
   * Generate build options for track expansion
   */
  private generateBuildOptions(
    player: Player,
    gameState: AIGameState,
    pathfinder: ReturnType<typeof getAIPathfinder>,
    config: AIConfig
  ): TurnOption[] {
    const options: TurnOption[] = [];

    // Check if player can afford to build
    const buildBudget = Math.min(player.money, AI_BUILD_BUDGET_PER_TURN);
    if (buildBudget < 1) {
      return options;
    }

    // Get build recommendations from pathfinder
    const buildCandidates = pathfinder.evaluateTrackBuildOptions(player, gameState);

    for (const candidate of buildCandidates.slice(0, 5)) {
      if (candidate.cost <= buildBudget) {
        options.push({
          type: 'build',
          priority: 6,
          expectedValue: candidate.strategicValue,
          details: {
            targetRow: candidate.targetPoint.row,
            targetCol: candidate.targetPoint.col,
            cost: candidate.cost,
            connectsMajorCity: candidate.connectsMajorCity,
            connectivity: candidate.strategicValue,
            futureValue: candidate.strategicValue * 1.5,
          },
        });
      }
    }

    return options;
  }

  /**
   * Generate train upgrade options
   */
  private generateUpgradeOptions(
    player: Player,
    config: AIConfig
  ): TurnOption[] {
    const options: TurnOption[] = [];
    const upgradeCost = 20; // ECU 20M to upgrade

    if (player.money < upgradeCost) {
      return options;
    }

    const currentTrain = player.trainType;

    // Determine possible upgrades
    const possibleUpgrades: Array<{ to: TrainType; benefit: string; value: number }> = [];

    switch (currentTrain) {
      case TrainType.Freight:
        possibleUpgrades.push(
          { to: TrainType.FastFreight, benefit: 'speed', value: 8 },
          { to: TrainType.HeavyFreight, benefit: 'capacity', value: 10 }
        );
        break;
      case TrainType.FastFreight:
        possibleUpgrades.push(
          { to: TrainType.Superfreight, benefit: 'capacity', value: 12 }
        );
        break;
      case TrainType.HeavyFreight:
        possibleUpgrades.push(
          { to: TrainType.Superfreight, benefit: 'speed', value: 12 }
        );
        break;
      // Superfreight - no upgrades available
    }

    for (const upgrade of possibleUpgrades) {
      options.push({
        type: 'upgrade',
        priority: 4,
        expectedValue: upgrade.value,
        details: {
          fromTrain: currentTrain,
          toTrain: upgrade.to,
          benefit: upgrade.benefit,
          cost: upgradeCost,
          efficiency: upgrade.value / upgradeCost,
        },
      });
    }

    return options;
  }

  /**
   * Calculate base score for an option based on personality weights
   */
  private calculateBaseScore(option: TurnOption, personality: PersonalityParams): number {
    let score = option.expectedValue;

    // Apply personality weight multipliers
    for (const [factor, weight] of Object.entries(personality.priorityWeights)) {
      const factorValue = (option.details[factor] as number) || 0;
      score += factorValue * weight;
    }

    return score;
  }

  /**
   * Adjust score based on difficulty level (planning horizon)
   */
  private adjustForDifficulty(
    baseScore: number,
    option: TurnOption,
    difficulty: DifficultyParams
  ): number {
    // Higher difficulty considers future value more
    const futureValueMultiplier = difficulty.planningHorizon / 5;
    const futureValue = (option.details.futureValue as number) || 0;

    return baseScore + (futureValue * futureValueMultiplier);
  }

  /**
   * Adjust score based on risk tolerance
   */
  private adjustForRisk(
    score: number,
    option: TurnOption,
    riskTolerance: number
  ): number {
    const risk = (option.details.risk as number) || 0;

    // Low risk tolerance heavily penalizes risky options
    // High risk tolerance rewards risky high-value options
    // The penalty scales exponentially with risk and inversely with tolerance
    const inverseTolerance = 1 - riskTolerance;
    const riskMultiplier = 1 - (risk * inverseTolerance * 1.5);

    return score * Math.max(0.1, riskMultiplier);
  }

  /**
   * Apply evaluation depth filter based on difficulty
   */
  private applyEvaluationDepth(
    options: RankedOption[],
    depth: 'satisfice' | 'good' | 'optimal'
  ): RankedOption[] {
    switch (depth) {
      case 'satisfice':
        // Return first option that meets minimum threshold
        const threshold = options.length > 0 ? options[0].score * 0.7 : 0;
        const satisficingOption = options.find(opt => opt.score >= threshold);
        return satisficingOption ? [satisficingOption] : options.slice(0, 1);

      case 'good':
        // Return top 3 options
        return options.slice(0, 3);

      case 'optimal':
        // Return all options for full evaluation
        return options;
    }
  }

  /**
   * Select final actions from ranked options
   * Supports selecting multiple compatible actions per turn
   */
  private selectActions(
    rankedOptions: RankedOption[],
    config: AIConfig
  ): RankedOption[] {
    if (rankedOptions.length === 0) {
      return [];
    }

    const selectedActions: RankedOption[] = [];
    const usedTypes = new Set<string>();

    // A turn typically consists of: move + (pickup/deliver) + build/upgrade
    // Select best option for each action type

    // First, select the highest-value delivery or pickup
    const deliveryOption = rankedOptions.find(o =>
      (o.type === 'deliver' || o.type === 'pickup') && !usedTypes.has(o.type)
    );
    if (deliveryOption) {
      selectedActions.push(deliveryOption);
      usedTypes.add(deliveryOption.type);
    }

    // Next, select movement if needed
    const moveOption = rankedOptions.find(o =>
      o.type === 'move' && !usedTypes.has('move')
    );
    if (moveOption && moveOption.score > 0) {
      selectedActions.push(moveOption);
      usedTypes.add('move');
    }

    // Finally, select build or upgrade (mutually exclusive with same budget)
    const buildOrUpgrade = rankedOptions.find(o =>
      (o.type === 'build' || o.type === 'upgrade') &&
      !usedTypes.has('build') && !usedTypes.has('upgrade')
    );
    if (buildOrUpgrade) {
      selectedActions.push(buildOrUpgrade);
      usedTypes.add(buildOrUpgrade.type);
    }

    // If nothing selected, take the top option
    if (selectedActions.length === 0) {
      selectedActions.push(rankedOptions[0]);
    }

    // Sort by priority for execution order
    selectedActions.sort((a, b) => b.priority - a.priority);

    return selectedActions;
  }

  /**
   * Generate human-readable reasoning for the plan
   */
  private generatePlanReasoning(
    actions: RankedOption[],
    config: AIConfig
  ): string {
    if (actions.length === 0) {
      return 'No viable actions available.';
    }

    const actionDescriptions = actions.map(a => a.reasoning).join(' ');
    return actionDescriptions;
  }

  /**
   * Generate reasoning for a specific option based on personality
   */
  private generateOptionReasoning(
    option: TurnOption,
    personality: PersonalityParams
  ): string {
    const value = option.expectedValue;
    const details = option.details;

    // Generate base description
    let baseReason = '';
    switch (option.type) {
      case 'deliver':
        baseReason = `Deliver ${details.loadType} to ${details.destinationCity} for ${details.payout}M`;
        break;
      case 'pickup':
        baseReason = `Pick up ${details.loadType} at ${details.sourceCity}`;
        break;
      case 'move':
        baseReason = `Move toward ${details.destination} for ${details.purpose}`;
        break;
      case 'build':
        baseReason = `Build track toward row ${details.targetRow}, col ${details.targetCol}`;
        break;
      case 'upgrade':
        baseReason = `Upgrade from ${details.fromTrain} to ${details.toTrain}`;
        break;
      case 'pass':
        baseReason = 'Wait this turn';
        break;
      default:
        baseReason = `${option.type} action`;
    }

    // Add personality-flavored commentary
    const style = personality.commentaryStyle;
    let commentary = '';

    switch (style) {
      case 'analytical':
        const roi = details.roi || (value > 0 ? 'positive' : 'neutral');
        commentary = `. ROI: ${roi}. Expected value: ${value}M.`;
        break;
      case 'strategic':
        const futureValue = details.futureValue || 'moderate';
        commentary = `. Strategic value: ${futureValue}. Building toward objectives.`;
        break;
      case 'reactive':
        commentary = value > 10 ? `. Seizing opportunity!` : `. Adapting to situation.`;
        break;
      case 'competitive':
        const denial = (details.opponentDenial as number) || 0;
        commentary = denial > 0 ? `. Blocking opponent access.` : `. Maintaining competitive position.`;
        break;
      case 'methodical':
        const risk = (details.risk as number) || 0;
        commentary = risk < 0.3 ? `. Safe and steady progress.` : `. Calculated risk.`;
        break;
      case 'humorous':
        const funnyReasons = [
          ` Because... why not?`,
          ` The algorithm approves.`,
          ` Trust the process.`,
          ` Chaos theory at work.`,
        ];
        commentary = funnyReasons[Math.floor(Math.random() * funnyReasons.length)];
        break;
      default:
        commentary = `. Expected value: ${value}M.`;
    }

    return baseReason + commentary;
  }
}

// Singleton instance
let instance: AIPlanner | null = null;

export function getAIPlanner(): AIPlanner {
  if (!instance) {
    instance = new AIPlanner();
  }
  return instance;
}
