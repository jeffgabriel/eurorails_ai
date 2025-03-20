import 'phaser';
import { Game } from 'phaser';

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: 1280,
    height: 720,
    parent: 'game',
    backgroundColor: '#ffffff',
    scene: {
        preload: function() {
            // Assets will be loaded here
        },
        create: function() {
            this.add.text(400, 300, 'Eurorails Game', {
                fontSize: '32px',
                color: '#000'
            });
        }
    }
};

window.addEventListener('load', () => {
    new Game(config);
}); 