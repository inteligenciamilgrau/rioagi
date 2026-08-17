import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5200;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx;
  const jog=ctx.player.position.clone();
  const pts=ctx.world.getSpawnPoints();
  const dists=pts.map(s=>+((s.position??s).distanceTo(jog)).toFixed(1)).sort((a,b)=>a-b);
  const temMetodo = typeof ctx.ai.spawnPerto === 'function';
  // simula o clique em JOGAR
  ctx.state='jogando';
  ctx.bus.emit('game:start',{});
  const vivos=ctx.ai.getEnemies();
  const dv=vivos.map(e=>+e.pos.distanceTo(jog).toFixed(1));
  return {jog:[+jog.x.toFixed(1),+jog.y.toFixed(1),+jog.z.toFixed(1)],
    temMetodo, distanciasSpawn:dists.slice(0,8), vivos:vivos.length, distVivos:dv};
});
console.log('spawnPerto existe?          ', r.temMetodo);
console.log('jogador em                 ', JSON.stringify(r.jog));
console.log('8 spawns mais proximos (m) ', JSON.stringify(r.distanciasSpawn));
console.log('inimigos apos game:start   ', r.vivos, ' distancias:', JSON.stringify(r.distVivos));
await b.close(); vite.kill();
