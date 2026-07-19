// ============================================================
// GrappleSystem — THE mass rule, zip-only (plan WP3; CLAUDE.md).
//
// Grapple attaches to ANYTHING. Terrain (infinite mass): the grappler
// zips at zipSpeed toward the anchor — velocity-steered, gravity off,
// auto-detach on arrival/obstruction. Dynamic targets: equal-and-
// opposite constant force; each end accelerates by pullForce / mass,
// integrated here as velocity += (F/m) * dt (the plan-§6 "acceleration,
// not velocity" semantic — see notes below). Grapplers on one target
// SUM automatically. No special cases: Brute (3.0) pulls YOU in, equal
// masses meet in the middle, multi-grapple hoisting emerges.
//
// Runs after MovementSystem (later writes win): terrain zips fully own
// both velocity axes; dynamic pulls ADD a delta on top, so a grounded
// target resists through friction/input ("brace with your legs" —
// intentional and emergent) while airborne bodies are pulled cleanly.
//
// Authoritative state lives in player.state.grapple ONLY (snapshot-
// friendly, rejoin-safe). sim.grapples is a presentation mirror —
// Map<ownerSlot, {x, y, tx, ty, targetKind, targetId, assist,
// dbgAccel}> — maintained every tick so snapshot.js can serialize
// beams mechanically without importing this module; snapshot.js reads
// only x/y/tx/ty. Clients never run this system.
//
// Stun coupling is POLL-only (applyStun is untouched): detaches land at
// most one tick late, invisible at 60 Hz.
// ============================================================

import { GRAPPLE, NOISE } from '../config.js';
import { EV } from '../net/protocol.js';
import { cancelFallStun } from './FallStunSystem.js';
import { addNoise } from './NoiseSystem.js';

export class GrappleSystem {
  init(sim) {
    sim.grapple = this; // discovery handle for WP4/WP5 (sim.grapple.detachAll…)
    this._rects = null; // lazy Phaser.Geom.Rectangle[] platform bounds cache
  }

  update(sim, dt) {
    const msDt = dt * 1000;
    for (const [, p] of sim.players) { // normalize (rejoin/late-add safe)
      p.state.grapple ??= null;
      p.state.grappleCdMs = Math.max(0, (p.state.grappleCdMs ?? 0) - msDt);
    }
    // Prune beam records for players that left the sim entirely.
    for (const slot of [...sim.grapples.keys()]) {
      if (!sim.players.has(slot)) sim.grapples.delete(slot);
    }
    this._detachPass(sim);
    this._firePass(sim);
    this._applyPass(sim, dt);
  }

  // ---------------- terrain cache ----------------

  _terrainRects(sim) {
    // Platforms + INTACT doors (doors are walls: they occlude LOS and
    // block casts too). Door rects carry their doorId so _castRay can
    // report targetKind 'door' + targetId on the wire; broken doors are
    // dropped on the invalidateTerrain() rebuild (DoorSystem.breakDoor).
    return this._rects ??= [
      ...sim.scene.platforms.getChildren().map((go) => go.getBounds()),
      ...[...sim.doors.values()]
        .filter((d) => d.state.state === 'intact')
        .map((d) => {
          const r = d.getBounds();
          r.doorId = d.state.id;
          return r;
        }),
    ];
  }

  /** WP4 seam: DoorSystem.breakDoor calls sim.grapple.invalidateTerrain()
   *  so the cast/LOS cache rebuilds without the broken door. */
  invalidateTerrain() {
    this._rects = null;
  }

  // ---------------- pass A: detach poll (D1..D9) ----------------

  _detachPass(sim) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      const g = s.grapple;
      if (!g) continue;

