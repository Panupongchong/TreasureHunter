// ============================================================
// wp7-tex-verify.mjs — WP7 TEXTURE-HALF verification.
// One headless Chrome instance (wp5-accept.mjs pattern), solo mode,
// lobby + run, CDP screenshots into scratchpad/wp7-tex-shots/.
// Asserts: texture registry present, generate-once across restarts,
// LOCKED body geometry unchanged, no page exceptions.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'vb-tmp-wp7'); // OUTSIDE the vite-watched tree
const SHOTS = path.join(HERE, 'wp7-tex-shots');
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

const main = async () => {
  launchChrome('solo', 9411);
  const page = new Cdp(9411, 'solo');
  await page.connect();
  await page.navigate(APP);
  await waitFor(page, `!!window.game && !!game.scene.getScene('Menu')`, 20000, 'menu');
  await sleep(600);
  await page.shot('00-menu.png');

  // ---- solo → lobby ----
  await page.eval(`game.scene.getScene('Menu')._solo()`);
  await waitFor(page, `game.scene.getScene('Game')?.players?.size > 0`, 15000, 'lobby');
  await sleep(1200);
  await page.shot('01-lobby.png');

  // texture registry
  const keys = await page.eval(`(()=>{
    const T = game.textures.list;
    return Object.keys(T).filter(k=>!k.startsWith('__')).sort();
  })()`);
  const want = ['player0','player1','player2','player3','playerEye','playerEyeX',
    'playerBag0','playerBagGem','playerGhost0','relic','relicGlint','skulker',
    'skulkerLegsUp','brute','bruteFist','hourglass','tombstone0','tombstoneGem',
    'portalArch','portalRings','tileWall','tileWallCracked','tileMid','tileFar',
    'px2','px3','px4','puff8','star8','debris4','glow64',
    'vignetteCollapse','vignetteDanger'];
  const missing = want.filter((k) => !keys.includes(k));
  report('T1 static texture registry complete', missing.length === 0,
    `${keys.length} keys; missing=[${missing}]`);
  report('T2 barrier textures are size-parameterized from map data',
    keys.some((k) => k.startsWith('bar:door:14x70')),
    keys.filter((k) => k.startsWith('bar:')).join(' '));

  // LOCKED body geometry — lobby (player)
  const geo1 = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot);
    return {w:p.body.width,h:p.body.height,ox:p.body.offset.x,oy:p.body.offset.y,
            bx:Math.round(p.body.x-(p.x-13)), by:Math.round(p.body.y-(p.y-17)),
            ox2:p.body.offset.x, oy2:p.body.offset.y,
            cw:p.width, ch:p.height, depth:p.depth};})()`);
  report('T3 player body geometry LOCKED (26x34, centered on container origin)',
    geo1.w === 26 && geo1.h === 34 && geo1.bx === 0 && geo1.by === 0,
    JSON.stringify(geo1));

  const dgeo = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const d=[...sc.doors.values()][0];
    return {tw:d.width,th:d.height,bw:d.body.width,bh:d.body.height,
            gb:(()=>{const b=d.getBounds();return [b.x,b.y,b.width,b.height]})(),
            depth:d.depth};})()`);
  report('T4 door natural-size image: texture == body == getBounds == map def',
    dgeo.tw === 14 && dgeo.th === 70 && dgeo.bw === 14 && dgeo.bh === 70 &&
    dgeo.gb[0] === 660 && dgeo.gb[1] === 458 && dgeo.gb[2] === 14 && dgeo.gb[3] === 70,
    JSON.stringify(dgeo));

  const mgeo = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const m=[...sc.monsters.values()][0];
    return {tex:m.texture.key,tw:m.width,th:m.height,bw:m.body.width,bh:m.body.height,
            ox:m.body.offset.x,oy:m.body.offset.y,depth:m.depth};})()`);
  report('T5 monster body geometry LOCKED (22x20 skulker under 22x18 art)',
    mgeo.bw === 22 && mgeo.bh === 20 && mgeo.tw === 22 && mgeo.th === 18,
    JSON.stringify(mgeo));

  const terr = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const ch=sc.platforms.getChildren();
    const b=ch[0].getBounds();
    return {n:ch.length,type:ch[0].type,b:[b.x,b.y,b.width,b.height],
            bw:ch[0].body.width,bh:ch[0].body.height,depth:ch[0].depth};})()`);
  report('T6 terrain TileSprite bounds/body == map rect (grapple raycast truth)',
    terr.type === 'TileSprite' && terr.b[0] === 0 && terr.b[1] === 528 &&
    terr.b[2] === 960 && terr.b[3] === 12 && terr.bw === 960 && terr.bh === 12,
    JSON.stringify(terr));

  // ---- start a run (host debug key P) ----
  await page.key('KeyP', 80, 'p');
  await waitFor(page, `game.scene.getScene('Game')?.mapId === 'test'`, 15000, 'run');
  await sleep(1800);
  await page.shot('02-run-spawn.png');

  // generate-once across the restart
  const afterKeys = await page.eval(`Object.keys(game.textures.list).filter(k=>!k.startsWith('__'))`);
  const added = afterKeys.filter((k) => !keys.includes(k));
  const addedNonTile = added.filter((k) => !/^[0-9a-f-]{20,}$/i.test(k));
  report('T7 no regeneration on scene.restart (only NEW map barriers added)',
    added.length > 0 && addedNonTile.every((k) => k.startsWith('bar:')),
    `lobby ${keys.length} -> run ${afterKeys.length}; added=[${addedNonTile.join(' ')}] +${added.length - addedNonTile.length} phaser-internal`);
  const barKeys = await page.eval(`Object.keys(game.textures.list).filter(k=>k.startsWith('bar:'))`);
  report('T8 test-map barrier keys generated from map dims',
    barKeys.length >= 5, barKeys.join(' '));

  // relic + geometry in the run
  const rgeo = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const r=sc.relic; return {tex:r.texture.key,tw:r.width,th:r.height,
      bw:r.body.width,bh:r.body.height,oy:r.body.offset.y,
      cx:Math.round(r.body.center.x-r.x),cy:Math.round(r.body.center.y-r.y)};})()`);
  report('T9 relic body LOCKED 22x22 under 22x28 diamond art, center unmoved',
    rgeo.bw === 22 && rgeo.bh === 22 && rgeo.tw === 22 && rgeo.th === 28 &&
    rgeo.cx === 0 && rgeo.cy === 0, JSON.stringify(rgeo));

  const p2 = await page.eval(`(()=>{const sc=game.scene.getScene('Game');
    const p=sc.players.get(sc.session.localSlot);
    return {ox:p.body.offset.x,oy:p.body.offset.y,w:p.body.width,h:p.body.height,
            onGround:p.state.onGround, y:Math.round(p.y)};})()`);
  report('T10 run-mode player body geometry still LOCKED (resting on floor top 1376)',
    p2.w === 26 && p2.h === 34 && p2.ox === 0 && p2.oy === 0 && p2.y === 1376 - 17,
    JSON.stringify(p2));

  // Camera tour: teleport the local player to each landmark and shoot.
  const tour = [
    ['03-doors-d0-d1', 1128, 1150],
    ['04-crankgate-d2', 2448, 950],
    ['05-vault-door-d3-relic', 2950, 1300],
    ['06-rubble-d4-hourglass', 1700, 560],
    ['07-ritual-altar', 1380, 980],
    ['08-exit-portal', 120, 1330],
  ];
  for (const [file, tx, ty] of tour) {
    await page.eval(`(()=>{const sc=game.scene.getScene('Game');
      const p=sc.players.get(sc.session.localSlot);
      p.body.reset(${tx},${ty}); sc.cameras.main.centerOn(${tx},${ty}); })()`);
    await sleep(700);
    await page.shot(file + '.png');
  }

  // Damage-state texture swap on the vault door (render-only path, driven
  // through the SAME setDoorDamaged the DOOR_STATE handler calls).
  // Teleport the player: the camera FOLLOWS it, so centerOn alone is a no-op.
  const goTo = async (tx, ty) => {
    await page.eval(`(()=>{const sc=game.scene.getScene('Game');
      const p=sc.players.get(sc.session.localSlot); p.body.reset(${tx},${ty});})()`);
    await sleep(600);
  };
  await goTo(2790, 1300);
  await page.shot('09a-door-intact.png');
  const dmgKey = async (hp) => page.eval(`import('/src/entities/DoorEntity.js').then(M=>{
    const d=game.scene.getScene('Game').doors.get('d3'); M.setDoorDamaged(d,${hp});
    return d.texture.key;})`);
  const before = await page.eval(`game.scene.getScene('Game').doors.get('d3').texture.key`);
  const mid = await dmgKey(2); await sleep(350); await page.shot('09b-door-cracked.png');
  const low = await dmgKey(1); await sleep(350); await page.shot('09c-door-splintered.png');
  const brk = await page.eval(`import('/src/entities/DoorEntity.js').then(M=>{
    const d=game.scene.getScene('Game').doors.get('d3'); M.setDoorBroken(d);
    return JSON.stringify({k:d.texture.key,bw:d.body?d.body.width:0,bh:d.body?d.body.height:0,
                           gb:[d.getBounds().width,d.getBounds().height]});})`);
  const b = JSON.parse(brk);
  await sleep(350); await page.shot('09d-door-broken.png');
  report('T11 damage states swap texture; body + bounds geometry unchanged',
    before !== mid && mid !== low && b.k.endsWith(':broken') &&
    b.bw === 24 && b.bh === 160 && b.gb[0] === 24 && b.gb[1] === 160,
    `${before} -> ${mid} -> ${low} -> ${b.k}; body ${b.bw}x${b.bh} bounds ${b.gb}`);

  // Restart churn: lobby -> run -> lobby -> run. Static keys must NEVER
  // regenerate, and Phaser's per-TileSprite fill textures must not pile up.
  const t0 = await page.eval(`Object.keys(game.textures.list).length`);
  await page.key('KeyR', 82, 'r');   // playing -> results
  await sleep(700);
  await page.shot('11-results.png');
  await page.key('KeyL', 76, 'l');   // results -> lobby (restart)
  await waitFor(page, `game.scene.getScene('Game')?.mapId === 'lobby'`, 15000, 'lobby2');
  await sleep(900);
  await page.key('KeyP', 80, 'p');
  await waitFor(page, `game.scene.getScene('Game')?.mapId === 'test'`, 15000, 'run2');
  await sleep(1500);
  const t1 = await page.eval(`Object.keys(game.textures.list).length`);
  report('T12 textures survive 2 more scene restarts without piling up',
    t1 <= t0 + 2, `before ${t0} -> after lobby+run round trip ${t1}`);
  await page.shot('10-run-restart.png');

  // fps under the textured scene
  const fps = await page.eval(`(async()=>{await new Promise(r=>setTimeout(r,2500));
    return Math.round(game.loop.actualFps);})()`);
  report('T13 frame rate holds with the textured world', fps >= 55, `${fps} fps`);

  report('T14 no page exceptions', page.errors.length === 0,
    page.errors.slice(0, 3).join(' | ') || 'clean');

  page.close();
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
