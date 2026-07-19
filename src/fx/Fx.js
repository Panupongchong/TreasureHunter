// ============================================================
// Fx.js — WP7 motion & juice (art-spec §3). RENDERING ONLY.
//
// Data-source law (plan risk 8, same law WorldHUD obeys): Fx may READ
// `.state` fields, map data, the session mirror, getWorldRow(), the
// per-frame grapple rows and its own derived kinematics. It never
// imports sim/ or systems/, never mutates `.state`, never emits an event
// and never touches net.*. Every visual below is keyed off an event kind
// that already existed in protocol.js or off a field the snapshot
// already writes back — WP7 adds no wire data.
//
// Three structural rules that keep it honest:
//
//  1. ALLOCATION HAPPENS IN THE CONSTRUCTOR. Emitters, ring/ghost pools,
//     shared Graphics and the screen overlays are built once. Steady
//     state does zero `scene.add.*`, zero `new`, zero generateTexture.
//     GC pauses — not draw cost — are what break 60 fps on a mid laptop.
//
//  2. NOTHING THAT OWNS A PHYSICS BODY IS EVER SCALED OR ROTATED.
//     Arcade derives body size from the GameObject's transform scale, so
//     a squash tween on a body-owning object silently resizes the
//     hitbox. Player squash/stretch/stun-rotation target `p.art` (a
//     body-less child container); monsters and the relic get no scale
//     tween at all — their juice is particles, flashes and pooled ghost
//     sprites.
//
//  3. DROP, NEVER QUEUE. Above the tier threshold a burst returns
//     immediately. A dropped dust puff is invisible; one that arrives
//     400 ms late is a bug.
//
// Every public method is a no-op after destroy(). `scene.fx` may be
// undefined at any time — every call site uses optional chaining.
// ============================================================

import {
  FX, COLORS, UI, PLAYER, CLOCK, MONSTERS, GAME_WIDTH, GAME_HEIGHT,
} from '../config.js';
import { ensureTextures, slotColor } from './textures.js';
import { followLocal, updateLookahead } from './camera.js';

const SHAKE_RANK = { small: 1, medium: 2, large: 3, calamity: 4 };

// Debris palettes per barrier type (art-spec §3.4).
const DEBRIS_PALETTE = {
  door: [COLORS.wood, COLORS.woodDark, COLORS.metalBand],
  bridge: [COLORS.wood, COLORS.woodDark, COLORS.metalBand],
  rubble: [COLORS.rubbleA, COLORS.rubbleB, COLORS.rubbleC],
  shortcut: [COLORS.surface, COLORS.surfaceShade, COLORS.surfaceTop],
  crankGate: [COLORS.steelDark, COLORS.steelDeep, COLORS.steel],
};

export class Fx {
  /** @param {Phaser.Scene} scene GameScene, any mode */
  constructor(scene) {
    // Idempotent + guarded: ordering between the texture half and this
    // half can never break, whichever runs first.
    ensureTextures(scene);
    this.scene = scene;
    this._destroyed = false;

    this._tweens = new Set();
    this._timers = new Set();
    this._kin = new Map();      // view -> derived kinematics (§0.3)
    this._doorHp = new Map();   // door id -> last seen smashHp
    this._shake = { rank: 0, endsAt: 0 };
    this._escLevel = -1;
    this._look = { off: 0 };
    this._liveCached = 0;
    this.drops = 0;             // exposed for the F3 debug overlay

    this._buildEmitters();
    this._buildPools();
    this._buildOverlays();
    this._buildCollapseDecals();

    this.arcGfx = scene.add.graphics().setDepth(FX.depth.particle);
    this._arcFade = null;

    // Escalation truth on create: a scene restart, a mid-run joiner
    // replaying ESCALATION before its first snapshot, and normal
    // progression all converge here (§5.3).
    this.syncEscalation(scene.getWorldRow?.().esc ?? 0);
  }

  // ================= construction =================

  _buildEmitters() {
    const s = this.scene;
    const mk = (tex, cfg, screen = false) => {
      const e = s.add.particles(0, 0, tex, { emitting: false, quantity: 1, ...cfg });
      e.setDepth(FX.depth.particle);
      if (screen) e.setScrollFactor(0).setDepth(FX.depth.tint + 1);
      return e;
    };
    this.em = {
      // fast sparks — grapple attach, dagger hits, relic pips
      sparkFast: mk('px2', { speed: { min: 80, max: 220 }, lifespan: { min: 150, max: 200 }, gravityY: 0 }),
      // heavy sparks — hammer hits, monster hits, monster death
      sparkHeavy: mk('px3', { speed: { min: 120, max: 260 }, lifespan: 250, gravityY: 600 }),
      // barrier debris — world gravity, spins, fades out over the tail
      debris: mk('debris4', {
        speed: { min: 150, max: 350 }, angle: { min: -150, max: -30 },
        lifespan: 700, gravityY: 1400, rotate: { start: 0, end: 720 },
        alpha: { start: 1, end: 0, ease: 'Quad.in' },
        scale: { min: 0.75, max: 1.5 },
      }),
      // soft dust — landings, sprint, footfalls, staggers
      dust: mk('puff8', {
        speed: { min: 40, max: 90 }, gravityY: -20, lifespan: { min: 400, max: 500 },
        scale: { start: 1, end: 1.6 }, alpha: { start: 0.35, end: 0 },
      }),
      // zip streaks
      streak: mk('px2', { speed: { min: 40, max: 80 }, lifespan: 150, gravityY: 0 }),
      // rising motes — tombstone wisps, exit portal dressing
      motes: mk('px2', { speed: { min: 20, max: 40 }, gravityY: -40, lifespan: 800, alpha: { start: 0.8, end: 0 } }),
      // relic flying shimmer
      shimmer: mk('px2', { speed: { min: 0, max: 20 }, lifespan: 250, gravityY: 0, alpha: { start: 1, end: 0 } }),
      // monster spawn telegraph — converge inward over the emerge window
      converge: mk('px2', { speed: { min: -180, max: -120 }, lifespan: MONSTERS.spawnEmergeMs / 2, gravityY: 0 }),
      // the ONE screen-space emitter: lose-screen falling debris
      debrisScreen: mk('debris4', {
        speedY: { min: 60, max: 220 }, speedX: { min: -40, max: 40 },
        lifespan: 2000, gravityY: 300, rotate: { start: 0, end: 540 },
        alpha: { start: 1, end: 0.2 },
      }, true),
    };
    this._emList = Object.values(this.em);
  }