      // D1/D2: owner stunned / grabbed / picked something up mid-grapple
      // (Carry runs after Grapple, so this catches it next tick).
      if (s.stunned) { detachGrapple(sim, p, 'stun'); continue; }
      if (s.carriedBy !== null || !canFireGrapple(s)) {
        detachGrapple(sim, p, 'carried'); continue;
      }
      // D3: release (disconnected slots get nullInput → auto-release).
      if (!sim.inputFor(slot).grappleHeld) {
        detachGrapple(sim, p, 'release'); continue;
      }

      let tipX, tipY;
      if (g.targetKind === 'entity') {
        const t = resolveTarget(sim, g.targetId);
        // D4: target despawned or got carried (body disabled).
        if (!t || !t.body.enable) { detachGrapple(sim, p, 'targetGone'); continue; }
        // D5: stun TRANSITION mid-grapple detaches; firing at an already-
        // stunned body attaches fine (rescue-hauling per CLAUDE.md).
        if (t.state?.stunned) {
          if (!g.targetStunnedAtAttach) { detachGrapple(sim, p, 'targetStun'); continue; }
        } else {
          g.targetStunnedAtAttach = false; // seen un-stunned: a later re-stun detaches
        }
        tipX = t.x; tipY = t.y;
      } else {
        tipX = g.anchorX; tipY = g.anchorY;
      }

