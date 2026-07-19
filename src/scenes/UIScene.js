// ============================================================
// UIScene — HUD overlay running parallel to GameScene (plan §1).
//
// WP6: pure delegator to the ui/ components (HUD, LobbyUI, ResultsUI,
// Toasts) plus the toast catalog (ux-spec §9) driven off the 'ui:event'
// relay (every event GameScene applies is re-emitted here — one line in
// GameScene, plan §WP6 contract §3.5).
//
// Lifecycle: UIScene is stopped/relaunched by GameScene on every phase
// restart — every game.events subscription lives in the _handlers map
// and is paired in the shutdown once-handler (WP1 gotcha). No
// module-level mutable state; run-scoped flags live on this instance.
// ============================================================

import { UI } from '../config.js';
import { PHASE } from '../net/Session.js';
import { EV } from '../net/protocol.js';
import { RS } from '../sim/snapshot.js';
import { Toasts } from '../ui/Toasts.js';
import { HUD, glyph, fmtMsShort, slotColorStr } from '../ui/HUD.js';
import { LobbyUI } from '../ui/LobbyUI.js';
import { ResultsUI } from '../ui/ResultsUI.js';

const STR = {
  joined: ' JOINED',
  left: ' LEFT',
  tombstone: ' DISCONNECTED — TOMBSTONE PLACED',
  isBack: ' IS BACK',
  costCause: {
    door: ' DOOR SMASHED (', rubble: ' RUBBLE BLASTED (',
    shortcut: ' SHORTCUT BROKEN (', bridge: ' BRIDGE KICKED (',
  },
  hourglass: ' HOURGLASS (',
  ritual: '+1:00 RITUAL COMPLETE',
  spawn: 'SOMETHING HEARD THAT…',
  spawnBig: 'SOMETHING BIG HEARD THAT…',
  hasRelic: ' HAS THE RELIC',
  droppedRelic: ' DROPPED THE RELIC!',
  reclaimed: ' RECLAIMED THE RELIC BAG',
};

export class UIScene extends Phaser.Scene {
  constructor() {
    super('UI');
  }

  init(data) {
    this.session = data.session;
    this.mode = data.mode;
  }

  create() {
    this.gameScene = this.scene.get('Game');
    this.toasts = new Toasts(this);
    this.hud = new HUD(this);
    this.lobbyUI = new LobbyUI(this);
    this.resultsUI = new ResultsUI(this);

    // run-scoped flags (reset naturally with every scene relaunch)
    this._relicToastDone = false;

    // roster snapshot for JOINED/LEFT diff toasts (names by slot).
    // Initialized from the live session so the relaunch never re-toasts
    // the current crew.
    this._rosterNames = this._namesBySlot();

    this._handlers = {
      'ui:toast': (text) => this.toasts.push(text),
      'ui:toast:dim': (text) => this.toasts.push(text, { color: UI.colors.dim }),
      'ui:event': (ev) => this._onUiEvent(ev),
      'net:phase': ({ phase, data }) => this._onPhase(phase, data),
      'net:roster': () => this._onRoster(),
    };
    for (const [name, fn] of Object.entries(this._handlers)) {
      this.game.events.on(name, fn);
    }
    this.events.once('shutdown', () => {
      for (const [name, fn] of Object.entries(this._handlers)) {
        this.game.events.off(name, fn);
      }
    });

    this._onPhase(this.session.phase, null);
    // fresh scene entering `playing` = the run just started → go banner.
    // (A mid-run rejoiner also sees it — accepted; it reads as a welcome.)
    if (this.session.phase === PHASE.PLAYING) this.hud.onPlayingEnter();
  }

  // ---------------- phase routing ----------------

  _onPhase(phase, data) {
    this.hud.setPhase(phase);
    this.lobbyUI.setActive(phase === PHASE.LOBBY);
    this.toasts.setLobbyAnchor(phase === PHASE.LOBBY);
    if (phase === PHASE.RESULTS) this.resultsUI.show(data);
    else this.resultsUI.hide();
  }

  // ---------------- roster diff (JOINED / LEFT, §9) ----------------

  _namesBySlot() {
    const names = [null, null, null, null];
    for (const p of this.session.allPlayers()) names[p.slot] = p.name;
    return names;
  }

