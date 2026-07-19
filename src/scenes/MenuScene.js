// ============================================================
// MenuScene — final WP6 menu tree (ux-spec §2–§5).
//
// Sub-states: 'menu' | 'join' | 'settings' | 'connecting'.
// Keyboard, mouse AND gamepad navigation via ui/nav.js FocusNav
// (§0.6); join-code entry and name editing capture raw keydown with
// nav disabled. Networking objects are created here and handed to
// GameScene via scene data; the menu never keeps a live transport
// after leaving.
// ============================================================

import { GAME_WIDTH, NET, UI } from '../config.js';
import { Session, PHASE } from '../net/Session.js';
import { HostNet } from '../net/HostNet.js';
import { ClientNet } from '../net/ClientNet.js';
import { tokenStorageKey, LAST_ROOM_KEY, PROTOCOL_VERSION } from '../net/protocol.js';
import { FocusNav } from '../ui/nav.js';
import { InputManager } from '../input/InputManager.js';

const KC = Phaser.Input.Keyboard.KeyCodes;

const STR = {
  title: 'VAULTBREAKERS',
  tagline: 'steal the relic · beat the calamity',
  host: '[ HOST GAME ]',
  join: '[ JOIN GAME ]',
  solo: '[ PRACTICE (SOLO) ]',
  settings: '[ SETTINGS ]',
  rejoin: (code) => `[ REJOIN LAST ROOM ${code} ]`,
  hint: 'arrows/WS + ENTER · mouse · gamepad',
  version: 'proto v' + PROTOCOL_VERSION,
  codeHeader: 'ENTER ROOM CODE',
  joinBtn: '[ JOIN ]',
  backHintKb: '[ESC] back',
  backHintPad: '(B) back',
  // §4.1 connecting overlay
  opening: 'OPENING ROOM',
  openingSub: 'registering with the broker',
  joining: (c) => `CONNECTING TO ROOM ${c}`,
  joiningSub: 'waiting for host',
  rejoining: (c) => `REJOINING ROOM ${c}`,
  rejoiningSub: 'reclaiming your slot',
  cancel: '[ CANCEL ]',
  // §5 settings
  settingsHeader: 'SETTINGS',
  name: 'NAME',
  ff: 'FRIENDLY FIRE',
  ffStd: 'STANDARD (50%)',
  ffFull: 'FULL (100%)',
  volume: 'VOLUME',
  volumeSuffix: ' (no audio yet)',
  bindsHeader: 'BINDS (view only)',
  kbToEdit: '(keyboard to edit)',
  back: '[ BACK ]',
  defaultName: 'PLAYER',
};

// §4.2 error strings — single source of truth, verbatim.
const JOIN_ERROR_TEXT = {
  'full': 'ROOM IS FULL (4/4)',
  'bad-code': 'ROOM NOT FOUND — CHECK THE CODE',
  'timeout': 'CONNECTION TIMED OUT — TRY AGAIN',
  'in-run': "RUN IN PROGRESS — CAN'T JOIN MID-RUN",
  'version': 'VERSION MISMATCH — HOST HAS A DIFFERENT BUILD',
};
const HOST_ERROR_TEXT = 'NO ROOM AVAILABLE — TRY AGAIN';

// §1 binds table, verbatim (view-only).
const BINDS = [
  ['Move', 'A / D', 'Left stick'],
  ['Jump (hold = higher)', 'SPACE', 'A'],
  ['Attack', 'LMB', 'X'],
  ['Aim', 'Mouse', 'Right stick'],
  ['Grapple', 'RMB', 'RT'],
  ['Interact (hold)', 'E', 'Y'],
  ['Grab / Throw', 'F', 'B'],
  ['Sprint / Dodge', 'SHIFT', 'LB'],
  ['Ping', 'Q', 'R3'],
];

