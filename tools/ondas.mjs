import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5195;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const linhas=[]; let piorSep=Infinity;
  for(let seg=0;seg<40;seg++){
    for(let f=0;f<60;f++) ctx.ai.update(1/60);
    const vivos=ctx.ai.getEnemies();
    // menor distancia entre dois vivos
    for(let i=0;i<vivos.length;i++)for(let j=i+1;j<vivos.length;j++){
      const d=vivos[i].pos.distanceTo(vivos[j].pos);
      if(d<piorSep) piorSep=d;
    }
    if(seg%8===0) linhas.push(`  t=${seg}s  vivos=${vivos.length}  naLista=${ctx.ai.vivos.length}  poolAtivos=${ctx.ai.pool.filter(x=>x.ativo).length}`);
  }
  return {linhas, piorSep:+piorSep.toFixed(2), pool:ctx.ai.pool.length};
});
console.log('40 s de simulacao com ondas ligadas:');
r.linhas.forEach(l=>console.log(l));
console.log(`\nmenor distancia ja observada entre dois inimigos: ${r.piorSep} m  (minimo pedido: 7 m)`);
console.log(`tamanho do pool: ${r.pool}`);
await b.close(); vite.kill();