  _onRoster() {
    const prev = this._rosterNames;
    const now = this._namesBySlot();
    this._rosterNames = now;
    for (let slot = 0; slot < 4; slot++) {
      if (slot === this.session.localSlot) continue;
      if (!prev[slot] && now[slot]) {
        this.toasts.push([{ text: now[slot], color: slotColorStr(slot) }, { text: STR.joined }]);
      } else if (prev[slot] && !now[slot]) {
        this.toasts.push([{ text: prev[slot], color: slotColorStr(slot) }, { text: STR.left }]);
      }
    }
    this.lobbyUI.onRoster();
  }

  // ---------------- toast catalog (ux-spec §9) ----------------

  _name(slot) {
    return this.session.players[slot]?.name ?? 'P' + (slot + 1);
  }

  _nameSeg(slot) {
    return { text: this._name(slot), color: slotColorStr(slot) };
  }

  /** Suppress history-burst toasts during a join/rejoin replay (rule 5). */
  _live() {
    const gs = this.gameScene;
    return gs?.mode !== 'client' || gs?.net?._replayDone === true;
  }

  _onUiEvent(ev) {
    switch (ev.kind) {
      case EV.TIME_COST: {
        this.hud.onTimeDelta(-ev.amount);
        if (!this._live()) break;
        const cause = STR.costCause[ev.cause] ?? ` ${String(ev.cause).toUpperCase()} (`;
        this.toasts.push([
          { text: '-' + fmtMsShort(ev.amount), color: UI.colors.danger },
          { text: cause },
          this._nameSeg(ev.slot ?? -1),
          { text: ')' },
        ]);
        break;
      }
      case EV.TIME_GAIN: {
        this.hud.onTimeDelta(ev.amount);
        if (!this._live()) break;
        if (ev.cause === 'ritual' || ev.slot == null) {
          this.toasts.push(STR.ritual, { color: UI.colors.ok });
        } else {
          this.toasts.push([
            { text: '+' + fmtMsShort(ev.amount), color: UI.colors.ok },
            { text: STR.hourglass },
            this._nameSeg(ev.slot),
            { text: ')' },
          ]);
        }
        break;
      }
      case EV.NOISE_BURST: {
        this.hud.onNoiseSpike();
        if (ev.cause === 'relicDrop' && ev.slot != null && this._live()) {
          this.toasts.push([this._nameSeg(ev.slot), { text: STR.droppedRelic, color: UI.colors.warn }]);
        }
        break;
      }
      case EV.SPAWN: {
        if (ev.etype !== 'monster') break;
        if (this.session.phase !== PHASE.PLAYING || !this._live()) break;
        this.hud.onMonsterSpawn();
        const big = ev.mtype === 'brute';
        this.toasts.push(big ? STR.spawnBig : STR.spawn,
          { color: big ? UI.colors.danger : UI.colors.warn });
        break;
      }
      case EV.ESCALATION: {
        if (this._live()) this.hud.showEscalation(ev.level);
        break;
      }
      case EV.RELIC_STATE: {
        if (ev.rs === RS.held && !this._relicToastDone && ev.hs >= 0 && this._live()) {
          this._relicToastDone = true;
          this.toasts.push([this._nameSeg(ev.hs), { text: STR.hasRelic }]);
        }
        break;
      }
      case EV.TOMBSTONE: {
        if (this._live()) {
          this.toasts.push([this._nameSeg(ev.slot),
            { text: STR.tombstone, color: UI.colors.warn }]);
        }
        break;
      }
      case EV.REJOINED: {
        this.toasts.push([this._nameSeg(ev.slot), { text: STR.isBack, color: UI.colors.ok }]);
        break;
      }
      case EV.TOMBSTONE_STATE: {
        if (ev.by != null && this._live()) {
          this.toasts.push([this._nameSeg(ev.by), { text: STR.reclaimed }]);
        }
        break;
      }
      case EV.READY_COMPLETE: {
        this.lobbyUI.onReadyComplete();
        break;
      }
    }
  }

  // ---------------- update ----------------

  update() {
    const phase = this.session.phase;
    if (phase === PHASE.LOBBY) {
      this.hud.update();
      this.lobbyUI.update(glyph);
    } else if (phase === PHASE.PLAYING) {
      this.hud.update();
    } else if (phase === PHASE.RESULTS) {
      this.resultsUI.updatePad();
    }
  }
}
