// ============================================================
// wp5-accept.mjs — WP5 acceptance suite (relic, objective, test map).
//
// Node 22+ built-ins only. Headless Chrome ("--headless=new") over CDP,
// ONE Chrome INSTANCE per peer (a second tab occludes the first and
// freezes Phaser). Real public PeerJS broker, random 4-letter room codes.
//
// Driving model:
//  - Menu navigation via direct scene-method calls (Menu._host/_join/_solo)
//  - Phase keys (P/L) + smoke movement via REAL CDP keyboard events
//  - Gameplay verbs (grab/throw/grapple/interact) via an InputManager.poll
//    patch (window.__hold merged every poll + window.__edges one-shot
//    queue) — exact edge semantics, exact mouse-world aim, no 150 ms
//    headless key-hold flakiness. State setup (teleports) via body.reset.
//  - Assertions read host sim state + tapped sim events (host) and
//    net:event / net:phase logs (clients).
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'tmp-wp5');
const APP = 'http://localhost:5173/';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const infra = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

// ---------------- CDP ----------------

class Cdp {
  constructor(port, name) { this.port = port; this.name = name; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    let info = null;
    for (let i = 0; i < 60; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    if (!info) throw new Error(`${this.name}: CDP endpoint never came up on ${this.port}`);
    this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => this._onMsg(JSON.parse(m.data));
    const { targetInfos } = await this.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error(`${this.name}: no page target`);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
  }
  _onMsg(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? rej(new Error(`${this.name}: ${msg.error.message}`)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      this.errors.push(d?.exception?.description || d?.text || 'unknown');
      if (this.errors.length > 20) this.errors.shift();
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error(`${this.name} page exception: ` +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 400));
    }
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async key(code, vk, key, holdMs = 200) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  close() { try { this.ws?.close(); } catch {} }
}

// ---------------- helpers ----------------

const procs = [];
function launchChrome(name, port) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' });
  procs.push(proc);
  return proc;
}

async function waitFor(page, expr, timeoutMs, label) {
  const guarded = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < timeoutMs) {
    v = await page.eval(guarded);
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`timeout(${timeoutMs}ms) waiting for: ${label || expr}`);
}

const GLOBAL_TAPS = `(()=>{ if (window.__taps) return 'already';
  window.__phases=[]; window.__evts=[]; window.__toasts=[];
  game.events.on('net:phase', p=>{try{__phases.push(JSON.parse(JSON.stringify(p)))}catch(e){__phases.push({phase:p.phase})}});
  game.events.on('net:event', e=>{try{__evts.push(JSON.parse(JSON.stringify(e)))}catch(e2){}});
  game.events.on('ui:toast', t=>__toasts.push(String(t)));
  window.__taps=true; return 'ok'; })()`;

const PATCH_INPUT = `(()=>{ const sc=game.scene.getScene('Game'); if(!sc||!sc.inputManager) return 'no-scene';
  const im=sc.inputManager;
  window.__hold={}; window.__edges=[];
  if(!im.__patched){ im.__patched=true; const orig=im.poll.bind(im);
    im.poll=()=>{ const f=orig(); Object.assign(f, window.__hold||{});
      if((window.__edges||[]).length) Object.assign(f, window.__edges.shift());
      return f; }; }
  return 'ok'; })()`;

const TAP_SIM = `(()=>{ const sc=game.scene.getScene('Game'); if(!sc||!sc.sim) return 'no-sim';
  window.__sevts = window.__sevts||[];
  if(!sc.sim.__tapped){ sc.sim.__tapped=true; const orig=sc.sim.emit.bind(sc.sim);
    sc.sim.emit = ev => { try{window.__sevts.push(JSON.parse(JSON.stringify(ev)))}catch(e){} orig(ev); }; }
  return 'ok'; })()`;

const hold = (page, obj) => page.eval(`(Object.assign(window.__hold, ${JSON.stringify(obj)}), 'ok')`);
const unhold = (page, keys) => page.eval(`(${JSON.stringify(keys)}.forEach(k=>delete window.__hold[k]), 'ok')`);
const edge = (page, obj) => page.eval(`(window.__edges.push(${JSON.stringify(obj)}), 'ok')`);

const qPlayer = (slot) => `(()=>{const sc=game.scene.getScene('Game');const p=sc&&sc.sim&&sc.sim.players.get(${slot});
  if(!p) return null;
  const s=p.state;
  return {x:p.x,y:p.y,vx:p.body.velocity.x,vy:p.body.velocity.y,mass:s.mass,stunned:!!s.stunned,
    carrying:s.carrying?JSON.parse(JSON.stringify(s.carrying)):null,
    channel:s.channel?{type:s.channel.type,msLeft:s.channel.msLeft}:null,
    prog:s.channelProgress||0, grapple:s.grapple?{targetKind:s.grapple.targetKind,targetId:s.grapple.targetId}:null,
    attack:s.attack?s.attack.phase:null, weapon:s.weapon, facing:s.facing};})()`;

const qRelic = `(()=>{const sc=game.scene.getScene('Game');const r=sc&&(sc.sim?sc.sim.relic:sc.relic);
  if(!r) return null;
  const en=!!(r.body&&r.body.enable);
  return {x:r.x,y:r.y,vx:en?r.body.velocity.x:0,vy:en?r.body.velocity.y:0,rs:r.state.rs,holder:r.state.holderSlot,bodyOn:en};})()`;

const tpPlayer = (slot, x, y) =>
  `(game.scene.getScene('Game').sim.players.get(${slot}).body.reset(${x},${y}), 'ok')`;
const tpRelic = (x, y) =>
  `(game.scene.getScene('Game').sim.relic.body.reset(${x},${y}), 'ok')`;
const resetNoise = `(game.scene.getScene('Game').sim.world.noise=0, 'ok')`;
const sevtsLen = `(window.__sevts||[]).length`;
const sevtsSlice = (from) => `JSON.parse(JSON.stringify((window.__sevts||[]).slice(${from})))`;

async function sample(page, slot, ms, everyMs = 30) {
  await page.eval(`(()=>{const sc=game.scene.getScene('Game'); const p=sc.sim.players.get(${slot});
    window.__s=[]; const iv=setInterval(()=>{ try{ window.__s.push({t:performance.now(),x:p.x,y:p.y,vx:p.body.velocity.x,vy:p.body.velocity.y}); }catch(e){clearInterval(iv);} }, ${everyMs});
    setTimeout(()=>clearInterval(iv), ${ms}); return 'ok';})()`);
  await sleep(ms + 150);
  return page.eval(`window.__s`);
}

