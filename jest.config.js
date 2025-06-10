/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testTimeout: 10000,
  maxWorkers: 1,  // Force serial execution globally to prevent database deadlocks
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        diagnostics: {
          ignoreCodes: [1343]
        },
        isolatedModules: false,
        useESM: false,
        astTransformers: {
          before: [
            {
              path: 'ts-jest/dist/transformers/hoist-jest',
              options: { enums: true }
            }
          ]
        }
      }
    ]
  },
  moduleNameMapper: {
    '^phaser$': '<rootDir>/node_modules/phaser/dist/phaser.js',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transformIgnorePatterns: [
    'node_modules/(?!(phaser)/)'
  ],
  moduleDirectories: ['node_modules', 'src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  projects: [
    {
      displayName: 'client',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/client/__tests__/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/client/__tests__/setupTests.ts']
    },
    {
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/server/__tests__/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/server/__tests__/setup.ts'],
      maxWorkers: 1  // Force serial execution for database tests to prevent deadlocks
    },
    {
      displayName: 'shared',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/shared/**/__tests__/**/*.test.ts']
    }
  ]
}; 