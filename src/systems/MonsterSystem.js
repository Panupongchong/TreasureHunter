// ============================================================
// MonsterSystem — Skulker + Brute AI (plan WP4; tick position 8: after
// StunSystem, before DoorSystem). Monsters are a loudness tax, not
// bosses: chase-and-swipe / walk-block-smash, horizontal steering +
// jump probes only (plan risk 10 — no pathfinding).
//
// THE fragile invariant (combat spec decision 6): steering is an
// ACCEL-STEP toward a target vx, NEVER setVelocityX — this system runs
// after GrappleSystem, and a hard velocity write would erase grapple
// pull deltas every tick, silently breaking the Brute tug-of-war. The
// accel-step also IS the Brute's "braced legs" resistance (see
// config.MONSTERS.brute.accel).
//
// Monster stun = stunnedMs + ai:'stunned' ONLY (never a `stunned`
// boolean — grappleMass/D5 contract, see MonsterEntity header).
//
// Spawn feed: NoiseSystem pushes sim.spawnRequests at full gauge; this
// system drains them each tick (1-tick latency accepted), every
// bruteEveryN-th noise spawn is a Brute. Placement is never cheap:
// on-ground spot near the noise, ≥ spawnMinPlayerDist from every
// non-stunned player, + the 800 ms emerge state + telegraphed attacks.
// ============================================================

import { MONSTERS } from '../config.js';
import { EV } from '../net/protocol.js';
import { applyStun } from './StunSystem.js';
import { detachAll } from './GrappleSystem.js';
import { damageDoor } from './DoorSystem.js';
import { createMonster, destroyMonster } from '../entities/MonsterEntity.js';

const r = Math.round;

export class MonsterSystem {
  init(sim) {
    sim.monsterSys = this;      // CombatSystem discovery handle (kill())
    sim.spawnRequests ??= [];   // defensive; Sim ctor also initializes it
    this._nextId = 1;
    this._noiseSpawnCount = 0;
    this._respawns = [];        // lobby dummy respawn queue

    const scene = sim.scene;
    // ----- colliders (combat spec decision 7) -----
    scene.physics.add.collider(scene.monstersGroup, scene.platforms);
    if (scene.doorsGroup) {
      scene.physics.add.collider(scene.monstersGroup, scene.doorsGroup);
    }
    // Brute = solid corridor block (body pushable=false: players can't
    // shove it, grapple still moves it); Skulker = pass-through (damage
    // both ways is explicit box tests, never collider-driven). Arg order
    // is not trusted: the monster is whichever GO carries state.type.
    scene.physics.add.collider(scene.playersGroup, scene.monstersGroup, null,
      (a, b) => {
        const mo = a.state?.type ? a : b;
        return mo.state?.type === 'brute' && mo.body.enable;
      });

    // Map-declared monsters (lobby dummy pen) are level furniture: the
    // client builds the same views from map data at scene create (like
    // doors/pickups), so NO spawn event is emitted for them.
    for (const def of scene.map.monsterSpawns ?? []) {
      this._spawnAt(sim, def.type, def.x, def.y, {
        id: def.id, dummy: !!def.dummy, fromMap: true, spawnDef: { x: def.x, y: def.y },
      });
    }
  }

  // ---------------- lifecycle ----------------

  _spawnAt(sim, type, x, y, opts = {}) {
    const id = opts.id ?? ('m' + this._nextId++); // 'm<n>' — the wire id
    const m = createMonster(sim.scene, id, type, x, y, true, opts);
    sim.scene.monstersGroup.add(m);
    sim.monsters.set(id, m);       // the Map KEY is the wire id (grapple contract)
    sim.scene.monsters.set(id, m); // shared view map → one cosmetics path
    if (!opts.fromMap) {
      sim.emit({ kind: EV.SPAWN, id, etype: 'monster', mtype: type, x: r(x), y: r(y) });
    }
    return m;
  }

