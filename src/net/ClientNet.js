// ============================================================
// ClientNet — the client loop (plan §1).
//
// Sends hello + input frames (30 Hz, edge-OR coalesced so a jump edge
// sampled at 60 Hz is never lost — plan §2.4), feeds snapshots into the
// Interpolator, and surfaces phase/roster/event messages to the scenes
// via the provided emitter:
//   'net:roster' {}
//   'net:phase'  {phase, data}
//   'net:event'  {kind, ...payload}
//   'net:closed' {reason}        (host gone / kicked / heartbeat timeout)
// ============================================================

import { NET } from '../config.js';
import { PeerTransport } from './PeerTransport.js';
import { Interpolator } from './Interpolator.js';
import {
  MSG, CH, PROTOCOL_VERSION,
  makeHello, makeInput, makeBye, makePing,
  packInput, mergeInput, tokenStorageKey, LAST_ROOM_KEY,
} from './protocol.js';

export class ClientNet {
  /**
   * @param {import('./Session.js').Session} session
   * @param {{emit: Function}} emitter Phaser game.events (or compatible)
   */
  constructor(session, emitter) {
    this.session = session;
    this.emitter = emitter;
    this.transport = new PeerTransport({
      onMessage: (peerId, ch, msg) => this._onMessage(msg),
      onClosed: (reason) => this._onClosed(reason),
    });
    this.interpolator = new Interpolator();

    this._pendingJoin = null; // {resolve, reject, timer}
    this._sceneAttached = false;
    this._eventBacklog = []; // world events buffered while no scene listens
    this._outFrame = null;    // edge-OR coalesced frame awaiting the 30 Hz send
    this._seq = 0;
    this._hostLastSeen = 0;
    /** performance.now() of the last received snapshot — the UI half's
     *  "WAITING FOR HOST…" starvation notice (ux-spec §7.11) polls this.
     *  0 until the first snap arrives. */
    this.lastSnapAt = 0;
    this._inputTimer = null;
    this._hbTimer = null;
    this.closed = false;
  }

  /**
   * Join a room and complete the hello/welcome handshake.
   * Resolves with the welcome message; rejects with err.reason set to a
   * REJECT.* value, 'bad-code', or 'timeout'.
   */
  async join(code, name) {
    const roomCode = code.toUpperCase();
    const token = sessionStorage.getItem(tokenStorageKey(roomCode));
    await this.transport.join(roomCode);
    this._hostLastSeen = performance.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingJoin = null;
        this.close();
        reject(Object.assign(new Error('no welcome'), { reason: 'timeout' }));
      }, NET.joinTimeoutMs);
      this._pendingJoin = { resolve, reject, timer, roomCode };
      this.transport.send('host', CH.CTL, makeHello(name, token));
    });
  }

  /**
   * Called every render frame by GameScene (client mode). Edges are OR-ed
   * into the pending frame; analog/held values take the newest sample.
   */
  pushFrame(frame) {
    this._outFrame = mergeInput(this._outFrame, frame);
  }

  /** Fresh interpolation buffer (used across phase/scene restarts). */
  resetInterpolation() {
    this.interpolator = new Interpolator();
  }

  /**
   * GameScene.create (client mode) calls this AFTER registering its
   * 'net:event' handler: live delivery resumes and the backlog that
   * accumulated while no scene listened is returned for the scene to
   * apply in order. detachScene() on shutdown re-opens the buffer so
   * events during a phase restart aren't lost either.
   */
  attachScene() {
    this._sceneAttached = true;
    const backlog = this._eventBacklog;
    this._eventBacklog = [];
    return backlog;
  }

  detachScene() {
    this._sceneAttached = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._inputTimer);
    clearInterval(this._hbTimer);
    // Settle a join still in flight (menu Cancel). transport.close() sets
    // closed=true before the channel-close events, so _onClosed never runs
    // and the join timer would otherwise fire up to joinTimeoutMs later —
    // stomping the UI of whatever attempt the player started in between.
    if (this._pendingJoin) {
      const pending = this._pendingJoin;
      this._pendingJoin = null;
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' }));
    }
    try { this.transport.send('host', CH.CTL, makeBye()); } catch (_) {}
    this.transport.close();
  }

  // ---------------- inbound ----------------

  _onMessage(msg) {
    this._hostLastSeen = performance.now();
    switch (msg.t) {
      case MSG.WELCOME: return this._onWelcome(msg);
      case MSG.REJECT: return this._onReject(msg);
      case MSG.ROSTER:
        this.session.applyRoster(msg);
        return this.emitter.emit('net:roster', {});
      case MSG.PHASE:
        this.session.phase = msg.phase;
        return this.emitter.emit('net:phase', { phase: msg.phase, data: msg.data });
      case MSG.EVENT:
        // World events (incl. the rejoin replay burst) arrive on ordered
        // ctl the instant welcome resolves — BEFORE the GameScene exists
        // to listen (scene.start only queues; create() runs next game
        // step). Buffer until a scene attaches or the replay is lost:
        // invisible monsters, intact-looking broken doors (plan risk 9).
        if (!this._sceneAttached) {
          this._eventBacklog.push(msg);
          return;
        }
        return this.emitter.emit('net:event', msg);
      case MSG.SNAP:
        this.lastSnapAt = performance.now();
        return this.interpolator.addSnapshot(msg.s);
      case MSG.KICK:
        // A kicked player must NOT be offered "[ REJOIN LAST ROOM ]" for
        // this room — burn the stored credential before tearing down.
        try {
          if (this.session.roomCode) {
            sessionStorage.removeItem(tokenStorageKey(this.session.roomCode));
          }
          sessionStorage.removeItem(LAST_ROOM_KEY);
        } catch (_) { /* private mode */ }
        return this._onClosed('kicked');
      case MSG.PING:
        return; // liveness only
    }
  }

  _onWelcome(msg) {
    const pending = this._pendingJoin;
    if (!pending) return;
    this._pendingJoin = null;
    clearTimeout(pending.timer);

    this.session.applyWelcome(msg, pending.roomCode);
    this.transport.roomCode = pending.roomCode;
    try {
      sessionStorage.setItem(tokenStorageKey(pending.roomCode), msg.token);
      sessionStorage.setItem(LAST_ROOM_KEY, pending.roomCode); // menu rejoin shortcut
    } catch (_) { /* private mode — rejoin just won't survive a refresh */ }

    this._inputTimer = setInterval(() => this._sendInput(), 1000 / NET.inputHz);
    this._hbTimer = setInterval(() => this._heartbeat(), NET.heartbeatMs);
    pending.resolve(msg);
  }

  _onReject(msg) {
    const pending = this._pendingJoin;
    this._pendingJoin = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('rejected: ' + msg.reason), { reason: msg.reason }));
    }
    this.close();
  }

  _onClosed(reason) {
    if (this._pendingJoin) {
      const pending = this._pendingJoin;
      this._pendingJoin = null;
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('closed: ' + reason), { reason }));
    }
    if (!this.closed) {
      this.closed = true;
      clearInterval(this._inputTimer);
      clearInterval(this._hbTimer);
      this.transport.close();
      this.emitter.emit('net:closed', { reason });
    }
  }

  // ---------------- timers ----------------

  _sendInput() {
    if (!this._outFrame) return;
    this.transport.send('host', CH.ST, makeInput(this._seq++, packInput(this._outFrame)));
    this._outFrame = null;
  }

  _heartbeat() {
    this.transport.send('host', CH.CTL, makePing());
    if (performance.now() - this._hostLastSeen > NET.heartbeatTimeoutMs) {
      this._onClosed('timeout');
    }
  }
}
