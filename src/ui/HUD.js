// ============================================================
// HUD.js — in-game HUD (ux-spec §7) in two halves:
//
//   glyph(verb)  — THE single KB↔pad prompt-token mapping (§0.5)
//   class HUD    — screen-fixed widgets, owned by UIScene: clock, noise
//                  gauge, relic indicator, stun prompt, weapon, banner,
//                  host-lag notice
//   class WorldHUD — world-space UI, owned by GameScene (depth 900):
//                  interact prompts, channel-bar labels, ping markers +
//                  edge indicators, noise ripples, spawn '!', grapple
//                  crosshair/aim, carrier diamond, rejoin flash
//
// Data-source law (plan risk 8): every fact rendered here comes from
// snapshot-decoded `.state`, applyEvent-delivered events, the Session
// mirror, map data, or local input device state. No systems/ imports.
// ============================================================

import {
  GAME_WIDTH, GAME_HEIGHT, UI, CLOCK, GRAPPLE, PLAYER,
} from '../config.js';
import { InputManager } from '../input/InputManager.js';
import { PHASE } from '../net/Session.js';

// ---------------- shared helpers ----------------

const GLYPH_KB = {
  interact: '[E]', grab: '[F]', attack: '[LMB]', grapple: '[RMB]',
  jump: '[SPACE]', sprint: '[SHIFT]', ping: '[Q]', confirm: '[ENTER]', back: '[ESC]',
};
const GLYPH_PAD = {
  interact: '(Y)', grab: '(B)', attack: '(X)', grapple: '(RT)',
  jump: '(A)', sprint: '(LB)', ping: '(R3)', confirm: '(A)', back: '(B)',
};

/** The one KB↔gamepad prompt-token mapping (ux-spec §0.5). */
export function glyph(verb) {
  return (InputManager.lastDevice === 'pad' ? GLYPH_PAD : GLYPH_KB)[verb] || '[?]';
}

