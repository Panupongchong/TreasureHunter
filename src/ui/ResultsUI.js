// ============================================================
// ResultsUI — the results screen (ux-spec §8), owned by UIScene.
//
// Rendered ENTIRELY from the ResultsPayload carried by the phase
// message (clients need no other data except session.isHost for the
// button split). Buttons act through the 'ui:action' seam — UIScene
// stays net-free.
// ============================================================

import { GAME_WIDTH, GAME_HEIGHT, UI } from '../config.js';
import { FocusNav } from './nav.js';
import { fmtMs, fmtMsShort, slotColorStr } from './HUD.js';

const STR = {
  verdictWin: 'VAULT BROKEN',
  verdictLose: 'THE CALAMITY',
  reasonWin: 'the relic escaped the dungeon',
  reasonLose: 'the clock hit zero — everyone is very stylishly doomed',
  teamStats: (esc, left, treasure) => `ESCAPE TIME ${esc} · TIME LEFT ${left} · TREASURE: ${treasure}`,
  lost: ' (lost)',
  awardTitle: 'MOST RUINOUS PLAYER: ',
  awardNobody: 'NOBODY',
  awardDetail: (t, ff) => `caused ${t} of time costs and ${ff} friendly damage`,
  awardDetailNobody: 'a suspiciously professional crew',
  btnLobby: '[ RETURN TO LOBBY ]',
  btnExit: '[ EXIT ]',
  waiting: 'waiting for host…',
  noData: 'THE RUN IS OVER',
  noDataReason: 'you joined after the scoreboard — waiting for the host…',
};

// column left-edges + headers (§8)
const COLS = [
  [150, 'PLAYER'], [330, 'DOORS'], [410, 'TIME COST'], [530, 'NOISE'],
  [620, 'FF DEALT'], [720, 'ALLIES THROWN'], [870, 'STUNS'],
];

export class ResultsUI {
  /** @param {Phaser.Scene} uiScene */
  constructor(uiScene) {
    this.scene = uiScene;
    this.session = uiScene.session;
    this.root = null;
    this.nav = null;
  }

  get visible() {
    return !!this.root;
  }

  /** @param {object|null} data full ResultsPayload (null on a re-entry
   *  without data — renders what we can; host always sends data). */
  show(data) {
    this.hide();
    const s = this.scene;
    const C = UI.colors;
    this.root = s.add.container(0, 0).setDepth(UI.depth.modal);
    this.root.add(s.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2,
      GAME_WIDTH, GAME_HEIGHT, 0x000000, UI.scrimAlpha));
    // No payload = we joined mid-results before the host's replayed phase
    // message landed. Render a neutral holding screen — NEVER a verdict we
    // did not receive (plan risk 8: clients state only what the host said).
    if (!data) return this._showNoData();

    const win = data.result === 'win';
    const verdict = s.add.text(480, 64, win ? STR.verdictWin : STR.verdictLose, {
      fontFamily: UI.font, fontSize: '32px', color: win ? C.gold : C.danger,
    }).setOrigin(0.5).setScale(1.4);
    s.tweens.add({ targets: verdict, scale: 1, duration: UI.verdictPopMs });
    this.root.add(verdict);

    this.root.add(s.add.text(480, 100, win ? STR.reasonWin : STR.reasonLose, {
      fontFamily: UI.font, fontSize: '14px', color: C.muted,
    }).setOrigin(0.5));

    const ts = data.teamStats || {};
    this.root.add(s.add.text(480, 138, STR.teamStats(
      win ? fmtMs(ts.escapeMs || 0) : '—',
      fmtMs(ts.timeLeftMs || 0),
      win ? 'RELIC' : 'NONE',
    ), {
      fontFamily: UI.font, fontSize: '14px', color: C.text,
    }).setOrigin(0.5));

    // table header
    for (const [x, header] of COLS) {
      this.root.add(s.add.text(x, 176, header, {
        fontFamily: UI.font, fontSize: '12px', color: C.dim,
      }).setOrigin(0, 0.5));
    }

