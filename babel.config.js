// Babel configuration for Jest
// This file is only used for JavaScript files (not TypeScript)
// TypeScript files are handled by ts-jest, not Babel

module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    // Do NOT include @babel/preset-typescript - ts-jest handles TypeScript
  ],
};

