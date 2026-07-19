// wp7-art-shots.mjs — ART DIRECTOR capture pass. Read-only: drives the
// solo sim into each visual state and screenshots it. No production edits.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-art'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp7-art-shots');
const APP = process.env.APP || 'http://localhost:5175/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }
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
    const v = await page.eval(g);
    if (v) return v;
    await sleep(120);
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
    '--headless=new', '--remote-debugging-port=9733', `--user-data-dir=${path.join(TMP, 'a')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' }));

  const A = new Cdp(9733);
  await A.connect();
  await A.navigate(APP);
  await waitFor(A, `!!window.game && game.scene.isActive('Menu')`, 25000, 'menu');
  await A.shot('00-menu.png');

  await A.eval(`(game.scene.getScene('Menu')._solo(), 'ok')`);
  await waitFor(A, `game.scene.isActive('Game') && !!${SIM}`, 20000, 'lobby');
  await sleep(1200);
  await A.shot('01-lobby.png');

  // lobby: dummy monster + ready zone close-up (walk right a bit)
  await A.key('KeyD', 68, 'd', 700);
  await sleep(400);
  await A.shot('02-lobby-walk.png');

  await A.key('KeyP', 80, 'p');
  await waitFor(A, `${SC}.session.phase==='playing'`, 12000, 'playing');
  await waitFor(A, `!!${SIM}.relic`, 8000, 'relic');
  await sleep(900);
  await A.shot('03-run-start.png');

  // inventory of the map for later positioning
  const inv = await A.eval(`(()=>{const sc=${SC};
    return {doors:[...sc.doors.keys()].map(k=>({id:k,type:sc.doors.get(k).state.type,x:Math.round(sc.doors.get(k).x),y:Math.round(sc.doors.get(k).y)})),
      pickups:[...sc.pickups.keys()],
      map:{w:sc.map.width,h:sc.map.height},
      relic:{x:Math.round(sc.relic.x),y:Math.round(sc.relic.y)},
      exit: sc.map.exit||null};})()`);
  console.log('INV', JSON.stringify(inv));

  const tp = (x, y) => A.eval(`(()=>{const p=${SIM}.players.get(0);
    p.body.reset(${x},${y}); p.state.stunned=false; p.state.stunMsLeft=0; return 'ok';})()`);

  // ---- doors: intact / crack1 / crack2 / broken ----
  for (const d of inv.doors) {
    await tp(d.x + 70, d.y - 40);
    await sleep(500);
    await A.shot(`10-door-${d.id}-${d.type}-intact.png`);
  }
  const d0 = inv.doors.find((d) => d.type === 'door') || inv.doors[0];
  await tp(d0.x + 70, d0.y - 40); await sleep(400);
  for (const frac of [0.5, 0.2]) {
    await A.eval(`(()=>{const sc=${SC};const d=sc.doors.get('${d0.id}');
      const max=d.state.smashHp>0?d.state.smashHp:1;
      return import('/src/entities/DoorEntity.js').then(m=>{
        m.setDoorDamaged(d, Math.max(1, Math.round(${frac}*(window.__dmax??(window.__dmax=max)))));
        window.__ok=true;});})()`);
    await sleep(600);
    await A.shot(`11-door-dmg-${frac}.png`);
  }
  await A.eval(`(()=>import('/src/entities/DoorEntity.js').then(m=>{
    const d=${SC}.doors.get('${d0.id}'); m.setDoorBroken(d);
    ${SC}.fx?.onDoorState({id:'${d0.id}',state:'broken',smashHp:0});}))()`);
  await sleep(180);
  await A.shot('12-door-broken-debris.png');
  await sleep(700);
  await A.shot('13-door-broken-settled.png');

  // ---- monsters ----
  const here = await A.eval(`(()=>{const p=${SIM}.players.get(0);return {x:Math.round(p.x),y:Math.round(p.y)};})()`);
  await A.eval(`(()=>{const sim=${SIM};
    sim.monsterSys._spawnAt(sim,'skulker',${here.x + 90},${here.y - 10},{});
    sim.monsterSys._spawnAt(sim,'brute',${here.x + 190},${here.y - 20},{});
    return 'ok';})()`);
  await sleep(250);
  await A.shot('20-monster-spawn-telegraph.png');
  await sleep(1400);
  await A.shot('21-monsters-both.png');
  // force windup telegraph
  await A.eval(`(()=>{for(const [,m] of ${SIM}.monsters){m.state.ai='windup';m.state.aiTimerMs=900;
    ${SC}.fx?.onMonsterTelegraph({id:m.state.id});} return 'ok';})()`);
  await sleep(200);
  await A.shot('22-monster-windup.png');

  // ---- combat impact + noise ripple ----
  await A.eval(`(()=>{const sc=${SC};const p=sc.players.get(0);
    sc.fx?.onSwing({slot:0,weapon:'hammer'});
    sc.fx?.onHit({slot:0,weapon:'hammer',x:p.x+30,y:p.y});
    sc.fx?.onNoiseBurst({x:p.x+30,y:p.y,amount:8});return 'ok';})()`);
  await sleep(90);
  await A.shot('30-hammer-impact.png');
  await A.eval(`(()=>{const p=${SC}.players.get(0);
    ${SC}.fx?.onNoiseBurst({x:p.x,y:p.y,amount:35});return 'ok';})()`);
  await sleep(160);
  await A.shot('31-noise-ripple-big.png');
  await sleep(220);
  await A.shot('32-noise-ripple-big-late.png');
  await A.eval(`(()=>{const p=${SC}.players.get(0);
    ${SC}.fx?.onNoiseBurst({x:p.x+40,y:p.y,amount:2});return 'ok';})()`);
  await sleep(120);
  await A.shot('33-noise-ripple-small.png');

  // ---- grapple beam mid-zip ----
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);
    p.state.grapple={targetKind:'terrain',targetId:null,anchorX:p.x+220,anchorY:p.y-160,
      tipX:p.x+220,tipY:p.y-160,assist:false};
    p.body.setAllowGravity(false); p.body.setVelocity(700,-500); return 'ok';})()`);
  await sleep(120);
  await A.shot('40-grapple-zip.png');
  await sleep(120);
  await A.shot('41-grapple-zip-2.png');
  await A.eval(`(()=>{const p=${SIM}.players.get(0);p.state.grapple=null;
    p.body.setAllowGravity(true);return 'ok';})()`);

  // ---- relic states ----
  await sleep(700);
  const rx = await A.eval(`(()=>{const p=${SIM}.players.get(0);return {x:Math.round(p.x),y:Math.round(p.y)};})()`);
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);p.state.carrying=null;
    sim.relicSys._dropLoose(sim,p.x+50,p.y-20,0,0);return 'ok';})()`);
  await sleep(800);
  await A.shot('50-relic-loose.png');
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);p.state.carrying=null;
    sim.relicSys._attach(sim,p);return 'ok';})()`);
  await sleep(500);
  await A.shot('51-relic-in-hands.png');
  await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeBag(sim,sim.players.get(0));return 'ok';})()`);
  await sleep(500);
  await A.shot('52-relic-bagged.png');
  await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeUnbag(sim,sim.players.get(0));
    const p=sim.players.get(0);sim.relicSys._dropLoose(sim,p.x+20,p.y-60,420,-260);
    const rel=sim.relic; rel.state.rs='flying'; return 'ok';})()`);
  await sleep(200);
  await A.shot('53-relic-flying.png');

  // ---- stun pose + stars ----
  await A.eval(`(()=>import('/src/systems/StunSystem.js').then(m=>{
    const sim=${SIM};m.applyStun(sim,sim.players.get(0),6000,'ff');}))()`);
  await sleep(700);
  await A.shot('60-stun-pose.png');
  await A.eval(`(()=>{const p=${SIM}.players.get(0);p.state.stunned=false;p.state.stunMsLeft=0;return 'ok';})()`);
  await sleep(400);

  // ---- HUD under load: 3 monsters + particles + relic held ----
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);
    sim.monsterSys._spawnAt(sim,'skulker',p.x+70,p.y-10,{});
    sim.monsterSys._spawnAt(sim,'skulker',p.x-70,p.y-10,{});
    sim.relicSys._dropLoose(sim,p.x+30,p.y-10,0,0);
    sim.world.noise=Math.min(100,85);
    return 'ok';})()`);
  await sleep(600);
  await A.eval(`(()=>{const sc=${SC};const p=sc.players.get(0);
    sc.fx?.onNoiseBurst({x:p.x,y:p.y,amount:30});
    sc.fx?.onHit({slot:0,weapon:'hammer',x:p.x+20,y:p.y});
    sc.fx?.onMonsterSpawn({x:p.x+120,y:p.y,id:'zz'});return 'ok';})()`);
  await sleep(140);
  await A.shot('70-chaos-hud.png');

  // ---- escalation 1 ----
  await A.eval(`(()=>{const sim=${SIM};sim.world.clockMsLeft=5*60*1000;return 'ok';})()`);
  await waitFor(A, `${SIM}.world.escalationLevel>=1`, 8000, 'esc1');
  await sleep(2400);
  await A.shot('80-escalation1-dim.png');
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);
    sim.relicSys._attach(sim,p);return 'ok';})()`);
  await sleep(500);
  await A.shot('81-escalation1-relic-carried.png');

  // ---- escalation 2 ----
  await A.eval(`(()=>{const sim=${SIM};sim.world.clockMsLeft=2*60*1000;return 'ok';})()`);
  await waitFor(A, `${SIM}.world.escalationLevel>=2`, 8000, 'esc2');
  await sleep(1400);
  await A.shot('82-escalation2-collapse.png');
  await A.eval(`(()=>{const sim=${SIM};const p=sim.players.get(0);
    sim.monsterSys._spawnAt(sim,'brute',p.x+120,p.y-20,{});
    sim.monsterSys._spawnAt(sim,'skulker',p.x-90,p.y-10,{});
    ${SC}.fx?.onNoiseBurst({x:p.x,y:p.y,amount:30});return 'ok';})()`);
  await sleep(500);
  await A.shot('83-escalation2-chaos.png');

  // ---- urgency vignette ≤30s ----
  await A.eval(`(()=>{${SIM}.world.clockMsLeft=25000;return 'ok';})()`);
  await sleep(900);
  await A.shot('84-urgency-vignette.png');

  // ---- lose ----
  await A.eval(`(()=>{${SIM}.world.clockMsLeft=200;return 'ok';})()`);
  await sleep(500);
  await A.shot('90-lose-moment.png');
  await sleep(1400);
  await A.shot('91-lose-results.png');
  await sleep(1500);
  await A.shot('92-lose-results-settled.png');

  // ---- back to lobby, then win ----
  await A.eval(`(()=>{const u=game.scene.getScene('UI');return 'ui:'+!!u;})()`);
  console.log('errors', JSON.stringify(A.errors.slice(0, 5)));
  A.close();
} catch (e) {
  console.error('ABORT:', e.message);
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { } }
}
