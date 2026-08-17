import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5187;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const ai=ctx.ai; const log=[];
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const n=ai.spawn(sp.position??sp, sp.yaw??0, null)?1:0;
  const e=ai.getEnemies()[0];
  if(!e) return {erro:'nenhum inimigo', n};
  const nanCheck=(tag)=>{
    const s=e.soldado; s.grupo.updateMatrixWorld(true);
    let nans=0, maxD=0;
    for(const bo of s.ossos||[]){
      const v=new (ctx.camera.position.constructor)();
      bo.getWorldPosition(v);
      if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||!Number.isFinite(v.z))nans++;
      else maxD=Math.max(maxD, v.distanceTo(e.pos));
    }
    const g=s.grupo.position;
    log.push(`${tag.padEnd(22)} ossosNaN=${nans}  distMaxOsso=${maxD.toFixed(1)}m  grupo=(${g.x.toFixed(1)},${g.y.toFixed(1)},${g.z.toFixed(1)}) visivel=${s.grupo.visible?'S':'N'}`);
    return nans;
  };
  nanCheck('vivo');
  // dano progressivo
  for(let i=0;i<4;i++){ e.levarDano(15,e.pos.clone(),'torso',{x:0,y:0,z:1}); ai.update(1/60); }
  nanCheck('apos 60 de dano');
  // mata
  e.levarDano(500,e.pos.clone(),'torso',{x:0,y:0,z:1});
  nanCheck('recem-morto');
  for(let i=0;i<10;i++) ai.update(1/60);
  const n1=nanCheck('ragdoll +10 quadros');
  for(let i=0;i<60;i++) ai.update(1/60);
  const n2=nanCheck('ragdoll +70 quadros');
  return {log, nanFinal:n1+n2};
});
if(r.erro){console.log(r.erro,r);}
else{ r.log.forEach(l=>console.log(l));
  console.log(r.nanFinal>0?'\n>>> RAGDOLL PRODUZ NaN — e a causa do sumico':'\n>>> sem NaN'); }
await b.close(); vite.kill();
