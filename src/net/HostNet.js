// ============================================================
// HostNet — the host loop (plan §1).
//
// Accepts joiners, validates hello, assigns slot+token, handles
// tombstone rejoin, buffers the latest InputFrame per slot (edge-OR
// merged), broadcasts snapshots at 20 Hz via setInterval (less throttled
// than rAF in background tabs — plan risk 7), and broadcasts
// phase/roster/event messages on the reliable ctl channel.
//
// Emits on the provided emitter (the Phaser game-level EventEmitter):
//   'net:join'   {slot, name, rejoined}
//   'net:leave'  {slot, phase}    (slot freed in lobby, reserved in run)
//   'net:roster' {}               (after any roster change)
//   'net:phase'  {phase, data}    (host GameScene follows the SAME event
//                                  path as clients — one transition code path)
//   'net:closed' {reason}
// ============================================================

import { SnapshotInterpolation } from '@geckos.io/snapshot-interpolation';
import { NET } from '../config.js';
import { PeerTransport } from './PeerTransport.js';
import { PHASE } from './Session.js';
import {
  MSG, CH, EV, PROTOCOL_VERSION, REJECT,
  makeWelcome, makeReject, makeRoster, makePhase, makeEvent, makeSnap,
  makePing, makeKick, unpackInput, mergeInput, clearEdges,
} from './protocol.js';

// Give a reject/kick message time to flush before closing the connection.
const CLOSE_FLUSH_MS = 250;

export class HostNet {
  /**
   * @param {import('./Session.js').Session} session
   * @param {{emit: Function}} emitter Phaser game.events (or compatible)
   */
  constructor(session, emitter) {
    this.session = session;
    this.emitter = emitter;
    this.transport = new PeerTransport({
      onPeerConnected: (id) => this._onPeerConnected(id),
      onPeerDisconnected: (id) => this._onPeerLost(id),
      onMessage: (id, ch, msg) => this._onMessage(id, msg),
      onClosed: (reason) => this.emitter.emit('net:closed', { reason }),
    });

    // Snapshot factory only — the host never interpolates.
    this.si = new SnapshotInterpolation(NET.snapshotHz);

    /** Set by GameScene (host mode): () => serializeWorld(sim). */
    this.getState = null;

    /** Set by GameScene (host mode): () => buildReplay(sim) — the ordered
     *  event list reconstructing discrete world state for a rejoiner
     *  (doors/pickups/escalation/monsters), sent before SYNC_DONE. */
    this.getReplay = null;

    this.inputBuffers = [null, null, null, null];
    this.inputSeq = [-1, -1, -1, -1];

    this.lastSeen = new Map();   // peerId -> performance.now()
    this.helloTimers = new Map();
    this.snapTimer = null;
    this.hbTimer = null;
    this.closed = false;
  }

  /** Open the room. Resolves with the 4-letter code.
   *  @param {boolean} ffFull WP6: the host's friendly-fire preference —
   *  fixed at session creation, broadcast via welcome/roster. */
  async start(hostName, ffFull = false) {
    const code = await this.transport.host();
    this.session.initHost(code, hostName, ffFull);
    this.hbTimer = setInterval(() => this._heartbeat(), NET.heartbeatMs);
    this.snapTimer = setInterval(() => this._sendSnapshot(), 1000 / NET.snapshotHz);
    return code;
  }

  // ---------------- outbound API (GameScene / Session owners) ----------------

  /** The ONLY way host-owned phases change (plan §2.3). */
  setPhase(phase, data) {
    this.session.phase = phase;
    // Remembered so a peer that joins/rejoins DURING results gets the real
    // payload (welcome carries the phase but never its data) — otherwise the
    // client would have to invent a verdict, which plan risk 8 forbids.
    this.lastPhaseData = data || null;
    this.transport.broadcast(CH.CTL, makePhase(phase, data));
    this.emitter.emit('net:phase', { phase, data: data || null });
  }

  /** Broadcast one authoritative event ({kind, ...payload}) to all clients. */
  broadcastEvent(ev) {
    this.transport.broadcast(CH.CTL, makeEvent(ev));
  }

  broadcastRoster() {
    const r = this.session.rosterPayload();
    this.transport.broadcast(CH.CTL, makeRoster(r.players, r.ffFull, r.stageId));
    this.emitter.emit('net:roster', {});
  }

  /**
   * WP6: kick a joiner (host lobby verb — CLAUDE.md "Leader … can kick").
   * LOBBY-ONLY hard rule: a mid-run kick would collide with the tombstone
   * reservation contract (the kicked runner would keep a reclaimable
   * slot). Sends KICK, then closes after a flush window (mirrors _reject);
   * slot freeing + roster broadcast + 'net:leave' all ride the existing
   * _onPeerLost path when the connection drops.
   */
  kick(slot) {
    if (this.session.phase !== PHASE.LOBBY) return;
    const p = this.session.players[slot];
    if (!p || p.isHost || !p.connected || !p.peerId) return;
    const peerId = p.peerId; // capture: _onPeerLost may null it before the timer
    this.transport.send(peerId, CH.CTL, makeKick());
    setTimeout(() => this.transport.closePeer(peerId), CLOSE_FLUSH_MS);
  }

