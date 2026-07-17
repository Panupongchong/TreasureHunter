import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS } from './config.js';
import { MenuScene } from './scenes/MenuScene.js';
import { GameScene } from './scenes/GameScene.js';

// Phaser is attached to window so scene files can use the global
// `Phaser.Input.Keyboard.KeyCodes` etc. without re-importing.
window.Phaser = Phaser;

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#0b0d14',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: PHYSICS.gravityY },
      debug: false,
    },
  },
  input: {
    gamepad: true,
  },
  scene: [MenuScene, GameScene],
});
