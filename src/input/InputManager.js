// ============================================================
// InputManager — the input abstraction layer (CLAUDE.md, build step 2).
//
// Game code NEVER reads keys or gamepad buttons directly. Each frame it
// calls inputManager.poll() and receives an InputFrame. This is also the
// exact object that will be serialized and sent to the host in build
// step 3 (host-authoritative netcode), so keep it flat and small.
//
// Bindings (see CLAUDE.md):
//   Gamepad: L-stick move, A jump, X attack, R-stick aim, RT grapple,
//            Y interact, B grab/throw, LB sprint, R3 ping
//   KB/M:    AD move, Space jump, LMB attack, mouse aim, RMB grapple,
//            E interact, F grab, Shift sprint, Q ping
// ============================================================

const DEADZONE = 0.25;

/** @typedef {{
 *  moveX: number,        // -1..1
 *  jump: boolean,        // pressed this frame (edge)
 *  jumpHeld: boolean,    // held (for variable jump height)
 *  sprint: boolean,
 *  attack: boolean,      // edge
 *  grapple: boolean,     // edge
 *  grappleHeld: boolean,
 *  interact: boolean,    // held (channels)
 *  grab: boolean,        // edge
 *  ping: boolean,        // edge
 *  aimX: number,         // world-space aim target x
 *  aimY: number,         // world-space aim target y
 *  usingGamepad: boolean
 * }} InputFrame */

export class InputManager {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    const kb = scene.input.keyboard;

    this.keys = kb.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      left2: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right2: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      jump: Phaser.Input.Keyboard.KeyCodes.SPACE,
      jump2: Phaser.Input.Keyboard.KeyCodes.UP,
      jump3: Phaser.Input.Keyboard.KeyCodes.W,
      interact: Phaser.Input.Keyboard.KeyCodes.E,
      grab: Phaser.Input.Keyboard.KeyCodes.F,
      sprint: Phaser.Input.Keyboard.KeyCodes.SHIFT,
      ping: Phaser.Input.Keyboard.KeyCodes.Q,
    });

    // Edge-detection state
    this._prev = { jump: false, attack: false, grapple: false, grab: false, ping: false };

    // Gamepad aim persists between frames so a released stick keeps direction
    this._padAimDir = { x: 1, y: 0 };
  }

  /** @returns {InputFrame} */
  poll() {
    const pad = this._activePad();
    const usingGamepad = !!pad;

    // ----- movement -----
    let moveX = 0;
    if (this.keys.left.isDown || this.keys.left2.isDown) moveX -= 1;
    if (this.keys.right.isDown || this.keys.right2.isDown) moveX += 1;
    if (pad) {
      const ax = pad.axes.length > 0 ? pad.axes[0].getValue() : 0;
      if (Math.abs(ax) > DEADZONE) moveX = ax;
    }

    // ----- raw button states -----
    const pointer = this.scene.input.activePointer;
    const jumpDown =
      this.keys.jump.isDown || this.keys.jump2.isDown || this.keys.jump3.isDown ||
      (pad ? pad.A : false);
    const attackDown = pointer.leftButtonDown() || (pad ? pad.X : false);
    const grappleDown = pointer.rightButtonDown() || (pad ? pad.R2 > 0.5 : false);
    const grabDown = this.keys.grab.isDown || (pad ? pad.B : false);
    const pingDown = this.keys.ping.isDown || (pad ? this._padButton(pad, 11) : false); // R3
    const interactDown = this.keys.interact.isDown || (pad ? pad.Y : false);
    const sprintDown = this.keys.sprint.isDown || (pad ? pad.L1 : false);

    // ----- aim -----
    let aimX, aimY;
    if (pad) {
      const rx = pad.axes.length > 2 ? pad.axes[2].getValue() : 0;
      const ry = pad.axes.length > 3 ? pad.axes[3].getValue() : 0;
      if (Math.hypot(rx, ry) > DEADZONE) {
        const len = Math.hypot(rx, ry);
        this._padAimDir = { x: rx / len, y: ry / len };
      }
      // Aim is expressed as a point far along the aim direction from the
      // player; GameScene resolves it against the local player position.
      aimX = this._padAimDir.x;
      aimY = this._padAimDir.y;
    } else {
      // Mouse: world-space point. GameScene converts via camera.
      const world = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
      aimX = world.x;
      aimY = world.y;
    }

    // ----- edges -----
    const frame = {
      moveX,
      jump: jumpDown && !this._prev.jump,
      jumpHeld: jumpDown,
      sprint: sprintDown,
      attack: attackDown && !this._prev.attack,
      grapple: grappleDown && !this._prev.grapple,
      grappleHeld: grappleDown,
      interact: interactDown,
      grab: grabDown && !this._prev.grab,
      ping: pingDown && !this._prev.ping,
      aimX,
      aimY,
      usingGamepad,
    };

    this._prev.jump = jumpDown;
    this._prev.attack = attackDown;
    this._prev.grapple = grappleDown;
    this._prev.grab = grabDown;
    this._prev.ping = pingDown;

    return frame;
  }

  _activePad() {
    const pads = this.scene.input.gamepad;
    if (!pads || pads.total === 0) return null;
    return pads.getPad(0) || null;
  }

  _padButton(pad, index) {
    const b = pad.buttons[index];
    return b ? b.pressed : false;
  }
}
