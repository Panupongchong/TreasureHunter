// ============================================================
// traversal.smoke.mjs — headless smoke test for the grapple + movement
// path. Run with `npm run smoke`.
//
// Why this exists: a refactor left a call to a method that had been
// deleted (this._terrainRects) on the line-of-sight path. `vite build`
// emitted it happily — a bundler does not resolve member calls — and the
// game froze the first time anyone right-clicked, because the throw
// killed the scene update loop. Nothing in the project executed a sim
// tick outside the browser, so nothing could have caught it.
//
// So: run the REAL systems against a minimal fake scene. Phaser geometry
// is stubbed to the three calls the systems actually make. This is not a
// physics test and it cannot tell you how anything FEELS — it only proves
// the code paths execute and the numbers land where the design says.
//
// Covers: fire → hook → reel → let go (two-stage), mass-scaled reel
// speed, the in-hands grapple block, whiffing at a suppressed anchor,
// jump-mode grapple still behaving as it always did, auto-step at both
// masses, and the jump verb being on/off per map.
// ============================================================

// ---- minimal Phaser geometry (only what the systems touch) ----
const seg = (x1, y1, x2, y2, r) => { // Liang-Barsky clip test
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - r.x], [dx, r.right - x1], [-dy, y1 - r.y], [dy, r.bottom - y1]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [{ x: x1 + dx * t0, y: y1 + dy * t0 }, { x: x1 + dx * t1, y: y1 + dy * t1 }];
};
globalThis.Phaser = {
  Geom: {
    Line: class { constructor(x1, y1, x2, y2) { Object.assign(this, { x1, y1, x2, y2 }); } },
    Rectangle: class {
      constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
      get right() { return this.x + this.width; }
      get bottom() { return this.y + this.height; }
    },
    Intersects: {
      LineToRectangle: (l, r) => !!seg(l.x1, l.y1, l.x2, l.y2, r),
      GetLineToRectangle: (l, r) => seg(l.x1, l.y1, l.x2, l.y2, r) ?? [],
    },
  },
};

const base = new URL('../src/', import.meta.url).href;
const { GrappleSystem } = await import(base + 'systems/GrappleSystem.js');
const { MovementSystem } = await import(base + 'systems/MovementSystem.js');
const { zipArena } = await import(base + 'maps/zipArena.js');
const { testMap } = await import(base + 'maps/testMap.js');
const { GRAPPLE } = await import(base + 'config.js');

const rect = (x, y, w, h) => new Phaser.Geom.Rectangle(x, y, w, h);

function makeBody(x, y, w = 26, h = 34) {
  const b = {
    width: w, height: h,
    position: { x: x - w / 2, y: y - h / 2 },
    prev: { x: x - w / 2, y: y - h / 2 },
    velocity: { x: 0, y: 0 },
    blocked: { up: false, down: true, left: false, right: false },
    enable: true, allowGravity: true,
    get x() { return this.position.x; }, set x(v) { this.position.x = v; },
    get y() { return this.position.y; }, set y(v) { this.position.y = v; },
    get right() { return this.position.x + this.width; },
    get bottom() { return this.position.y + this.height; },
    setVelocity(vx, vy) { this.velocity.x = vx; this.velocity.y = vy; },
    setVelocityX(v) { this.velocity.x = v; },
    setVelocityY(v) { this.velocity.y = v; },
    setAllowGravity(v) { this.allowGravity = v; },
  };
  return b;
}

function makePlayer(slot, x, y, mass = 1.0) {
  const body = makeBody(x, y);
  return {
    x, y, body,
    state: {
      slot, mass, stunned: false, carriedBy: null, carrying: null,
      grapple: null, grappleCdMs: 0, facing: 1, onGround: true,
      ridersMass: 0, standingOnSlot: null, staggerMsLeft: 0,
      lastGroundedAt: 0, jumpBufferedAt: -Infinity,
      fallStartY: null, falling: false, sprinting: false, attackMoveMult: 1,
    },
  };
}

