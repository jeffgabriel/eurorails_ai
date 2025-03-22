import 'phaser';
import { GameScene } from './scenes/GameScene';
import { SetupScene } from './scenes/SetupScene';

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: 1200,
    height: 800,
    backgroundColor: '#ffffff',
    parent: 'game',
    dom: {
        createContainer: true
    },
    scene: [SetupScene, GameScene],  // SetupScene will run first
    physics: {
        default: 'none'
    },
    disableContextMenu: true,
    scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
    }
};

// Create game instance
const game = new Phaser.Game(config);

// No need for manual resize handler as we're using Phaser's built-in scaling 