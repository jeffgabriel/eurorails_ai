/**
 * CJS-compatible stub for @anthropic-ai/claude-agent-sdk.
 *
 * The real SDK ships as pure ESM (.mjs) and uses import.meta, which cannot be
 * processed by Jest's CommonJS transform pipeline. This stub provides the
 * minimal exports that production code imports, allowing tests to:
 *   - Auto-mock the module via jest.mock('@anthropic-ai/claude-agent-sdk')
 *   - Import and override specific exports in test files
 *
 * The stub is never called directly in tests — each test that exercises
 * ClaudeAgentSdkAdapter uses jest.mock('@anthropic-ai/claude-agent-sdk') to
 * replace `query` and `AbortError` with controlled test doubles.
 */

'use strict';

class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Stub query function — never called directly in tests (always jest.mock'd).
 * Throws to make accidental real invocations obvious.
 */
function query() {
  throw new Error(
    '[claudeAgentSdk.mock.js] query() stub invoked directly. ' +
    'Did you forget jest.mock("@anthropic-ai/claude-agent-sdk")?'
  );
}

module.exports = {
  query,
  AbortError,
};
