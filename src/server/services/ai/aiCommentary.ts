/**
 * AI Commentary Service
 * Personality-driven text generation for AI players
 */

import { AIPersonality } from '../../../shared/types/GameTypes';
import { AIAction, AIDebugInfo } from '../../../shared/types/AITypes';
import { AITurnPlan, AIDecision, PersonalityParams } from './types';
import { AI_PERSONALITY_CONFIG } from './aiConfig';

/** Commentary templates by personality */
const COMMENTARY_TEMPLATES: Record<PersonalityParams['commentaryStyle'], CommentaryTemplates> = {
  analytical: {
    build: [
      'Building {target} for {cost}M. ROI: {roi}x. Acceptable.',
      'Track extension to {target} calculated at {cost}M. Efficiency: optimal.',
      'Cost-benefit analysis favors {target} route. Proceeding.',
    ],
    move: [
      'Moving to {destination}. {mileposts} mileposts remaining.',
      'Optimal path to {destination} identified. Distance: {distance}.',
      'Traversing route. Efficiency rating: {efficiency}.',
    ],
    deliver: [
      'Delivery complete: {load} to {city}. Net gain: {payout}M.',
      'Cargo delivered. ROI on this transaction: {roi}%.',
      'Contract fulfilled. Profit margin: acceptable.',
    ],
    pickup: [
      'Acquiring {load} at {city}. Demand card value: {value}M.',
      'Load secured. Transport efficiency calculated.',
      'Cargo loaded. Capacity utilization: {capacity}%.',
    ],
    strategy: [
      'Current strategy: maximizing ROI per milepost traveled.',
      'Optimization focus: {goal}. Progress: {progress}%.',
      'Efficiency metrics trending positive. Continuing current approach.',
    ],
    idle: [
      'Analyzing options. No optimal move identified yet.',
      'Calculating alternatives...',
      'Data insufficient for action. Holding position.',
    ],
  },
  strategic: {
    build: [
      '{target} connection complete. Network expansion continues.',
      'Infrastructure investment: {target}. Long-term value secured.',
      'Building toward {goal}. Foundation strengthening.',
    ],
    move: [
      'Positioning for future opportunities at {destination}.',
      'Strategic relocation to {destination}. Network leverage increasing.',
      'Moving into position. The network grows stronger.',
    ],
    deliver: [
      'Delivery funds network expansion. {payout}M secured.',
      '{load} delivered. Resources for growth acquired.',
      'Contract complete. Reinvesting in infrastructure.',
    ],
    pickup: [
      '{load} acquired. Part of the larger plan.',
      'Loading {load}. Another piece falls into place.',
      'Cargo secured for strategic delivery.',
    ],
    strategy: [
      'Building the network. Opportunities will follow.',
      'Phase: infrastructure development. Goal: {goal}.',
      '{cities} major cities connected. Progress steady.',
    ],
    idle: [
      'Planning next expansion phase...',
      'Evaluating network growth options.',
      'Strategic pause. Analyzing the board.',
    ],
  },
  reactive: {
    build: [
      '{target}? Perfect opportunity! Building now.',
      'Spotted a great route to {target}. Going for it!',
      'Quick build to {target}. Fortune favors the bold!',
    ],
    move: [
      'Racing to {destination}! {payout}M awaits!',
      'New opportunity at {destination}. Moving fast!',
      'Chasing the big score at {destination}!',
    ],
    deliver: [
      'Yes! {payout}M in the bank!',
      '{load} delivered! What a haul!',
      'Another successful delivery! On to the next!',
    ],
    pickup: [
      'Grabbing {load} while it\'s available!',
      'Quick pickup at {city}. Opportunity seized!',
      '{load} secured! Now for the delivery!',
    ],
    strategy: [
      'Following the money wherever it leads.',
      'Current chase: {goal}. Adapting as needed.',
      'Staying flexible. The best deals come unexpectedly.',
    ],
    idle: [
      'Scanning for opportunities...',
      'Something good will come up soon!',
      'Waiting for the right moment...',
    ],
  },
  competitive: {
    build: [
      'Built into {target}. That slot is mine now.',
      'Securing {target} before the competition.',
      'Strategic position at {target} established.',
    ],
    move: [
      'Moving to {destination}. Watching the competition.',
      'Heading to {destination}. Let\'s see them match this.',
      'Positioning against opponents at {destination}.',
    ],
    deliver: [
      'Delivery complete. {payout}M ahead of the pack.',
      '{load} delivered. That\'s one they won\'t get.',
      'Contract secured. Competition denied.',
    ],
    pickup: [
      'Grabbed {load} before {opponent} could reach it.',
      '{load} secured. One less option for others.',
      'That {load} won\'t be going to anyone else.',
    ],
    strategy: [
      'Monitoring opponent positions. Staying ahead.',
      'Goal: deny key routes to competition.',
      'Blocking strategy active. They won\'t pass easily.',
    ],
    idle: [
      'Watching what others are planning...',
      'Analyzing opponent moves.',
      'Strategic observation in progress.',
    ],
  },
  methodical: {
    build: [
      'Steady progress: {target} connected.',
      'Another step forward. {target} complete.',
      'Careful expansion to {target}. No rush needed.',
    ],
    move: [
      'Proceeding to {destination}. Patience pays.',
      'Measured progress toward {destination}.',
      'Moving steadily. One milepost at a time.',
    ],
    deliver: [
      'Delivery complete. {payout}M added. Progress continues.',
      '{load} delivered safely. No complications.',
      'Contract fulfilled as planned. Moving forward.',
    ],
    pickup: [
      '{load} loaded carefully. Ready for transport.',
      'Pickup complete at {city}. As scheduled.',
      'Cargo secured. Proceeding with the plan.',
    ],
    strategy: [
      'Slow and steady. The race isn\'t always to the swift.',
      'Current goal: {goal}. Proceeding methodically.',
      'Step by step progress. {progress}% complete.',
    ],
    idle: [
      'Taking time to evaluate all options.',
      'No need to rush. Considering carefully.',
      'Patience. The right move will present itself.',
    ],
  },
  humorous: {
    build: [
      'Building to {target} because... vibes.',
      'Why {target}? Why not! YOLO!',
      'Random track to {target}. The chaos has a plan.',
    ],
    move: [
      'Heading to {destination}. Or am I? Yes. Maybe.',
      'Plot twist! Moving to {destination}!',
      'Destination: {destination}. Probably.',
    ],
    deliver: [
      'Delivered {load}! I meant to do that.',
      '{payout}M! Even chaos can be profitable!',
      'Success! According to my totally real plan!',
    ],
    pickup: [
      'Ooh, shiny {load}! Mine now!',
      'Grabbing {load}. No particular reason.',
      '{load} at {city}? Don\'t mind if I do!',
    ],
    strategy: [
      'Strategy? I prefer \"creative improvisation.\"',
      'Current plan: keep everyone guessing.',
      'Chaos is just order waiting to be discovered.',
    ],
    idle: [
      'Contemplating the mysteries of railroad management...',
      '*Chaotic contemplation noises*',
      'The plan is developing. Trust the process.',
    ],
  },
};

