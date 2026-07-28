// ============================================================
// MovementSystem — applies InputFrames to player bodies (plan WP2).
//
// Multi-player, input-buffer driven: accel/friction, air control, jump
// buffer + coyote + variable height, sprint, and the mass speed/jump
// multipliers (speedMult = 1/mass, jumpMult = 1/sqrt(mass)).
//
// Weight rules (plan §4):
//   speed mass = own mass + carried load + riders stacked on your head
//                (riders affect SPEED only, never grapple mass)
//   jump mass  = own mass + carried load
//
// Stunned players are inert (null input → gravity + friction only).
// Riding a player's head counts as grounded; jumping off inherits 80%
// of the carrier's velocity. While the carrier RISES the rider's own
// vy is negative, which blocks the jump — that is exactly what makes
// boost jumps apex-timed (CLAUDE.md: pure skill, not a mechanic).
// ============================================================

import { PHYSICS, PVP, MASS, massSpeedMult, massJumpMult, traversalFor } from '../config.js';
import { nullInput } from '../net/protocol.js';
import { terrainRects } from '../sim/terrain.js';

export class MovementSystem {
  update(sim, dt) {
    const time = sim.scene.time.now;
    const T = traversalFor(sim.scene.map);
    for (const [slot, p] of sim.players) {
      const s = p.state;
      if (s.carriedBy !== null) continue; // pinned by CarrySystem
      // Stagger (WP4 light FF): input treated as null while staggerMsLeft
      // runs — momentum + friction still apply (feel spec §2). NOT stun.
      const frame = (s.stunned || (s.staggerMsLeft ?? 0) > 0)
        ? nullInput() : sim.inputFor(slot);
      this._move(sim, p, frame, time, dt, T);
    }
  }

  _move(sim, p, frame, time, dt, T) {
    const body = p.body;
    const s = p.state;
    // Carried player's EFFECTIVE mass — a hauled bagged-relic carrier
    // weighs 2.0 (mass table), not a flat 1.0.
    const carriedLoad = s.carrying?.kind === 'player'
      ? (sim.players.get(s.carrying.slot)?.state.mass ?? MASS.player)
      : 0;
    const speedMult = massSpeedMult(s.mass + carriedLoad + s.ridersMass);
    const jumpMult = massJumpMult(s.mass + carriedLoad);
    const carrier = s.standingOnSlot !== null ? sim.players.get(s.standingOnSlot) : null;
    const onGround = body.blocked.down || !!carrier;
    s.onGround = onGround;
    s.sprinting = frame.sprint && frame.moveX !== 0;
    if (onGround) s.lastGroundedAt = time;

    // ----- horizontal: accel toward target, friction toward rest -----
    // attackMoveMult: CombatSystem sets it during windup/active (hammer
    // 0.4 — committed = vulnerable, feel spec §1); 1 otherwise.
    const targetSpeed = frame.moveX * PHYSICS.baseMoveSpeed * speedMult *
      (frame.sprint ? PHYSICS.baseSprintMult : 1) * (s.attackMoveMult ?? 1);
    const accel = (onGround ? PHYSICS.accel : PHYSICS.accel * PHYSICS.airAccelMult) * speedMult;

    if (frame.moveX !== 0) {
      s.facing = Math.sign(frame.moveX);
      const dv = targetSpeed - body.velocity.x;
      const step = Math.sign(dv) * Math.min(Math.abs(dv), accel * dt);
      body.setVelocityX(body.velocity.x + step);
    } else if (onGround) {
      // Rest = zero relative to whatever we stand on (moving-carrier ride).
      const restVX = carrier ? carrier.body.velocity.x : 0;
      const dv = restVX - body.velocity.x;
      const step = Math.sign(dv) * Math.min(Math.abs(dv), PHYSICS.friction * dt);
      body.setVelocityX(body.velocity.x + step);
    }

    // ----- auto-climb (zip mode): one tile is free, two tiles need the hook -----
    // Removing jump makes every lip a wall, so a step-up has to exist. It is
    // mass-scaled like everything else: stepHeight/mass, which means a relic
    // carrier at 2.0 clears 20 px — nothing on a 40 px grid. The relic walks
    // flat ground or it goes on the line. That is the rule doing the work,
    // not a special case for the objective.
    if (T.autoStep && onGround && frame.moveX !== 0) {
      // Carried load counts, riders do not — the same split jump used.
      this._autoStep(sim, p, Math.sign(frame.moveX),
        T.stepHeight * massSpeedMult(s.mass + carriedLoad));
    }

    // ----- jump: buffer + coyote + variable height -----
    if (!T.jumpEnabled) return;
    if (frame.jump) s.jumpBufferedAt = time;
    const buffered = time - s.jumpBufferedAt <= PHYSICS.jumpBufferMs;
    const coyote = time - s.lastGroundedAt <= PHYSICS.coyoteMs;
    if (buffered && (onGround || coyote) && body.velocity.y >= -1) {
      // T.jumpVelocityMult is the per-map jump CEILING (zip mode: 0.7 → a
      // 55 px apex). It multiplies the mass rule, never replaces it, so a
      // heavy body is still worse off in a low-jump map than a light one.
      let vy = -PHYSICS.baseJumpVelocity * jumpMult * (T.jumpVelocityMult ?? 1);
      if (carrier) {
        // 80% velocity inheritance from the body under your feet.
        vy += PVP.velocityInheritance * Math.min(0, carrier.body.velocity.y);
        body.setVelocityX(body.velocity.x + PVP.velocityInheritance * carrier.body.velocity.x);
      }
      body.setVelocityY(vy);
      s.jumpBufferedAt = -Infinity;
      s.lastGroundedAt = -Infinity;
    }
    if (!frame.jumpHeld && body.velocity.y < 0) {
      body.setVelocityY(body.velocity.y * (1 - (1 - PHYSICS.jumpCutMult) * dt * 10));
    }
  }