      const dx = tipX - p.x, dy = tipY - p.y;
      const dist = Math.hypot(dx, dy);
      // D6: range break (slack so a pull can stretch briefly).
      if (dist > GRAPPLE.maxRange * GRAPPLE.breakRangeMult) {
        detachGrapple(sim, p, 'range'); continue;
      }
      // D7: line-of-sight broken.
      if (this._losBlocked(sim, p.x, p.y, tipX, tipY)) {
        detachGrapple(sim, p, 'los'); continue;
      }
      if (g.targetKind === 'terrain') {
        // D8: arrival.
        if (dist <= GRAPPLE.arriveRadius) { detachGrapple(sim, p, 'arrived'); continue; }
        // D9: blocked in the travel direction (flags are from the previous
        // physics step — detach lands one tick after impact; the collider
        // already stopped the body, cosmetic only).
        const ux = dx / (dist || 1), uy = dy / (dist || 1);
        const b = p.body;
        if ((ux < -0.2 && b.blocked.left) || (ux > 0.2 && b.blocked.right) ||
            (uy < -0.2 && b.blocked.up) || (uy > 0.2 && b.blocked.down)) {
          detachGrapple(sim, p, 'blocked'); continue;
        }
      }
    }
  }

  /** Segment-vs-terrain, shortened 2 px at the tip end — a terrain anchor
   *  lies ON a rect surface and must not self-occlude. */
  _losBlocked(sim, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len <= 2) return false;
    const t = (len - 2) / len;
    const line = new Phaser.Geom.Line(x1, y1, x1 + dx * t, y1 + dy * t);
    for (const rect of this._terrainRects(sim)) {
      if (Phaser.Geom.Intersects.LineToRectangle(line, rect)) return true;
    }
    return false;
  }

  // ---------------- pass B: fire (edge → gate → aim → cast → attach) ----------------

  _firePass(sim) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      const frame = sim.inputFor(slot);
      if (!frame.grapple) continue;
      if (!canFireGrapple(s)) continue;
      // Re-press while attached = instant retarget (no cooldown charged).
      if (s.grapple) detachGrapple(sim, p, 'refire');
      if (s.grappleCdMs > 0) continue;

      const { dir, assisted } = this._resolveAim(sim, p, frame);
      const hit = this._castRay(sim, p.x, p.y, dir, GRAPPLE.maxRange, slot);
      if (!hit) continue; // whiff: no event (WP7 may add a local whiff FX)

      if (hit.kind === 'terrain') {
        s.grapple = {
          // Door anchors keep targetId = the door id ('d*') so grapplesOn/
          // detachAll match it — breakDoor's detachAll(sim, doorId,
          // 'targetGone') drops zips mid-flight; detachGrapple restores
          // gravity. Steering is unchanged (anchorX/Y).
          targetKind: 'terrain', targetId: hit.id ?? null,
          anchorX: hit.x, anchorY: hit.y,
          tipX: hit.x, tipY: hit.y,
          assist: false,
        };
        p.body.setAllowGravity(false); // straight zip line, no sag
      } else {
        s.grapple = {
          targetKind: 'entity', targetId: hit.id,
          tipX: hit.go.x, tipY: hit.go.y,
          targetStunnedAtAttach: !!hit.go.state?.stunned,
          assist: assisted,
        };
      }
      cancelFallStun(p); // grapple mid-fall cancels fall stun
      const ix = Math.round(hit.x), iy = Math.round(hit.y);
      sim.emit({
        kind: EV.GRAPPLE_ATTACH, slot,
        targetKind: wireKind(hit), targetId: hit.id ?? null, x: ix, y: iy,
      });
      // addNoise is the single gauge sink (WP4 contract §0.2) — it also
      // emits the presentation NOISE_BURST. Never emit the event directly.
      addNoise(sim, ix, iy, NOISE.grappleImpact, 'grapple', slot);
    }
  }

  /** Final unit ray direction (+ whether gamepad assist rotated it).
   *  Mouse = free aim, raw (LOCKED). Gamepad = soft magnetism: rotate the
   *  whole ray onto the dynamic candidate nearest the ray (perpendicular
   *  distance); the standard nearest-hit cast then runs on the assisted
   *  ray, so terrain still occludes — terrain is never a magnet target. */
  _resolveAim(sim, p, frame) {
    let dir = aimDir(frame, p.x, p.y, p.state.facing);
    if (!frame.usingGamepad) return { dir, assisted: false };
    let best = null;
    for (const cand of dynamicTargets(sim, p.state.slot)) {
      const tox = cand.go.x - p.x, toy = cand.go.y - p.y;
      const t = tox * dir.x + toy * dir.y; // projection along ray
      if (t < GRAPPLE.minRange || t > GRAPPLE.maxRange) continue; // behind/too far
      const perp = Math.hypot(tox - t * dir.x, toy - t * dir.y);
      if (perp <= GRAPPLE.aimAssistRadius && (!best || perp < best.perp)) best = { cand, perp };
    }
    if (best) {
      const bx = best.cand.go.x - p.x, by = best.cand.go.y - p.y;
      const l = Math.hypot(bx, by);
      dir = { x: bx / l, y: by / l };
      return { dir, assisted: true };
    }
    return { dir, assisted: false };
  }

  /** Exact segment-vs-rect cast — nearest hit of EITHER kind wins
   *  (terrain occludes targets and vice versa). minRange filters PER
   *  INTERSECTION, not on the winner: a touching teammate must not mask
   *  terrain behind him. */
  _castRay(sim, x, y, dir, maxLen, selfSlot) {
    const line = new Phaser.Geom.Line(x, y, x + dir.x * maxLen, y + dir.y * maxLen);
    let best = null; // {kind, id, go, x, y, dist}
    const consider = (kind, id, go, pts) => {
      for (const pt of pts) {
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < GRAPPLE.minRange) continue;
        if (!best || d < best.dist) best = { kind, id, go, x: pt.x, y: pt.y, dist: d };
      }
    };
    for (const rect of this._terrainRects(sim)) {
      // Door rects carry rect.doorId (WP4) — plain terrain stays id null.
      consider('terrain', rect.doorId ?? null, null,
        Phaser.Geom.Intersects.GetLineToRectangle(line, rect));
    }
    for (const cand of dynamicTargets(sim, selfSlot)) {
      const b = cand.go.body;
      const rect = new Phaser.Geom.Rectangle(b.x, b.y, b.width, b.height);
      consider('entity', cand.id, cand.go, Phaser.Geom.Intersects.GetLineToRectangle(line, rect));
    }
    return best;
  }

  // ---------------- pass C: apply (zip / force integrate / beam mirror) ----------------

  _applyPass(sim, dt) {
    /** GameObject -> {ax, ay} — the map accumulating makes multi-grapple SUM automatic. */
    const forces = new Map();
    const addForce = (go, ax, ay) => {
      const f = forces.get(go) || { ax: 0, ay: 0 };
      f.ax += ax; f.ay += ay;
      forces.set(go, f);
    };
    // Plan §4: stunned = inert 1.0-mass body ALWAYS.
    const grappleMass = (go) => (go.state?.stunned ? 1.0 : (go.state?.mass ?? 1.0));

    for (const [slot, p] of sim.players) {
      const g = p.state.grapple;
      if (!g) { sim.grapples.delete(slot); continue; }

      if (g.targetKind === 'terrain') {
        const ax = g.anchorX - p.x, ay = g.anchorY - p.y;
        const len = Math.hypot(ax, ay) || 1;
        // Full ownership of both axes, AFTER MovementSystem ran.
        p.body.setVelocity((ax / len) * GRAPPLE.zipSpeed, (ay / len) * GRAPPLE.zipSpeed);
        cancelFallStun(p); // a downward zip must not register as a fall
        g.tipX = g.anchorX; g.tipY = g.anchorY;
      } else {
        const t = resolveTarget(sim, g.targetId);
        if (!t) continue; // despawned this tick; D4 detaches next tick
        const dx = t.x - p.x, dy = t.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        addForce(p, ux * GRAPPLE.pullForce / grappleMass(p), uy * GRAPPLE.pullForce / grappleMass(p));
        addForce(t, -ux * GRAPPLE.pullForce / grappleMass(t), -uy * GRAPPLE.pullForce / grappleMass(t));
        // Being tethered saves BOTH ends (grapple-catch a falling teammate).
        cancelFallStun(p); cancelFallStun(t);
        g.tipX = t.x; g.tipY = t.y;
      }
    }

    // Integrate with caps — the anti-explosion clause. Only bodies that
    // received grapple force this tick are clamped; throws/jumps elsewhere
    // are untouched.
    for (const [go, f] of forces) {
      const mag = Math.hypot(f.ax, f.ay);
      if (mag > GRAPPLE.maxPullAccel) {
        f.ax *= GRAPPLE.maxPullAccel / mag;
        f.ay *= GRAPPLE.maxPullAccel / mag;
      }
      let vx = go.body.velocity.x + f.ax * dt;
      let vy = go.body.velocity.y + f.ay * dt;
      const sp = Math.hypot(vx, vy);
      if (sp > GRAPPLE.maxPullSpeed) {
        vx *= GRAPPLE.maxPullSpeed / sp;
        vy *= GRAPPLE.maxPullSpeed / sp;
      }
      go.body.setVelocity(vx, vy);
    }

    // Mirror beam records for snapshot.js / rendering (presentation seam:
    // snapshot reads only x/y/tx/ty; the rest is debug).
    for (const [slot, p] of sim.players) {
      const g = p.state.grapple;
      if (!g) continue;
      const f = forces.get(p);
      sim.grapples.set(slot, {
        x: p.x, y: p.y, tx: g.tipX, ty: g.tipY,
        targetKind: g.targetKind, targetId: g.targetId,
        assist: !!g.assist,
        dbgAccel: f ? Math.min(Math.hypot(f.ax, f.ay), GRAPPLE.maxPullAccel) : 0,
      });
    }
  }
}