  /**
   * Start the death sequence (CombatSystem calls this on hp<=0; pit rects
   * call it too). Body off immediately: dynamicTargets stops yielding it
   * and beams on it drop.
   * @param {string} reason 'died'|'pitDeath'|'faded'
   */
  kill(sim, id, reason, bySlot = null, weapon = null) {
    const m = sim.monsters.get(id);
    if (!m || m.state.ai === 'dying') return;
    m.state.ai = 'dying';
    m.state.aiTimerMs = MONSTERS.dyingMs;
    m.state.deathReason = reason;
    m.body.enable = false;
    detachAll(sim, id, 'targetGone');
    sim.emit({ kind: EV.MONSTER_DIED, id, bySlot, weapon, reason });
  }

  _despawn(sim, id) {
    const m = sim.monsters.get(id);
    const s = m.state;
    sim.emit({
      kind: EV.DESPAWN, id, etype: 'monster',
      reason: s.deathReason ?? 'died', x: r(m.x), y: r(m.y),
    });
    sim.monsters.delete(id);
    sim.scene.monsters.delete(id);
    destroyMonster(m);
    if (s.dummy && s.spawnDef) { // lobby practice never runs dry
      this._respawns.push({
        msLeft: MONSTERS.dummyRespawnMs, id: s.id, type: s.type,
        x: s.spawnDef.x, y: s.spawnDef.y,
      });
    }
  }

  // ---------------- tick ----------------

  update(sim, dt) {
    const ms = dt * 1000;

    // 1) consume spawn requests (NoiseSystem pushed at full gauge)
    while (sim.spawnRequests.length) {
      const req = sim.spawnRequests.shift();
      this._noiseSpawnCount++;
      const type = (this._noiseSpawnCount % MONSTERS.bruteEveryN === 0)
        ? 'brute' : 'skulker';
      const [x, y] = this._placeSpawn(sim, req.x, req.y, type);
      this._spawnAt(sim, type, x, y, {});
    }

    // 1b) lobby dummy respawns (SPAWN event re-creates the client view)
    for (let i = this._respawns.length - 1; i >= 0; i--) {
      const rq = this._respawns[i];
      rq.msLeft -= ms;
      if (rq.msLeft <= 0) {
        this._respawns.splice(i, 1);
        this._spawnAt(sim, rq.type, rq.x, rq.y,
          { id: rq.id, dummy: true, spawnDef: { x: rq.x, y: rq.y } });
      }
    }

    // 2) thrown/yanked-player impact stun (explicit check, no collider)
    for (const [, m] of sim.monsters) {
      const s = m.state;
      if (s.stunnedMs > 0 || s.ai === 'dying' || s.ai === 'spawn') continue;
      for (const [, p] of sim.players) {
        if (!p.body?.enable) continue;
        if (Math.hypot(p.body.velocity.x, p.body.velocity.y) < MONSTERS.impactStunSpeed) continue;
        if (!this._bodiesOverlap(p.body, m.body)) continue;
        s.stunnedMs = MONSTERS.impactStunMs;
        s.ai = 'stunned';
        sim.emit({
          kind: EV.HIT, slot: p.state.slot, weapon: 'body',
          targetKind: 'monster', targetId: s.id, x: r(m.x), y: r(m.y), ff: false,
        });
        break;
      }
    }

    // 3) per-monster FSM (keys copied: _tick may despawn)
    for (const id of [...sim.monsters.keys()]) this._tick(sim, id, ms, dt);
  }

  _tick(sim, id, ms, dt) {
    const m = sim.monsters.get(id);
    const s = m.state;
    const cfg = MONSTERS[s.type];
    s.aiTimerMs -= ms;
    s.stunnedMs = Math.max(0, s.stunnedMs - ms);
    s.attackCdMs = Math.max(0, s.attackCdMs - ms);
    s.smashCdMs = Math.max(0, s.smashCdMs - ms);

    if (s.ai === 'dying') {
      if (s.aiTimerMs <= 0) this._despawn(sim, id);
      return;
    }
    // Pit death — Brute-baiting; Skulkers die in pits too (no special case).
    if (this._insidePit(sim, m)) return this.kill(sim, id, 'pitDeath');

    switch (s.ai) {
      case 'spawn': // emerge: hittable, can't move/attack
        this._steer(m, 0, cfg, dt);
        if (s.aiTimerMs <= 0) s.ai = 'idle';
        return;

      case 'stunned': // inert: gravity + grapple only, no steering drive
        if (s.stunnedMs <= 0) s.ai = 'idle';
        return;

      case 'idle':
        return this._idle(sim, m, cfg, ms, dt, id);

      case 'chase':
        return this._chase(sim, m, cfg, ms, dt, id);

      case 'windup': // telegraph: feet planted, facing locked
        this._steer(m, 0, cfg, dt);
        if (s.aiTimerMs <= 0) {
          s.ai = 'attack';
          s.aiTimerMs = cfg.activeMs;
          s.swungHit = false;
          sim.emit({ kind: EV.MONSTER_ATTACK, id });
        }
        return;

      case 'attack':
        this._steer(m, 0, cfg, dt);
        if (!s.swungHit) this._resolveSwipe(sim, m, cfg, id);
        if (s.aiTimerMs <= 0) {
          s.ai = 'chase';
          s.attackCdMs = cfg.cooldownMs;
        }
        return;

      case 'doorSmash':
        return this._doorSmash(sim, m, cfg, id, dt);
    }
  }

  // ---------------- states ----------------

  _idle(sim, m, cfg, ms, dt, id) {
    const s = m.state;
    if (s.dummy) { this._steer(m, 0, cfg, dt); return; } // lobby pen: stands there

    // Acquire: players first; Brute falls back to demolition duty.
    s.targetSlot = this._nearestPlayerSlot(sim, m, cfg.detectRadius);
    if (s.targetSlot === null && s.type === 'brute') {
      s.doorTargetId = this._nearestDoorId(sim, m, cfg.doorSeekRadius, cfg.range + 20);
    }
    if (s.targetSlot !== null || s.doorTargetId) {
      s.ai = 'chase';
      s.deaggroMs = 0;
      s.idleMs = 0;
      return;
    }

    // Wander; the Skulker tax expires if you actually go quiet.
    s.idleMs += ms;
    if (s.type === 'skulker' && s.idleMs >= cfg.despawnAfterIdleMs) {
      return this.kill(sim, id, 'faded');
    }
    s.wanderTurnMs -= ms;
    if (s.wanderTurnMs <= 0) {
      s.wanderDir = [-1, 0, 1][Math.floor(Math.random() * 3)];
      s.wanderTurnMs = cfg.wanderTurnMinMs +
        Math.random() * (cfg.wanderTurnMaxMs - cfg.wanderTurnMinMs);
    }
    if (s.wanderDir !== 0) {
      if ((s.wanderDir < 0 && m.body.blocked.left) ||
          (s.wanderDir > 0 && m.body.blocked.right)) {
        s.wanderDir = -s.wanderDir; // bounce off walls
      }
      s.facing = s.wanderDir;
    }
    this._steer(m, s.wanderDir * cfg.wanderSpeed, cfg, dt);
  }

  _chase(sim, m, cfg, ms, dt, id) {
    const s = m.state;
    let tx, ty;
    if (s.doorTargetId) {
      const d = sim.doors.get(s.doorTargetId);
      if (!d || d.state.state !== 'intact') {
        s.doorTargetId = null; s.ai = 'idle'; s.idleMs = 0; return;
      }
      // A player wandering into detection outranks the door.
      const ps = this._nearestPlayerSlot(sim, m, cfg.detectRadius);
      if (ps !== null) { s.targetSlot = ps; s.doorTargetId = null; return; }
      tx = d.x; ty = d.y;
    } else {
      const t = sim.players.get(s.targetSlot);
      // Never target/re-hit a stunned player (no stunlock, ever): on
      // target stun, retarget nearest non-stunned in detection, else idle.
      if (!t || !t.body.enable ||
          (MONSTERS.ignoreStunnedPlayers && t.state.stunned)) {
        s.targetSlot = this._nearestPlayerSlot(sim, m, cfg.detectRadius);
        if (s.targetSlot === null) { s.ai = 'idle'; s.idleMs = 0; }
        return;
      }
      tx = t.x; ty = t.y;
      // De-aggro: beyond detection ×1.6 continuously for holdMs → wander.
      if (Math.hypot(tx - m.x, ty - m.y) > cfg.detectRadius * MONSTERS.deaggroRangeMult) {
        s.deaggroMs += ms;
        if (s.deaggroMs >= MONSTERS.deaggroHoldMs) {
          s.targetSlot = null; s.ai = 'idle'; s.idleMs = 0; return;
        }
      } else {
        s.deaggroMs = 0;
      }
    }

    const dx = tx - m.x;
    s.facing = dx < 0 ? -1 : 1;
    const inReach = Math.abs(dx) <= cfg.range && Math.abs(ty - m.y) <= cfg.range + 20;
    if (inReach) {
      this._steer(m, 0, cfg, dt);
      if (s.doorTargetId) { s.ai = 'doorSmash'; return; }
      if (s.attackCdMs <= 0) {
        s.ai = 'windup';
        s.aiTimerMs = cfg.windupMs;
        // The telegraph contract: EVERY hit is preceded by this event for
        // the full windup (QA #4 audits it; WP7 readability hangs off it).
        sim.emit({ kind: EV.MONSTER_TELEGRAPH, id, type: s.type });
      }
      return;
    }
    this._steer(m, Math.sign(dx) * cfg.chaseSpeed, cfg, dt);
    // Skulker hop when horizontally blocked — the ONLY pathfinding allowed.
    if (s.type === 'skulker' && m.body.blocked.down &&
        ((dx < 0 && m.body.blocked.left) || (dx > 0 && m.body.blocked.right))) {
      m.body.setVelocityY(-cfg.hopVelocity);
    }
  }

  _doorSmash(sim, m, cfg, id, dt) {
    const s = m.state;
    const d = sim.doors.get(s.doorTargetId);
    if (!d || d.state.state !== 'intact') {
      s.doorTargetId = null; s.ai = 'idle'; s.idleMs = 0; return;
    }
    const ps = this._nearestPlayerSlot(sim, m, cfg.detectRadius);
    if (ps !== null) { s.targetSlot = ps; s.doorTargetId = null; s.ai = 'chase'; return; }
    if (Math.abs(d.x - m.x) > cfg.range * 1.5) { s.ai = 'chase'; return; } // knocked away
    this._steer(m, 0, cfg, dt);
    if (s.smashCdMs <= 0) {
      s.smashCdMs = cfg.doorHitIntervalMs;
      // damageDoor charges NO time for monster smashes (slot null path)
      // but the full noise burst on break — bait-demolition is intended.
      if (damageDoor(sim, d, cfg.doorDamage, { kind: 'monster', id })) {
        sim.emit({
          kind: EV.HIT, slot: -1, weapon: 'brute',
          targetKind: 'door', targetId: s.doorTargetId, x: r(d.x), y: r(d.y), ff: false,
        });
      }
    }
  }

  _resolveSwipe(sim, m, cfg, id) {
    const s = m.state;
    const x = s.facing === 1 ? m.body.x + m.body.width : m.body.x - cfg.range;
    const box = new Phaser.Geom.Rectangle(
      x, m.y - (cfg.height + 24) / 2, cfg.range, cfg.height + 24);
    for (const [, p] of sim.players) {
      if (!p.body?.enable) continue;
      if (MONSTERS.ignoreStunnedPlayers && p.state.stunned) continue; // never re-hit
      if (!Phaser.Geom.Intersects.RectangleToRectangle(box,
        new Phaser.Geom.Rectangle(p.body.x, p.body.y, p.body.width, p.body.height))) continue;
      s.swungHit = true; // one victim per swipe
      applyStun(sim, p, cfg.hitStunMs, 'monster'); // the ONE stun entry point
      p.body.velocity.x += s.facing * cfg.hitShove;
      sim.emit({
        kind: EV.HIT, slot: -1, weapon: s.type,
        targetKind: 'player', targetId: 'p' + p.state.slot,
        x: r(p.x), y: r(p.y), ff: false,
      });
      break;
    }
  }

  // ---------------- helpers ----------------

  /** Accel-step toward a target vx — NEVER setVelocityX (see header). */
  _steer(m, targetVx, cfg, dt) {
    const dv = targetVx - m.body.velocity.x;
    m.body.velocity.x += Math.sign(dv) * Math.min(Math.abs(dv), cfg.accel * dt);
  }

  _bodiesOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
           a.y < b.y + b.height && a.y + a.height > b.y;
  }

  _insidePit(sim, m) {
    for (const [px, py, pw, ph] of sim.scene.map.pits ?? []) {
      if (m.x >= px && m.x <= px + pw && m.y >= py && m.y <= py + ph) return true;
    }
    return false;
  }

  _nearestPlayerSlot(sim, m, radius) {
    let best = null, bestD = radius;
    for (const [slot, p] of sim.players) {
      if (!p.body?.enable) continue;
      if (MONSTERS.ignoreStunnedPlayers && p.state.stunned) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d <= bestD) { bestD = d; best = slot; }
    }
    return best;
  }

  /** Nearest intact SMASHABLE door (crankGate is hammer- and Brute-immune).
   *  vReach filters out vertically-unreachable doors: _chase's doorSmash
   *  transition requires |door.y - m.y| <= range + 20, and a Brute has no
   *  vertical movement — an unfiltered mid-air door (testMap d2) would
   *  park it underneath forever with no de-aggro path. */
  _nearestDoorId(sim, m, radius, vReach) {
    let best = null, bestD = radius;
    for (const [id, d] of sim.doors) {
      if (d.state.state !== 'intact' || d.state.smashHp === Infinity) continue;
      if (Math.abs(d.y - m.y) > vReach) continue;
      const dist = Math.hypot(d.x - m.x, d.y - m.y);
      if (dist <= bestD) { bestD = dist; best = id; }
    }
    return best;
  }

  /**
   * Spawn placement (feel spec §3, "never cheap"): nearest valid
   * on-ground spot near the noise focus, ≥ spawnMinPlayerDist from EVERY
   * non-stunned player, expanding outward in spawnStepPx probes; not
   * inside a pit. Falls back to the focus itself — spawning never fails.
   */
  _placeSpawn(sim, fx, fy, type) {
    const cfg = MONSTERS[type];
    const mapW = sim.scene.map.width ?? 960; // maps always set width; belt-and-braces
    const rects = sim.scene.platforms.getChildren().map((go) => go.getBounds());
    const maxK = Math.ceil((mapW / 2) / MONSTERS.spawnStepPx);
    for (let k = 0; k <= maxK; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const x = Phaser.Math.Clamp(fx + sign * k * MONSTERS.spawnStepPx, 20, mapW - 20);
        // Ground under x: prefer the nearest platform top at/below the focus.
        let top = null, bestScore = Infinity;
        for (const rc of rects) {
          if (x < rc.left || x > rc.right || rc.width < cfg.width) continue;
          const score = rc.top >= fy - 60 ? rc.top - fy : 1e6 + (fy - rc.top);
          if (score < bestScore) { bestScore = score; top = rc.top; }
        }
        if (top === null) continue;
        const y = top - cfg.height / 2 - 1;
        if (this._insidePit(sim, { x, y })) continue;
        let ok = true;
        for (const [, p] of sim.players) {
          if (p.state.stunned) continue;
          if (Math.hypot(p.x - x, p.y - y) < MONSTERS.spawnMinPlayerDist) { ok = false; break; }
        }
        if (ok) return [x, y];
      }
    }
    return [fx, fy]; // never fail (emerge + telegraph still give ~1.5 s warning)
  }
}
