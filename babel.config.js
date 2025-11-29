// Babel configuration for Jest
// This file prevents Jest from using Babel to parse TypeScript files
// TypeScript files should be handled by ts-jest, not Babel

module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    // Do NOT include @babel/preset-typescript - ts-jest handles TypeScript
  ],
  // Explicitly ignore TypeScript files - ts-jest handles them
  // This prevents Jest from trying to use Babel for .ts/.tsx files
  ignore: ['**/*.ts', '**/*.tsx'],
};

