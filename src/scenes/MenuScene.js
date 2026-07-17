// ============================================================
// MenuScene — placeholder main menu.
// Host/Join/Settings arrive with build step 3 (netcode) and step 11
// (lobby). For now: title + local test play.
// ============================================================

import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;

    this.add.text(cx, 170, 'VAULTBREAKERS', {
      fontFamily: 'Courier New, monospace',
      fontSize: '44px',
      color: '#ffd23f',
      letterSpacing: 8,
    }).setOrigin(0.5);

    this.add.text(cx, 215, 'steal the relic · beat the calamity', {
      fontFamily: 'Courier New, monospace',
      fontSize: '14px',
      color: '#8890a6',
    }).setOrigin(0.5);

    const play = this.add.text(cx, 320, '[ LOCAL TEST ]', {
      fontFamily: 'Courier New, monospace',
      fontSize: '22px',
      color: '#e8eaf2',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    play.on('pointerover', () => play.setColor('#ffd23f'));
    play.on('pointerout', () => play.setColor('#e8eaf2'));
    play.on('pointerdown', () => this.scene.start('Game'));

    this.add.text(cx, 480,
      'move A/D · jump SPACE (hold = higher) · sprint SHIFT · gamepad supported', {
      fontFamily: 'Courier New, monospace',
      fontSize: '12px',
      color: '#565d75',
    }).setOrigin(0.5);

    // Keyboard/gamepad shortcut to start
    this.input.keyboard.once('keydown-ENTER', () => this.scene.start('Game'));
    this.input.gamepad?.once('down', () => this.scene.start('Game'));
  }
}
