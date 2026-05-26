/**
 * JIRA-268 — hasLLMApiKey skill-level gate.
 *
 * Verifies that Medium-skill bots never construct an LLM brain regardless
 * of credential availability, while Easy and Hard preserve the existing
 * "credentials present implies brain" behavior.
 *
 * Tests access the private static predicate via bracket notation. No
 * pipeline mocks are needed because the predicate has zero dependencies
 * outside of process.env.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { BotConfig, BotSkillLevel } from '../../../shared/types/GameTypes';

// Bracket-notation handle for the private predicate. Justified at the
// architectural level (ADR-4): widening the predicate's visibility would
// leak an internal helper to external callers; the test surface is the
// only legitimate consumer that needs direct access.
const hasLLMApiKey = (AIStrategyEngine as unknown as {
  hasLLMApiKey: (botConfig: BotConfig | null) => boolean;
}).hasLLMApiKey;

describe('AIStrategyEngine.hasLLMApiKey — JIRA-268 skill-level gate', () => {
  const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ORIGINAL_CLAUDE_CODE = process.env.ANTHROPIC_USE_CLAUDE_CODE;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_USE_CLAUDE_CODE;
  });

  afterEach(() => {
    if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
    if (ORIGINAL_CLAUDE_CODE === undefined) delete process.env.ANTHROPIC_USE_CLAUDE_CODE;
    else process.env.ANTHROPIC_USE_CLAUDE_CODE = ORIGINAL_CLAUDE_CODE;
  });

  it('AC1: returns false for Medium when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-medium';
    const cfg: BotConfig = { skillLevel: BotSkillLevel.Medium, name: 'test-medium' };
    expect(hasLLMApiKey(cfg)).toBe(false);
  });

  it('AC2: returns true for Easy when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-easy';
    const cfg: BotConfig = { skillLevel: BotSkillLevel.Easy, name: 'test-easy' };
    expect(hasLLMApiKey(cfg)).toBe(true);
  });

  it('AC3: returns true for Hard when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-hard';
    const cfg: BotConfig = { skillLevel: BotSkillLevel.Hard, name: 'test-hard' };
    expect(hasLLMApiKey(cfg)).toBe(true);
  });

  it('AC4: returns false for Medium when ANTHROPIC_API_KEY is unset', () => {
    const cfg: BotConfig = { skillLevel: BotSkillLevel.Medium, name: 'test-medium' };
    expect(hasLLMApiKey(cfg)).toBe(false);
  });

  it('AC5: returns false for null botConfig', () => {
    expect(hasLLMApiKey(null)).toBe(false);
  });

  it('regression: Easy still returns false when ANTHROPIC_API_KEY is unset', () => {
    const cfg: BotConfig = { skillLevel: BotSkillLevel.Easy, name: 'test-easy-no-key' };
    expect(hasLLMApiKey(cfg)).toBe(false);
  });

  it('regression: Hard still returns false when ANTHROPIC_API_KEY is unset', () => {
    const cfg: BotConfig = { skillLevel: BotSkillLevel.Hard, name: 'test-hard-no-key' };
    expect(hasLLMApiKey(cfg)).toBe(false);
  });
});
