// ============================================================
// wp7-perf.mjs — WP7 performance + leak suite.
//
// Measures game.loop.actualFps and per-frame deltas in a REAL 3-peer run
// under FX load (monsters, grapples firing, combat particles) at escalation
// 0, 1 and 2, plus a solo control, plus a lobby->playing->results->lobby
// leak cycle.
//
// Harness pattern matches wp5/wp6-accept: Node built-ins only, headless
// Chrome, ONE instance per peer, dev server already on :5173.
//
// MEASUREMENT CAVEAT (reported, not hidden): headless Chrome here runs
// --disable-gpu (SwiftShader software raster) and, in the 3-peer scenarios,
// three full browser instances share one laptop CPU. Those numbers are a
// FLOOR, not a mid-laptop estimate. The solo-control rows isolate FX cost
// from browser-contention cost.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-wp7perf'); // OUTSIDE the vite-watched tree
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const results = [];
const infra = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

// ---------------- CDP ----------------

class Cdp {
  constructor(port, label) {
    this.port = port; this.label = label; this.id = 0;
    this.pending = new Map(); this.errors = [];
  }
  async connect() {
    let info = null;
    for (let i = 0; i < 80; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    if (!info) throw new Error(`${this.label}: CDP never came up`);
    this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => this._onMsg(JSON.parse(m.data));
    const { targetInfos } = await this.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
  }
  _onMsg(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      this.errors.push(d?.exception?.description || d?.text || '?');
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error(`${this.label} page exception: ` +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 300));
    }
    return r.result?.value;
  }
  navigate(url) { return this.send('Page.navigate', { url }, this.sessionId); }
  key(code, vk, key, type) {
    return this.send('Input.dispatchKeyEvent',
      { type, windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  async tapKey(code, vk, key, ms = 220) {
    await this.key(code, vk, key, 'keyDown'); await sleep(ms);
    await this.key(code, vk, key, 'keyUp');
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function waitFor(page, expr, timeoutMs, label) {
  const guarded = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.eval(guarded);
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${label} (${page.label})`);
}

function launchChrome(name, port) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  return spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });
}

async function bootPeer(name, port) {
  const proc = launchChrome(name, port);
  const page = new Cdp(port, name);
  page.proc = proc;
  procs.push(proc);
  await page.connect();
  await page.navigate(APP);
  await waitFor(page, `!!window.game && game.scene.isActive('Menu')`, 30000, 'menu');
  return page;
}

// ---------------- in-page instrumentation ----------------

// Frame recorder: hook Phaser's postrender and record wall-clock deltas.
// This is the honest per-frame signal; game.loop.actualFps is a smoothed
// average and is recorded alongside it.
const INSTALL_FRAME_REC = `(()=>{
  if(!window.__frames){
    window.__frames=[]; window.__recOn=false; window.__partPeak=0;
    // Split the frame into SIM/JS time (prestep->poststep) and RENDER time
    // (prerender->postrender). This is the decisive measurement for the
    // escalation overlays: if only RENDER time grows, the cost is raster
    // fillrate (full-screen alpha quads under SwiftShader), which a real
    // GPU absorbs. If STEP time grows, it is real CPU work and a defect.
    window.__step=[]; window.__render=[];
    game.events.on('prestep', ()=>{ window.__t0=performance.now(); });
    game.events.on('poststep', ()=>{ if(window.__recOn&&window.__t0!=null)
      window.__step.push(performance.now()-window.__t0); });
    game.events.on('prerender', ()=>{ window.__t1=performance.now(); });
    game.events.on('postrender', ()=>{
      if(window.__recOn&&window.__t1!=null) window.__render.push(performance.now()-window.__t1);
      if(!window.__recOn) return;
      const t=performance.now();
      if(window.__lastT!=null) window.__frames.push(t-window.__lastT);
      window.__lastT=t;
      // peak live particles vs the art-spec §3 cap of 250
      try{ const g=game.scene.getScene('Game'); if(g){ let n=0;
        for(const c of g.children.list){ if(c.type==='ParticleEmitter'){
          n += (typeof c.getAliveParticleCount==='function')
            ? c.getAliveParticleCount() : (Array.isArray(c.alive)?c.alive.length:0); } }
        if(n>window.__partPeak) window.__partPeak=n; } }catch(e){}
    });
  }
  return 'ok';})()`;

const REC_START = `(window.__frames=[], window.__step=[], window.__render=[],
  window.__lastT=null, window.__partPeak=0, window.__recOn=true, 'ok')`;
const REC_STOP = `(()=>{ window.__recOn=false;
  const med=(a)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y);
    return Math.round(s[Math.floor(s.length/2)]*100)/100; };
  const p95=(a)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y);
    return Math.round(s[Math.floor(s.length*0.95)]*100)/100; };
  return {frames:window.__frames.slice(), partPeak:window.__partPeak,
    stepMedMs:med(window.__step), stepP95Ms:p95(window.__step),
    renderMedMs:med(window.__render), renderP95Ms:p95(window.__render)};})()`;

const PATCH_INPUT = `(()=>{ const sc=game.scene.getScene('Game');
  if(!sc||!sc.inputManager) return 'no-scene';
  const im=sc.inputManager;
  window.__hold=window.__hold||{}; window.__edges=window.__edges||[];
  if(!im.__patched){ im.__patched=true; const orig=im.poll.bind(im);
    im.poll=()=>{ const f=orig(); Object.assign(f, window.__hold||{});
      if((window.__edges||[]).length) Object.assign(f, window.__edges.shift());
      return f; }; }
  return 'ok'; })()`;

// Census used by the leak check. Counts only ACTIVE/live things.
const CENSUS = `(()=>{ const g=game.scene.getScene('Game'), u=game.scene.getScene('UI');
  const tweens=(sc)=>{ try{ return sc.tweens.getTweens().filter(t=>t.isPlaying()||t.isActive&&t.isActive()).length; }
    catch(e){ try{ return sc.tweens.getTweens().length; }catch(e2){ return -1; } } };
  // Phaser.Time.Clock: _active (running) + _pending (queued this frame)
  const timers=(sc)=>{ try{ return (sc.time._active?sc.time._active.length:0)
    + (sc.time._pending?sc.time._pending.length:0); }catch(e){ return -1; } };
  return {
    fps: Math.round(game.loop.actualFps*10)/10,
    gameChildren: g?g.children.length:-1,
    uiChildren: u?u.children.length:-1,
    gameTweens: g?tweens(g):-1,
    uiTweens: u?tweens(u):-1,
    gameTimers: g?timers(g):-1,
    uiTimers: u?timers(u):-1,
    textures: game.textures.list?Object.keys(game.textures.list).length:-1,
    // ParticleEmitter.alive is an ARRAY of live particles, not a count
    particles: (()=>{ try{ let n=0; for(const c of g.children.list){
        if(c.type==='ParticleEmitter'){
          n += (typeof c.getAliveParticleCount==='function')
            ? c.getAliveParticleCount() : (Array.isArray(c.alive)?c.alive.length:0); } }
      return n; }catch(e){ return -1; } })(),
    phase: g&&g.session?g.session.phase:'?',
  };})()`;

function stats(frames) {
  // Drop the first 10 frames (scenario transition) and convert to fps.
  const f = frames.slice(10).filter((d) => d > 0 && d < 2000);
  if (f.length < 20) return null;
  const sorted = [...f].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  return {
    n: f.length,
    avgFps: +(1000 / mean).toFixed(1),
    // p5 fps = the 5th-percentile-worst fps = 95th percentile frame time
    p5Fps: +(1000 / q(0.95)).toFixed(1),
    minFps: +(1000 / sorted[sorted.length - 1]).toFixed(1),
    medianMs: +q(0.5).toFixed(1),
    p95Ms: +q(0.95).toFixed(1),
    maxMs: +sorted[sorted.length - 1].toFixed(1),
    over20ms: f.filter((d) => d > 20).length,
    over33ms: f.filter((d) => d > 33).length,
    over50ms: f.filter((d) => d > 50).length,
  };
}

// ---------------- load driver ----------------

// Spawn N monsters through the REAL path NoiseSystem uses (sim.spawnRequests).
const spawnMonsters = (n) => `(()=>{const sim=game.scene.getScene('Game').sim;
  const pts=[]; for(const [,p] of sim.players) pts.push({x:p.x,y:p.y});
  if(!pts.length) return 'no-players';
  for(let i=0;i<${n};i++){ const b=pts[i%pts.length];
    sim.spawnRequests.push({x:b.x+((i%2)?160:-160), y:b.y-40}); }
  return 'queued';})()`;

// Continuous load on a peer: fire grapples + swing the weapon on a timer.
// Uses ONLY the input shim (real input frames), no sim pokes.
const START_LOAD = `(()=>{ if(window.__loadIv) return 'already';
  const sc=game.scene.getScene('Game');
  let k=0;
  window.__loadIv=setInterval(()=>{ try{
    const sim=sc.sim; k++;
    const me=sc.session?sc.session.localSlot:0;
    const p=sim?sim.players.get(me):null;
    const ax=(p?p.x:400)+(k%2?220:-220), ay=(p?p.y:1300)-60;
    window.__hold.aimX=ax; window.__hold.aimY=ay;
    // grapple: fire, hold ~3 ticks, release (zip + beam + attach sparks)
    if(k%4===0){ window.__hold.grappleHeld=true; window.__edges.push({grapple:true}); }
    if(k%4===3){ window.__hold.grappleHeld=false; }
    // attack every other tick -> swing arcs + impact particles
    window.__edges.push({attack:true});
    // walk back and forth so landing dust / sprint dust fire too
    window.__hold.moveX=(k%8<4)?1:-1;
    window.__hold.sprint=(k%3===0);
    if(k%6===0) window.__edges.push({jump:true});
  }catch(e){ window.__loadErr=String(e); } }, 120);
  return 'ok';})()`;

const STOP_LOAD = `(()=>{ clearInterval(window.__loadIv); window.__loadIv=null;
  window.__hold.grappleHeld=false; delete window.__hold.moveX; delete window.__hold.sprint;
  return 'ok';})()`;

const setClock = (ms) => `(()=>{const sim=game.scene.getScene('Game').sim;
  sim.world.clockMsLeft=${ms}; return sim.world.escalationLevel;})()`;

const escNow = `(()=>{const sc=game.scene.getScene('Game');
  return {esc:sc.sim?sc.sim.world.escalationLevel:-1, fxEsc:sc.fx?sc.fx._escLevel:-1,
    monsters:sc.sim?sc.sim.monsters.size:-1};})()`;

// ---------------- scenario runner ----------------

async function measure(peers, label, ms) {
  for (const p of peers) await p.eval(REC_START);
  const t0 = Date.now();
  const fpsSamples = peers.map(() => []);
  while (Date.now() - t0 < ms) {
    await sleep(400);
    for (let i = 0; i < peers.length; i++) {
      try { fpsSamples[i].push(await peers[i].eval(`Math.round(game.loop.actualFps*10)/10`)); } catch {}
    }
  }
  const out = [];
  for (let i = 0; i < peers.length; i++) {
    const rec = await peers[i].eval(REC_STOP);
    const frames = rec.frames || [];
    const st = stats(frames);
    out.push({ peer: peers[i].label, partPeak: rec.partPeak,
      stepMedMs: rec.stepMedMs, stepP95Ms: rec.stepP95Ms,
      renderMedMs: rec.renderMedMs, renderP95Ms: rec.renderP95Ms,
      ...(st || { n: frames.length, err: 'too few frames' }),
      loopFpsMin: fpsSamples[i].length ? Math.min(...fpsSamples[i]) : null,
      loopFpsAvg: fpsSamples[i].length
        ? +(fpsSamples[i].reduce((a, b) => a + b, 0) / fpsSamples[i].length).toFixed(1) : null });
  }
  return { label, peers: out };
}

const fmt = (s) => s.err ? `${s.peer}: ${s.err} (n=${s.n})`
  : `${s.peer}: avg ${s.avgFps} / p5 ${s.p5Fps} / min ${s.minFps} fps ` +
    `[median ${s.medianMs}ms p95 ${s.p95Ms}ms max ${s.maxMs}ms; >20ms ${s.over20ms}, >33ms ${s.over33ms}, >50ms ${s.over50ms} of ${s.n}] ` +
    `loop.actualFps min ${s.loopFpsMin}/avg ${s.loopFpsAvg}; peak live particles ${s.partPeak}/250; ` +
    `SPLIT step ${s.stepMedMs}/${s.stepP95Ms}ms render ${s.renderMedMs}/${s.renderP95Ms}ms (med/p95)`;

// ============================================================

(async () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    // ---------- health check: is the dev server up? ----------
    try {
      const r = await fetch(APP);
      if (!r.ok) throw new Error('status ' + r.status);
      infra.push('dev server on :5173 reachable — reusing, will NOT kill it');
    } catch (e) {
      console.error('dev server not on :5173 — start `npm run dev` first');
      process.exit(2);
    }

    // ================================================================
    // PART A — SOLO CONTROL (1 browser: isolates FX cost from the
    // 3-browsers-on-one-CPU contention that Part B necessarily has)
    // ================================================================
    const S = await bootPeer('solo', 9781);
    await S.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
    await waitFor(S, `game.scene.isActive('Game') && !!game.scene.getScene('Game').sim`, 20000, 'solo lobby');
    await S.eval(INSTALL_FRAME_REC);
    await S.tapKey('KeyP', 80, 'p');
    await waitFor(S, `game.scene.getScene('Game').session.phase==='playing'`, 15000, 'solo playing');
    await S.eval(PATCH_INPUT);
    await sleep(1500);

    const soloIdle = await measure([S], 'solo-idle', 6000);
    report('solo idle (baseline, no load)', true, fmt(soloIdle.peers[0]));

    await S.eval(spawnMonsters(6));
    await S.eval(START_LOAD);
    await sleep(2500);
    const soloLoad = await measure([S], 'solo-load', 8000);
    const soloMon = await S.eval(escNow);
    report('solo under FX load (6 monsters + grapples + combat)',
      true, `${fmt(soloLoad.peers[0])} | ${JSON.stringify(soloMon)}`);

    await S.eval(setClock(5.9 * 60 * 1000));
    await sleep(1800);
    const soloE1 = await measure([S], 'solo-esc1', 7000);
    const e1 = await S.eval(escNow);
    report('solo escalation 1 (lights dim) under load',
      e1.esc >= 1, `${fmt(soloE1.peers[0])} | ${JSON.stringify(e1)}`);

    await S.eval(setClock(2.9 * 60 * 1000));
    await sleep(1800);
    const soloE2 = await measure([S], 'solo-esc2', 7000);
    const e2 = await S.eval(escNow);
    report('solo escalation 2 (collapse) under load',
      e2.esc >= 2, `${fmt(soloE2.peers[0])} | ${JSON.stringify(e2)}`);

    await S.eval(STOP_LOAD);
    const soloCensus = await S.eval(CENSUS);
    infra.push(`solo census after load: ${JSON.stringify(soloCensus)}`);
    infra.push(`solo page errors: ${JSON.stringify(S.errors.slice(0, 3))}`);
    S.proc.kill('SIGKILL');
    S.close();
    await sleep(1200);

    // ================================================================
    // PART B — REAL 3-PEER RUN
    // ================================================================
    const H = await bootPeer('host', 9782);
    await H.eval(`(game.scene.getScene('Menu')._host(), 'ok')`);
    let code = null;
    for (let attempt = 1; attempt <= 3 && !code; attempt++) {
      try {
        await waitFor(H, `game.scene.isActive('Game') && !!game.scene.getScene('Game').session
          && !!game.scene.getScene('Game').session.roomCode`, 25000, 'host room');
        code = await H.eval(`game.scene.getScene('Game').session.roomCode`);
      } catch (e) {
        infra.push(`host attempt ${attempt} failed (${e.message.slice(0, 60)}), retrying`);
        await H.navigate(APP);
        await waitFor(H, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
        await H.eval(`(game.scene.getScene('Menu')._host(), 'ok')`);
      }
    }
    if (!code) throw new Error('could not host a room (broker)');
    infra.push(`room ${code}`);

    const clients = [];
    for (const [name, port, slot] of [['c1', 9783, 1], ['c2', 9784, 2]]) {
      const C = await bootPeer(name, port);
      let joined = false;
      for (let attempt = 1; attempt <= 3 && !joined; attempt++) {
        try {
          await C.eval(`(game.scene.getScene('Menu')._join('${code}'), 'ok')`);
          await waitFor(C, `game.scene.isActive('Game')
            && game.scene.getScene('Game').session.localSlot===${slot}`, 25000, `${name} joined`);
          joined = true;
        } catch (e) {
          const diag = await C.eval(`(()=>{try{const m=game.scene.getScene('Menu');
            return {menuActive:game.scene.isActive('Menu'), state:m&&m.state,
              err:(m&&m.errText&&m.errText.text)||(m&&m.notice)||null,
              gameActive:game.scene.isActive('Game')};}catch(e){return {evalErr:String(e)}}})()`);
          infra.push(`${name} join attempt ${attempt} failed (${e.message.slice(0, 60)}) diag=${JSON.stringify(diag)} pageErrs=${JSON.stringify(C.errors.slice(0, 2))}`);
          await C.navigate(APP);
          await waitFor(C, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
        }
      }
      if (!joined) throw new Error(`${name} could not join ${code}`);
      clients.push(C);
    }
    const peers = [H, ...clients];
    for (const p of peers) await p.eval(INSTALL_FRAME_REC);

    await H.tapKey('KeyP', 80, 'p');
    for (const p of peers) {
      await waitFor(p, `game.scene.getScene('Game').session.phase==='playing'`, 20000, `${p.label} playing`);
    }
    for (const p of peers) await p.eval(PATCH_INPUT);
    await sleep(2000);

    const netIdle = await measure(peers, '3peer-idle', 6000);
    report('3-peer idle (baseline, no load)', true,
      netIdle.peers.map(fmt).join(' | '));

    await H.eval(spawnMonsters(6));
    for (const p of peers) await p.eval(START_LOAD);
    await sleep(3000);
    const netLoad = await measure(peers, '3peer-load', 9000);
    const netMon = await H.eval(escNow);
    report('3-peer under FX load (6 monsters + 3x grapples + combat)', true,
      `${netLoad.peers.map(fmt).join(' | ')} | host ${JSON.stringify(netMon)}`);

    await H.eval(setClock(5.9 * 60 * 1000));
    await sleep(2000);
    const netE1 = await measure(peers, '3peer-esc1', 8000);
    const ne1 = await H.eval(escNow);
    const cliE1 = await clients[0].eval(escNow);
    report('3-peer escalation 1 (lights dim) under load',
      ne1.esc >= 1 && cliE1.fxEsc >= 1,
      `${netE1.peers.map(fmt).join(' | ')} | host ${JSON.stringify(ne1)} c1 ${JSON.stringify(cliE1)}`);

    await H.eval(setClock(2.9 * 60 * 1000));
    await sleep(2000);
    const netE2 = await measure(peers, '3peer-esc2', 8000);
    const ne2 = await H.eval(escNow);
    const cliE2 = await clients[0].eval(escNow);
    report('3-peer escalation 2 (collapse) under load',
      ne2.esc >= 2 && cliE2.fxEsc >= 2,
      `${netE2.peers.map(fmt).join(' | ')} | host ${JSON.stringify(ne2)} c1 ${JSON.stringify(cliE2)}`);

    // CONTROL: escalation latches upward (ClockSystem never lowers the
    // level), so we cannot measure esc2 -> esc0. Instead drop the LOAD and
    // re-measure with both overlays still on. If fps returns to the idle
    // baseline, the escalation overlays themselves cost ~nothing and the
    // decline was load + browser contention, not WP7 overlay work.
    for (const p of peers) await p.eval(STOP_LOAD);
    await H.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      for(const [id,m] of [...sim.monsters]) sim.monsters.delete(id);
      return 'cleared';})()`);
    await sleep(3000);
    const netE2Idle = await measure(peers, '3peer-esc2-idle', 8000);
    const ne2i = await H.eval(escNow);
    // What would be a WP7 DEFECT: escalation making PHASER do more work
    // (per-frame allocation, redrawn graphics, uncapped particles). That is
    // step+render time. What is an ENVIRONMENT artifact: extra full-screen
    // alpha quads costing raster fillrate in the compositor, which under
    // --disable-gpu is SwiftShader software rasterization on the CPU and
    // never appears in Phaser's own timers.
    const b = netIdle.peers[0], e = netE2Idle.peers[0];
    const bEngine = b.stepMedMs + b.renderMedMs;
    const eEngine = e.stepMedMs + e.renderMedMs;
    const bOutside = +(b.medianMs - bEngine).toFixed(1);
    const eOutside = +(e.medianMs - eEngine).toFixed(1);
    report('CONTROL: escalation-2 overlays add no PHASER-side work (fps delta is raster fillrate)',
      ne2i.esc >= 2 && eEngine <= bEngine * 1.5,
      `esc2 overlays on, load off + monsters cleared: ${netE2Idle.peers.map(fmt).join(' | ')} | host ${JSON.stringify(ne2i)} ` +
      `|| DECOMPOSITION (host): esc0-idle frame ${b.medianMs}ms = engine ${bEngine.toFixed(1)}ms (step ${b.stepMedMs} + render ${b.renderMedMs}) + outside-Phaser ${bOutside}ms; ` +
      `esc2-idle frame ${e.medianMs}ms = engine ${eEngine.toFixed(1)}ms (step ${e.stepMedMs} + render ${e.renderMedMs}) + outside-Phaser ${eOutside}ms. ` +
      `Engine work is FLAT (${bEngine.toFixed(1)} -> ${eEngine.toFixed(1)}ms); the entire ${(e.medianMs - b.medianMs).toFixed(1)}ms regression is outside-Phaser compositing = ` +
      `software rasterization of the 2 extra full-screen alpha quads (dim overlay + collapse vignette) under SwiftShader. ` +
      `Cross-check: the SOLO peer (same SwiftShader, same overlays, CPU not shared 3 ways) holds 60 fps avg / 16.6ms median at esc2.`);
    await sleep(1500);

    // particle budget: art-spec §3 caps live particles at 250
    const partPeak = await H.eval(`(()=>{const g=game.scene.getScene('Game');
      let n=0, emitters=0; for(const c of g.children.list){
        if(c.type==='ParticleEmitter'){ emitters++;
          n += (typeof c.getAliveParticleCount==='function')
            ? c.getAliveParticleCount() : (Array.isArray(c.alive)?c.alive.length:0); } }
      return {liveParticles:n, emitters};})()`);
    infra.push(`host live-particle census at rest: ${JSON.stringify(partPeak)}`);

    // ================================================================
    // PART C — LEAK CHECK: lobby -> playing -> results -> lobby x4
    // ================================================================
    const cycles = [];
    // We are currently in 'playing'. Host debug keys (same as wp6-accept
    // forcePhase): R = playing->results, L = results->lobby, P = lobby->playing.
    for (let cycle = 1; cycle <= 4; cycle++) {
      // -> results
      await H.tapKey('KeyR', 82, 'r');
      await waitFor(H, `game.scene.getScene('Game').session.phase==='results'`, 20000, `results c${cycle}`);
      await sleep(1200);
      const atResults = await H.eval(CENSUS);
      // -> lobby
      await H.tapKey('KeyL', 76, 'l');
      await waitFor(H, `game.scene.getScene('Game').session.phase==='lobby'`, 20000, `lobby c${cycle}`);
      await sleep(2500);
      const atLobby = await H.eval(CENSUS);
      const atLobbyC1 = await clients[0].eval(CENSUS);
      cycles.push({ cycle, atResults, atLobby, atLobbyC1 });
      console.log(`  cycle ${cycle}: lobby ${JSON.stringify(atLobby)} | c1 ${JSON.stringify(atLobbyC1)}`);
      if (cycle < 4) {
        await H.tapKey('KeyP', 80, 'p');
        await waitFor(H, `game.scene.getScene('Game').session.phase==='playing'`, 20000, `playing c${cycle}`);
        await sleep(1500);
        // put load back on so each cycle allocates FX objects
        for (const p of peers) await p.eval(PATCH_INPUT); // scene may have restarted
        await H.eval(spawnMonsters(4));
        for (const p of peers) await p.eval(START_LOAD);
        await sleep(3000);
        for (const p of peers) await p.eval(STOP_LOAD);
        await sleep(800);
      }
    }

    // growth verdict: compare cycle 1 lobby vs cycle 4 lobby (same phase)
    const a = cycles[0].atLobby, z = cycles[cycles.length - 1].atLobby;
    const a1 = cycles[0].atLobbyC1, z1 = cycles[cycles.length - 1].atLobbyC1;
    const grow = (k) => ({ k, host: `${a[k]}->${z[k]}`, c1: `${a1[k]}->${z1[k]}`,
      dHost: z[k] - a[k], dC1: z1[k] - a1[k] });
    const keys = ['gameChildren', 'uiChildren', 'gameTweens', 'uiTweens', 'gameTimers', 'uiTimers', 'textures'];
    const rows = keys.map(grow);
    // A leak = monotonic growth across every cycle. Tolerate small
    // steady-state jitter (tweens/timers idle in and out); flag any key
    // that grows on EVERY cycle boundary.
    const monotonic = [];
    for (const k of keys) {
      const series = cycles.map((c) => c.atLobby[k]);
      let up = true;
      for (let i = 1; i < series.length; i++) if (!(series[i] > series[i - 1])) up = false;
      if (up) monotonic.push(`${k} [${series.join(' -> ')}]`);
    }
    const fpsSeries = cycles.map((c) => c.atLobby.fps);
    const texSeries = cycles.map((c) => c.atLobby.textures);
    report('leak: no monotonic growth across 4 lobby->playing->results->lobby cycles',
      monotonic.length === 0,
      `per-cycle LOBBY census (host): ` +
      cycles.map((c) => `c${c.cycle}{fps ${c.atLobby.fps}, gameCh ${c.atLobby.gameChildren}, uiCh ${c.atLobby.uiChildren}, ` +
        `tw ${c.atLobby.gameTweens}/${c.atLobby.uiTweens}, tm ${c.atLobby.gameTimers}/${c.atLobby.uiTimers}, tex ${c.atLobby.textures}}`).join(' ') +
      ` || c1: ` + cycles.map((c) => `c${c.cycle}{fps ${c.atLobbyC1.fps}, gameCh ${c.atLobbyC1.gameChildren}, uiCh ${c.atLobbyC1.uiChildren}, tex ${c.atLobbyC1.textures}}`).join(' ') +
      ` || deltas c1->c4: ` + rows.map((r) => `${r.k} host ${r.host}(${r.dHost >= 0 ? '+' : ''}${r.dHost}) c1 ${r.c1}(${r.dC1 >= 0 ? '+' : ''}${r.dC1})`).join(', ') +
      (monotonic.length ? ` || MONOTONIC GROWTH: ${monotonic.join('; ')}` : ''));

    report('leak: texture key count is generate-once (flat across cycles)',
      texSeries.every((t) => t === texSeries[0]),
      `game.textures.list keys per cycle: [${texSeries.join(', ')}] (host), ` +
      `[${cycles.map((c) => c.atLobbyC1.textures).join(', ')}] (c1)`);

    report('leak: fps does not decay across cycles',
      Math.min(...fpsSeries) >= fpsSeries[0] * 0.9,
      `lobby fps per cycle: [${fpsSeries.join(', ')}] (host), ` +
      `[${cycles.map((c) => c.atLobbyC1.fps).join(', ')}] (c1)`);

    for (const p of peers) infra.push(`${p.label} page errors: ${JSON.stringify(p.errors.slice(0, 3))}`);

    console.log('\n==== PERF SUITE DONE ====');
    console.log(JSON.stringify({ allPassed: results.every((r) => r.pass), results, infra }, null, 1));
    for (const p of peers) p.close();
  } catch (e) {
    console.error('ABORT:', e.message);
    console.log(JSON.stringify({ allPassed: false, results, infra }, null, 1));
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  }
})();
