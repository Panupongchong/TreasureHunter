// ============================================================
// GameScene — the platformer core, ported to Phaser 3 arcade physics.
// Build steps 1–2: movement, platforms, input abstraction, and the
// mass rule hooks (speed/jump multipliers) that everything later
// composes from. Single local player for now; netcode is step 3.
// ============================================================

import {
  GAME_WIDTH, GAME_HEIGHT, PHYSICS, PLAYER, PLATFORMS, SPAWNS,
  MASS, massSpeedMult, massJumpMult,
} from '../config.js';
import { InputManager } from '../input/InputManager.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  create() {
    this.inputManager = new InputManager(this);

    // ----- static level -----
    this.platforms = this.physics.add.staticGroup();
    for (const [x, y, w, h] of PLATFORMS) {
      // Arcade static bodies are positioned by center
      const rect = this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x39406a);
      this.add.rectangle(x + w / 2, y + 2, w, 3, 0x4c548a); // top highlight
      this.platforms.add(rect);
    }

    // ----- local player -----
    this.player = this.spawnPlayer(0);
    this.physics.add.collider(this.player, this.platforms);

    // Jump-feel timers
    this.lastGroundedAt = 0;
    this.jumpBufferedAt = -Infinity;

    // Debug overlay (toggle with F3) — grow this in step 3 for netcode state
    this.debugText = this.add.text(8, 8, '', {
      fontFamily: 'Courier New, monospace',
      fontSize: '11px',
      color: '#565d75',
    }).setDepth(100);
    this.showDebug = false;
    this.input.keyboard.on('keydown-F3', () => {
      this.showDebug = !this.showDebug;
      this.debugText.setVisible(this.showDebug);
    });
    this.debugText.setVisible(false);

    this.add.text(GAME_WIDTH - 8, 8, 'ESC menu · F3 debug', {
      fontFamily: 'Courier New, monospace',
      fontSize: '11px',
      color: '#565d75',
    }).setOrigin(1, 0);
    this.input.keyboard.on('keydown-ESC', () => this.scene.start('Menu'));
  }

  /** @param {number} slot 0..3 */
  spawnPlayer(slot) {
    const [sx, sy] = SPAWNS[slot % SPAWNS.length];
    const p = this.add.rectangle(sx, sy, PLAYER.width, PLAYER.height, PLAYER.colors[slot % 4]);
    this.physics.add.existing(p);

    /** @type {Phaser.Physics.Arcade.Body} */
    const body = p.body;
    body.setCollideWorldBounds(true);
    body.setMaxVelocityY(1200);

    // Gameplay state — mass drives everything (CLAUDE.md physics core)
    p.state = {
      mass: MASS.player,   // becomes 2.0 when carrying the relic (step 8)
      facing: 1,
      slot,
    };

    // Facing "eye" marker
    p.eye = this.add.rectangle(sx, sy, 5, 5, 0x12141c).setDepth(1);
    return p;
  }

  update(time, delta) {
    const dt = delta / 1000;
    const frame = this.inputManager.poll();
    const p = this.player;
    /** @type {Phaser.Physics.Arcade.Body} */
    const body = p.body;
    const s = p.state;

    const speedMult = massSpeedMult(s.mass);
    const jumpMult = massJumpMult(s.mass);
    const onGround = body.blocked.down;
    if (onGround) this.lastGroundedAt = time;

    // ----- horizontal movement (accel/friction, air control) -----
    const targetSpeed = frame.moveX * PHYSICS.baseMoveSpeed * speedMult *
      (frame.sprint ? PHYSICS.baseSprintMult : 1);
    const accel = (onGround ? PHYSICS.accel : PHYSICS.accel * PHYSICS.airAccelMult) * speedMult;

    if (frame.moveX !== 0) {
      s.facing = Math.sign(frame.moveX);
      const dv = targetSpeed - body.velocity.x;
      const step = Math.sign(dv) * Math.min(Math.abs(dv), accel * dt);
      body.setVelocityX(body.velocity.x + step);
    } else if (onGround) {
      const dv = -body.velocity.x;
      const step = Math.sign(dv) * Math.min(Math.abs(dv), PHYSICS.friction * dt);
      body.setVelocityX(body.velocity.x + step);
    }

    // ----- jump: buffer + coyote + variable height -----
    if (frame.jump) this.jumpBufferedAt = time;
    const buffered = time - this.jumpBufferedAt <= PHYSICS.jumpBufferMs;
    const coyote = time - this.lastGroundedAt <= PHYSICS.coyoteMs;
    if (buffered && (onGround || coyote) && body.velocity.y >= -1) {
      body.setVelocityY(-PHYSICS.baseJumpVelocity * jumpMult);
      this.jumpBufferedAt = -Infinity;
      this.lastGroundedAt = -Infinity;
    }
    // Early release cuts the jump (variable height)
    if (!frame.jumpHeld && body.velocity.y < 0) {
      body.setVelocityY(body.velocity.y * (1 - (1 - PHYSICS.jumpCutMult) * dt * 10));
    }

    // ----- cosmetics -----
    p.eye.setPosition(p.x + s.facing * 8, p.y - 6);

    if (this.showDebug) {
      this.debugText.setText([
        `pos ${p.x.toFixed(0)},${p.y.toFixed(0)}  vel ${body.velocity.x.toFixed(0)},${body.velocity.y.toFixed(0)}`,
        `mass ${s.mass}  speedMult ${speedMult.toFixed(2)}  jumpMult ${jumpMult.toFixed(2)}`,
        `ground ${onGround}  pad ${frame.usingGamepad}`,
        `fps ${this.game.loop.actualFps.toFixed(0)}`,
      ]);
    }
  }
}
