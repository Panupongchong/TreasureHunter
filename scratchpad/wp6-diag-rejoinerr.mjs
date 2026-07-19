// Diagnostic: bogus-token rejoin into a live run must show the
// "RUN IN PROGRESS" error. Reproduces the wp6-accept rejoin-ux negative
// path in isolation and captures the page exception.
//
// A: host a room, debug-P into 'playing'.
// B1: seed bogus token + last-room (menu SHOWS the rejoin button) -> _join
// B2: seed bogus token WITHOUT last-room (no rejoin button)       -> _join
// If B2 shows the error while B1 hangs, the destroyed-btnRejoin-in-nav
// theory is confirmed.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-wp6diag'); // OUTSIDE the vite-watched tree
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(port, name) { this.port = port; this.name = name; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    let info = null;
    for (let i = 0; i < 60; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
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
      this.errors.push((d?.exception?.description || d?.text || 'unknown').slice(0, 500));
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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '?').slice(0, 400));
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async key(code, vk, key, holdMs = 150) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function waitFor(page, expr, timeoutMs, label) {
  const guarded = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.eval(guarded);
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

const procs = [];
function boot(name, port) {
  mkdirSync(path.join(TMP, name), { recursive: true });
  procs.push(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(TMP, name)}`,
    '--no-first-run', '--disable-gpu', '--mute-audio', '--window-size=1024,720',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' }));
}

async function probe(page, code, tag) {
  await page.eval(`(game.scene.getScene('Menu')._join('${code}', true), 'ok')`);
  let outcome = 'HUNG';
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const st = await page.eval(`(()=>{try{const m=game.scene.getScene('Menu');
      return {state:m.state, err:m.errorText.text, overlay:m.overlay.visible, busy:m.busy};}catch(e){return null}})()`);
    if (st && st.state === 'join' && st.err) { outcome = `ERROR SHOWN: '${st.err}'`; break; }
    await sleep(300);
  }
  const fin = await page.eval(`(()=>{const m=game.scene.getScene('Menu');
    return {state:m.state, err:m.errorText.text, overlay:m.overlay.visible, busy:m.busy, btn:!!m.btnRejoin};})()`);
  console.log(`${tag}: ${outcome} | final=${JSON.stringify(fin)} | pageErrors=${JSON.stringify(page.errors.slice(-3))}`);
  return outcome;
}

try {
  rmSync(TMP, { recursive: true, force: true });
  boot('a', 9651); boot('b', 9652);
  const A = new Cdp(9651, 'A'); await A.connect();
  const B = new Cdp(9652, 'B'); await B.connect();
  await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'A menu');
  await A.eval(`(game.scene.getScene('Menu')._host(), 'ok')`);
  const code = await waitFor(A, `game.scene.isActive('Game') && game.scene.getScene('Game').session.roomCode`, 20000, 'A hosts');
  console.log('room:', code);
  await A.key('KeyP', 80, 'p', 220);
  await waitFor(A, `game.scene.getScene('Game').session.phase==='playing'`, 10000, 'A playing');

  // B1: bogus token WITH last-room (rejoin button present)
  await B.navigate(APP);
  await waitFor(B, `!!window.game && game.scene.isActive('Menu')`, 25000, 'B menu');
  await B.eval(`(sessionStorage.setItem('vb-token-${code}','deadbeef'), sessionStorage.setItem('vb-last-room','${code}'), 'ok')`);
  await B.navigate(APP);
  await waitFor(B, `!!window.game && game.scene.isActive('Menu')`, 25000, 'B menu 2');
  const hasBtn = await B.eval(`!!game.scene.getScene('Menu').btnRejoin`);
  console.log('B1 rejoin button present:', hasBtn);
  await probe(B, code, 'B1 (button present)');

  // B2: bogus token WITHOUT last-room (no rejoin button in the nav)
  await B.eval(`(sessionStorage.setItem('vb-token-${code}','deadbeef'), sessionStorage.removeItem('vb-last-room'), 'ok')`);
  await B.navigate(APP);
  await waitFor(B, `!!window.game && game.scene.isActive('Menu')`, 25000, 'B menu 3');
  B.errors.length = 0;
  const hasBtn2 = await B.eval(`!!game.scene.getScene('Menu').btnRejoin`);
  console.log('B2 rejoin button present:', hasBtn2);
  await probe(B, code, 'B2 (no button)');

  A.close(); B.close();
} catch (e) {
  console.error('DIAG ABORT:', e.message);
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
