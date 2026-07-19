// ============================================================
// wp7-stun-drop-check.mjs — does a stun drop a HAND-HELD relic for
// EVERY stun source? (wp5-accept only covered the fall path.)
// Solo mode, one headless Chrome instance. Dev server must be on :5173.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-stundrop'); // OUTSIDE the vite-watched tree
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

class Cdp {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    let info = null;
    for (let i = 0; i < 60; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    if (!info) throw new Error('CDP never came up');
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
      { expression: expr, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error('page exception: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 300));
    }
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
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
  throw new Error(`timeout waiting for ${label}`);
}

// Put the relic into slot-0's HANDS deterministically, clear any stun.
const armHands = `(()=>{const sc=game.scene.getScene('Game');const sim=sc.sim;
  const p=sim.players.get(0); const rel=sim.relic;
  p.state.stunned=false; p.state.stunMsLeft=0; p.state.carrying=null;
  sim.relicSys._attach(sim,p);
  return {rs:rel.state.rs, carrying:JSON.stringify(p.state.carrying)};})()`;

const relicNow = `(()=>{const sc=game.scene.getScene('Game');const sim=sc.sim;
  const p=sim.players.get(0);
  return {rs:sim.relic.state.rs, holder:sim.relic.state.holderSlot,
    carrying:p.state.carrying?JSON.stringify(p.state.carrying):null,
    stunned:!!p.state.stunned,
    heldGemVisible: !!(sc.players.get(0)&&sc.players.get(0).heldGem&&sc.players.get(0).heldGem.visible)};})()`;

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

try {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  procs.push(spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9701', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' }));

  const A = new Cdp(9701);
  await A.connect();
  await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!game.scene.getScene('Game').sim`, 20000, 'solo lobby');
  // P = start run (host debug key) -> testMap, which HAS a relic
  await A.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 80, code: 'KeyP', key: 'p' }, A.sessionId);
  await sleep(220);
  await A.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 80, code: 'KeyP', key: 'p' }, A.sessionId);
  await waitFor(A, `game.scene.getScene('Game').session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!game.scene.getScene('Game').sim.relic`, 8000, 'relic exists');
  await sleep(500);

  // ---- source 1: FALL (the one wp5-accept already covered) ----
  {
    await A.eval(armHands);
    const before = await A.eval(relicNow);
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); p.body.reset(600,600); return 'ok';})()`);
    await sleep(2500);
    const after = await A.eval(relicNow);
    report('fall-stun drops hand-held relic',
      before.rs === 'held' && after.stunned && after.rs === 'loose' &&
      after.carrying === null && after.heldGemVisible === false,
      `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`);
  }

  // ---- source 2: MONSTER hit ----
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); p.state.stunned=false; p.state.stunMsLeft=0;
      p.body.reset(2950,1350); return 'ok';})()`);
    await sleep(400);
    await A.eval(armHands);
    const before = await A.eval(relicNow);
    // Drive the real monster hit path in MonsterSystem (cause 'monster').
    const fired = await A.eval(`(()=>{const sc=game.scene.getScene('Game');const sim=sc.sim;
      const p=sim.players.get(0);
      let m=null; for(const [,mm] of sim.monsters){ m=mm; break; }
      if(!m) return 'no-monster';
      m.body.reset(p.x+10, p.y);
      m.state.ai='chase'; m.state.targetSlot=0; m.state.attackCdMs=0; m.state.stunnedMs=0;
      return 'ok';})()`);
    await sleep(3500);
    const after = await A.eval(relicNow);
    report('monster-hit stun drops hand-held relic',
      fired === 'ok' && before.rs === 'held' && after.stunned && after.rs === 'loose' &&
      after.carrying === null && after.heldGemVisible === false,
      `monsterSetup=${fired} before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`);
  }

  // ---- source 3: heavy FF (hammer) — needs a 2nd player; solo has one,
  //      so drive CombatSystem's stun entry the way a hammer hit does.
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); p.state.stunned=false; p.state.stunMsLeft=0;
      p.body.reset(600,1300); return 'ok';})()`);
    await sleep(400);
    await A.eval(armHands);
    const before = await A.eval(relicNow);
    const r = await A.eval(`(async()=>{ return 'n/a'; })()`);
    // applyStun is THE single entry point every source funnels through
    // (CombatSystem ff / MonsterSystem / FallStun all call it) — exercise
    // it with the ff cause and duration.
    await A.eval(`(()=>{const sc=game.scene.getScene('Game');
      const mod=sc.__stunmod; return 'ok';})()`);
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0);
      // mirror CombatSystem line: applyStun(sim,t,FF.hammerStunMs,'ff')
      sim.stunSys ? null : null;
      return 'ok';})()`);
    // Use the real exported applyStun via a dynamic import in-page.
    await A.eval(`(()=>{ window.__ffDone=false;
      import('/src/systems/StunSystem.js').then(m=>{
        const sim=game.scene.getScene('Game').sim;
        m.applyStun(sim, sim.players.get(0), 2000, 'ff');
        window.__ffDone=true;
      }); return 'ok';})()`);
    await waitFor(A, `window.__ffDone===true`, 8000, 'ff stun applied');
    await sleep(200);
    const after = await A.eval(relicNow);
    report('heavy-FF stun drops hand-held relic',
      before.rs === 'held' && after.stunned && after.rs === 'loose' &&
      after.carrying === null && after.heldGemVisible === false,
      `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`);
  }

  // ---- control: BAGGED relic must SURVIVE a stun (CLAUDE.md locked) ----
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); p.state.stunned=false; p.state.stunMsLeft=0;
      p.body.reset(600,1300); return 'ok';})()`);
    await sleep(400);
    await A.eval(armHands);
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      sim.relicSys.completeBag(sim, sim.players.get(0)); return 'ok';})()`);
    const before = await A.eval(relicNow);
    await A.eval(`(()=>{ window.__bagDone=false;
      import('/src/systems/StunSystem.js').then(m=>{
        const sim=game.scene.getScene('Game').sim;
        m.applyStun(sim, sim.players.get(0), 2000, 'ff');
        window.__bagDone=true;
      }); return 'ok';})()`);
    await waitFor(A, `window.__bagDone===true`, 8000, 'bag stun applied');
    await sleep(200);
    const after = await A.eval(relicNow);
    report('BAGGED relic survives stun (locked design)',
      before.rs === 'bagged' && after.stunned && after.rs === 'bagged' && after.carrying !== null,
      `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`);
  }

  console.log('\npage errors:', JSON.stringify(A.errors.slice(0, 3)));
  console.log('\n' + JSON.stringify({ allPassed: results.every((r) => r.pass), results }, null, 1));
  A.close();
} catch (e) {
  console.error('ABORT:', e.message);
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
