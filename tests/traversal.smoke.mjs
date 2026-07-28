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
// Covers: throw → flight → bite → reel → let go (two-stage), the lob-and-
// drag path (a high throw lands on the deck and is hauled into the lip),
// the arc existing at all, recall, mass-scaled reel speed, the in-hands
// grapple block, whiffing at a suppressed anchor, jump-mode grapple still
// being hitscan and behaving as it always did, auto-step at both masses,
// and the per-map jump ceiling.
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
const { GRAPPLE, PHYSICS } = await import(base + 'config.js');

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

/**
 * Tick the grapple system with a non-pressing frame until `pred` holds.
 * A thrown hook needs real ticks to get anywhere — every zip-mode test
 * below has to fly the line rather than assume it resolved on the press.
 * @returns {{ticks:number, phases:Set<string>}|null} null = never happened
 */
const flyUntil = (G, sim, p, pred, max = 150) => {
  const phases = new Set();
  for (let i = 1; i <= max; i++) {
    sim.inputs[0] = frame();
    G.update(sim, 1 / 60);
    if (p.state.grapple) phases.add(p.state.grapple.phase);
    if (pred(p)) return { ticks: i, phases };
  }
  return null;
};

// ---------------------------------------------------------------
const results = [];
const run = (name, fn) => {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['XX', `${name} — ${e.constructor.name}: ${e.message}`]); }
};

run('zip arena: hook is thrown, flies, bites the anchor, reels, lets go', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  // stand on the road under the authored anchor and throw at it
  p.x = 1800; p.y = 1119; p.body.position.x = p.x - 13; p.body.position.y = p.y - 17;
  sim.inputs[0] = frame({ grapple: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  const g = p.state.grapple;
  if (!g) throw new Error('press 1 threw nothing');
  if (g.phase !== 'flying') throw new Error(`press 1 should THROW, phase ${g.phase}`);
  if (g.targetKind !== 'hook') throw new Error('a hook in the air is attached to nothing');
  if (p.body.allowGravity === false) throw new Error('a thrown hook must not kill gravity');
  // fly it: this also exercises the D7 line-of-sight poll (the crash site)
  const flown = flyUntil(G, sim, p, (q) => q.state.grapple?.phase === 'hooked');
  if (!flown) throw new Error(`hook never bit (phase ${p.state.grapple?.phase ?? 'gone'})`);
  if (flown.ticks < 3) throw new Error('bit instantly — that is a ray, not a throw');
  if (p.body.allowGravity === false) throw new Error('a slack hook must keep gravity');
  if (p.state.grapple.targetKind !== 'terrain') throw new Error('should have bitten terrain');
  // press 2: commit the reel
  sim.inputs[0] = frame({ grapple: true });
  G.update(sim, 1 / 60);
  if (p.state.grapple.phase !== 'reeling') throw new Error('press 2 should reel');
  if (p.body.allowGravity !== false) throw new Error('reeling to terrain should kill gravity');
  const sp = Math.hypot(p.body.velocity.x, p.body.velocity.y);
  if (Math.round(sp) !== 650) throw new Error(`reel speed ${Math.round(sp)}, want 650`);
  // press 3: let go, keeping speed
  sim.inputs[0] = frame({ grapple: true });
  G.update(sim, 1 / 60);
  if (p.state.grapple) throw new Error('press 3 should let go');
  if (p.body.allowGravity !== true) throw new Error('gravity must come back on release');
  if (Math.hypot(p.body.velocity.x, p.body.velocity.y) < 600) throw new Error('momentum was thrown away');
});

run('zip arena: the hook ARCS — a flat throw drops as it travels', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 300; p.y = 900; // mid-air, nothing to hit for a long way east
  p.body.position.x = 287; p.body.position.y = 883;
  sim.inputs[0] = frame({ grapple: true, aimX: 900, aimY: 900 }); // dead level
  G.update(sim, 1 / 60);
  const g = p.state.grapple;
  if (g.phase !== 'flying') throw new Error('no hook in the air');
  const x0 = g.tipX, y0 = g.tipY; // numbers: g is the LIVE grapple object
  for (let i = 0; i < 12; i++) { sim.inputs[0] = frame(); G.update(sim, 1 / 60); }
  if (!p.state.grapple) throw new Error('hook died mid-flight');
  const drop = p.state.grapple.tipY - y0;
  if (drop < 10) throw new Error(`level throw dropped ${drop.toFixed(1)} px — no arc`);
  if (p.state.grapple.tipX - x0 < 100) throw new Error('hook barely moved');
});

