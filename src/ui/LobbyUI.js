// ============================================================
// LobbyUI — lobby-phase panels (ux-spec §6), owned by UIScene:
// room code badge + COPY, roster panel with host kick-hold, stage board
// popup, ready-zone fill ring, FF/stage toasts.
//
// The ready ring and board popup are world-space widgets, but the lobby
// map is exactly 960×540 (world == screen with a static camera), so
// drawing them in the UIScene is legal — asserted on activation
// (contract §0 rule 3).
// ============================================================

import { GAME_WIDTH, UI, PLAYER, NET, READY } from '../config.js';
import { PHASE } from '../net/Session.js';
import { getMap } from '../maps/mapTypes.js';
import { slotColorStr } from './HUD.js';

const STR = {
  room: 'ROOM ',
  copy: '[COPY]',
  copied: 'COPIED',
  solo: 'SOLO PRACTICE',
  kick: '[KICK]',
  lost: 'LOST',
  empty: '—',
  host: '★ ',
  stage: 'STAGE',
  nextStage: (g) => `${g} NEXT STAGE`,
  hostOnly: 'ONLY THE HOST PICKS THE STAGE',
  ready: (n, m) => `READY ${n}/${m}`,
  ffFull: 'FRIENDLY FIRE: FULL',
  ffStd: 'FRIENDLY FIRE: STANDARD',
  stageToast: (name) => `STAGE: ${name}`,
};

