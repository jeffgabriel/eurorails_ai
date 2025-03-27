/** @type {import('jest').Config} */
module.exports = {
  verbose: true,
  testTimeout: 10000,
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        useESM: false,
        isolatedModules: true,
        diagnostics: {
          ignoreCodes: [1343]
        },
        babelConfig: true
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
      setupFilesAfterEnv: ['<rootDir>/src/server/__tests__/setup.ts']
    },
    {
      displayName: 'shared',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/shared/**/__tests__/**/*.test.ts']
    }
  ]
}; 