// ============================================================
// Toasts — transient messages (ux-spec §9).
//
// Stack anchored bottom-center: newest at baseline y=496, each older
// toast pushed 20 px up; max 4 visible (oldest evicted). Each toast:
// 12 px text on a pill panel (padding 8x4), 3000 ms life, 300 ms fade.
//
// push(segments, opts) — segments is a string OR an array of
// {text, color?} so "<NAME>" can render in the player's slot color
// while the rest stays default. All tween targets are scene children,
// so everything dies with the UIScene (no leaked timers).
// ============================================================

import { GAME_WIDTH, UI } from '../config.js';

export class Toasts {
  /** @param {Phaser.Scene} scene the UI scene */
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.baseY = UI.toast.baseY;
  }

  /** Phase-aware anchor: the lobby's ready ring owns bottom-center, so the
   *  stack moves up there and returns to the spec baseline elsewhere. */
  setLobbyAnchor(inLobby) {
    const y = inLobby ? UI.toast.lobbyBaseY : UI.toast.baseY;
    if (y === this.baseY) return;
    this.baseY = y;
    this._restack();
  }

  /**
   * @param {string|Array<{text:string, color?:string}>} segments
   * @param {{color?: string}} [opts] default color for string form
   */
  push(segments, opts = {}) {
    if (typeof segments === 'string') {
      segments = [{ text: segments, color: opts.color }];
    }
    const c = this.scene.add.container(GAME_WIDTH / 2, this.baseY)
      .setDepth(UI.depth.toasts);

    const texts = [];
    let w = 0;
    for (const seg of segments) {
      const t = this.scene.add.text(0, 0, seg.text, {
        fontFamily: UI.font, fontSize: '12px', color: seg.color || UI.colors.text,
      }).setOrigin(0, 0.5);
      texts.push(t);
      w += t.width;
    }
    const h = 16 + 4 * 2; // 12px line + 4px padding each side
    const g = this.scene.add.graphics();
    g.fillStyle(UI.colors.panel, UI.panelAlpha);
    g.fillRoundedRect(-w / 2 - 8, -h / 2, w + 16, h, 4);
    c.add(g);
    let x = -w / 2;
    for (const t of texts) {
      t.setX(x);
      c.add(t);
      x += t.width;
    }

    this.items.push(c);
    if (this.items.length > UI.toast.max) {
      const old = this.items.shift();
      this.scene.tweens.killTweensOf(old);
      old.destroy();
    }
    this._restack();

    this.scene.tweens.add({
      targets: c,
      alpha: 0,
      delay: UI.toast.lifeMs,
      duration: UI.toast.fadeMs,
      onComplete: () => {
        const i = this.items.indexOf(c);
        if (i !== -1) this.items.splice(i, 1);
        c.destroy();
        this._restack();
      },
    });
  }

  _restack() {
    for (let i = 0; i < this.items.length; i++) {
      const fromNewest = this.items.length - 1 - i;
      this.items[i].setY(this.baseY - fromNewest * UI.toast.stepY);
    }
  }
}
