/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testTimeout: 10000,
  maxWorkers: 1, // prevent DB deadlocks

  // JUnit XML reporter for CircleCI
  reporters: ['default', ['jest-junit', { outputDirectory: 'test-results' }]],

  // Automatically clear mock call history, instances, contexts and results
  // between tests. This prevents cross-test contamination of mock.calls etc.
  // NOTE: This does NOT reset mockReturnValue/mockImplementation — those must
  // be explicitly re-set in beforeEach when tests need specific mock behavior.
  clearMocks: true,

  // Shared defaults (projects can override)
  moduleNameMapper: {
    '^phaser$': '<rootDir>/node_modules/phaser/dist/phaser.js',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleDirectories: ['node_modules', 'src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover'],
  coverageThreshold: {
    global: {
      statements: 50,
      branches: 40,
      functions: 50,
      lines: 50,
    },
  },

  projects: [
    {
      displayName: 'client',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/client/__tests__/**/*.test.ts'],
      testPathIgnorePatterns: [
        '<rootDir>/src/client/__tests__/lobby/lobby.integration.test.ts',
        '<rootDir>/src/client/__tests__/lobby/lobby.e2e.database.test.ts'
      ],
      setupFilesAfterEnv: ['<rootDir>/src/client/__tests__/setupTests.js'], // use the JS setup we just fixed
      testEnvironmentOptions: { url: 'http://localhost' },

      // IMPORTANT: put ts transform INSIDE the project
      // Explicitly use ts-jest for TypeScript, prevent babel-jest fallback
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
            diagnostics: { ignoreCodes: [1343] },
            isolatedModules: false,
            useESM: false,
          },
        ],
        // Explicitly handle JS files with babel-jest (only for .js/.jsx, not .ts/.tsx)
        '^.+\\.(js|jsx)$': 'babel-jest',
      },
      transformIgnorePatterns: ['/node_modules/(?!(phaser|uuid)/)'],
      moduleNameMapper: {
        '^phaser$': '<rootDir>/node_modules/phaser/dist/phaser.js',
        '^@/(.*)$': '<rootDir>/src/$1',
      },
    },

    {
      // Unit tests: pure logic, no real database. Deterministic — this is the CI gate.
      // Real-DB tests live in the 'server-integration' project (see below) and are
      // excluded here via the *.integration.test.ts suffix and the integration/ dir.
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/server/__tests__/**/*.test.ts'],
      testPathIgnorePatterns: [
        '\\.integration\\.test\\.ts$',
        '<rootDir>/src/server/__tests__/integration/',
      ],
      setupFiles: ['<rootDir>/src/server/__tests__/setupFiles.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/server/__tests__/setup.ts'],
      maxWorkers: 1,

      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
            diagnostics: { ignoreCodes: [1343] },
            isolatedModules: false,
            useESM: false,
          },
        ],
        '^.+\\.(js|jsx)$': 'babel-jest',
      },
      transformIgnorePatterns: ['/node_modules/(?!(uuid)/)'],
      // Map the ESM-only claude-agent-sdk to a CJS-compatible stub for Jest.
      // Real usage is in production code; tests mock this at the module boundary.
      moduleNameMapper: {
        '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/src/server/__tests__/mocks/claudeAgentSdk.mock.js',
      },
    },

    {
      // Integration tests: exercise a real Postgres (eurorails_test). Kept OUT of the
      // unit gate because they share one physical DB and are inherently order/state
      // sensitive. Run serially in their own process via `npm run test:integration`.
      // A server test belongs here if it imports the real `../db` pool — name it
      // `*.integration.test.ts` (or place it in __tests__/integration/).
      displayName: 'server-integration',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/server/__tests__/**/*.integration.test.ts',
        '<rootDir>/src/server/__tests__/integration/**/*.test.ts',
      ],
      setupFiles: ['<rootDir>/src/server/__tests__/setupFiles.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/src/server/__tests__/setup.ts',
        '<rootDir>/src/server/__tests__/setup.integration.ts',
      ],
      maxWorkers: 1,

      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
            diagnostics: { ignoreCodes: [1343] },
            isolatedModules: false,
            useESM: false,
          },
        ],
        '^.+\\.(js|jsx)$': 'babel-jest',
      },
      transformIgnorePatterns: ['/node_modules/(?!(uuid)/)'],
      moduleNameMapper: {
        '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/src/server/__tests__/mocks/claudeAgentSdk.mock.js',
      },
    },

    // Skip integration tests in CI to avoid flaky database initialization issues
    // Integration tests can still be run locally
    ...(process.env.CI ? [] : [{
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/client/__tests__/lobby/lobby.integration.test.ts',
        '<rootDir>/src/client/__tests__/lobby/lobby.e2e.database.test.ts'
      ],
      setupFiles: ['<rootDir>/src/server/__tests__/setupFiles.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/server/__tests__/setup.ts'],
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
            diagnostics: { ignoreCodes: [1343] },
            isolatedModules: false,
            useESM: false,
          },
        ],
        '^.+\\.(js|jsx)$': 'babel-jest'
      },
      moduleNameMapper: {
        '^phaser$': '<rootDir>/node_modules/phaser/dist/phaser.js',
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      moduleDirectories: ['node_modules', 'src'],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    }]),

    {
      displayName: 'shared',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/shared/**/__tests__/**/*.test.ts'],

      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
            diagnostics: { ignoreCodes: [1343] },
            isolatedModules: false,
            useESM: false,
          },
        ],
        '^.+\\.(js|jsx)$': 'babel-jest',
      },
      transformIgnorePatterns: ['/node_modules/(?!(uuid)/)'],
    },
  ],
};
