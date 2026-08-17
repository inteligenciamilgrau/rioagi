import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5216;
const v=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};v.stdout.on('data',h);v.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  ctx.bus.emit('game:start',{});
  const G=ctx.progressao, jog=ctx.player.position;
  const linhas=[];
  for(let seg=1;seg<=40;seg++){
    for(let f=0;f<60;f++){ G.update(1/60); ctx.ai.update(1/60); }
    if(seg%8===0){
      const vivos=ctx.ai.getEnemies();
      const ds=vivos.map(e=>e.pos.distanceTo(jog)).sort((a,b)=>a-b);
      const parados=vivos.filter(e=>e.estado==='ocioso').length;
      linhas.push(`t=${String(seg).padStart(2)}s onda ${G.onda} | vivos ${vivos.length} | ociosos ${parados} | dist min ${ds.length?ds[0].toFixed(0):'-'}m med ${ds.length?(ds.reduce((a,c)=>a+c,0)/ds.length).toFixed(0):'-'}m`);
    }
  }
  return linhas;
});
r.forEach(l=>console.log(l));
await b.close(); v.kill();
