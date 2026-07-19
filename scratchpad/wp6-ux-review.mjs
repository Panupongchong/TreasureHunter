// ============================================================
// wp6-ux-review.mjs — Technical UX Designer review walk (solo, 1 Chrome).
// Screenshots every screen state into scratchpad/wp6-ux-shots/ for the
// spec-fidelity audit. Read-only: no product files touched.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'wp6-ux-shots');
const TMP = path.join(os.tmpdir(), 'vb-tmp-wp6-review'); // OUTSIDE the vite-watched tree
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

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
      this.errors.push(d?.exception?.description || d?.text || 'unknown');
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate',
      { expression: expr, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error('page exception: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 400));
    }
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async key(code, vk, key, holdMs = 120) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
    log('shot: ' + file);
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function waitFor(page, expr, timeoutMs, label) {
  const guarded = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.eval(guarded)) return true;
    await sleep(120);
  }
  throw new Error(`timeout waiting for: ${label || expr}`);
}

const PATCH_INPUT = `(()=>{ const sc=game.scene.getScene('Game'); if(!sc||!sc.inputManager) return 'no-scene';
  const im=sc.inputManager;
  window.__hold={}; window.__edges=[];
  if(!im.__patched){ im.__patched=true; const orig=im.poll.bind(im);
    im.poll=()=>{ const f=orig(); Object.assign(f, window.__hold||{});
      if((window.__edges||[]).length) Object.assign(f, window.__edges.shift());
      return f; }; }
  return 'ok'; })()`;

mkdirSync(SHOTS, { recursive: true });
mkdirSync(TMP, { recursive: true });
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9612', `--user-data-dir=${path.join(TMP, 'p')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
  '--window-size=1000,600',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });

const page = new Cdp(9612);
try {
  await page.connect();
  await page.navigate(APP);
  await waitFor(page, `!!window.game && game.scene.getScene('Menu') && game.scene.getScene('Menu').scene.isActive()`, 15000, 'menu up');
  await sleep(600);

  // ----- 1. main menu -----
  await page.shot('01-menu.png');

  // ----- 2. join code entry (2 letters typed → disabled JOIN) -----
  await page.key('ArrowDown', 40, 'ArrowDown');
  await sleep(120);
  await page.key('Enter', 13, 'Enter');
  await sleep(300);
  await page.key('KeyK', 75, 'k');
  await page.key('KeyQ', 81, 'q');
  await sleep(300);
  await page.shot('02-join-partial.png');
  await page.key('KeyR', 82, 'r');
  await page.key('KeyZ', 90, 'z');
  await sleep(300);
  await page.shot('03-join-full.png');
  await page.key('Escape', 27, 'Escape');
  await sleep(300);

  // ----- 3. settings -----
  await page.eval(`(()=>{const m=game.scene.getScene('Menu'); m._showSettings(); return m.state})()`);
  await sleep(300);
  await page.shot('04-settings.png');
  // name edit mode
  await page.key('Enter', 13, 'Enter');
  await sleep(200);
  await page.shot('05-settings-nameedit.png');
  await page.key('Escape', 27, 'Escape');
  await sleep(200);
  await page.key('Escape', 27, 'Escape');
  await sleep(300);

  // ----- 4. solo lobby -----
  const menuState = await page.eval(`game.scene.getScene('Menu').state`);
  log('menu state before solo: ' + menuState);
  await page.eval(`(()=>{const m=game.scene.getScene('Menu'); m._solo(); return 'ok'})()`);
  await waitFor(page, `(()=>{const g=game.scene.getScene('Game');return g&&g.scene.isActive()&&g.mode==='solo'})()`, 8000, 'solo game');
  await sleep(800);
  await page.shot('06-solo-lobby.png');

  // walk to the stage board (x=320) → popup on proximity
  await page.eval(PATCH_INPUT);
  await page.eval(`(game.scene.getScene('Game').sim.players.get(0).body.reset(320, 500), 'ok')`);
  await sleep(500);
  await page.shot('07-lobby-board-popup.png');

  // near weapon rack for prompt
  await page.eval(`(game.scene.getScene('Game').sim.players.get(0).body.reset(170, 470), 'ok')`);
  await sleep(400);
  await page.shot('08-lobby-rack-prompt.png');

  // ready zone → ring fills
  await page.eval(`(game.scene.getScene('Game').sim.players.get(0).body.reset(480, 500), 'ok')`);
  await sleep(1500);
  await page.shot('09-ready-filling.png');
  await waitFor(page, `game.scene.getScene('Game').session.phase==='playing'`, 8000, 'run start');
  await sleep(900); // banner mid-hold
  await page.shot('10-playing-banner.png');
  await sleep(1800); // banner gone
  await page.shot('11-playing-hud.png');

  // ----- 5. HUD detail probes -----
  await page.eval(PATCH_INPUT); // restarted scene
  // ping marker on-screen
  await page.eval(`(()=>{const g=game.scene.getScene('Game');const p=g.sim.players.get(0);
    window.__edges.push({ping:true, aimX:p.body.x+150, aimY:p.body.y}); return 'ok'})()`);
  await sleep(400);
  await page.shot('12-ping-marker.png');
  // noise burst → gauge tick + ripple (drive an attack)
  await page.eval(`(window.__edges.push({attack:true}), 'ok')`);
  await sleep(250);
  await page.shot('13-noise-ripple.png');
  // clock urgency: force clock under 3 min (host sim truth, review probe only)
  await page.eval(`(()=>{const g=game.scene.getScene('Game');
    g.sim.world.clockMsLeft = 170*1000; return 'ok'})()`);
  await sleep(1200);
  await page.shot('14-clock-urgency2.png');
  // stun the local player (probe the mash bar; sim-side poke)
  const stunProbe = await page.eval(`(()=>{const g=game.scene.getScene('Game');
    const p=g.sim.players.get(0);
    if (g.sim.stunSys && g.sim.stunSys.applyStun) { g.sim.stunSys.applyStun(g.sim, p, 'probe'); return 'sys'; }
    p.state.stunned=true; p.state.stunMsLeft=6000; return 'flag'; })()`);
  log('stun probe: ' + stunProbe);
  await sleep(500);
  await page.shot('15-stunned.png');

  // ----- 6. results (debug R) + back (L) -----
  await page.key('KeyR', 82, 'r');
  await waitFor(page, `game.scene.getScene('Game').session.phase==='results'`, 5000, 'results');
  await sleep(1400); // let entrance juice finish
  await page.shot('16-results.png');
  await page.key('KeyL', 76, 'l');
  await waitFor(page, `(()=>{const g=game.scene.getScene('Game');return g.session.phase==='lobby'})()`, 8000, 'back to lobby');
  await sleep(700);
  await page.shot('17-back-lobby.png');

  const errs = page.errors.filter((e) => !/favicon/.test(e));
  log('page errors: ' + (errs.length ? errs.slice(0, 5).join(' | ') : 'none'));
} catch (err) {
  console.error('WALK FAILED: ' + err.message);
} finally {
  page.close();
  proc.kill();
}
