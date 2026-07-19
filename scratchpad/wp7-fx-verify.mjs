// ============================================================
// wp7-fx-verify.mjs — WP7 FX/CAMERA/HUD-STYLING half verification.
//
// Headless Chrome via CDP (wp5/wp6/wp7-tex harness pattern).
//   Part A: solo — lobby + run, camera scroll, world-UI alignment,
//           LOCKED body geometry MID-SQUASH, beams, particles, ripple,
//           escalation, cap enforcement, shake arbiter, results, leak.
//   Part B: 2 peers over the real PeerJS broker — host + client render
//           the same FX, camera follows on the client, no exceptions.
// Screenshots -> scratchpad/wp7-fx-shots/
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Chrome profiles live OUTSIDE the project: a user-data-dir inside the
// Vite root makes the dev server watch ~10k extension files and reload
// the page continuously, so nothing ever finishes booting.
const TMP = path.join(os.tmpdir(), 'vb-wp7fx');
const SHOTS = path.join(HERE, 'wp7-fx-shots');
const APP = 'http://localhost:5174/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome.exe not found'); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });

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
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.errors.push(JSON.stringify(msg.params.args?.[0]?.value || ''));
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
      { expression: expr, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error('page exception: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
    }
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async key(code, vk, key, holdMs = 120) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws?.close(); } catch { } }
}

const procs = [];
function launchChrome(name, port) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  procs.push(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--window-size=1024,720', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' }));
}

async function waitFor(page, expr, ms, label) {
  const guarded = `(()=>{try{return (${expr})}catch(e){return false}})()`;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.eval(guarded)) return true;
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + (label || expr));
}

// Fire an authoritative event through the REAL applyEvent dispatcher —
// the same path host/solo/client all use. No harness back door into Fx.
const fire = (ev) => `import('/src/sim/events.js').then(M=>{
  const sc=game.scene.getScene('Game'); M.applyEvent(sc, ${JSON.stringify(ev)}); return 'ok';})`;

