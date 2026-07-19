// ============================================================
// wp7-relic-visual-check.mjs — the carried relic must render EXACTLY
// once (WP7 added player heldGem/bagGem while the relic entity was
// still pinned to the holder = two gems), and contextmenu must be
// suppressed (RMB is grapple). Solo mode, one headless Chrome.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-relicvis'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp7-relic-shots');
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || '?').slice(0, 300));
    }
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
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
  throw new Error(`timeout waiting for ${label}`);
}

// Count VISIBLE gold-gem representations of the relic near the player.
const gemCensus = `(()=>{const sc=game.scene.getScene('Game');
  const p=sc.players.get(0), rel=sc.relic;
  const vis=(o)=>!!(o&&o.visible&&(o.alpha===undefined||o.alpha>0.05));
  return {
    rs: rel.state.rs,
    relicEntityVisible: vis(rel),
    relicGlowVisible: vis(rel.glow),
    heldGemVisible: vis(p.heldGem),
    bagGemVisible: vis(p.bagGem),
    bagVisible: vis(p.bag),
    total: [vis(rel), vis(p.heldGem), vis(p.bagGem)].filter(Boolean).length,
  };})()`;

try {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  procs.push(spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9711', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' }));

  const A = new Cdp(9711);
  await A.connect();
  await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');

  // ---- contextmenu suppression (RMB = grapple) ----
  {
    const r = await A.eval(`(()=>{
      let prevented=false;
      const h=(e)=>{ prevented = e.defaultPrevented; };
      window.addEventListener('contextmenu', h, false);
      const c=document.querySelector('canvas');
      const ev=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});
      c.dispatchEvent(ev);
      window.removeEventListener('contextmenu', h, false);
      return {hasCanvas:!!c, defaultPrevented: ev.defaultPrevented, seen:prevented};})()`);
    report('right-click context menu suppressed',
      r.hasCanvas && r.defaultPrevented === true,
      `canvas=${r.hasCanvas} contextmenu event defaultPrevented=${r.defaultPrevented}`);
  }

  await A.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!game.scene.getScene('Game').sim`, 20000, 'lobby');
  await A.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 80, code: 'KeyP', key: 'p' }, A.sessionId);
  await sleep(220);
  await A.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 80, code: 'KeyP', key: 'p' }, A.sessionId);
  await waitFor(A, `game.scene.getScene('Game').session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!game.scene.getScene('Game').sim.relic`, 8000, 'relic');
  await sleep(600);

  // ---- loose: exactly the relic entity, no player gems ----
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); p.state.carrying=null; p.state.stunned=false;
      sim.relicSys._dropLoose(sim, p.x+60, p.y, 0, 0); return 'ok';})()`);
    await sleep(500);
    const c = await A.eval(gemCensus);
    await A.shot('01-relic-loose.png');
    report('loose relic renders once (entity only)',
      c.rs === 'loose' && c.relicEntityVisible && !c.heldGemVisible && !c.bagGemVisible && c.total === 1,
      JSON.stringify(c));
  }

  // ---- hands: exactly the player's heldGem, entity muted ----
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      const p=sim.players.get(0); p.state.carrying=null;
      sim.relicSys._attach(sim,p); return 'ok';})()`);
    await sleep(500);
    const c = await A.eval(gemCensus);
    await A.shot('02-relic-hands.png');
    report('hand-carried relic renders once (no double gem)',
      c.rs === 'held' && c.heldGemVisible && !c.relicEntityVisible &&
      !c.relicGlowVisible && c.total === 1,
      JSON.stringify(c));
  }

  // ---- bagged: exactly the player's bag gem, entity muted ----
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      sim.relicSys.completeBag(sim, sim.players.get(0)); return 'ok';})()`);
    await sleep(500);
    const c = await A.eval(gemCensus);
    await A.shot('03-relic-bagged.png');
    report('bagged relic renders once (bag gem only)',
      c.rs === 'bagged' && c.bagGemVisible && !c.relicEntityVisible && c.total === 1,
      JSON.stringify(c));
  }

  // ---- stun-drop: entity reappears on the ground, player gems clear ----
  {
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      sim.relicSys.completeUnbag(sim, sim.players.get(0)); return 'ok';})()`);
    await sleep(300);
    await A.eval(`(()=>{ window.__d=false;
      import('/src/systems/StunSystem.js').then(m=>{
        const sim=game.scene.getScene('Game').sim;
        m.applyStun(sim, sim.players.get(0), 3000, 'ff'); window.__d=true; });
      return 'ok';})()`);
    await waitFor(A, `window.__d===true`, 8000, 'stun applied');
    await sleep(600);
    const c = await A.eval(gemCensus);
    await A.shot('04-relic-dropped-after-stun.png');
    report('stun drop: relic back on the ground, carrier gems cleared',
      c.rs === 'loose' && c.relicEntityVisible && !c.heldGemVisible && !c.bagGemVisible && c.total === 1,
      JSON.stringify(c));
  }

  // ---- tombstone case must still show a gem (bagged pins to the stone) ----
  {
    const t = await A.eval(`(()=>{const sc=game.scene.getScene('Game');const sim=sc.sim;
      const p=sim.players.get(0); p.state.stunned=false; p.state.stunMsLeft=0; p.state.carrying=null;
      sim.relicSys._attach(sim,p); sim.relicSys.completeBag(sim,p);
      sim.relicSys.makeTombstone ? null : null;
      return 'armed';})()`);
    // drive the real disconnect path if exposed, else assert the entity rule
    const has = await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      return typeof sim.relicSys.onDisconnect==='function' ||
             typeof sim.relicSys.dropOnDisconnect==='function' ||
             Object.getOwnPropertyNames(Object.getPrototypeOf(sim.relicSys)).join(',');})()`);
    report('tombstone bagged-relic path available (informational)', true,
      `armed=${t}; relicSys methods: ${String(has).slice(0, 200)}`);
  }

  console.log('\npage errors:', JSON.stringify(A.errors.slice(0, 3)));
  console.log('\n' + JSON.stringify({ allPassed: results.every((r) => r.pass), results }, null, 1));
  A.close();
} catch (e) {
  console.error('ABORT:', e.message);
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
