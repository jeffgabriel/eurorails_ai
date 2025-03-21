import 'phaser';
import { GameScene } from './scenes/GameScene';

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    scene: GameScene,
    audio: {
        noAudio: true
    },
    render: {
        powerPreference: 'high-performance',
        antialias: true,
        pixelArt: false
    },
    physics: {
        default: 'none' // Disable physics system since we don't need it
    },
    disableContextMenu: true,
    backgroundColor: '#ffffff'
};

const game = new Phaser.Game(config);

// Handle window resizing
window.addEventListener('resize', () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
}); 