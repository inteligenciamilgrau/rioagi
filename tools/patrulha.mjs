import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5198;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando'; ctx.ai.spawnAutomatico=false;
  const V=ctx.camera.position.constructor;
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const P=sp.position??sp;
  // rota de patrulha real, como spawnOnda monta
  const rota=[];
  for(let k=0;k<3;k++){ const q=pts[(k*5+2)%pts.length]; rota.push((q.position??q).clone()); }
  const e=ctx.ai.spawn(P, 0, rota); window.__e=e;
  ctx.player.movement.teleport(P.x+40,P.y+0.1,P.z+40);   // longe: nao detecta
  const log=[];
  const amostra=(t)=>{
    const s=e.soldado; s.grupo.updateMatrixWorld(true);
    const q=new V(), v=new V(); s.porNome.quadril.getWorldPosition(q);
    let nan=0,max=0,pior='';
    for(const bo of s.ossos){ bo.getWorldPosition(v);
      if(!Number.isFinite(v.x+v.y+v.z)){nan++;pior=bo.name;continue;}
      const d=v.distanceTo(q); if(d>max){max=d;pior=bo.name;} }
    log.push(`t=${t}s estado=${e.estado.padEnd(9)} NaN=${nan} maiorDist=${max.toFixed(2)}m (${pior}) grupoY=${s.grupo.position.y.toFixed(2)}`);
    return {nan,max};
  };
  amostra(0);
  let quebrou=-1;
  for(let seg=1;seg<=30;seg++){
    for(let f=0;f<60;f++) ctx.ai.update(1/60);
    const a=amostra(seg);
    if((a.nan>0||a.max>3) && quebrou<0) quebrou=seg;
    if(seg>=8 && quebrou<0 && seg%6) log.pop();   // enxuga log se estiver saudavel
  }
  return {log,quebrou};
});
r.log.forEach(l=>console.log(l));
console.log(r.quebrou>0?`\n>>> ESQUELETO QUEBROU aos ${r.quebrou}s de patrulha`:'\n>>> esqueleto saudavel em 30s de patrulha');
await p.evaluate(()=>{const c=window.__game.ctx;const e=window.__e;
  c.camera.up.set(0,1,0);
  c.camera.position.set(e.pos.x+3,e.pos.y+1.4,e.pos.z+3);
  c.camera.lookAt(e.pos.x,e.pos.y+0.9,e.pos.z); c.camera.updateMatrixWorld(true);
  c.menu?.hideAll?.(); c.hud?.setVisible?.(false); c.viewScene.visible=false; window.__game.settle(14);});
await p.waitForTimeout(250);
await p.screenshot({path:ROOT+'/shots/inimigo/patrulha.png'});
await b.close(); vite.kill();