  _buildPools() {
    const s = this.scene;
    // Ring pool (noise ripples, spawn bursts, pickup pops). Round-robin;
    // reusing a live ring kills its tween first.
    this._rings = [];
    for (let i = 0; i < FX.caps.rings; i++) {
      this._rings.push(s.add.graphics().setDepth(FX.depth.particle).setVisible(false));
    }
    this._ringI = 0;
    // Ghost pool — zip afterimages AND monster death pops. One pool, the
    // texture is set per use, so neither effect can allocate at runtime.
    this._ghosts = [];
    for (let i = 0; i < FX.caps.ghostPool; i++) {
      this._ghosts.push(s.add.image(0, 0, 'px2')
        .setDepth(FX.depth.particle - 1).setVisible(false));
    }
    this._ghostI = 0;
  }

  _buildOverlays() {
    const s = this.scene;
    const cx = GAME_WIDTH / 2, cy = GAME_HEIGHT / 2;
    const fix = (go, depth) => go.setScrollFactor(0).setDepth(depth)
      .setAlpha(0).setVisible(false);
    // Screen-space, NOT world-space: a 3200×1440 world rect costs 8× the
    // fill of a 960×540 screen one for an identical image.
    this.dimRect = fix(s.add.rectangle(cx, cy, GAME_WIDTH, GAME_HEIGHT, FX.dim.color), FX.depth.dim);
    this.collapseVig = fix(s.add.image(cx, cy, 'vignetteCollapse'), FX.depth.collapseVig);
    this.urgencyVig = fix(s.add.image(cx, cy, 'vignetteDanger'), FX.depth.urgencyVig);
    this.edgeVig = fix(s.add.image(cx, cy, 'vignetteDanger'), FX.depth.urgencyVig - 1);
    this.tintRect = fix(s.add.rectangle(cx, cy, GAME_WIDTH, GAME_HEIGHT, COLORS.danger), FX.depth.tint);
    this.wipeRect = fix(s.add.rectangle(cx, cy, GAME_WIDTH, GAME_HEIGHT, COLORS.bgDeep), FX.depth.wipe);
    this.flashRect = fix(s.add.rectangle(cx, cy, GAME_WIDTH, GAME_HEIGHT, COLORS.white), FX.depth.wipe + 1);
    // Escalation-1 relic halo (world space, pinned to the relic in update).
    this.relicEscGlow = s.add.image(0, 0, 'glow64')
      .setBlendMode(Phaser.BlendModes.ADD).setTint(COLORS.gold)
      .setScale(FX.glow.relicR * FX.glow.relicEscMult * 2 / 64)
      .setAlpha(FX.glow.relicEscAlpha)
      .setDepth(FX.depth.relic - 2).setVisible(false);
  }

  /**
   * Collapse-marked platforms (§5.4 "unstable, not collapsing"). The sim
   * never collapses anything — WP4 debt, deliberately unimplemented — so
   * rendering art-spec §3.10's crumble would advertise physics that does
   * not exist and teach players to distrust ground that is solid. What
   * ships instead is a structural-stress WARNING: a danger wash, a dashed
   * top-edge marking and a slow pebble drip. No splitting, no falling
   * pieces, no collider change.
   */
  _buildCollapseDecals() {
    const s = this.scene;
    this._marked = [];
    const idx = s.map.collapseIdx ?? [];
    if (!idx.length || !s.platforms) return;
    const kids = s.platforms.getChildren();
    this._collapseGfx = s.add.graphics().setDepth(FX.depth.decal).setVisible(false);
    for (const i of idx) {
      const ts = kids[i];
      if (!ts) continue;
      this._marked.push(ts);
      // 2 px dashed danger line along the top edge — drawn ONCE into one
      // static Graphics for every marked platform, never cleared.
      const [x, y, w] = s.map.platforms[i];
      this._collapseGfx.fillStyle(COLORS.danger, 0.5);
      for (let dx = 0; dx < w; dx += 10) {
        this._collapseGfx.fillRect(x + dx, y, Math.min(6, w - dx), 2);
      }
    }
    this._pebbleAt = 0;
  }

  // ================= small helpers =================

  _tw(cfg) {
    if (this._destroyed) return null;
    const done = cfg.onComplete;
    cfg.onComplete = (...a) => {
      this._tweens.delete(t);
      if (!this._destroyed && done) done(...a);
    };
    const t = this.scene.tweens.add(cfg);
    this._tweens.add(t);
    return t;
  }

  /**
   * Stop a tween we previously started, WITHOUT Phaser's killTweensOf.
   * Three effects share a player's `art` node (squash = scale, stun pose =
   * rotation, stagger = x). A blanket killTweensOf(art) stopped the other
   * two mid-flight, and Tween.stop() skips onComplete — so the node was
   * stranded at the interrupted value (a permanently squashed stunned
   * player) AND the tween stayed referenced in _tweens forever.
   * Each slot is killed and untracked independently instead.
   */
  _killSlot(node, slot) {
    const t = node?.[slot];
    if (t) {
      this._tweens.delete(t);
      if (t.isPlaying?.() || t.isActive?.()) t.stop();
      node[slot] = null;
    }
  }

