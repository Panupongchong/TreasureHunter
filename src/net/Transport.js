// ============================================================
// Transport — the network seam (CLAUDE.md locked decision).
//
// All game code talks to this interface only. The prototype implements it
// with PeerJS (net/PeerTransport.js); the Steam release will implement it
// with Steam Networking. Nothing outside net/ may import peerjs directly.
//
// Model (host-authoritative):
//   - two logical channels per host<->joiner pair:
//       'ctl' reliable+ordered  (hello/welcome/roster/phase/event/kick)
//       'st'  unreliable        (input up, snapshots down)
//   - joiner:  send InputFrames up, receive world snapshots down
//   - host:    receive InputFrames, simulate, broadcast snapshots ~20 Hz
//   - client rendering uses @geckos.io/snapshot-interpolation (~100ms buffer)
//   - NO client-side prediction in v1 (locked decision)
//   - reconnect: tombstone system keyed by per-run player token
// ============================================================

export class Transport {
  /**
   * @param {{
   *   onPeerConnected?: (peerId: string) => void,   // host: joiner has both channels open
   *   onPeerDisconnected?: (peerId: string) => void,// host: joiner gone (either channel closed)
   *   onMessage?: (peerId: string, channel: 'ctl'|'st', msg: object) => void,
   *   onClosed?: (reason: string) => void,          // client: host/link gone. host: transport dead
   * }} handlers
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.isHost = false;
    this.roomCode = null;
  }

  /** Host a room. Resolves with the 4-letter room code. */
  async host() {
    throw new Error('Transport.host: abstract');
  }

  /** Join a room by code. Resolves when both channels to the host are open. */
  async join(code) {
    throw new Error('Transport.join: abstract');
  }

  /** Send one message. Host: peerId targets a joiner. Client: peerId ignored (goes to host). */
  send(peerId, channel, msg) {
    throw new Error('Transport.send: abstract');
  }

  /** Host only: send to every connected joiner. */
  broadcast(channel, msg) {
    throw new Error('Transport.broadcast: abstract');
  }

  /** Host only: forcibly drop one joiner (kick / heartbeat timeout). */
  closePeer(peerId) {}

  /** Tear the whole transport down. Safe to call twice. */
  close() {}
}
