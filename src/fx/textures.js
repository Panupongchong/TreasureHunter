// ============================================================
// fx/textures.js — WP7 procedural texture generation (TEXTURE HALF).
//
// EVERY pixel in the game is generated here, once, from Phaser Graphics
// + generateTexture. No external asset files, ever (CLAUDE.md).
//
// Lifecycle (technical-artist contract §3), two-layered on purpose:
//   1. module-level `_built` flag — fast path, one bool compare per
//      GameScene.restart() (which fires on EVERY phase change).
//   2. `scene.textures.exists(key)` per key — correct under Vite HMR,
//      where the module is re-evaluated against a LIVE TextureManager.
// Textures live on Phaser.Game.textures, NOT on the scene, so they
// survive lobby → playing → results → lobby indefinitely. We never call
// textures.remove(): a shutting-down scene's GameObjects may still hold
// a reference, and removal renders them as the green __MISSING frame.
//
// HARD RULE: generateTexture() is reachable ONLY from ensureTextures()
// and ensureBarrierTexture(). Any per-frame call is a defect (plan §WP7
// acceptance: 60 fps, no per-frame texture generation).
// ============================================================

import { COLORS, FX, PLAYER } from '../config.js';

let _built = false;

// ---------------- color helpers (single source of truth, §6) ----------------

/** Per-channel multiply, floored — the art-spec §1.1 "dark variant" rule.
 *  darken(0xffd23f, 0.55) === 0x8c7423 (spec's worked example). */
