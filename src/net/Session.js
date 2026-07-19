// ============================================================
// Session — roster + phase state machine, shared by host & client.
//
// Host MUTATES it (HostNet is the only writer of host-owned phases);
// clients MIRROR it from welcome/roster/phase messages — never
// speculatively (plan §2.3).
//
// Slot entries: { slot, name, connected, isHost } on every peer, plus
// host-only bookkeeping { token, peerId } that never goes on the wire
// (rosterPayload strips it).
// ============================================================

import { NET } from '../config.js';
import { makeToken, REJECT } from './protocol.js';

export const PHASE = {
  MENU: 'menu',             // local-only
  CONNECTING: 'connecting', // local-only
  LOBBY: 'lobby',           // host-owned from here down
  PLAYING: 'playing',
  RESULTS: 'results',
};

export class Session {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = PHASE.MENU;
    this.isHost = false;
    this.roomCode = null;
    this.localSlot = -1;
    /** @type {Array<object|null>} index = slot */
    this.players = [null, null, null, null];
    this.ffFull = false;
    this.stageId = 'test';
  }

  // ---------------- host side ----------------

  /** WP6 invariant: ffFull is written exactly ONCE, here at init (the
   *  host's localStorage preference) — there is no mutation vector after
   *  that, so "applies in lobby, never mid-run" holds by construction.
   *  Clients only ever mirror it (applyWelcome/applyRoster). */
  initHost(roomCode, name, ffFull = false) {
    this.reset();
    this.isHost = true;
    this.roomCode = roomCode;
    this.localSlot = 0;
    this.phase = PHASE.LOBBY;
    this.ffFull = !!ffFull;
    this.players[0] = {
      slot: 0, name, connected: true, isHost: true,
      token: makeToken(), peerId: null,
    };
  }

  /** Solo practice: a one-player local session, no transport. */
  initSolo(name, ffFull = false) {
    this.reset();
    this.isHost = true; // authoritative locally (Sim runs)
    this.localSlot = 0;
    this.phase = PHASE.LOBBY;
    this.ffFull = !!ffFull;
    this.players[0] = {
      slot: 0, name, connected: true, isHost: true,
      token: null, peerId: null,
    };
  }

  /**
   * Resolve a hello into a slot (plan §2.6).
   * @returns {{slot, token, rejoined} | {reject: string}}
   */
  claimSlot(name, token, peerId) {
    if (token) {
      const p = this.players.find((p) => p && p.token === token && !p.isHost);
      if (p) {
        // If the old link hasn't been reaped yet (tab refresh beats the
        // heartbeat timeout), the token proves identity — take the slot
        // over and let HostNet evict the stale peer.
        const evictPeer = p.connected ? p.peerId : null;
        p.connected = true;
        p.peerId = peerId;
        if (name) p.name = name;
        return { slot: p.slot, token, rejoined: true, evictPeer };
      }
    }
    // Fresh join (or a token we don't know): only allowed in the lobby.
    if (this.phase !== PHASE.LOBBY) return { reject: REJECT.IN_RUN };
    const slot = this.players.findIndex((p) => p === null);
    if (slot === -1) return { reject: REJECT.FULL };
    this.players[slot] = {
      slot, name, connected: true, isHost: false,
      token: makeToken(), peerId,
    };
    return { slot, token: this.players[slot].token, rejoined: false };
  }

  slotByPeer(peerId) {
    const p = this.players.find((p) => p && p.peerId === peerId);
    return p ? p.slot : -1;
  }

  /** Playing: slot stays reserved (tombstone rejoin). */
  markDisconnected(slot) {
    const p = this.players[slot];
    if (!p) return;
    p.connected = false;
    p.peerId = null;
  }

  /** Lobby: slot is simply freed. */
  freeSlot(slot) {
    this.players[slot] = null;
  }

  /**
   * WP6, host-only: free every disconnected slot. Called on the
   * results → lobby transition — tombstone reservation is a MID-RUN
   * contract ("reconnect to the same room during the run", CLAUDE.md);
   * returning to lobby ends the run, so reservations expire. Without
   * this, ghost connected:false rows would eat slots forever and block
   * fresh joins. (The host is never disconnected on the host.)
   */
  purgeDisconnected() {
    for (let slot = 0; slot < this.players.length; slot++) {
      const p = this.players[slot];
      if (p && !p.connected) this.players[slot] = null;
    }
  }

  /** Wire-safe roster (host-only fields stripped). */
  rosterPayload() {
    return {
      players: this.players.filter(Boolean).map(({ slot, name, connected, isHost }) =>
        ({ slot, name, connected, isHost })),
      ffFull: this.ffFull,
      stageId: this.stageId,
    };
  }

  // ---------------- client side ----------------

  applyWelcome(msg, roomCode) {
    this.isHost = false;
    this.roomCode = roomCode;
    this.localSlot = msg.slot;
    this.phase = msg.phase;
    this._applyRosterList(msg.roster);
    this.ffFull = msg.ffFull;
    this.stageId = msg.stageId;
  }

  applyRoster(msg) {
    this._applyRosterList(msg.players);
    this.ffFull = msg.ffFull;
    this.stageId = msg.stageId;
  }

  _applyRosterList(list) {
    this.players = [null, null, null, null];
    for (const p of list || []) {
      if (p.slot >= 0 && p.slot < NET.maxPlayers) this.players[p.slot] = { ...p };
    }
  }

  // ---------------- queries (both sides) ----------------

  connectedPlayers() {
    return this.players.filter((p) => p && p.connected);
  }

  allPlayers() {
    return this.players.filter(Boolean);
  }
}