  /**
   * killTweensOf + untrack. Phaser's stop() skips onComplete, which is
   * where _tw() removes the entry — so a pre-empted tween would sit in
   * _tweens until scene shutdown, growing all run and making the fxT
   * debug counter useless as a leak signal. Safe for single-owner nodes.
   */
  _killTweensOf(target) {
    this.scene.tweens.killTweensOf(target);
    const list = Array.isArray(target) ? target : [target];
    for (const t of [...this._tweens]) {
      const tt = t.targets || [];
      if (list.some((x) => tt.includes(x))) this._tweens.delete(t);
    }
  }

  _after(ms, fn) {
    if (this._destroyed) return null;
    const t = this.scene.time.delayedCall(ms, () => {
      this._timers.delete(t);
      if (!this._destroyed) fn();
    });
    this._timers.add(t);
    return t;
  }

  /** Camera-cull test: is (x,y) within the view inflated by FX.cullPad? */
  _onScreen(x, y) {
    const v = this.scene.cameras.main.worldView;
    return x >= v.x - FX.cullPad && x <= v.right + FX.cullPad &&
      y >= v.y - FX.cullPad && y <= v.bottom + FX.cullPad;
  }

  /**
   * The one budget gate. `tier` is 'T0' | 'T1' | 'T2'. Returns the number
   * of particles that may actually be emitted (0 = drop the burst).
   * Off-screen T1/T2 are dropped outright; off-screen T0 emits at half
   * count — a door smashing behind you should still cost something, but
   * you cannot see the pieces.
   */
  _budget(tier, count, x, y) {
    if (this._destroyed) return 0;
    const on = this._onScreen(x, y);
    if (!on) {
      if (tier !== 'T0') { this.drops++; return 0; }
      count = Math.ceil(count / 2);
    }
    const limit = FX.particleCap * FX.tier[tier];
    if (this._liveCached >= limit) { this.drops++; return 0; }
    const room = Math.max(0, Math.floor(limit - this._liveCached));
    const n = Math.min(count, room);
    if (n < count) this.drops++;
    this._liveCached += n; // optimistic — recomputed exactly next frame
    return n;
  }

  /** Emit from a pooled profile. Only tint + emission angle are mutated
   *  (both zero-allocation, and emission is synchronous so the mutation
   *  only affects this burst). */
  _emit(name, x, y, count, tint, angle) {
    const e = this.em[name];
    if (!e || count <= 0) return;
    if (tint != null && e.setParticleTint) e.setParticleTint(tint);
    if (angle && e.setEmitterAngle) e.setEmitterAngle(angle);
    e.emitParticleAt(x, y, count);
  }

  /** Expanding stroked ring from the pool. */
  _ring(x, y, r0, r1, color, width, ms, alpha0 = 0.85, delay = 0) {
    if (this._destroyed) return;
    const g = this._rings[this._ringI];
    this._ringI = (this._ringI + 1) % this._rings.length;
    this._killTweensOf(g);
    g.clear();
    g.setVisible(true).setAlpha(1);
    const st = { r: r0, a: alpha0 };
    this._tw({
      targets: st, r: r1, a: 0, duration: ms, delay, ease: 'Quad.out',
      onUpdate: () => {
        if (this._destroyed) return;
        g.clear();
        g.lineStyle(width, color, st.a);
        g.strokeCircle(x, y, st.r);
      },
      onComplete: () => { g.clear(); g.setVisible(false); },
    });
  }

  /** Pooled ghost sprite (zip afterimage / monster death pop). */
  _ghost(texture, x, y, opts = {}) {
    if (this._destroyed) return null;
    const g = this._ghosts[this._ghostI];
    this._ghostI = (this._ghostI + 1) % this._ghosts.length;
    this._killTweensOf(g);
    g.setTexture(texture).setPosition(x, y).setVisible(true)
      .setAlpha(opts.alpha ?? 0.22).setAngle(opts.angle ?? 0)
      .setScale(opts.scaleX ?? 1, opts.scaleY ?? 1)
      .setDepth(opts.depth ?? FX.depth.particle - 1);
    if (opts.tint != null) g.setTint(opts.tint); else g.clearTint();
    this._tw({
      targets: g, alpha: 0,
      scaleX: opts.toScaleX ?? (opts.scaleX ?? 1),
      scaleY: opts.toScaleY ?? (opts.scaleY ?? 1),
      duration: opts.ms ?? 240, ease: opts.ease ?? 'Linear',
      onComplete: () => g.setVisible(false),
    });
    return g;
  }

  /** Shake arbiter (art-spec §3.6). Sole owner of camera.shake. */
  shake(tier) {
    if (this._destroyed) return;
    const rank = SHAKE_RANK[tier] || 0;
    const now = this.scene.time.now;
    if (rank < this._shake.rank && now < this._shake.endsAt) return;
    const cfg = FX.shake[tier];
    if (!cfg) return;
    this._shake = { rank, endsAt: now + cfg.ms };
    this.scene.cameras.main.shake(cfg.ms, cfg.i);
  }

  /** Full-screen white flash. */
  _flash(ms = 120, alpha = 0.5) {
    const r = this.flashRect;
    this._killTweensOf(r);
    r.setVisible(true).setAlpha(alpha);
    this._tw({
      targets: r, alpha: 0, duration: ms,
      onComplete: () => r.setVisible(false),
    });
  }

  /** Screen-edge tint pulse (time cost / gain). */
  _edgePulse(color, alpha = 0.12, ms = 200) {
    const v = this.edgeVig;
    this._killTweensOf(v);
    v.setTint(color).setVisible(true).setAlpha(alpha);
    this._tw({
      targets: v, alpha: 0, duration: ms,
      onComplete: () => v.setVisible(false),
    });
  }

  /** Squash/stretch — ALWAYS on the art node, never the body owner. */
  _squash(view, sx, sy, ms, ease = 'Back.out') {
    const art = view?.art;
    if (!art) return;
    this._killSlot(art, '_fxSquash'); // scale only — leaves pose/stagger alone
    art.setScale(sx, sy);
    art._fxSquash = this._tw({
      targets: art, scaleX: 1, scaleY: 1, duration: ms, ease,
      onComplete: () => { art._fxSquash = null; },
    });
  }

  /** White tint-fill blink on a sprite child (never a container). */
  _whiteBlink(sprite, ms = 80) {
    if (!sprite?.setTintFill) return;
    // The stamp is what makes this survive: updatePlayerCosmetics runs
    // AFTER the event drain and calls setTint() unconditionally, which
    // resets tintFill — so a bare setTintFill here was cleared before the
    // frame ever rendered and the FF-heavy / revive flashes were
    // invisible in every mode. The cosmetics pass honours this deadline.
    sprite._fxFlashUntil = this.scene.time.now + ms;
    sprite.setTintFill(COLORS.white);
    this._after(ms, () => {
      sprite._fxFlashUntil = 0;
      sprite.clearTint?.();
    });
  }

  _localSlot() { return this.scene.session?.localSlot; }

  /** Client replay gate: suppress one-shots until SYNC_DONE, or a rejoin
   *  replay fires thirty explosions in one frame. Same guard WorldHUD
   *  .onMonsterSpawn already uses. */
  _live() {
    const s = this.scene;
    return s.mode !== 'client' || s.net?._replayDone === true;
  }

  // ================= camera =================

  /** (Re)attach the camera to the local view. Null-safe. */
  attachLocal(view) {
    if (this._destroyed) return;
    followLocal(this.scene, view || null);
  }

  // ================= per-frame =================

  update(dt) {
    if (this._destroyed) return;
    // ONE exact live-particle count per frame; bursts increment the
    // cached value optimistically instead of re-summing per burst.
    let live = 0;
    for (const e of this._emList) live += e.getAliveParticleCount();
    this._liveCached = live;

    const local = this.scene.players?.get(this._localSlot()) || null;
    updateLookahead(this.scene, local, this._look);

    this._updatePlayers(dt, local);
    this._updateRelic();
    this._updateWorldRow();
    this._updatePebbles();
  }

  _kinOf(view) {
    let k = this._kin.get(view);
    if (!k) {
      k = {
        x: view.x, y: view.y, vx: 0, vy: 0, vyPrev: 0,
        onGround: !!view.state.onGround, stunned: !!view.state.stunned,
        tLand: 0, tSprint: 0, tZip: 0,
      };
      this._kin.set(view, k);
    }
    return k;
  }

  _updatePlayers(dt, local) {
    const now = this.scene.time.now;
    // Zipping slots: derived from the beam rows GameScene already builds
    // every frame — no new data, and it is correct in every mode.
    const zipping = new Set();
    for (const b of this.scene._beamRows || []) zipping.add(b.slot);

    for (const [slot, p] of this.scene.players) {
      const k = this._kinOf(p);
      // A player added AFTER the escalation fired (rejoin) still needs its
      // glow — reconcile per frame instead of only on the level change.
      if (this._escLevel >= 1 && p.glow && !p.glow.visible) {
        p.glow.setVisible(true).setAlpha(FX.glow.playerAlpha);
      }
      if (dt > 0) {
        k.vyPrev = k.vy;
        k.vx = (p.x - k.x) / dt;
        k.vy = (p.y - k.y) / dt;
      }
      k.x = p.x; k.y = p.y;
      const s = p.state;

      // ---- landing / takeoff (art-spec §3.8) ----
      const og = !!s.onGround;
      if (og && !k.onGround) {
        const impact = Math.abs(k.vyPrev);
        if (impact >= FX.landSoftMin && now - k.tLand > FX.rates.landMs) {
          k.tLand = now;
          const hard = impact >= FX.landHardMin;
          // HARD_LANDING already carries its own dust+shake+squash, so a
          // hard landing here only pays the soft treatment when the event
          // did not fire (client-side derivation, monsters excluded).
          this._landDust(p, hard ? 8 : 4);
          this._squash(p, hard ? 1.30 : 1.22, hard ? 0.70 : 0.78, hard ? 200 : 160);
        }
      } else if (!og && k.onGround && k.vy < -50) {
        this._squash(p, 0.82, 1.18, 140, 'Quad.out');
      }
      k.onGround = og;

      // ---- stun pose (state-driven: correct on host, client and replay) ----
      const st = !!s.stunned;
      if (st !== k.stunned) {
        k.stunned = st;
        if (p.art) {
          this._killSlot(p.art, '_fxPose'); // rotation only
          p.art._fxPose = this._tw({
            targets: p.art,
            rotation: st ? (k.vx < 0 ? -Math.PI / 2 : Math.PI / 2) : 0,
            duration: st ? 200 : 120, ease: 'Quad.out',
            onComplete: () => { p.art._fxPose = null; },
          });
        }
      }

      // ---- sprint dust (T2) ----
      if (s.sprinting && og && now - k.tSprint > FX.rates.sprintMs) {
        k.tSprint = now;
        const n = this._budget('T2', FX.caps.sprintDust, p.x, p.y);
        this._emit('dust', p.x - s.facing * 6, p.y + PLAYER.height / 2, n, COLORS.inkDim);
      }

      // ---- zip trail (T2): afterimages + streaks opposite velocity ----
      const speed = Math.hypot(k.vx, k.vy);
      if (zipping.has(slot) && speed > FX.zipSpeedMin && now - k.tZip > FX.rates.zipMs) {
        k.tZip = now;
        if (this._onScreen(p.x, p.y)) {
          this._ghost(`playerGhost${slot % 4}`, p.x, p.y, { alpha: 0.22, ms: 240 });
        }
        const n = this._budget('T2', FX.caps.zipStreaks, p.x, p.y);
        const a = Math.atan2(-k.vy, -k.vx) * 180 / Math.PI;
        this._emit('streak', p.x, p.y, n, slotColor(slot), { min: a - 20, max: a + 20 });
      }
    }
    // Drop kinematics for views that are gone (tombstone, kick, restart).
    if (this._kin.size > this.scene.players.size + 2) {
      for (const view of this._kin.keys()) {
        if (!view.scene) this._kin.delete(view);
      }
    }
  }

  _landDust(p, count) {
    const n = this._budget('T1', Math.min(count, FX.caps.landDust), p.x, p.y);
    this._emit('dust', p.x, p.y + PLAYER.height / 2, n, COLORS.inkDim);
  }

  _updateRelic() {
    const rel = this.scene.relic;
    if (!rel) return;
    const now = this.scene.time.now;
    if (this.relicEscGlow.visible) this.relicEscGlow.setPosition(rel.x, rel.y);
    if (rel.state.rs === 'flying') {
      this._shimmerAt ??= 0;
      if (now - this._shimmerAt > FX.rates.shimmerMs) {
        this._shimmerAt = now;
        const n = this._budget('T2', 1, rel.x, rel.y);
        this._emit('shimmer', rel.x, rel.y, n, COLORS.gold);
      }
    }
  }

  _updateWorldRow() {
    const row = this.scene.getWorldRow?.();
    if (!row) return;
    this.syncEscalation(row.esc || 0);
    // ≤30 s urgency vignette (art-spec §3.10). Screen space, depth 95.
    const urgent = row.clock > 0 && row.clock <= 30000;
    if (urgent) {
      const t = this.scene.time.now / 1000;
      this.urgencyVig.setVisible(true)
        .setAlpha(0.10 + 0.05 * Math.sin(t * Math.PI * 2));
    } else if (this.urgencyVig.visible) {
      this.urgencyVig.setVisible(false).setAlpha(0);
    }
  }

  _updatePebbles() {
    if (this._escLevel < 2 || !this._marked.length) return;
    const now = this.scene.time.now;
    if (now - this._pebbleAt < FX.rates.pebbleMs) return;
    this._pebbleAt = now;
    const idx = this.scene.map.collapseIdx ?? [];
    for (let i = 0; i < idx.length; i++) {
      const [x, y, w, h] = this.scene.map.platforms[idx[i]];
      const px = x + Math.random() * w, py = y + h;
      const n = this._budget('T2', 1, px, py);
      this._emit('dust', px, py, n, COLORS.rubbleA);
    }
  }

  // ================= beams (art-spec §3.1) =================

  /**
   * Replaces the WP1 2 px line + square. 3 px slot-color body, 1 px ink
   * core, 7 px rotated diamond tip. One shared Graphics, cleared and
   * redrawn per frame — the same object count as before.
   */
  drawBeams(rows) {
    const g = this.scene.beamGfx;
    g.clear();
    if (this._destroyed) return;
    for (const b of rows) {
      const color = slotColor(b.slot);
      g.lineStyle(3, color, 0.95);
      g.lineBetween(b.x, b.y, b.tx, b.ty);
      g.lineStyle(1, COLORS.ink, 0.6);
      g.lineBetween(b.x, b.y, b.tx, b.ty);
      // hook tip: diamond rotated to the beam angle, 2 px outline
      const a = Math.atan2(b.ty - b.y, b.tx - b.x);
      const r = 3.5, ca = Math.cos(a), sa = Math.sin(a);
      const pt = (dx, dy) => ({ x: b.tx + dx * ca - dy * sa, y: b.ty + dx * sa + dy * ca });
      const pts = [pt(r, 0), pt(0, r), pt(-r, 0), pt(0, -r)];
      g.fillStyle(color, 1);
      g.fillPoints(pts, true);
      g.lineStyle(2, COLORS.outline, 1);
      g.strokePoints(pts, true, true);
    }
  }

  // ================= escalation (§5) =================

  /**
   * MONOTONIC by contract (protocol.js: ESCALATION is "emitted ONCE per
   * level (monotonic)"), and that matters: the ESCALATION event and the
   * snapshot world row are two views of the same fact arriving at
   * different times. On a client the ctl event lands BEFORE the 20 Hz
   * snapshot that raises `esc`, so a sync that could LOWER the level
   * would tween the lights down, snap them back up on the next frame,
   * and flicker. Levels only ever rise; a scene restart builds a fresh
   * Fx, which is the one and only reset.
   */
  syncEscalation(level) {
    if (this._destroyed || level <= this._escLevel) return;
    this._escLevel = level;
    this._applyEsc(level, false);
  }

  /** ESCALATION event → the animated transition, then the resting state. */
  onEscalation(level) {
    if (this._destroyed || level <= this._escLevel) return;
    this._escLevel = level;
    this._applyEsc(level, true);
  }

  _applyEsc(level, animate) {
    // Level 1 — lights dim + per-player glow + relic glow up.
    if (level >= 1) {
      this.dimRect.setVisible(true);
      if (animate) {
        this._tw({
          targets: this.dimRect, alpha: FX.dim.alpha,
          duration: FX.dim.ms, ease: 'Quad.inOut',
        });
      } else {
        this.dimRect.setAlpha(FX.dim.alpha);
      }
      for (const [, p] of this.scene.players) {
        p.glow?.setVisible(true).setAlpha(FX.glow.playerAlpha);
      }
      // The relic's OWN glow is rewritten by updateRelicCosmetics every
      // frame, so bumping it here would be overwritten instantly. Fx
      // instead owns a second, larger additive halo that it pins to the
      // relic — no cross-file coupling, no per-frame fight.
      this.relicEscGlow.setVisible(true);
    } else {
      this.dimRect.setVisible(false).setAlpha(0);
      this.relicEscGlow.setVisible(false);
      for (const [, p] of this.scene.players) p.glow?.setVisible(false).setAlpha(0);
    }

    // Level 2 — collapse vignette + the §5.4 platform warning treatment.
    if (level >= 2) {
      this.collapseVig.setVisible(true);
      if (animate) this._tw({ targets: this.collapseVig, alpha: 1, duration: 800 });
      else this.collapseVig.setAlpha(1);
      this._collapseGfx?.setVisible(true);
      for (const ts of this._marked) {
        // A wash, not a flash: tint toward danger and leave it there.
        ts.setTint(0xc06068);
      }
    } else {
      this.collapseVig.setVisible(false).setAlpha(0);
      this._collapseGfx?.setVisible(false);
      for (const ts of this._marked) ts.clearTint();
    }
  }

  // ================= one-shot event hooks =================

  onGrappleAttach(ev) {
    if (!this._live()) return;
    const n = this._budget('T0', 6, ev.x, ev.y);
    this._emit('sparkFast', ev.x, ev.y, n, COLORS.ink);
  }

  onGrappleDetach(ev) {
    if (!this._live()) return;
    if (ev.reason !== 'caught') return;
    const rel = this.scene.relic;
    if (!rel) return;
    const n = this._budget('T1', 4, rel.x, rel.y);
    this._emit('sparkFast', rel.x, rel.y, n, COLORS.gold);
  }

  onHit(ev) {
    if (!this._live()) return;
    const x = ev.x, y = ev.y;
    if (ev.slot === -1) {                       // a monster dealt it
      this._emit('sparkHeavy', x, y, this._budget('T0', 8, x, y), COLORS.danger);
      this.shake('small');
    } else if (ev.weapon === 'dagger') {
      this._emit('sparkFast', x, y, this._budget('T0', 4, x, y), COLORS.ink);
    } else {                                    // hammer / body slam
      const tint = ev.weapon === 'body' ? slotColor(ev.slot ?? 0) : COLORS.ink;
      this._emit('sparkHeavy', x, y, this._budget('T0', 5, x, y), tint);
      this._emit('sparkHeavy', x, y, this._budget('T0', 3, x, y), COLORS.noise);
      this.shake('small');
    }
    // FF heavy: white flash on the victim so "I just hammered a friend"
    // is unmissable. Victim resolved from targetId, which already exists.
    if (ev.ff && ev.weapon === 'hammer') {
      for (const [, p] of this.scene.players) {
        if (Math.abs(p.x - x) < 40 && Math.abs(p.y - y) < 44) this._whiteBlink(p.body_, 60);
      }
    }
  }

  onSwing(ev) {
    if (!this._live()) return;
    const p = this.scene.players.get(ev.slot);
    if (!p || !this._onScreen(p.x, p.y)) return;
    const hammer = ev.weapon !== 'dagger';
    const r = hammer ? 30 : 20;
    const spread = (hammer ? 90 : 50) * Math.PI / 180;
    const base = p.state.facing < 0 ? Math.PI : 0;
    const g = this.arcGfx;
    g.clear();
    g.lineStyle(hammer ? 4 : 2, COLORS.ink, 0.5);
    g.beginPath();
    g.arc(p.x, p.y, r, base - spread / 2, base + spread / 2);
    g.strokePath();
    g.setAlpha(1);
    this._killTweensOf(g);
    this._tw({
      targets: g, alpha: 0, duration: hammer ? 120 : 80,
      onComplete: () => g.clear(),
    });
  }

  onDoorState(ev) {
    const d = this.scene.doors?.get(ev.id);
    if (!d || !this._live()) return;
    const type = d.state.type || 'door';
    const pal = DEBRIS_PALETTE[type] || DEBRIS_PALETTE.door;
    const prev = this._doorHp.get(ev.id);
    this._doorHp.set(ev.id, ev.smashHp);

    if (ev.state === 'broken') {
      const full = type === 'rubble' ? FX.caps.debrisRubble : FX.caps.debrisDoor;
      for (let i = 0; i < pal.length; i++) {
        const n = this._budget('T0', Math.ceil(full / pal.length), d.x, d.y);
        this._emit('debris', d.x, d.y, n, pal[i]);
      }
      this._emit('dust', d.x, d.y, this._budget('T1', 6, d.x, d.y), COLORS.inkDim);
      this.shake(type === 'rubble' ? 'large' : 'medium');
      return;
    }
    // A damage hit: DOOR_STATE already carries smashHp on EVERY hit, so
    // "took a hit" is derivable — no new event, no new payload field.
    if (prev == null || ev.smashHp >= prev) return;
    const now = this.scene.time.now;
    this._doorFxAt ??= new Map();
    if (now - (this._doorFxAt.get(ev.id) ?? -1e9) < FX.rates.doorDebrisMs) return;
    this._doorFxAt.set(ev.id, now);
    const n = this._budget('T0', 6, d.x, d.y);
    this._emit('debris', d.x, d.y, n, pal[0]);
  }

