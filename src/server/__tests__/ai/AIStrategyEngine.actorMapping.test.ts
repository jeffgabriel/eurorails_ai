/**
 * AIStrategyEngine actor mapping tests — TEST-003
 *
 * Tests mapActorMetadata() for correct population of actor, actorDetail,
 * and llmModel in BotTurnResult for all model values.
 */

import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';

describe('AIStrategyEngine.mapActorMetadata', () => {
  const mapActorMetadata = AIStrategyEngine.mapActorMetadata;

  describe('system actors', () => {
    it('maps initial-build-planner to system actor', () => {
      const result = mapActorMetadata('initial-build-planner', false);
      expect(result).toEqual({ actor: 'system', actorDetail: 'initial-build-planner' });
    });

    it('maps route-executor to system actor', () => {
      const result = mapActorMetadata('route-executor', false);
      expect(result).toEqual({ actor: 'system', actorDetail: 'route-executor' });
    });
  });

  describe('heuristic actors', () => {
    it('maps broke-bot-heuristic to heuristic actor', () => {
      const result = mapActorMetadata('broke-bot-heuristic', false);
      expect(result).toEqual({ actor: 'heuristic', actorDetail: 'broke-bot-heuristic' });
    });

    it('maps heuristic-fallback to heuristic actor', () => {
      const result = mapActorMetadata('heuristic-fallback', false);
      expect(result).toEqual({ actor: 'heuristic', actorDetail: 'heuristic-fallback' });
    });
  });

  describe('LLM actors', () => {
    it('maps trip-planner to llm actor without llmModel', () => {
      const result = mapActorMetadata('trip-planner', false);
      expect(result).toEqual({ actor: 'llm', actorDetail: 'trip-planner' });
      expect(result.llmModel).toBeUndefined();
    });

    it('maps an actual model ID to llm/strategy-brain with llmModel', () => {
      const result = mapActorMetadata('claude-haiku-4-5-20251001', false);
      expect(result).toEqual({
        actor: 'llm',
        actorDetail: 'strategy-brain',
        llmModel: 'claude-haiku-4-5-20251001',
      });
    });

    it('maps another model ID to llm/strategy-brain', () => {
      const result = mapActorMetadata('gemini-2.5-flash', false);
      expect(result).toEqual({
        actor: 'llm',
        actorDetail: 'strategy-brain',
        llmModel: 'gemini-2.5-flash',
      });
    });
  });

  describe('error actors', () => {
    it('maps llm-failed to error actor', () => {
      const result = mapActorMetadata('llm-failed', false);
      expect(result).toEqual({ actor: 'error', actorDetail: 'llm-failed' });
    });

    it('maps no-api-key to error actor', () => {
      const result = mapActorMetadata('no-api-key', false);
      expect(result).toEqual({ actor: 'error', actorDetail: 'no-api-key' });
    });

    it('maps pipeline-error to error actor', () => {
      const result = mapActorMetadata('pipeline-error', false);
      expect(result).toEqual({ actor: 'error', actorDetail: 'pipeline-error' });
    });
  });

  describe('guardrail override', () => {
    it('overrides any model value when guardrailOverridden is true', () => {
      const result = mapActorMetadata('claude-haiku-4-5-20251001', true);
      expect(result).toEqual({ actor: 'guardrail', actorDetail: 'guardrail-enforcer' });
      expect(result.llmModel).toBeUndefined();
    });

    it('overrides system model when guardrailOverridden is true', () => {
      const result = mapActorMetadata('route-executor', true);
      expect(result).toEqual({ actor: 'guardrail', actorDetail: 'guardrail-enforcer' });
    });

    it('overrides undefined model when guardrailOverridden is true', () => {
      const result = mapActorMetadata(undefined, true);
      expect(result).toEqual({ actor: 'guardrail', actorDetail: 'guardrail-enforcer' });
    });
  });

  describe('edge cases', () => {
    it('maps undefined model to system/unknown', () => {
      const result = mapActorMetadata(undefined, false);
      expect(result).toEqual({ actor: 'system', actorDetail: 'unknown' });
    });
  });
});