interface CommentaryTemplates {
  build: string[];
  move: string[];
  deliver: string[];
  pickup: string[];
  strategy: string[];
  idle: string[];
}

export class AICommentary {
  /**
   * Generate a turn summary with personality-appropriate commentary
   * @param actions Actions taken during the turn
   * @param personality AI personality type
   * @returns Human-readable turn summary
   */
  generateTurnSummary(
    actions: AIAction[],
    personality: AIPersonality
  ): string {
    const config = AI_PERSONALITY_CONFIG[personality];
    const templates = COMMENTARY_TEMPLATES[config.commentaryStyle];

    if (actions.length === 0) {
      return this.selectTemplate(templates.idle, {});
    }

    const summaries = actions.map(action => {
      const actionTemplates = templates[action.type as keyof CommentaryTemplates] || templates.idle;
      return this.selectTemplate(actionTemplates, action.details);
    });

    return summaries.join(' ');
  }

  /**
   * Generate a strategy description with personality-appropriate commentary
   * @param plan The AI's current turn plan
   * @param personality AI personality type
   * @returns Human-readable strategy description
   */
  generateStrategyDescription(
    plan: AITurnPlan,
    personality: AIPersonality
  ): string {
    const config = AI_PERSONALITY_CONFIG[personality];
    const templates = COMMENTARY_TEMPLATES[config.commentaryStyle];

    const baseStrategy = this.selectTemplate(templates.strategy, {
      goal: plan.reasoning || 'general progress',
      progress: Math.floor(Math.random() * 30 + 50), // Placeholder
      cities: Math.floor(Math.random() * 4 + 1), // Placeholder
    });

    // Add personality-specific flavor
    return this.addPersonalityFlavor(baseStrategy, personality);
  }

