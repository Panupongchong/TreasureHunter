// ============================================================
// CombatSystem — hammer + dagger attacks, FF, monster damage
// (plan WP4 combat half; tick position 5: after CarrySystem, before
// the arcade step).
//
// Attack state machine: player.state.attack =
//   null | {phase:'windup'|'active'|'recovery', msLeft, hitIds:Set,
//           facing, hitBonusDone}
// One swing hits each target id at most once (hitIds). Wire: player
// rows carry `wpn`/`atk` ints (snapshot.js owns the enums).
//
// FF semantics (players have NO health — CLAUDE.md "50% damage" scales
// interruption, not HP):
//   dagger → STAGGER micro-primitive (staggerMsLeft: input nulled in
//     MovementSystem, channel cancelled, attack aborted — NOT applyStun,
//     because stun drops the relic and would make the dagger unsafe
//     near teammates, violating its locked identity)
//   hammer → REAL stun via StunSystem.applyStun(cause 'ff')
// Explicit FF numbers live in config.FF (baseline vs .full — the
// session.ffFull lobby toggle).
//
// Noise: addNoise() is the ONLY gauge sink (contract §0.2). Per-swing
// noise on press (whiff included), one hit-bonus per swing on the first
// landed monster/player hit. Door hits add swing noise only (feel §1).
// ============================================================

import { COMBAT, FF, MONSTERS, NOISE } from '../config.js';
import { EV } from '../net/protocol.js';
import { applyStun } from './StunSystem.js';
import { damageDoor } from './DoorSystem.js';
import { addNoise } from './NoiseSystem.js';

const r = Math.round;

/** Identical gate shape to canFireGrapple: relic-in-hands blocks with
 *  zero WP5 edits; bagged passes. Attacking WHILE grappling is allowed
 *  (grapple-yank into hammer = core play). */
const canAttack = (s) =>
  !s.stunned && s.carriedBy === null && s.staggerMsLeft <= 0 &&
  s.attack === null && s.attackCdMs <= 0 &&
  (s.carrying === null || (s.carrying.kind === 'relic' && s.carrying.where === 'bag'));

/**
 * Light-FF stagger (feel spec §2): input-null micro-primitive. NOT the
 * stunned state — no relic drop, no carry/grapple/revive changes, no
 * snapshot bit (250 ms of no-input reads through motion alone).
 */
export function applyStagger(sim, target, bySlot) {
  const s = target.state;
  const ms = sim.session.ffFull ? FF.full.daggerStaggerMs : FF.daggerStaggerMs;
  s.staggerMsLeft = Math.max(s.staggerMsLeft ?? 0, ms);
  s.channel = null;          // active channel is CANCELLED
  s.channelProgress = 0;
  if (s.attack) {            // attack in progress is aborted
    s.attack = null;
    s.attackMoveMult = 1;
  }
  sim.emit({ kind: EV.STAGGERED, slot: s.slot, bySlot });
}

export class CombatSystem {
  init(sim) {
    sim.combat = this; // discovery handle
  }

  update(sim, dt) {
    const ms = dt * 1000;
    for (const [slot, p] of sim.players) {
      const s = p.state;

      // ----- normalize (rejoin/late-add safe, GrappleSystem convention) -----
      // Weapon persists across scene restarts via the Phaser game registry
      // (host-local, never on the wire — clients learn weapons from the
      // `wpn` snapshot field). InteractSystem's rack toggle writes
      // state.weapon; we mirror changes back into the registry here.
      const regKey = 'vb:weapon:' + slot;
      if (s.weapon == null) {
        s.weapon = sim.scene.registry.get(regKey) ?? COMBAT.defaultWeapon;
      } else if (sim.scene.registry.get(regKey) !== s.weapon) {
        sim.scene.registry.set(regKey, s.weapon);
      }
      s.attack ??= null;
      s.attackCdMs = Math.max(0, (s.attackCdMs ?? 0) - ms);
      s.staggerMsLeft = Math.max(0, (s.staggerMsLeft ?? 0) - ms);
      s.attackMoveMult = 1; // recomputed below while an attack is live

      // Stun/carry interrupts the swing (the start-charged cooldown
      // still runs — an interrupt never refunds a faster next swing).
      if (s.stunned || s.carriedBy !== null) { s.attack = null; continue; }

      const frame = sim.inputFor(slot);
      if (frame.attack && canAttack(s)) {
        const w = COMBAT[s.weapon];
        s.attack = {
          phase: 'windup', msLeft: w.windupMs, hitIds: new Set(),
          facing: s.facing,      // hammer: locked at windup start
          hitBonusDone: false,   // one landed-hit noise bonus per swing
        };
        // Cooldown charged at swing START = true press-to-press cadence
        // (cooldownMs > full swing duration for both weapons, so the cd
        // is the cadence). Charging it at recovery end doubled every
        // press-to-press interval vs the designed numbers (feel review).
        s.attackCdMs = w.cooldownMs;
        // Per-swing noise, whiff included (feel spec §1).
        addNoise(sim, p.x, p.y,
          s.weapon === 'hammer' ? NOISE.hammerSwing : NOISE.daggerSwing,
          'attack', slot);
        sim.emit({ kind: EV.SWING, slot, weapon: s.weapon });
      }
      if (!s.attack) continue;

      const w = COMBAT[s.weapon];
      // Facing lock + movement penalty from windup start through active.
      if (s.attack.phase !== 'recovery') {
        if (w.facingLock) s.facing = s.attack.facing;
        s.attackMoveMult = w.moveMult; // MovementSystem reads this next tick
      }

      s.attack.msLeft -= ms;
      if (s.attack.msLeft <= 0) {
        if (s.attack.phase === 'windup') {
          s.attack.phase = 'active';
          s.attack.msLeft = w.activeMs;
        } else if (s.attack.phase === 'active') {
          s.attack.phase = 'recovery';
          s.attack.msLeft = w.recoveryMs;
        } else {
          s.attack = null; // cooldown already charged at swing start
          continue;
        }
      }
      if (s.attack.phase === 'active') this._resolveHits(sim, p, w);
    }
  }

