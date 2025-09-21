/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testTimeout: 10000,
  maxWorkers: 1, // prevent DB deadlocks

  // Shared defaults (projects can override)
  moduleNameMapper: {
    '^phaser$': '<rootDir>/node_modules/phaser/dist/phaser.js',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleDirectories: ['node_modules', 'src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  projects: [
    {
      displayName: 'client',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/client/__tests__/**/*.test.ts'],
      testPathIgnorePatterns: ['<rootDir>/src/client/__tests__/lobby/lobby.integration.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/client/__tests__/setupTests.js'], // use the JS setup we just fixed
      testEnvironmentOptions: { url: 'http://localhost' },

      // IMPORTANT: put ts transform INSIDE the project
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
      },
      transformIgnorePatterns: ['/node_modules/(?!(phaser)/)'],
      moduleNameMapper: {
        '^phaser$': '<rootDir>/node_modules/phaser/dist/phaser.js',
        '^@/(.*)$': '<rootDir>/src/$1',
      },
    },

    {
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/server/__tests__/**/*.test.ts'],
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
      },
      transformIgnorePatterns: ['/node_modules/'],
    },

    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/client/__tests__/lobby/lobby.integration.test.ts'],
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
    },

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
      },
      transformIgnorePatterns: ['/node_modules/'],
    },
  ],
};
