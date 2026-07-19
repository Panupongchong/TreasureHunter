// ============================================================
// NoiseSystem — the tactical pressure gauge (plan WP4; CLAUDE.md).
//
// Fills from the config.NOISE table, decays slowly when quiet (after a
// short delay so bursts accumulate honestly), and at full gauge pushes a
// spawn request for MonsterSystem and halves (spawnDropFactor). Monsters
// are a loudness tax, not bosses.
//
// addNoise() below is THE single noise API — the only way noise enters
// the gauge (cross-half contract §0.2). Systems NEVER emit NOISE_BURST
// directly; addNoise emits it (presentation-only, WP7 ripple).
// ============================================================

import { NOISE } from '../config.js';
import { EV } from '../net/protocol.js';
import { PHASE } from '../net/Session.js';

/**
 * THE single noise sink (WP4 "Exposes"; WP5 bag-stow calls it too).
 * CombatSystem calls it per swing (NOISE.daggerSwing / NOISE.hammerSwing,
 * cause 'attack') and per landed hit bonus. Discrete sources use the
 * default (emits a NOISE_BURST presentation event + updates the spawn
 * focus); continuous per-tick sources (sprint) pass {burst:false} so the
 * ctl channel isn't spammed.
 *
 * @param {import('../sim/Sim.js').Sim} sim
 * @param {number} x world px of the noise source
 * @param {number} y
 * @param {number} amount gauge points (config.NOISE table)
 * @param {string} cause 'attack'|'grapple'|'landing'|'sprint'|'doorSmash'|...
 * @param {number|null} slot attributed player slot (stats), or null
 * @param {{burst?: boolean}} [opts]
 */
export function addNoise(sim, x, y, amount, cause, slot = null, { burst = true } = {}) {
  sim.world.noise = Math.min(NOISE.max, sim.world.noise + amount);
  sim._noiseLastAddAt = performance.now();
  if (slot !== null) sim.stats.perSlot[slot].noiseMade += amount;
  if (burst) {
    sim.noiseFocus = { x, y };
    // WP6 contract W2: slot rides the burst — the "<NAME> DROPPED THE
    // RELIC!" toast keys off {cause:'relicDrop', slot} (ux-spec §9).
    sim.emit({ kind: EV.NOISE_BURST, x: Math.round(x), y: Math.round(y), amount, cause, slot });
  }
}

export class NoiseSystem {
  update(sim, dt) {
    // Sprint tick (continuous, no events).
    for (const [, p] of sim.players) {
      if (p.state.sprinting && !p.state.stunned) {
        addNoise(sim, p.x, p.y, NOISE.sprintPerSec * dt, 'sprint', p.state.slot,
          { burst: false });
      }
    }
    // Decay only after decayDelayMs of true quiet — bursts accumulate
    // honestly; a genuinely quiet team still drains to 0 in <1 min.
    if (performance.now() - (sim._noiseLastAddAt ?? 0) > NOISE.decayDelayMs) {
      sim.world.noise = Math.max(0, sim.world.noise - NOISE.decayPerSec * dt);
    }
    // Full gauge -> spawn request + halve. Spawns only mid-run; the gauge
    // itself fills/halves in lobby practice too (visibility without stakes).
    if (sim.world.noise >= NOISE.max) {
      if (sim.session.phase === PHASE.PLAYING) {
        const f = sim.noiseFocus ?? { x: 480, y: 270 };
        sim.spawnRequests.push({ x: f.x, y: f.y, reason: 'noise' });
      }
      sim.world.noise *= NOISE.spawnDropFactor;
    }
  }
}