  /** Melee is facing-based; aim does not bend it. */
  _hitbox(p, w) {
    const x = p.state.facing === 1
      ? p.body.x + p.body.width
      : p.body.x - w.hitboxW;
    return new Phaser.Geom.Rectangle(x, p.y - w.hitboxH / 2, w.hitboxW, w.hitboxH);
  }

  _resolveHits(sim, p, w) {
    const s = p.state;
    const box = this._hitbox(p, w);
    const full = sim.session.ffFull;
    const overlapBody = (body) => body?.enable &&
      Phaser.Geom.Intersects.RectangleToRectangle(box,
        new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height));
    const hitBonus = () => {
      if (s.attack.hitBonusDone) return;
      s.attack.hitBonusDone = true;
      addNoise(sim, p.x, p.y,
        s.weapon === 'hammer' ? NOISE.hammerHitBonus : NOISE.daggerHitBonus,
        'attack', s.slot);
    };

    // ----- monsters: damage + mass-rule knockback + flinch -----
    for (const [id, m] of sim.monsters) {
      const msState = m.state;
      if (s.attack.hitIds.has(id) || msState.ai === 'dying') continue;
      if (!overlapBody(m.body)) continue;
      s.attack.hitIds.add(id);
      msState.hp -= w.damage;
      // Knockback = base/mass — the one rule again. Pops Skulkers (0.5),
      // barely nudges Brutes (3.0). Purely horizontal along facing.
      m.body.velocity.x += s.facing * (w.knockbackBase / msState.mass);
      // Flinch is per-MONSTER (skulker 300 ms interrupts its windup; brute
      // 0 = armored). Never a `stunned` boolean (grapple-mass/D5 contract).
      const flinch = MONSTERS[msState.type].flinchMs;
      if (flinch > 0) {
        msState.stunnedMs = Math.max(msState.stunnedMs, flinch);
        msState.ai = 'stunned';
        sim.emit({ kind: EV.MONSTER_FLINCH, id });
      }
      sim.emit({
        kind: EV.HIT, slot: s.slot, weapon: s.weapon,
        targetKind: 'monster', targetId: id, x: r(m.x), y: r(m.y), ff: false,
      });
      hitBonus();
      if (msState.hp <= 0) sim.monsterSys?.kill(sim, id, 'died', s.slot, s.weapon);
    }

    // ----- teammates: FF (dagger stagger / hammer stun), explicit config.FF -----
    for (const [slot2, t] of sim.players) {
      const tid = 'p' + slot2;
      if (t === p || s.attack.hitIds.has(tid)) continue;
      if (!overlapBody(t.body)) continue; // carried bodies (body off) can't be hit
      s.attack.hitIds.add(tid);
      // NO STUNLOCK, EVER (the monster rule applies to players too):
      // hitting an already-stunned teammate still shoves the body
      // (batting friends around stays funny) but never extends the stun,
      // staggers, or pads ffDealt.
      const alreadyDown = t.state.stunned;
      if (s.weapon === 'hammer') {
        t.body.velocity.x += s.facing * (full ? FF.full.hammerShoveX : FF.hammerShoveX);
        t.body.velocity.y -= FF.hammerShoveY;
        if (!alreadyDown) applyStun(sim, t, full ? FF.full.hammerStunMs : FF.hammerStunMs, 'ff');
      } else {
        t.body.velocity.x += s.facing * (full ? FF.full.daggerShoveX : FF.daggerShoveX);
        t.body.velocity.y -= FF.daggerShoveY;
        if (!alreadyDown) applyStagger(sim, t, s.slot);
      }
      if (!alreadyDown) sim.stats.perSlot[s.slot].ffDealt++;
      sim.emit({
        kind: EV.HIT, slot: s.slot, weapon: s.weapon,
        targetKind: 'player', targetId: tid, x: r(t.x), y: r(t.y), ff: true,
      });
      hitBonus();
    }

    // ----- doors: hammer only (doorDamage set), once per swing per door -----
    if (w.doorDamage) {
      for (const [id, d] of sim.doors) {
        if (s.attack.hitIds.has(id) || d.state.state !== 'intact') continue;
        if (!Phaser.Geom.Intersects.RectangleToRectangle(box, d.getBounds())) continue;
        s.attack.hitIds.add(id);
        // damageDoor is the ONLY smash entry point (contract §0.1); it
        // emits DOOR_STATE per hit and handles break (time cost + burst).
        // Returns false on crankGate (hammer-immune) — no HIT event then.
        if (damageDoor(sim, d, w.doorDamage, { kind: 'player', slot: s.slot })) {
          sim.emit({
            kind: EV.HIT, slot: s.slot, weapon: s.weapon,
            targetKind: 'door', targetId: id, x: r(d.x), y: r(d.y), ff: false,
          });
        }
      }
    }
  }
}
