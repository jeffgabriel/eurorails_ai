// game/index.ts - Standalone game entry point
// This recreates the original index.ts functionality for the standalone game
import Phaser from 'phaser';
import { GameScene } from '../scenes/GameScene';
import { SetupScene } from '../scenes/SetupScene';

// Get game ID from URL parameters or path
function getGameIdFromUrl(): string | null {
  // Try to get from URL search params first
  const urlParams = new URLSearchParams(window.location.search);
  const gameIdFromParams = urlParams.get('gameId');
  if (gameIdFromParams) return gameIdFromParams;

  // Try to get from path (e.g., /game/123 -> 123)
  const pathParts = window.location.pathname.split('/');
  const gameIndex = pathParts.indexOf('game');
  if (gameIndex !== -1 && pathParts[gameIndex + 1]) {
    return pathParts[gameIndex + 1];
  }

  return null;
}

// Create Phaser game configuration
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1920,
  height: 1080,
  parent: 'game-container',
  backgroundColor: '#ffffff',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [SetupScene, GameScene],
};

// Initialize the game
const game = new Phaser.Game(config);

// Get game ID and pass it to the setup scene
const gameId = getGameIdFromUrl();
console.log('Game index.ts loaded, gameId:', gameId);
console.log('Current URL:', window.location.href);

if (gameId) {
  console.log('Starting game with ID:', gameId);
  // The SetupScene will handle loading the game with this ID
  game.scene.start('SetupScene', { gameId });
} else {
  console.log('No game ID found, starting setup scene normally');
  game.scene.start('SetupScene');
}

// Export the game instance for potential external access
export { game };
