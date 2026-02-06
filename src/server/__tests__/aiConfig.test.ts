import { isAIBotsEnabled } from '../config/aiConfig';

describe('isAIBotsEnabled', () => {
  const originalEnv = process.env.ENABLE_AI_BOTS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLE_AI_BOTS;
    } else {
      process.env.ENABLE_AI_BOTS = originalEnv;
    }
  });

  it('returns false when env var is undefined', () => {
    delete process.env.ENABLE_AI_BOTS;
    expect(isAIBotsEnabled()).toBe(false);
  });

  it('returns false when env var is empty string', () => {
    process.env.ENABLE_AI_BOTS = '';
    expect(isAIBotsEnabled()).toBe(false);
  });

  it('returns false when env var is "false"', () => {
    process.env.ENABLE_AI_BOTS = 'false';
    expect(isAIBotsEnabled()).toBe(false);
  });

  it('returns false when env var is "0"', () => {
    process.env.ENABLE_AI_BOTS = '0';
    expect(isAIBotsEnabled()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    process.env.ENABLE_AI_BOTS = 'true';
    expect(isAIBotsEnabled()).toBe(true);
  });

  it('returns true when env var is "TRUE"', () => {
    process.env.ENABLE_AI_BOTS = 'TRUE';
    expect(isAIBotsEnabled()).toBe(true);
  });

  it('returns true when env var is "1"', () => {
    process.env.ENABLE_AI_BOTS = '1';
    expect(isAIBotsEnabled()).toBe(true);
  });

  it('returns false for arbitrary string', () => {
    process.env.ENABLE_AI_BOTS = 'yes';
    expect(isAIBotsEnabled()).toBe(false);
  });
});
