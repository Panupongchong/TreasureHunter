// wp7-art-chaos.mjs — THE readability bar: 4 players + monsters +
// particles + escalation tint, at 1x and zoomed. Read-only.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-art6'); // OUTSIDE the vite-watched tree
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
  procs.push(spawn(CHROME, ['--headless=new', '--remote-debugging-port=9788', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--disable-gpu', '--mute-audio', '--window-size=1024,720', 'about:blank'], { stdio: 'ignore' }));
  const A = new Cdp(9788); await A.connect(); await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.eval(`(game.scene.getScene('Menu')._solo(),'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!${SIM}`, 20000, 'lobby');
  await A.key('KeyP', 80, 'p');
  await waitFor(A, `${SC}.session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!${SIM}.relic`, 8000, 'relic');
  await sleep(900);
  await A.eval(`(()=>{const sc=${SC};for(const s of[1,2,3])if(!sc.players.has(s))sc._addPlayer(s);return 1;})()`);
  await sleep(400);

  const setup = async () => A.eval(`(()=>{const sim=${SIM};const sc=${SC};const b=sc.players.get(0);
    const put=(s,dx,dy)=>{const q=sc.players.get(s);if(q&&q.body)q.body.reset(b.x+dx,b.y+dy);};
    put(1,-150,0);put(2,80,0);put(3,190,-40);
    const p2=sc.players.get(2);p2.state.carrying=null;sim.relicSys._attach(sim,p2);
    return 1;})()`);
  const monsters = async () => A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);
    sim.monsterSys._spawnAt(sim,'skulker',p.x+40,p.y-10,{});
    sim.monsterSys._spawnAt(sim,'skulker',p.x-60,p.y-10,{});
    sim.monsterSys._spawnAt(sim,'brute',p.x+260,p.y-20,{});return 1;})()`);
  const burst = async () => A.eval(`(()=>{const sc=${SC};const p=sc.players.get(0);
    sc.fx?.onNoiseBurst({x:p.x,y:p.y,amount:32});
    sc.fx?.onHit({slot:0,weapon:'hammer',x:p.x+24,y:p.y});
    sc.fx?.onHit({slot:-1,x:p.x-40,y:p.y});
    sc.fx?.onSwing({slot:0,weapon:'hammer'});return 1;})()`);

  await setup(); await monsters(); await sleep(1300); await setup();
  await burst(); await sleep(110);
  await A.shot('X0-chaos-esc0.png');

  await A.eval(`(()=>{${SIM}.world.clockMsLeft=5*60*1000;return 1;})()`);
  await waitFor(A, `${SIM}.world.escalationLevel>=1`, 8000, 'esc1');
  await sleep(2600); await setup(); await monsters(); await sleep(900); await setup();
  await burst(); await sleep(110);
  await A.shot('X1-chaos-esc1.png');
  await sleep(600); await A.shot('X2-chaos-esc1-quiet.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(2);return 1;})()`);
  await sleep(400); await A.shot('X3-chaos-esc1-zoom.png');
  await A.eval(`(()=>{${SC}.cameras.main.setZoom(1);return 1;})()`);

  await A.eval(`(()=>{${SIM}.world.clockMsLeft=2*60*1000;return 1;})()`);
  await waitFor(A, `${SIM}.world.escalationLevel>=2`, 8000, 'esc2');
  await sleep(1400); await setup(); await monsters(); await sleep(900); await setup();
  await burst(); await sleep(110);
  await A.shot('X4-chaos-esc2.png');
  await A.eval(`(()=>{${SIM}.world.clockMsLeft=20000;return 1;})()`);
  await sleep(900); await setup();
  await burst(); await sleep(110);
  await A.shot('X5-chaos-urgency.png');
  console.log('errors', JSON.stringify(A.errors.slice(0, 3)));
  A.close();
} catch (e) { console.error('ABORT:', e.message); }
finally { for (const p of procs) { try { p.kill('SIGKILL'); } catch { } } }
