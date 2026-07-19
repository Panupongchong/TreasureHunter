// Quick render check: join code entry + settings screens.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'tmp-wp6');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.errors = []; }
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
      this.errors.push(msg.params?.exceptionDetails?.exception?.description || 'err');
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
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '?').slice(0, 300));
    return r.result?.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }, this.sessionId); }
  async key(code, vk, key, holdMs = 120) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key }, this.sessionId);
    await sleep(holdMs);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key }, this.sessionId);
  }
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    writeFileSync(path.join(TMP, file), Buffer.from(data, 'base64'));
  }
  close() { try { this.ws?.close(); } catch {} }
}

mkdirSync(TMP, { recursive: true });
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9602', `--user-data-dir=${path.join(TMP, 'p2')}`,
  '--no-first-run', '--disable-gpu', '--mute-audio', '--window-size=1024,720', 'about:blank',
], { stdio: 'ignore' });
const page = new Cdp(9602);
try {
  await page.connect();
  await page.navigate('http://localhost:5173/');
  for (let i = 0; i < 60; i++) {
    try { if (await page.eval(`!!window.game && game.scene.getScene('Menu')?.scene.isActive()`)) break; } catch {}
    await sleep(300);
  }
  await sleep(500);
  // join screen: type AB, check boxes
  await page.eval(`(game.scene.getScene('Menu')._showJoin(), 'ok')`);
  await page.key('KeyA', 65, 'a');
  await page.key('KeyB', 66, 'b');
  await sleep(200);
  const join = await page.eval(`(()=>{const m=game.scene.getScene('Menu');
    return {state:m.state, code:m.codeArr.join(''), active:m.activeBox, joinColor:m.joinBtn.style.color};})()`);
  console.log('join:', JSON.stringify(join));
  await page.shot('07-join.png');
  await page.key('Escape', 27, 'Escape');
  await sleep(200);
  // settings
  await page.eval(`(game.scene.getScene('Menu')._showSettings(), 'ok')`);
  await sleep(200);
  const set = await page.eval(`(()=>{const m=game.scene.getScene('Menu');
    return {state:m.state, name:m.valName.text, ff:m.valFf.text, vol:m.valVol.text, navItems:m.nav.items.length};})()`);
  console.log('settings:', JSON.stringify(set));
  // toggle FF via right arrow, edit name
  await page.key('ArrowDown', 40, 'ArrowDown');
  await page.key('ArrowRight', 39, 'ArrowRight');
  await sleep(150);
  const ff2 = await page.eval(`game.scene.getScene('Menu').valFf.text + '|' + localStorage.getItem('vb-ff')`);
  console.log('ff-toggled:', ff2);
  await page.shot('08-settings.png');
  console.log('page-errors:', page.errors.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  console.log('FAIL', e.message);
} finally {
  page.close();
  proc.kill();
}
