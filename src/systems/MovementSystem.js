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

import { PHYSICS, PVP, MASS, massSpeedMult, massJumpMult } from '../config.js';
import { nullInput } from '../net/protocol.js';

export class MovementSystem {
  update(sim, dt) {
    const time = sim.scene.time.now;
    for (const [slot, p] of sim.players) {
      const s = p.state;
      if (s.carriedBy !== null) continue; // pinned by CarrySystem
      // Stagger (WP4 light FF): input treated as null while staggerMsLeft
      // runs — momentum + friction still apply (feel spec §2). NOT stun.
      const frame = (s.stunned || (s.staggerMsLeft ?? 0) > 0)
        ? nullInput() : sim.inputFor(slot);
      this._move(sim, p, frame, time, dt);
    }
  }

  _move(sim, p, frame, time, dt) {
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

    // ----- jump: buffer + coyote + variable height -----
    if (frame.jump) s.jumpBufferedAt = time;
    const buffered = time - s.jumpBufferedAt <= PHYSICS.jumpBufferMs;
    const coyote = time - s.lastGroundedAt <= PHYSICS.coyoteMs;
    if (buffered && (onGround || coyote) && body.velocity.y >= -1) {
      let vy = -PHYSICS.baseJumpVelocity * jumpMult;
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
}