// ---------------- module API (CarrySystem/StunSystem convention) ----------------

/** The fire gate — this IS the capability check WP5 "turns on": a hand-
 *  held relic sets carrying {kind:'relic', where:'hands'} and is blocked
 *  with zero WP5 edits; bagged passes (CLAUDE.md table). In WP3 carrying
 *  can only be {kind:'player'} → correctly blocked (players-in-arms). */
export function canFireGrapple(s) {
  return !s.stunned && s.carriedBy === null &&
    (s.carrying === null ||
     (s.carrying.kind === 'relic' && s.carrying.where === 'bag'));
}

export function detachGrapple(sim, p, reason) {
  const s = p.state;
  if (!s.grapple) return;
  s.grapple = null;
  s.grappleCdMs = reason === 'refire' ? 0 : GRAPPLE.fireCooldownMs;
  p.body.setAllowGravity(true); // no-op unless terrain zip; always safe
  sim.grapples.delete(s.slot);
  sim.emit({ kind: EV.GRAPPLE_DETACH, slot: s.slot, reason });
}

/** Players whose beam is attached to targetId (WP4 Brute tug-of-war / stats). */
export function grapplesOn(sim, targetId) {
  const out = [];
  for (const [, p] of sim.players) {
    if (p.state.grapple?.targetId === targetId) out.push(p);
  }
  return out;
}

