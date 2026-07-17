// ============================================================
// Transport — the network seam (CLAUDE.md, build step 3 — NOT YET WIRED).
//
// All game code talks to this interface only. The prototype implements it
// with PeerJS; the Steam release will implement it with Steam Networking.
// Nothing outside this folder may import peerjs directly.
//
// Planned model (host-authoritative):
//   - joiner:  send InputFrames up, receive world snapshots down
//   - host:    receive InputFrames, simulate, broadcast snapshots ~20 Hz
//   - client rendering uses @geckos.io/snapshot-interpolation (~100ms buffer)
//   - NO client-side prediction in v1 (locked decision)
//   - reconnect: tombstone system keyed by per-run player token
// ============================================================

export class Transport {
  /** @param {{ onMessage: Function, onPeerJoin: Function, onPeerLeave: Function }} handlers */
  constructor(handlers) {
    this.handlers = handlers;
    this.isHost = false;
    this.roomCode = null;
  }

  /** Host a room. Resolves with the room code. */
  async host() {
    throw new Error('Transport.host: not implemented yet (build step 3)');
  }

  /** Join a room by code. */
  async join(code) {
    throw new Error('Transport.join: not implemented yet (build step 3)');
  }

  /** Send to host (as joiner) or broadcast (as host). */
  send(msg) {
    throw new Error('Transport.send: not implemented yet (build step 3)');
  }

  close() {}
}
