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
//
// ---- Hook flight (TRAVERSAL.projectileHook; config HOOK) ----
// With the flag on, the press no longer resolves instantly. The hook is a
// thrown body with its own gravity and its own three-phase life BEFORE the
// existing hooked/reeling ladder ever starts:
//
//   flying      → integrating hvx/hvy under HOOK.gravity. Along each step
//                 it contests three things and takes the nearest: an anchor
//                 within HOOK.catchRadius (bite), a dynamic body (bite), a
//                 terrain slab (contact)
//   dragging    → it landed ON TOP of a slab, so it is being hauled along
//                 that deck toward the player's side until it bites a lip
//                 anchor, slides off the far edge back into `flying`, or
//                 runs out of deck
//   retracting  → it grabbed nothing (wall, ceiling, timeout, end of rope);
//                 it comes home at retractSpeed and the line clears itself
//
// Only the bite writes anchorX/anchorY + targetKind, i.e. only the bite
// produces the state the rest of this file already knew how to run. The
// zip/force/detach machinery below is UNCHANGED — flight is a front end
// bolted onto it, which is why jump-mode maps (projectileHook false) still
// take the original hitscan path line for line.
// ============================================================

import { GRAPPLE, HOOK, NOISE, massSpeedMult, traversalFor } from '../config.js';
import { EV } from '../net/protocol.js';
import { cancelFallStun } from './FallStunSystem.js';
import { addNoise } from './NoiseSystem.js';
import { terrainRects, terrainAnchors, invalidateTerrain } from '../sim/terrain.js';

export class GrappleSystem {
  init(sim) {
    sim.grapple = this; // discovery handle for WP4/WP5 (sim.grapple.detachAll…)
    this._sim = sim;    // invalidateTerrain() is called with no args (DoorSystem)
  }

  update(sim, dt) {
    const msDt = dt * 1000;
    const T = traversalFor(sim.scene.map);
    for (const [, p] of sim.players) { // normalize (rejoin/late-add safe)
      p.state.grapple ??= null;
      p.state.grappleCdMs = Math.max(0, (p.state.grappleCdMs ?? 0) - msDt);
    }
    // Prune beam records for players that left the sim entirely.
    for (const slot of [...sim.grapples.keys()]) {
      if (!sim.players.has(slot)) sim.grapples.delete(slot);
    }
    this._detachPass(sim, T, msDt);
    this._firePass(sim, T);
    this._hookPass(sim, dt, T); // no-op unless a hook is in the air
    this._applyPass(sim, dt, T);
  }

  /** WP4 seam: DoorSystem.breakDoor calls sim.grapple.invalidateTerrain()
   *  so the cast/LOS/anchor caches rebuild without the broken door. */
  invalidateTerrain() {
    invalidateTerrain(this._sim);
  }

  // ---------------- pass A: detach poll (D1..D9) ----------------

  _detachPass(sim, T, msDt) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      const g = s.grapple;
      if (!g) continue;
      g.ageMs = (g.ageMs ?? 0) + msDt;
      const flight = IN_FLIGHT.has(g.phase); // hook not attached to anything yet

      // D1/D2: owner stunned / grabbed / picked something up mid-grapple
      // (Carry runs after Grapple, so this catches it next tick).
      if (s.stunned) { detachGrapple(sim, p, 'stun'); continue; }
      if (s.carriedBy !== null || !canFireGrapple(s)) {
        detachGrapple(sim, p, 'carried'); continue;
      }
      // D3: release (disconnected slots get nullInput → auto-release).
      // Two-stage mode owns its own lifetime: the line is press-driven, so
      // letting the button go between the hook and the reel must NOT drop
      // it. A hook you never commit to expires instead (D3b).
      if (!T.twoStage && !sim.inputFor(slot).grappleHeld) {
        detachGrapple(sim, p, 'release'); continue;
      }
      // D3b: uncommitted tether timeout (two-stage only).
      if (T.twoStage && g.phase === 'hooked' && T.tetherMaxMs &&
          g.ageMs > T.tetherMaxMs) {
        detachGrapple(sim, p, 'tetherExpired'); continue;
      }
      // D3c: a hook that has been in the air this long has whiffed. It
      // RETRACTS rather than vanishing — the line coming back is the
      // feedback that tells you the throw was bad.
      if (g.phase === 'flying' && g.ageMs > HOOK.maxFlightMs) {
        startRetract(g); continue;
      }