run('zip arena: a high throw lands on the deck and DRAGS into the lip', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  // On the road west of the shelf (platform 10, deck top 976, x 1900..2140).
  // Its near lip anchor is (1894, 970); aim 150 px straight ABOVE that — too
  // high to be a reachable arc, so the hook launches raw, sails over the lip,
  // lands on the deck, and is hauled back west until it catches the lip.
  // Aiming AT the lip instead just hits it (the test above), which is the
  // whole point: same button, two outcomes, decided by where you pointed.
  p.x = 1800; p.y = 1119; p.body.position.x = 1787; p.body.position.y = 1102;
  sim.inputs[0] = frame({ grapple: true, aimX: 1894, aimY: 820 });
  G.update(sim, 1 / 60);
  const flown = flyUntil(G, sim, p, (q) => q.state.grapple?.phase === 'hooked');
  if (!flown) throw new Error(`never caught the lip (phase ${p.state.grapple?.phase ?? 'gone'})`);
  if (!flown.phases.has('dragging')) {
    throw new Error('bit in mid-air — this throw was supposed to overshoot and drag');
  }
  const anchored = p.state.grapple;
  if (Math.round(anchored.anchorY) !== 970) {
    throw new Error(`caught something at y ${anchored.anchorY}, want the 970 lip`);
  }
});

run('zip arena: a hook that grabs nothing comes home by itself', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 2350; p.y = 1119; // under the SMOOTH ferry deck, and out of reach of it
  p.body.position.x = 2337; p.body.position.y = 1102;
  sim.inputs[0] = frame({ grapple: true, aimX: 2350, aimY: 700 }); // straight up
  G.update(sim, 1 / 60);
  const done = flyUntil(G, sim, p, (q) => !q.state.grapple);
  if (!done) throw new Error('the missed hook never returned');
  if (done.phases.has('hooked')) throw new Error('the ferry deck must offer no lip');
  if (!done.phases.has('retracting')) throw new Error('a miss should retract, not vanish');
});

run('zip arena: pressing again mid-flight recalls the hook', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 300; p.y = 900;
  p.body.position.x = 287; p.body.position.y = 883;
  sim.inputs[0] = frame({ grapple: true, aimX: 900, aimY: 880 });
  G.update(sim, 1 / 60);
  for (let i = 0; i < 5; i++) { sim.inputs[0] = frame(); G.update(sim, 1 / 60); }
  if (p.state.grapple?.phase !== 'flying') throw new Error('hook not in the air');
  sim.inputs[0] = frame({ grapple: true }); // press 2 while it is still out
  G.update(sim, 1 / 60);
  if (p.state.grapple?.phase !== 'retracting') throw new Error('press should recall it');
  if (!flyUntil(G, sim, p, (q) => !q.state.grapple)) throw new Error('recall never finished');
});

run('zip arena: carrier reels at half speed', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 1800; p.y = 1119; p.body.position.x = 1787; p.body.position.y = 1102;
  p.state.mass = 2.0;
  p.state.carrying = { kind: 'relic', where: 'bag' }; // bagged: allowed to grapple
  sim.inputs[0] = frame({ grapple: true, aimX: 1770, aimY: 900 });
  G.update(sim, 1 / 60);
  if (!flyUntil(G, sim, p, (q) => q.state.grapple?.phase === 'hooked')) {
    throw new Error('carrier hook never bit');
  }
  sim.inputs[0] = frame({ grapple: true }); // commit the reel
  G.update(sim, 1 / 60);
  const sp = Math.round(Math.hypot(p.body.velocity.x, p.body.velocity.y));
  if (sp !== 325) throw new Error(`carrier reel ${sp}, want 325`);
});

