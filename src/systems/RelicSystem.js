// ============================================================
// RelicSystem — the relic state machine (loose/held/bagged/flying),
// THE carrier mass seam, the escape objective, AND the tombstone
// lifecycle (plan WP5; the relic rules ARE the tombstone complexity,
// §2.6). Tick position: directly after CarrySystem (plan §3.2 pos 4) —
// the held/bagged pin runs AFTER CarrySystem's carried-player pin, so
// holder-carried-by-teammate chains resolve in one tick.
//
// THE mass seam (single-writer invariant — reviewers must police it):
// player.state.mass is recomputed HERE for EVERY player, EVERY tick:
//   mass = MASS.player + (carrying relic ? MASS.relic : 0)
// With zero MovementSystem edits that feeds speedMult/jumpMult, the
// grapple mass rule, fall-stun safeHeight, and the snapshot `m` field.
// If a future WP writes state.mass elsewhere, this recompute silently
// overwrites it — move the formula, don't add a second writer.
//
// Exposed to other systems via `sim.relicSys` (discovery-handle pattern:
// CarrySystem/StunSystem/InteractSystem/GameScene call in — no import
// cycles; precedent: sim.grapple, sim.combat).
// ============================================================

import { RELIC, MASS, NOISE, CLOCK, PVP } from '../config.js';
import { EV } from '../net/protocol.js';
import { PHASE } from '../net/Session.js';
import { RS } from '../sim/snapshot.js';
import { addNoise } from './NoiseSystem.js';
import { detachGrapple, detachAll, aimDir } from './GrappleSystem.js';
import { dropCarried } from './CarrySystem.js';
import {
  createTombstone, setTombstoneBagged, destroyTombstone,
} from '../entities/TombstoneEntity.js';

/** Emit the discrete relic truth ({rs:int, hs:int, x, y}) — every transition. */
function emitRelicState(sim) {
  const st = sim.relic.state;
  sim.emit({
    kind: EV.RELIC_STATE, rs: RS[st.rs] ?? 0, hs: st.holderSlot ?? -1,
    x: Math.round(sim.relic.x), y: Math.round(sim.relic.y),
  });
}

/** Map exitZone data → {x,y,w,h} rect. Accepts the platform-style array
 *  [x,y,w,h] (designer map convention) or an {x,y,w,h} object. */
function zoneRect(z) {
  if (!z) return null;
  return Array.isArray(z) ? { x: z[0], y: z[1], w: z[2], h: z[3] } : z;
}

export class RelicSystem {
  init(sim) {
    sim.relicSys = this;
  }