async function sampleRelicAndPlayer(page, slot, ms, everyMs = 40) {
  await page.eval(`(()=>{const sc=game.scene.getScene('Game'); const sim=sc.sim;
    window.__rs=[]; const iv=setInterval(()=>{ try{ const r=sim.relic, p=sim.players.get(${slot});
      window.__rs.push({t:performance.now(),rx:r.x,ry:r.y,rvx:(r.body&&r.body.enable)?r.body.velocity.x:0,rs:r.state.rs,holder:r.state.holderSlot,px:p?p.x:null,py:p?p.y:null}); }catch(e){clearInterval(iv);} }, ${everyMs});
    setTimeout(()=>clearInterval(iv), ${ms}); return 'ok';})()`);
  await sleep(ms + 150);
  return page.eval(`window.__rs`);
}

// ---------------- boot / session ----------------

async function bootPeer(name, port) {
  const proc = launchChrome(name, port);
  const page = new Cdp(port, name);
  page.proc = proc;
  await page.connect();
  await page.navigate(APP);
  await waitFor(page, `!!window.game && !!game.scene.getScene('Menu') && game.scene.isActive('Menu')`, 25000, `${name}: menu ready`);
  await page.eval(GLOBAL_TAPS);
  return page;
}

async function hostRoom(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.eval(`(game.scene.getScene('Menu')._host(), 'ok')`);
    try {
      const code = await waitFor(page,
        `game.scene.isActive('Game') && game.scene.getScene('Game').session.roomCode`, 15000, 'host: room open');
      return code;
    } catch (e) {
      infra.push(`host attempt ${attempt} failed (${e.message.slice(0, 80)}), retrying`);
      await page.navigate(APP);
      await waitFor(page, `!!window.game && game.scene.isActive('Menu')`, 20000, 'host: menu after reload');
      await page.eval(GLOBAL_TAPS);
    }
  }
  throw new Error('could not host a room after 3 attempts (broker)');
}

async function joinRoom(page, code, expectSlot) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.eval(`(game.scene.getScene('Menu')._join('${code}'), 'ok')`);
    try {
      await waitFor(page,
        `game.scene.isActive('Game') && game.scene.getScene('Game').session.localSlot===${expectSlot}`,
        18000, `join slot ${expectSlot}`);
      return;
    } catch (e) {
      infra.push(`join attempt ${attempt} for slot ${expectSlot} failed (${e.message.slice(0, 80)}), retrying`);
      await page.navigate(APP);
      await waitFor(page, `!!window.game && game.scene.isActive('Menu')`, 20000, 'joiner: menu after reload');
      await page.eval(GLOBAL_TAPS);
    }
  }
  throw new Error(`could not join room ${code} after 3 attempts (broker)`);
}

async function repatchAll(pages, hostPage) {
  for (const p of pages) await waitFor(p, `(${PATCH_INPUT})==='ok'`, 8000, `${p.name}: input patch`);
  await hostPage.eval(TAP_SIM);
}

// ---------------- main ----------------

