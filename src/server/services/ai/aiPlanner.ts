/**
 * AI Planner Service
 * Strategic decision-making for AI players
 */

import { AIDifficulty, AIPersonality, Player } from '../../../shared/types/GameTypes';
import {
  AIConfig,
  AITurnPlan,
  TurnOption,
  RankedOption,
  AIGameState
} from './types';
import { AI_DIFFICULTY_CONFIG, AI_PERSONALITY_CONFIG } from './aiConfig';

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

    // TODO: Implement in BE-002
    // - Generate build options
    // - Generate movement options
    // - Generate pickup/delivery options
    // - Generate upgrade options
    // - Add pass option

    // Stub: return basic pass option
    options.push({
      type: 'pass',
      priority: 0,
      expectedValue: 0,
      details: {},
    });

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
   */
  private selectActions(
    rankedOptions: RankedOption[],
    config: AIConfig
  ): RankedOption[] {
    if (rankedOptions.length === 0) {
      return [];
    }

    // For now, select the top-scoring option
    // TODO: Implement multi-action selection in BE-002
    return [rankedOptions[0]];
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
    // TODO: Implement personality-specific reasoning in BE-002
    return `${option.type} action with expected value ${option.expectedValue}.`;
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
