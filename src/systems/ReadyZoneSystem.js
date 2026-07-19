// ============================================================
// ReadyZoneSystem — lobby only (plan §1 / WP6): "Ready = everyone
// stands in the vault-entrance zone 3 s" (CLAUDE.md, locked; the 3 s
// lives in config READY.holdMs).
//
// Registered unconditionally in host/solo mode AFTER InteractSystem,
// BEFORE ClockSystem (plan §3.2 group 9); self-gates on phase + map.
//
// Fill progress is continuous → it rides the snapshot world row
// (rz 0..100, rzN inside-count, rzM connected-total — see
// sim/snapshot.js); completion is discrete → EV.READY_COMPLETE, which
// the host/solo GameScene intercepts in the event drain and maps to
// the lobby → playing phase transition (the same seam as RUN_OVER).
// Clients render the ring purely from rz/rzN/rzM + map.readyZone
// geometry — no gameplay logic (plan risk 8).
//
// Zone membership is POSITION-ONLY: a stunned body parked inside still
// counts (tunable decision — the zone reads "everyone stands here";
// flagged in the WP6 spec §1).
// ============================================================

import { READY } from '../config.js';
import { EV } from '../net/protocol.js';
import { PHASE } from '../net/Session.js';

export class ReadyZoneSystem {
  init(sim) {
    sim.world.readyMs = 0;
    sim.world.readyN = 0;
    sim.world.readyM = 0;
    // Latch: prevents re-fire during the transition frame(s) between
    // READY_COMPLETE and the scene restart into 'playing'.
    sim.world.readyLatched = false;
    this._prevM = -1; // host-only scratch, never serialized
  }

  update(sim, dt) {
    const zone = sim.scene.map.readyZone;
    if (sim.session.phase !== PHASE.LOBBY || !zone || sim.world.readyLatched) {
      sim.world.readyMs = 0;
      sim.world.readyN = 0;
      sim.world.readyM = 0;
      return;
    }

    const m = sim.session.connectedPlayers().length;
    let n = 0;
    for (const [slot, p] of sim.players) {
      if (!sim.session.players[slot]?.connected) continue;
      if (p.x >= zone.x && p.x <= zone.x + zone.w &&
          p.y >= zone.y && p.y <= zone.y + zone.h) {
        n++;
      }
    }

    // A roster-size change resets INSTANTLY, even if all survivors are
    // inside (ux-spec §6.4: a disconnect changing m cancels the fill).
    if (m !== this._prevM) {
      sim.world.readyMs = 0;
      this._prevM = m;
    }

    if (n === m && m >= 1) sim.world.readyMs += dt * 1000;
    else sim.world.readyMs = 0;

    sim.world.readyN = n;
    sim.world.readyM = m;

    if (sim.world.readyMs >= READY.holdMs) {
      sim.world.readyLatched = true;
      sim.emit({ kind: EV.READY_COMPLETE });
    }
  }
}
