import 'phaser';
import { GameScene } from './scenes/GameScene';
import { SetupScene } from './scenes/SetupScene';
import { SettingsScene } from './scenes/SettingsScene';

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: 1200,
    height: 800,
    backgroundColor: '#ffffff',
    parent: 'game',
    dom: {
        createContainer: true
    },
    scene: [GameScene, SetupScene, SettingsScene],  // GameScene will run first with test players
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