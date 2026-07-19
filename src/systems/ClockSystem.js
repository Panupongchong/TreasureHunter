// ============================================================
// ClockSystem — the strategic pressure clock (plan WP4; CLAUDE.md).
//
// 12-min countdown starts on 'playing' entry (the phase transition
// restarts GameScene -> fresh Sim -> init runs with session.phase
// already 'playing'). Escalation levels at <6 min and <3 min (monotonic,
// emitted once). Clock zero = calamity = the ONLY loss.
//
// Also owns pickups: hourglass touch pickup (+30 s, +10 noise) and the
// ritual altar (ALL connected players channel simultaneously, +60 s,
// once per run — "all connected" not "exactly 4" so solo stays playable).
//
// chargeTime/grantTime below are the ONLY clock mutators (cross-half
// contract §0.6) — DoorSystem charges smashes through chargeTime.
// ============================================================

import { CLOCK, INTERACT, NOISE } from '../config.js';
import { EV } from '../net/protocol.js';
import { PHASE } from '../net/Session.js';
import { addNoise } from './NoiseSystem.js';

/**
 * Charge time off the clock (smash costs). No-ops when the clock is not
 * running — lobby practice smashes are free.
 * @param {import('../sim/Sim.js').Sim} sim
 * @param {number} ms
 * @param {string} cause 'door'|'rubble'|'shortcut'|'bridge'
 * @param {number|null} slot attributed player (stats + Most Ruinous award)
 */
export function chargeTime(sim, ms, cause, slot = null) {
  if (!sim.world.clockRunning || ms <= 0) return;
  sim.world.clockMsLeft = Math.max(0, sim.world.clockMsLeft - ms);
  if (slot !== null) sim.stats.perSlot[slot].timeCostMs += ms;
  sim.emit({ kind: EV.TIME_COST, amount: ms, cause, slot });
}

/**
 * Grant time back (hourglass/ritual). Clamped to the session length.
 * @param {import('../sim/Sim.js').Sim} sim
 * @param {number} ms
 * @param {string} cause 'hourglass'|'ritual'
 * @param {number|null} slot WP6: the taker (hourglass toast "+0:30
 *   HOURGLASS (<NAME>)"); null = team gain (ritual)
 */
export function grantTime(sim, ms, cause, slot = null) {
  if (!sim.world.clockRunning || ms <= 0) return;
  sim.world.clockMsLeft = Math.min(CLOCK.sessionMs, sim.world.clockMsLeft + ms);
  sim.emit({ kind: EV.TIME_GAIN, amount: ms, cause, slot });
}

export class ClockSystem {
  init(sim) {
    // THE start seam: Sim ctor already set clockMsLeft = CLOCK.sessionMs;
    // Sim reads session (data), never net.
    sim.world.clockRunning = (sim.session.phase === PHASE.PLAYING);
  }

  update(sim, dt) {
    this._pickups(sim, dt);
    if (!sim.world.clockRunning) return;
    sim.world.clockMsLeft = Math.max(0, sim.world.clockMsLeft - dt * 1000);
    const w = sim.world;
    if (w.escalationLevel < 1 && w.clockMsLeft < CLOCK.escalation1Ms) {
      w.escalationLevel = 1;
      sim.emit({ kind: EV.ESCALATION, level: 1 });
    }
    if (w.escalationLevel < 2 && w.clockMsLeft < CLOCK.escalation2Ms) {
      w.escalationLevel = 2;
      sim.emit({ kind: EV.ESCALATION, level: 2 });
    }
    if (w.clockMsLeft <= 0) {
      w.clockRunning = false; // freeze; also stops double-emit
      sim.emit({ kind: EV.RUN_OVER, result: 'lose', reason: 'calamity' });
    }
  }

  _pickups(sim, dt) {
    for (const [, pk] of sim.pickups) {
      const s = pk.state;
      if (s.type === 'hourglass' && !s.taken) {
        for (const [, p] of sim.players) { // touch pickup, any player
          if (Math.abs(p.x - pk.x) <= INTERACT.hourglassTouchRadius &&
              Math.abs(p.y - pk.y) <= INTERACT.hourglassTouchRadius) {
            s.taken = true;
            sim.stats.treasure++; // WP5: teamStats.treasure = hourglasses collected
            grantTime(sim, CLOCK.hourglassBonusMs, 'hourglass', p.state.slot);
            addNoise(sim, pk.x, pk.y, NOISE.hourglassPickup, 'hourglass', p.state.slot);
            sim.emit({ kind: EV.DESPAWN, id: s.id, etype: 'hourglass' });
            break;
          }
        }
      } else if (s.type === 'ritual' && !s.used) {
        // ALL CONNECTED players (solo => 1) must channel simultaneously.
        // A stunned player can't channel and therefore blocks the ritual
        // until revived (flagged prototype decision).
        const channelers = [];
        for (const [, p] of sim.players) {
          if (p.state.channel?.type === 'ritual' && p.state.channel.targetId === s.id) {
            channelers.push(p);
          }
        }
        s.channelers = channelers.map((p) => p.state.slot);
        const required = Math.max(1, sim.session.connectedPlayers().length);
        if (channelers.length >= required) {
          s.progress += dt * 1000 / INTERACT.ritualChannelMs;
        } // else: HOLD at current progress — no deadlock, no reset
        for (const p of channelers) { // shared-bar override (post-Interact tick)
          p.state.channelProgress = Math.min(100, Math.round(s.progress * 100));
        }
        if (s.progress >= 1) {
          s.used = true;
          for (const p of channelers) {
            p.state.channel = null;
            p.state.channelProgress = 0;
          }
          grantTime(sim, CLOCK.ritualBonusMs, 'ritual');
          sim.emit({ kind: EV.PICKUP_STATE, id: s.id, used: true });
        }
      }
    }
  }
}
