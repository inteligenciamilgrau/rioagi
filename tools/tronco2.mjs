import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5199;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:700,height:520}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando'; ctx.ai.spawnAutomatico=false;
  const V=ctx.camera.position.constructor;
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const P=sp.position??sp;
  const rota=[]; for(let k=0;k<3;k++){const q=pts[(k*5+2)%pts.length]; rota.push((q.position??q).clone());}
  const e=ctx.ai.spawn(P,0,rota); window.__e=e;
  ctx.player.movement.teleport(P.x+45,P.y+0.1,P.z+45);
  const log=[]; let quebrou=-1;
  const OSSOS=['peito','cabeca','ombro_D','punho_D','joelho_D','pe_D'];
  const REF={peito:0.39,cabeca:0.63,ombro_D:0.51,punho_D:0.53,joelho_D:0.49,pe_D:0.95};
  for(let seg=0;seg<=90;seg++){
    if(seg>0) for(let f=0;f<60;f++) ctx.ai.update(1/60);
    const s=e.soldado; s.grupo.updateMatrixWorld(true);
    const q=new V(), v=new V(); s.porNome.quadril.getWorldPosition(q);
    const d={}; let ruim=false;
    for(const n of OSSOS){ s.porNome[n].getWorldPosition(v); d[n]=v.distanceTo(q);
      if(Math.abs(d[n]-REF[n])>0.30) ruim=true; }
    if(seg%10===0||ruim) log.push(`t=${String(seg).padStart(2)}s ${e.estado.padEnd(9)} `+OSSOS.map(n=>`${n}=${d[n].toFixed(2)}`).join(' ')+(ruim?'  <-- FORA':''));
    if(ruim&&quebrou<0) quebrou=seg;
    if(quebrou>0&&seg>quebrou+3) break;
  }
  return {log,quebrou};
});
console.log('referencia (pose correta): peito=0.39 cabeca=0.63 ombro=0.51 punho=0.53 joelho=0.49 pe=0.95\n');
r.log.forEach(l=>console.log(l));
console.log(r.quebrou>=0?`\n>>> POSE QUEBROU aos ${r.quebrou}s`:'\n>>> pose correta durante 90s');
if(r.quebrou>=0){ await p.evaluate(()=>{const c=window.__game.ctx,e=window.__e;
  c.camera.up.set(0,1,0); c.camera.position.set(e.pos.x+3,e.pos.y+1.3,e.pos.z+3);
  c.camera.lookAt(e.pos.x,e.pos.y+0.9,e.pos.z); c.camera.updateMatrixWorld(true);
  c.menu?.hideAll?.(); c.hud?.setVisible?.(false); c.viewScene.visible=false; window.__game.settle(14);});
  await p.waitForTimeout(250); await p.screenshot({path:ROOT+'/shots/inimigo/quebrado.png'}); }
await b.close(); vite.kill();