/** Drop beams by owner slot (number) or by target id (WP4 door-break /
 *  WP5 hooks). A player id drops beams ON that player AND his own beam. */
export function detachAll(sim, key, reason = 'manual') {
  if (typeof key === 'number') {
    const p = sim.players.get(key);
    if (p) detachGrapple(sim, p, reason);
    return;
  }
  for (const p of grapplesOn(sim, key)) detachGrapple(sim, p, reason);
  if (key[0] === 'p') {
    const p = sim.players.get(Number(key.slice(1)));
    if (p) detachGrapple(sim, p, reason);
  }
}

// ---------------- aim + target queries (module-local) ----------------

/** Unit aim direction for a frame relative to a shooter position.
 *  Matches protocol.js packInput exactly: gamepad frames carry a unit dir
 *  in aimX/aimY; mouse frames carry a world point. Lives here, not in
 *  InputManager — aim-assist is host-side only (plan risk 8).
 *  Exported for WP5: RelicSystem.throwRelic reuses the one protocol-exact
 *  aim decode. */
export function aimDir(frame, px, py, fallbackFacing = 1) {
  let dx, dy;
  if (frame.usingGamepad) { dx = frame.aimX; dy = frame.aimY; }
  else { dx = frame.aimX - px; dy = frame.aimY - py; }
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return { x: fallbackFacing, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** Every grapple-able dynamic body, with its §2.5 wire id. WP4/WP5 need
 *  zero changes here — the collections just start existing. Stunned
 *  players ARE included (rescue = the mass rule); carried bodies
 *  (body.enable false) are not. */
function* dynamicTargets(sim, excludeSlot) {
  for (const [slot, p] of sim.players) {
    if (slot === excludeSlot) continue;
    if (!p.body || !p.body.enable) continue;
    yield { id: 'p' + slot, go: p };
  }
  for (const [id, m] of sim.monsters) {
    // The Map key IS the wire id — resolveTarget looks up sim.monsters by
    // this same key, so never substitute state.id here (a mismatch would
    // make every monster grapple attach then instantly detach 'targetGone').
    if (m.body?.enable) yield { id, go: m };
  }
  if (sim.relic?.body?.enable) { // WP5: loose/flying only → grapple-catch is free
    yield { id: 'relic', go: sim.relic };
  }
}

function resolveTarget(sim, id) {
  if (id === 'relic') return sim.relic;
  if (id[0] === 'p') return sim.players.get(Number(id.slice(1))) || null;
  return sim.monsters.get(id) || null;
}

/** Wire targetKind for the attach event (§2.2 catalog shape). Door ids
 *  start with 'd' — never collides with detachAll's 'p' special case. */
function wireKind(hit) {
  if (hit.kind === 'terrain') return hit.id ? 'door' : 'terrain';
  if (hit.id === 'relic') return 'relic';
  return hit.id[0] === 'p' ? 'player' : 'monster';
}