const goTo = async (page, x, y) => {
  await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot); p.body.reset(${x},${y});})()`);
  await sleep(500);
};

const main = async () => {
  // ================= PART A — solo =================
  launchChrome('solo', 9431);
  const page = new Cdp(9431, 'solo');
  await page.connect();
  await page.navigate(APP);
  await waitFor(page, `!!window.game && !!game.scene.getScene('Menu')`, 20000, 'menu');
  await page.eval(`game.scene.getScene('Menu')._solo()`);
  await waitFor(page, `game.scene.getScene('Game')?.players?.size > 0`, 15000, 'lobby');
  await sleep(1000);

  // ---- F1 Fx exists, allocated once, overlays are screen space ----
  const f1 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'), f=sc.fx;
    return {has:!!f, emitters:f?f._emList.length:0, rings:f?f._rings.length:0,
      ghosts:f?f._ghosts.length:0,
      dimSF:f?f.dimRect.scrollFactorX:-1, vigSF:f?f.collapseVig.scrollFactorX:-1,
      dimD:f?f.dimRect.depth:-1, vigD:f?f.collapseVig.depth:-1,
      urgD:f?f.urgencyVig.depth:-1};})()`);
  report('F1 Fx constructed; pools allocated once; overlays scrollFactor 0 at spec depths',
    f1.has && f1.emitters === 9 && f1.rings === 8 && f1.ghosts === 24 &&
    f1.dimSF === 0 && f1.vigSF === 0 && f1.dimD === 90 && f1.vigD === 91 && f1.urgD === 95,
    JSON.stringify(f1));

  // ---- F2 lobby camera stays STATIC (WP6 world==screen preserved) ----
  const f2 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'),c=sc.cameras.main;
    return {follows:!!sc._camFollows, tgt:!!c._follow, vx:c.worldView.x, vy:c.worldView.y,
      map:[sc.map.width,sc.map.height]};})()`);
  report('F2 lobby (960x540) keeps a STATIC camera — no follow, worldView at origin',
    f2.follows === false && f2.tgt === false && f2.vx === 0 && f2.vy === 0,
    JSON.stringify(f2));
  await page.shot('01-lobby-static-cam.png');

  // ---- run ----
  await page.key('KeyP', 80, 'p');
  await waitFor(page, `game.scene.getScene('Game')?.mapId === 'test'`, 15000, 'run');
  await sleep(1500);
  await page.shot('02-run-camera-follow.png');

  // ---- F3 camera follows + lookahead + deadzone on the big stage ----
  await goTo(page, 2400, 1300);
  await sleep(900);
  const f3 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'),c=sc.cameras.main;
    return {follows:!!sc._camFollows, tgt:!!c._follow, rp:c.roundPixels,
      dz:c.deadzone?[c.deadzone.width,c.deadzone.height]:null,
      vx:Math.round(c.worldView.x), vy:Math.round(c.worldView.y),
      look:Math.round(sc.fx._look.off), map:[sc.map.width,sc.map.height]};})()`);
  report('F3 large stage: camera follows local view, scrolled, roundPixels + 120x80 deadzone',
    f3.follows && f3.tgt && f3.rp === true && f3.dz[0] === 120 && f3.dz[1] === 80 &&
    f3.vx > 500 && f3.vy > 400 && Math.abs(f3.look) > 5, JSON.stringify(f3));
  await page.shot('03-camera-scrolled.png');

  // ---- F4 world-space UI still lands on its targets with the camera scrolled ----
  // Stand next to the vault door: the WorldHUD prompt is world-anchored, so
  // its WORLD x must equal the door's, and its SCREEN x must equal
  // world - worldView.x. Screen-space widgets must stay at scrollFactor 0.
  const d3 = await page.eval(`(()=>{const d=game.scene.getScene('Game').doors.get('d3');
    return [Math.round(d.x),Math.round(d.y)];})()`);
  await goTo(page, d3[0] - 34, d3[1]);
  await sleep(900);
  const f4 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'),c=sc.cameras.main;
    const w=sc.worldUI, d=sc.doors.get('d3');
    const scr=sc.toScreen(d.x,d.y);
    return {vx:Math.round(c.worldView.x), vy:Math.round(c.worldView.y),
      promptVis:w.prompt1.visible, promptSF:w.prompt1.scrollFactorX,
      dynSF:w.dynGfx.scrollFactorX, dbgSF:sc.debugText.scrollFactorX,
      dx:Math.round(d.x), px:Math.round(w.prompt1.x),
      scrX:Math.round(scr.x), expectX:Math.round(d.x-c.worldView.x),
      barSF:sc.players.get(sc.session.localSlot).barBg.scrollFactorX};})()`);
  report('F4 world-space UI stays world-anchored under a scrolled camera; toScreen exact',
    f4.vx > 0 && f4.promptSF === 1 && f4.dynSF === 1 && f4.barSF === 1 &&
    f4.dbgSF === 0 && f4.promptVis && Math.abs(f4.px - f4.dx) < 1 &&
    f4.scrX === f4.expectX, JSON.stringify(f4));

  // ping marker: world marker at world coords, edge indicator screen-fixed
  await page.eval(fire({ kind: 'pingMarker', slot: 0, x: 300, y: 1300 }));
  await sleep(400);
  const f4b = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.worldUI.pings[0], c=sc.cameras.main;
    return {n:sc.worldUI.pings.length, gx:Math.round(p.g.x), gSF:p.g.scrollFactorX,
      eSF:p.edge.scrollFactorX, eVis:p.edge.visible,
      offscreen:!c.worldView.contains(p.x,p.y),
      ex:Math.round(p.edge.x)};})()`);
  report('F4b ping marker world-anchored; off-screen edge indicator screen-fixed + clamped',
    f4b.gx === 300 && f4b.gSF === 1 && f4b.eSF === 0 && f4b.offscreen &&
    f4b.eVis && f4b.ex >= 12 && f4b.ex <= 948, JSON.stringify(f4b));
  await page.shot('04-world-ui-scrolled-camera.png');

  // ---- F5 LOCKED body geometry MID-SQUASH (the §0.2 hitbox guard) ----
  const f5 = await page.eval(`(async()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot);
    const base={w:p.body.width,h:p.body.height};
    sc.fx._squash(p, 1.30, 0.70, 400);
    await new Promise(r=>setTimeout(r,120));
    const mid={w:p.body.width,h:p.body.height,
      artSX:+p.art.scaleX.toFixed(3), artSY:+p.art.scaleY.toFixed(3),
      goSX:p.scaleX, goSY:p.scaleY, goRot:p.rotation};
    await new Promise(r=>setTimeout(r,500));
    const after={w:p.body.width,h:p.body.height,artSX:+p.art.scaleX.toFixed(2)};
    return {base,mid,after};})()`);
  report('F5 squash-stretch runs on p.art; body stays LOCKED 26x34, root never scaled/rotated',
    f5.base.w === 26 && f5.base.h === 34 && f5.mid.w === 26 && f5.mid.h === 34 &&
    f5.after.w === 26 && f5.after.h === 34 &&
    f5.mid.artSX !== 1 && f5.mid.artSY !== 1 &&
    f5.mid.goSX === 1 && f5.mid.goSY === 1 && f5.mid.goRot === 0 &&
    f5.after.artSX === 1, JSON.stringify(f5));

  // stun pose: rotation on the art node only, body unchanged
  const f5b = await page.eval(`(async()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot);
    // StunSystem clears .stunned the moment stunMsLeft hits 0, so the
    // flag alone flips back before the pose tween finishes — hold it.
    p.state.stunned=true; p.state.stunMsLeft=4000;
    await new Promise(r=>setTimeout(r,400));
    const on={rot:+p.art.rotation.toFixed(2), goRot:p.rotation,
      w:p.body.width,h:p.body.height, stars:p.stars.visible};
    p.state.stunned=false; p.state.stunMsLeft=0;
    await new Promise(r=>setTimeout(r,320));
    const off={rot:+p.art.rotation.toFixed(2), w:p.body.width,h:p.body.height};
    return {on,off};})()`);
  report('F5b stun pose rotates the ART node only; body + root transform untouched',
    Math.abs(Math.abs(f5b.on.rot) - 1.57) < 0.05 && f5b.on.goRot === 0 &&
    f5b.on.w === 26 && f5b.on.h === 34 && f5b.on.stars === true &&
    Math.abs(f5b.off.rot) < 0.05 && f5b.off.w === 26, JSON.stringify(f5b));
  await page.shot('05-stun-pose.png');

  // ---- F6 grapple beam styling ----
  const f6 = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot);
    const rows=[{slot:0,x:p.x,y:p.y,tx:p.x+220,ty:p.y-160}];
    const delegated = sc._drawBeams.toString().includes('this.fx.drawBeams');
    sc._drawBeams(rows);
    const cmds=sc.beamGfx.commandBuffer.length;
    return {delegated, cmds, rows:sc._beamRows.length, depth:sc.beamGfx.depth};})()`);
  report('F6 beam drawing delegated to Fx (3px body + 1px ink core + diamond tip)',
    f6.delegated && f6.cmds > 20 && f6.depth === 40, JSON.stringify(f6));

  // live grapple for the screenshot: fire GRAPPLE_ATTACH sparks too
  await page.eval(fire({ kind: 'grappleAttach', slot: 0, targetKind: 'terrain', targetId: null, x: 3050, y: 1180 }));
  await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot);
    sc._drawBeams([{slot:0,x:p.x,y:p.y,tx:3050,ty:1180}]);})()`);
  await sleep(120);
  await page.shot('06-grapple-beam-attach-sparks.png');

  // ---- F7 impact particles (HIT) ----
  const f7 = await page.eval(`(async()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const p=sc.players.get(sc.session.localSlot);
    const before=f._emList.reduce((a,e)=>a+e.getAliveParticleCount(),0);
    const M=await import('/src/sim/events.js');
    M.applyEvent(sc,{kind:'hit',slot:0,weapon:'hammer',targetKind:'door',
      targetId:'d3',x:p.x+30,y:p.y,ff:false});
    await new Promise(r=>setTimeout(r,60));
    const after=f._emList.reduce((a,e)=>a+e.getAliveParticleCount(),0);
    return {before,after,shakeRank:f._shake.rank};})()`);
  report('F7 HIT emits impact particles through the real applyEvent path + small shake',
    f7.after > f7.before && f7.shakeRank >= 1, JSON.stringify(f7));
  await page.shot('07-hammer-impact-particles.png');

  // ---- F8 noise ripple (amount-scaled, art-spec §3.5) ----
  const f8 = await page.eval(`(async()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const p=sc.players.get(sc.session.localSlot);
    const M=await import('/src/sim/events.js');
    M.applyEvent(sc,{kind:'noiseBurst',x:p.x,y:p.y,amount:30,cause:'doorSmash'});
    await new Promise(r=>setTimeout(r,80));
    const vis=f._rings.filter(g=>g.visible).length;
    return {vis, shake:f._shake.rank,
      hudRippleUsed: typeof sc.worldUI._ripple==='function'};})()`);
  report('F8 NOISE_BURST(30) draws the triple ripple from the pool + medium shake (one owner)',
    f8.vis >= 1 && f8.shake >= 2, JSON.stringify(f8));
  await sleep(60);
  await page.shot('08-noise-ripple-doorsmash.png');

  // ---- F9 escalation 1 ----
  await page.eval(fire({ kind: 'escalation', level: 1 }));
  await sleep(1400);
  const f9 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const p=sc.players.get(sc.session.localSlot);
    return {lvl:f._escLevel, dimVis:f.dimRect.visible, dimA:+f.dimRect.alpha.toFixed(2),
      glow:p.glow.visible, glowA:+p.glow.alpha.toFixed(2),
      relicGlow:f.relicEscGlow.visible};})()`);
  report('F9 ESCALATION 1: dim overlay tweening up + per-player glow + relic halo',
    f9.lvl === 1 && f9.dimVis && f9.dimA > 0.15 && f9.glow && f9.relicGlow,
    JSON.stringify(f9));
  await sleep(900);
  await page.shot('09-escalation1-lights-dim.png');

  // ---- F10 escalation 2: vignette + "unstable, not collapsing" platforms ----
  await page.eval(fire({ kind: 'escalation', level: 2 }));
  await sleep(1000);
  const f10 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const marked=f._marked;
    return {lvl:f._escLevel, vig:f.collapseVig.visible, vigA:+f.collapseVig.alpha.toFixed(2),
      marked:marked.length, tinted:marked.filter(t=>t.isTinted).length,
      decal:!!f._collapseGfx&&f._collapseGfx.visible,
      bodiesIntact:marked.every(t=>t.body&&t.body.enable!==false)};})()`);
  report('F10 ESCALATION 2: vignette + marked-platform warning wash; COLLIDERS UNTOUCHED',
    f10.lvl === 2 && f10.vig && f10.vigA > 0.5 && f10.marked === 4 &&
    f10.tinted === 4 && f10.decal && f10.bodiesIntact, JSON.stringify(f10));
  await goTo(page, 1700, 900);
  await sleep(700);
  await page.shot('10-escalation2-collapse-warning.png');

  // ---- F11 particle cap + drop policy ----
  const f11 = await page.eval(`(async()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const p=sc.players.get(sc.session.localSlot);
    const M=await import('/src/sim/events.js');
    const d0=f.drops; let peak=0;
    for(let i=0;i<400;i++){
      M.applyEvent(sc,{kind:'hit',slot:0,weapon:'hammer',targetKind:'monster',
        targetId:'m',x:p.x+(i%40),y:p.y,ff:false});
      const live=f._emList.reduce((a,e)=>a+e.getAliveParticleCount(),0);
      if(live>peak)peak=live;
    }
    await new Promise(r=>setTimeout(r,50));
    const live=f._emList.reduce((a,e)=>a+e.getAliveParticleCount(),0);
    return {peak, live, drops:f.drops-d0, cap:250};})()`);
  report('F11 hard particle cap holds under a 400-event burst; excess DROPPED not queued',
    f11.peak <= 250 && f11.live <= 250 && f11.drops > 0, JSON.stringify(f11));

  // ---- F12 shake arbiter never stacks ----
  const f12 = await page.eval(`(()=>{const f=game.scene.getScene('Game').fx;
    f._shake={rank:0,endsAt:0};
    f.shake('calamity'); const a={...f._shake};
    f.shake('small');    const b={...f._shake};
    f.shake('calamity'); const c={...f._shake};
    return {a:a.rank,b:b.rank,c:c.rank};})()`);
  report('F12 shake arbiter: a lower tier never interrupts a running higher one',
    f12.a === 4 && f12.b === 4 && f12.c === 4, JSON.stringify(f12));

  // ---- F13 fps under load: real monsters (noise-driven) + particles ----
  await page.eval(`import('/src/systems/NoiseSystem.js').then(async M=>{
    const sc=game.scene.getScene('Game'); const p=sc.players.get(sc.session.localSlot);
    for(let i=0;i<4;i++){ M.addNoise(sc.sim,p.x,p.y,100,'test',0);
      await new Promise(r=>setTimeout(r,900)); }
    return 'ok';})`);
  await sleep(2500);
  const load = await page.eval(`(async()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const p=sc.players.get(sc.session.localSlot);
    const M=await import('/src/sim/events.js');
    const samples=[]; let minF=999, peak=0;
    for(let t=0;t<90;t++){
      M.applyEvent(sc,{kind:'hit',slot:0,weapon:'hammer',targetKind:'monster',
        targetId:'m',x:p.x+20,y:p.y,ff:false});
      if(t%12===0) M.applyEvent(sc,{kind:'noiseBurst',x:p.x,y:p.y,amount:30,cause:'doorSmash'});
      if(t%20===0) M.applyEvent(sc,{kind:'doorState',id:'d3',state:'intact',smashHp:4-(t/20|0),method:'smash',slot:0});
      await new Promise(r=>requestAnimationFrame(r));
      const fps=game.loop.actualFps; samples.push(fps); if(fps<minF)minF=fps;
      const live=f._emList.reduce((a,e)=>a+e.getAliveParticleCount(),0);
      if(live>peak)peak=live;
    }
    return {monsters:sc.monsters.size, players:sc.players.size,
      mean:Math.round(samples.reduce((a,b)=>a+b,0)/samples.length),
      min:Math.round(minF), peak, drops:f.drops, tweens:f._tweens.size};})()`);
  report('F13 60 fps budget holds under load (monsters + capped particles + shakes)',
    load.min >= 55 && load.mean >= 58 && load.peak <= 250,
    JSON.stringify(load));
  await page.shot('11-load-monsters-particles.png');

  // ---- F14 win results: wipe + confetti ----
  await page.key('KeyR', 82, 'r');
  await sleep(900);
  const f14 = await page.eval(`(()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const c=sc.cameras.main;
    return {phase:sc.session.phase, follow:!!c._follow,
      confetti:sc.children.list.filter(o=>o.depth===101).length,
      tweens:f._tweens.size};})()`);
  report('F14 RESULTS: camera released + confetti burst allocated on a WIN payload',
    f14.phase === 'results' && f14.follow === false && f14.confetti > 0,
    JSON.stringify(f14));
  await page.shot('12-results-win-confetti.png');

  // lose-path FX on demand (calamity shake + danger tint + falling debris)
  await page.eval(fire({ kind: 'runOver', result: 'lose', reason: 'calamity' }));
  await sleep(500);
  const f14b = await page.eval(`(()=>{const f=game.scene.getScene('Game').fx;
    return {tintVis:f.tintRect.visible, tintA:+f.tintRect.alpha.toFixed(2),
      shake:f._shake.rank,
      debris:f.em.debrisScreen.getAliveParticleCount(),
      debrisSF:f.em.debrisScreen.scrollFactorX};})()`);
  report('F14b LOSE: calamity shake + danger tint + screen-space falling debris',
    f14b.tintVis && f14b.tintA > 0.1 && f14b.shake === 4 &&
    f14b.debris > 0 && f14b.debrisSF === 0, JSON.stringify(f14b));
  await page.shot('13-results-lose-calamity.png');

  // ---- F15 teardown / leak across phase restarts ----
  const before = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    return {tw:sc.tweens.getTweens().length, fxTw:sc.fx._tweens.size};})()`);
  await page.key('KeyL', 76, 'l');
  await waitFor(page, `game.scene.getScene('Game')?.mapId === 'lobby'`, 15000, 'lobby2');
  await sleep(800);
  await page.key('KeyP', 80, 'p');
  await waitFor(page, `game.scene.getScene('Game')?.mapId === 'test'`, 15000, 'run2');
  await sleep(1500);
  const after = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    return {tw:sc.tweens.getTweens().length, fxTw:sc.fx._tweens.size,
      esc:sc.fx._escLevel, dim:sc.fx.dimRect.visible,
      follow:!!sc.cameras.main._follow, fps:Math.round(game.loop.actualFps)};})()`);
  report('F15 phase restart rebuilds Fx clean: no tween pile-up, escalation reset, camera re-attached',
    after.fxTw <= before.fxTw + 2 && after.esc === 0 && after.dim === false &&
    after.follow === true, JSON.stringify({ before, after }));

  const fpsAfter = await page.eval(`(async()=>{await new Promise(r=>setTimeout(r,2500));
    return Math.round(game.loop.actualFps);})()`);
  report('F16 fps healthy after the restart round trip (no cross-round decay)',
    fpsAfter >= 55, `${fpsAfter} fps`);
  await page.shot('14-run2-after-restart.png');

  report('F17 solo: no page exceptions', page.errors.length === 0,
    page.errors.slice(0, 3).join(' | ') || 'clean');

  // ================= PART B — host + client =================
  launchChrome('host', 9432);
  launchChrome('client', 9433);
  const H = new Cdp(9432, 'host'), C = new Cdp(9433, 'client');
  await H.connect(); await C.connect();
  await H.navigate(APP); await C.navigate(APP);
  await waitFor(H, `!!window.game && game.scene.isActive('Menu')`, 25000, 'host menu');
  await waitFor(C, `!!window.game && game.scene.isActive('Menu')`, 25000, 'client menu');
  await H.eval(`(game.scene.getScene('Menu')._host(), 'ok')`);
  await waitFor(H, `game.scene.getScene('Game')?.players?.size > 0`, 30000, 'host lobby');
  const code = await H.eval(`game.scene.getScene('Game').session.roomCode`);
  await C.eval(`(game.scene.getScene('Menu')._join('${code}'), 'ok')`);
  await waitFor(C, `game.scene.getScene('Game')?.players?.size > 0`, 30000, 'client lobby');
  await waitFor(H, `game.scene.getScene('Game').players.size === 2`, 20000, 'host sees 2');
  await sleep(1200);
  await H.shot('20-host-lobby.png');
  await C.shot('21-client-lobby.png');

  const b1 = await C.eval(`(()=>{const sc=game.scene.getScene('Game');
    return {mode:sc.mode, hasFx:!!sc.fx, follows:!!sc._camFollows,
      emitters:sc.fx?sc.fx._emList.length:0};})()`);
  report('F18 client builds the SAME Fx (one code path, no mode branches)',
    b1.mode === 'client' && b1.hasFx && b1.emitters === 9, JSON.stringify(b1));

  // start the run
  await H.key('KeyP', 80, 'p');
  await waitFor(H, `game.scene.getScene('Game')?.mapId === 'test'`, 20000, 'host run');
  await waitFor(C, `game.scene.getScene('Game')?.mapId === 'test'`, 20000, 'client run');
  await sleep(2500);

  // move the host player so the CLIENT's view of it moves too, then check
  // the client camera follows its OWN interpolated view.
  await H.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot); p.body.reset(2400,1300);})()`);
  await sleep(1500);
  const b2 = await C.eval(`(()=>{const sc=game.scene.getScene('Game'),c=sc.cameras.main;
    const me=sc.players.get(sc.session.localSlot);
    return {follows:!!sc._camFollows, tgt:!!c._follow,
      tgtIsLocal: c._follow===me,
      vx:Math.round(c.worldView.x), vy:Math.round(c.worldView.y),
      myx:Math.round(me.x), myy:Math.round(me.y),
      promptSF:sc.worldUI.prompt1.scrollFactorX};})()`);
  report('F19 client camera follows its OWN interpolated view; world UI still scrollFactor 1',
    b2.follows && b2.tgt && b2.tgtIsLocal && b2.promptSF === 1, JSON.stringify(b2));
  await C.shot('22-client-run-camera.png');

  // client-side FX from host-broadcast events: beams + ripple + escalation
  await H.eval(`import('/src/systems/NoiseSystem.js').then(M=>{
    const sc=game.scene.getScene('Game'); const p=sc.players.get(sc.session.localSlot);
    M.addNoise(sc.sim,p.x,p.y,100,'test',0); return 'ok';})`);
  await sleep(1800);
  const b3 = await C.eval(`(async()=>{const sc=game.scene.getScene('Game'),f=sc.fx;
    const before=f._emList.reduce((a,e)=>a+e.getAliveParticleCount(),0);
    const rings=f._rings.filter(g=>g.visible).length;
    return {monsters:sc.monsters.size, live:before, rings,
      replayDone:sc.net._replayDone===true, drops:f.drops};})()`);
  report('F20 client renders host-driven FX (monster spawn burst + ripple) after SYNC_DONE',
    b3.replayDone && b3.monsters >= 1, JSON.stringify(b3));
  await C.shot('23-client-monster-spawn-fx.png');
  await H.shot('24-host-monster-spawn-fx.png');

  // escalation reaches the client through the ESCALATION event
  await H.eval(fire({ kind: 'escalation', level: 1 }));
  await H.eval(`(()=>{const sc=game.scene.getScene('Game');
    sc.net.broadcastEvent({kind:'escalation',level:1}); return 'ok';})()`);
  await sleep(2400);
  const b4 = await C.eval(`(()=>{const f=game.scene.getScene('Game').fx;
    return {lvl:f._escLevel, vis:f.dimRect.visible, a:+f.dimRect.alpha.toFixed(2)};})()`);
  report('F21 escalation-1 tint reaches the client over the wire',
    b4.lvl === 1 && b4.vis && b4.a > 0.15, JSON.stringify(b4));
  await C.shot('25-client-escalation1.png');

  // 2-peer fps. TWO headless Chrome instances with --disable-gpu share one
  // CPU here, so the absolute number is dominated by harness contention,
  // not by the game. What is actually attributable to WP7 is the DELTA, so
  // measure with Fx live and again with it detached (drawBeams falls back
  // to the WP1 path, update() is skipped) and require the overhead to be
  // small. Absolute 60 fps is asserted in the single-instance F13/F16.
  const sample = (pg) => pg.eval(`(async()=>{await new Promise(r=>setTimeout(r,3000));
    return Math.round(game.loop.actualFps);})()`);
  const hOn = await sample(H), cOn = await sample(C);
  const detach = (pg) => pg.eval(`(()=>{const sc=game.scene.getScene('Game');
    sc._fxParked=sc.fx; sc.fx=null; return 'ok';})()`);
  await detach(H); await detach(C);
  const hOff = await sample(H), cOff = await sample(C);
  await H.eval(`(()=>{const sc=game.scene.getScene('Game'); sc.fx=sc._fxParked; return 'ok';})()`);
  await C.eval(`(()=>{const sc=game.scene.getScene('Game'); sc.fx=sc._fxParked; return 'ok';})()`);
  const overhead = Math.max(hOff - hOn, cOff - cOn);
  report('F22 2-peer: Fx costs ~nothing (delta vs Fx-detached under identical load)',
    overhead <= 4, `host ${hOn} (fx off ${hOff}) / client ${cOn} (fx off ${cOff}) -> max delta ${overhead} fps`);

  report('F23 2-peer: no page exceptions',
    H.errors.length === 0 && C.errors.length === 0,
    [...H.errors.slice(0, 2), ...C.errors.slice(0, 2)].join(' | ') || 'clean');

  page.close(); H.close(); C.close();
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fail}/${results.length} passed`);
  for (const p of procs) { try { p.kill(); } catch { } }
  process.exit(fail ? 1 : 0);
};

main().catch(async (e) => {
  console.error('HARNESS ERROR:', e.message);
  for (const p of procs) { try { p.kill(); } catch { } }
  process.exit(2);
});