  /**
   * Ripple size ∝ gauge fill added (art-spec §3.5): sprint ticks whisper,
   * door smashes scream. This REPLACES WorldHUD._ripple (events.js routes
   * to whichever exists) so there is exactly one ripple and one shake
   * owner.
   */
  onNoiseBurst(ev) {
    if (!this._live()) return;
    const amount = ev.amount || 0;
    const r1 = Math.min(6 + amount * 3, 90);
    if (!this._onScreen(ev.x, ev.y)) return;
    this._ring(ev.x, ev.y, 6, r1, COLORS.noise, 2, 350, 0.85);
    if (amount >= 15) this._ring(ev.x, ev.y, 6, r1, COLORS.noise, 3, 350, 0.7, 120);
    if (amount >= 30) {
      this._ring(ev.x, ev.y, 6, r1, COLORS.noise, 3, 350, 0.55, 240);
      this.shake('medium');
    }
  }

  onStun(ev) {
    if (!this._live()) return;
    const p = this.scene.players.get(ev.slot);
    if (!p) return;
    // The rotation + stars are state-driven (they must survive a rejoin
    // replay and a snapshot-only client); the event owns the impact.
    this._squash(p, 1.30, 0.70, 200);
    this._landDust(p, 10);
    if (ev.slot === this._localSlot()) this.shake('medium');
  }

  onRevive(ev) {
    if (!this._live()) return;
    const p = this.scene.players.get(ev.slot);
    if (p) this._whiteBlink(p.body_, 80);
  }

  onStaggered(ev) {
    if (!this._live()) return;
    const p = this.scene.players.get(ev.slot);
    if (!p) return;
    const n = this._budget('T1', 2, p.x, p.y);
    this._emit('dust', p.x, p.y + PLAYER.height / 2, n, COLORS.inkDim);
    if (p.art) {
      this._killSlot(p.art, '_fxStagger'); // x offset only
      p.art.x = 2;
      p.art._fxStagger = this._tw({
        targets: p.art, x: 0, duration: 60, ease: 'Bounce.out',
        onComplete: () => { p.art._fxStagger = null; },
      });
    }
  }

  onHardLanding(ev) {
    if (!this._live()) return;
    const p = this.scene.players.get(ev.slot);
    if (p) {
      this._landDust(p, FX.caps.landDust);
      this._squash(p, 1.30, 0.70, 200);
      this._kinOf(p).tLand = this.scene.time.now; // suppress the derived twin
    }
    if (ev.slot === this._localSlot()) this.shake('small');
  }

  // ---- monsters ----

  onMonsterSpawn(ev) {
    if (!this._live()) return;
    this._ring(ev.x, ev.y, 10, 40, COLORS.danger, 2, 150);
    this.shake('medium');
    // Art-spec §3.9 wants a 700 ms telegraph BEFORE the spawn. There is
    // no pre-spawn event and inventing one would be a protocol change, so
    // the telegraph runs CONCURRENTLY with the 800 ms emerge window — the
    // monster genuinely cannot move or attack during it, so readability
    // survives. Documented deviation.
    const n = this._budget('T0', 8, ev.x, ev.y);
    this._emit('converge', ev.x, ev.y, n, COLORS.danger, { min: 0, max: 360 });
    this._ring(ev.x, ev.y, 28, 8, COLORS.danger, 2, MONSTERS.spawnEmergeMs, 0.35);
  }

  onMonsterTelegraph(ev) {
    if (!this._live()) return;
    const m = this.scene.monsters?.get(ev.id);
    if (!m || !this._onScreen(m.x, m.y)) return;
    // NO scale tween on the monster: it owns the arcade body (art-spec's
    // (1.15,0.85) windup would resize the hitbox). The ground ring is the
    // readable cue instead, and the WP4 white windup blink still plays.
    const cfg = MONSTERS[m.state.type] || MONSTERS.skulker;
    this._ring(m.x, m.y + cfg.height / 2, 8, 22, COLORS.danger, 2, cfg.windupMs, 0.35);
    if (m.fistL) {
      // Tween an OFFSET, not the fists' y: updateMonsterCosmetics rewrites
      // fist positions from m.x/m.y every frame, so a direct y tween was
      // overwritten on the very next update and the art-spec §2.2 windup
      // rise never rendered. Cosmetics adds this offset and decays it.
      this._killSlot(m, '_fxFists');
      m._fistLift = 0;
      m._fxFists = this._tw({
        targets: m, _fistLift: -8, duration: 400, ease: 'Quad.out',
        onComplete: () => { m._fxFists = null; },
      });
    }
  }

  onMonsterAttack(ev) {
    if (!this._live()) return;
    const m = this.scene.monsters?.get(ev.id);
    if (!m) return;
    const n = this._budget('T1', 4, m.x, m.y);
    this._emit('dust', m.x, m.y + 12, n, COLORS.inkDim);
    if (m.state.type === 'brute') this.shake('small');
  }

  onMonsterFlinch(ev) {
    if (!this._live()) return;
    const m = this.scene.monsters?.get(ev.id);
    if (!m) return;
    const n = this._budget('T1', 3, m.x, m.y);
    this._emit('sparkFast', m.x, m.y, n, COLORS.white);
  }

  onMonsterDied(ev) {
    if (!this._live()) return;
    const m = this.scene.monsters?.get(ev.id);
    if (!m) return;
    if (ev.reason !== 'pitDeath') {
      const n = this._budget('T0', 8, m.x, m.y);
      this._emit('sparkHeavy', m.x, m.y, n, COLORS.danger);
    }
    // The death pop is a POOLED GHOST of the monster texture, not a scale
    // tween on the monster: the monster still owns its arcade body during
    // the `dying` window and MonsterSystem's pit test reads its center.
    if (this._onScreen(m.x, m.y)) {
      this._ghost(m.texture.key, m.x, m.y, {
        alpha: 0.8, scaleX: 1, scaleY: 1, toScaleX: 1.5, toScaleY: 0.5,
        ms: MONSTERS.dyingMs, depth: FX.depth.particle, ease: 'Quad.out',
      });
    }
  }