export class LobbyUI {
  /** @param {Phaser.Scene} uiScene */
  constructor(uiScene) {
    this.scene = uiScene;
    this.session = uiScene.session;
    this.game = uiScene.scene.get('Game');
    const C = UI.colors;

    this.root = uiScene.add.container(0, 0).setVisible(false);

    // ----- room code badge (§6.1): panel 220x36 center (480,26) -----
    const badge = uiScene.add.graphics().setDepth(UI.depth.panels);
    badge.fillStyle(C.panel, UI.panelAlpha);
    badge.fillRoundedRect(480 - 110, 26 - 18, 220, 36, UI.panelRadius);
    badge.lineStyle(UI.panelStrokeW, C.panelStroke, 1);
    badge.strokeRoundedRect(480 - 110, 26 - 18, 220, 36, UI.panelRadius);
    this.root.add(badge);
    if (this.session.roomCode) {
      this.root.add(uiScene.add.text(396, 26, STR.room, {
        fontFamily: UI.font, fontSize: '14px', color: C.muted,
      }).setOrigin(0, 0.5));
      this.root.add(uiScene.add.text(396 + 46, 26, this.session.roomCode, {
        fontFamily: UI.font, fontSize: '18px', color: C.gold,
      }).setOrigin(0, 0.5));
      this.copyBtn = uiScene.add.text(560, 26, STR.copy, {
        fontFamily: UI.font, fontSize: '12px', color: C.text,
      }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
      this.copyBtn.on('pointerover', () => this.copyBtn.setColor(C.gold));
      this.copyBtn.on('pointerout', () => {
        if (this.copyBtn.text === STR.copy) this.copyBtn.setColor(C.text);
      });
      this.copyBtn.on('pointerdown', () => this._copyCode());
      this.root.add(this.copyBtn);
    } else {
      this.root.add(uiScene.add.text(480, 26, STR.solo, {
        fontFamily: UI.font, fontSize: '14px', color: C.muted,
      }).setOrigin(0.5));
    }

    // ----- roster panel (§6.2): 208x124 at (16,16) -----
    const rp = uiScene.add.graphics().setDepth(UI.depth.panels);
    rp.fillStyle(C.panel, UI.panelAlpha);
    rp.fillRoundedRect(16, 16, 208, 124, UI.panelRadius);
    rp.lineStyle(UI.panelStrokeW, C.panelStroke, 1);
    rp.strokeRoundedRect(16, 16, 208, 124, UI.panelRadius);
    this.root.add(rp);
    this.rosterRows = uiScene.add.container(0, 0).setDepth(UI.depth.hud);
    this.root.add(this.rosterRows);
    this.kickRingGfx = uiScene.add.graphics().setDepth(UI.depth.hud + 1);
    this.root.add(this.kickRingGfx);
    this._kickHold = null; // {slot, startedAt}

    // ----- ready ring + board popup (world-space; world==screen in lobby) -----
    this.ringGfx = uiScene.add.graphics().setDepth(UI.depth.hud);
    this.root.add(this.ringGfx);
    this.ringText = uiScene.add.text(0, 0, '', {
      fontFamily: UI.font, fontSize: '14px', color: UI.colors.text,
    }).setOrigin(0.5).setDepth(UI.depth.hud);
    this.root.add(this.ringText);
    this.ringCount = uiScene.add.text(0, 0, '', {
      fontFamily: UI.font, fontSize: '12px', color: UI.colors.ok,
    }).setOrigin(0.5).setDepth(UI.depth.hud);
    this.root.add(this.ringCount);
    this._prevRz = 0;
    this._flashUntil = 0;
    this._flashColor = null;
    this._ringKey = '';

    // board popup (240x100 anchored 12px above the board, §6.3)
    this.popup = uiScene.add.container(0, 0).setVisible(false).setDepth(UI.depth.hud);
    this.popupBg = uiScene.add.graphics();
    this.popup.add(this.popupBg);
    this.popupTitle = uiScene.add.text(0, 0, STR.stage, {
      fontFamily: UI.font, fontSize: '10px', color: C.muted,
    }).setOrigin(0.5);
    this.popupName = uiScene.add.text(0, 0, '', {
      fontFamily: UI.font, fontSize: '14px', color: C.text,
    }).setOrigin(0.5);
    this.popupLine3 = uiScene.add.text(0, 0, '', {
      fontFamily: UI.font, fontSize: '12px', color: C.text,
    }).setOrigin(0.5);
    this.popup.add([this.popupTitle, this.popupName, this.popupLine3]);
    this.root.add(this.popup);

    this._prevFf = this.session.ffFull;
    this._prevStage = this.session.stageId;
    this._active = false;
  }

  setActive(active) {
    this._active = active;
    this.root.setVisible(active);
    if (active) {
      const map = this.game?.map;
      if (map && map.width > GAME_WIDTH) {
        // world!=screen would misplace the world-space widgets (contract §0.3)
        console.warn('[LobbyUI] lobby map exceeds the viewport — world-space UI misaligned');
      }
      this.rebuildRoster();
      // FF toast on lobby entry when FULL (the toggle itself is menu-time).
      // Flag lives on the SESSION, not the UIScene: UIScene relaunches on
      // every phase change, so a per-scene flag re-announced a fixed
      // setting after every results→lobby return.
      if (this.session.ffFull && !this.session._ffToasted) {
        this.session._ffToasted = true;
        this.scene.toasts.push(STR.ffFull);
      }
    } else {
      this.popup.setVisible(false);
      this._kickHold = null;
      this.kickRingGfx.clear();
    }
  }

  _copyCode() {
    const code = this.session.roomCode;
    try {
      navigator.clipboard?.writeText(code).then(() => {
        this.copyBtn.setText(STR.copied).setColor(UI.colors.ok);
        this.scene.time.delayedCall(UI.copiedRevertMs, () => {
          if (this.copyBtn.active) this.copyBtn.setText(STR.copy).setColor(UI.colors.text);
        });
      }).catch(() => {});
    } catch (_) { /* clipboard unavailable */ }
  }

  /** Rebuild roster rows — called on net:roster only, not per frame. */
  rebuildRoster() {
    this.rosterRows.removeAll(true);
    this._kickHold = null;
    this.kickRingGfx.clear();
    const C = UI.colors;
    const canKick = this.session.isHost && this.game?.mode === 'host';
    for (let slot = 0; slot < NET.maxPlayers; slot++) {
      const rowY = 16 + 8 + 14 + slot * 28;
      const p = this.session.players[slot];
      if (!p) {
        this.rosterRows.add(this.scene.add.text(208, rowY, STR.empty, {
          fontFamily: UI.font, fontSize: '12px', color: C.dim,
        }).setOrigin(1, 0.5));
        continue;
      }
      this.rosterRows.add(this.scene.add.rectangle(28 + 6, rowY, 12, 12,
        PLAYER.colors[slot % 4]));
      const prefix = p.isHost ? STR.host : '';
      this.rosterRows.add(this.scene.add.text(46, rowY, prefix + p.name, {
        fontFamily: UI.font, fontSize: '14px', color: slotColorStr(slot),
      }).setOrigin(0, 0.5));
      if (!p.connected) {
        this.rosterRows.add(this.scene.add.text(208, rowY, STR.lost, {
          fontFamily: UI.font, fontSize: '12px', color: C.danger,
        }).setOrigin(1, 0.5));
      } else if (canKick && !p.isHost) {
        // kick hold-to-confirm (mouse-only in v1 — accepted, ux-spec §6.2)
        const kick = this.scene.add.text(208, rowY, STR.kick, {
          fontFamily: UI.font, fontSize: '12px', color: C.danger,
        }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
        kick.on('pointerdown', () => {
          this._kickHold = { slot, startedAt: this.scene.time.now, rowY };
        });
        const cancel = () => { this._kickHold = null; this.kickRingGfx.clear(); };
        kick.on('pointerup', cancel);
        kick.on('pointerout', cancel);
        this.rosterRows.add(kick);
      }
    }
  }

  /** READY_COMPLETE event → 300 ms ok flash (§6.4). */
  onReadyComplete() {
    this._flashUntil = this.scene.time.now + UI.readyRing.doneFlashMs;
    this._flashColor = UI.colors.okInt;
  }

  /** Roster-diff toasts owned by LobbyUI: stage change (§9). */
  onRoster() {
    this.rebuildRoster();
    if (this.session.stageId !== this._prevStage) {
      this._prevStage = this.session.stageId;
      this.scene.toasts.push(STR.stageToast(getMap(this.session.stageId).name.toUpperCase()));
    }
    if (this.session.ffFull !== this._prevFf) {
      this._prevFf = this.session.ffFull;
      this.scene.toasts.push(this.session.ffFull ? STR.ffFull : STR.ffStd);
    }
  }

  update(glyphFn) {
    if (!this._active) return;
    this._updateKickHold();
    this._updateRing();
    this._updatePopup(glyphFn);
  }

  _updateKickHold() {
    if (!this._kickHold) return;
    const now = this.scene.time.now;
    const frac = (now - this._kickHold.startedAt) / UI.kickHoldMs;
    const g = this.kickRingGfx;
    g.clear();
    const cx = 196, cy = this._kickHold.rowY;
    g.lineStyle(3, UI.colors.dangerInt, 1);
    g.beginPath();
    g.arc(cx, cy, UI.kickRingR, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frac) * Math.PI * 2);
    g.strokePath();
    if (frac >= 1) {
      const slot = this._kickHold.slot;
      this._kickHold = null;
      g.clear();
      this.scene.game.events.emit('ui:action', { action: 'kick', slot });
    }
  }

  _updateRing() {
    const gs = this.game;
    const zone = gs?.map?.readyZone;
    if (!zone || !gs.getWorldRow) { this.ringGfx.clear(); this.ringText.setText(''); this.ringCount.setText(''); return; }
    const row = gs.getWorldRow();
    const rz = row.rz || 0;
    const n = row.rzN || 0;
    const m = row.rzM || this.session.connectedPlayers().length || 1;
    const now = this.scene.time.now;

    // reset flash: rz dropped to 0 from >0 (client-side detect, §6.4)
    if (this._prevRz > 0 && rz === 0 && now >= this._flashUntil) {
      this._flashUntil = now + UI.readyRing.resetFlashMs;
      this._flashColor = UI.colors.warnInt;
    }
    this._prevRz = rz;

    const R = UI.readyRing;
    const cx = zone.x + zone.w / 2;
    // Ring sits clear of head height: players standing in the zone were
    // occluding their own 3-2-1 countdown (UX review §6.4).
    const cy = zone.y + zone.h - 8 - UI.readyRing.aboveStrip;
    const flashing = now < this._flashUntil;
    const key = [rz, n, m, flashing ? this._flashColor : 0].join('|');
    if (key !== this._ringKey) {
      this._ringKey = key;
      const g = this.ringGfx;
      g.clear();
      g.lineStyle(R.lineW, UI.colors.panelStroke, 1);
      g.strokeCircle(cx, cy, R.r);
      if (flashing) {
        g.lineStyle(R.lineW, this._flashColor, 1);
        g.strokeCircle(cx, cy, R.r);
      } else if (rz > 0) {
        g.lineStyle(R.lineW, UI.colors.okInt, 1);
        g.beginPath();
        g.arc(cx, cy, R.r, -Math.PI / 2, -Math.PI / 2 + (rz / 100) * Math.PI * 2);
        g.strokePath();
      }
      this.ringText.setPosition(cx, cy + 6).setText(STR.ready(n, m));
      if (rz > 0 && rz < 100) {
        // Countdown ABOVE the readout (was below, at head height).
        // Duration from config so ring fill and digits can't disagree.
        this.ringCount.setPosition(cx, cy - 16)
          .setText(String(Math.ceil((1 - rz / 100) * (READY.holdMs / 1000))));
      } else {
        this.ringCount.setText('');
      }
    }
  }

  _updatePopup(glyphFn) {
    const gs = this.game;
    const board = gs?.map?.board;
    const local = gs?.players?.get(this.session.localSlot);
    if (!board || !local) { this.popup.setVisible(false); return; }
    const near = Math.max(Math.abs(local.x - board.x), Math.abs(local.y - board.y)) <=
      UI.boardPopupCloseRange;
    this.popup.setVisible(near);
    if (!near) return;
    const bx = board.x, by = board.y - 12 - 50; // panel 240x100 anchored above
    this.popup.setPosition(bx, by);
    const g = this.popupBg;
    g.clear();
    g.fillStyle(UI.colors.panel, UI.panelAlpha);
    g.fillRoundedRect(-120, -50, 240, 100, UI.panelRadius);
    g.lineStyle(UI.panelStrokeW, UI.colors.panelStroke, 1);
    g.strokeRoundedRect(-120, -50, 240, 100, UI.panelRadius);
    this.popupTitle.setPosition(0, -34);
    this.popupName.setPosition(0, -12)
      .setText(getMap(this.session.stageId).name.toUpperCase());
    const isHost = this.session.isHost;
    this.popupLine3.setPosition(0, 18)
      .setText(isHost ? STR.nextStage(glyphFn('interact')) : STR.hostOnly)
      .setColor(isHost ? UI.colors.text : UI.colors.dim);
  }
}