  update(sim, dt) {
    // 1. THE mass seam — every player, every tick, relic or not (lobby too).
    for (const [, p] of sim.players) {
      p.state.mass = MASS.player +
        (p.state.carrying?.kind === 'relic' ? MASS.relic : 0);
    }
    const rel = sim.relic;
    if (!rel) return; // lobby: no relic — nothing else to do
    const st = rel.state;
    st.lockoutMs = Math.max(0, (st.lockoutMs ?? 0) - dt * 1000);

    // 2. Pin held/bagged to the holder (after CarrySystem's pin — chains
    //    resolve in one tick). Holder GO missing = tombstoned holder: pin
    //    the visible relic to the stone so the wire position stays correct.
    if (st.rs === 'held' || st.rs === 'bagged') {
      const holder = sim.players.get(st.holderSlot);
      if (holder) {
        const f = holder.state.facing;
        if (st.rs === 'held') {
          rel.setPosition(holder.x + f * RELIC.holdOffsetX, holder.y + RELIC.holdOffsetY);
        } else {
          rel.setPosition(holder.x - f * RELIC.bagOffsetX, holder.y + RELIC.bagOffsetY);
        }
      } else {
        const ts = sim.tombstones.get('t' + st.holderSlot);
        if (ts) rel.setPosition(ts.state.x, ts.state.y + RELIC.tombstoneOffsetY);
        else this._dropLoose(sim, rel.x, rel.y, 0, 0); // defensive: orphaned
      }
    }

    // 3. flying → loose on landing. Uncaught landing clatters (relicLand);
    //    a caught relic never reaches this — rewards the catch.
    if (st.rs === 'flying' && rel.body.blocked.down) {
      st.rs = 'loose';
      rel.body.setDragX(RELIC.looseDragX);
      addNoise(sim, rel.x, rel.y, NOISE.relicLand, 'relicLand', st.lockoutSlot);
      emitRelicState(sim);
    }

    // 4. Grapple-catch — FLYING only (a LOOSE grappled relic only reels via
    //    the mass rule and needs a grab press — grapple-fishing, CLAUDE.md).
    //    Arrival radius mirrors the hand pickup (designer A: pickupRadius).
    if (st.rs === 'flying') {
      for (const [, p] of sim.players) {
        const s = p.state;
        if (s.grapple?.targetId !== 'relic' || s.stunned ||
            s.carriedBy !== null || s.carrying) continue;
        // Same no-self-catch rule as tryGrabRelic: the thrower can't
        // instantly re-catch his own throw inside the lockout window.
        if (st.lockoutMs > 0 && st.lockoutSlot === s.slot) continue;
        if (Math.hypot(rel.x - p.x, rel.y - p.y) > RELIC.pickupRadius) continue;
        detachGrapple(sim, p, 'caught');
        this._attach(sim, p); // → hands; emits RELIC_STATE
        break;
      }
    }

    // 5. Escape objective — RelicSystem owns the win (D12): the HOLDER
    //    (hands OR bag) inside the exit zone. A loose/flying relic in the
    //    zone does NOT win (no hurl-to-win). A stunned-but-bagged holder
    //    thrown in DOES (intended comedy). clockRunning=false freezes the
    //    clock and mutually excludes the calamity double-fire.
    if (sim.world.clockRunning && sim.session.phase === PHASE.PLAYING &&
        (st.rs === 'held' || st.rs === 'bagged')) {
      const holder = sim.players.get(st.holderSlot);
      const z = zoneRect(sim.scene.map.exitZone);
      if (holder && z &&
          holder.x >= z.x && holder.x <= z.x + z.w &&
          holder.y >= z.y && holder.y <= z.y + z.h) {
        sim.world.clockRunning = false;
        sim.stats.escapeMs = CLOCK.sessionMs - sim.world.clockMsLeft;
        sim.emit({
          kind: EV.RUN_OVER, result: 'win', reason: 'escaped',
          slot: st.holderSlot, escapeMs: sim.stats.escapeMs,
        });
        // GameScene's existing RUN_OVER → RESULTS seam does the rest.
      }
    }
  }

  // ---------------- private helpers ----------------

  /** Relic → a player's HANDS (instant pickup / catch). */
  _attach(sim, p) {
    const st = sim.relic.state;
    st.rs = 'held';
    st.holderSlot = p.state.slot;
    p.state.carrying = { kind: 'relic', where: 'hands' };
    sim.relic.body.enable = false;     // drops it from dynamicTargets…
    detachAll(sim, 'relic', 'targetGone'); // …and detach beams on it eagerly
    detachGrapple(sim, p, 'carried');  // hands: canFireGrapple now false — eager
    emitRelicState(sim);
  }

  _dropLoose(sim, x, y, vx, vy) {
    const st = sim.relic.state;
    st.rs = 'loose';
    st.holderSlot = null;
    sim.relic.body.reset(x, y);
    sim.relic.body.enable = true;
    sim.relic.body.setDragX(RELIC.looseDragX);
    sim.relic.body.setVelocity(vx, vy);
    emitRelicState(sim);
  }

  // ---------------- API called by CarrySystem (grab-edge dispatch) ----------------