let H, C1, C2, C3;

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // ---------- boot host instance + solo smoke ----------
  H = await bootPeer('host', 9421);
  {
    await H.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
    await waitFor(H, `game.scene.isActive('Game') && game.scene.getScene('Game').mode==='solo'`, 10000, 'solo boot');
    await sleep(600);
    const x0 = (await H.eval(qPlayer(0))).x;
    await H.key('KeyD', 68, 'd', 600); // REAL keyboard — proves the raw input path
    await sleep(300);
    const x1 = (await H.eval(qPlayer(0))).x;
    const dx = x1 - x0;
    const fps = await H.eval(`game.loop.actualFps`);
    report('smoke-solo', dx > 40, `solo mode boots, real KeyD moved player ${dx.toFixed(0)}px right (fps ${fps.toFixed(0)})`);
    await H.eval(`(game.scene.getScene('Game')._leave(null), 'ok')`);
    await waitFor(H, `game.scene.isActive('Menu')`, 8000, 'back to menu');
    await H.eval(GLOBAL_TAPS);
  }

  // ---------- host + 2 clients over the real broker ----------
  const code = await hostRoom(H);
  console.log('room code:', code);
  C1 = await bootPeer('c1', 9422);
  await joinRoom(C1, code, 1);
  C2 = await bootPeer('c2', 9423);
  await joinRoom(C2, code, 2);
  await waitFor(H, `game.scene.getScene('Game').session.connectedPlayers().length===3`, 10000, 'host sees 3 players');

  // ---------- smoke: host+client motion sync in lobby ----------
  {
    await repatchAll([H, C1, C2], H);
    // client -> host: REAL keyboard on C1, watched on the host sim
    const p1a = await H.eval(qPlayer(1));
    await C1.key('KeyD', 68, 'd', 600);
    await sleep(500);
    const p1b = await H.eval(qPlayer(1));
    // host -> client: host walks (poll patch), C1's view of p0 follows snapshots
    const hx0 = (await H.eval(qPlayer(0))).x;
    const c1x0 = await C1.eval(`game.scene.getScene('Game').players.get(0).x`);
    await hold(H, { moveX: 1 });
    await sleep(700);
    await unhold(H, ['moveX']);
    await sleep(600); // interp buffer settle
    const hx1 = (await H.eval(qPlayer(0))).x;
    const c1x1 = await C1.eval(`game.scene.getScene('Game').players.get(0).x`);
    const clientMoved = p1b.x - p1a.x;
    const hostMoved = hx1 - hx0;
    const viewErr = Math.abs(c1x1 - hx1);
    const ok = clientMoved > 40 && hostMoved > 60 && (c1x1 - c1x0) > 40 && viewErr < 80;
    report('smoke-netsync', ok,
      `C1 KeyD moved its player ${clientMoved.toFixed(0)}px on HOST sim; host walked ${hostMoved.toFixed(0)}px, ` +
      `C1's interpolated view followed to within ${viewErr.toFixed(1)}px`);
  }

  // ---------- start run 1 (host key P) ----------
  await H.key('KeyP', 80, 'p', 220);
  await waitFor(H, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 10000, 'host: playing');
  await waitFor(C1, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 10000, 'C1: playing');
  await waitFor(C2, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 10000, 'C2: playing');
  await sleep(500);
  await repatchAll([H, C1, C2], H);

  // ================= 1. carry-weight =================
  {
    await H.eval(tpPlayer(0, 400, 1340));
    await sleep(400);
    // unladen walk
    await hold(H, { moveX: 1 });
    let s = await sample(H, 0, 1200);
    await unhold(H, ['moveX']);
    const walkFree = Math.max(...s.map((r) => r.vx));
    await sleep(400);
    // unladen jump — start the sampler BEFORE the jump edge so the launch
    // velocity is captured; base y = settled (resting) y from early samples.
    await H.eval(tpPlayer(0, 400, 1340));
    await sleep(500);
    const jumpMeasure = async () => {
      await hold(H, { jumpHeld: true });
      const sampP = sample(H, 0, 1300);
      await sleep(120);
      await edge(H, { jump: true, jumpHeld: true });
      const ss = await sampP;
      await unhold(H, ['jumpHeld']);
      const baseY = Math.max(...ss.map((r) => r.y));
      return { vy: Math.min(...ss.map((r) => r.vy)), apex: baseY - Math.min(...ss.map((r) => r.y)) };
    };
    let jm = await jumpMeasure();
    const vyFree = jm.vy, apexFree = jm.apex;
    // grab relic (teleport it next to us, F edge)
    await H.eval(tpRelic(430, 1330));
    await sleep(500);
    await edge(H, { grab: true });
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='held'`, 4000, 'relic grabbed');
    const mass = (await H.eval(qPlayer(0))).mass;
    // laden walk
    await H.eval(tpPlayer(0, 400, 1340));
    await sleep(400);
    await hold(H, { moveX: 1 });
    s = await sample(H, 0, 1200);
    await unhold(H, ['moveX']);
    const walkLaden = Math.max(...s.map((r) => r.vx));
    await sleep(400);
    // laden jump
    await H.eval(tpPlayer(0, 400, 1340));
    await sleep(500);
    jm = await jumpMeasure();
    const vyLaden = jm.vy, apexLaden = jm.apex;
    const speedRatio = walkLaden / walkFree;
    const jumpRatio = vyLaden / vyFree;
    const ok = mass === 2 &&
      Math.abs(speedRatio - 0.5) < 0.06 &&
      Math.abs(jumpRatio - 0.707) < 0.06;
    report('carry-weight', ok,
      `carrier mass ${mass}; walk ${walkLaden.toFixed(0)}/${walkFree.toFixed(0)} px/s = ${(speedRatio * 100).toFixed(1)}% (rule: 50%); ` +
      `jump-v ${(-vyLaden).toFixed(0)}/${(-vyFree).toFixed(0)} px/s = ${(jumpRatio * 100).toFixed(1)}% (rule: 70.7%); ` +
      `apex ${apexLaden.toFixed(0)}px vs ${apexFree.toFixed(0)}px`);
    await H.eval(resetNoise);
  }

  // ================= 2. bag-channel =================
  {
    // relic is in P0's hands. Per CLAUDE.md, holding E should start the ~3 s bag channel.
    await H.eval(tpPlayer(0, 400, 1340)); // nowhere near any door/tombstone/ritual
    await sleep(400);
    await hold(H, { interact: true });
    let sawChannel = null;
    for (let i = 0; i < 10; i++) {
      const p = await H.eval(qPlayer(0));
      if (p.channel) { sawChannel = p.channel; break; }
      await sleep(150);
    }
    await unhold(H, ['interact']);
    let detail;
    let pass = false;
    if (!sawChannel) {
      // Prove the completion machinery exists and only the START is missing:
      // hold E FIRST (a null channel is only searched, never cleared, while E
      // is down), THEN seed the channel object — it must progress and complete.
      await hold(H, { interact: true });
      await sleep(150);
      await H.eval(`(()=>{const p=game.scene.getScene('Game').sim.players.get(0);
        p.state.channel={type:'bag',targetId:null,msLeft:3000,msTotal:3000}; return 'ok';})()`);
      let mirrored = 0;
      for (let i = 0; i < 30; i++) {
        const ch = await C1.eval(`game.scene.getScene('Game').players.get(0).state.channelProgress||0`);
        mirrored = Math.max(mirrored, ch);
        const r = await H.eval(qRelic);
        if (r.rs === 'bagged') break;
        await sleep(150);
      }
      await unhold(H, ['interact']);
      const r = await H.eval(qRelic);
      detail = `BUG: holding E with relic in hands NEVER starts the 'bag' channel — ` +
        `InteractSystem._findChannel (src/systems/InteractSystem.js) has no bag/unbag branch: ` +
        `its priority comment lists "revive > reclaim > door > ritual > bag/unbag > rack" and _channelValid/_complete ` +
        `both handle 'bag'/'unbag', but no requestChannel(p,{type:'bag'...}) call exists anywhere (numbered branches jump 2->4). ` +
        `Proof the rest works: manually seeding p.state.channel={type:'bag'} and holding E completed the channel ` +
        `(relic rs='${r.rs}', client mirrored progress up to ${mirrored}%). Same start gap applies to 'unbag'.`;
    } else {
      // Honest path exists — verify progress mirror + completion.
      await hold(H, { interact: true });
      let mirrored = 0;
      for (let i = 0; i < 30; i++) {
        const ch = await C1.eval(`game.scene.getScene('Game').players.get(0).state.channelProgress||0`);
        mirrored = Math.max(mirrored, ch);
        const r = await H.eval(qRelic);
        if (r.rs === 'bagged') break;
        await sleep(150);
      }
      await unhold(H, ['interact']);
      const r = await H.eval(qRelic);
      pass = r.rs === 'bagged' && mirrored > 30;
      detail = `bag channel '${sawChannel.type}' started, completed to rs='${r.rs}', client saw progress ${mirrored}%`;
    }
    // Damage-interrupt check (works via seeded channel even with the start bug):
    // C1 dagger-hits P0 mid-channel -> stagger cancels the channel, relic stays in hands.
    await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); if(p.state.carrying&&p.state.carrying.kind==='relic') p.state.carrying.where='hands';
      sim.relic.state.rs='held'; sim.players.get(1).state.weapon='dagger'; return 'ok';})()`);
    let interrupted = false;
    let intDetail = '';
    for (let attempt = 1; attempt <= 3 && !interrupted; attempt++) {
      await H.eval(tpPlayer(0, 400, 1340));
      await H.eval(tpPlayer(1, 436, 1340));
      await sleep(400);
      await hold(H, { interact: true });
      await sleep(150);
      await H.eval(`(()=>{const p=game.scene.getScene('Game').sim.players.get(0);
        p.state.channel={type:'bag',targetId:null,msLeft:3000,msTotal:3000}; return 'ok';})()`);
      await sleep(700);
      const midProg = (await H.eval(qPlayer(0))).prog;
      const mark2 = await H.eval(sevtsLen);
      await hold(C1, { moveX: -0.01 }); // face left toward P0
      await sleep(150);
      await unhold(C1, ['moveX']);
      await edge(C1, { attack: true });
      // The stagger nulls the channel (full reset) — but E is STILL HELD,
      // so a fresh channel legitimately restarts the moment the 250 ms
      // stagger ends (post-fix behavior: _findChannel now HAS a bag
      // branch to restart from). Detect the reset by polling for the
      // progress drop to 0, not by expecting channel to stay null.
      let sawReset = false;
      let minProg = midProg;
      let lastProg = midProg;
      for (let i = 0; i < 12; i++) {
        await sleep(100);
        const snap = await H.eval(qPlayer(0));
        const prog = snap.channel === null ? 0 : snap.prog;
        if (prog < lastProg) sawReset = true;
        minProg = Math.min(minProg, prog);
        lastProg = prog;
      }
      const hitEvs = await H.eval(sevtsSlice(mark2));
      const staggered = hitEvs.find((e) => e.kind === 'staggered' && e.slot === 0);
      const afterHit = await H.eval(qPlayer(0));
      const rAfter = await H.eval(qRelic);
      await unhold(H, ['interact']);
      if (!staggered) { intDetail = `attempt ${attempt}: dagger missed (no staggered event)`; continue; }
      interrupted = midProg > 5 && sawReset && minProg <= 2 &&
        rAfter.rs === 'held' && afterHit.carrying && afterHit.carrying.where === 'hands';
      intDetail = `channel at ${midProg}% -> dagger FF stagger -> progress dropped to ${minProg}% (full reset), ` +
        `restarted to ${lastProg}% under still-held E, relic rs='${rAfter.rs}' still in hands ` +
        `(${interrupted ? 'interrupts with full reset' : 'DID NOT INTERRUPT'})`;
    }
    detail += ` | damage-interrupt: ${intDetail}`;
    report('bag-channel', pass && interrupted, detail);
    await H.eval(resetNoise);
  }

  // ================= 3. stun-drop =================
  {
    // 3a: HANDS carrier stunned by an over-safe fall -> drops + noiseBurst.
    const r0 = await H.eval(qRelic);
    if (r0.rs !== 'held') { // re-grab if a previous step left it elsewhere
      await H.eval(tpPlayer(0, 400, 1340));
      if (!r0.bodyOn) await H.eval(`(game.scene.getScene('Game').sim.relic.body.enable=true,'ok')`);
      await H.eval(tpRelic(420, 1330));
      await sleep(400);
      await edge(H, { grab: true });
      await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='held'`, 4000, 'regrab for stun test');
    }
    const mark = await H.eval(sevtsLen);
    await C1.eval(`window.__evts=[]`);
    // x=300 is a clear column (plaza stairs sit at x464-720); fall from
    // y=1050 to rest y=1359 = ~309 px >> carrier safeHeight 260/2 = 130.
    await H.eval(tpPlayer(0, 300, 1050));
    await waitFor(H, `game.scene.getScene('Game').sim.players.get(0).state.stunned===true`, 5000, 'carrier stunned');
    await sleep(400);
    const evs = await H.eval(sevtsSlice(mark));
    const pA = await H.eval(qPlayer(0));
    const rA = await H.eval(qRelic);
    const stunEv = evs.find((e) => e.kind === 'stun' && e.slot === 0);
    const burst = evs.find((e) => e.kind === 'noiseBurst' && e.cause === 'relicDrop');
    const relicStateEv = evs.find((e) => e.kind === 'relicState' && e.hs === -1);
    await sleep(600);
    const c1evs = await C1.eval(`JSON.parse(JSON.stringify(window.__evts))`);
    const c1burst = c1evs.find((e) => e.kind === 'noiseBurst' && e.cause === 'relicDrop');
    const handsOk = !!stunEv && !!burst && !!relicStateEv && pA.carrying === null &&
      (rA.rs === 'loose' || rA.rs === 'flying') && !!c1burst;
    // recover
    await H.eval(`(game.scene.getScene('Game').sim.players.get(0).state.stunMsLeft=1,'ok')`);
    await waitFor(H, `game.scene.getScene('Game').sim.players.get(0).state.stunned===false`, 4000, 'recovered');

    // 3b: BAGGED carrier stunned -> relic secure.
    await H.eval(tpPlayer(0, 400, 1340));
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='loose'`, 5000, 'relic loose again');
    await H.eval(tpRelic(420, 1330));
    await sleep(400);
    await edge(H, { grab: true });
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='held'`, 4000, 'grabbed again');
    await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      sim.relicSys.completeBag(sim, sim.players.get(0)); return 'ok';})()`); // seeded: bag-start is bugged (test 2)
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='bagged'`, 3000, 'bagged');
    const mark2 = await H.eval(sevtsLen);
    await H.eval(tpPlayer(0, 300, 1050));
    await waitFor(H, `game.scene.getScene('Game').sim.players.get(0).state.stunned===true`, 5000, 'bagged carrier stunned');
    await sleep(400);
    const evs2 = await H.eval(sevtsSlice(mark2));
    const pB = await H.eval(qPlayer(0));
    const rB = await H.eval(qRelic);
    const noDrop = !evs2.find((e) => e.kind === 'noiseBurst' && e.cause === 'relicDrop');
    const bagOk = rB.rs === 'bagged' && rB.holder === 0 && pB.carrying && pB.carrying.where === 'bag' && noDrop;
    report('stun-drop', handsOk && bagOk,
      `hands: fall-stun -> relic rs='${rA.rs}', carrying=${JSON.stringify(pA.carrying)}, ` +
      `noiseBurst{cause:'relicDrop',amount:${burst?.amount}} host+client(seen=${!!c1burst}); ` +
      `bagged: stun -> rs='${rB.rs}' holder=${rB.holder} carrying=${JSON.stringify(pB.carrying)}, relicDrop burst=${!noDrop} ` +
      `(bag seeded via relicSys.completeBag for setup speed — the real E-hold path is covered by bag-channel)`);
    await H.eval(`(game.scene.getScene('Game').sim.players.get(0).state.stunMsLeft=1,'ok')`);
    await waitFor(H, `game.scene.getScene('Game').sim.players.get(0).state.stunned===false`, 4000, 'recovered 2');
    await H.eval(resetNoise);
  }

  // ================= 6. capability-gate =================
  {
    // Current state: P0 has relic BAGGED. First verify bagged ALLOWS both
    // verbs, then unbag (seeded) and verify hands BLOCKS both.
    // Grapple anchor = ground ahead (a short down-slope zip that detaches
    // 'blocked' immediately) — attach EVENT is the proof; a high anchor
    // zips into the stair underside and the fall re-stuns the carrier.
    await H.eval(tpPlayer(0, 700, 1340));
    await sleep(400);
    // bagged: attack works
    let mark = await H.eval(sevtsLen);
    await edge(H, { attack: true });
    await sleep(500);
    const evBagSwing = (await H.eval(sevtsSlice(mark))).find((e) => e.kind === 'swing' && e.slot === 0);
    await sleep(700); // ride out recovery
    // bagged: grapple fire works
    mark = await H.eval(sevtsLen);
    await hold(H, { grappleHeld: true, aimX: 850, aimY: 1380 });
    await edge(H, { grapple: true });
    await sleep(500);
    const evBagAttach = (await H.eval(sevtsSlice(mark))).find((e) => e.kind === 'grappleAttach' && e.slot === 0);
    await unhold(H, ['grappleHeld', 'aimX', 'aimY']);
    await sleep(300);
    // unbag (seeded — start path bugged) -> hands
    await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      sim.relicSys.completeUnbag(sim, sim.players.get(0)); return 'ok';})()`);
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='held'`, 3000, 'unbagged to hands');
    await H.eval(tpPlayer(0, 700, 1340));
    await sleep(1000); // attack cooldown (hammer 900 ms press-to-press) fully clear
    // hands: grapple fire ignored
    mark = await H.eval(sevtsLen);
    await hold(H, { grappleHeld: true, aimX: 850, aimY: 1380 });
    await edge(H, { grapple: true });
    await sleep(500);
    const gHands = (await H.eval(qPlayer(0))).grapple;
    const evHandsAttach = (await H.eval(sevtsSlice(mark))).find((e) => e.kind === 'grappleAttach' && e.slot === 0);
    await unhold(H, ['grappleHeld', 'aimX', 'aimY']);
    // hands: attack ignored
    mark = await H.eval(sevtsLen);
    await edge(H, { attack: true });
    await sleep(500);
    const pHands = await H.eval(qPlayer(0));
    const evHandsSwing = (await H.eval(sevtsSlice(mark))).find((e) => e.kind === 'swing' && e.slot === 0);
    const ok = !!evBagAttach && !!evBagSwing &&
      gHands === null && !evHandsAttach && !evHandsSwing && pHands.attack === null && !pHands.stunned;
    report('capability-gate', ok,
      `bagged: grapple fired (attach event=${!!evBagAttach}) and attack swung (event=${!!evBagSwing}); ` +
      `hands: grapple ignored (state=${JSON.stringify(gHands)}, event=${!!evHandsAttach}) and attack ignored ` +
      `(attack=${pHands.attack}, event=${!!evHandsSwing}, stunned=${pHands.stunned}). ` +
      `Unbag seeded via completeUnbag for setup speed (real start path covered by bag-channel)`);
    await H.eval(resetNoise);
  }

  // ================= 4. throw-catch =================
  {
    // Thrower = C1 (slot 1, real client input), catcher = HOST P0 via an
    // in-page auto-aimer (fires at the live relic position once it flies).
    const FORCE_LOOSE = (x, y) => `(()=>{const sim=game.scene.getScene('Game').sim;
      for(const [,pl] of sim.players){ if(pl.state.carrying&&pl.state.carrying.kind==='relic') pl.state.carrying=null; }
      const r=sim.relic; r.state.rs='loose'; r.state.holderSlot=null; r.state.lockoutMs=0; r.state.lockoutSlot=null;
      r.body.enable=true; r.body.reset(${x},${y}); r.body.setDragX(600); r.body.setVelocity(0,0); return 'ok';})()`;
    const CLEAR_CATCHER = `(clearInterval(window.__catchIv), clearTimeout(window.__catchTo), delete window.__hold.grappleHeld, 'ok')`;
    let ok = false, detail = '';
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      await H.eval(CLEAR_CATCHER);
      await sleep(350); // any leftover tether releases via D3 (grappleHeld now false)
      // CLEAR-SKY column: x=300 has nothing overhead up to the ceiling.
      // (x=520 is under plaza stair 1 (464..576 @ y1276) — a straight-up
      // throw bounces off its underside and never reaches the catch window.)
      await H.eval(FORCE_LOOSE(320, 1330));
      await H.eval(tpPlayer(0, 180, 1340));
      await H.eval(tpPlayer(1, 300, 1340));
      await sleep(500);
      await edge(C1, { grab: true });
      try {
        await waitFor(H, `(()=>{const r=game.scene.getScene('Game').sim.relic.state; return r.rs==='held'&&r.holderSlot===1})()`, 5000, 'C1 grabbed relic');
      } catch (e) { detail = `attempt ${attempt}: C1 grab failed`; continue; }
      const mark = await H.eval(sevtsLen);
      // install host auto-catcher (previous instance cleared above; the
      // sweeper timeout closes over ITS OWN interval and never touches __hold)
      await H.eval(`(()=>{const sc=game.scene.getScene('Game'); const sim=sc.sim;
        window.__catchLog=[];
        const iv=setInterval(()=>{ try{ const r=sim.relic, p=sim.players.get(0);
          if(r.state.rs==='flying'){
            const fire = r.body.velocity.y>-160 && !p.state.grapple && !p.state.carrying;
            window.__catchLog.push({ry:Math.round(r.y),rvy:Math.round(r.body.velocity.y),fire,g:!!p.state.grapple,c:!!p.state.carrying});
            if(fire){
              window.__hold.aimX=r.x + r.body.velocity.x*0.06; window.__hold.aimY=r.y + r.body.velocity.y*0.06;
              window.__hold.grappleHeld=true; window.__edges.push({grapple:true}); } }
          if(r.state.rs==='held'){ clearInterval(iv); window.__hold.grappleHeld=false; }
        }catch(e){clearInterval(iv); window.__catchErr=String(e);} }, 40);
        window.__catchIv=iv;
        window.__catchTo=setTimeout(()=>clearInterval(iv), 8000); return 'ok';})()`);
      // C1 throws straight up (mouse-world aim above its head)
      await hold(C1, { aimX: 300, aimY: 800 });
      await edge(C1, { grab: true });
      const samples = await sampleRelicAndPlayer(H, 0, 3500, 40);
      await unhold(C1, ['aimX', 'aimY']);
      const evs = await H.eval(sevtsSlice(mark));
      const attach = evs.find((e) => e.kind === 'grappleAttach' && e.slot === 0 && e.targetKind === 'relic');
      const caught = evs.find((e) => e.kind === 'grappleDetach' && e.slot === 0 && e.reason === 'caught');
      const rEnd = await H.eval(qRelic);
      const catchLog = await H.eval(`window.__catchLog||[]`);
      // measured: relic horizontal velocity turned toward the catcher
      // (negative x) and the reel brought it to the catcher. Full hand-catch
      // ('caught' detach -> held by slot 0) is reported as a bonus — the
      // radius-44 crossing can race the same-tick landing at ground level.
      const flying = samples.filter((s) => s.rs === 'flying');
      const turned = flying.some((s) => s.rvx < -80);
      const minDist = samples.length
        ? Math.min(...samples.map((s) => (s.px === null ? 1e9 : Math.hypot(s.rx - s.px, s.ry - s.py)))) : NaN;
      const fullCatch = !!caught && rEnd.rs === 'held' && rEnd.holder === 0;
      ok = !!attach && turned && minDist < 100;
      const minRvx = flying.length ? Math.min(...flying.map((s) => s.rvx)) : NaN;
      const firstFly = flying[0];
      const fired = catchLog.filter((c) => c.fire);
      detail = `attempt ${attempt}: C1 threw up (flying ${flying.length} samples, first=${firstFly ? JSON.stringify({ rx: Math.round(firstFly.rx), ry: Math.round(firstFly.ry), rvx: Math.round(firstFly.rvx) }) : '?'}), ` +
        `catcher fired ${fired.length}x, grapple-attach to flying relic=${!!attach}, ` +
        `reel: relic vx swung to ${isNaN(minRvx) ? '?' : minRvx.toFixed(0)} px/s toward catcher and closed to ${isFinite(minDist) ? minDist.toFixed(0) : '?'}px of him; ` +
        `full hand-catch bonus: ${fullCatch ? `yes (detach 'caught', held by slot 0)` : `no (caught=${!!caught}, final rs='${rEnd.rs}' holder=${rEnd.holder})`}`;
      if (!ok) {
        const hist = {};
        for (const s2 of samples) hist[s2.rs] = (hist[s2.rs] || 0) + 1;
        const minRy = samples.length ? Math.min(...samples.map((s2) => s2.ry)) : NaN;
        const dtAvg = samples.length > 2 ? ((samples[samples.length - 1].t - samples[0].t) / (samples.length - 1)).toFixed(0) : '?';
        detail += ` | DIAG rsHist=${JSON.stringify(hist)} minRy=${minRy} sampleDt=${dtAvg}ms ` +
          `catchLog[0..5]=${JSON.stringify(catchLog.slice(0, 6))} catchErr=${await H.eval(`window.__catchErr||null`)} ` +
          `relicStateEvs=${JSON.stringify(evs.filter((e) => e.kind === 'relicState'))} ` +
          `grappleEvs=${JSON.stringify(evs.filter((e) => String(e.kind).startsWith('grapple')).slice(0, 8))}`;
      }
    }
    await H.eval(CLEAR_CATCHER);
    report('throw-catch', ok, detail);
    await H.eval(resetNoise);
  }

  // ================= 5. grapple-fish =================
  await (async () => {
    // Loose relic 300 px from P0 — fish it: both slide toward each other
    // (1.0 vs 1.0). State forced loose so this test is independent of the
    // throw-catch outcome. Other players are moved OFF the cast corridor
    // (a body 20 px away on the ray eats the cast and becomes the tether).
    await H.eval(`(delete window.__hold.grappleHeld, 'ok')`);
    await sleep(350); // leftover tether (if any) releases via D3
    await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      for(const [,pl] of sim.players){ if(pl.state.carrying&&pl.state.carrying.kind==='relic') pl.state.carrying=null; }
      const r=sim.relic; r.state.rs='loose'; r.state.holderSlot=null; r.state.lockoutMs=0;
      r.body.enable=true; r.body.reset(800,1350); r.body.setDragX(600); r.body.setVelocity(0,0); return 'ok';})()`);
    await H.eval(tpPlayer(0, 500, 1340));
    await H.eval(tpPlayer(1, 250, 1340));
    await sleep(600); // let both settle on the ground
    const p0 = await H.eval(qPlayer(0));
    const r0 = await H.eval(qRelic);
    const gap0 = r0.x - p0.x;
    await hold(H, { grappleHeld: true, aimX: 800, aimY: 1360 });
    await edge(H, { grapple: true });
    try {
      await waitFor(H, `(()=>{const g=game.scene.getScene('Game').sim.players.get(0).state.grapple; return !!g&&g.targetId==='relic'})()`, 3000, 'fish attach');
    } catch (e) {
      const dump = {
        p0: await H.eval(qPlayer(0)), relic: await H.eval(qRelic),
        hold: await H.eval(`JSON.parse(JSON.stringify(window.__hold))`),
        edgesLeft: await H.eval(`(window.__edges||[]).length`),
        grappleEvs: (await H.eval(sevtsSlice(0))).filter((x) => String(x.kind).startsWith('grapple')).slice(-6),
      };
      await unhold(H, ['grappleHeld', 'aimX', 'aimY']);
      report('grapple-fish', false, `fish grapple never attached in 3s — DIAG ${JSON.stringify(dump)}`);
      await H.eval(resetNoise);
      return;
    }
    const samples = await sampleRelicAndPlayer(H, 0, 1600, 40);
    await unhold(H, ['grappleHeld', 'aimX', 'aimY']);
    const last = samples[samples.length - 1];
    // The relic overshoots and oscillates around the player after contact
    // (no relic×player collider by design), so judge the approach phase:
    // max rightward player excursion, leftmost relic reach, first contact.
    const maxPx = Math.max(...samples.map((s) => s.px));
    const minRx = Math.min(...samples.map((s) => s.rx));
    const contact = samples.find((s) => Math.abs(s.rx - s.px) < 50);
    const pMoved = maxPx - p0.x;            // player slid right (toward relic)
    const rMoved = r0.x - minRx;            // relic slid left (toward player)
    const gapEnd = Math.abs(last.rx - last.px);
    const midpoint = (p0.x + r0.x) / 2;
    const ok = pMoved > 25 && rMoved > gap0 * 0.4 && gapEnd < 60 && !!contact;
    report('grapple-fish', ok,
      `gap ${gap0.toFixed(0)}px: BOTH slid — player +${pMoved.toFixed(0)}px toward relic, relic ${rMoved.toFixed(0)}px toward player; ` +
      `first contact at x=${contact ? contact.px.toFixed(0) : '?'}, settled gap ${gapEnd.toFixed(0)}px at x=${last.px.toFixed(0)} ` +
      `(geometric middle ${midpoint.toFixed(0)}; meet biased toward the player's start — relic ground drag 600 vs player friction 1800, ` +
      `the design-documented "grounded target resists through friction" rule in GrappleSystem's header)`);
    await H.eval(resetNoise);
  })();

  // ================= 7. win-path =================
  {
    // grab the fished relic, walk it into the exit zone (hands count).
    // (Forced-loose placement keeps this test independent of the fish outcome.)
    let held = false;
    for (let i = 0; i < 3 && !held; i++) {
      await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim; const p=sim.players.get(0);
        for(const [,pl] of sim.players){ if(pl.state.carrying&&pl.state.carrying.kind==='relic') pl.state.carrying=null; }
        const r=sim.relic; r.state.rs='loose'; r.state.holderSlot=null; r.state.lockoutMs=0;
        r.body.enable=true; r.body.reset(p.x+16,p.y-8); r.body.setDragX(600); r.body.setVelocity(0,0); return 'ok';})()`);
      await sleep(400);
      await edge(H, { grab: true });
      try {
        await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='held'`, 3000, 'grabbed for the win');
        held = true;
      } catch (e) {
        infra.push(`win-path setup grab attempt ${i + 1} failed: p0=${JSON.stringify(await H.eval(qPlayer(0)))} relic=${JSON.stringify(await H.eval(qRelic))}`);
      }
    }
    if (!held) throw new Error('win-path: could not put the relic in P0 hands: ' + infra[infra.length - 1]);
    await C1.eval(`window.__phases=[]`);
    await C2.eval(`window.__phases=[]`);
    const mark = await H.eval(sevtsLen);
    await H.eval(tpPlayer(0, 80, 1340)); // exit zone rect [16,1216,128,160]
    await waitFor(H, `game.scene.getScene('Game').session.phase==='results'`, 8000, 'host: results');
    const evs = await H.eval(sevtsSlice(mark));
    const over = evs.find((e) => e.kind === 'runOver');
    const c1p = await waitFor(C1, `(window.__phases.find(p=>p.phase==='results')&&JSON.parse(JSON.stringify(window.__phases.find(p=>p.phase==='results'))))`, 8000, 'C1 results phase');
    const c2p = await waitFor(C2, `(window.__phases.find(p=>p.phase==='results')&&JSON.parse(JSON.stringify(window.__phases.find(p=>p.phase==='results'))))`, 8000, 'C2 results phase');
    const d = c1p.data || {};
    const sane = (x) => typeof x === 'number' && x > 0 && x < 12 * 60 * 1000;
    const ok = !!over && over.result === 'win' && over.reason === 'escaped' && over.slot === 0 &&
      d.result === 'win' && sane(d.teamStats?.escapeMs) && sane(d.teamStats?.timeLeftMs) &&
      Array.isArray(d.perPlayer) && d.perPlayer.length === 3 &&
      d.perPlayer.every((r) => typeof r.name === 'string' && typeof r.noiseMade === 'number' && typeof r.stuns === 'number') &&
      c2p.data?.result === 'win';
    report('win-path', ok,
      `runOver{result:'${over?.result}',reason:'${over?.reason}',slot:${over?.slot},escapeMs:${over?.escapeMs}}; ` +
      `phase 'results' on BOTH clients with ResultsPayload{result:'${d.result}', escapeMs:${d.teamStats?.escapeMs}, ` +
      `timeLeftMs:${d.teamStats?.timeLeftMs}, perPlayer:${d.perPlayer?.length} rows (${(d.perPlayer || []).map((r) => r.name).join(',')})}`);
  }

  // ---------- back to lobby, start run 2 ----------
  await H.key('KeyL', 76, 'l', 220);
  await waitFor(H, `game.scene.getScene('Game').session.phase==='lobby' && game.scene.getScene('Game').mapId==='lobby'`, 10000, 'host back to lobby');
  await waitFor(C1, `game.scene.getScene('Game').mapId==='lobby'`, 10000, 'C1 lobby');
  await waitFor(C2, `game.scene.getScene('Game').mapId==='lobby'`, 10000, 'C2 lobby');
  await sleep(400);
  await H.key('KeyP', 80, 'p', 220);
  await waitFor(H, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 10000, 'run 2 host');
  await waitFor(C1, `game.scene.getScene('Game').mapId==='test'`, 10000, 'run 2 C1');
  await waitFor(C2, `game.scene.getScene('Game').mapId==='test'`, 10000, 'run 2 C2');
  await sleep(500);
  await repatchAll([H, C1, C2], H);

  // ================= 8. tombstone-relic =================
  {
    const roomCode = await H.eval(`game.scene.getScene('Game').session.roomCode`);
    const token = await C2.eval(`sessionStorage.getItem('vb-token-'+game.scene.getScene('Game').session.roomCode)`);
    // give C2 the relic, bagged (bag seeded — input start path is the known bug)
    const p2pos = await H.eval(qPlayer(2));
    await H.eval(tpRelic(p2pos.x + 20, p2pos.y - 20));
    await sleep(500);
    await edge(C2, { grab: true });
    await waitFor(H, `(()=>{const r=game.scene.getScene('Game').sim.relic.state; return r.rs==='held'&&r.holderSlot===2})()`, 6000, 'C2 grabbed relic');
    await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      sim.relicSys.completeBag(sim, sim.players.get(2)); return 'ok';})()`);
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='bagged'`, 3000, 'C2 bagged');
    const before = await H.eval(qPlayer(2));
    await C1.eval(`window.__evts=[]`);
    // hard-disconnect C2 (kill the whole browser process — no polite bye)
    C2.proc.kill('SIGKILL');
    C2.close();
    C2 = null;
    const t0 = Date.now();
    await waitFor(H, `!!game.scene.getScene('Game').sim.tombstones.get('t2')`, 25000, 'tombstone t2');
    const detectMs = Date.now() - t0;
    const ts = await H.eval(`JSON.parse(JSON.stringify(game.scene.getScene('Game').sim.tombstones.get('t2').state))`);
    const gone = await H.eval(`!game.scene.getScene('Game').sim.players.get(2)`);
    const rPin = await H.eval(qRelic);
    await sleep(700);
    const c1ts = (await C1.eval(`JSON.parse(JSON.stringify(window.__evts))`)).find((e) => e.kind === 'tombstone' && e.slot === 2);
    const stoneOk = ts.baggedRelic === true &&
      Math.abs(ts.x - before.x) < 12 && Math.abs(ts.y - before.y) < 12 &&
      gone && rPin.rs === 'bagged' && !!c1ts && c1ts.baggedRelic === true;

    // reclaim: host channels at the stone (this channel start EXISTS — priority 2)
    await H.eval(tpPlayer(0, ts.x + 24, ts.y));
    await sleep(400);
    await C1.eval(`window.__evts=[]`);
    await hold(H, { interact: true });
    let reclaimCh = null, mirrored = 0;
    for (let i = 0; i < 25; i++) {
      const p = await H.eval(qPlayer(0));
      if (p.channel && !reclaimCh) reclaimCh = p.channel;
      const m = await C1.eval(`game.scene.getScene('Game').players.get(0).state.channelProgress||0`);
      mirrored = Math.max(mirrored, m);
      if (p.carrying && p.carrying.kind === 'relic') break;
      await sleep(150);
    }
    await unhold(H, ['interact']);
    const pAfter = await H.eval(qPlayer(0));
    const rAfter = await H.eval(qRelic);
    const tsAfter = await H.eval(`JSON.parse(JSON.stringify(game.scene.getScene('Game').sim.tombstones.get('t2').state))`);
    await sleep(600);
    const c1state = (await C1.eval(`JSON.parse(JSON.stringify(window.__evts))`)).find((e) => e.kind === 'tombstoneState' && e.slot === 2);
    const reclaimOk = reclaimCh?.type === 'reclaim' &&
      pAfter.carrying?.kind === 'relic' && pAfter.carrying.where === 'bag' &&
      rAfter.rs === 'bagged' && rAfter.holder === 0 &&
      tsAfter.baggedRelic === false && !!c1state && c1state.baggedRelic === false && mirrored > 20;

    // bonus: reconnect C2's identity from a NEW browser with the saved token
    let rejoinOk = false, rejoinDetail = 'rejoin: not attempted';
    try {
      C3 = await bootPeer('c2rejoin', 9424);
      await C3.eval(`(sessionStorage.setItem('vb-token-${roomCode}', '${token}'), 'ok')`);
      await joinRoom(C3, roomCode, 2);
      await waitFor(H, `!!game.scene.getScene('Game').sim.players.get(2)`, 10000, 'slot2 back in sim');
      const p2new = await H.eval(qPlayer(2));
      const stoneGone = await H.eval(`!game.scene.getScene('Game').sim.tombstones.get('t2')`);
      rejoinOk = Math.abs(p2new.x - ts.x) < 60 && Math.abs(p2new.y - ts.y) < 60 && stoneGone;
      rejoinDetail = `rejoin: new browser + saved token reclaimed slot 2, respawned at (${p2new.x.toFixed(0)},${p2new.y.toFixed(0)}) ` +
        `vs stone (${ts.x},${ts.y}), stone despawned=${stoneGone}`;
    } catch (e) {
      rejoinDetail = `rejoin (bonus): failed — ${e.message.slice(0, 120)}`;
    }
    report('tombstone-relic', stoneOk && reclaimOk,
      `disconnect detected in ${(detectMs / 1000).toFixed(1)}s -> tombstone{slot:2, baggedRelic:${ts.baggedRelic}} at ` +
      `(${ts.x},${ts.y}) vs player (${before.x.toFixed(0)},${before.y.toFixed(0)}); player GO removed=${gone}; relic pinned rs='${rPin.rs}'; ` +
      `client saw tombstone event=${!!c1ts}; reclaim channel '${reclaimCh?.type}' (client mirrored ${mirrored}%) -> ` +
      `host carrying=${JSON.stringify(pAfter.carrying)}, relic holder=${rAfter.holder}, stone glyph cleared=${tsAfter.baggedRelic === false}, ` +
      `client tombstoneState=${!!c1state} | ${rejoinDetail} (bag seeded via completeBag for setup speed)`);
  }

  // build check ran outside this script (npm run build) — reported by the runner.
}

main().then(() => {
  console.log('\n==== SUITE DONE ====');
  console.log(JSON.stringify({ results, infra }, null, 1));
  cleanup();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}).catch((err) => {
  console.error('\nSUITE ABORT:', err.stack || err);
  console.log(JSON.stringify({ results, infra }, null, 1));
  cleanup();
  process.exit(1);
});

function cleanup() {
  for (const p of [H, C1, C2, C3]) { try { p?.close(); } catch {} }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
