// wp7-art-win.mjs — win moment + confetti, exit portal proximity pulse,
// hourglass pickup, stun pose close-up. Read-only.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-art5'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp7-art-shots');
const APP = 'http://localhost:5175/';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
class Cdp {
  constructor(p) { this.port = p; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    let i2 = null;
    for (let i = 0; i < 60; i++) { try { i2 = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; } catch { await sleep(250); } }
    this.ws = new WebSocket(i2.webSocketDebuggerUrl);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (m) => this._m(JSON.parse(m.data));
    const { targetInfos } = await this.send('Target.getTargets');
    const pg = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable', {}, sessionId); await this.send('Page.enable', {}, sessionId);
  }
  _m(m) {
    if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params?.exceptionDetails?.exception?.description || '?');
  }
  send(method, params = {}, sid) { const id = ++this.id; const p = { id, method, params }; if (sid) p.sessionId = sid; this.ws.send(JSON.stringify(p)); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true }, this.sessionId); if (r.exceptionDetails) throw new Error('exc ' + (r.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result?.value; }
  async navigate(u) { await this.send('Page.navigate', { url: u }, this.sessionId); }
  async shot(n) { const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId); writeFileSync(path.join(SHOTS, n), Buffer.from(data, 'base64')); console.log('shot', n); }
  async key(c, vk, ch, ms = 120) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, code: c, key: ch }, this.sessionId); await sleep(ms); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code: c, key: ch }, this.sessionId); }
  close() { try { this.ws?.close(); } catch { } }
}
async function waitFor(p, e, t, l) { const g = `(()=>{try{return (${e})}catch(x){return false}})()`; const t0 = Date.now(); while (Date.now() - t0 < t) { const v = await p.eval(g); if (v) return v; await sleep(120); } throw new Error('timeout ' + l); }
const SC = `game.scene.getScene('Game')`, SIM = `${SC}.sim`;
try {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); mkdirSync(SHOTS, { recursive: true });
  procs.push(spawn(CHROME, ['--headless=new', '--remote-debugging-port=9777', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--disable-gpu', '--mute-audio', '--window-size=1024,720', 'about:blank'], { stdio: 'ignore' }));
  const A = new Cdp(9777); await A.connect(); await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.eval(`(game.scene.getScene('Menu')._solo(),'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!${SIM}`, 20000, 'lobby');
  await A.key('KeyP', 80, 'p');
  await waitFor(A, `${SC}.session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!${SIM}.relic`, 8000, 'relic');
  await sleep(900);

  // hourglass pickup FX
  const hg = await A.eval(`(()=>{const sc=${SC};const e=[...sc.pickups.entries()].find(x=>x[0][0]==='h');
    if(!e)return null;const p=sc.players.get(0);p.body.reset(e[1].x-30,e[1].y-40);
    return {id:e[0],x:Math.round(e[1].x),y:Math.round(e[1].y)};})()`);
  await sleep(700);
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(3);return 1;})()`);
  await sleep(500); await A.shot('H0-hourglass-zoom.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(1);return 1;})()`);

  // stun pose close-up
  await A.eval(`(()=>import('/src/systems/StunSystem.js').then(m=>{
    const sim=${SIM};m.applyStun(sim,sim.players.get(0),8000,'ff');}))()`);
  await sleep(900);
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(3);return 1;})()`);
  await sleep(400); await A.shot('H1-stun-zoom.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(1);const p=${SIM}.players.get(0);
    p.state.stunned=false;p.state.stunMsLeft=0;return 1;})()`);
  await sleep(500);

  // exit portal proximity pulse + win
  await A.eval(`(()=>{const sim=${SIM};const sc=${SC};const p=sim.players.get(0);
    p.state.carrying=null; sim.relicSys._attach(sim,p);
    p.body.reset(300,1300); return 1;})()`);
  await sleep(700); await A.shot('H2-carrier-approaching-exit.png');
  await A.eval(`(()=>{const p=${SIM}.players.get(0);p.body.reset(80,1290);return 1;})()`);
  await sleep(250); await A.shot('H3-win-wipe.png');
  await sleep(900); await A.shot('H4-win-results.png');
  await sleep(1600); await A.shot('H5-win-results-confetti.png');
  console.log('errors', JSON.stringify(A.errors.slice(0, 3)));
  A.close();
} catch (e) { console.error('ABORT:', e.message); }
finally { for (const p of procs) { try { p.kill('SIGKILL'); } catch { } } }
