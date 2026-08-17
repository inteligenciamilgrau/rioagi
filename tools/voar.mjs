import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5217;
const v=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};v.stdout.on('data',h);v.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando'; ctx.bus.emit('game:start',{});
  const V=ctx.camera.position.constructor;
  const col=ctx.world.collision; const down=new V(0,-1,0), o=new V();
  let piorAlt=0, amostras=0, voadores=0;
  for(let seg=0;seg<60;seg++){
    for(let f=0;f<60;f++){ ctx.progressao.update(1/60); ctx.ai.update(1/60); }
    for(const e of ctx.ai.getEnemies()){
      o.set(e.pos.x, e.pos.y+3, e.pos.z);
      const h=col.raycast(o,down,30);
      if(!h?.hit) continue;
      const alt=e.pos.y-h.point.y;
      amostras++;
      if(alt>piorAlt) piorAlt=alt;
      if(alt>0.6) voadores++;
    }
  }
  return {piorAlt:+piorAlt.toFixed(2), amostras, voadores};
});
console.log(`amostras de altura: ${r.amostras}`);
console.log(`maior altura acima do chao: ${r.piorAlt} m`);
console.log(`amostras acima de 0,6 m (voando): ${r.voadores}`);
console.log(r.voadores===0 ? '>>> ninguem voando' : '>>> AINDA VOA');
await b.close(); v.kill();
