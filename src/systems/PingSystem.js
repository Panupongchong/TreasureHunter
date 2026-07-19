// ============================================================
// PingSystem — the 8th verb (CLAUDE.md: "ping (marker)"; Q / R3).
//
// Host/solo only, registered LAST in the system list (reads inputs,
// emits an event, order-insensitive). NO phase gate — pinging in the
// lobby is practice. Works identically in host and solo modes.
//
// Marker point = the AIM POINT (ux-spec §7.8, the standing UI
// authority): mouse aim is already world px on the wire; gamepad aim
// is a unit dir → project PING.gamepadDist px from the player (facing
// fallback on a neutral stick). Clamped to the map. Documented
// fallback if playtests show mis-pings: use the player position
// (one-line change below).
//
// EV.PING_MARKER {slot, x, y} rides the normal drain (ordered ctl).
// Pings are transient: never in snapshots, never in buildReplay.
// Cooldown PING.cooldownMs per slot, host-validated.
// ============================================================

import { PING } from '../config.js';
import { EV } from '../net/protocol.js';

export class PingSystem {
  constructor() {
    this._lastPingAt = [-Infinity, -Infinity, -Infinity, -Infinity];
  }

  update(sim) {
    const now = performance.now();
    for (const [slot, p] of sim.players) {
      const f = sim.inputFor(slot);
      // Stunned: ALL action inputs are ignored (ux-spec §7.4).
      if (!f.ping || p.state.stunned) continue;
      if (now - this._lastPingAt[slot] < PING.cooldownMs) continue;
      this._lastPingAt[slot] = now;

      let x, y;
      if (f.usingGamepad) {
        let dx = f.aimX, dy = f.aimY; // unit dir on the wire (plan §2.5)
        if (dx === 0 && dy === 0) { dx = p.state.facing; dy = 0; } // neutral stick
        x = p.x + dx * PING.gamepadDist;
        y = p.y + dy * PING.gamepadDist;
      } else {
        x = f.aimX; // mouse: world px already
        y = f.aimY;
      }
      const map = sim.scene.map;
      x = Math.max(0, Math.min(map.width, x));
      y = Math.max(0, Math.min(map.height, y));

      sim.emit({ kind: EV.PING_MARKER, slot, x: Math.round(x), y: Math.round(y) });
    }
  }
}