export function darken(int, k = FX.slotDarkMult) {
  const r = Math.floor(((int >> 16) & 0xff) * k);
  const g = Math.floor(((int >> 8) & 0xff) * k);
  const b = Math.floor((int & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}

/** int — world fills, tints, beams, particles. */
export function slotColor(slot) { return PLAYER.colors[slot % 4]; }

/** '#rrggbb' — Phaser Text styles. ui/HUD.js re-exports this one. */
export function slotColorStr(slot) {
  return '#' + slotColor(slot).toString(16).padStart(6, '0');
}

/** int — bags, accessories, engravings (slot color × 0.55). */
export function slotDark(slot) { return darken(slotColor(slot)); }

/** Deterministic 32-bit string hash — the ONLY randomness source in this
 *  module. Math.random() is banned here: host and client generate the
 *  same bitmaps independently, with zero coordination. */
export function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (xorshift32) seeded from hash(). */
function rng(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------- private drawing primitives ----------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Outlined rounded rect. Outline is drawn as a full-size filled shape,
 *  fill inset by `ow` — so every size in the recipes below is the OUTER
 *  silhouette INCLUDING the outline (contract §2.0). */
function roundRect(g, x, y, w, h, r, fill, ow = FX.outlineW, outline = COLORS.outline) {
  if (ow > 0) {
    g.fillStyle(outline, 1);
    if (r > 0) g.fillRoundedRect(x, y, w, h, r); else g.fillRect(x, y, w, h);
  }
  g.fillStyle(fill, 1);
  const ir = Math.max(0, r - ow);
  if (ir > 0) g.fillRoundedRect(x + ow, y + ow, w - ow * 2, h - ow * 2, ir);
  else g.fillRect(x + ow, y + ow, w - ow * 2, h - ow * 2);
}

function strip(g, x, y, w, h, color, alpha = 1) {
  g.fillStyle(color, alpha);
  g.fillRect(x, y, w, h);
}

function polygon(g, pts, color, alpha = 1) {
  g.fillStyle(color, alpha);
  g.fillPoints(pts.map(([px, py]) => ({ x: px, y: py })), true);
}

/** Outlined diamond (rhombus) with points at N/E/S/W of the box. */
function diamond(g, x, y, w, h, fill, ow = FX.outlineW) {
  const cx = x + w / 2, cy = y + h / 2;
  if (ow > 0) {
    polygon(g, [[cx, y], [x + w, cy], [cx, y + h], [x, cy]], COLORS.outline);
  }
  const rx = w / 2 - ow, ry = h / 2 - ow;
  polygon(g, [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]], fill);
  return { cx, cy, rx, ry };
}

/** Jagged 3-segment 1 px line — cracks, deterministic from `rand`. */
function crack(g, x0, y0, x1, y1, rand, color = COLORS.outline) {
  g.lineStyle(1, color, 1);
  const pts = [[x0, y0]];
  for (let i = 1; i < 3; i++) {
    const t = i / 3;
    const jx = (rand() - 0.5) * 6, jy = (rand() - 0.5) * 6;
    pts.push([x0 + (x1 - x0) * t + jx, y0 + (y1 - y0) * t + jy]);
  }
  pts.push([x1, y1]);
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.strokePath();
}

/** Radial falloff disc, white — tinted + additively blended at use site.
 *  64 px so a single texture serves every glow radius via setScale. */
function glowDisc(g, size) {
  const c = size / 2;
  const steps = 20;
  for (let i = steps; i >= 1; i--) {
    g.fillStyle(COLORS.white, 0.055);
    g.fillCircle(c, c, (c * i) / steps);
  }
}

/** Four gradient edge strips as N stacked 1-px-stepped rects per edge —
 *  Graphics has no gradient fill; stepping is invisible at these alphas. */
function vignette(g, w, h, color, peak) {
  const steps = 16;
  const tb = 64, lr = 48;
  for (let i = 0; i < steps; i++) {
    const t = 1 - i / steps;   // 1 at the edge → 0 inward
    // Bands are ADJACENT, not overlapping (yTop = i*bandT), so nothing
    // accumulates — each band's value IS its final alpha. The old
    // `/steps*4` divisor therefore capped the edge at peak/4 and the
    // collapse + urgency vignettes rendered at a quarter of the spec'd
    // strength (art-spec §1.4 / §3.10), i.e. invisible.
    const a = peak * t * t;
    const yTop = Math.round((i * tb) / steps);
    const bandT = Math.max(1, Math.round(tb / steps));
    g.fillStyle(color, a);
    g.fillRect(0, yTop, w, bandT);
    g.fillRect(0, h - yTop - bandT, w, bandT);
    const xL = Math.round((i * lr) / steps);
    const bandL = Math.max(1, Math.round(lr / steps));
    g.fillRect(xL, 0, bandL, h);
    g.fillRect(w - xL - bandL, 0, bandL, h);
  }
}

// ---------------- the static set ----------------

/**
 * Generate every static texture. Idempotent and ~0 ms after the first
 * call. Called as the FIRST statement of GameScene.create() so every
 * entry path (menu→lobby, lobby→playing, client join, rejoin replay) is
 * covered by construction.
 * @param {Phaser.Scene} scene
 */
export function ensureTextures(scene) {
  if (_built && scene.textures.exists('player0')) return;
  const g = scene.make.graphics({ add: false });
  const T = scene.textures;
  /** draw one key iff it does not already exist */
  const make = (key, w, h, draw) => {
    if (T.exists(key)) return;
    g.clear();
    draw(g);
    g.generateTexture(key, w, h);
  };

  // ---- 2.1 players -------------------------------------------------
  for (let s = 0; s < 4; s++) {
    const col = slotColor(s), dk = slotDark(s);
    make(`player${s}`, PLAYER.width, PLAYER.height, (gg) => {
      roundRect(gg, 0, 0, PLAYER.width, PLAYER.height, FX.cornerR, col);
      strip(gg, 2, PLAYER.height - 8, PLAYER.width - 4, 6, dk, 0.35);
    });
    // Ghost: fill-only silhouette for the §3.2 zip afterimage (Fx half).
    make(`playerGhost${s}`, PLAYER.width, PLAYER.height, (gg) => {
      gg.fillStyle(col, 1);
      gg.fillRoundedRect(0, 0, PLAYER.width, PLAYER.height, FX.cornerR);
    });
    make(`playerBag${s}`, 14, 16, (gg) => {
      roundRect(gg, 0, 0, 14, 16, FX.cornerR, dk);
      strip(gg, 0, 5, 14, 2, COLORS.outline);
    });
    make(`tombstone${s}`, 24, 30, (gg) => {
      // slab: rounded TOP corners only (bottom square)
      gg.fillStyle(COLORS.outline, 1);
      gg.fillRoundedRect(0, 0, 24, 30, { tl: 12, tr: 12, bl: 0, br: 0 });
      gg.fillStyle(COLORS.rubbleA, 1);
      gg.fillRoundedRect(2, 2, 20, 28, { tl: 10, tr: 10, bl: 0, br: 0 });
      gg.fillStyle(col, 1);
      gg.fillRoundedRect(8, 9, 8, 8, 2);            // engraving (0,-6 from center)
      strip(gg, 8, 21, 8, 2, COLORS.metalBand);
      strip(gg, 8, 25, 8, 2, COLORS.metalBand);
    });
  }
  make('playerEye', 8, 7, (gg) => {
    gg.fillStyle(COLORS.eyeWhite, 1);
    gg.fillRoundedRect(0, 0, 8, 7, 3);
    gg.fillStyle(COLORS.outline, 1);
    gg.fillRect(4, 1, 3, 4);                        // pupil, offset toward facing
  });
  make('playerEyeX', 8, 8, (gg) => {
    gg.lineStyle(2, COLORS.outline, 1);
    gg.lineBetween(0, 0, 8, 8);
    gg.lineBetween(8, 0, 0, 8);
  });
  make('playerBagGem', 6, 8, (gg) => diamond(gg, 0, 0, 6, 8, COLORS.gold, 1));
  make('tombstoneGem', 6, 8, (gg) => diamond(gg, 0, 0, 6, 8, COLORS.gold, 1));

  // ---- 2.2 monsters ------------------------------------------------
  const skulker = (legsUp) => (gg) => {
    // legs first (they hang below the capsule, behind its outline)
    for (let i = 0; i < 4; i++) {
      const lx = [3, 8, 14, 19][i];
      const up = legsUp && (i === 0 || i === 2) ? 2 : 0;
      strip(gg, lx, 14 - up, 2, 4, COLORS.dangerDark);
    }
    roundRect(gg, 0, 0, 22, 14, 7, COLORS.monster);
    gg.fillStyle(COLORS.white, 1);
    gg.fillRect(13, 4, 3, 3);                       // two small eyes = monster
    gg.fillRect(17, 4, 3, 3);                       // (players get ONE big eye)
  };
  make('skulker', 22, 18, skulker(false));
  make('skulkerLegsUp', 22, 18, skulker(true));
  // 48×56 = body (44×52) + the 2 px outline each side. Art-spec asks for
  // 56×64 over a 44×52 body; that overhangs 6 px per side — a hitbox lie
  // on the one entity whose identity is "walking terrain you route
  // around". Proportions preserved, silhouette honest (contract §9-B).
  make('brute', 48, 56, (gg) => {
    roundRect(gg, 0, 0, 48, 56, 2, COLORS.dangerDeep, FX.bruteOutlineW);
    strip(gg, 3, 12, 42, 4, COLORS.dangerDark);
    strip(gg, 3, 26, 42, 4, COLORS.dangerDark);
    strip(gg, 3, 42, 42, 4, COLORS.dangerDark);
    gg.fillStyle(COLORS.white, 1);
    gg.fillRect(24, 8, 5, 4);
    gg.fillRect(38, 8, 5, 4);
  });
  make('bruteFist', 14, 12, (gg) => roundRect(gg, 0, 0, 14, 12, 3, COLORS.dangerDark));

  // ---- 2.3 relic ---------------------------------------------------
  make('relic', 22, 28, (gg) => {
    const { cx, cy, rx, ry } = diamond(gg, 0, 0, 22, 28, COLORS.gold);
    // facet bands by y (top 7 goldLight / bottom 7 goldDark)
    const hwAt = (dy) => rx * (1 - dy / ry);
    const d = 5, hw = hwAt(d);
    polygon(gg, [[cx, cy - ry], [cx + hw, cy - d], [cx - hw, cy - d]], COLORS.goldLight);
    polygon(gg, [[cx - hw, cy + d], [cx + hw, cy + d], [cx, cy + ry]], COLORS.goldDark);
    gg.lineStyle(1, COLORS.goldFacet, 1);
    gg.lineBetween(cx - rx, cy, cx, cy - ry);
    gg.lineBetween(cx - rx, cy, cx, cy + ry);
    gg.lineBetween(cx + rx, cy, cx, cy - ry);
    gg.lineBetween(cx + rx, cy, cx, cy + ry);
  });
  make('relicGlint', 4, 4, (gg) => strip(gg, 0, 0, 4, 4, COLORS.white));

  // ---- 2.5 pickups / portal ---------------------------------------
  make('hourglass', 18, 24, (gg) => {
    polygon(gg, [[3, 4], [15, 4], [9, 11]], COLORS.goldLight);   // upper sand
    polygon(gg, [[9, 13], [15, 20], [3, 20]], COLORS.gold);      // lower sand
    strip(gg, 2, 0, 14, 3, COLORS.steel);                        // caps
    strip(gg, 2, 21, 14, 3, COLORS.steel);
    strip(gg, 2, 0, 2, 24, COLORS.steel);                        // struts
    strip(gg, 14, 0, 2, 24, COLORS.steel);
    gg.lineStyle(1, COLORS.outline, 1);
    gg.strokeRect(1.5, 0.5, 15, 23);
  });
  make('portalArch', 48, 76, (gg) => {
    gg.fillStyle(COLORS.outline, 1);
    gg.fillRect(0, 0, 48, 76);
    for (let i = 0; i < 5; i++) {                                // jambs
      gg.fillStyle(COLORS.surfaceTop, 1);
      gg.fillRect(1, 13 + i * 12 + 1, 6, 10);
      gg.fillRect(41, 13 + i * 12 + 1, 6, 10);
    }
    for (let i = 0; i < 3; i++) {                                // lintel
      gg.fillStyle(COLORS.surfaceTop, 1);
      gg.fillRect(9 + i * 10 + 1, 1, 8, 10);
    }
    gg.fillStyle(COLORS.bgDeep, 1);
    gg.fillRect(8, 12, 32, 64);                                  // inner void
  });
  make('portalRings', 48, 76, (gg) => {
    const rings = [[28, 56, 0.5], [20, 40, 0.3], [12, 24, 0.2]];
    for (const [w, h, a] of rings) {
      gg.lineStyle(2, COLORS.quiet, a);
      gg.strokeEllipse(24, 44, w, h);
    }
  });

  // ---- 2.6 terrain tiles -------------------------------------------
  const TS = FX.tile.size, CELL = FX.tile.cell;
  const brickTile = (cracked) => (gg) => {
    gg.fillStyle(COLORS.surface, 1);
    gg.fillRect(0, 0, TS, TS);
    gg.fillStyle(COLORS.surfaceSeam, 1);
    for (let y = CELL; y < TS; y += CELL) gg.fillRect(0, y, TS, 1);
    for (let row = 0; row < TS / CELL; row++) {
      const off = row % 2 ? CELL / 2 : 0;
      for (let x = off; x < TS; x += CELL) {
        if (x === 0) continue;
        gg.fillRect(x, row * CELL, 1, CELL);
      }
    }
    // 12 deterministic variation marks, each fully INSIDE its cell so
    // the tile stays seamless.
    const r = rng(hash('tileWall'));
    for (let i = 0; i < 12; i++) {
      const cxi = Math.floor(r() * (TS / CELL)), cyi = Math.floor(r() * (TS / CELL));
      const px = cxi * CELL + 4 + Math.floor(r() * (CELL - 12));
      const py = cyi * CELL + 4 + Math.floor(r() * (CELL - 10));
      if (i % 2) strip(gg, px, py, 4, 3, COLORS.surfaceShade);
      else strip(gg, px, py, 3, 2, COLORS.surfaceTop);
    }
    if (cracked) {
      const cr = rng(hash('tileWallCracked'));
      for (let q = 0; q < 4; q++) {
        const qx = (q % 2) * 64, qy = Math.floor(q / 2) * 64;
        crack(gg, qx + 10, qy + 8, qx + 50, qy + 56, cr);
      }
    }
  };
  make('tileWall', TS, TS, brickTile(false));
  make('tileWallCracked', TS, TS, brickTile(true));
  make('tileMid', TS, TS, (gg) => {
    gg.fillStyle(COLORS.bgMid, 1);
    gg.fillRect(0, 0, TS, TS);
    gg.fillStyle(COLORS.bgMidDetail, 1);
    for (let y = 0; y < TS; y += 24) gg.fillRect(0, y, TS, 1);
    for (let row = 0; row * 24 < TS; row++) {
      const off = row % 2 ? 24 : 0;
      for (let x = off; x < TS; x += 48) gg.fillRect(x, row * 24, 1, 24);
    }
  });
  make('tileFar', 256, 256, (gg) => {
    gg.fillStyle(COLORS.bgFar, 1);
    gg.fillRect(0, 0, 256, 256);
    gg.fillStyle(COLORS.bgFarDetail, 1);
    gg.fillRect(20, 0, 24, 256);                                 // pillars
    gg.fillRect(212, 0, 24, 256);
    gg.fillRect(68, 96, 120, 160);                               // arch body
    gg.fillCircle(128, 96, 60);                                  // arch top
  });

  // ---- 2.7 particles / overlays ------------------------------------
  for (const n of [2, 3, 4]) {
    make(`px${n}`, n, n, (gg) => strip(gg, 0, 0, n, n, COLORS.white));
  }
  make('debris4', 4, 4, (gg) => strip(gg, 0, 0, 4, 4, COLORS.white));
  make('puff8', 8, 8, (gg) => {
    gg.fillStyle(COLORS.white, 0.5); gg.fillCircle(4, 4, 4);
    gg.fillStyle(COLORS.white, 0.3); gg.fillCircle(4, 4, 3);
    gg.fillStyle(COLORS.white, 0.15); gg.fillCircle(4, 4, 2);
  });
  make('star8', 8, 8, (gg) => {
    polygon(gg, [[4, 0], [5.2, 2.8], [8, 4], [5.2, 5.2], [4, 8], [2.8, 5.2], [0, 4], [2.8, 2.8]],
      COLORS.stun);
  });
  make('glow64', 64, 64, (gg) => glowDisc(gg, 64));
  make('vignetteCollapse', 960, 540,
    (gg) => vignette(gg, 960, 540, FX.vignette.collapse, FX.vignette.alpha));
  make('vignetteDanger', 960, 540,
    (gg) => vignette(gg, 960, 540, FX.vignette.danger, FX.vignette.dangerAlpha));

  g.destroy();
  _built = true;
}

// ---------------- size-parameterized barriers (contract §2.4 / F1) ----------------

/** Both affordance tags derive from EXISTING config (DOORS.smashHp /
 *  DOORS.quietMs) — no new data, no new wire fields. */
function chevronTag(g, w) {
  const x = w - 16, y = 2;
  for (let i = 0; i < 3; i++) {
    polygon(g, [[x + i * 5, y + 8], [x + i * 5 + 4, y], [x + i * 5 + 6, y], [x + i * 5 + 2, y + 8]],
      i % 2 ? COLORS.outline : COLORS.noise);
  }
}

function keyholeTag(g, w, h) {
  const cx = 7, cy = Math.round(h / 2);
  g.fillStyle(COLORS.steel, 1);
  g.fillCircle(cx, cy - 2, 3);
  g.fillRect(cx - 1.5, cy, 3, 5);
}

function digTag(g, w, h) {
  const cx = 6, cy = Math.round(h / 2);
  g.fillStyle(COLORS.steel, 1);
  g.fillRect(cx - 4, cy - 3, 8, 2);
  g.fillRect(cx - 4, cy + 1, 8, 2);
}

/**
 * Barrier textures are generated from MAP DATA, not from art-spec's fixed
 * sizes — no map in the project matches those sizes (contract §F1: the
 * test map's barriers are 24×160 / 64×120, and `d0` is a VERTICAL
 * drawbridge). Recipes are re-expressed proportionally.
 *
 * Fully determined by (type, w, h, dmg) ⇒ host and client generate
 * identical bitmaps with zero coordination.
 *
 * @param {Phaser.Scene} scene
 * @param {'door'|'rubble'|'shortcut'|'bridge'|'crankGate'} type
 * @param {number} w @param {number} h
 * @param {0|1|2|'broken'} dmg
 * @returns {string} texture key
 */
export function ensureBarrierTexture(scene, type, w, h, dmg = 0) {
  const key = `bar:${type}:${w}x${h}:${dmg}`;
  if (scene.textures.exists(key)) return key;

  const g = scene.make.graphics({ add: false });
  const L = Math.max(w, h), S = Math.min(w, h);
  const vertical = h >= w;
  const rand = rng(hash(key));
  const intact = dmg === 0;
  const broken = dmg === 'broken';
  const ow = FX.outlineW;

  // Long-axis helpers: (l, s) → (x, y) in texture space.
  const P = vertical ? (l, s) => [s, l] : (l, s) => [l, s];
  const rectLS = (l, s, ll, ss, color, alpha = 1) => {
    const [x, y] = P(l, s);
    const [ww, hh] = vertical ? [ss, ll] : [ll, ss];
    strip(g, x, y, ww, hh, color, alpha);
  };

  switch (type) {
    case 'door': {
      if (broken) {
        rectLS(0, 0, L, 4, COLORS.woodDark);
        rectLS(0, S - 4, L, 4, COLORS.woodDark);
        break;
      }
      roundRect(g, 0, 0, w, h, 0, COLORS.wood);
      for (const f of [0.25, 0.5, 0.75]) {                        // plank seams
        rectLS(ow, Math.round(S * f), L - ow * 2, 1, COLORS.woodDark);
      }
      const band = clamp(Math.round(L * 0.08), 4, 8);
      for (const f of [0.18, 0.74]) {                             // metal bands
        const l = Math.round(L * f);
        rectLS(l, ow, band, S - ow * 2, COLORS.metalBand);
        for (const bf of [0.3, 0.7]) {
          const [bx, by] = P(l + Math.round(band / 2) - 1, Math.round(S * bf));
          strip(g, bx, by, 2, 2, COLORS.inkDim);
        }
      }
      if (dmg >= 1) crack(g, ...P(Math.round(L * 0.12), Math.round(S * 0.3)),
        ...P(Math.round(L * 0.52), Math.round(S * 0.6)), rand);
      if (dmg >= 2) {
        crack(g, ...P(Math.round(L * 0.9), Math.round(S * 0.7)),
          ...P(Math.round(L * 0.5), Math.round(S * 0.35)), rand);
        for (let i = 0; i < 3; i++) {                             // edge notches
          const l = Math.round(L * (0.2 + 0.3 * i) + rand() * 10);
          const [nx, ny] = P(l, i % 2 ? S - 3 : 0);
          strip(g, nx, ny, 3, 3, COLORS.outline);
        }
      }
      if (intact) { chevronTag(g, w); keyholeTag(g, w, h); }
      break;
    }
    case 'rubble': {
      if (broken) break;                                          // hidden; Fx leaves a scuff
      const circles = [];
      for (let i = 0; i < 7; i++) {
        const r = S * (0.20 + rand() * 0.16);
        circles.push([r + rand() * (w - 2 * r), r + rand() * (h - 2 * r), r]);
      }
      g.fillStyle(COLORS.outline, 1);                             // silhouette outline
      for (const [cx, cy, r] of circles) g.fillCircle(cx, cy, r + ow);
      const fills = [COLORS.rubbleA, COLORS.rubbleB, COLORS.rubbleC];
      circles.forEach(([cx, cy, r], i) => {
        g.fillStyle(fills[i % 3], 1);
        g.fillCircle(cx, cy, r);
      });
      for (let i = 0; i < 4; i++) {
        strip(g, 6 + rand() * (w - 12), 6 + rand() * (h - 12), 2, 2, COLORS.inkDim);
      }
      if (intact) { chevronTag(g, w); digTag(g, w, h); }
      break;
    }
    case 'shortcut': {
      if (broken) break;
      strip(g, 0, 0, w, h, COLORS.surface);
      rectLS(0, 0, L, 3, COLORS.surfaceTop);
      rectLS(0, S - 2, L, 2, COLORS.surfaceShade);
      // pre-cracked: the whole point of the type is "is it wall, or is it
      // breakable?" — two long cracks answer it at a glance.
      crack(g, ...P(Math.round(L * 0.1), Math.round(S * 0.25)),
        ...P(Math.round(L * 0.7), Math.round(S * 0.7)), rand);
      crack(g, ...P(Math.round(L * 0.35), Math.round(S * 0.8)),
        ...P(Math.round(L * 0.95), Math.round(S * 0.3)), rand);
      if (dmg >= 1) crack(g, ...P(Math.round(L * 0.2), Math.round(S * 0.9)),
        ...P(Math.round(L * 0.6), Math.round(S * 0.1)), rand);
      if (dmg >= 2) crack(g, ...P(Math.round(L * 0.55), Math.round(S * 0.05)),
        ...P(Math.round(L * 0.05), Math.round(S * 0.95)), rand);
      if (intact) { chevronTag(g, w); keyholeTag(g, w, h); }
      break;
    }
    case 'bridge': {
      if (broken) break;
      strip(g, 0, 0, w, h, COLORS.wood);
      g.lineStyle(1, COLORS.woodDark, 1);
      for (let l = 16; l < L; l += 16) {                          // slats ⟂ long axis
        const [sx, sy] = P(l, 0);
        if (vertical) g.lineBetween(0, sy, w, sy); else g.lineBetween(sx, 0, sx, h);
      }
      for (const l of [3, L - 7]) {                               // support pins
        rectLS(l, 3, 4, 4, COLORS.metalBand);
        rectLS(l, S - 7, 4, 4, COLORS.metalBand);
      }
      g.lineStyle(ow, COLORS.outline, 1);
      g.strokeRect(ow / 2, ow / 2, w - ow, h - ow);
      if (dmg >= 1) crack(g, ...P(Math.round(L * 0.2), 2), ...P(Math.round(L * 0.6), S - 2), rand);
      if (dmg >= 2) crack(g, ...P(Math.round(L * 0.85), 2), ...P(Math.round(L * 0.45), S - 2), rand);
      if (intact) { chevronTag(g, w); digTag(g, w, h); }
      break;
    }
    case 'crankGate': {
      if (broken) break;
      // Portcullis: transparent between the bars. You can SEE through a
      // portcullis — the bars are the only thing blocking you, and that
      // is a readability win in a corridor gate.
      for (const f of [0.12, 0.37, 0.62, 0.87]) {
        const x = Math.round(w * f) - 1;
        strip(g, x, 0, 3, h - 4, COLORS.steelDark);
        polygon(g, [[x, h - 4], [x + 3, h - 4], [x + 1.5, h]], COLORS.steelDark);
      }
      for (const f of [0.19, 0.5, 0.81]) {
        strip(g, 0, Math.round(h * f), w, 2, COLORS.steelDeep);
      }
      // NO chevron tag — crankGate is hammer-immune (DOORS.smashHp
      // Infinity). It DOES get the quiet tag: the crank IS the route.
      if (intact) keyholeTag(g, w, h);
      break;
    }
  }

  g.generateTexture(key, w, h);
  g.destroy();
  return key;
}

/** Damage bucket from live smashHp — art-spec §2.5 thresholds. */
export function damageStage(smashHp, maxHp) {
  if (!Number.isFinite(maxHp) || maxHp <= 0) return 0;
  const frac = smashHp / maxHp;
  return frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2;
}
