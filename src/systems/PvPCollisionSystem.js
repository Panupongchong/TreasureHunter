// ============================================================
// PvPCollisionSystem — players are platforms to each other (plan WP2,
// risk 2).
//
// The player×player collider uses a processCallback: return true
// (solid) ONLY when the contact is clearly top/bottom (the upper body
// was above the lower one last step); side contacts return false and
// get a manual separation acceleration instead (soft push) — corridors
// clog, but nobody hard-blocks or climbs anybody.
//
// update() runs FIRST each tick: it converts the contacts collected
// during the previous physics step into rider state (standingOnSlot)
// and transmits stacked weight down the stack (ridersMass, speed calc
// only — plan §4).
// ============================================================

import { PVP } from '../config.js';

export class PvPCollisionSystem {
  constructor() {
    /** [riderSlot, carrierSlot] pairs collected during the arcade step. */
    this.stepContacts = [];
  }

  init(sim) {
    this.sim = sim;
    const scene = sim.scene;
    scene.physics.add.collider(
      scene.playersGroup, scene.playersGroup,
      null,
      (a, b) => this._process(a, b),
    );
  }

  _process(a, b) {
    if (!a.state || !b.state) return false;
    const upper = a.body.prev.y <= b.body.prev.y ? a : b;
    const lower = upper === a ? b : a;
    const wasAbove =
      upper.body.prev.y + upper.body.height <= lower.body.prev.y + PVP.topContactEps;

    if (wasAbove && upper.body.velocity.y >= lower.body.velocity.y - 1) {
      this.stepContacts.push([upper.state.slot, lower.state.slot]);
      return true; // solid: stand on heads
    }

    // Side contact: no hard block, just push apart.
    const dt = this.sim.scene.game.loop.delta / 1000;
    const dir = Math.sign(a.x - b.x) || (a.state.slot < b.state.slot ? 1 : -1);
    a.body.velocity.x += dir * PVP.sidePushAccel * dt;
    b.body.velocity.x -= dir * PVP.sidePushAccel * dt;
    return false;
  }

  update(sim) {
    for (const [, p] of sim.players) {
      p.state.standingOnSlot = null;
      p.state.ridersMass = 0;
    }
    // riders: rider -> carrier (a body can only stand on one head)
    const riders = new Map(this.stepContacts);
    for (const [riderSlot, carrierSlot] of riders) {
      const rider = sim.players.get(riderSlot);
      if (rider) rider.state.standingOnSlot = carrierSlot;
    }
    // Transmit weight down the whole stack: each rider's mass (plus its
    // own carried load is ignored — plan keeps this to body mass) adds
    // to every body beneath it. Chains are ≤4 deep; walk per rider.
    for (const [riderSlot] of riders) {
      const rider = sim.players.get(riderSlot);
      if (!rider) continue;
      let below = riders.get(riderSlot);
      let guard = 0;
      while (below !== undefined && guard++ < 4) {
        const carrier = sim.players.get(below);
        if (!carrier) break;
        carrier.state.ridersMass += rider.state.mass;
        below = riders.get(below);
      }
    }
    this.stepContacts = [];
  }
}
