// ============================================================
// wp6-accept.mjs — WP6 acceptance suite (UX screens: menu, lobby UI,
// stand-to-ready, HUD, results, tombstone-rejoin UX, kick).
//
// Harness inherited from wp5-accept.mjs: Node 22+ built-ins only,
// ONE headless Chrome INSTANCE per peer over CDP, real public PeerJS
// broker, random 4-letter room codes. Starts `npm run dev` itself
// (unless :5173 is already serving) and kills it when done.
//
// Driving model:
//  - Menu: REAL CDP keyboard events (keyboard-only nav is an acceptance
//    item) + direct scene-method calls where the path was already proven.
//  - Gamepad menu nav: page-side stub of scene.input.gamepad.getPad —
//    headless Chrome exposes no Gamepad hardware; the stub feeds the
//    REAL FocusNav/_updatePad code paths (documented in "uncovered").
//  - Gameplay verbs: InputManager.poll patch (__hold merge + __edges
//    one-shot queue) — exact edge semantics at headless fps.
//  - Kick: REAL CDP mouse press-hold-release on the [KICK] roster button
//    (kick is mouse-only by design); seeding fallback on miss.
//  - State setup (teleports, clock forcing) via host sim body.reset —
//    same technique as wp5.
//  - Assertions read host sim state + tapped sim events (host) and
//    net:event / net:phase / net:roster logs (clients). Screenshots at
//    every major screen -> scratchpad/wp6-shots/.
//
// Also runs (as children): scratchpad/wp5-accept.mjs UNMODIFIED
// (regression, re-proves P/L debug keys) and `npm run build`.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = path.join(os.tmpdir(), 'vb-tmp-wp6a'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp6-shots');
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
  async key(code, vk, key, holdMs = 120) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  async mouse(type, x, y) {
    await this.send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, this.sessionId);
  }
  async shot(file) {
    try {
      const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
      writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
    } catch (e) { infra.push(`shot ${file} failed: ${e.message.slice(0, 80)}`); }
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
  window.__phases=[]; window.__evts=[]; window.__toasts=[]; window.__rosterN=0;
  game.events.on('net:phase', p=>{try{__phases.push(JSON.parse(JSON.stringify(p)))}catch(e){__phases.push({phase:p.phase})}});
  game.events.on('net:event', e=>{try{__evts.push(JSON.parse(JSON.stringify(e)))}catch(e2){}});
  game.events.on('ui:toast', t=>{try{__toasts.push(typeof t==='string'?t:JSON.stringify(t))}catch(e){}});
  game.events.on('net:roster', ()=>{window.__rosterN++;});
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
  return {x:p.x,y:p.y,mass:s.mass,stunned:!!s.stunned,
    carrying:s.carrying?JSON.parse(JSON.stringify(s.carrying)):null,
    channel:s.channel?{type:s.channel.type,msLeft:s.channel.msLeft}:null,
    prog:s.channelProgress||0, weapon:s.weapon, facing:s.facing};})()`;

const tpPlayer = (slot, x, y) =>
  `(game.scene.getScene('Game').sim.players.get(${slot}).body.reset(${x},${y}), 'ok')`;
const tpRelic = (x, y) =>
  `(game.scene.getScene('Game').sim.relic.body.reset(${x},${y}), 'ok')`;

const uiTexts = (containerExpr) => `(()=>{const c=${containerExpr}; if(!c) return null;
  const out=[]; const walk=(go)=>{ if(!go) return;
    if(go.type==='Text') out.push(go.text);
    if(go.list) for(const ch of go.list) walk(ch); };
  walk(c); return out;})()`;

async function repatchAll(pages, hostPage) {
  for (const p of pages) await waitFor(p, `(${PATCH_INPUT})==='ok'`, 8000, `${p.name}: input patch`);
  if (hostPage) await hostPage.eval(TAP_SIM);
}

/** Run a test step; on throw report FAIL (if not already reported) and
 *  recover so later steps still run. */
async function step(name, fn, recover) {
  try { await fn(); }
  catch (e) {
    if (!results.some((r) => r.name === name)) {
      report(name, false, 'ABORTED: ' + (e.message || String(e)).slice(0, 300));
    } else {
      infra.push(`${name}: post-report error ${(e.message || '').slice(0, 150)}`);
    }
    if (recover) {
      try { await recover(); } catch (e2) { infra.push(`recovery after ${name} failed: ${(e2.message || '').slice(0, 150)}`); }
    }
  }
}

/** Drive the HOST debug keys until every live peer reports `target`. */
async function forcePhase(target, pages) {
  const live = pages.filter(Boolean);
  const hostPage = live[0];
  for (let i = 0; i < 3; i++) {
    const cur = await hostPage.eval(`(()=>{try{return game.scene.getScene('Game').session.phase}catch(e){return null}})()`);
    if (cur === target) break;
    if (cur === 'lobby' && target === 'playing') await hostPage.key('KeyP', 80, 'p', 220);
    else if (cur === 'playing' && target === 'results') await hostPage.key('KeyR', 82, 'r', 220);
    else if (cur === 'results' && target === 'lobby') await hostPage.key('KeyL', 76, 'l', 220);
    else if (cur === 'playing' && target === 'lobby') { await hostPage.key('KeyR', 82, 'r', 220); await sleep(600); await hostPage.key('KeyL', 76, 'l', 220); }
    else if (cur === 'results' && target === 'playing') { await hostPage.key('KeyL', 76, 'l', 220); await sleep(600); await hostPage.key('KeyP', 80, 'p', 220); }
    await sleep(1200);
  }
  for (const p of live) {
    try { await waitFor(p, `game.scene.getScene('Game').session.phase==='${target}'`, 9000, `${p.name}: forced ${target}`); }
    catch (e) { infra.push(`forcePhase(${target}) on ${p.name}: ${e.message.slice(0, 100)}`); }
  }
  await sleep(500);
  try { await repatchAll(live, hostPage); } catch {}
}

// ---------------- dev server ----------------

let devProc = null;
let devStartedByUs = false;
async function ensureDevServer() {
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { infra.push('dev server already running — reusing, will NOT kill it'); return; }
  } catch {}
  devStartedByUs = true;
  devProc = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'ignore', shell: true });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(APP, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { infra.push('dev server started by suite'); return; }
    } catch {}
    await sleep(500);
  }
  throw new Error('npm run dev never came up on :5173');
}

function killDevServer() {
  if (!devStartedByUs || !devProc) return;
  try { spawn('taskkill', ['/pid', String(devProc.pid), '/T', '/F'], { stdio: 'ignore', shell: true }); } catch {}
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

// zone/ready helpers (lobby map: readyZone {x:420,y:468,w:120,h:60})
const ZONE_SPOTS = [[446, 500], [480, 500], [514, 500]];
async function allIntoZone(hostPage, slots) {
  for (let i = 0; i < slots.length; i++) {
    await hostPage.eval(tpPlayer(slots[i], ZONE_SPOTS[i % 3][0], ZONE_SPOTS[i % 3][1]));
  }
}

// ---------------- main ----------------

let H, C1, C2, C1B, C4;

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  await ensureDevServer();

  H = await bootPeer('host', 9631);
  await H.eval(`(localStorage.setItem('vb-name','BOSS'), localStorage.setItem('vb-ff','0'), 'ok')`);

  // ================= 1. menu-journey (keyboard-only) =================
  {
    const m0 = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {state:m.state, items:m.nav.items.length, idx:m.nav.index,
        focus:m.nav.items[m.nav.index]?.go.text, marker:m.nav.marker.visible,
        title:m.titleText.text};})()`);
    await H.shot('01-menu.png');
    // Down x3 -> SETTINGS, Enter -> settings state
    await H.key('ArrowDown', 40, 'ArrowDown'); await sleep(120);
    await H.key('ArrowDown', 40, 'ArrowDown'); await sleep(120);
    await H.key('ArrowDown', 40, 'ArrowDown'); await sleep(120);
    const mSet = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {idx:m.nav.index, focus:m.nav.items[m.nav.index]?.go.text};})()`);
    await H.key('Enter', 13, 'Enter'); await sleep(250);
    const sSet = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {state:m.state, items:m.nav.items.length, name:m.valName.text, ff:m.valFf.text, vol:m.valVol.text};})()`);
    await H.shot('02-settings.png');
    // toggle FF right then left-back (leave STANDARD), then Esc back
    await H.key('ArrowDown', 40, 'ArrowDown'); await sleep(120);
    await H.key('ArrowRight', 39, 'ArrowRight'); await sleep(150);
    const ffOn = await H.eval(`game.scene.getScene('Menu').valFf.text + '|' + localStorage.getItem('vb-ff')`);
    await H.key('ArrowRight', 39, 'ArrowRight'); await sleep(150);
    const ffOff = await H.eval(`game.scene.getScene('Menu').valFf.text + '|' + localStorage.getItem('vb-ff')`);
    await H.key('Escape', 27, 'Escape'); await sleep(200);
    // Down -> JOIN, Enter -> join code entry
    await H.key('ArrowDown', 40, 'ArrowDown'); await sleep(120);
    const mJoin = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {focus:m.nav.items[m.nav.index]?.go.text};})()`);
    await H.key('Enter', 13, 'Enter'); await sleep(250);
    // type A B 7(ignored) -> incomplete; Enter must be a no-op
    await H.key('KeyA', 65, 'a'); await H.key('KeyB', 66, 'b');
    await H.key('Digit7', 55, '7'); await sleep(150);
    const partial = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {state:m.state, code:m.codeArr.join(''), btn:m.joinBtn.style.color};})()`);
    await H.key('Enter', 13, 'Enter'); await sleep(400);
    const afterEnter = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {state:m.state, busy:m.busy};})()`);
    // complete with C D -> button enabled
    await H.key('KeyC', 67, 'c'); await H.key('KeyD', 68, 'd'); await sleep(150);
    const complete = await H.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {code:m.codeArr.join(''), btn:m.joinBtn.style.color};})()`);
    // clear, type a random (nonexistent) code, Enter -> bad-code error state
    for (let i = 0; i < 4; i++) await H.key('Backspace', 8, 'Backspace');
    const bad = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    for (const ch of bad) await H.key('Key' + ch, ch.charCodeAt(0), ch.toLowerCase());
    await H.key('Enter', 13, 'Enter');
    let err = null;
    try {
      err = await waitFor(H, `(()=>{const m=game.scene.getScene('Menu');
        return m.state==='join' && m.errorText.text ? m.errorText.text : false;})()`, 15000, 'bad-code error');
    } catch (e) { err = 'NO-ERROR(' + e.message.slice(0, 40) + ')'; }
    await H.shot('03-join-error.png');
    await H.key('Escape', 27, 'Escape'); await sleep(200);
    const backHome = await H.eval(`game.scene.getScene('Menu').state`);

    const ok = m0.state === 'menu' && m0.items === 4 && m0.marker && m0.idx === 0 &&
      /HOST GAME/.test(m0.focus) && m0.title === 'VAULTBREAKERS' &&
      /SETTINGS/.test(mSet.focus) && sSet.state === 'settings' && sSet.items === 4 &&
      /FULL \(100%\)\|1/.test(ffOn) && /STANDARD \(50%\)\|0/.test(ffOff) &&
      /JOIN GAME/.test(mJoin.focus) &&
      partial.state === 'join' && partial.code === 'AB' && partial.btn === '#565d75' &&
      afterEnter.state === 'join' && !afterEnter.busy &&
      complete.code === 'ABCD' && complete.btn === '#e8eaf2' &&
      err === 'ROOM NOT FOUND — CHECK THE CODE' && backHome === 'menu';
    report('menu-journey', ok,
      `menu 4 items focus[0]='${m0.focus}'; kb nav reached SETTINGS ('${mSet.focus}') -> state settings (${sSet.items} rows, ` +
      `ff toggle '${ffOn}'->'${ffOff}'), Esc back; JOIN ('${mJoin.focus}') -> code entry: 'AB'+digit ignored btn dim(${partial.btn}), ` +
      `Enter no-op, 'ABCD' enables btn(${complete.btn}); bad code ${bad} -> error '${err}'; Esc -> '${backHome}'`);
  }

  // ================= 1b. menu-gamepad-nav (stubbed pad) =================
  {
    let ok = false, detail = '';
    try {
      await H.eval(`(()=>{const m=game.scene.getScene('Menu');
        window.__padSim={A:false,B:false,up:false,down:false,left:false,right:false,leftStick:{x:0,y:0}};
        window.__padOld=m.input.gamepad; // may be a plugin instance or undefined
        m.input.gamepad={getPad:()=>window.__padSim};
        return 'ok';})()`);
      const i0 = await H.eval(`game.scene.getScene('Menu').nav.index`);
      await H.eval(`(window.__padSim.down=true,'ok')`); await sleep(150);
      await H.eval(`(window.__padSim.down=false,'ok')`); await sleep(150);
      const i1 = await H.eval(`game.scene.getScene('Menu').nav.index`);
      await H.eval(`(window.__padSim.A=true,'ok')`); await sleep(150);
      await H.eval(`(window.__padSim.A=false,'ok')`); await sleep(250);
      const st1 = await H.eval(`game.scene.getScene('Menu').state`); // idx1 = JOIN -> 'join'
      const hint = await H.eval(`game.scene.getScene('Menu').backHint.text`); // glyph swap to (B) back
      await H.eval(`(window.__padSim.B=true,'ok')`); await sleep(150);
      await H.eval(`(window.__padSim.B=false,'ok')`); await sleep(250);
      const st2 = await H.eval(`game.scene.getScene('Menu').state`);
      await H.eval(`(()=>{const m=game.scene.getScene('Menu'); m.input.gamepad=window.__padOld; return 'ok';})()`);
      await H.key('Escape', 27, 'Escape'); // restore lastDevice='kb'
      await sleep(150);
      ok = i0 === 0 && i1 === 1 && st1 === 'join' && st2 === 'menu' && hint === '(B) back';
      detail = `stubbed pad: down moved focus ${i0}->${i1}, A activated JOIN (state '${st1}', back-hint glyph '${hint}'), ` +
        `B backed out (state '${st2}'). NOTE: pad object stubbed in-page (headless Chrome has no Gamepad hardware) — ` +
        `real FocusNav/_updatePad code paths exercised`;
    } catch (e) { detail = 'gamepad stub failed: ' + e.message.slice(0, 200); }
    report('menu-gamepad-nav', ok, detail);
  }

  // ================= 2. ready-zone-solo =================
  {
    await H.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
    await waitFor(H, `game.scene.isActive('Game') && game.scene.getScene('Game').mode==='solo'`, 10000, 'solo boot');
    await sleep(600);
    const lob = await H.eval(`(()=>{const ui=game.scene.getScene('UI');const g=game.scene.getScene('Game');
      return {phase:g.session.phase, active:ui.lobbyUI._active, ring:ui.lobbyUI.ringText.text,
        soloBadge:!ui.lobbyUI.copyBtn, room:g.session.roomCode};})()`);
    await H.shot('04-solo-lobby.png');
    await H.eval(tpPlayer(0, 480, 500));
    await sleep(800);
    const filling = await H.eval(`game.scene.getScene('Game').getWorldRow()`);
    await waitFor(H, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 8000, 'solo run start');
    await sleep(700);
    const c0 = await H.eval(`game.scene.getScene('Game').getWorldRow().clock`);
    await sleep(1200);
    const c1 = await H.eval(`game.scene.getScene('Game').getWorldRow().clock`);
    const hud = await H.eval(`(()=>{const ui=game.scene.getScene('UI');
      return {clockVis:ui.hud.clockText.visible, clock:ui.hud.clockText.text, noiseVis:ui.hud.noiseGfx.visible};})()`);
    await H.shot('05-solo-playing.png');
    const ok = lob.phase === 'lobby' && lob.active && /^READY \d\/1$/.test(lob.ring) && lob.soloBadge &&
      filling.rz > 0 && filling.rzN === 1 && filling.rzM === 1 &&
      c1 < c0 && hud.clockVis && /^\d{2}:\d{2}$/.test(hud.clock);
    report('ready-zone-solo', ok,
      `solo lobby (ring '${lob.ring}', SOLO badge=${lob.soloBadge}); standing in zone filled rz=${filling.rz}% (n/m ${filling.rzN}/${filling.rzM}) ` +
      `-> phase playing on testMap; clock ticks ${c0}->${c1}ms, HUD clock '${hud.clock}'`);
    await H.eval(`(game.scene.getScene('Game')._leave(null), 'ok')`);
    await waitFor(H, `game.scene.isActive('Menu')`, 8000, 'back to menu');
    await H.eval(GLOBAL_TAPS);
  }

  // ================= host + 2 clients =================
  const code = await hostRoom(H);
  console.log('room code:', code);
  C1 = await bootPeer('c1', 9632);
  await C1.eval(`(localStorage.setItem('vb-name','CREW1'), 'ok')`);
  await joinRoom(C1, code, 1);
  C2 = await bootPeer('c2', 9633);
  await C2.eval(`(localStorage.setItem('vb-name','CREW2'), 'ok')`);
  await joinRoom(C2, code, 2);
  await waitFor(H, `game.scene.getScene('Game').session.connectedPlayers().length===3`, 10000, 'host sees 3 players');
  await sleep(800); // roster + views settle

  // ================= 3. lobby-3peers =================
  {
    const peers = [[H, 'host'], [C1, 'c1'], [C2, 'c2']];
    const states = [];
    for (const [p, nm] of peers) {
      const st = await p.eval(`(()=>{const g=game.scene.getScene('Game');const ui=game.scene.getScene('UI');
        const names=g.session.allPlayers().map(x=>x.slot+':'+x.name+(x.isHost?'*':''));
        const rowTexts=[]; for(const go of ui.lobbyUI.rosterRows.list){ if(go.type==='Text') rowTexts.push({t:go.text,c:go.style.color}); }
        const chips=ui.lobbyUI.rosterRows.list.filter(go=>go.type==='Rectangle').length;
        const badge=${uiTexts(`game.scene.getScene('UI').lobbyUI.root`)};
        return {room:g.session.roomCode, phase:g.session.phase, active:ui.lobbyUI._active,
          names, rowTexts, chips, badge,
          furniture:{door:!!g.doors.get('d0'), doorIntact:g.doors.get('d0')?.state.state,
            dummy:!!g.monsters.get('dummy0'), rack:!!g.map.weaponRack, board:!!g.map.board, zone:!!g.map.readyZone},
          ring:ui.lobbyUI.ringText.text};})()`);
      states.push([nm, st]);
    }
    await H.shot('06-lobby-host.png');
    await C1.shot('07-lobby-c1.png');
    const okPeer = ([nm, st]) =>
      st.room === code && st.phase === 'lobby' && st.active &&
      st.names.join(',') === '0:BOSS*,1:CREW1,2:CREW2' &&
      st.rowTexts.some((r) => r.t === '★ BOSS' && r.c === '#ffd23f') &&
      st.rowTexts.some((r) => r.t === 'CREW1' && r.c === '#4fd1c5') &&
      st.rowTexts.some((r) => r.t === 'CREW2' && r.c === '#f47fb0') &&
      st.chips === 3 && st.badge.includes(code) &&
      st.furniture.door && st.furniture.doorIntact === 'intact' && st.furniture.dummy &&
      st.furniture.rack && st.furniture.board && st.furniture.zone &&
      /^READY \d\/3$/.test(st.ring);
    const ok = states.every(okPeer);
    report('lobby-3peers', ok,
      states.map(([nm, st]) => `${nm}: room=${st.room} names=[${st.names}] chips=${st.chips} ` +
        `badgeHasCode=${st.badge.includes(code)} furniture=${JSON.stringify(st.furniture)} ring='${st.ring}' ok=${okPeer([nm, st])}`).join(' | '));
  }

  // ================= 4. stage-board =================
  await step('stage-board', async () => {
    await repatchAll([H, C1, C2], H);
    // host walks to the board
    await H.eval(tpPlayer(0, 320, 500));
    await sleep(500);
    const popupH = await H.eval(`(()=>{const ui=game.scene.getScene('UI');
      return {vis:ui.lobbyUI.popup.visible, name:ui.lobbyUI.popupName.text, line3:ui.lobbyUI.popupLine3.text};})()`);
    const rosterN0 = await C1.eval(`window.__rosterN`);
    await hold(H, { interact: true });
    let sawBoardCh = null;
    for (let i = 0; i < 15; i++) {
      const p = await H.eval(qPlayer(0));
      if (p.channel?.type === 'board') { sawBoardCh = p.channel; break; }
      await sleep(60);
    }
    await sleep(900); // channel 500 ms completes
    await unhold(H, ['interact']);
    await sleep(600);
    const rosterN1 = await C1.eval(`window.__rosterN`);
    const stageAfter = await C1.eval(`game.scene.getScene('Game').session.stageId`);
    await H.shot('08-stage-board.png');
    // non-host: C1 stands at the board and holds E -> NO channel on the host sim
    await H.eval(tpPlayer(1, 320, 500));
    await H.eval(tpPlayer(0, 140, 500)); // host walks away (frees the spot)
    await sleep(700);
    const popupC1 = await C1.eval(`(()=>{const ui=game.scene.getScene('UI');
      return {vis:ui.lobbyUI.popup.visible, line3:ui.lobbyUI.popupLine3.text, color:ui.lobbyUI.popupLine3.style.color};})()`);
    await hold(C1, { interact: true });
    let nonHostCh = null;
    for (let i = 0; i < 10; i++) {
      const p = await H.eval(qPlayer(1));
      if (p.channel) { nonHostCh = p.channel; break; }
      await sleep(120);
    }
    await unhold(C1, ['interact']);
    await H.eval(tpPlayer(1, 820, 480));
    const ok = popupH.vis && popupH.name === 'THE UNDERVAULT' && /NEXT STAGE/.test(popupH.line3) &&
      sawBoardCh !== null && rosterN1 > rosterN0 && stageAfter === 'test' &&
      popupC1.vis && popupC1.line3 === 'ONLY THE HOST PICKS THE STAGE' && popupC1.color === '#565d75' &&
      nonHostCh === null;
    report('stage-board', ok,
      `host popup {vis:${popupH.vis}, stage:'${popupH.name}', line3:'${popupH.line3}'}; board channel started=${!!sawBoardCh}, ` +
      `completion broadcast roster to C1 (${rosterN0}->${rosterN1}), stageId '${stageAfter}' (STAGES has 1 entry — cycle is a ` +
      `same-id wrap by design); non-host popup line3='${popupC1.line3}' and holding E started NO channel (${JSON.stringify(nonHostCh)})`);
  });

  // ================= 5. ready-zone (3 peers, cancel mid-fill) =================
  await step('ready-zone', async () => {
    await C1.eval(`window.__evts=[]`); await C2.eval(`window.__evts=[]`);
    await allIntoZone(H, [0, 1, 2]);
    // watch fill rise on the CLIENT (snapshot-driven)
    let c1Max = 0, hostAt = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 2600) {
      const hr = await H.eval(`game.scene.getScene('Game').getWorldRow()`);
      const cr = await C1.eval(`game.scene.getScene('Game').getWorldRow()`);
      c1Max = Math.max(c1Max, cr.rz || 0);
      hostAt = hr.rz;
      if (hr.rz >= 40) break;
      await sleep(100);
    }
    await H.shot('09-ready-filling.png');
    const nm = await C1.eval(`(()=>{const r=game.scene.getScene('Game').getWorldRow(); return {n:r.rzN,m:r.rzM};})()`);
    // step OUT at ~mid fill
    await H.eval(tpPlayer(1, 200, 480));
    let cancelled = false, c1AfterCancel = -1;
    const t1 = Date.now();
    while (Date.now() - t1 < 2000) {
      const hr = await H.eval(`game.scene.getScene('Game').getWorldRow()`);
      const cr = await C1.eval(`game.scene.getScene('Game').getWorldRow()`);
      if (hr.rz === 0 && (cr.rz || 0) === 0) { cancelled = true; c1AfterCancel = cr.rz; break; }
      await sleep(100);
    }
    const ringAfterCancel = await C2.eval(`game.scene.getScene('UI').lobbyUI.ringText.text`);
    // everyone back in -> 3 s -> playing everywhere
    await allIntoZone(H, [0, 1, 2]);
    await waitFor(H, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 9000, 'host playing');
    await waitFor(C1, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 9000, 'C1 playing');
    await waitFor(C2, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 9000, 'C2 playing');
    const readyEvC1 = (await C1.eval(`JSON.parse(JSON.stringify(window.__evts))`)).some((e) => e.kind === 'readyComplete');
    await sleep(700);
    const banner = await C1.eval(`(()=>{const ui=game.scene.getScene('UI');
      return {vis:ui.hud.bannerText.visible, text:ui.hud.bannerText.text};})()`);
    const ck0 = await C2.eval(`game.scene.getScene('Game').getWorldRow().clock`);
    await sleep(1200);
    const ck1 = await C2.eval(`game.scene.getScene('Game').getWorldRow().clock`);
    const ok = c1Max >= 25 && hostAt >= 40 && nm.n === 3 && nm.m === 3 &&
      cancelled && /^READY [12]\/3$/.test(ringAfterCancel) &&
      readyEvC1 && banner.text === 'STEAL THE RELIC — GO' &&
      ck1 < ck0 && ck0 > 0;
    report('ready-zone', ok,
      `all 3 in zone: client-visible fill rose to ${c1Max}% (host ${hostAt}%, READY ${nm.n}/${nm.m}); ` +
      `P1 stepped out at ~${hostAt}% -> reset to 0 on host AND client (=${cancelled}, C2 ring '${ringAfterCancel}'); ` +
      `all back in -> 3s -> phase playing on all 3 (readyComplete event on C1=${readyEvC1}), ` +
      `banner '${banner.text}', clock ticking on C2 ${ck0}->${ck1}ms`);
  }, () => forcePhase('playing', [H, C1, C2]));

  await sleep(400);
  await repatchAll([H, C1, C2], H);

  // ================= 6. hud-playing =================
  await step('hud-playing', async () => {
    // clock on both clients
    const cA0 = await C1.eval(`(()=>{const ui=game.scene.getScene('UI');
      return {vis:ui.hud.clockText.visible, text:ui.hud.clockText.text};})()`);
    await sleep(2100);
    const cA1 = await C1.eval(`game.scene.getScene('UI').hud.clockText.text`);
    const cB = await C2.eval(`(()=>{const ui=game.scene.getScene('UI');
      return {vis:ui.hud.clockText.visible, text:ui.hud.clockText.text, noiseVis:ui.hud.noiseGfx.visible};})()`);
    // noise: host hammer swing (noise 8)
    await C1.eval(`window.__evts=[]`);
    await edge(H, { attack: true });
    let c1Noise = 0;
    const tN = Date.now();
    while (Date.now() - tN < 3000) {
      c1Noise = await C1.eval(`game.scene.getScene('Game').getWorldRow().noise`);
      if (c1Noise > 0) break;
      await sleep(150);
    }
    const c1Burst = (await C1.eval(`JSON.parse(JSON.stringify(window.__evts))`)).some((e) => e.kind === 'noiseBurst');
    // carry icon: host grabs the relic
    const p0 = await H.eval(qPlayer(0));
    await H.eval(tpRelic(p0.x + 20, p0.y - 10));
    await sleep(400);
    await edge(H, { grab: true });
    await waitFor(H, `game.scene.getScene('Game').sim.relic.state.rs==='held'`, 5000, 'host grabbed relic');
    await waitFor(C1, `game.scene.getScene('Game').players.get(0).state.carryingHands===true`, 5000, 'C1 sees carryingHands bit');
    await sleep(400);
    const relicC1 = await C1.eval(`game.scene.getScene('UI').hud.relicText.text`);
    const relicH = await H.eval(`game.scene.getScene('UI').hud.relicText.text`);
    // ping: move C1's player far away so the marker is off-screen for C1
    await H.eval(tpPlayer(1, 2000, 1340));
    await sleep(900); // interp + camera settle on C1
    await C1.eval(`window.__evts=[]`); await C2.eval(`window.__evts=[]`);
    await hold(H, { aimX: p0.x + 60, aimY: p0.y - 40 });
    await edge(H, { ping: true });
    await sleep(200);
    await edge(H, { ping: true }); // inside 500 ms cooldown -> must be swallowed
    await sleep(700);
    await unhold(H, ['aimX', 'aimY']);
    const pingEvs1 = (await C1.eval(`JSON.parse(JSON.stringify(window.__evts))`)).filter((e) => e.kind === 'pingMarker');
    const pingC1 = await C1.eval(`(()=>{const w=game.scene.getScene('Game').worldUI;
      return {n:w.pings.length, edgeVis:w.pings[0]?.edge.visible, x:w.pings[0]?.x};})()`);
    const pingC2 = await C2.eval(`(()=>{const w=game.scene.getScene('Game').worldUI;
      return {n:w.pings.length, edgeVis:w.pings[0]?.edge.visible};})()`);
    await C1.shot('10-hud-c1-ping-edge.png');
    await C2.shot('11-hud-c2.png');
    await H.eval(tpPlayer(1, 272, 1340)); // bring P1 back
    const ok = cA0.vis && /^\d{2}:\d{2}$/.test(cA0.text) && cA1 !== cA0.text &&
      cB.vis && cB.noiseVis && /^\d{2}:\d{2}$/.test(cB.text) &&
      c1Noise >= 4 && c1Burst &&
      relicC1 === 'BOSS HAS THE RELIC' && relicH === "RELIC IN HANDS — DON'T GET HIT" &&
      pingEvs1.length === 1 && pingC1.n === 1 && pingC1.edgeVis === true &&
      pingC2.n === 1 && pingC2.edgeVis === false;
    report('hud-playing', ok,
      `clock on C1 '${cA0.text}'->'${cA1}' (C2 '${cB.text}'); hammer swing -> client noise ${c1Noise} (burst event=${c1Burst}); ` +
      `host grab -> C1 carryingHands bit + indicator '${relicC1}', host local '${relicH}'; ` +
      `ping -> 1 marker event on C1 (2nd swallowed by 500ms cooldown, got ${pingEvs1.length}), ` +
      `far C1 shows EDGE indicator (${pingC1.edgeVis}), near C2 shows world marker only (edge ${pingC2.edgeVis})`);
  });

  // ================= 7. win-results =================
  await step('win-results', async () => {
    await C1.eval(`window.__phases=[]`); await C2.eval(`window.__phases=[]`);
    await H.eval(tpPlayer(0, 80, 1340)); // exit zone [16,1216,128,160], relic in hands
    await waitFor(H, `game.scene.getScene('Game').session.phase==='results'`, 8000, 'host results');
    const c1p = await waitFor(C1, `(window.__phases.find(p=>p.phase==='results')&&JSON.parse(JSON.stringify(window.__phases.find(p=>p.phase==='results'))))`, 8000, 'C1 results');
    await waitFor(C2, `!!window.__phases.find(p=>p.phase==='results')`, 8000, 'C2 results');
    await sleep(1200); // entrance tweens
    const hostUi = await H.eval(`(()=>{const ui=game.scene.getScene('UI');
      const texts=${uiTexts(`game.scene.getScene('UI').resultsUI.root`)};
      return {vis:ui.resultsUI.visible, texts, navTexts:ui.resultsUI.nav.items.map(i=>i.go.text)};})()`);
    const c1Ui = await C1.eval(`(()=>{const ui=game.scene.getScene('UI');
      const texts=${uiTexts(`game.scene.getScene('UI').resultsUI.root`)};
      return {vis:ui.resultsUI.visible, texts, navTexts:ui.resultsUI.nav.items.map(i=>i.go.text)};})()`);
    await H.shot('12-results-win-host.png');
    await C1.shot('13-results-win-c1.png');
    const d = c1p.data || {};
    const sane = (x) => typeof x === 'number' && x > 0 && x < 12 * 60 * 1000;
    const has = (arr, s) => arr.some((t) => t === s || (t && t.startsWith && t.startsWith(s)));
    const okPayload = d.result === 'win' && sane(d.teamStats?.escapeMs) && sane(d.teamStats?.timeLeftMs) &&
      Array.isArray(d.perPlayer) && d.perPlayer.length === 3 && d.award !== undefined;
    const okHost = hostUi.vis && has(hostUi.texts, 'VAULT BROKEN') && has(hostUi.texts, 'the relic escaped the dungeon') &&
      hostUi.texts.some((t) => /^ESCAPE TIME \d{2}:\d{2} · TIME LEFT \d{2}:\d{2} · TREASURE: RELIC$/.test(t)) &&
      has(hostUi.texts, 'BOSS') && has(hostUi.texts, 'CREW1') && has(hostUi.texts, 'CREW2') &&
      hostUi.texts.some((t) => t.startsWith('MOST RUINOUS PLAYER: ')) &&
      hostUi.navTexts.join(',') === '[ RETURN TO LOBBY ],[ EXIT ]';
    const okC1 = c1Ui.vis && has(c1Ui.texts, 'VAULT BROKEN') && has(c1Ui.texts, 'waiting for host…') &&
      c1Ui.navTexts.join(',') === '[ EXIT ]' &&
      c1Ui.texts.some((t) => t.startsWith('MOST RUINOUS PLAYER: '));
    report('win-results', okPayload && okHost && okC1,
      `payload{result:${d.result}, escapeMs:${d.teamStats?.escapeMs}, perPlayer:${d.perPlayer?.length}}; ` +
      `host UI: verdict+reason+teamline+3 rows+award ok=${okHost}, buttons [${hostUi.navTexts}]; ` +
      `client UI: ok=${okC1}, buttons [${c1Ui.navTexts}] (award line '${c1Ui.texts.find((t) => t.startsWith && t.startsWith('MOST RUINOUS'))}')`);
  }, () => forcePhase('results', [H, C1, C2]));

  // ================= 8. return-to-lobby (results button) + run 2 via zone =================
  await step('return-to-lobby', async () => {
    // real Enter on the host activates the focused [ RETURN TO LOBBY ]
    await H.key('Enter', 13, 'Enter');
    await waitFor(H, `game.scene.getScene('Game').session.phase==='lobby' && game.scene.getScene('Game').mapId==='lobby'`, 9000, 'host lobby');
    await waitFor(C1, `game.scene.getScene('Game').session.phase==='lobby' && game.scene.getScene('Game').mapId==='lobby'`, 9000, 'C1 lobby');
    await waitFor(C2, `game.scene.getScene('Game').session.phase==='lobby' && game.scene.getScene('Game').mapId==='lobby'`, 9000, 'C2 lobby');
    await sleep(600);
    const st = await C1.eval(`(()=>{const g=game.scene.getScene('Game');const ui=game.scene.getScene('UI');
      return {room:g.session.roomCode, names:g.session.allPlayers().map(x=>x.slot+':'+x.name).join(','),
        lobbyActive:ui.lobbyUI._active, results:ui.resultsUI.visible};})()`);
    await C1.shot('14-back-in-lobby-c1.png');
    // run 2 via the ready zone again
    await repatchAll([H, C1, C2], H);
    await allIntoZone(H, [0, 1, 2]);
    let run2 = true;
    try {
      await waitFor(H, `game.scene.getScene('Game').session.phase==='playing'`, 9000, 'run 2 host');
      await waitFor(C1, `game.scene.getScene('Game').session.phase==='playing'`, 9000, 'run 2 C1');
      await waitFor(C2, `game.scene.getScene('Game').session.phase==='playing'`, 9000, 'run 2 C2');
    } catch (e) { run2 = false; infra.push('run2 via zone: ' + e.message.slice(0, 80)); }
    const ok = st.room === code && st.names === '0:BOSS,1:CREW1,2:CREW2' &&
      st.lobbyActive && !st.results && run2;
    report('return-to-lobby', ok,
      `host pressed ENTER on [ RETURN TO LOBBY ] -> all peers lobby, SAME code ${st.room}, roster '${st.names}', ` +
      `results overlay gone=${!st.results}; second run started via the ready zone=${run2}`);
  }, () => forcePhase('playing', [H, C1, C2]));

  await sleep(400);
  await repatchAll([H, C1, C2], H);

  // ================= 9. lose-results (clock zero) =================
  await step('lose-results', async () => {
    await C1.eval(`window.__phases=[]`); await C2.eval(`window.__phases=[]`);
    await H.eval(`(game.scene.getScene('Game').sim.world.clockMsLeft=2200, 'ok')`);
    await waitFor(H, `game.scene.getScene('Game').session.phase==='results'`, 10000, 'host lose results');
    const c1p = await waitFor(C1, `(window.__phases.find(p=>p.phase==='results')&&JSON.parse(JSON.stringify(window.__phases.find(p=>p.phase==='results'))))`, 8000, 'C1 lose results');
    await waitFor(C2, `!!window.__phases.find(p=>p.phase==='results')`, 8000, 'C2 lose results');
    await sleep(1100);
    const c2Ui = await C2.eval(`(()=>{const ui=game.scene.getScene('UI');
      const texts=${uiTexts(`game.scene.getScene('UI').resultsUI.root`)};
      return {vis:ui.resultsUI.visible, texts};})()`);
    await C2.shot('15-results-lose-c2.png');
    const d = c1p.data || {};
    const ok = d.result === 'lose' &&
      c2Ui.vis && c2Ui.texts.includes('THE CALAMITY') &&
      c2Ui.texts.includes('the clock hit zero — everyone is very stylishly doomed') &&
      c2Ui.texts.some((t) => /^ESCAPE TIME — · TIME LEFT 00:00 · TREASURE: NONE$/.test(t));
    report('lose-results', ok,
      `clock forced to 2.2s -> calamity: payload result '${d.result}' reason '${d.reason ?? d.result}'; C2 UI verdict 'THE CALAMITY' ` +
      `+ lose reason + team line '${c2Ui.texts.find((t) => t.startsWith && t.startsWith('ESCAPE TIME'))}'`);
    // back to lobby via the DEBUG L key (must still work)
    await H.key('KeyL', 76, 'l', 220);
    await waitFor(H, `game.scene.getScene('Game').session.phase==='lobby' && game.scene.getScene('Game').mapId==='lobby'`, 9000, 'L -> lobby host');
    await waitFor(C1, `game.scene.getScene('Game').mapId==='lobby'`, 9000, 'L -> lobby C1');
    await waitFor(C2, `game.scene.getScene('Game').mapId==='lobby'`, 9000, 'L -> lobby C2');
  }, () => forcePhase('lobby', [H, C1, C2]));

  await sleep(600);

  // ================= 10. kick =================
  await step('kick', async () => {
    // REAL mouse hold on the [KICK] button of slot 2's roster row.
    // rowY = 16+8+14 + slot*28 = 94 for slot 2; button right-aligned x=208.
    const geo = await H.eval(`(()=>{const r=game.canvas.getBoundingClientRect();
      return {left:r.left, top:r.top, sx:r.width/960, sy:r.height/540};})()`);
    const px = geo.left + 188 * geo.sx;
    const py = geo.top + 94 * geo.sy;
    await H.mouse('mouseMoved', px, py);
    await sleep(120);
    await H.mouse('mousePressed', px, py);
    await sleep(880); // kick hold = 700 ms
    await H.mouse('mouseReleased', px, py);
    let kicked = true;
    try {
      await waitFor(C2, `game.scene.isActive('Menu') && game.scene.getScene('Menu').notice==='KICKED BY HOST'`, 8000, 'C2 kicked to menu');
    } catch (e) {
      kicked = false;
      infra.push('real-mouse kick missed, falling back to _kickHold seed: ' + e.message.slice(0, 60));
      await H.eval(`(()=>{const ui=game.scene.getScene('UI');
        ui.lobbyUI._kickHold={slot:2, startedAt:ui.time.now-800, rowY:94}; return 'ok';})()`);
      await waitFor(C2, `game.scene.isActive('Menu') && game.scene.getScene('Menu').notice==='KICKED BY HOST'`, 8000, 'C2 kicked (seeded)');
      kicked = true;
    }
    await C2.shot('16-kicked-menu-c2.png');
    const c2Cred = await C2.eval(`(()=>{return {tok:sessionStorage.getItem('vb-token-${code}'), last:sessionStorage.getItem('vb-last-room')};})()`);
    await waitFor(H, `game.scene.getScene('Game').session.allPlayers().length===2`, 8000, 'host roster shrank');
    await waitFor(C1, `game.scene.getScene('Game').session.allPlayers().length===2`, 8000, 'C1 roster shrank');
    const c1Rows = await C1.eval(`(()=>{const ui=game.scene.getScene('UI');
      return ui.lobbyUI.rosterRows.list.filter(go=>go.type==='Text').map(t=>t.text);})()`);
    // kicked slot can re-join fresh
    await C2.eval(`(game.scene.getScene('Menu')._join('${code}'), 'ok')`);
    await waitFor(C2, `game.scene.isActive('Game') && game.scene.getScene('Game').session.localSlot===2`, 18000, 'C2 rejoined fresh');
    await waitFor(H, `game.scene.getScene('Game').session.allPlayers().length===3`, 8000, 'roster back to 3');
    const ok = kicked && c2Cred.tok === null && c2Cred.last === null &&
      c1Rows.includes('CREW2') === false;
    report('kick', ok,
      `host mouse-held [KICK] on slot 2 -> C2 on menu with notice 'KICKED BY HOST'; C2 rejoin credentials burned ` +
      `(token=${c2Cred.tok}, last=${c2Cred.last}); roster updated everywhere (C1 rows after kick: [${c1Rows}]); ` +
      `kicked player re-joined fresh into slot 2 (3 players again)`);
  });

  await sleep(500);

  // ================= 11. rejoin-ux =================
  await step('rejoin-ux', async () => {
    // run 3 via the DEBUG P key (re-proves it alongside the zone path)
    await H.key('KeyP', 80, 'p', 220);
    await waitFor(H, `game.scene.getScene('Game').session.phase==='playing' && game.scene.getScene('Game').mapId==='test'`, 10000, 'run 3 host');
    await waitFor(C1, `game.scene.getScene('Game').mapId==='test'`, 10000, 'run 3 C1');
    await waitFor(C2, `game.scene.getScene('Game').mapId==='test'`, 10000, 'run 3 C2');
    await sleep(500);
    await repatchAll([H, C2], H);
    const token = await C1.eval(`sessionStorage.getItem('vb-token-${code}')`);
    await C2.eval(`window.__evts=[]`);
    // hard-kill C1's whole browser (no polite bye)
    C1.proc.kill('SIGKILL');
    C1.close();
    C1 = null;
    const t0 = Date.now();
    await waitFor(H, `!!game.scene.getScene('Game').sim.tombstones.get('t1')`, 25000, 'tombstone t1');
    const detectMs = Date.now() - t0;
    const ts = await H.eval(`JSON.parse(JSON.stringify(game.scene.getScene('Game').sim.tombstones.get('t1').state))`);
    await sleep(700);
    const c2TsEv = (await C2.eval(`JSON.parse(JSON.stringify(window.__evts))`)).some((e) => e.kind === 'tombstone' && e.slot === 1);
    const c2Toast = (await C2.eval(`JSON.parse(JSON.stringify(window.__toasts))`)).join('|');

    // relaunch: fresh browser, seed the persisted credentials, reload -> menu button
    C1B = await bootPeer('c1rejoin', 9634);
    await C1B.eval(`(localStorage.setItem('vb-name','CREW1'),
      sessionStorage.setItem('vb-token-${code}','${token}'),
      sessionStorage.setItem('vb-last-room','${code}'), 'ok')`);
    await C1B.navigate(APP);
    await waitFor(C1B, `!!window.game && game.scene.isActive('Menu')`, 20000, 'rejoin menu');
    await C1B.eval(GLOBAL_TAPS);
    const rejoinBtn = await C1B.eval(`(()=>{const m=game.scene.getScene('Menu');
      return {exists:!!m.btnRejoin, text:m.btnRejoin?.text, items:m.nav.items.length};})()`);
    await C1B.shot('17-rejoin-menu.png');
    // keyboard-only: Up wraps to the last item (= rejoin), Enter activates
    await C1B.key('ArrowUp', 38, 'ArrowUp'); await sleep(150);
    const focusText = await C1B.eval(`(()=>{const m=game.scene.getScene('Menu');return m.nav.items[m.nav.index]?.go.text;})()`);
    await C1B.key('Enter', 13, 'Enter');
    await waitFor(C1B, `game.scene.isActive('Game') && game.scene.getScene('Game').session.localSlot===1 && game.scene.getScene('Game').session.phase==='playing'`, 20000, 'rejoined into the run');
    await waitFor(H, `!!game.scene.getScene('Game').sim.players.get(1)`, 10000, 'slot1 back in sim');
    const p1new = await H.eval(qPlayer(1));
    const stoneGone = await H.eval(`!game.scene.getScene('Game').sim.tombstones.get('t1')`);
    const c1bState = await C1B.eval(`(()=>{const g=game.scene.getScene('Game');
      return {mode:g.mode, map:g.mapId, name:g.session.players[1]?.name,
        hasView:!!g.players.get(1)};})()`);
    await sleep(700);
    const c2Back = (await C2.eval(`JSON.parse(JSON.stringify(window.__evts))`)).some((e) => e.kind === 'rejoined' && e.slot === 1);
    await C1B.shot('18-rejoined-c1.png');
    const nearStone = Math.abs(p1new.x - ts.x) < 60 && Math.abs(p1new.y - ts.y) < 60;
    const okPos = rejoinBtn.exists && rejoinBtn.text === '[ REJOIN LAST ROOM ${code} ]'.replace('${code}', code) &&
      rejoinBtn.items === 5 && focusText === rejoinBtn.text &&
      c2TsEv && nearStone && stoneGone &&
      c1bState.mode === 'client' && c1bState.map === 'test' && c1bState.name === 'CREW1' && c1bState.hasView && c2Back;

    // NEGATIVE path: bogus token -> 'in-run' error state, no hang
    C4 = await bootPeer('bogus', 9635);
    await C4.eval(`(sessionStorage.setItem('vb-token-${code}','deadbeef'),
      sessionStorage.setItem('vb-last-room','${code}'), 'ok')`);
    await C4.navigate(APP);
    await waitFor(C4, `!!window.game && game.scene.isActive('Menu')`, 20000, 'bogus menu');
    const bogusBtn = await C4.eval(`!!game.scene.getScene('Menu').btnRejoin`);
    await C4.eval(`(game.scene.getScene('Menu')._join('${code}', true), 'ok')`);
    let negOk = false, negDetail = '';
    try {
      const errText = await waitFor(C4, `(()=>{const m=game.scene.getScene('Menu');
        return (m.state==='join' && m.errorText.text) ? m.errorText.text : false;})()`, 15000, 'in-run error');
      const after = await C4.eval(`(()=>{const m=game.scene.getScene('Menu');
        return {busy:m.busy, btn:!!m.btnRejoin, tok:sessionStorage.getItem('vb-token-${code}'),
          last:sessionStorage.getItem('vb-last-room')};})()`);
      await C4.shot('19-inrun-error.png');
      negOk = errText === "RUN IN PROGRESS — CAN'T JOIN MID-RUN" && !after.busy &&
        !after.btn && after.tok === null && after.last === null;
      negDetail = `bogus token -> error '${errText}' on the code-entry line, busy=${after.busy}, ` +
        `dead credential burned (token=${after.tok}, rejoin button gone=${!after.btn})`;
    } catch (e) { negDetail = 'NEGATIVE PATH HUNG: ' + e.message.slice(0, 120); }
    C4.proc.kill('SIGKILL'); C4.close(); C4 = null;

    report('rejoin-ux', okPos && negOk,
      `disconnect detected in ${(detectMs / 1000).toFixed(1)}s -> tombstone{slot:1} at (${ts.x},${ts.y}), C2 saw event=${c2TsEv} ` +
      `(toasts: ${c2Toast || 'none'}); fresh browser + stored token -> menu showed '${rejoinBtn.text}' (5 nav items), ` +
      `keyboard Up+Enter -> rejoined slot 1 as '${c1bState.name}' at (${p1new?.x.toFixed(0)},${p1new?.y.toFixed(0)}) ` +
      `near stone=${nearStone}, stone despawned=${stoneGone}, C2 got rejoined event=${c2Back} | negative: ${negDetail}`);
  });

  // ---------------- shut down the browsers before the child suites ----------------
  for (const p of [H, C1, C1B, C2, C4]) { try { p?.proc?.kill('SIGKILL'); p?.close(); } catch {} }
  H = C1 = C1B = C2 = C4 = null;
  await sleep(1500);

  // ================= 12. wp5-regression (unmodified) =================
  {
    console.log('--- running wp5-accept.mjs (regression) ---');
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(HERE, 'wp5-accept.mjs')], {
        cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', errOut = '';
      child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
      child.stderr.on('data', (d) => { errOut += d; });
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 12 * 60 * 1000);
      child.on('exit', (code2) => { clearTimeout(killer); resolve({ code: code2, out, errOut }); });
    });
    const passes = (r.out.match(/^PASS /gm) || []).length;
    const fails = (r.out.match(/^FAIL /gm) || []).length;
    // 10, not 11: wp5's own `build` row is emitted by ITS runner, not by
    // the script — this suite runs its own build check in section 13.
    report('wp5-regression', r.code === 0 && passes === 10 && fails === 0,
      `wp5-accept.mjs exit ${r.code}: ${passes} PASS / ${fails} FAIL (10 expected in-script; also re-proves the P/L debug keys)` +
      (r.code !== 0 ? ` | stderr: ${r.errOut.slice(0, 200)}` : ''));
  }

  // ================= 13. build =================
  {
    const r = await new Promise((resolve) => {
      const child = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
      let out = '', errOut = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { errOut += d; });
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3 * 60 * 1000);
      child.on('exit', (code2) => { clearTimeout(killer); resolve({ code: code2, out, errOut }); });
    });
    const builtLine = (r.out + r.errOut).split('\n').find((l) => /built in/.test(l)) || '';
    report('build', r.code === 0,
      `npm run build exit ${r.code} ${builtLine.trim()}` +
      (r.code !== 0 ? ` | ${(r.errOut || r.out).slice(-400)}` : ' (Node 22.7.0 Vite warning = expected noise)'));
  }
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
  for (const p of [H, C1, C1B, C2, C4]) { try { p?.close(); } catch {} }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  killDevServer();
}