  /**
   * Freshest merged InputFrame for a slot (or null). Edge flags are
   * consumed once: cleared on the stored buffer after this read (§2.4).
   */
  consumeInput(slot) {
    const buffered = this.inputBuffers[slot];
    if (!buffered) return null;
    const frame = { ...buffered };
    clearEdges(buffered);
    return frame;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.hbTimer);
    clearInterval(this.snapTimer);
    for (const t of this.helloTimers.values()) clearTimeout(t);
    this.helloTimers.clear();
    this.transport.close();
  }

  // ---------------- transport handlers ----------------

  _onPeerConnected(peerId) {
    this.lastSeen.set(peerId, performance.now());
    // A connection that never says hello gets dropped.
    this.helloTimers.set(peerId, setTimeout(() => {
      this.helloTimers.delete(peerId);
      this.transport.closePeer(peerId);
    }, NET.helloTimeoutMs));
  }

  _onPeerLost(peerId) {
    this.lastSeen.delete(peerId);
    clearTimeout(this.helloTimers.get(peerId));
    this.helloTimers.delete(peerId);

    const slot = this.session.slotByPeer(peerId);
    if (slot === -1) return; // never got past hello
    // WP6 contract W13: capture the name BEFORE freeSlot — the host's
    // "<NAME> LEFT" toast would otherwise see an already-freed row.
    const name = this.session.players[slot]?.name ?? null;
    if (this.session.phase === PHASE.PLAYING || this.session.phase === PHASE.RESULTS) {
      // Slot stays reserved for tombstone rejoin (plan §2.6).
      this.session.markDisconnected(slot);
    } else {
      this.session.freeSlot(slot);
    }
    this.inputBuffers[slot] = null;
    this.inputSeq[slot] = -1;
    this.broadcastRoster();
    this.emitter.emit('net:leave', { slot, phase: this.session.phase, name });
  }

  _onMessage(peerId, msg) {
    this.lastSeen.set(peerId, performance.now());
    switch (msg.t) {
      case MSG.HELLO: return this._onHello(peerId, msg);
      case MSG.INPUT: return this._onInput(peerId, msg);
      case MSG.BYE: return this.transport.closePeer(peerId);
      case MSG.PING: return; // liveness only — lastSeen already updated
    }
  }

  _onHello(peerId, msg) {
    clearTimeout(this.helloTimers.get(peerId));
    this.helloTimers.delete(peerId);

    if (msg.v !== PROTOCOL_VERSION) return this._reject(peerId, REJECT.VERSION);
    if (this.session.slotByPeer(peerId) !== -1) return; // duplicate hello

    const name = String(msg.name || 'Rogue').slice(0, NET.maxNameLen);
    const claim = this.session.claimSlot(name, msg.token || null, peerId);
    if (claim.reject) return this._reject(peerId, claim.reject);
    // Token takeover: the slot's peerId already points at the new peer,
    // so the stale link's close callback resolves to no slot (no-op) —
    // which also means _onPeerLost never clears the slot's input state.
    if (claim.evictPeer) this.transport.closePeer(claim.evictPeer);

    // Fresh transport = fresh seq counter. Without this reset a fast
    // token-takeover rejoin keeps the OLD high-water seq and every input
    // frame from the new link (restarting at 0) is dropped as stale —
    // the rejoined player would be frozen for minutes.
    this.inputSeq[claim.slot] = -1;
    this.inputBuffers[claim.slot] = null;

    const r = this.session.rosterPayload();
    this.transport.send(peerId, CH.CTL, makeWelcome(
      claim.slot, claim.token, this.session.phase, r.players, r.ffFull, r.stageId,
    ));

    // World replay (plan risk 9) for EVERY accepted joiner — rejoiners
    // need live monsters/doors/escalation, and even a fresh lobby joiner
    // needs prior discrete state (smashed practice door, dead dummy).
    // Discrete state goes as ordered ctl events then the terminator;
    // ClientNet buffers the burst until the GameScene attaches. Replay
    // events are idempotent on the client (existence-checked handlers).
    for (const ev of (this.getReplay ? this.getReplay() : [])) {
      this.transport.send(peerId, CH.CTL, makeEvent(ev));
    }
    this.transport.send(peerId, CH.CTL, makeEvent({ kind: EV.SYNC_DONE }));
    // Results-phase join: replay the phase message so the newcomer renders
    // the real ResultsPayload instead of an empty screen (welcome carries
    // only the phase name). Ordered ctl → arrives after the world replay.
    if (this.session.phase === PHASE.RESULTS && this.lastPhaseData) {
      this.transport.send(peerId, CH.CTL, makePhase(PHASE.RESULTS, this.lastPhaseData));
    }
    if (claim.rejoined && this.session.phase !== PHASE.LOBBY) {
      this.broadcastEvent({ kind: EV.REJOINED, slot: claim.slot });
    }

    this.broadcastRoster();
    this.emitter.emit('net:join', { slot: claim.slot, name, rejoined: claim.rejoined });
  }

  _onInput(peerId, msg) {
    const slot = this.session.slotByPeer(peerId);
    if (slot === -1) return;
    if (typeof msg.seq !== 'number' || msg.seq <= this.inputSeq[slot]) return; // stale/dup
    this.inputSeq[slot] = msg.seq;
    let frame;
    try {
      frame = unpackInput(msg.f);
    } catch (_) { return; }
    this.inputBuffers[slot] = mergeInput(this.inputBuffers[slot], frame);
  }

  _reject(peerId, reason) {
    this.transport.send(peerId, CH.CTL, makeReject(reason));
    setTimeout(() => this.transport.closePeer(peerId), CLOSE_FLUSH_MS);
  }

  // ---------------- timers ----------------

  _sendSnapshot() {
    if (!this.getState) return;
    const phase = this.session.phase;
    if (phase !== PHASE.LOBBY && phase !== PHASE.PLAYING) return;
    const snap = this.si.snapshot.create(this.getState());
    this.transport.broadcast(CH.ST, makeSnap(snap));
  }

  _heartbeat() {
    this.transport.broadcast(CH.CTL, makePing());
    const now = performance.now();
    for (const [peerId, seen] of this.lastSeen) {
      if (now - seen > NET.heartbeatTimeoutMs) this.transport.closePeer(peerId);
    }
  }
}