const BOX_XS = [408, 456, 504, 552]; // §3 letter-box centers

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  init(data) {
    this.notice = data?.notice || null;
  }

  create() {
    this.state = 'menu';
    this.busy = false;
    this.cancelled = false;
    const cx = GAME_WIDTH / 2;
    const C = UI.colors;
    const T = (x, y, text, size, color, origin = 0.5) => this.add.text(x, y, text, {
      fontFamily: UI.font, fontSize: size + 'px', color,
    }).setOrigin(...(Array.isArray(origin) ? origin : [origin, origin]));

    this.titleText = this.add.text(cx, 130, STR.title, {
      fontFamily: UI.font, fontSize: '44px', color: C.gold, letterSpacing: 8,
    }).setOrigin(0.5);
    this.taglineText = T(cx, 172, STR.tagline, 14, C.muted);
    T(cx, 505, STR.hint, 12, C.dim);
    T(12, 526, STR.version, 10, C.dim, [0, 0.5]);

    // shared error line (§3/§4.2: code-entry AND main-menu errors)
    this.errorText = T(cx, 430, '', 12, C.danger);

    // notice pill (KICKED BY HOST / HOST DISCONNECTED…) — §9-styled
    if (this.notice) this._noticePill(this.notice);

    this.nav = new FocusNav(this, { onBack: () => this._navBack() });

    // ----- main menu (§2) -----
    this.menuBox = this.add.container(0, 0);
    this.btnHost = T(cx, 250, STR.host, 22, C.text);
    this.btnJoin = T(cx, 292, STR.join, 22, C.text);
    this.btnSolo = T(cx, 334, STR.solo, 22, C.text);
    this.btnSettings = T(cx, 376, STR.settings, 22, C.text);
    this.menuBox.add([this.btnHost, this.btnJoin, this.btnSolo, this.btnSettings]);
    this._rejoin = this._rejoinCode();
    if (this._rejoin) {
      this.btnRejoin = T(cx, 424, STR.rejoin(this._rejoin), 14, C.warn);
      this.btnRejoin.baseColor = C.warn;
      this.menuBox.add(this.btnRejoin);
    }
    // No [ EXIT ] on web (locked). A desktop build appends it here.
    const IS_DESKTOP = false;
    if (IS_DESKTOP) { /* [ EXIT ] at y=418 */ }

    // ----- join code entry (§3) -----
    this.codeArr = ['', '', '', ''];
    this.activeBox = 0;
    this.joinBox = this.add.container(0, 0).setVisible(false);
    // §3 backing panel (360x200 centered on 480,300), behind everything else
    // in the group — added first so it never occludes the letters.
    const joinPanel = this.add.graphics();
    joinPanel.fillStyle(UI.colors.panel, UI.panelAlpha);
    joinPanel.fillRoundedRect(480 - 180, 300 - 100, 360, 200, UI.panelRadius);
    joinPanel.lineStyle(UI.panelStrokeW, UI.colors.panelStroke, 1);
    joinPanel.strokeRoundedRect(480 - 180, 300 - 100, 360, 200, UI.panelRadius);
    this.joinBox.add(joinPanel);
    this.joinBox.add(T(cx, 232, STR.codeHeader, 18, C.text));
    this.codeGfx = this.add.graphics();
    this.joinBox.add(this.codeGfx);
    this.codeLetters = BOX_XS.map((x) => {
      const t = T(x, 290, '', 26, C.text);
      this.joinBox.add(t);
      return t;
    });
    this.caret = this.add.rectangle(BOX_XS[0], 290 + 20, 24, 2, UI.colors.goldInt);
    this.joinBox.add(this.caret);
    this.joinBtn = T(cx, 366, STR.joinBtn, 22, C.dim);
    this.joinBtn.setInteractive({ useHandCursor: true });
    this.joinBtn.on('pointerdown', () => this._tryJoin());
    this.joinBox.add(this.joinBtn);
    this.backHint = T(cx, 400, STR.backHintKb, 12, C.dim);
    this.joinBox.add(this.backHint);
    // click a box to activate it
    BOX_XS.forEach((x, i) => {
      const hit = this.add.rectangle(x, 290, 40, 52, 0, 0)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => { this.activeBox = i; this._renderCode(); });
      this.joinBox.add(hit);
    });

    // ----- settings (§5) -----
    this._buildSettings();

    // ----- connecting overlay (§4.1) -----
    this.overlay = this.add.container(0, 0).setVisible(false).setDepth(50);
    this.overlay.add(this.add.rectangle(cx, 270, GAME_WIDTH, 540, 0x000000, UI.scrimAlpha));
    const og = this.add.graphics();
    og.fillStyle(C.panel, UI.panelAlpha);
    og.fillRoundedRect(cx - 210, 270 - 70, 420, 140, UI.panelRadius);
    og.lineStyle(UI.panelStrokeW, C.panelStroke, 1);
    og.strokeRoundedRect(cx - 210, 270 - 70, 420, 140, UI.panelRadius);
    this.overlay.add(og);
    this.overlayStatus = T(cx, 245, '', 18, C.text);
    this.overlaySub = T(cx, 275, '', 12, C.muted);
    this.cancelBtn = T(cx, 312, STR.cancel, 14, C.text);
    this.cancelBtn.setInteractive({ useHandCursor: true });
    this.cancelBtn.on('pointerover', () => this.cancelBtn.setColor(C.gold));
    this.cancelBtn.on('pointerout', () => this.cancelBtn.setColor(C.text));
    this.cancelBtn.on('pointerdown', () => this._cancel());
    this.overlay.add([this.overlayStatus, this.overlaySub, this.cancelBtn]);
    this._overlayBase = '';

    // ----- input -----
    this.input.keyboard.on('keydown', (e) => this._onKey(e));
    this._pasteHandler = (e) => this._onPaste(e);
    document.addEventListener('paste', this._pasteHandler);
    this.events.once('shutdown', () => {
      document.removeEventListener('paste', this._pasteHandler);
      this.nav.destroy();
    });
    // join-state gamepad edge/repeat scratch
    this._pad = { prev: {}, vNext: 0, hNext: 0, vDir: 0, hDir: 0 };

    this._applyState('menu');
  }

  // ---------------- settings construction ----------------

  _buildSettings() {
    const cx = GAME_WIDTH / 2;
    const C = UI.colors;
    this.settingsBox = this.add.container(0, 0).setVisible(false);
    const g = this.add.graphics();
    g.fillStyle(C.panel, UI.panelAlpha);
    g.fillRoundedRect(cx - 260, 290 - 190, 520, 380, UI.panelRadius);
    g.lineStyle(UI.panelStrokeW, C.panelStroke, 1);
    g.strokeRoundedRect(cx - 260, 290 - 190, 520, 380, UI.panelRadius);
    this.settingsBox.add(g);
    const T = (x, y, text, size, color, ox, oy) => {
      const t = this.add.text(x, y, text, {
        fontFamily: UI.font, fontSize: size + 'px', color,
      }).setOrigin(ox, oy);
      this.settingsBox.add(t);
      return t;
    };
    T(cx, 128, STR.settingsHeader, 18, C.text, 0.5, 0.5);
    this.rowName = T(250, 170, STR.name, 14, C.muted, 0, 0.5);
    this.valName = T(710, 170, '', 14, C.text, 1, 0.5);
    this.editHint = T(710, 184, STR.kbToEdit, 10, C.dim, 1, 0.5).setVisible(false);
    this.rowFf = T(250, 205, STR.ff, 14, C.muted, 0, 0.5);
    this.valFf = T(710, 205, '', 14, C.text, 1, 0.5);
    this.rowVol = T(250, 240, STR.volume, 14, C.muted, 0, 0.5);
    this.valVol = T(710, 240, '', 14, C.dim, 1, 0.5);
    T(cx, 280, STR.bindsHeader, 14, C.muted, 0.5, 0.5);
    for (let i = 0; i < BINDS.length; i++) {
      const y = 300 + i * 16;
      T(270, y, BINDS[i][0], 12, C.muted, 0, 0.5);
      T(520, y, BINDS[i][1], 12, C.text, 1, 0.5);
      T(700, y, BINDS[i][2], 12, C.text, 1, 0.5);
    }
    this.btnBack = T(cx, 470, STR.back, 22, C.text, 0.5, 0.5);
    this.editingName = false;
    this._refreshSettingsValues();
  }

  _refreshSettingsValues() {
    const name = this._name();
    this.valName.setText(this.editingName ? this._editBuffer + '_' : name);
    this.valFf.setText(this._ffPref() ? STR.ffFull : STR.ffStd);
    this.valVol.setText(`◄ ${this._vol()}% ►` + STR.volumeSuffix);
  }

  _vol() {
    const v = parseInt(localStorage.getItem('vb-vol') ?? '80', 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 80;
  }

  _setVol(v) {
    try { localStorage.setItem('vb-vol', String(Math.max(0, Math.min(100, v)))); } catch (_) {}
    this._refreshSettingsValues();
  }

  _toggleFf() {
    try { localStorage.setItem('vb-ff', this._ffPref() ? '0' : '1'); } catch (_) {}
    this._refreshSettingsValues();
  }

  _startNameEdit() {
    // Name editing is keyboard-only (ux-spec §5: the row shows
    // "(keyboard to edit)" on a pad). Activating it from the pad would
    // disable FocusNav with no pad-reachable way back out — a softlock.
    if (InputManager.lastDevice === 'pad') return;
    this.editingName = true;
    this._editBuffer = this._name() === STR.defaultName ? '' : this._name();
    this.nav.setEnabled(false);
    this._refreshSettingsValues();
  }

  _commitNameEdit() {
    this.editingName = false;
    const name = (this._editBuffer || '').trim().slice(0, NET.maxNameLen) || STR.defaultName;
    try { localStorage.setItem('vb-name', name); } catch (_) {}
    this.nav.setEnabled(true);
    this._refreshSettingsValues();
  }

  // ---------------- actions ----------------

  _solo() {
    if (this.busy) return;
    const session = new Session();
    session.initSolo(this._name(), this._ffPref());
    this.scene.start('Game', { mode: 'solo', mapId: 'lobby', session, net: null });
  }

  async _host() {
    if (this.busy) return;
    this.busy = true;
    this.cancelled = false;
    const session = new Session();
    const net = new HostNet(session, this.game.events);
    this._netInFlight = net;
    this._showConnecting(STR.opening, STR.openingSub);
    try {
      await net.start(this._name(), this._ffPref());
      // Staleness is per-ATTEMPT, not the shared `cancelled` flag: a new
      // attempt resets that flag, so a late settlement from an abandoned
      // net would otherwise stomp the live one's overlay and buttons.
      if (this._netInFlight !== net) return net.close();
      this.scene.start('Game', { mode: 'host', mapId: 'lobby', session, net });
    } catch (err) {
      net.close();
      if (this._netInFlight !== net) return; // superseded/cancelled — stay silent
      // broker unreachable / code-collision retries exhausted (§4.2)
      this._applyState('menu');
      this._setError(HOST_ERROR_TEXT);
      this.busy = false;
    }
  }

  async _join(code, rejoin = false) {
    if (this.busy) return;
    this.busy = true;
    this.cancelled = false;
    const codeU = code.toUpperCase();
    // Was a rejoin token attached to this attempt? (ClientNet.join reads
    // the same key.) Needed to interpret an 'in-run' reject below.
    let hadToken = false;
    try { hadToken = !!sessionStorage.getItem(tokenStorageKey(codeU)); } catch (_) {}
    const session = new Session();
    const net = new ClientNet(session, this.game.events);
    this._netInFlight = net;
    if (rejoin || hadToken) this._showConnecting(STR.rejoining(codeU), STR.rejoiningSub);
    else this._showConnecting(STR.joining(codeU), STR.joiningSub);
    try {
      await net.join(codeU, this._name());
      if (this._netInFlight !== net) return net.close(); // see _host

      const inRun = session.phase === PHASE.PLAYING || session.phase === PHASE.RESULTS;
      this.scene.start('Game', {
        mode: 'client',
        mapId: inRun ? session.stageId : 'lobby',
        session, net,
      });
    } catch (err) {
      net.close();
      if (this._netInFlight !== net) return; // superseded/cancelled — stay silent
      this.busy = false;
      // 'in-run' WITH a token = the token is dead (host doesn't know it —
      // e.g. a new run started). Burn the credential so the rejoin
      // shortcut disappears (ClientNet stays policy-free).
      if (err.reason === 'in-run' && hadToken) {
        try {
          sessionStorage.removeItem(tokenStorageKey(codeU));
          if (sessionStorage.getItem(LAST_ROOM_KEY) === codeU) {
            sessionStorage.removeItem(LAST_ROOM_KEY);
          }
        } catch (_) {}
        this._rejoin = null;
        this.btnRejoin?.destroy();
        this.btnRejoin = null;
      }
      // join errors land on the code-entry error line (§4.2)
      this._applyState('join');
      this._setError(JOIN_ERROR_TEXT[err.reason] || JOIN_ERROR_TEXT['timeout']);
    }
  }

  _cancel() {
    this.cancelled = true;
    this.busy = false;
    this._netInFlight?.close();
    this._netInFlight = null;
    this._applyState(this._cameFrom === 'join' ? 'join' : 'menu');
  }

  /** Friendly-fire preference ('vb-ff': '1' = FULL). Applied ONLY when
   *  the local player hosts — fixed at session init. */
  _ffPref() {
    try { return localStorage.getItem('vb-ff') === '1'; } catch (_) { return false; }
  }

  /** The last room code IFF a live token for it exists — null otherwise. */
  _rejoinCode() {
    try {
      const code = sessionStorage.getItem(LAST_ROOM_KEY);
      return code && sessionStorage.getItem(tokenStorageKey(code)) ? code : null;
    } catch (_) { return null; }
  }

  _name() {
    try {
      return (localStorage.getItem('vb-name') || STR.defaultName).slice(0, NET.maxNameLen);
    } catch (_) { return STR.defaultName; }
  }

  // ---------------- ui state ----------------

  _applyState(state) {
    this.state = state;
    this.menuBox.setVisible(state === 'menu');
    this.joinBox.setVisible(state === 'join');
    this.settingsBox.setVisible(state === 'settings');
    this.overlay.setVisible(state === 'connecting');
    // title/tagline stay for menu/join/connecting (§3); the settings
    // panel overlaps them → hide (panel alpha 0.92 would ghost them).
    this.titleText.setVisible(state !== 'settings');
    this.taglineText.setVisible(state !== 'settings');
    this._setError('');
    if (state === 'menu') {
      this.nav.setEnabled(true);
      const items = [
        { go: this.btnHost, onActivate: () => this._host() },
        { go: this.btnJoin, onActivate: () => this._showJoin() },
        { go: this.btnSolo, onActivate: () => this._solo() },
        { go: this.btnSettings, onActivate: () => this._showSettings() },
      ];
      if (this.btnRejoin) {
        items.push({ go: this.btnRejoin, onActivate: () => this._join(this._rejoin, true), baseColor: UI.colors.warn });
        items[items.length - 1].go.baseColor = UI.colors.warn;
      }
      this.nav.setItems(items);
    } else if (state === 'settings') {
      this.nav.setEnabled(true);
      this.nav.setItems([
        {
          go: this.rowName,
          onActivate: () => this._startNameEdit(),
        },
        {
          go: this.rowFf,
          onActivate: () => this._toggleFf(),
          onLeft: () => this._toggleFf(),
          onRight: () => this._toggleFf(),
        },
        {
          go: this.rowVol,
          onLeft: () => this._setVol(this._vol() - 10),
          onRight: () => this._setVol(this._vol() + 10),
        },
        { go: this.btnBack, onActivate: () => this._applyState('menu') },
      ]);
    } else {
      // join / connecting: raw key + pad handling, nav suspended
      this.nav.setEnabled(false);
      if (state === 'join') this._renderCode();
    }
  }

  _navBack() {
    if (this.state === 'settings') {
      if (this.editingName) this._commitNameEdit();
      else this._applyState('menu');
    }
    // 'menu': Esc never exits the page (§0.6)
  }

  _showJoin() {
    if (this.busy) return;
    this._cameFrom = 'join';
    this._applyState('join');
  }

  _showSettings() {
    if (this.busy) return;
    this._refreshSettingsValues();
    this._applyState('settings');
  }

  _showConnecting(status, sub) {
    this._cameFrom = this.state === 'join' ? 'join' : 'menu';
    this.state = 'connecting';
    this.menuBox.setVisible(false);
    this.joinBox.setVisible(false);
    this.settingsBox.setVisible(false);
    this.overlay.setVisible(true);
    this._overlayBase = status;
    this.overlaySub.setText(sub);
    this.nav.setEnabled(false);
    this._setError('');
  }

  _setError(text) {
    this.errorText.setText(text || '');
  }

  _noticePill(text) {
    const t = this.add.text(0, 0, text, {
      fontFamily: UI.font, fontSize: '12px', color: UI.colors.danger,
    }).setOrigin(0, 0.5);
    const w = t.width;
    const g = this.add.graphics().setDepth(UI.depth.toasts);
    g.fillStyle(UI.colors.panel, UI.panelAlpha);
    g.fillRoundedRect(480 - w / 2 - 8, 496 - 12, w + 16, 24, 4);
    t.setPosition(480 - w / 2, 496).setDepth(UI.depth.toasts + 1);
  }

  // ---------------- join code entry ----------------

  _codeComplete() {
    return this.codeArr.every((c) => c);
  }

  _tryJoin() {
    if (this._codeComplete()) this._join(this.codeArr.join(''));
  }

  _renderCode() {
    const g = this.codeGfx;
    const C = UI.colors;
    g.clear();
    for (let i = 0; i < 4; i++) {
      g.fillStyle(C.panel, 1);
      g.fillRect(BOX_XS[i] - 20, 290 - 26, 40, 52);
      g.lineStyle(2, i === this.activeBox ? C.goldInt : C.panelStroke, 1);
      g.strokeRect(BOX_XS[i] - 20, 290 - 26, 40, 52);
      this.codeLetters[i].setText(this.codeArr[i]);
    }
    this.caret.setX(BOX_XS[this.activeBox]);
    this.joinBtn.setColor(this._codeComplete() ? C.text : C.dim);
  }

  _codeType(letter) {
    this.codeArr[this.activeBox] = letter;
    if (this.activeBox < 3) this.activeBox++;
    this._renderCode();
  }

  _codeBackspace() {
    // clear the last filled box
    let i = 3;
    while (i >= 0 && !this.codeArr[i]) i--;
    if (i >= 0) {
      this.codeArr[i] = '';
      this.activeBox = i;
    }
    this._renderCode();
  }

  _onPaste(e) {
    if (this.state !== 'join') return;
    const text = (e.clipboardData?.getData('text') || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (text.length >= 4) {
      this.codeArr = text.slice(0, 4).split('');
      this.activeBox = 3;
      this._renderCode();
    }
  }

  // ---------------- input ----------------

  _onKey(e) {
    if (this.state === 'join') {
      if (e.keyCode >= 65 && e.keyCode <= 90) this._codeType(e.key.toUpperCase());
      else if (e.keyCode === KC.BACKSPACE) this._codeBackspace();
      else if (e.keyCode === KC.ENTER) this._tryJoin();
      else if (e.keyCode === KC.ESC) this._applyState('menu');
      return;
    }
    if (this.state === 'settings' && this.editingName) {
      if (e.keyCode === KC.ENTER || e.keyCode === KC.ESC) this._commitNameEdit();
      else if (e.keyCode === KC.BACKSPACE) {
        this._editBuffer = this._editBuffer.slice(0, -1);
        this._refreshSettingsValues();
      } else if (/^[a-zA-Z0-9 ]$/.test(e.key) && this._editBuffer.length < NET.maxNameLen) {
        this._editBuffer += e.key;
        this._refreshSettingsValues();
      }
      return;
    }
    if (this.state === 'connecting' && e.keyCode === KC.ESC) this._cancel();
  }

  update() {
    // connecting-dots animation (§4.1)
    if (this.state === 'connecting') {
      const dots = '.'.repeat(Math.floor(this.time.now / UI.connectDotsMs) % 4);
      this.overlayStatus.setText(this._overlayBase + dots);
    }
    // caret blink (§3)
    if (this.state === 'join') {
      this.caret.setVisible(Math.floor(this.time.now / UI.caretBlinkMs) % 2 === 0);
      this.backHint.setText(InputManager.lastDevice === 'pad' ? STR.backHintPad : STR.backHintKb);
    }
    // name-row gamepad hint (§5)
    if (this.state === 'settings') {
      this.editHint.setVisible(!this.editingName && InputManager.lastDevice === 'pad' &&
        this.nav.index === 0);
    }
    this._updatePad();
    if (this.state === 'menu' || this.state === 'settings') this.nav.updatePad();
  }

  /** Gamepad handling for the non-nav states (join letter cycling §3,
   *  connecting cancel §4.1). */
  _updatePad() {
    const pad = this.input.gamepad?.getPad(0);
    if (!pad) return;
    const now = this.time.now;
    const P = this._pad;
    const sy = pad.leftStick ? pad.leftStick.y : 0;
    const sx = pad.leftStick ? pad.leftStick.x : 0;
    const vDir = (pad.down || sy > 0.5) ? 1 : (pad.up || sy < -0.5) ? -1 : 0;
    const hDir = (pad.right || sx > 0.5) ? 1 : (pad.left || sx < -0.5) ? -1 : 0;
    const a = !!pad.A, b = !!pad.B;
    const aEdge = a && !P.prev.a, bEdge = b && !P.prev.b;
    P.prev = { a, b };
    if (vDir || hDir || a || b) InputManager.lastDevice = 'pad';

    if (this.state === 'connecting') {
      if (bEdge) this._cancel();
      P.vDir = vDir; P.hDir = hDir;
      return;
    }
    if (this.state !== 'join') { P.vDir = vDir; P.hDir = hDir; return; }

    const repeat = (dir, key, fire) => {
      if (dir !== P[key + 'Dir']) {
        P[key + 'Dir'] = dir;
        if (dir) { fire(dir); P[key + 'Next'] = now + UI.focusRepeatDelayMs; }
      } else if (dir && now >= P[key + 'Next']) {
        fire(dir);
        P[key + 'Next'] = now + UI.focusRepeatMs;
      }
    };
    repeat(vDir, 'v', (dir) => {
      // cycle the active box letter A→Z with wrap (empty starts at 'A')
      const cur = this.codeArr[this.activeBox];
      const idx = cur ? cur.charCodeAt(0) - 65 : (dir > 0 ? -1 : 1);
      const next = ((idx + (dir > 0 ? 1 : -1)) % 26 + 26) % 26;
      this.codeArr[this.activeBox] = String.fromCharCode(65 + next);
      this._renderCode();
    });
    repeat(hDir, 'h', (dir) => {
      this.activeBox = Math.max(0, Math.min(3, this.activeBox + dir));
      this._renderCode();
    });
    if (aEdge) this._tryJoin();
    if (bEdge) this._applyState('menu');
  }
}
