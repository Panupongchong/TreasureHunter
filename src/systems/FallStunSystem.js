// ============================================================
// FallStunSystem — falls beyond safe height stun (plan WP2).
//
// safeHeight = base / mass (heavier bodies stun sooner). Fall distance
// is tracked from where the descent STARTED (apex), not the jump-off
// point. Landing on a teammate splits the impact — both briefly
// stunned, shorter than a full fall stun. Grappling mid-fall calls
// cancelFor (WP3) to wipe the tracked fall.
// ============================================================

import { STUN, NOISE } from '../config.js';
import { EV } from '../net/protocol.js';
import { applyStun } from './StunSystem.js';
import { addNoise } from './NoiseSystem.js';

const FALL_VY_MIN = 40; // px/s downward before we call it "falling"

export class FallStunSystem {
  update(sim) {
    for (const [, p] of sim.players) {
      const s = p.state;
      const body = p.body;
      if (!body.enable) { // carried: no falls while in someone's arms
        s.fallStartY = null;
        continue;
      }
      const onGround = body.blocked.down || s.standingOnSlot !== null;
      if (!onGround) {
        if (s.fallStartY === null && body.velocity.y > FALL_VY_MIN) {
          s.fallStartY = p.y;
        }
        continue;
      }
      if (s.fallStartY === null) continue;

      const dist = p.y - s.fallStartY;
      s.fallStartY = null;
      // WP4: hard landings make noise — fires for hard-but-safe AND
      // stunning landings (threshold = safeHeight * hardLandingFrac).
      if (dist > (STUN.baseSafeFallHeight / s.mass) * NOISE.hardLandingFrac) {
        addNoise(sim, p.x, p.y, NOISE.hardLanding, 'landing', s.slot);
        sim.emit({ kind: EV.HARD_LANDING, slot: s.slot, x: Math.round(p.x), y: Math.round(p.y) });
      }
      if (dist <= STUN.baseSafeFallHeight / s.mass || s.stunned) continue;

      if (s.standingOnSlot !== null) {
        // Landed on a teammate: split impact, both briefly stunned.
        const cushion = sim.players.get(s.standingOnSlot);
        applyStun(sim, p, STUN.splitStunMs, 'fall-split');
        if (cushion && !cushion.state.stunned) {
          applyStun(sim, cushion, STUN.splitStunMs, 'fall-split');
        }
      } else {
        applyStun(sim, p, STUN.selfRecoverMs, 'fall');
      }
    }
  }
}

/** WP3: grappling mid-fall cancels the pending fall stun. */
export function cancelFallStun(player) {
  player.state.fallStartY = null;
}
