import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5190;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const V=ctx.camera.position.constructor;
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9];
  const e=ctx.ai.spawn(sp.position??sp, sp.yaw??0, null);
  if(!e) return {erro:'sem inimigo'};
  // poe o jogador logo a frente para a IA mirar de verdade
  ctx.player.movement.teleport((sp.position??sp).x+6,(sp.position??sp).y+0.1,(sp.position??sp).z);
  const log=[];
  const medir=(tag)=>{
    const s=e.soldado; s.grupo.updateMatrixWorld(true);
    let nan=0,max=0,pior='';
    const v=new V();
    for(const bo of s.ossos||[]){
      bo.getWorldPosition(v);
      if(!Number.isFinite(v.x+v.y+v.z)){nan++;continue;}
      const d=v.distanceTo(e.pos);
      if(d>max){max=d;pior=bo.name;}
    }
    log.push(`${tag.padEnd(20)} NaN=${nan}  ossoMaisLonge=${max.toFixed(2)}m (${pior})  estado=${e.estado}`);
    return {nan,max};
  };
  medir('spawn');
  e.percepcao.consciencia=1; e.percepcao.visivel=true;
  e._trocar('atirar');
  for(let i=0;i<5;i++){ ctx.ai.update(1/60); }
  medir('mirando 5q');
  for(let i=0;i<60;i++){ ctx.ai.update(1/60); }
  const a=medir('mirando 65q');
  // agora leva dano enquanto mira
  for(let i=0;i<5;i++){ e.levarDano(10,e.pos.clone(),'torso',{x:1,y:0,z:0}); ctx.ai.update(1/60); }
  const c=medir('dano+mira');
  for(let i=0;i<120;i++){ ctx.ai.update(1/60); }
  const d=medir('+120 quadros');
  return {log, ruim:(a.nan+c.nan+d.nan)>0 || a.max>5 || c.max>5 || d.max>5};
});
if(r.erro)console.log(r.erro);
else{ r.log.forEach(l=>console.log(l));
  console.log(r.ruim?'\n>>> OSSOS EXPLODINDO — causa do sumico do tronco':'\n>>> esqueleto estavel'); }
await b.close(); vite.kill();