      let tipX, tipY;
      if (flight) {
        tipX = g.tipX; tipY = g.tipY; // the hook itself, mid-air or mid-drag
      } else if (g.targetKind === 'entity') {
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
      // D6: range break (slack so a pull can stretch briefly). An unattached
      // hook does not snap the line — it has simply run out of rope, so it
      // turns around. maxRange is the rope; breakRangeMult's stretch is for
      // pulls, which a flying hook is not doing.
      if (flight) {
        if (g.phase !== 'retracting' && dist > GRAPPLE.maxRange) { startRetract(g); continue; }
      } else if (dist > GRAPPLE.maxRange * GRAPPLE.breakRangeMult) {
        detachGrapple(sim, p, 'range'); continue;
      }
      // D7: line-of-sight broken. Skipped in flight, and that is required, not
      // lenient: a hook being dragged across a deck sits BEHIND that deck's
      // lip from below, so the taut-line test would cancel the drag on the
      // exact tick it starts working. A real rope drapes over the edge; the
      // check comes back the moment the hook bites and the line is straight.
      if (!flight && this._losBlocked(sim, p.x, p.y, tipX, tipY)) {
        detachGrapple(sim, p, 'los'); continue;
      }
      // A slack hook neither arrives nor cares what it is pressed against:
      // arrival and obstruction only mean something once you are reeling.
      if (!flight && g.targetKind === 'terrain' && g.phase !== 'hooked') {
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
    for (const rect of terrainRects(sim)) {
      if (Phaser.Geom.Intersects.LineToRectangle(line, rect)) return true;
    }
    return false;
  }

  // ---------------- pass B: fire (edge → gate → aim → cast → attach) ----------------

  _firePass(sim, T) {
    for (const [slot, p] of sim.players) {
      const s = p.state;
      const frame = sim.inputFor(slot);
      if (!frame.grapple) continue;
      if (!canFireGrapple(s)) continue;

      // ---- a hook in the air owns the press: it means "come back" ----
      // Not a refire, and not ignored either. The line is a physical object
      // now, so you cannot have two of them, and a bad throw has to be
      // cancellable or the arc time becomes a punishment you just wait out.
      if (s.grapple && IN_FLIGHT.has(s.grapple.phase)) {
        if (s.grapple.phase !== 'retracting') startRetract(s.grapple);
        continue;
      }

      // ---- two-stage: the press means something different each beat ----
      // 1 hook (handled below) · 2 commit the reel · 3 let go, keeping
      // whatever speed the reel built. Beat 3 is the momentum tech: you
      // choose the release point, so a hook ahead of you is a slingshot
      // rather than a taxi that always parks at the anchor.
      if (T.twoStage && s.grapple) {
        if (s.grapple.phase === 'hooked') {
          s.grapple.phase = 'reeling';
          if (s.grapple.targetKind === 'terrain') p.body.setAllowGravity(false);
          sim.emit({ kind: EV.GRAPPLE_ATTACH, slot,
            targetKind: 'reel', targetId: s.grapple.targetId ?? null,
            x: Math.round(s.grapple.tipX), y: Math.round(s.grapple.tipY) });
        } else {
          detachGrapple(sim, p, 'letGo');
        }
        continue;
      }
      // Re-press while attached = instant retarget (no cooldown charged).
      if (s.grapple) detachGrapple(sim, p, 'refire');
      if (s.grappleCdMs > 0) continue;

      const { dir, assisted, aimPoint } = this._resolveAim(sim, p, frame);

      // ---- projectile mode: the press only THROWS. Nothing is resolved
      // here — _hookPass decides what (if anything) this hook grabs, one
      // tick of flight at a time.
      if (T.projectileHook) {
        const v = this._throwVelocity(p, dir, aimPoint);
        s.grapple = {
          phase: 'flying',
          targetKind: 'hook', targetId: null, // nothing is attached yet
          tipX: p.x, tipY: p.y,
          hvx: v.hvx, hvy: v.hvy,
          assist: assisted, ageMs: 0,
        };
        continue;
      }

      const hit = this._castRay(sim, p.x, p.y, dir, GRAPPLE.maxRange, slot, T);
      if (!hit) continue; // whiff: no event (WP7 may add a local whiff FX)

      const phase = T.twoStage ? 'hooked' : 'reeling';
      if (hit.kind === 'terrain') {
        s.grapple = {
          phase,
          // Door anchors keep targetId = the door id ('d*') so grapplesOn/
          // detachAll match it — breakDoor's detachAll(sim, doorId,
          // 'targetGone') drops zips mid-flight; detachGrapple restores
          // gravity. Steering is unchanged (anchorX/Y).
          targetKind: 'terrain', targetId: hit.id ?? null,
          anchorX: hit.x, anchorY: hit.y,
          tipX: hit.x, tipY: hit.y,
          assist: false,
        };
        // Gravity off only while REELING — a slack hook leaves you
        // ballistic, which is the whole point of the pause between presses.
        if (phase === 'reeling') p.body.setAllowGravity(false);
      } else {
        s.grapple = {
          phase,
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

  /** Final unit ray direction (+ whether gamepad assist rotated it, + the
   *  world POINT being aimed at when there is one — the projectile hook
   *  needs a point, not just a heading, to solve an arc through).
   *  Mouse = free aim, raw (LOCKED) — the cursor IS the point. Gamepad =
   *  soft magnetism: rotate the whole ray onto the dynamic candidate nearest
   *  the ray (perpendicular distance); the standard nearest-hit cast then
   *  runs on the assisted ray, so terrain still occludes — terrain is never
   *  a magnet target, and a gamepad aiming at terrain therefore has no point
   *  to solve to and throws raw along the stick (CLAUDE.md: "raw aim for
   *  terrain"). */
  _resolveAim(sim, p, frame) {
    let dir = aimDir(frame, p.x, p.y, p.state.facing);
    if (!frame.usingGamepad) {
      return { dir, assisted: false, aimPoint: { x: frame.aimX, y: frame.aimY } };
    }
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
      // Magnetized: the body's position is the point, so an assisted gamepad
      // throw arcs onto it instead of dropping under it at range.
      return {
        dir, assisted: true,
        aimPoint: { x: best.cand.go.x, y: best.cand.go.y },
      };
    }
    return { dir, assisted: false, aimPoint: null };
  }

  /**
   * Launch velocity for a thrown hook. With an aim POINT, solve the flatter
   * of the two ballistic arcs through it: the throw then honours free aim
   * under gravity instead of asking the player to eyeball the lead, which is
   * what lets HOOK.gravity stay high enough for lobs to be a real option.
   *
   * No solution (too far, or too high for v²/2g of vertical reach) → launch
   * raw along the aim. That fallback is not a failure case, it is the second
   * half of the design: it is the throw that sails over a lip and lands on
   * the deck behind it.
   */
  _throwVelocity(p, dir, aimPoint) {
    const v = HOOK.throwSpeed;
    if (aimPoint) {
      const sol = solveArc(aimPoint.x - p.x, aimPoint.y - p.y, v, HOOK.gravity);
      if (sol) return sol;
    }
    return { hvx: dir.x * v, hvy: dir.y * v };
  }

  /** Exact segment-vs-rect cast — nearest hit of EITHER kind wins
   *  (terrain occludes targets and vice versa). minRange filters PER
   *  INTERSECTION, not on the winner: a touching teammate must not mask
   *  terrain behind him. */
  _castRay(sim, x, y, dir, maxLen, selfSlot, T) {
    const line = new Phaser.Geom.Line(x, y, x + dir.x * maxLen, y + dir.y * maxLen);
    let best = null; // {kind, id, go, x, y, dist}
    const consider = (kind, id, go, pts) => {
      for (const pt of pts) {
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < GRAPPLE.minRange) continue;
        if (!best || d < best.dist) best = { kind, id, go, x: pt.x, y: pt.y, dist: d };
      }
    };
    if (T.anchorsOnly) {
      // Anchor mode: terrain is not a surface you stick to, it is a set of
      // POINTS. Match like the gamepad assist does — nearest along the ray,
      // within anchorSnap perpendicular — so a lip is a target you can
      // actually hit at speed. LOS is checked per anchor because terrain no
      // longer enters the nearest-hit contest to occlude anything.
      for (const a of terrainAnchors(sim)) {
        const tox = a.x - x, toy = a.y - y;
        const along = tox * dir.x + toy * dir.y;
        if (along < GRAPPLE.minRange || along > maxLen) continue;
        const perp = Math.hypot(tox - along * dir.x, toy - along * dir.y);
        if (perp > T.anchorSnap) continue;
        if (best && along >= best.dist) continue;
        if (this._losBlocked(sim, x, y, a.x, a.y)) continue;
        best = { kind: 'terrain', id: a.id, go: null, x: a.x, y: a.y, dist: along };
      }
    } else {
      for (const rect of terrainRects(sim)) {
        // Door rects carry rect.doorId (WP4) — plain terrain stays id null.
        consider('terrain', rect.doorId ?? null, null,
          Phaser.Geom.Intersects.GetLineToRectangle(line, rect));
      }
    }
    for (const cand of dynamicTargets(sim, selfSlot)) {
      const b = cand.go.body;
      const rect = new Phaser.Geom.Rectangle(b.x, b.y, b.width, b.height);
      const pts = Phaser.Geom.Intersects.GetLineToRectangle(line, rect);
      // Bodies still hide behind walls in anchor mode, where terrain rects
      // are no longer in the contest to do the occluding for us.
      if (T.anchorsOnly && pts.length && this._losBlocked(sim, x, y, cand.go.x, cand.go.y)) continue;
      consider('entity', cand.id, cand.go, pts);
    }
    return best;
  }

  // ---------------- pass B2: hook flight (projectileHook only) ----------------

  _hookPass(sim, dt, T) {
    for (const [, p] of sim.players) {
      const g = p.state.grapple;
      if (!g) continue;
      if (g.phase === 'flying') this._stepFlight(sim, p, g, dt, T);
      else if (g.phase === 'dragging') this._stepDrag(sim, p, g, dt, T);
      else if (g.phase === 'retracting') this._stepRetract(sim, p, g, dt);
    }
  }

  /**
   * One tick of ballistic hook. Semi-implicit Euler, then the whole STEP
   * (not the end point) is tested against three contestants and the nearest
   * wins. Testing the segment rather than the new position is what makes
   * this tunnel-proof: at 950 px/s a 60 Hz step is ~16 px, exactly the
   * thickness of the Zip Arena's rungs, so a point test would fly through
   * platform 6 about half the time.
   */
  _stepFlight(sim, p, g, dt, T) {
    const hx = g.tipX, hy = g.tipY;
    g.hvy += HOOK.gravity * dt;
    const nx = hx + g.hvx * dt, ny = hy + g.hvy * dt;
    const line = new Phaser.Geom.Line(hx, hy, nx, ny);
    const along = (x, y) => Math.hypot(x - hx, y - hy);
    // Path length so far, so minRange means the same thing it means on the
    // hitscan path: nothing bites in the first 32 px. Terrain CONTACT still
    // counts at any distance (the floor under your feet is really there) —
    // this only stops the lip you are standing on from grabbing the hook the
    // instant it leaves your hand.
    const flown = g.flownPx ?? 0;
    const biteOk = (d) => flown + d >= GRAPPLE.minRange;

    // 1. anchor bite. The hook is a small object: catchRadius, not anchorSnap.
    let bestAnchor = null;
    if (T.anchorsOnly) {
      for (const a of terrainAnchors(sim)) {
        const near = segNearest(a.x, a.y, hx, hy, nx, ny);
        if (near.dist > HOOK.catchRadius || !biteOk(near.along)) continue;
        if (!bestAnchor || near.along < bestAnchor.d) bestAnchor = { d: near.along, a };
      }
    }
    // 2. dynamic body bite (the ferry route: bodies are the traversal network).
    let bestBody = null;
    const pad = HOOK.bodyPad;
    for (const cand of dynamicTargets(sim, p.state.slot)) {
      const b = cand.go.body;
      const rect = new Phaser.Geom.Rectangle(
        b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad);
      for (const pt of Phaser.Geom.Intersects.GetLineToRectangle(line, rect)) {
        const d = along(pt.x, pt.y);
        if (!biteOk(d)) continue;
        if (!bestBody || d < bestBody.d) bestBody = { d, cand, x: pt.x, y: pt.y };
      }
    }
    // 3. terrain contact — a hit, not necessarily a grab.
    let bestRect = null;
    for (const rect of terrainRects(sim)) {
      for (const pt of Phaser.Geom.Intersects.GetLineToRectangle(line, rect)) {
        const d = along(pt.x, pt.y);
        if (!bestRect || d < bestRect.d) bestRect = { d, rect, x: pt.x, y: pt.y };
      }
    }

    // Nearest wins, with the anchor allowed a few px of tie-break over the
    // slab it is hanging off — otherwise the lip you aimed at loses to its
    // own platform every time.
    let win = null;
    for (const [c, bias] of [[bestAnchor, HOOK.anchorBias], [bestBody, 0], [bestRect, 0]]) {
      if (c && (!win || c.d - bias < win.score)) win = { ...c, score: c.d - bias };
    }
    if (!win) { // clean air: keep flying
      g.tipX = nx; g.tipY = ny;
      g.flownPx = flown + along(nx, ny);
      return;
    }
    g.flownPx = flown + win.d;

    if (win.a) {
      this._catchTerrain(sim, p, g, win.a.x, win.a.y, win.a.id, T);
    } else if (win.cand) {
      this._catchEntity(sim, p, g, win.cand, T);
    } else if (!T.anchorsOnly) {
      // Ray-mode geometry, projectile delivery: any surface is a grab.
      this._catchTerrain(sim, p, g, win.x, win.y, win.rect.doorId ?? null, T);
    } else if (g.hvy > 0 && hy <= win.rect.y + 2) {
      // Came down onto the DECK. This is the feature: the throw missed the
      // lip, so the hook lands and gets hauled back until it finds one.
      const r = win.rect;
      g.phase = 'dragging';
      g.tipX = Math.min(Math.max(win.x, r.x), r.right);
      g.tipY = r.y;
      // Copied, not referenced: a door break invalidates the rect cache and a
      // held reference would drag along geometry that no longer exists.
      g.dragX0 = r.x; g.dragX1 = r.right; g.dragY = r.y;
      g.dragMs = 0;
    } else {
      startRetract(g); // wall, ceiling, underside: nothing to hold onto
    }
  }

  /**
   * The hook is lying on a deck and the line is pulling it home. It slides
   * toward the player's side until it bites a lip, falls off the edge, or is
   * dragged all the way under the player with nothing to show for it.
   */
  _stepDrag(sim, p, g, dt, T) {
    g.dragMs = (g.dragMs ?? 0) + dt * 1000;
    const dir = Math.sign(p.x - g.tipX) || p.state.facing;
    g.tipX += dir * HOOK.slideSpeed * dt;
    g.tipY = g.dragY;

    // A lip anchor sits 6 px outside the corner and 6 px above it, so the
    // hook reaches catchRadius of it a few px BEFORE the edge — the bite
    // reads as catching the corner, which is what it is.
    const a = this._anchorNear(sim, g.tipX, g.tipY, HOOK.catchRadius);
    if (a) { this._catchTerrain(sim, p, g, a.x, a.y, a.id, T); return; }

    if (g.tipX < g.dragX0 || g.tipX > g.dragX1) {
      // Off the far edge of a deck with no lip to offer (noAnchorIdx, or a
      // corner buried in a wall). It keeps its slide speed and falls: it can
      // still land on something lower down. Suppressed lips stay unhookable
      // without a single line of special-case code.
      g.phase = 'flying';
      g.hvx = dir * HOOK.slideSpeed; g.hvy = 0;
      return;
    }
    // Dragged under our own feet, or dragging forever on a long smooth deck.
    if (Math.abs(p.x - g.tipX) < HOOK.dragArriveX || g.dragMs > HOOK.dragMaxMs) {
      startRetract(g);
    }
  }

  _stepRetract(sim, p, g, dt) {
    const dx = p.x - g.tipX, dy = p.y - g.tipY;
    const d = Math.hypot(dx, dy);
    const step = HOOK.retractSpeed * dt;
    if (d <= Math.max(step, GRAPPLE.arriveRadius)) {
      detachGrapple(sim, p, 'hookReturned'); // charges the normal cooldown
      return;
    }
    g.tipX += (dx / d) * step;
    g.tipY += (dy / d) * step;
  }

  /** Nearest anchor within r of a point, or null. */
  _anchorNear(sim, x, y, r) {
    let best = null, bd = r;
    for (const a of terrainAnchors(sim)) {
      const d = Math.hypot(a.x - x, a.y - y);
      if (d <= bd) { bd = d; best = a; }
    }
    return best;
  }

  // ---- the bite: the one place flight becomes an ATTACHED grapple ----

  _catchTerrain(sim, p, g, x, y, id, T) {
    g.phase = T.twoStage ? 'hooked' : 'reeling';
    g.targetKind = 'terrain';
    g.targetId = id ?? null;
    g.anchorX = x; g.anchorY = y;
    g.tipX = x; g.tipY = y;
    if (g.phase === 'reeling') p.body.setAllowGravity(false);
    this._announceCatch(sim, p, g, x, y);
  }

  _catchEntity(sim, p, g, cand, T) {
    g.phase = T.twoStage ? 'hooked' : 'reeling';
    g.targetKind = 'entity';
    g.targetId = cand.id;
    g.targetStunnedAtAttach = !!cand.go.state?.stunned;
    g.tipX = cand.go.x; g.tipY = cand.go.y;
    this._announceCatch(sim, p, g, cand.go.x, cand.go.y);
  }

  /** Shared bite bookkeeping. Everything the hitscan path did on ATTACH
   *  happens here instead — one tick later in wall-clock terms, and at the
   *  point where it is actually true. In particular the fall-stun cancel and
   *  the noise burst belong to the BITE, not the throw: a hook that grabbed
   *  nothing must not save you from a fall or wake up a Skulker. */
  _announceCatch(sim, p, g, x, y) {
    g.ageMs = 0; // the two-stage tether clock starts when the hook holds
    delete g.hvx; delete g.hvy;
    cancelFallStun(p);
    const ix = Math.round(x), iy = Math.round(y);
    sim.emit({
      kind: EV.GRAPPLE_ATTACH, slot: p.state.slot,
      targetKind: wireKind({ kind: g.targetKind, id: g.targetId }),
      targetId: g.targetId, x: ix, y: iy,
    });
    addNoise(sim, ix, iy, NOISE.grappleImpact, 'grapple', p.state.slot);
  }

  // ---------------- pass C: apply (zip / force integrate / beam mirror) ----------------

  _applyPass(sim, dt, T) {
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

      // Anything that is not REELING is pure decoration: no force, no
      // steering, gravity still on. That covers the slack two-stage hook
      // (you keep running, falling, whatever — the line is just attached
      // now) and all three flight phases, whose tip _hookPass already owns.
      if (g.phase !== 'reeling') { g.tipX ??= p.x; g.tipY ??= p.y; }
      else if (g.targetKind === 'terrain') {
        const ax = g.anchorX - p.x, ay = g.anchorY - p.y;
        const len = Math.hypot(ax, ay) || 1;
        // Reel speed scales by 1/mass when the map asks: the relic carrier
        // (2.0) reels at half, which is where jumpMult's tax went.
        const speed = T.zipSpeed *
          (T.massScaledZip ? massSpeedMult(grappleMass(p)) : 1);
        // Full ownership of both axes, AFTER MovementSystem ran.
        p.body.setVelocity((ax / len) * speed, (ay / len) * speed);
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
        phase: g.phase ?? 'reeling', // presentation: a slack hook should not
                                     // read like a taut one (WP7 beam FX)
        assist: !!g.assist,
        dbgAccel: f ? Math.min(Math.hypot(f.ax, f.ay), GRAPPLE.maxPullAccel) : 0,
      });
    }
  }
}

// ---------------- hook-flight helpers (module-local) ----------------

/** The three phases in which nothing is attached and no force is applied.
 *  Every guard in this file that used to mean "attached" tests this. */
const IN_FLIGHT = new Set(['flying', 'dragging', 'retracting']);

/** Give up on the throw and reel the hook home. Never emits: the line was
 *  never attached, so there is no DETACH to report until it arrives. */
function startRetract(g) {
  g.phase = 'retracting';
  g.hvx = 0; g.hvy = 0;
}

/**
 * Launch velocity that puts a projectile of speed `v` under gravity `g`
 * through the offset (dx, dy) — dy NEGATIVE is up, screen convention.
 * Returns the low (flatter) of the two arcs, or null if the point is out of
 * ballistic reach.
 *
 *   Y = X·tanθ − gX²(1+tan²θ)/(2v²)   solved for tanθ gives
 *   tanθ = (v² ± √(v⁴ − 2v²Yg − g²X²)) / (gX),  minus root = the low arc
 *
 * The discriminant is the reach test, and it is the same number as the
 * config note: max flat reach is v²/g, max vertical is v²/2g.
 */
function solveArc(dx, dy, v, g) {
  const X = Math.abs(dx), Y = -dy; // work in y-up
  if (X < 1) return null;          // straight up/down: raw aim is already right
  const v2 = v * v;
  const disc = v2 * v2 - 2 * v2 * Y * g - g * g * X * X;
  if (disc < 0) return null;       // unreachable — caller throws raw (the lob)
  const tan = (v2 - Math.sqrt(disc)) / (g * X);
  const th = Math.atan(tan);
  return { hvx: Math.sign(dx) * v * Math.cos(th), hvy: -v * Math.sin(th) };
}

/** Nearest point on segment (x1,y1)-(x2,y2) to (px,py).
 *  @returns {{dist, along}} perpendicular-ish distance, and how far along the
 *  segment that point sits — `along` is what orders the contestants, so an
 *  anchor behind a wall we also hit this step loses to the wall. */
function segNearest(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  const cx = x1 + dx * t, cy = y1 + dy * t;
  return { dist: Math.hypot(px - cx, py - cy), along: Math.hypot(cx - x1, cy - y1) };
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
  const g = s.grapple;
  // Launcher inheritance: let go of a PLAYER you were reeling toward and
  // you take 80% of their velocity with you. A teammate who sprints away
  // as you release adds their speed to your shot — the same trade the old
  // boost jump asked for (timing with a partner), moved onto the line.
  const T = traversalFor(sim.scene.map);
  if (T.launcherInherit && g.phase === 'reeling' &&
      g.targetKind === 'entity' && g.targetId?.[0] === 'p') {
    const t = resolveTarget(sim, g.targetId);
    if (t?.body) {
      p.body.setVelocity(
        p.body.velocity.x + T.launcherInherit * t.body.velocity.x,
        p.body.velocity.y + T.launcherInherit * t.body.velocity.y);
    }
  }
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
