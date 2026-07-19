// wp7-art-probe.mjs — identify what is actually drawn in the bagged case,
// and check remote name labels. Read-only.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-art3'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp7-art-shots');
const APP = process.env.APP || 'http://localhost:5175/';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
class Cdp {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    let info = null;
    for (let i = 0; i < 60; i++) { try { info = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); break; } catch { await sleep(250); } }
    this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => this._onMsg(JSON.parse(m.data));
    const { targetInfos } = await this.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable', {}, sessionId); await this.send('Page.enable', {}, sessionId);
  }
  _onMsg(msg) {
    if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.exception?.description || '?');
  }
  send(method, params = {}, sessionId) { const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId; this.ws.send(JSON.stringify(p)); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true }, this.sessionId); if (r.exceptionDetails) throw new Error('exc ' + (r.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result?.value; }
  async navigate(u) { await this.send('Page.navigate', { url: u }, this.sessionId); }
  async shot(n) { const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId); writeFileSync(path.join(SHOTS, n), Buffer.from(data, 'base64')); console.log('shot', n); }
  async key(code, vk, ch, ms = 120) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, code, key: ch }, this.sessionId); await sleep(ms); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key: ch }, this.sessionId); }
  close() { try { this.ws?.close(); } catch { } }
}
async function waitFor(p, e, t, l) { const g = `(()=>{try{return (${e})}catch(x){return false}})()`; const t0 = Date.now(); while (Date.now() - t0 < t) { const v = await p.eval(g); if (v) return v; await sleep(120); } throw new Error('timeout ' + l); }
const SC = `game.scene.getScene('Game')`, SIM = `${SC}.sim`;
try {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); mkdirSync(SHOTS, { recursive: true });
  procs.push(spawn(CHROME, ['--headless=new', '--remote-debugging-port=9755', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--window-size=1024,720',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' }));
  const A = new Cdp(9755); await A.connect(); await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.eval(`(game.scene.getScene('Menu')._solo(),'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!${SIM}`, 20000, 'lobby');
  await A.key('KeyP', 80, 'p');
  await waitFor(A, `${SC}.session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!${SIM}.relic`, 8000, 'relic');
  await sleep(900);
  await A.eval(`(()=>{const sc=${SC};for(const s of [1,2,3]) if(!sc.players.has(s)) sc._addPlayer(s);return 1;})()`);
  await sleep(300);

  const census = `(()=>{const sc=${SC};const p=sc.players.get(2);const rel=sc.relic;
    const v=(o)=>!!(o&&o.visible&&(o.alpha??1)>0.05);
    return {rs:rel.state.rs, holder:rel.state.holderSlot,
      relEntity:v(rel), relGlow:v(rel.glow), relGlint:v(rel.glint),
      relXY:[Math.round(rel.x),Math.round(rel.y)], pXY:[Math.round(p.x),Math.round(p.y)],
      heldGem:v(p.heldGem), bag:v(p.bag), bagGem:v(p.bagGem),
      escGlow:v(sc.fx?.relicEscGlow),
      carrying: JSON.stringify(p.state.carrying), carryingBag:p.state.carryingBag};})()`;

  await A.eval(`(()=>{const sim=${SIM};const p=${SC}.players.get(2);p.state.carrying=null;sim.relicSys._attach(sim,p);return 1;})()`);
  await sleep(400); console.log('HANDS ', JSON.stringify(await A.eval(census)));
  await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeBag(sim,${SC}.players.get(2));return 1;})()`);
  await sleep(500); console.log('BAGGED', JSON.stringify(await A.eval(census)));
  await A.eval(`(()=>{const c=${SC}.cameras.main;c.stopFollow();c.setZoom(3);
    c.centerOn(${SC}.players.get(2).x,${SC}.players.get(2).y-10);return 1;})()`);
  await sleep(600); await A.shot('G0-bagged-closeup.png');
  const near = await A.eval(`(()=>{const sc=${SC};const p=sc.players.get(2);const out=[];
    const walk=(list,px,py,pathv)=>{for(const o of list){const wx=px+(o.x||0),wy=py+(o.y||0);
      if(o.visible&&(o.alpha??1)>0.05&&Math.abs(wx-p.x)<60&&Math.abs(wy-p.y)<70)
        out.push({pathv,type:o.type,tex:o.texture&&o.texture.key,x:Math.round(wx),y:Math.round(wy)});
      if(o.list)walk(o.list,wx,wy,pathv+'>'+((o.texture&&o.texture.key)||o.type));}};
    walk(sc.children.list,0,0,'');return out;})()`);
  console.log('NEAR-CARRIER', JSON.stringify(near));
  // WHO draws the floating gold mark above a BAGGED carrier's head?
  const who = await A.eval(`(()=>{const sc=${SC};const p=sc.players.get(2);
    const cand={heldGem:p.heldGem,bagGem:p.bagGem,bag:p.bag,stars:p.stars,
      relic:sc.relic,relicGlow:sc.relic.glow,relicGlint:sc.relic.glint};
    const o={};for(const k in cand){const c=cand[k];o[k]={vis:!!c.visible,alpha:c.alpha,
      wx:Math.round(c.parentContainer?p.x+c.x:c.x),wy:Math.round(c.parentContainer?p.y+c.y:c.y),
      tex:c.texture&&c.texture.key, sx:c.scaleX};}
    o.starsChildVis=p.stars.list.map(s=>s.visible);
    return o;})()`);
  console.log('WHO', JSON.stringify(who));
  await A.eval(`(()=>{const p=${SC}.players.get(2);p.stars.setVisible(false);
    p.__starsOff=true;return 1;})()`);
  await sleep(400); await A.shot('G2-bagged-stars-off.png');
  await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeUnbag(sim,${SC}.players.get(2));return 1;})()`);
  await sleep(2800);
  await A.eval(`(()=>{const c=${SC}.cameras.main;c.centerOn(${SC}.players.get(2).x,${SC}.players.get(2).y-10);return 1;})()`);
  await sleep(300); await A.shot('G1-hands-closeup.png');

  // world-space name labels for remotes?
  const labels = await A.eval(`(()=>{const sc=${SC};const out=[];
    sc.children.list.forEach(o=>{ if(o.type==='Text' && o.visible && o.text) out.push({t:o.text,x:Math.round(o.x),y:Math.round(o.y),c:o.style?.color});});
    return out.slice(0,40);})()`);
  console.log('WORLD TEXTS', JSON.stringify(labels));
  const wui = await A.eval(`(()=>{const sc=${SC};return sc.worldUI? Object.keys(sc.worldUI):'none';})()`);
  console.log('worldUI keys', JSON.stringify(wui));
  console.log('errors', JSON.stringify(A.errors.slice(0, 3)));
  A.close();
} catch (e) { console.error('ABORT:', e.message); }
finally { for (const p of procs) { try { p.kill('SIGKILL'); } catch { } } }