run('zip arena: a thrown hook still bites a BODY (the ferry route)', () => {
  const { sim, p } = makeSim(zipArena);
  const G = new GrappleSystem(); G.init(sim);
  p.x = 1950; p.y = 1119; p.body.position.x = 1937; p.body.position.y = 1102;
  // The map's own road launcher (md1 at 2150,1084): a Brute-sized dummy east
  // of us on open road. Station D's premise is that bodies are the traversal
  // network, so the hook has to be able to catch one. Deliberately NOT next
  // to the pedestal — its lip anchor sits 20 px off the Brute's flank and
  // would legitimately grab the hook first, which is a level-design fact
  // about that corner, not something to assert about bodies.
  const brute = {
    x: 2150, y: 1084, body: makeBody(2150, 1084, 44, 52),
    state: { type: 'brute', mass: 3.0, stunned: false, facing: -1, hp: 10, ai: 'idle' },
  };
  sim.monsters.set('md1', brute);
  sim.inputs[0] = frame({ grapple: true, aimX: brute.x, aimY: brute.y });
  G.update(sim, 1 / 60);
  if (!flyUntil(G, sim, p, (q) => q.state.grapple?.phase === 'hooked')) {
    throw new Error(`hook never reached the Brute (${p.state.grapple?.phase ?? 'gone'})`);
  }
  const g = p.state.grapple;
  if (g.targetKind !== 'entity' || g.targetId !== 'md1') {
    throw new Error(`bit ${g.targetKind}/${g.targetId}, want entity/md1`);
  }
  // and the mass rule still owns what happens next: 3.0 vs 1.0 reels US in
  sim.inputs[0] = frame({ grapple: true });
  G.update(sim, 1 / 60);
  if (p.body.velocity.x <= 0) throw new Error('reeling toward the Brute should pull us east');
  if (Math.abs(brute.body.velocity.x) >= Math.abs(p.body.velocity.x)) {
    throw new Error('a 3.0 Brute must move less than the 1.0 player pulling it');
  }
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

run('zip mode: jump fires, but low enough to respect the step law', () => {
  const { sim, p } = makeSim(zipArena);
  const M = new MovementSystem();
  p.x = 300; p.y = 1119;
  sim.inputs[0] = frame({ jump: true, jumpHeld: true });
  M.update(sim, 1 / 60);
  const vy = -p.body.velocity.y;
  if (vy <= 0) throw new Error('jump did not fire in zip mode');
  if (vy >= PHYSICS.baseJumpVelocity) throw new Error(`zip jump ${vy} is not a LOW jump`);
  // The number that matters is the apex, because the level is built on it:
  // over one tile (40), under two (80).
  const apex = (vy * vy) / (2 * PHYSICS.gravityY);
  if (apex < 45 || apex > 70) throw new Error(`apex ${apex.toFixed(0)} px, want ~55`);
  // …and the relic carrier still cannot hop even one tile.
  const { sim: sim2, p: p2 } = makeSim(zipArena);
  p2.state.mass = 2.0;
  p2.x = 300; p2.y = 1119;
  sim2.inputs[0] = frame({ jump: true, jumpHeld: true });
  new MovementSystem().update(sim2, 1 / 60);
  const cApex = (p2.body.velocity.y ** 2) / (2 * PHYSICS.gravityY);
  if (cApex >= 40) throw new Error(`carrier apex ${cApex.toFixed(0)} px clears a tile`);
});

for (const [s, m] of results) console.log(`  ${s}  ${m}`);
const bad = results.filter(([s]) => s === 'XX').length;
console.log(`\n${results.length - bad} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