/** `MM:SS` (clock, team stats). */
export function fmtMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/** `M:SS` (results table / ±delta amounts). */
export function fmtMsShort(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** '#rrggbb' for a slot's player color. */
export function slotColorStr(slot) {
  return '#' + PLAYER.colors[slot % 4].toString(16).padStart(6, '0');
}

// ---------------- strings (ux-spec §11) ----------------

const STR = {
  noiseLabel: 'NOISE',
  stunned: 'STUNNED!',
  mash: 'MASH ANY BUTTON TO RECOVER',
  weaponName: { hammer: 'HAMMER', dagger: 'DAGGER' },
  weaponHint: { hammer: 'loud · smashes doors', dagger: 'quiet · quick' },
  bannerGo: 'STEAL THE RELIC — GO',
  bannerEsc1: 'THE DUNGEON STIRS',
  bannerEsc2: 'THE FLOORS ARE FALLING',
  relicInVault: 'RELIC IN VAULT',
  relicLoose: 'RELIC LOOSE',
  relicHands: "RELIC IN HANDS — DON'T GET HIT",
  relicBagged: 'RELIC BAGGED — SECURE',
  relicTeammate: (n) => `${n} HAS THE RELIC`,
  relicAir: 'RELIC IN THE AIR',
  relicTombstone: 'RELIC AT TOMBSTONE',
  waitingHost: 'WAITING FOR HOST…',
  hammerHint: 'hammer smashes doors — costs time and noise',
  // prompts (§7.7)
  pRevive: (g) => `${g} REVIVE`,
  pGrab: (g) => `${g} GRAB`,
  pPickLock: (g) => `${g} PICK LOCK (hold)`,
  pCrank: (g) => `${g} CRANK — NEEDS 2`,
  pRitual: (g) => `${g} RITUAL — NEEDS ALL 4 (+1:00)`,
  pGrabRelic: (g) => `${g} GRAB RELIC`,
  pBagRelic: (g) => `${g} BAG RELIC (hold)`,
  pUnbag: (g) => `${g} UNBAG (hold)`,
  pThrow: (g) => `${g} THROW`,
  pReclaim: (g) => `${g} RECLAIM BAG (hold)`,
  pTakeWeapon: (g, w) => `${g} TAKE ${w}`,
  pBoard: (g) => `${g} STAGE BOARD`,
  // channel labels (§7.6)
  chLabel: {
    revive: 'REVIVING', bag: 'BAGGING', unbag: 'UNBAGGING',
    pickDoor: 'PICKING', crank: 'CRANKING', ritual: 'RITUAL',
    reclaim: 'RECLAIMING', rack: 'TAKING', board: 'CHANGING STAGE',
  },
};

// ============================================================
// HUD — screen-fixed (UIScene)
// ============================================================

export class HUD {
  /** @param {Phaser.Scene} uiScene */
  constructor(uiScene) {
    this.scene = uiScene;
    this.session = uiScene.session;
    this.game = uiScene.scene.get('Game');
    const C = UI.colors;

    // ----- clock (§7.1) -----
    this.clockText = uiScene.add.text(GAME_WIDTH / 2, 30, '', {
      fontFamily: UI.font, fontSize: '28px', color: C.text,
    }).setOrigin(0.5).setDepth(UI.depth.hud);
    this._clockSec = -1;
    this._clockFlashUntil = 0;
    this._clockFlashColor = null;

    // ----- noise gauge (§7.2) -----
    const NG = UI.noiseGauge;
    this.noiseGfx = uiScene.add.graphics().setDepth(UI.depth.hud);
    this.noiseLabel = uiScene.add.text(NG.x, NG.y + NG.h + 4, STR.noiseLabel, {
      fontFamily: UI.font, fontSize: '10px', color: C.muted,
    }).setDepth(UI.depth.hud);
    this.noiseSpike = uiScene.add.rectangle(0, NG.y + NG.h / 2, 3, NG.h + 4, 0xffffff, 0.8)
      .setDepth(UI.depth.hud + 1).setVisible(false);
    this._noiseShown = -1;
    this._noiseDisplay = 0;   // animated-down value after a spawn halve
    this._noiseFlashUntil = 0;

    // ----- relic indicator (§7.3) -----
    this.relicGfx = uiScene.add.graphics().setDepth(UI.depth.hud);
    this.relicText = uiScene.add.text(GAME_WIDTH - 16 - 26, 25, '', {
      fontFamily: UI.font, fontSize: '12px', color: C.muted,
    }).setOrigin(1, 0.5).setDepth(UI.depth.hud);
    this._relicSeen = false;
    this._relicKey = '';

    // ----- stun prompt + mash bar (§7.4) -----
    this.stunTitle = uiScene.add.text(480, 400, STR.stunned, {
      fontFamily: UI.font, fontSize: '22px', color: C.danger,
    }).setOrigin(0.5).setDepth(UI.depth.hud).setVisible(false);
    this.stunSub = uiScene.add.text(480, 418, STR.mash, {
      fontFamily: UI.font, fontSize: '14px', color: C.text,
    }).setOrigin(0.5, 0).setDepth(UI.depth.hud).setVisible(false);
    this.stunBarGfx = uiScene.add.graphics().setDepth(UI.depth.hud).setVisible(false);
    this._stunMax = 0;

    // ----- weapon indicator (§7.5) -----
    this.wpnGfx = uiScene.add.graphics().setDepth(UI.depth.hud);
    this.wpnName = uiScene.add.text(44, 508, '', {
      fontFamily: UI.font, fontSize: '14px', color: C.text,
    }).setOrigin(0, 0.5).setDepth(UI.depth.hud);
    this.wpnHint = uiScene.add.text(44, 520, '', {
      fontFamily: UI.font, fontSize: '10px', color: C.dim,
    }).setOrigin(0, 0.5).setDepth(UI.depth.hud);
    this._wpnShown = '';

    // ----- phase banner (§7.9) -----
    this.bannerBand = uiScene.add.rectangle(GAME_WIDTH / 2, UI.banner.y, GAME_WIDTH, 44,
      0x000000, UI.banner.bandAlpha).setDepth(UI.depth.banner).setVisible(false);
    this.bannerText = uiScene.add.text(GAME_WIDTH / 2, UI.banner.y, '', {
      fontFamily: UI.font, fontSize: '26px', color: C.gold,
    }).setOrigin(0.5).setDepth(UI.depth.banner).setVisible(false);

    this._lagToastAt = 0;
    this.phase = null;
  }

  setPhase(phase) {
    this.phase = phase;
    const playing = phase === PHASE.PLAYING;
    this.clockText.setVisible(playing);
    this.noiseGfx.setVisible(playing);
    this.noiseLabel.setVisible(playing);
    if (!playing) this.noiseSpike.setVisible(false);
    this.relicGfx.setVisible(playing);
    this.relicText.setVisible(playing);
    // weapon indicator shows in lobby AND playing (rack feedback, §6.5)
    const inWorld = playing || phase === PHASE.LOBBY;
    this.wpnGfx.setVisible(inWorld);
    this.wpnName.setVisible(inWorld);
    this.wpnHint.setVisible(inWorld);
    if (!inWorld) {
      this.stunTitle.setVisible(false);
      this.stunSub.setVisible(false);
      this.stunBarGfx.setVisible(false);
    }
  }

  /** Entering `playing` — the go banner (§7.9). */
  onPlayingEnter() {
    this.showBanner(STR.bannerGo, UI.colors.gold, 26);
  }

  showEscalation(level) {
    if (level === 1) this.showBanner(STR.bannerEsc1, UI.colors.warn, 22);
    else this.showBanner(STR.bannerEsc2, UI.colors.danger, 22);
  }

  showBanner(text, color, sizePx) {
    const B = UI.banner;
    this.bannerText.setText(text).setColor(color).setFontSize(sizePx + 'px');
    this.bannerBand.setVisible(true).setAlpha(0);
    this.bannerText.setVisible(true).setAlpha(0);
    this.scene.tweens.killTweensOf([this.bannerBand, this.bannerText]);
    this.scene.tweens.add({
      targets: [this.bannerBand, this.bannerText],
      alpha: 1, duration: B.inMs,
      onComplete: () => this.scene.tweens.add({
        targets: [this.bannerBand, this.bannerText],
        alpha: 0, delay: B.holdMs, duration: B.outMs,
        onComplete: () => { this.bannerBand.setVisible(false); this.bannerText.setVisible(false); },
      }),
    });
  }

  /** TIME_COST (negative) / TIME_GAIN (positive) → delta float + clock flash. */
  onTimeDelta(amountMs) {
    const gain = amountMs > 0;
    const color = gain ? UI.colors.ok : UI.colors.danger;
    const label = (gain ? '+' : '-') + fmtMsShort(Math.abs(amountMs));
    const t = this.scene.add.text(GAME_WIDTH / 2, 54, label, {
      fontFamily: UI.font, fontSize: '18px', color,
    }).setOrigin(0.5).setDepth(UI.depth.hud);
    this.scene.tweens.add({
      targets: t, y: 54 + 16, alpha: 0, duration: UI.clock.deltaFloatMs,
      onComplete: () => t.destroy(),
    });
    this._clockFlashUntil = this.scene.time.now + UI.clock.flashMs;
    this._clockFlashColor = color;
  }

  /** NOISE_BURST → gauge spike tick (§7.2). */
  onNoiseSpike() {
    if (this.phase !== PHASE.PLAYING) return;
    const NG = UI.noiseGauge;
    const row = this.game.getWorldRow?.();
    const frac = Math.min(1, (row?.noise ?? 0) / 100);
    this.noiseSpike.setX(NG.x + 2 + (NG.w - 4) * frac).setVisible(true).setAlpha(0.8);
    this.scene.tweens.killTweensOf(this.noiseSpike);
    this.scene.tweens.add({
      targets: this.noiseSpike, alpha: 0, duration: NG.spikeMs,
      onComplete: () => this.noiseSpike.setVisible(false),
    });
  }

  /** Monster spawn during playing → white flash + animate down to halved. */
  onMonsterSpawn() {
    this._noiseFlashUntil = this.scene.time.now + 150;
    // _noiseDisplay currently holds the pre-spawn value; update() tweens
    // it down toward the (halved) authoritative value.
  }

  update() {
    const gs = this.game;
    if (!gs || !gs.getWorldRow) return;
    const row = gs.getWorldRow();
    const now = this.scene.time.now;

    if (this.phase === PHASE.PLAYING) {
      this._updateClock(row, now);
      this._updateNoise(row, now);
      this._updateRelic(gs);
    }
    if (this.phase === PHASE.PLAYING || this.phase === PHASE.LOBBY) {
      this._updateStun(gs);
      this._updateWeapon(gs);
      this._updateHostLag(gs, now);
    }
  }

  _updateClock(row, now) {
    const ms = row.clock;
    const C = UI.colors;
    let color = C.text, size = 28;
    const urgency2 = ms < CLOCK.escalation2Ms;
    const urgency1 = ms < CLOCK.escalation1Ms;
    if (urgency2) { color = C.danger; size = 32; } else if (urgency1) { color = C.warn; size = 30; }
    if (now < this._clockFlashUntil) color = this._clockFlashColor;

    const sec = Math.ceil(ms / 1000);
    if (sec !== this._clockSec) {
      this._clockSec = sec;
      this.clockText.setText(fmtMs(ms));
      if (urgency1 || urgency2) {
        const pop = sec <= UI.clock.finalPopS ? 1.25 : 1.08;
        this.clockText.setScale(pop);
        this.scene.tweens.killTweensOf(this.clockText);
        this.scene.tweens.add({ targets: this.clockText, scale: 1, duration: sec <= UI.clock.finalPopS ? 300 : 200 });
      }
    }
    this.clockText.setColor(color).setFontSize(size + 'px');
    this.clockText.setAlpha(urgency2 ? (Math.floor(now / 250) % 2 ? 0.55 : 1) : 1);
  }

  _updateNoise(row, now) {
    const target = row.noise;
    // spawn-halve animation: drift the shown value down; jumps up instantly
    if (target >= this._noiseDisplay) this._noiseDisplay = target;
    else this._noiseDisplay = Math.max(target, this._noiseDisplay - 100 * (16 / UI.noiseGauge.halveMs));
    const shown = Math.round(this._noiseDisplay);
    const flashing = now < this._noiseFlashUntil;
    const key = shown + (flashing ? 'f' : '') + (shown >= UI.noiseGauge.warnAt ? 'w' + (Math.floor(now / 250) % 2) : '');
    if (key === this._noiseShown) return;
    this._noiseShown = key;

    const NG = UI.noiseGauge;
    const C = UI.colors;
    const g = this.noiseGfx;
    g.clear();
    g.fillStyle(C.panel, 1);
    g.fillRect(NG.x, NG.y, NG.w, NG.h);
    const warn = shown >= NG.warnAt;
    g.lineStyle(2, warn ? C.warnInt : C.panelStroke, 1);
    g.strokeRect(NG.x, NG.y, NG.w, NG.h);
    const fillW = (NG.w - 4) * Math.min(1, shown / 100);
    const blink = warn && Math.floor(now / 250) % 2 === 1;
    g.fillStyle(flashing ? 0xffffff : C.noiseInt, blink ? 0.7 : 1);
    if (fillW > 0) g.fillRect(NG.x + 2, NG.y + 2, fillW, NG.h - 4);
  }

  _updateRelic(gs) {
    const relic = gs.relic;
    if (!relic) { this.relicGfx.clear(); this.relicText.setText(''); return; }
    const st = relic.state;
    const C = UI.colors;
    const local = this.session.localSlot;

    // first-seen tracking (presentation-only, reset each run with the scene)
    if (!this._relicSeen && gs.cameras?.main?.worldView.contains(relic.x, relic.y)) {
      this._relicSeen = true;
    }

    let text, color, fill, outline, boxed = false, pulse = false;
    if (st.rs === 'held' || st.rs === 'bagged') {
      const atStone = st.rs === 'bagged' && st.holderSlot != null &&
        this.session.players[st.holderSlot]?.connected === false;
      if (atStone) {
        text = STR.relicTombstone; color = C.warn; outline = C.warnInt; fill = null;
      } else if (st.holderSlot === local) {
        if (st.rs === 'held') { text = STR.relicHands; color = C.gold; fill = C.goldInt; pulse = true; }
        else { text = STR.relicBagged; color = C.ok; fill = C.goldInt; boxed = true; }
      } else {
        const name = this.session.players[st.holderSlot]?.name ?? 'P' + (st.holderSlot + 1);
        text = STR.relicTeammate(name);
        color = slotColorStr(st.holderSlot);
        fill = PLAYER.colors[st.holderSlot % 4];
      }
    } else if (st.rs === 'flying') {
      text = STR.relicAir; color = C.warn; fill = C.goldInt;
    } else {
      if (this._relicSeen) { text = STR.relicLoose; color = C.muted; outline = C.dimInt; fill = null; }
      else { text = STR.relicInVault; color = C.dim; outline = C.dimInt; fill = null; }
    }

    const pulseA = pulse ? 0.7 + 0.3 * Math.abs(Math.sin(this.scene.time.now / 318)) : 1;
    const key = text + '|' + (fill ?? 'o') + '|' + boxed + '|' + pulseA.toFixed(2);
    if (key === this._relicKey) return;
    this._relicKey = key;

    this.relicText.setText(text).setColor(color);
    const g = this.relicGfx;
    g.clear();
    const cx = GAME_WIDTH - 16 - 9, cy = 25; // 18x18 diamond anchored right
    if (boxed) {
      g.lineStyle(1, C.goldInt, 1);
      g.strokeRect(cx - 11, cy - 11, 22, 22);
    }
    const pts = [{ x: cx, y: cy - 9 }, { x: cx + 9, y: cy }, { x: cx, y: cy + 9 }, { x: cx - 9, y: cy }];
    if (fill != null) {
      g.fillStyle(fill, pulseA);
      g.fillPoints(pts, true);
    } else {
      g.lineStyle(2, outline ?? C.dimInt, 1);
      g.strokePoints(pts, true, true);
    }
  }

  _updateStun(gs) {
    const local = gs.players?.get(this.session.localSlot);
    const stunned = !!local?.state.stunned;
    this.stunTitle.setVisible(stunned);
    this.stunSub.setVisible(stunned);
    this.stunBarGfx.setVisible(stunned);
    if (!stunned) { this._stunMax = 0; return; }
    const msLeft = local.state.stunMsLeft ?? 0;
    this._stunMax = Math.max(this._stunMax, msLeft);
    const frac = this._stunMax > 0 ? Math.min(1, msLeft / this._stunMax) : 0;
    const SB = UI.stunBar;
    const g = this.stunBarGfx;
    g.clear();
    g.fillStyle(UI.colors.panel, 1);
    g.fillRect(480 - SB.w / 2, SB.y, SB.w, SB.h);
    g.lineStyle(1, UI.colors.panelStroke, 1);
    g.strokeRect(480 - SB.w / 2, SB.y, SB.w, SB.h);
    g.fillStyle(UI.colors.warnInt, 1);
    if (frac > 0) g.fillRect(480 - SB.w / 2 + 1, SB.y + 1, (SB.w - 2) * frac, SB.h - 2);
  }

  _updateWeapon(gs) {
    const local = gs.players?.get(this.session.localSlot);
    const weapon = local?.state.weapon === 'dagger' ? 'dagger' : 'hammer';
    if (weapon === this._wpnShown) return;
    this._wpnShown = weapon;
    this.wpnName.setText(STR.weaponName[weapon]);
    this.wpnHint.setText(STR.weaponHint[weapon]);
    const g = this.wpnGfx;
    g.clear();
    g.fillStyle(UI.colors.textInt, 1);
    if (weapon === 'hammer') {
      g.fillRect(16, 500, 20, 7);   // head
      g.fillRect(24, 507, 4, 12);   // handle
    } else {
      g.fillTriangle(26, 500, 21, 518, 31, 518); // thin blade
    }
  }

  _updateHostLag(gs, now) {
    if (gs.mode !== 'client' || !gs.net) return;
    // No snapshot EVER arrived is exactly the case this notice exists for
    // (ctl up, st dead), so fall back to when the HUD attached rather than
    // exempting it.
    this._attachedAt ??= performance.now();
    const last = gs.net.lastSnapAt || this._attachedAt;
    const perfNow = performance.now();
    if (perfNow - last > UI.hostLagAfterMs && now - this._lagToastAt > UI.hostLagRepeatMs) {
      this._lagToastAt = now;
      this.scene.toasts.push(STR.waitingHost, { color: UI.colors.warn });
    }
  }
}

// ============================================================
// WorldHUD — world-space (GameScene, depth 900)
// ============================================================

export class WorldHUD {
  /** @param {Phaser.Scene} gameScene */
  constructor(gameScene) {
    this.scene = gameScene;
    this.session = gameScene.session;
    const D = UI.depth.world;

    // prompts (max 2 lines, §7.7)
    this.prompt1 = gameScene.add.text(0, 0, '', {
      fontFamily: UI.font, fontSize: '12px', color: UI.colors.text,
    }).setOrigin(0.5).setDepth(D).setVisible(false);
    this.prompt2 = gameScene.add.text(0, 0, '', {
      fontFamily: UI.font, fontSize: '12px', color: UI.colors.text,
    }).setOrigin(0.5).setDepth(D).setVisible(false);

    // per-frame dynamic drawing (crosshair, aim line, carrier diamond, brackets)
    this.dynGfx = gameScene.add.graphics().setDepth(D);

    // channel labels: slot -> Text
    this.chLabels = new Map();
    this._chPrev = new Map();     // slot -> {type, progress}
    this._staggerAt = new Map();  // slot -> time of last STAGGERED

    // ping markers
    this.pings = [];

    this._hammerHintShown = false;
    this._destroyed = false;
  }

  // ---------------- event entry points (called by events.js / GameScene) ----------------

  addPing(slot, x, y) {
    const color = PLAYER.colors[slot % 4];
    const g = this.scene.add.graphics().setDepth(UI.depth.world);
    g.fillStyle(color, 1);
    g.fillTriangle(-6, -16, 6, -16, 0, -5); // 12px downward triangle
    g.fillCircle(0, 0, 2);                  // 4px dot at the exact point
    g.setPosition(x, y).setScale(1.6);
    this.scene.tweens.add({ targets: g, scale: 1, duration: UI.ping.popMs });
    // 1 Hz ±3px bob
    this.scene.tweens.add({ targets: g, y: y - 3, duration: 500, yoyo: true, repeat: -1 });
    // edge indicator (screen-fixed)
    const edge = this.scene.add.graphics().setScrollFactor(0).setDepth(UI.depth.world)
      .setVisible(false);
    edge.fillStyle(color, 1);
    edge.fillTriangle(5, 0, -5, -5, -5, 5); // points along +x; rotated in update
    const ping = { g, edge, x, y, bornAt: this.scene.time.now };
    this.pings.push(ping);
    this.scene.tweens.add({
      targets: [g, edge], alpha: 0,
      delay: UI.ping.lifeMs - UI.ping.fadeMs, duration: UI.ping.fadeMs,
      onComplete: () => {
        const i = this.pings.indexOf(ping);
        if (i !== -1) this.pings.splice(i, 1);
        this.scene.tweens.killTweensOf(g);
        g.destroy(); edge.destroy();
      },
    });
  }

  /** NOISE_BURST → world ripple (+ shake when loud) — ux-spec §10. */
  onNoiseBurst(ev) {
    this._ripple(ev.x, ev.y, ev.amount);
    if (ev.amount >= UI.ripple.loudAmount) {
      this.scene.time.delayedCall(100, () => {
        if (!this._destroyed) this._ripple(ev.x, ev.y, ev.amount);
      });
      this.scene.cameras.main.shake(UI.ripple.shakeMs, UI.ripple.shakePx / GAME_WIDTH);
    }
  }

  _ripple(x, y, amount) {
    const g = this.scene.add.graphics().setDepth(UI.depth.world);
    const state = { r: 6, a: 0.8 };
    this.scene.tweens.add({
      targets: state, r: 18 + amount * 1.2, a: 0, duration: UI.ripple.ms,
      onUpdate: () => {
        g.clear();
        g.lineStyle(2, UI.colors.noiseInt, state.a);
        g.strokeCircle(x, y, state.r);
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Runtime monster SPAWN → one-shot '!' marker (§7.2). */
  onMonsterSpawn(ev) {
    if (this.session.phase !== PHASE.PLAYING) return;
    if (this.scene.mode === 'client' && !this.scene.net?._replayDone) return; // no replay bursts
    const t = this.scene.add.text(ev.x, ev.y - 30, '!', {
      fontFamily: UI.font, fontSize: '18px', color: UI.colors.danger,
    }).setOrigin(0.5).setDepth(UI.depth.world);
    this.scene.time.delayedCall(1500, () => t.destroy());
  }

  /** STAGGERED — feeds the channel-interrupt heuristic (§7.6). */
  onStagger(ev) {
    this._staggerAt.set(ev.slot, this.scene.time.now);
  }

  /** REJOINED at a standing tombstone → alpha-blink the re-added view. */
  rejoinFlash(x, y, slot) {
    const view = this.scene.players.get(slot);
    if (!view) return;
    this.scene.tweens.add({
      targets: view, alpha: { from: 0.15, to: 1 }, duration: 133, repeat: 2,
      onComplete: () => view.setAlpha(1),
    });
  }

  // ---------------- per-frame update ----------------

  update() {
    if (this._destroyed) return;
    this.dynGfx.clear();
    this._updatePrompts();
    this._updateChannelLabels();
    this._updatePingEdges();
    this._updateCarrierDiamond();
    this._updateAim();
    this._updateCursor();
  }

  _local() {
    return this.scene.players.get(this.session.localSlot) || null;
  }

  // ----- interact prompts (§7.7): nearest pair only -----
  _updatePrompts() {
    const local = this._local();
    if (!local || local.state.stunned || local.state.carriedBy !== null) {
      this.prompt1.setVisible(false);
      this.prompt2.setVisible(false);
      return;
    }
    const R = UI.promptRange;
    const s = local.state;
    const gi = glyph('interact'), gg = glyph('grab');
    let best = null; // {dist, x, y, lines[]}
    const consider = (x, y, topY, lines, dist) => {
      if (dist > R) return;
      if (!best || dist < best.dist) best = { dist, x, y: topY, lines };
    };
    const distTo = (t) => Math.max(Math.abs(t.x - local.x), Math.abs(t.y - local.y));

    // self-anchored prompts (dist 0 — they win; they describe held state).
    // Client disambiguation: the CARRYING_HANDS bit covers both relic-in-
    // hands and carrying a player — the relic view's rs/holderSlot tells
    // which (mirrored facts only, plan risk 8).
    const relicView = this.scene.relic;
    const holdsRelicHands = s.carrying
      ? (s.carrying.kind === 'relic' && s.carrying.where === 'hands')
      : (s.carryingHands && relicView?.state.rs === 'held' &&
         relicView.state.holderSlot === this.session.localSlot);
    const holdsRelicBag = s.carrying
      ? (s.carrying.kind === 'relic' && s.carrying.where === 'bag')
      : !!s.carryingBag;
    const carriesPlayer = s.carrying
      ? s.carrying.kind === 'player'
      : (s.carryingHands && !holdsRelicHands);
    if (holdsRelicHands) {
      consider(local.x, local.y, local.y - 44, [STR.pBagRelic(gi), STR.pThrow(gg)], 0);
    } else if (holdsRelicBag) {
      consider(local.x, local.y, local.y - 44, [STR.pUnbag(gi)], 0);
    } else if (carriesPlayer) {
      consider(local.x, local.y, local.y - 44, [STR.pThrow(gg)], 0);
    }

    if (!best) {
      // stunned teammate
      for (const [slot, p] of this.scene.players) {
        if (slot === this.session.localSlot || !p.state.stunned) continue;
        consider(p.x, p.y, p.y - 46, [STR.pRevive(gi), STR.pGrab(gg)], distTo(p));
      }
      // loose relic
      if (relicView && relicView.state.rs === 'loose' &&
          !s.carrying && !s.carryingHands && !s.carryingBag) {
        consider(relicView.x, relicView.y, relicView.y - 31,
          [STR.pGrabRelic(gg), STR.pBagRelic(gi)], distTo(relicView));
      }
      // doors (intact)
      for (const [, d] of this.scene.doors) {
        if (d.state.state !== 'intact') continue;
        const dist = distTo(d);
        const line = d.state.type === 'crankGate' ? STR.pCrank(gi) : STR.pPickLock(gi);
        consider(d.x, d.y, d.y - d.height / 2 - 20, [line], dist);
        // once-per-run hammer hint (dim toast)
        if (dist <= R && !this._hammerHintShown &&
            (s.weapon ?? 'hammer') === 'hammer' && d.state.type !== 'crankGate') {
          this._hammerHintShown = true;
          this.scene.game.events.emit('ui:toast:dim', STR.hammerHint);
        }
      }
      // ritual altar
      for (const [, pk] of this.scene.pickups) {
        if (pk.state.type === 'ritual' && !pk.state.used) {
          consider(pk.x, pk.y, pk.y - 34, [STR.pRitual(gi)], distTo(pk));
        }
      }
      // tombstone with bag
      for (const [, ts] of this.scene.tombstones) {
        if (ts.state.baggedRelic) {
          consider(ts.state.x, ts.state.y, ts.state.y - 56, [STR.pReclaim(gi)], distTo(ts.state));
        }
      }
      // weapon rack — single toggle point (WP4 semantics): offer the OTHER weapon
      const rack = this.scene.map.weaponRack;
      if (rack) {
        const other = (s.weapon ?? 'hammer') === 'hammer' ? 'DAGGER' : 'HAMMER';
        consider(rack.x, rack.y, rack.y - 34, [STR.pTakeWeapon(gi, other)], distTo(rack));
      }
      // stage board (lobby). Skipped once the proximity popup is open —
      // the popup panel covers this row and says everything it did, so
      // showing both renders as text ghosting through the panel.
      const board = this.scene.map.board;
      if (board && distTo(board) > UI.boardPopupCloseRange) {
        consider(board.x, board.y, board.y - 34, [STR.pBoard(gi)], distTo(board));
      }
    }

    if (!best) {
      this.prompt1.setVisible(false);
      this.prompt2.setVisible(false);
      return;
    }
    this.prompt1.setVisible(true).setPosition(best.x, best.y);
    if (this.prompt1.text !== best.lines[0]) this.prompt1.setText(best.lines[0]);
    if (best.lines[1]) {
      this.prompt2.setVisible(true).setPosition(best.x, best.y + 14);
      if (this.prompt2.text !== best.lines[1]) this.prompt2.setText(best.lines[1]);
    } else {
      this.prompt2.setVisible(false);
    }
  }

  // ----- channel-bar labels + interrupt flash (§7.6) -----
  _updateChannelLabels() {
    const now = this.scene.time.now;
    const seen = new Set();
    // count channelers per type (crank/ritual shared-count labels)
    const typeCount = new Map();
    for (const [, p] of this.scene.players) {
      const t = this._chTypeOf(p);
      if (t) typeCount.set(t, (typeCount.get(t) || 0) + 1);
    }
    const m = this.session.connectedPlayers().length;

    for (const [slot, p] of this.scene.players) {
      const type = this._chTypeOf(p);
      const prev = this._chPrev.get(slot);
      // interrupt heuristic: progress was live and the channel vanished
      // while stunned / within 250 ms of a STAGGERED for that slot
      if (prev && prev.progress > 5 && !type) {
        const staggered = now - (this._staggerAt.get(slot) ?? -1e9) < 250;
        if (p.state.stunned || staggered) this._interruptFlash(p.x, p.y - UI.channelBar.aboveHead);
      }
      this._chPrev.set(slot, { type, progress: p.state.channelProgress || 0 });

      if (!type) continue;
      seen.add(slot);
      let label = this.chLabels.get(slot);
      if (!label) {
        label = this.scene.add.text(0, 0, '', {
          fontFamily: UI.font, fontSize: '10px', color: UI.colors.text,
        }).setOrigin(0.5).setDepth(UI.depth.world);
        this.chLabels.set(slot, label);
      }
      let text = STR.chLabel[type] ?? type.toUpperCase();
      if (type === 'crank') text = `CRANKING ${typeCount.get('crank') || 1}/2`;
      if (type === 'ritual') text = `RITUAL ${typeCount.get('ritual') || 1}/${m}`;
      if (label.text !== text) label.setText(text);
      label.setPosition(p.x, p.y - UI.channelBar.aboveHead - 9).setVisible(true);
    }
    for (const [slot, label] of this.chLabels) {
      if (!seen.has(slot)) { label.destroy(); this.chLabels.delete(slot); }
    }
  }

  _chTypeOf(p) {
    if ((p.state.channelProgress || 0) <= 0) return null;
    return p.state.channel?.type ?? // host/solo truth
      (p.state.channelType && p.state.channelType !== 'none' ? p.state.channelType : null);
  }

  _interruptFlash(x, y) {
    const bar = this.scene.add.rectangle(x, y, UI.channelBar.w, UI.channelBar.h,
      UI.colors.warnInt).setDepth(UI.depth.world);
    this.scene.tweens.add({
      targets: bar, x: x + 2, duration: 33, yoyo: true, repeat: 2,
    });
    this.scene.tweens.add({
      targets: bar, alpha: 0, duration: 200, onComplete: () => bar.destroy(),
    });
  }

  // ----- ping edge indicators (§7.8) -----
  _updatePingEdges() {
    if (!this.pings.length) return;
    const cam = this.scene.cameras.main;
    const view = cam.worldView;
    const inset = UI.ping.edgeInset;
    for (const ping of this.pings) {
      if (view.contains(ping.x, ping.y)) {
        ping.edge.setVisible(false);
        continue;
      }
      const sx = Phaser.Math.Clamp(ping.x - view.x, inset, GAME_WIDTH - inset);
      const sy = Phaser.Math.Clamp(ping.y - view.y, inset, GAME_HEIGHT - inset);
      ping.edge.setVisible(true).setPosition(sx, sy)
        .setRotation(Math.atan2(ping.y - view.y - sy, ping.x - view.x - sx));
    }
  }

  // ----- carrier over-head diamond (§7.3) -----
  _updateCarrierDiamond() {
    const relic = this.scene.relic;
    if (!relic) return;
    const st = relic.state;
    if (st.rs !== 'held' && st.rs !== 'bagged') return;
    const holder = this.scene.players.get(st.holderSlot);
    if (!holder) return;
    const cx = holder.x, cy = holder.y - PLAYER.height / 2 - 12;
    this.dynGfx.fillStyle(UI.colors.goldInt, 1);
    this.dynGfx.fillPoints([
      { x: cx, y: cy - 4 }, { x: cx + 4, y: cy }, { x: cx, y: cy + 4 }, { x: cx - 4, y: cy },
    ], true);
  }

  // ----- grapple crosshair / aim line / assist brackets (§7.10) -----
  // Display-only raycast: segment-vs-rect against map platforms + intact
  // doors + dynamic entity views. NEVER imports GrappleSystem (approximation
  // by design — documented deviation; host still decides the real attach).
  _updateAim() {
    const local = this._local();
    const frame = this.scene.lastInputFrame;
    if (!local || !frame || local.state.stunned) return;
    // no aim UI while relic-in-hands (grapple/attack are gated — §7.3 tells why)
    const relic = this.scene.relic;
    const relicInHands = local.state.carrying
      ? (local.state.carrying.kind === 'relic' && local.state.carrying.where === 'hands')
      : (local.state.carryingHands && relic?.state.rs === 'held' &&
         relic.state.holderSlot === this.session.localSlot);
    if (relicInHands) return;

    const g = this.dynGfx;
    if (frame.usingGamepad) {
      let dx = frame.aimX, dy = frame.aimY;
      if (dx === 0 && dy === 0) { dx = local.state.facing; dy = 0; }
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const x0 = local.x + dx * (PLAYER.width / 2 + 2);
      const y0 = local.y + dy * (PLAYER.height / 2 + 2);
      g.lineStyle(2, UI.colors.dimInt, UI.aimLine.alpha);
      g.lineBetween(x0, y0, x0 + dx * UI.aimLine.len, y0 + dy * UI.aimLine.len);
      // assist brackets: nearest dynamic view near the ray
      const target = this._assistTarget(local, dx, dy);
      if (target) this._drawBrackets(g, target);
    } else {
      const ax = frame.aimX, ay = frame.aimY;
      const hit = this._rayWouldAttach(local, ax, ay);
      const s = UI.crosshair.size / 2;
      g.lineStyle(2, hit ? UI.colors.goldInt : UI.colors.dimInt, 1);
      g.lineBetween(ax - s, ay, ax + s, ay);
      g.lineBetween(ax, ay - s, ax, ay + s);
    }
  }

  _terrainRects() {
    const rects = [];
    for (const [x, y, w, h] of this.scene.map.platforms) {
      rects.push(new Phaser.Geom.Rectangle(x, y, w, h));
    }
    for (const [, d] of this.scene.doors) {
      if (d.state.state === 'intact') {
        rects.push(new Phaser.Geom.Rectangle(d.x - d.width / 2, d.y - d.height / 2, d.width, d.height));
      }
    }
    return rects;
  }

  _dynamicViews(local) {
    const out = [];
    for (const [slot, p] of this.scene.players) {
      if (slot !== this.session.localSlot) out.push(p);
    }
    for (const [, mv] of this.scene.monsters) out.push(mv);
    const relic = this.scene.relic;
    if (relic && (relic.state.rs === 'loose' || relic.state.rs === 'flying')) out.push(relic);
    return out;
  }

  _rayWouldAttach(local, ax, ay) {
    let dx = ax - local.x, dy = ay - local.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return false;
    dx /= len; dy /= len;
    const ex = local.x + dx * GRAPPLE.maxRange;
    const ey = local.y + dy * GRAPPLE.maxRange;
    const line = new Phaser.Geom.Line(local.x, local.y, ex, ey);
    let bestD = Infinity;
    const consider = (rect) => {
      const pts = Phaser.Geom.Intersects.GetLineToRectangle(line, rect);
      for (const p of pts) {
        const d = Math.hypot(p.x - local.x, p.y - local.y);
        if (d < bestD) bestD = d;
      }
    };
    for (const rect of this._terrainRects()) consider(rect);
    for (const v of this._dynamicViews(local)) {
      const w = v.width || 22, h = v.height || 22;
      consider(new Phaser.Geom.Rectangle(v.x - w / 2, v.y - h / 2, w, h));
    }
    return bestD >= GRAPPLE.minRange && bestD <= GRAPPLE.maxRange;
  }

  _assistTarget(local, dx, dy) {
    let best = null, bestPerp = GRAPPLE.aimAssistRadius;
    for (const v of this._dynamicViews(local)) {
      const rx = v.x - local.x, ry = v.y - local.y;
      const along = rx * dx + ry * dy;
      if (along < GRAPPLE.minRange || along > GRAPPLE.maxRange) continue;
      const perp = Math.abs(rx * dy - ry * dx);
      if (perp < bestPerp) { bestPerp = perp; best = v; }
    }
    return best;
  }

  _drawBrackets(g, v) {
    const w = (v.width || 22) / 2 + 4, h = (v.height || 22) / 2 + 4, L = 6;
    g.lineStyle(2, UI.colors.goldInt, 1);
    const cs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sy] of cs) {
      const cx = v.x + sx * w, cy = v.y + sy * h;
      g.lineBetween(cx, cy, cx - sx * L, cy);
      g.lineBetween(cx, cy, cx, cy - sy * L);
    }
  }

  // ----- OS cursor (§7.10): hidden over canvas during playing, KB/M only -----
  _updateCursor() {
    const hide = this.session.phase === PHASE.PLAYING && InputManager.lastDevice !== 'pad';
    const canvas = this.scene.game.canvas;
    const want = hide ? 'none' : '';
    if (canvas.style.cursor !== want) canvas.style.cursor = want;
  }

  destroy() {
    this._destroyed = true;
    this.scene.game.canvas.style.cursor = '';
    // GameObjects are scene children — destroyed with the scene.
  }
}
