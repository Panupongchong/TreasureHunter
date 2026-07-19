// ============================================================
// DoorSystem — barriers: smash HP vs quiet channel progress (plan WP4).
//
// Every barrier offers loud/fast/costly (hammer/Brute smash: time cost +
// big noise) vs quiet/slow/free (channel; often co-op). The crank gate is
// hammer-immune and needs 2 SIMULTANEOUS channelers.
//
// damageDoor() below is the ONLY smash entry point (cross-half contract
// §0.1): CombatSystem calls it on hammer hit overlap, MonsterSystem for
// Brute door attacks. Dagger never calls it.
//
// Quiet-channel progress lives ON THE DOOR (persists across interrupted
// attempts, plan §4). InteractSystem owns channel start/validity/cancel
// for the external types 'pickDoor'/'crank'; this system owns progress
// and completion.
// ============================================================

import { DOORS } from '../config.js';
import { EV } from '../net/protocol.js';
import { chargeTime } from './ClockSystem.js';
import { addNoise } from './NoiseSystem.js';
import { detachAll } from './GrappleSystem.js';

/**
 * The one smash entry point (CombatSystem hammer + MonsterSystem Brute).
 * @param {import('../sim/Sim.js').Sim} sim
 * @param {object} door door GO from sim.doors
 * @param {number} hits door-HP to subtract (hammer: COMBAT.hammer.doorDamage;
 *   Brute: MONSTERS.brute.doorDamage)
 * @param {{kind:'player', slot:number}|{kind:'monster', id:string}} source
 *   Brute-broken doors charge NO time cost but emit the full smash noise
 *   burst (breakDoor handles both via the slot=null path).
 * @returns {boolean} true if the hit connected (false: already broken /
 *   crankGate hammer-immune — CombatSystem may still play a clank later)
 */
export function damageDoor(sim, door, hits, source) {
  const s = door.state;
  if (s.state !== 'intact' || s.smashHp === Infinity) return false; // crankGate immune
  s.smashHp -= hits;
  const slot = source.kind === 'player' ? source.slot : null;
  if (s.smashHp <= 0) {
    breakDoor(sim, door, 'smash', slot);
  } else {
    sim.emit({
      kind: EV.DOOR_STATE, id: s.id, state: 'intact',
      smashHp: s.smashHp, method: 'smash', slot,
    });
  }
  return true;
}

/**
 * Break a door. method 'smash' charges the type's time cost (no-op in the
 * lobby: chargeTime gates on clockRunning) + the smash noise burst;
 * 'quiet' is free and silent. Either way: static body off, beams on the
 * door snap (WP3 must-do), terrain/LOS cache invalidated, DOOR_STATE out.
 * slot = smashing player, or null (Brute smash / quiet break).
 */
export function breakDoor(sim, door, method, slot) {
  const s = door.state;
  if (s.state === 'broken') return;
  s.state = 'broken';
  s.smashHp = 0;
  if (door.body) door.body.enable = false; // static body off (host-only path)
  if (method === 'smash') {
    // Time cost only for PLAYER smashes (slot set). Brute-broken doors
    // charge NO time — players didn't choose the shortcut so the clock
    // doesn't fine them — but the FULL noise burst still fires.
    if (slot !== null) {
      chargeTime(sim, s.timeCostMs, s.type, slot);
      sim.stats.perSlot[slot].doorsSmashed++;
    }
    addNoise(sim, door.x, door.y, DOORS.smashNoise[s.type], 'doorSmash', slot);
  } // quiet: free + silent
  detachAll(sim, s.id, 'targetGone');       // WP3 must-do: drop zips mid-flight
  sim.grapple?.invalidateTerrain?.();       // rebuild terrain cache (LOS too)
  sim.emit({
    kind: EV.DOOR_STATE, id: s.id, state: 'broken',
    smashHp: 0, method, slot,
  });
}

export class DoorSystem {
  update(sim, dt) {
    // Advance quiet channels. InteractSystem validated them (external
    // types); this system OWNS progress + completion.
    const byDoor = new Map(); // doorId -> [players channeling it]
    for (const [, p] of sim.players) {
      const ch = p.state.channel;
      if (ch && (ch.type === 'pickDoor' || ch.type === 'crank')) {
        let list = byDoor.get(ch.targetId);
        if (!list) byDoor.set(ch.targetId, (list = []));
        list.push(p);
      }
    }
    for (const [, door] of sim.doors) {
      if (door.state.type === 'crankGate') door.state.crankSlots = [];
    }
    for (const [doorId, channelers] of byDoor) {
      const door = sim.doors.get(doorId);
      if (!door || door.state.state !== 'intact') continue;
      const s = door.state;
      let rate;
      if (s.type === 'crankGate') {
        s.crankSlots = channelers.map((p) => p.state.slot);
        // NO-DEADLOCK RULE: a lone crank channeler is VALID but advances
        // at rate 0 — progress holds, never resets. The second player
        // joining flips rate to 1. No ordering constraint, no
        // reset-punishment loop.
        rate = channelers.length >= 2 ? 1 : 0;
      } else {
        // Co-op picking sums (CLAUDE.md "often co-op") but capped so a
        // full stack can't out-pace the smash for free (feel review).
        rate = Math.min(channelers.length, DOORS.maxQuietChannelers);
      }
      s.quietProgress = Math.min(1,
        s.quietProgress + rate * dt * 1000 / DOORS.quietMs[s.type]);
      for (const p of channelers) { // shared-bar override (runs before Interact)
        p.state.channelProgress = Math.round(s.quietProgress * 100);
      }
      if (s.quietProgress >= 1) {
        for (const p of channelers) {
          p.state.channel = null;
          p.state.channelProgress = 0;
        }
        breakDoor(sim, door, 'quiet', null);
      }
    }
  }
}