  onDespawn(ev) {
    if (!this._live()) return;
    if (ev.etype === 'hourglass') {
      const pk = this.scene.pickups?.get(ev.id);
      if (!pk) return;
      this._flash(80, 0.25);
      this._ring(pk.x, pk.y, 8, 28, COLORS.quiet, 2, 250);
    }
  }

  // ---- relic / pickups / tombstones ----

  onRelicState(ev) {
    if (!this._live()) return;
    const rel = this.scene.relic;
    if (!rel) return;
    const x = ev.x ?? rel.x, y = ev.y ?? rel.y;
    const name = rel.state.rs;
    if (name === 'bagged') this._ring(x, y, 8, 20, COLORS.gold, 2, 200);
    else if (name === 'held') this._emit('sparkFast', x, y, this._budget('T1', 4, x, y), COLORS.gold);
    else if (name === 'loose') {
      this._emit('sparkFast', x, y, this._budget('T1', 6, x, y), COLORS.gold);
      this._emit('dust', x, y, this._budget('T2', 2, x, y), COLORS.inkDim);
    }
  }

  onPickupUsed(ev) {
    if (!this._live()) return;
    const pk = this.scene.pickups?.get(ev.id);
    if (!pk) return;
    this._ring(pk.x, pk.y, 8, 46, COLORS.white, 3, 200, 0.5);
    const n = this._budget('T0', 12, pk.x, pk.y);
    this._emit('sparkHeavy', pk.x, pk.y, n, COLORS.stun);
  }

  onTombstone(ev) {
    if (!this._live()) return;
    const n = this._budget('T1', 6, ev.x, ev.y);
    this._emit('motes', ev.x, ev.y, n, slotColor(ev.slot));
  }

  onTombstoneState(ev) {
    if (!this._live()) return;
    const ts = this.scene.tombstones?.get('t' + ev.slot);
    if (!ts) return;
    const n = this._budget('T2', 4, ts.x, ts.y);
    this._emit('motes', ts.x, ts.y, n, COLORS.gold);
  }

  onRejoined(ev) {
    const p = this.scene.players?.get(ev.slot);
    if (!p) return;
    this._ring(p.x, p.y, 10, 36, slotColor(ev.slot), 2, 250);
    if (ev.slot === this._localSlot()) this.attachLocal(p);
  }

  onReadyComplete() {
    this._flash(120, 0.5);
  }

  /** TIME_COST (sign −1) / TIME_GAIN (sign +1). The −0:20 float itself is
   *  the UIScene catalog's (§7.1, shipped); Fx adds only the edge pulse. */
  onTimeDelta(sign) {
    if (!this._live()) return;
    this._edgePulse(sign < 0 ? COLORS.noise : COLORS.quiet, 0.12, 200);
  }

  onRunOver(ev) {
    this.scene.cameras.main.stopFollow();
    if (ev.result === 'win') {
      // Vault-door slam: bgDeep wipes DOWN over 250 ms, landing under the
      // results overlay (a separate scene, rendered above GameScene).
      const r = this.wipeRect;
      r.setVisible(true).setAlpha(1).setScale(1, 0);
      r.y = 0;
      r.setOrigin(0.5, 0);
      this._tw({ targets: r, scaleY: 1, duration: 250, ease: 'Quad.in' });
      return;
    }
    // Lose: calamity shake outranks everything, danger tint, falling debris.
    this.shake('calamity');
    const t = this.tintRect;
    t.setVisible(true).setAlpha(0);
    this._tw({ targets: t, alpha: 0.35, duration: 600 });
    for (let i = 0; i < FX.caps.loseDebris; i++) {
      this.em.debrisScreen.setParticleTint?.(COLORS.rubbleB);
      this.em.debrisScreen.emitParticleAt(Math.random() * GAME_WIDTH, -20, 1);
    }
  }

  /** Screen-space confetti for a WIN results screen. Allocated on demand,
   *  destroyed on completion — never live during gameplay. */
  confettiBurst() {
    if (this._destroyed) return;
    const cols = [...PLAYER.colors, COLORS.gold];
    for (let i = 0; i < FX.caps.confetti; i++) {
      const r = this.scene.add.rectangle(
        Math.random() * GAME_WIDTH, -10 - Math.random() * 120, 3, 6,
        cols[i % cols.length]).setScrollFactor(0).setDepth(FX.depth.wipe + 2);
      this._tw({
        targets: r,
        y: GAME_HEIGHT + 40,
        x: r.x + (Math.random() - 0.5) * 160,
        angle: (Math.random() - 0.5) * 1440,
        duration: 2500 + Math.random() * 800,
        ease: 'Quad.in',
        onComplete: () => r.destroy(),
      });
    }
  }

  // ================= teardown =================

  /**
   * Phase restarts cycle GameScene constantly (menu→lobby→run→results→
   * lobby→run…), so a leak here shows up as an fps decay ACROSS ROUNDS
   * rather than within one. Everything Fx created is either a scene child
   * (dies with the scene) or a tween/timer, which are NOT scene children
   * in the sense that matters — they must be killed explicitly.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const t of this._tweens) { try { t.remove(); } catch { /* already gone */ } }
    this._tweens.clear();
    for (const t of this._timers) { try { t.remove(false); } catch { /* already gone */ } }
    this._timers.clear();
    // destroy() runs from the scene 'shutdown' handler, by which point
    // Phaser has already torn down parts of the scene (cameras.main is
    // gone, emitters may be destroyed). Every teardown step is guarded so
    // a restart can never throw out of the shutdown chain — that would
    // strand the NEXT create().
    for (const e of this._emList) {
      try { e.stop(); e.killAll(); } catch { /* already destroyed */ }
    }
    this._kin.clear();
    this._doorHp.clear();
    try { this.scene.cameras?.main?.stopFollow(); } catch { /* camera gone */ }
    this.scene.fx = null;
  }
}
