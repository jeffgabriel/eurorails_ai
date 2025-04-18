import 'phaser';
import { GameScene } from './scenes/GameScene';
import { SetupScene } from './scenes/SetupScene';
import { SettingsScene } from './scenes/SettingsScene';
import { LoadDialogScene } from './scenes/LoadDialogScene';

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#ffffff',
    dom: {
        createContainer: true
    },
    scale: {
        mode: Phaser.Scale.RESIZE,
        parent: 'game',
        width: '100%',
        height: '100%',
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    scene: [SetupScene, GameScene, SettingsScene, LoadDialogScene],
    physics: {
        default: 'none'
    },
    disableContextMenu: true
};

// Create game instance
const game = new Phaser.Game(config);

// No need for manual resize handler as we're using Phaser's built-in scaling 