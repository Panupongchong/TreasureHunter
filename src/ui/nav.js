// ============================================================
// nav.js — FocusNav, the shared focus-list controller (ux-spec §0.6).
//
// One class used by MenuScene (all sub-states) and ResultsUI. Declared
// WP6 deviation from the plan file list: shared by two owners, belongs
// in neither. Owns the `>` focus marker, focus colors, keyboard nav,
// gamepad nav with repeat (updatePad() polled by the owning scene), and
// mouse hover/click wiring.
//
// Items: [{ go, onActivate, onLeft?, onRight?, disabled? }] — `go` is a
// Phaser Text (any origin). Exactly one enabled item is focused.
// ============================================================

import { UI } from '../config.js';
import { InputManager } from '../input/InputManager.js';

const KC = Phaser.Input.Keyboard.KeyCodes;

export class FocusNav {
  /** @param {Phaser.Scene} scene @param {{onBack?: Function}} opts */
  constructor(scene, { onBack = null } = {}) {
    this.scene = scene;
    this.items = [];
    this.index = -1;
    this.enabled = true;
    this.onBack = onBack;
    this.marker = scene.add.text(0, 0, '>', {
      fontFamily: UI.font, fontSize: '14px', color: UI.colors.gold,
    }).setOrigin(1, 0.5).setVisible(false).setDepth(60);

    this._keyHandler = (e) => this._onKey(e);
    scene.input.keyboard.on('keydown', this._keyHandler);

    // gamepad edge/repeat state
    this._padPrev = { a: false, b: false };
    this._vDir = 0; this._vNextAt = 0;
    this._hDir = 0; this._hNextAt = 0;
    this._destroyed = false;
  }

  /** Replace the item list (rebuilds pointer wiring). */
  setItems(items) {
    this.items = items || [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const go = it.go;
      if (!go.input) {
        go.setInteractive({
          hitArea: new Phaser.Geom.Rectangle(
            -UI.buttonHitPad, -UI.buttonHitPad,
            go.width + UI.buttonHitPad * 2, go.height + UI.buttonHitPad * 2),
          hitAreaCallback: Phaser.Geom.Rectangle.Contains,
          useHandCursor: true,
        });
      }
      go.off('pointerover').off('pointerdown');
      go.on('pointerover', () => {
        if (this.enabled && !it.disabled) this.focus(i);
      });
      go.on('pointerdown', () => {
        if (this.enabled && !it.disabled) { this.focus(i); this.activate(); }
      });
    }
    this.focus(this._firstEnabled());
  }

  _firstEnabled() {
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].disabled) return i;
    }
    return -1;
  }

  focus(i) {
    this.index = i;
    this._refresh();
  }

  /** Re-apply colors + marker (also call after a disabled flag changes).
   *  Items whose GameObject was destroyed while still listed are dropped
   *  rather than styled: setColor on a destroyed Text throws deep inside
   *  Phaser, and this runs from _applyState — an exception here would
   *  abort the caller mid-transition (that is how the burned rejoin
   *  button used to swallow its own error message). */
  _refresh() {
    const alive = (go) => !!go && !!go.scene;
    if (this.items.some((it) => !alive(it.go))) {
      this.items = this.items.filter((it) => alive(it.go));
      if (this.index >= this.items.length) this.index = this._firstEnabled();
    }
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.disabled) it.go.setColor(UI.colors.dim);
      else it.go.setColor(i === this.index ? UI.colors.gold : (it.baseColor || UI.colors.text));
    }
    const it = this.items[this.index];
    if (!it) { this.marker.setVisible(false); return; }
    const go = it.go;
    this.marker.setVisible(this.enabled)
      .setPosition(go.x - go.displayWidth * go.originX - UI.focusMarkerGap,
        go.y + go.displayHeight * (0.5 - go.originY));
  }

  setEnabled(on) {
    this.enabled = on;
    this._refresh();
  }

  move(dir) {
    if (!this.items.length) return;
    let i = this.index;
    for (let n = 0; n < this.items.length; n++) {
      i = (i + dir + this.items.length) % this.items.length;
      if (!this.items[i].disabled) { this.focus(i); return; }
    }
  }

  activate() {
    const it = this.items[this.index];
    if (!it || it.disabled) return;
    // pressed feedback: scale 0.96 for 80 ms (ux-spec §0.4)
    const go = it.go;
    this.scene.tweens.add({
      targets: go, scale: UI.buttonPressScale, duration: UI.buttonPressMs,
      yoyo: true, onComplete: () => go.setScale(1),
    });
    it.onActivate?.();
  }

  _onKey(e) {
    InputManager.lastDevice = 'kb';
    if (!this.enabled) return;
    switch (e.keyCode) {
      case KC.UP: case KC.W: this.move(-1); break;
      case KC.DOWN: case KC.S: this.move(1); break;
      case KC.ENTER: this.activate(); break;
      case KC.ESC: this.onBack?.(); break;
      case KC.LEFT: case KC.A: this.items[this.index]?.onLeft?.(); break;
      case KC.RIGHT: case KC.D: this.items[this.index]?.onRight?.(); break;
    }
  }

  /** Poll gamepad — call from the owning scene's update(). */
  updatePad() {
    if (this._destroyed) return;
    const pad = this.scene.input.gamepad?.getPad(0);
    if (!pad) return;
    const now = this.scene.time.now;

    const sy = pad.leftStick ? pad.leftStick.y : 0;
    const sx = pad.leftStick ? pad.leftStick.x : 0;
    const vDir = (pad.down || sy > 0.5) ? 1 : (pad.up || sy < -0.5) ? -1 : 0;
    const hDir = (pad.right || sx > 0.5) ? 1 : (pad.left || sx < -0.5) ? -1 : 0;
    const a = !!pad.A;
    const b = !!pad.B;

    if (vDir || hDir || a || b) InputManager.lastDevice = 'pad';
    if (!this.enabled) { this._padPrev = { a, b }; this._vDir = vDir; this._hDir = hDir; return; }

    if (vDir !== this._vDir) {
      this._vDir = vDir;
      if (vDir) { this.move(vDir); this._vNextAt = now + UI.focusRepeatDelayMs; }
    } else if (vDir && now >= this._vNextAt) {
      this.move(vDir);
      this._vNextAt = now + UI.focusRepeatMs;
    }

    if (hDir !== this._hDir) {
      this._hDir = hDir;
      if (hDir) {
        const it = this.items[this.index];
        (hDir < 0 ? it?.onLeft : it?.onRight)?.();
        this._hNextAt = now + UI.focusRepeatDelayMs;
      }
    } else if (hDir && now >= this._hNextAt) {
      const it = this.items[this.index];
      (hDir < 0 ? it?.onLeft : it?.onRight)?.();
      this._hNextAt = now + UI.focusRepeatMs;
    }

    if (a && !this._padPrev.a) this.activate();
    if (b && !this._padPrev.b) this.onBack?.();
    this._padPrev = { a, b };
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.scene.input.keyboard?.off('keydown', this._keyHandler);
    this.marker.destroy();
  }
}