    // player rows (one per payload row; stagger fade-in 60 ms apart)
    const rows = data.perPlayer || [];
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i];
      const y = 200 + i * 32;
      const rowGos = [];
      const name = s.add.text(COLS[0][0], y, p.name, {
        fontFamily: UI.font, fontSize: '14px', color: slotColorStr(p.slot),
      }).setOrigin(0, 0.5);
      rowGos.push(name);
      if (this.session.players[p.slot]?.connected === false) {
        rowGos.push(s.add.text(COLS[0][0] + name.width, y, STR.lost, {
          fontFamily: UI.font, fontSize: '14px', color: C.dim,
        }).setOrigin(0, 0.5));
      }
      const cells = [
        String(p.doorsSmashed ?? 0), fmtMsShort(p.timeCostMs ?? 0),
        String(Math.round(p.noiseMade ?? 0)), String(p.ffDealt ?? 0),
        String(p.throws ?? 0), String(p.stuns ?? 0),
      ];
      for (let cIdx = 0; cIdx < cells.length; cIdx++) {
        rowGos.push(s.add.text(COLS[cIdx + 1][0], y, cells[cIdx], {
          fontFamily: UI.font, fontSize: '14px', color: C.text,
        }).setOrigin(0, 0.5));
      }
      for (const go of rowGos) {
        go.setAlpha(0);
        s.tweens.add({
          targets: go, alpha: 1, delay: i * UI.resultsRowStaggerMs, duration: 150,
        });
        this.root.add(go);
      }
    }

    // award (§8; pops in last)
    const award = data.award || { slot: null };
    const awardSlot = (award.slot === null || award.slot === undefined || award.slot < 0)
      ? null : award.slot;
    const awardName = awardSlot === null
      ? STR.awardNobody
      : (rows.find((r) => r.slot === awardSlot)?.name ?? 'P' + (awardSlot + 1));
    const awardLine = s.add.text(480, 348, STR.awardTitle + awardName, {
      fontFamily: UI.font, fontSize: '18px', color: C.gold,
    }).setOrigin(0.5).setAlpha(0);
    const detail = awardSlot === null
      ? STR.awardDetailNobody
      : STR.awardDetail(fmtMsShort(award.timeCostMs ?? 0), award.ffDealt ?? 0);
    const awardDetail = s.add.text(480, 372, detail, {
      fontFamily: UI.font, fontSize: '12px', color: C.muted,
    }).setOrigin(0.5).setAlpha(0);
    s.tweens.add({
      targets: [awardLine, awardDetail], alpha: 1,
      delay: rows.length * UI.resultsRowStaggerMs + UI.resultsAwardDelayMs, duration: 200,
    });
    this.root.add([awardLine, awardDetail]);

    // ----- buttons (host: return + exit; clients: waiting + exit) -----
    const emit = (action) => this.scene.game.events.emit('ui:action', { action });
    const items = [];
    if (this.session.isHost) {
      const lobbyBtn = s.add.text(480 - 120, 440, STR.btnLobby, {
        fontFamily: UI.font, fontSize: '22px', color: C.text,
      }).setOrigin(0.5);
      const exitBtn = s.add.text(480 + 160, 440, STR.btnExit, {
        fontFamily: UI.font, fontSize: '22px', color: C.text,
      }).setOrigin(0.5);
      this.root.add([lobbyBtn, exitBtn]);
      items.push({ go: lobbyBtn, onActivate: () => emit('returnLobby') });
      items.push({ go: exitBtn, onActivate: () => emit('exitSession') });
    } else {
      this.root.add(s.add.text(480 - 100, 440, STR.waiting, {
        fontFamily: UI.font, fontSize: '14px', color: C.muted,
      }).setOrigin(0.5));
      const exitBtn = s.add.text(480 + 100, 440, STR.btnExit, {
        fontFamily: UI.font, fontSize: '22px', color: C.text,
      }).setOrigin(0.5);
      this.root.add(exitBtn);
      items.push({ go: exitBtn, onActivate: () => emit('exitSession') });
    }
    this.nav = new FocusNav(s, { onBack: null }); // Esc never exits the page
    this.nav.marker.setDepth(UI.depth.modal + 1);
    this.nav.setItems(items);
  }

  /** Neutral holding screen + Exit only (see show()). The host's replayed
   *  phase message re-enters show() with real data and replaces this. */
  _showNoData() {
    const s = this.scene;
    const C = UI.colors;
    this.root.add(s.add.text(480, 200, STR.noData, {
      fontFamily: UI.font, fontSize: '32px', color: C.muted,
    }).setOrigin(0.5));
    this.root.add(s.add.text(480, 244, STR.noDataReason, {
      fontFamily: UI.font, fontSize: '14px', color: C.dim,
    }).setOrigin(0.5));
    const exitBtn = s.add.text(480, 440, STR.btnExit, {
      fontFamily: UI.font, fontSize: '22px', color: C.text,
    }).setOrigin(0.5);
    this.root.add(exitBtn);
    this.nav = new FocusNav(s, { onBack: null });
    this.nav.marker.setDepth(UI.depth.modal + 1);
    this.nav.setItems([{
      go: exitBtn,
      onActivate: () => this.scene.game.events.emit('ui:action', { action: 'exitSession' }),
    }]);
  }

  updatePad() {
    this.nav?.updatePad();
  }

  hide() {
    this.nav?.destroy();
    this.nav = null;
    this.root?.destroy();
    this.root = null;
  }
}