  /**
   * Arcade has no step-up, so this is it: if we are walking into something,
   * find the surface we are pressed against, and if its top is within reach
   * AND our body fits standing on it, translate up. Velocity is untouched —
   * you keep walking, the lip just stops existing.
   *
   * Deliberately probes 2 px past the body edge rather than trusting
   * blocked.left/right alone: those flags are from the previous physics
   * step, so a fresh contact would cost a frame of being stuck.
   */
  _autoStep(sim, p, dir, maxRise) {
    if (maxRise < 2) return; // too heavy to climb anything (relic carrier)
    const b = p.body;
    if (!(dir < 0 ? b.blocked.left : b.blocked.right)) return;
    const probeX = dir < 0 ? b.x - 2 : b.right + 2;
    const feet = b.bottom;
    const band = feet - maxRise; // highest surface we could stand on

    let topY = null;
    for (const r of terrainRects(sim)) {
      if (probeX < r.x || probeX > r.right) continue;
      if (r.y >= feet - 1 || r.bottom <= band) continue; // below us / out of reach
      if (topY === null || r.y < topY) topY = r.y;
    }
    if (topY === null) return;
    const rise = feet - topY;
    if (rise <= 0 || rise > maxRise) return; // a two-tile wall stays a wall

    // Headroom: the body must actually fit up there, or we would shove it
    // into a ceiling and wedge it.
    const dest = new Phaser.Geom.Rectangle(b.x, topY - b.height, b.width, b.height);
    for (const r of terrainRects(sim)) {
      if (dest.x < r.right && r.x < dest.right &&
          dest.y < r.bottom - 0.5 && r.y + 0.5 < dest.bottom) return;
    }
    p.y -= rise;
    b.position.y -= rise;   // keep the body in sync inside this same tick
    b.prev.y -= rise;       // …and its previous position, or blocked flags lie
  }
}
