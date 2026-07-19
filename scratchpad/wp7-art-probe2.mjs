import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const TMP=path.join(HERE,'tmp-art4'), SHOTS=path.join(HERE,'wp7-art-shots');
const APP='http://localhost:5175/';
const CHROME=['C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'].find(p=>existsSync(p));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const procs=[];
class Cdp{constructor(p){this.port=p;this.id=0;this.pending=new Map();this.errors=[];}
 async connect(){let i2=null;for(let i=0;i<60;i++){try{i2=await(await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();break;}catch{await sleep(250);}}
  this.ws=new WebSocket(i2.webSocketDebuggerUrl);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});
  this.ws.onmessage=m=>this._m(JSON.parse(m.data));const{targetInfos}=await this.send('Target.getTargets');
  const pg=targetInfos.find(t=>t.type==='page');const{sessionId}=await this.send('Target.attachToTarget',{targetId:pg.targetId,flatten:true});
  this.sessionId=sessionId;await this.send('Runtime.enable',{},sessionId);await this.send('Page.enable',{},sessionId);}
 _m(m){if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params?.exceptionDetails?.exception?.description||'?');}
 send(method,params={},sid){const id=++this.id;const p={id,method,params};if(sid)p.sessionId=sid;this.ws.send(JSON.stringify(p));return new Promise((res,rej)=>this.pending.set(id,{res,rej}));}
 async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true},this.sessionId);if(r.exceptionDetails)throw new Error('exc '+(r.exceptionDetails.exception?.description||'').slice(0,200));return r.result?.value;}
 async navigate(u){await this.send('Page.navigate',{url:u},this.sessionId);}
 async shot(n){const{data}=await this.send('Page.captureScreenshot',{format:'png'},this.sessionId);writeFileSync(path.join(SHOTS,n),Buffer.from(data,'base64'));console.log('shot',n);}
 async key(c,vk,ch,ms=120){await this.send('Input.dispatchKeyEvent',{type:'keyDown',windowsVirtualKeyCode:vk,code:c,key:ch},this.sessionId);await sleep(ms);await this.send('Input.dispatchKeyEvent',{type:'keyUp',windowsVirtualKeyCode:vk,code:c,key:ch},this.sessionId);}
 close(){try{this.ws?.close();}catch{}}}
async function waitFor(p,e,t,l){const g=`(()=>{try{return (${e})}catch(x){return false}})()`;const t0=Date.now();while(Date.now()-t0<t){const v=await p.eval(g);if(v)return v;await sleep(120);}throw new Error('timeout '+l);}
const SC=`game.scene.getScene('Game')`,SIM=`${SC}.sim`;
try{
 rmSync(TMP,{recursive:true,force:true});mkdirSync(TMP,{recursive:true});mkdirSync(SHOTS,{recursive:true});
 procs.push(spawn(CHROME,['--headless=new','--remote-debugging-port=9766',`--user-data-dir=${path.join(TMP,'a')}`,'--no-first-run','--disable-gpu','--mute-audio','--window-size=1024,720','about:blank'],{stdio:'ignore'}));
 const A=new Cdp(9766);await A.connect();await A.navigate(APP);
 await waitFor(A,`!!window.game && game.scene.isActive('Menu')`,25000,'menu');
 await A.eval(`(game.scene.getScene('Menu')._solo(),'ok')`);
 await waitFor(A,`game.scene.isActive('Game') && !!${SIM}`,20000,'lobby');
 await A.key('KeyP',80,'p');await waitFor(A,`${SC}.session.phase==='playing'`,12000,'playing');
 await waitFor(A,`!!${SIM}.relic`,8000,'relic');await sleep(900);
 await A.eval(`(()=>{const sc=${SC};for(const s of[1,2,3])if(!sc.players.has(s))sc._addPlayer(s);return 1;})()`);
 await sleep(300);
 await A.eval(`(()=>{const sim=${SIM};const p=${SC}.players.get(2);p.state.carrying=null;sim.relicSys._attach(sim,p);sim.relicSys.completeBag(sim,p);return 1;})()`);
 await sleep(700);
 const dump=await A.eval(`(()=>{const sc=${SC};const p=sc.players.get(2);const out=[];
  const walk=(list,parentX,parentY,path)=>{for(const o of list){const wx=parentX+(o.x||0),wy=parentY+(o.y||0);
   if(o.visible&&(o.alpha??1)>0.05&&Math.abs(wx-p.x)<60&&Math.abs(wy-p.y)<60){
    out.push({p:path,type:o.type,tex:o.texture?.key,x:Math.round(wx),y:Math.round(wy),tint:(o.tintTopLeft??0).toString(16),alpha:o.alpha});}
   if(o.list)walk(o.list,wx,wy,path+'/'+(o.texture?.key||o.type));}};
  walk(sc.children.list,0,0,'');return out;})()`);
 console.log(JSON.stringify(dump,null,1));
 await A.eval(`(()=>{${SC}.cameras.main.setZoom(3);${SC}.cameras.main.stopFollow();${SC}.cameras.main.centerOn(${SC}.players.get(2).x,${SC}.players.get(2).y);return 1;})()`);
 await sleep(500); await A.shot('G0-bagged-closeup.png');
 await A.eval(`(()=>{const sim=${SIM};sim.relicSys.completeUnbag(sim,${SC}.players.get(2));return 1;})()`);
 await sleep(2600);
 await A.eval(`(()=>{${SC}.cameras.main.centerOn(${SC}.players.get(2).x,${SC}.players.get(2).y);return 1;})()`);
 await A.shot('G1-hands-closeup.png');
 console.log('errors',JSON.stringify(A.errors.slice(0,3)));A.close();
}catch(e){console.error('ABORT:',e.message);}finally{for(const p of procs){try{p.kill('SIGKILL');}catch{}}}
