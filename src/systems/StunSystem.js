// ============================================================
// StunSystem — stun timers, mash-to-recover, revive plumbing (plan WP2).
//
// Stuns never kill — they cost TIME. A stunned player is an inert
// 1.0-mass physics body: no input (MovementSystem feeds it nullInput),
// drops anything carried, CAN be grabbed/carried/thrown (CarrySystem)
// and revived by a teammate channel (InteractSystem).
// ============================================================

import { STUN } from '../config.js';
import { EV } from '../net/protocol.js';
import { dropCarried } from './CarrySystem.js';

/**
 * The one entry point for stunning a player — WP3 (grapple detach),
 * WP4 (monster/heavy-FF hits) and FallStunSystem all call this.
 * Stacking a stun onto a stunned player extends to the longer timer.
 */
export function applyStun(sim, player, ms, cause) {
  const s = player.state;
  if (s.stunned) {
    s.stunMsLeft = Math.max(s.stunMsLeft, ms);
    return;
  }
  s.stunned = true;
  s.stunMsLeft = ms;
  s.sprinting = false;
  s.channel = null;
  s.channelProgress = 0;
  dropCarried(sim, player); // carried teammate slips free
  sim.relicSys?.dropOnStun(sim, player); // hands → loose + burst; bag → secure (WP5)
  sim.stats.perSlot[s.slot].stuns++;
  sim.emit({ kind: EV.STUN, slot: s.slot, ms, cause });
}

/** Recovery — self (bySlot null) or teammate revive channel. */
export function revive(sim, player, bySlot) {
  const s = player.state;
  if (!s.stunned) return;
  s.stunned = false;
  s.stunMsLeft = 0;
  if (s.carriedBy !== null) {
    // Revived in someone's arms: they set you down.
    const carrier = sim.players.get(s.carriedBy);
    if (carrier) dropCarried(sim, carrier);
  }
  sim.emit({ kind: EV.REVIVE, slot: s.slot, by: bySlot });
}

export class StunSystem {
  update(sim, dt) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      if (!s.stunned) continue;
      // Mash to reduce: every fresh press of jump/attack/grab shaves time.
      const frame = sim.inputs[slot];
      if (frame && (frame.jump || frame.attack || frame.grab)) {
        s.stunMsLeft -= STUN.mashReduceMs;
      }
      s.stunMsLeft -= dt * 1000;
      if (s.stunMsLeft <= 0) revive(sim, p, null);
    }
  }
}
