// qa-fish-diag.mjs — dump the grapple-fish post-contact gap series so the
// acceptance assertion can be based on measured convergence, not a guess.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-fishdiag'); // OUTSIDE the vite-watched tree
const APP = 'http://localhost:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

class Cdp {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); }
  async connect() {
    let info = null;
    for (let i = 0; i < 60; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => { const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } };
    const { targetInfos } = await this.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error('page exc: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200));
    return r.result?.value;
  }
  navigate(url) { return this.send('Page.navigate', { url }, this.sessionId); }
}

async function waitFor(page, expr, ms, label) {
  const g = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await page.eval(g); if (v) return v; await sleep(120); }
  throw new Error('timeout: ' + label);
}

try {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  procs.push(spawn(CHROME, ['--headless=new', '--remote-debugging-port=9755',
    `--user-data-dir=${path.join(TMP, 'a')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--mute-audio', '--window-size=1024,720',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' }));
  const A = new Cdp(9755); await A.connect(); await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!game.scene.getScene('Game').sim`, 20000, 'lobby');
  await A.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 80, code: 'KeyP', key: 'p' }, A.sessionId);
  await sleep(220);
  await A.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 80, code: 'KeyP', key: 'p' }, A.sessionId);
  await waitFor(A, `game.scene.getScene('Game').session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!game.scene.getScene('Game').sim.relic`, 8000, 'relic');
  await sleep(600);
  // same input shim wp5-accept uses
  console.log('patch input:', await A.eval(`(()=>{ const sc=game.scene.getScene('Game');
    if(!sc||!sc.inputManager) return 'no-scene'; const im=sc.inputManager;
    window.__hold={}; window.__edges=[];
    if(!im.__patched){ im.__patched=true; const orig=im.poll.bind(im);
      im.poll=()=>{ const f=orig(); Object.assign(f, window.__hold||{});
        if((window.__edges||[]).length) Object.assign(f, window.__edges.shift());
        return f; }; }
    return 'ok'; })()`));

  for (let trial = 1; trial <= 4; trial++) {
    // set up exactly like wp5-accept grapple-fish
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      for(const [,pl] of sim.players){ if(pl.state.carrying&&pl.state.carrying.kind==='relic') pl.state.carrying=null; }
      const p=sim.players.get(0); p.state.stunned=false; p.state.stunMsLeft=0; p.state.grapple=null;
      p.body.reset(500,1340);
      const r=sim.relic; r.state.rs='loose'; r.state.holderSlot=null; r.state.lockoutMs=0;
      r.body.enable=true; r.body.reset(800,1350); r.body.setDragX(600); r.body.setVelocity(0,0);
      return 'ok';})()`);
    await sleep(700);
    // sample for 3000ms (longer than the suite's 1600) to see convergence
    await A.eval(`(()=>{const sim=game.scene.getScene('Game').sim;
      window.__g=[]; const iv=setInterval(()=>{try{const r=sim.relic,p=sim.players.get(0);
        window.__g.push({t:Math.round(performance.now()),gap:Math.round(r.x-p.x),rx:Math.round(r.x),px:Math.round(p.x)});
      }catch(e){clearInterval(iv);}},40);
      setTimeout(()=>clearInterval(iv),3000); return 'ok';})()`);
    // fire the grapple via the input hold/edge queues the suite uses
    await A.eval(`(()=>{window.__hold=window.__hold||{};window.__edges=window.__edges||[];
      window.__hold.grappleHeld=true; window.__hold.aimX=800; window.__hold.aimY=1360;
      window.__edges.push({grapple:true}); return 'ok';})()`);
    await sleep(3300);
    await A.eval(`(delete window.__hold.grappleHeld, delete window.__hold.aimX, delete window.__hold.aimY, 'ok')`);
    const g = await A.eval(`window.__g||[]`);
    const ci = g.findIndex((s) => Math.abs(s.gap) < 50);
    const post = ci >= 0 ? g.slice(ci) : [];
    const half = Math.floor(post.length / 2);
    const amp = (arr) => (arr.length ? Math.max(...arr.map((s) => Math.abs(s.gap))) : NaN);
    console.log(`trial ${trial}: samples=${g.length} contactIdx=${ci} postN=${post.length} ` +
      `ampFirstHalf=${amp(post.slice(0, half))} ampSecondHalf=${amp(post.slice(half))} ` +
      `ampAll=${amp(post)} gapAtCut=${post.length ? Math.abs(post[post.length - 1].gap) : '?'}`);
    console.log('  gaps: ' + post.map((s) => s.gap).join(','));
    await A.eval(`(()=>{const p=game.scene.getScene('Game').sim.players.get(0); p.state.grapple=null; return 'ok';})()`);
    await sleep(400);
  }
} catch (e) { console.error('ABORT:', e.message); }
finally { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } }
