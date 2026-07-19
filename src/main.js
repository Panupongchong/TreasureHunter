import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS } from './config.js';
import { MenuScene } from './scenes/MenuScene.js';
import { GameScene } from './scenes/GameScene.js';
import { UIScene } from './scenes/UIScene.js';

// Phaser is attached to window so scene files can use the global
// `Phaser.Input.Keyboard.KeyCodes` etc. without re-importing.
window.Phaser = Phaser;

// Exposed for debugging and headless acceptance tests.
window.game = new Phaser.Game({
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
  // RMB is the grapple button (CLAUDE.md bindings), so the browser context
  // menu would pop on every single grapple. Suppress it game-wide.
  disableContextMenu: true,
  input: {
    gamepad: true,
  },
  scene: [MenuScene, GameScene, UIScene],
});
