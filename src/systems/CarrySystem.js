// ============================================================
// CarrySystem — the grab/carry/throw verb (plan WP2: players only;
// the relic variant lands in WP5).
//
// Grab (F/B edge) picks up a stunned, unclaimed teammate in range; the
// carried body's physics is disabled and it rides above the carrier's
// head (CLAUDE.md: rescue = the existing mass rule — the carrier is
// slowed by the extra mass via MovementSystem's carried load).
// Grab again while carrying = throw (arc along facing, 80% velocity
// inheritance). Stun/revive releases are gentle drops.
// ============================================================

import { CARRY, PVP } from '../config.js';

export class CarrySystem {
  update(sim, dt) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      if (s.stunned || s.carriedBy !== null) continue;
      const frame = sim.inputFor(slot);
      if (frame.grab) {
        if (s.carrying?.kind === 'player') throwCarried(sim, p);
        else if (s.carrying?.kind === 'relic') {
          // Hands: grab edge = throw. Bagged: no-op — unbag first
          // (CLAUDE.md relic table). Dispatch via the discovery handle
          // (sim.relicSys) — no CarrySystem↔RelicSystem import cycle.
          if (s.carrying.where === 'hands') sim.relicSys?.throwRelic(sim, p);
        } else if (!sim.relicSys?.tryGrabRelic(sim, p)) {
          // WP5 grab priority: loose/flying relic FIRST (deterministic —
          // throw-catch chains must be reliable under pressure), then a
          // stunned teammate.
          grab(sim, p);
        }
      }
      // Pin the carried body above the carrier's head.
      if (s.carrying?.kind === 'player') {
        const carried = sim.players.get(s.carrying.slot);
        if (carried) {
          carried.setPosition(p.x, p.y + CARRY.carryOffsetY);
          carried.state.facing = s.facing;
        }
      }
    }
  }
}

/** Try to pick up a stunned teammate within grab range. */
export function grab(sim, p) {
  const s = p.state;
  if (s.carrying) return false;
  for (const [, target] of sim.players) {
    if (target === p) continue;
    const ts = target.state;
    // A bagged relic survives the stun and rides along with its holder
    // (CLAUDE.md: a stunned player CAN be hauled — the objective carrier
    // most of all). Any other carrying state still blocks the grab.
    if (!ts.stunned || ts.carriedBy !== null) continue;
    if (ts.carrying && !(ts.carrying.kind === 'relic' && ts.carrying.where === 'bag')) continue;
    if (Math.abs(target.x - p.x) > CARRY.grabRange ||
        Math.abs(target.y - p.y) > CARRY.grabRange) continue;
    ts.carriedBy = s.slot;
    ts.channel = null;
    ts.channelProgress = 0;
    s.carrying = { kind: 'player', slot: ts.slot };
    target.body.enable = false;
    return true;
  }
  return false;
}

/** Throw the carried body along facing with velocity inheritance. */
export function throwCarried(sim, p) {
  const s = p.state;
  if (s.carrying?.kind !== 'player') return;
  const carried = sim.players.get(s.carrying.slot);
  s.carrying = null;
  if (!carried) return;
  carried.state.carriedBy = null;
  carried.body.reset(p.x + s.facing * 12, p.y + CARRY.carryOffsetY);
  carried.body.enable = true;
  carried.body.setVelocity(
    p.body.velocity.x * PVP.velocityInheritance + s.facing * CARRY.throwVelX,
    p.body.velocity.y * PVP.velocityInheritance - CARRY.throwVelY,
  );
  sim.stats.perSlot[s.slot].throws++;
}

/** Gentle release (stun/revive/disconnect) — no throw arc. */
export function dropCarried(sim, p) {
  const s = p.state;
  if (s.carrying?.kind !== 'player') return;
  const carried = sim.players.get(s.carrying.slot);
  s.carrying = null;
  if (!carried) return;
  carried.state.carriedBy = null;
  carried.body.reset(p.x + s.facing * 12, p.y);
  carried.body.enable = true;
  carried.body.setVelocity(p.body.velocity.x, 0);
}