function makeSim(map) {
  const platforms = map.platforms.map(([x, y, w, h]) => ({ getBounds: () => rect(x, y, w, h) }));
  const p = makePlayer(0, 300, 1119);
  const sim = {
    scene: { map, time: { now: 1000 }, platforms: { getChildren: () => platforms } },
    players: new Map([[0, p]]),
    monsters: new Map(), doors: new Map(), pickups: new Map(),
    relic: null, grapples: new Map(), events: [],
    world: { noise: 0, clockRunning: true, escalationLevel: 0 },
    stats: { perSlot: [0, 1, 2, 3].map(() => ({ noiseMade: 0 })) },
    inputs: [null],
    session: { phase: 'playing' },
    inputFor(s) { return this.inputs[s] ?? frame(); },
    emit(ev) { this.events.push(ev); },
  };
  return { sim, p };
}

const frame = (o = {}) => ({
  moveX: 0, jump: false, jumpHeld: false, attack: false, sprint: false,
  grapple: false, grappleHeld: false, grab: false, interact: false, ping: false,
  usingGamepad: false, aimX: 0, aimY: 0, ...o,
});

// ---------------------------------------------------------------
const results = [];
const run = (name, fn) => {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['XX', `${name} — ${e.constructor.name}: ${e.message}`]); }
};

