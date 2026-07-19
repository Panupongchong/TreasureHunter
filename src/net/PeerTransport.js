// ============================================================
// PeerTransport — PeerJS implementation of the Transport seam.
//
// Owns the Peer object and the TWO DataConnections per host<->joiner pair
// (labels 'ctl' reliable / 'st' unreliable, both serialization:'json').
// Host peer ID = 'pfproto-' + 4 uppercase letters. Joiner IDs are random.
//
// NOTHING outside net/ imports peerjs.
// ============================================================

import { Peer } from 'peerjs';
import { NET } from '../config.js';
import { Transport } from './Transport.js';
import { CH, makeRoomCode } from './protocol.js';

const HOST_ID_RETRIES = 5;

export class PeerTransport extends Transport {
  constructor(handlers = {}) {
    super(handlers);
    this.peer = null;
    /** host: peerId -> { ctl, st, connected } ; client: single entry under 'host' */
    this.links = new Map();
    this.closed = false;
  }

  // ---------------- host ----------------

  /** Create the room. Retries on code collision. Resolves with the code. */
  async host() {
    this.isHost = true;
    let lastErr = null;
    for (let attempt = 0; attempt < HOST_ID_RETRIES; attempt++) {
      const code = makeRoomCode();
      try {
        this.peer = await this._openPeer(NET.peerIdPrefix + code);
        this.roomCode = code;
        this._wireHostPeer();
        return code;
      } catch (err) {
        lastErr = err;
        if (err && err.type === 'unavailable-id') continue; // collision — new code
        throw err;
      }
    }
    throw lastErr || new Error('could not allocate a room code');
  }

  _wireHostPeer() {
    this.peer.on('connection', (conn) => this._onIncoming(conn));
    this.peer.on('disconnected', () => {
      // Broker link lost. Existing WebRTC links keep working; try to get the
      // broker back so future joiners/rejoiners can still find the room.
      if (!this.closed && this.peer && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (_) { /* best-effort */ }
      }
    });
    this.peer.on('error', (err) => {
      // Fatal peer errors (network/server) kill the transport.
      if (err && (err.type === 'network' || err.type === 'server-error' ||
                  err.type === 'socket-error' || err.type === 'socket-closed')) {
        // Non-fatal for established WebRTC links; ignore unless nothing works.
      }
    });
  }

  _onIncoming(conn) {
    if (this.closed) { try { conn.close(); } catch (_) {} return; }
    const peerId = conn.peer;
    let link = this.links.get(peerId);
    if (!link) {
      link = { ctl: null, st: null, connected: false, timer: null };
      this.links.set(peerId, link);
      // If the second channel never arrives, drop the half-open link.
      link.timer = setTimeout(() => {
        if (!link.connected) this._dropLink(peerId, 'half-open');
      }, NET.joinTimeoutMs);
    }
    if (conn.label !== CH.CTL && conn.label !== CH.ST) {
      try { conn.close(); } catch (_) {}
      return;
    }
    link[conn.label] = conn;

    conn.on('open', () => this._maybeLinkReady(peerId));
    conn.on('data', (data) => {
      if (data && typeof data === 'object') {
        this.handlers.onMessage?.(peerId, conn.label, data);
      }
    });
    conn.on('close', () => this._dropLink(peerId, 'closed'));
    conn.on('error', () => this._dropLink(peerId, 'error'));
    // Some browsers only fire iceStateChanged on abrupt loss.
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this._dropLink(peerId, 'ice-' + state);
      }
    });
  }

  _maybeLinkReady(peerId) {
    const link = this.links.get(peerId);
    if (!link || link.connected) return;
    if (link.ctl?.open && link.st?.open) {
      link.connected = true;
      clearTimeout(link.timer);
      this.handlers.onPeerConnected?.(peerId);
    }
  }

  _dropLink(peerId, _reason) {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    clearTimeout(link.timer);
    for (const ch of [link.ctl, link.st]) {
      try { ch?.close(); } catch (_) {}
    }
    if (this.isHost) {
      if (link.connected) this.handlers.onPeerDisconnected?.(peerId);
    } else if (!this.closed) {
      // Client: losing either channel to the host means the session is over.
      this.closed = true;
      this.handlers.onClosed?.('host-gone');
    }
  }

  // ---------------- client ----------------

  /** Join a room by 4-letter code. Resolves once both channels are open. */
  async join(code) {
    this.isHost = false;
    this.roomCode = code.toUpperCase();
    const hostId = NET.peerIdPrefix + this.roomCode;
    this.peer = await this._openPeer(undefined); // random id

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(Object.assign(new Error('join failed: ' + reason), { reason }));
      };
      const timer = setTimeout(() => fail('timeout'), NET.joinTimeoutMs);

      this.peer.on('error', (err) => {
        if (err && err.type === 'peer-unavailable') fail('bad-code');
        else if (!settled) fail(err?.type || 'peer-error');
      });

      const link = { ctl: null, st: null, connected: false, timer: null };
      this.links.set('host', link);

      const wire = (label, opts) => {
        const conn = this.peer.connect(hostId, opts);
        link[label] = conn;
        conn.on('open', () => {
          if (link.ctl?.open && link.st?.open && !settled) {
            settled = true;
            link.connected = true;
            clearTimeout(timer);
            resolve();
          }
        });
        conn.on('data', (data) => {
          if (data && typeof data === 'object') {
            this.handlers.onMessage?.('host', label, data);
          }
        });
        conn.on('close', () => {
          if (!settled) fail('closed');
          else this._dropLink('host', 'closed');
        });
        conn.on('error', () => {
          if (!settled) fail('conn-error');
          else this._dropLink('host', 'error');
        });
        conn.on('iceStateChanged', (state) => {
          if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            if (!settled) fail('ice-' + state);
            else this._dropLink('host', 'ice-' + state);
          }
        });
      };

      wire(CH.CTL, { label: CH.CTL, reliable: true, serialization: 'json' });
      wire(CH.ST, { label: CH.ST, reliable: false, serialization: 'json' });
    });
  }

  // ---------------- common ----------------

  _openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id === undefined ? new Peer() : new Peer(id);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { peer.destroy(); } catch (_) {}
          reject(Object.assign(new Error('broker timeout'), { type: 'broker-timeout' }));
        }
      }, NET.joinTimeoutMs);
      peer.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch (_) {}
        reject(err);
      });
    });
  }

  /** @override Host: peerId targets a joiner; client: peerId ignored. */
  send(peerId, channel, msg) {
    const link = this.links.get(this.isHost ? peerId : 'host');
    const conn = link?.[channel];
    if (conn?.open) {
      try { conn.send(msg); } catch (_) { /* transient — heartbeats will reap */ }
    }
  }

  /** @override */
  broadcast(channel, msg) {
    for (const [peerId, link] of this.links) {
      if (!link.connected) continue;
      const conn = link[channel];
      if (conn?.open) {
        try { conn.send(msg); } catch (_) {}
      }
    }
  }

  /** @override */
  closePeer(peerId) {
    this._dropLink(peerId, 'kicked');
  }

  /** @override */
  close() {
    if (this.closed && !this.peer) return;
    this.closed = true;
    for (const [, link] of this.links) {
      clearTimeout(link.timer);
      for (const ch of [link.ctl, link.st]) {
        try { ch?.close(); } catch (_) {}
      }
    }
    this.links.clear();
    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }
  }
}
