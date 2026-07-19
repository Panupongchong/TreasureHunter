// ============================================================
// wp6-smoke.mjs — WP6 UI-half smoke check (solo path, one Chrome).
// 1) menu renders + keyboard nav moves focus + Enter activates
// 2) solo lobby shows badge/roster UI
// 3) standing in the ready zone starts a solo run
// 4) HUD appears with clock + noise gauge
// Expects `npm run dev` already serving on :5173.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'tmp-wp6');
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function report(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

class Cdp {
  constructor(port, name) { this.port = port; this.name = name; this.id = 0; this.pending = new Map(); this.errors = []; }
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
  async key(code, vk, key, holdMs = 200) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    writeFileSync(path.join(TMP, file), Buffer.from(data, 'base64'));
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

mkdirSync(TMP, { recursive: true });
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9601', `--user-data-dir=${path.join(TMP, 'p')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
  '--window-size=1024,720',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });

const page = new Cdp(9601, 'solo');
try {
  await page.connect();
  await page.navigate(APP);
  await waitFor(page, `!!window.game && game.scene.getScene('Menu') && game.scene.getScene('Menu').scene.isActive()`, 15000, 'menu up');
  await sleep(500);

  // ----- 1. menu renders + keyboard nav -----
  const menu = await page.eval(`(()=>{const m=game.scene.getScene('Menu');
    return {state:m.state, idx:m.nav.index, items:m.nav.items.length,
      focusText:m.nav.items[m.nav.index]?.go.text, marker:m.nav.marker.visible};})()`);
  await page.shot('01-menu.png');
  report('menu-renders', menu.state === 'menu' && menu.items >= 4 && menu.marker,
    JSON.stringify(menu));

  await page.key('ArrowDown', 40, 'ArrowDown');
  await sleep(150);
  await page.key('ArrowDown', 40, 'ArrowDown');
  await sleep(150);
  const nav = await page.eval(`(()=>{const m=game.scene.getScene('Menu');
    return {idx:m.nav.index, focusText:m.nav.items[m.nav.index]?.go.text};})()`);
  report('menu-kb-nav', nav.idx === 2 && /PRACTICE/.test(nav.focusText), JSON.stringify(nav));

  // Enter activates PRACTICE (SOLO)
  await page.key('Enter', 13, 'Enter');
  await waitFor(page, `(()=>{const g=game.scene.getScene('Game');return g&&g.scene.isActive()&&g.mode==='solo'})()`, 8000, 'solo game');
  await sleep(700);

  // ----- 2. solo lobby UI -----
  const lobby = await page.eval(`(()=>{const ui=game.scene.getScene('UI');const g=game.scene.getScene('Game');
    return {phase:g.session.phase, lobbyActive:ui.lobbyUI._active, rows:ui.lobbyUI.rosterRows.length,
      ringText:ui.lobbyUI.ringText.text, mapId:g.mapId,
      row:g.getWorldRow()};})()`);
  await page.shot('02-solo-lobby.png');
  report('solo-lobby-ui', lobby.phase === 'lobby' && lobby.lobbyActive && lobby.rows > 0 &&
    /^READY \d\/\d$/.test(lobby.ringText), JSON.stringify(lobby));

  // ----- 3. ready zone starts the run -----
  await page.eval(PATCH_INPUT);
  await page.eval(`(game.scene.getScene('Game').sim.players.get(0).body.reset(480, 500), 'ok')`);
  await sleep(600);
  const filling = await page.eval(`game.scene.getScene('Game').getWorldRow()`);
  await page.shot('03-ready-filling.png');
  report('ready-filling', filling.rz > 0 && filling.rzN === 1 && filling.rzM === 1,
    JSON.stringify(filling));
  await waitFor(page, `game.scene.getScene('Game').session.phase==='playing'`, 8000, 'run start');
  report('ready-starts-run', true, 'phase=playing after standing in zone');
  await sleep(1200);

  // ----- 4. HUD with clock + noise gauge -----
  const hud = await page.eval(`(()=>{const ui=game.scene.getScene('UI');const g=game.scene.getScene('Game');
    return {mapId:g.mapId, clockVisible:ui.hud.clockText.visible, clockText:ui.hud.clockText.text,
      noiseVisible:ui.hud.noiseGfx.visible, bannerText:ui.hud.bannerText.text,
      row:g.getWorldRow()};})()`);
  await page.shot('04-playing-hud.png');
  report('hud-playing', hud.clockVisible && /^\d{2}:\d{2}$/.test(hud.clockText) &&
    hud.noiseVisible && hud.mapId === 'test', JSON.stringify(hud));

  // ----- bonus: ping marker (Q edge) + results via R + return via L -----
  await page.eval(PATCH_INPUT); // scene restarted → repatch
  await page.eval(`(window.__edges.push({ping:true, aimX:600, aimY:1300}), 'ok')`);
  await sleep(400);
  const pings = await page.eval(`game.scene.getScene('Game').worldUI.pings.length`);
  report('ping-marker', pings >= 1, `pings=${pings}`);

  await page.key('KeyR', 82, 'r');
  await waitFor(page, `game.scene.getScene('Game').session.phase==='results'`, 5000, 'results');
  await sleep(600);
  const res = await page.eval(`(()=>{const ui=game.scene.getScene('UI');
    return {visible:ui.resultsUI.visible, navItems:ui.resultsUI.nav?.items.length};})()`);
  await page.shot('05-results.png');
  report('results-ui', res.visible && res.navItems === 2, JSON.stringify(res));

  await page.key('KeyL', 76, 'l');
  await waitFor(page, `(()=>{const g=game.scene.getScene('Game');return g.session.phase==='lobby'&&g.mapId==='lobby'})()`, 8000, 'back to lobby');
  await sleep(600);
  const back = await page.eval(`(()=>{const ui=game.scene.getScene('UI');
    return {lobbyActive:ui.lobbyUI._active, results:ui.resultsUI.visible};})()`);
  await page.shot('06-back-lobby.png');
  report('return-to-lobby', back.lobbyActive && !back.results, JSON.stringify(back));

  const errs = page.errors.filter((e) => !/favicon/.test(e));
  report('no-page-errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');
} catch (err) {
  report('smoke', false, err.message);
} finally {
  page.close();
  proc.kill();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