run('zip arena: right-click fires, attaches, ticks, reels, lets go', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  // stand on the road under the shelf; aim up-right at the shelf lip
  p.x = 1800; p.y = 1119; p.body.position.x = p.x - 13; p.body.position.y = p.y - 17;
  sim.inputs[0] = frame({ grapple: true, grappleHeld: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  if (!p.state.grapple) throw new Error('no attach on the authored anchor');
  if (p.state.grapple.phase !== 'hooked') throw new Error('press 1 should HOOK, not reel');
  if (p.body.allowGravity === false) throw new Error('a slack hook must keep gravity');
  // tick with no input: exercises the D7 line-of-sight poll (the crash site)
  sim.inputs[0] = frame({ aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  if (!p.state.grapple) throw new Error('line dropped while merely hooked');
  // press 2: commit the reel
  sim.inputs[0] = frame({ grapple: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  if (p.state.grapple.phase !== 'reeling') throw new Error('press 2 should reel');
  if (p.body.allowGravity !== false) throw new Error('reeling to terrain should kill gravity');
  sim.inputs[0] = frame();
  G.update(sim, 1 / 60);
  const sp = Math.hypot(p.body.velocity.x, p.body.velocity.y);
  if (Math.round(sp) !== 650) throw new Error(`reel speed ${Math.round(sp)}, want 650`);
  // press 3: let go, keeping speed
  sim.inputs[0] = frame({ grapple: true });
  G.update(sim, 1 / 60);
  if (p.state.grapple) throw new Error('press 3 should let go');
  if (p.body.allowGravity !== true) throw new Error('gravity must come back on release');
  if (Math.hypot(p.body.velocity.x, p.body.velocity.y) < 600) throw new Error('momentum was thrown away');
});

run('zip arena: carrier reels at half speed', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 1800; p.y = 1119; p.body.position.x = 1787; p.body.position.y = 1102;
  p.state.mass = 2.0;
  p.state.carrying = { kind: 'relic', where: 'bag' }; // bagged: allowed to grapple
  sim.inputs[0] = frame({ grapple: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  sim.inputs[0] = frame({ grapple: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  sim.inputs[0] = frame();
  G.update(sim, 1 / 60);
  const sp = Math.round(Math.hypot(p.body.velocity.x, p.body.velocity.y));
  if (sp !== 325) throw new Error(`carrier reel ${sp}, want 325`);
});

run('zip arena: hands-carrier cannot fire at all', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 1800; p.y = 1119;
  p.state.carrying = { kind: 'relic', where: 'hands' };
  sim.inputs[0] = frame({ grapple: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  if (p.state.grapple) throw new Error('in-hands relic must block the grapple');
});

run('zip arena: no anchor in that direction = clean whiff', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 2400; p.y = 1119; // under the smooth ferry deck
  sim.inputs[0] = frame({ grapple: true, aimX: 2400, aimY: 700 }); // straight up
  G.update(sim, 1 / 60);
  if (p.state.grapple) throw new Error('ferry deck must offer no terrain anchor');
});

run('testMap (jump mode) still attaches to bare terrain and holds', () => {
  const { sim, p } = makeSim(testMap);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 300; p.y = 1340; p.body.position.x = 287; p.body.position.y = 1323;
  sim.inputs[0] = frame({ grapple: true, grappleHeld: true, aimX: 500, aimY: 1290 });
  G.update(sim, 1 / 60);
  if (!p.state.grapple) throw new Error('jump mode should hit raw terrain');
  if (p.state.grapple.phase !== 'reeling') throw new Error('jump mode has no hook phase');
  sim.inputs[0] = frame({ grappleHeld: true, aimX: 500, aimY: 1290 }); // hold: D7 poll
  G.update(sim, 1 / 60);
  const sp = Math.round(Math.hypot(p.body.velocity.x, p.body.velocity.y));
  if (sp !== GRAPPLE.zipSpeed) throw new Error(`jump-mode zip ${sp}, want ${GRAPPLE.zipSpeed}`);
  sim.inputs[0] = frame(); // release detaches in jump mode
  G.update(sim, 1 / 60);
  if (p.state.grapple) throw new Error('release must detach in jump mode');
});

run('auto-step: scout climbs one tile, carrier does not', () => {
  for (const [mass, shouldClimb] of [[1.0, true], [2.0, false]]) {
    const { sim, p } = makeSim(zipArena);
    const M = new MovementSystem();
    // pressed against station A's 40 px block (top 1096), walking east
    p.state.mass = mass;
    p.x = 594; p.y = 1119;
    p.body.position.x = 574; p.body.position.y = 1102; // bottom 1136 = road top
    p.body.blocked.right = true;
    sim.inputs[0] = frame({ moveX: 1 });
    M.update(sim, 1 / 60);
    const climbed = p.y < 1119 - 1;
    if (climbed !== shouldClimb) {
      throw new Error(`mass ${mass}: climbed=${climbed}, want ${shouldClimb} (y ${p.y})`);
    }
    if (shouldClimb && Math.round(p.body.bottom) !== 1096) {
      throw new Error(`landed at body bottom ${p.body.bottom}, want 1096`);
    }
  }
});

run('auto-step: two-tile wall is never climbed', () => {
  const { sim, p } = makeSim(zipArena);
  const M = new MovementSystem();
  p.x = 834; p.y = 1119;
  p.body.position.x = 814; p.body.position.y = 1102;
  p.body.blocked.right = true;
  sim.inputs[0] = frame({ moveX: 1 });
  M.update(sim, 1 / 60);
  if (p.y !== 1119) throw new Error(`climbed an 80 px wall (y ${p.y})`);
});

run('jump mode: no auto-step, jump still fires', () => {
  const { sim, p } = makeSim(testMap);
  const M = new MovementSystem();
  p.x = 300; p.y = 1340;
  sim.inputs[0] = frame({ jump: true, jumpHeld: true });
  M.update(sim, 1 / 60);
  if (p.body.velocity.y >= 0) throw new Error('jump did not fire in jump mode');
});

run('zip mode: jump input does nothing', () => {
  const { sim, p } = makeSim(zipArena);
  const M = new MovementSystem();
  p.x = 300; p.y = 1119;
  sim.inputs[0] = frame({ jump: true, jumpHeld: true });
  M.update(sim, 1 / 60);
  if (p.body.velocity.y !== 0) throw new Error('jump fired in zip mode');
});

for (const [s, m] of results) console.log(`  ${s}  ${m}`);
const bad = results.filter(([s]) => s === 'XX').length;
console.log(`\n${results.length - bad} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