  /**
   * Grab edge, carrying===null. True = consumed (relic wins the grab —
   * deterministic relic-first priority, D2). Instant hand pickup within
   * pickupRadius, works on `loose` AND `flying` (bare-hand catch).
   * The thrower is locked out of his own throw for pickupLockoutMs.
   */
  tryGrabRelic(sim, p) {
    const rel = sim.relic;
    const s = p.state;
    if (!rel) return false;
    const st = rel.state;
    if (st.rs !== 'loose' && st.rs !== 'flying') return false;
    if (s.stunned || s.carriedBy !== null || s.carrying) return false;
    if (st.lockoutMs > 0 && st.lockoutSlot === s.slot) return false;
    if (Math.hypot(rel.x - p.x, rel.y - p.y) > RELIC.pickupRadius) return false;
    this._attach(sim, p);
    return true;
  }

  /** Grab edge while carrying {relic, hands}: aim-directed throw. Bagged
   *  grab-edge is a no-op (unbag first — CLAUDE.md table); relic throws
   *  do NOT count toward the `throws` stat (that one is teammates thrown). */
  throwRelic(sim, p) {
    const rel = sim.relic;
    const s = p.state;
    s.carrying = null; // mass recomputes to 1.0 next tick (mass seam)
    const frame = sim.inputFor(s.slot);
    let dir;
    if (frame.usingGamepad && Math.hypot(frame.aimX, frame.aimY) < 1e-4) {
      // Aim-neutral gamepad fallback: 45° up along facing (designer A).
      const a = RELIC.defaultThrowAngleDeg * Math.PI / 180;
      dir = { x: s.facing * Math.cos(a), y: -Math.sin(a) };
    } else {
      dir = aimDir(frame, p.x, p.y, s.facing);
    }
    const st = rel.state;
    st.rs = 'flying';
    st.holderSlot = null;
    st.lockoutSlot = s.slot;
    st.lockoutMs = RELIC.pickupLockoutMs;
    rel.body.reset(p.x + dir.x * 20, p.y + dir.y * 20 - 4); // +20 px along aim
    rel.body.enable = true;
    rel.body.setDragX(0); // fly clean; loose drag returns on landing
    rel.body.setVelocity(
      dir.x * RELIC.throwSpeed + PVP.velocityInheritance * p.body.velocity.x,
      dir.y * RELIC.throwSpeed + PVP.velocityInheritance * p.body.velocity.y,
    );
    addNoise(sim, p.x, p.y, NOISE.relicThrow, 'relicThrow', s.slot);
    emitRelicState(sim);
  }

  // ---------------- API called by StunSystem.applyStun ----------------

  /** Hands → loose + noise burst; bag → SECURE (no-op). CLAUDE.md table.
   *  Pop direction: away from the stun source when the shove gave the body
   *  a direction, else opposite carrier facing — never at rest underfoot. */
  dropOnStun(sim, p) {
    const c = p.state.carrying;
    if (c?.kind !== 'relic') return;
    if (c.where === 'bag') return; // SECURE
    p.state.carrying = null;
    const st = sim.relic.state;
    st.lockoutSlot = null;
    st.lockoutMs = 0;
    const vx = p.body.velocity.x;
    const dir = Math.abs(vx) > 50 ? Math.sign(vx) : -p.state.facing;
    const pop = dir * (RELIC.dropPopVx + (Math.random() * 2 - 1) * RELIC.dropPopVxJitter);
    this._dropLoose(sim, p.x, p.y - 6, pop, -RELIC.dropPopVy);
    addNoise(sim, p.x, p.y, NOISE.relicDropBurst, 'relicDrop', p.state.slot);
  }

  // ---------------- API called by InteractSystem._complete ----------------

  completeBag(sim, p) {
    if (p.state.carrying?.kind !== 'relic' || p.state.carrying.where !== 'hands') return;
    p.state.carrying.where = 'bag';
    sim.relic.state.rs = 'bagged';
    addNoise(sim, p.x, p.y, NOISE.bagStow, 'bagStow', p.state.slot);
    emitRelicState(sim);
  }

