// mapViewer/index.ts - Map viewer Phaser game entry point
import Phaser from 'phaser';
import { MapViewerScene } from './MapViewerScene';

// Get game ID from URL path (e.g., /map/123 -> 123)
function getGameIdFromUrl(): string | null {
  const pathParts = window.location.pathname.split('/');
  const mapIndex = pathParts.indexOf('map');
  if (mapIndex !== -1 && pathParts[mapIndex + 1]) {
    return pathParts[mapIndex + 1];
  }
  return null;
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1920,
  height: 1080,
  parent: 'map-viewer-container',
  backgroundColor: '#0b0e14',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [MapViewerScene],
};

const game = new Phaser.Game(config);

const gameId = getGameIdFromUrl();
if (gameId) {
  game.scene.start('MapViewerScene', { gameId });
} else {
  game.scene.start('MapViewerScene', { gameId: '' });
}

export { game };
