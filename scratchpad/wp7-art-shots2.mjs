// wp7-art-shots2.mjs — supplemental ART pass: 4 players, carry reads,
// zoomed entity close-ups, working grapple beam, win screen.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-art2'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp7-art-shots');
const APP = process.env.APP || 'http://localhost:5175/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error('page exc: ' + (r.exceptionDetails.exception?.description || '?').slice(0, 300));
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log('shot', name);
  }
  async key(code, vk, ch, ms = 120) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, code, key: ch }, this.sessionId);
    await sleep(ms);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key: ch }, this.sessionId);
  }
  close() { try { this.ws?.close(); } catch { } }
}
async function waitFor(page, expr, timeoutMs, label) {
  const g = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.eval(g); if (v) return v; await sleep(120);
  }
  throw new Error('timeout: ' + label);
}
const SC = `game.scene.getScene('Game')`;
const SIM = `${SC}.sim`;

try {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  procs.push(spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9744', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' }));
  const A = new Cdp(9744);
  await A.connect();
  await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!${SIM}`, 20000, 'lobby');
  await A.key('KeyP', 80, 'p');
  await waitFor(A, `${SC}.session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!${SIM}.relic`, 8000, 'relic');
  await sleep(900);

  // freeze monsters out of the way; add 3 fake teammates
  await A.eval(`(()=>{const sc=${SC};
    for(const s of [1,2,3]) if(!sc.players.has(s)) sc._addPlayer(s);
    return [...sc.players.keys()];})()`);
  await sleep(300);

  const P = (s) => `${SC}.players.get(${s})`;
  const place = async (rows) => {
    await A.eval(`(()=>{const sc=${SC};${rows.map(([s, dx, dy]) =>
      `{const q=sc.players.get(${s});const b=sc.players.get(0);if(q&&q.body)q.body.reset(b.x+${dx},b.y+${dy});else if(q)q.setPosition(b.x+${dx},b.y+${dy});}`).join('')}return 'ok';})()`);
  };

  // ---- THE READ: 4 players spread out, slot 2 has the relic in hands ----
  await A.eval(`(()=>{const sim=${SIM};const sc=${SC};
    const p2=sc.players.get(2); p2.state.carrying=null;
    sim.relicSys._attach(sim,p2); return 'ok';})()`);
  await place([[1, -140, 0], [2, 90, 0], [3, 200, -60]]);
  await sleep(600);
  await A.shot('A0-four-players-slot2-hands.png');
  // zoomed
  await A.eval(`(()=>{const c=${SC}.cameras.main;c.setZoom(2.2);return 'ok';})()`);
  await sleep(400);
  await A.shot('A1-four-players-slot2-hands-zoom.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(1);return 'ok';})()`);

  // bagged variant
  await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeBag(sim,${SC}.players.get(2));return 'ok';})()`);
  await place([[1, -140, 0], [2, 90, 0], [3, 200, -60]]);
  await sleep(600);
  await A.shot('A2-four-players-slot2-bagged.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(2.2);return 'ok';})()`);
  await sleep(400);
  await A.shot('A3-four-players-slot2-bagged-zoom.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(1);return 'ok';})()`);

  // loose relic on the floor with 4 players, for contrast
  await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeUnbag(sim,${SC}.players.get(2));
    const p=${SC}.players.get(0);sim.relicSys._dropLoose(sim,p.x+40,p.y-10,0,0);return 'ok';})()`);
  await sleep(800);
  await A.shot('A4-four-players-relic-loose.png');

  // ---- close-ups (zoom 3) of entity families ----
  const zoomShot = async (name, setup, z = 3) => {
    if (setup) await A.eval(setup);
    await A.eval(`(()=>{${SC}.cameras.main.setZoom(${z});return 'ok';})()`);
    await sleep(500);
    await A.shot(name);
    await A.eval(`(()=>{${SC}.cameras.main.setZoom(1);return 'ok';})()`);
    await sleep(150);
  };
  await zoomShot('B0-zoom-player-and-relic.png', null);
  await zoomShot('B1-zoom-monsters.png', `(()=>{const sim=${SIM};const p=sim.players.get(0);
    sim.monsterSys._spawnAt(sim,'skulker',p.x+60,p.y-10,{});
    sim.monsterSys._spawnAt(sim,'brute',p.x+140,p.y-20,{});return 'ok';})()`);

  // door close-ups
  const inv = await A.eval(`(()=>{const sc=${SC};return [...sc.doors.entries()].map(([k,d])=>({id:k,type:d.state.type,x:Math.round(d.x),y:Math.round(d.y)}));})()`);
  for (const d of inv) {
    await A.eval(`(()=>{const p=${SIM}.players.get(0);p.body.reset(${d.x + 60},${d.y - 20});return 'ok';})()`);
    await sleep(400);
    await zoomShot(`C0-zoom-${d.type}-${d.id}.png`, null, 2.6);
  }

  // ---- grapple beam mid-zip, guaranteed ----
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);
    p.state.stunned=false;p.state.stunMsLeft=0;
    p.state.grapple={targetKind:'terrain',targetId:null,anchorX:p.x+260,anchorY:p.y-200,
      tipX:p.x+260,tipY:p.y-200,assist:false};
    p.body.setAllowGravity(false);p.body.setVelocity(760,-560);return 'ok';})()`);
  await sleep(100); await A.shot('D0-grapple-zip.png');
  await sleep(120); await A.shot('D1-grapple-zip-b.png');
  await A.eval(`(()=>{const p=${SIM}.players.get(0);p.state.grapple=null;p.body.setAllowGravity(true);return 'ok';})()`);
  await sleep(600);

  // ---- tombstone + hourglass ----
  await A.eval(`(()=>{const sc=${SC};const sim=${SIM};const p=sc.players.get(0);
    if(sc.spawnTombstone) sc.spawnTombstone(1,p.x+60,p.y);
    return Object.getOwnPropertyNames(Object.getPrototypeOf(sc)).filter(n=>/tomb/i.test(n));})()`)
    .then((r) => console.log('tomb api', JSON.stringify(r))).catch(() => { });
  const hg = await A.eval(`(()=>{const sc=${SC};const e=[...sc.pickups.entries()][0];
    if(!e)return null;const p=sc.players.get(0);p.body.reset(e[1].x-40,e[1].y-30);
    return {id:e[0],x:Math.round(e[1].x),y:Math.round(e[1].y)};})()`);
  console.log('hourglass', JSON.stringify(hg));
  await sleep(500);
  await zoomShot('E0-zoom-hourglass.png', null, 3);

  // ---- win screen ----
  await A.eval(`(()=>{const sim=${SIM};const sc=${SC};
    const p=sim.players.get(0); sim.relicSys._attach(sim,p);
    const ex=sc.map.exitZone||sc.map.exit||null;
    return ex? JSON.stringify(ex): Object.keys(sc.map);})()`).then((r) => console.log('map keys', r));
  await A.eval(`(()=>{const sim=${SIM};
    if(sim.clockSys&&sim.endRun) sim.endRun('win','escaped');
    return Object.getOwnPropertyNames(Object.getPrototypeOf(sim)).join(',');})()`)
    .then((r) => console.log('sim api', String(r).slice(0, 300)));
  await sleep(400);
  await A.shot('F0-after-win-attempt.png');

  console.log('errors', JSON.stringify(A.errors.slice(0, 5)));
  A.close();
} catch (e) {
  console.error('ABORT:', e.message);
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { } }
}