  completeUnbag(sim, p) {
    if (p.state.carrying?.kind !== 'relic' || p.state.carrying.where !== 'bag') return;
    p.state.carrying.where = 'hands';
    sim.relic.state.rs = 'held';
    addNoise(sim, p.x, p.y, NOISE.bagUnstow, 'bagUnstow', p.state.slot);
    emitRelicState(sim);
  }

  /** Tombstone bagged-relic → the reclaimer's BAG (it was secured; the 2 s
   *  channel mirrors unbag). The stone STAYS (rejoin anchor) — only the
   *  glyph clears (TOMBSTONE_STATE). */
  completeReclaim(sim, p, tombstoneId) {
    const ts = sim.tombstones.get(tombstoneId);
    if (!ts?.state.baggedRelic || p.state.carrying) return;
    setTombstoneBagged(ts, false); // host visual now; clients via the event
    p.state.carrying = { kind: 'relic', where: 'bag' };
    sim.relic.state.holderSlot = p.state.slot; // rs stays 'bagged'
    addNoise(sim, p.x, p.y, NOISE.bagStow, 'reclaim', p.state.slot);
    // WP6 contract W3: `by` = the reclaimer — "<NAME> RECLAIMED THE RELIC
    // BAG" toast (ux-spec §9).
    sim.emit({ kind: EV.TOMBSTONE_STATE, slot: ts.state.slot, baggedRelic: false, by: p.state.slot });
    emitRelicState(sim);
  }

  // ---------------- API called by GameScene (host) ----------------

  /** _onLeave, phase===PLAYING only. Replaces the WP4 "inert placeholder":
   *  the player GO is removed host-side NOW (and on clients via the
   *  TOMBSTONE event); emits ride the next sim.update drain. */
  playerDisconnected(sim, slot) {
    const p = sim.players.get(slot);
    if (!p) return;
    if (p.state.carriedBy !== null) {
      const c = sim.players.get(p.state.carriedBy);
      if (c) dropCarried(sim, c);
    }
    if (p.state.carrying?.kind === 'player') dropCarried(sim, p);
    detachAll(sim, slot);          // his own beam
    detachAll(sim, 'p' + slot);    // beams on him
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    let bagged = false;
    if (p.state.carrying?.kind === 'relic') {
      if (p.state.carrying.where === 'hands') {
        this.dropOnStun(sim, p);   // same drop + burst path (plan §2.6)
      } else {
        bagged = true;             // rs 'bagged', holderSlot stays = slot;
      }                            // pin falls back to the tombstone
    }
    const id = 't' + slot;
    const ts = createTombstone(sim.scene, { id, slot, x, y, baggedRelic: bagged });
    sim.tombstones.set(id, ts);
    sim.scene.tombstones.set(id, ts);
    sim.emit({ kind: EV.TOMBSTONE, slot, x, y, baggedRelic: bagged });
    sim.scene._removePlayer(slot); // body + view gone NOW; handler idempotent
  }

  /** _onJoin rejoined path: [x, y] respawn override, or null (no stone). */
  tombstoneSpawn(sim, slot) {
    const ts = sim.tombstones.get('t' + slot);
    return ts ? [ts.state.x, ts.state.y - 8] : null;
  }

  /** _onJoin rejoined path, AFTER _addPlayer: restore the bag + despawn
   *  the stone. The owner auto-reclaims his own bagged relic. */
  consumeTombstone(sim, slot, p) {
    const id = 't' + slot;
    const ts = sim.tombstones.get(id);
    if (!ts) return;
    if (ts.state.baggedRelic && sim.relic) {
      p.state.carrying = { kind: 'relic', where: 'bag' };
      sim.relic.state.holderSlot = slot; // rs already 'bagged'
      emitRelicState(sim);
    }
    sim.tombstones.delete(id);
    sim.scene.tombstones.delete(id);
    destroyTombstone(ts);
    sim.emit({ kind: EV.DESPAWN, id, etype: 'tombstone', slot });
  }
}