  /**
   * Generate debug information for development/testing
   * @param decision The AI's decision details
   * @returns Formatted debug information
   */
  generateDebugInfo(decision: AIDecision): AIDebugInfo {
    return {
      routesEvaluated: decision.optionsConsidered.length,
      selectedRouteScore: decision.selectedOption?.score || 0,
      decisionTimeMs: decision.evaluationTimeMs,
      variablesConsidered: this.extractVariableNames(decision),
    };
  }

  /**
   * Select and fill a template with provided values
   */
  private selectTemplate(
    templates: string[],
    values: Record<string, unknown>
  ): string {
    if (templates.length === 0) {
      return '';
    }

    // Select a random template
    const template = templates[Math.floor(Math.random() * templates.length)];

    // Fill in values
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      const value = values[key];
      if (value !== undefined && value !== null) {
        return String(value);
      }
      return match; // Keep placeholder if no value
    });
  }

  /**
   * Add personality-specific flavor to text
   */
  private addPersonalityFlavor(text: string, personality: AIPersonality): string {
    switch (personality) {
      case 'optimizer':
        return text + ' Efficiency is everything.';
      case 'network_builder':
        return text + ' The network expands.';
      case 'opportunist':
        return text + ' Staying flexible.';
      case 'blocker':
        return text + ' Watching the competition.';
      case 'steady_hand':
        return text + ' Patience pays.';
      case 'chaos_agent':
        return text + ' ...probably.';
      default:
        return text;
    }
  }

  /**
   * Extract variable names from decision for debug info
   */
  private extractVariableNames(decision: AIDecision): string[] {
    const variables = new Set<string>();

    for (const option of decision.optionsConsidered) {
      for (const key of Object.keys(option.details)) {
        variables.add(key);
      }
    }

    return Array.from(variables);
  }

  /**
   * Generate a random AI player name based on personality
   */
  static generateAIName(personality: AIPersonality): string {
    const names: Record<AIPersonality, string[]> = {
      optimizer: ['Otto', 'Olga', 'Oscar', 'Olivia'],
      network_builder: ['Nadine', 'Norbert', 'Natasha', 'Nelson'],
      opportunist: ['Oliver', 'Ophelia', 'Orlando', 'Octavia'],
      blocker: ['Boris', 'Beatrix', 'Bruno', 'Bridget'],
      steady_hand: ['Stefan', 'Sylvia', 'Samuel', 'Sophie'],
      chaos_agent: ['Chaos Carl', 'Crazy Clara', 'Wild Werner', 'Zany Zelda'],
    };

    const personalityNames = names[personality];
    return personalityNames[Math.floor(Math.random() * personalityNames.length)];
  }
}

// Singleton instance
let instance: AICommentary | null = null;

export function getAICommentary(): AICommentary {
  if (!instance) {
    instance = new AICommentary();
  }
  return instance;
}
