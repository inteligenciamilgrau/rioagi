import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5202;
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
  ctx.bus.emit('game:start',{});
  const e=ctx.ai.getEnemies()[0];
  if(!e) return {erro:'sem inimigo'};
  const jog=ctx.player.position;
  const antes=jog.clone(); const camA=ctx.camera.position.clone();
  const log=[]; const tempos=[];
  const passo=()=>{ const t0=performance.now();
    ctx.ai.update(1/60); ctx.player.update(1/60); ctx.fx?.update?.(1/60,0); ctx.engine.render();
    return performance.now()-t0; };
  for(let i=0;i<20;i++) tempos.push(passo());
  const base=tempos.slice(5).reduce((a,c)=>a+c,0)/15;
  // mata
  const tMorte=[];
  ctx.ai.damageEnemy(e.id,500,e.pos.clone(),'torso','ia2');
  for(let i=0;i<25;i++) tMorte.push(passo());
  const depois=ctx.player.position.clone(); const camD=ctx.camera.position.clone();
  const pico=Math.max(...tMorte);
  return {
    base:+base.toFixed(2), pico:+pico.toFixed(2), fator:+(pico/base).toFixed(1),
    perfil:tMorte.slice(0,10).map(x=>+x.toFixed(1)),
    jogadorMoveu:+antes.distanceTo(depois).toFixed(3),
    cameraMoveu:+camA.distanceTo(camD).toFixed(3),
    posAntes:[+antes.x.toFixed(1),+antes.y.toFixed(1),+antes.z.toFixed(1)],
    posDepois:[+depois.x.toFixed(1),+depois.y.toFixed(1),+depois.z.toFixed(1)],
  };
});
if(r.erro){console.log(r.erro);}else{
console.log(`quadro normal: ${r.base} ms   pico apos a morte: ${r.pico} ms  (${r.fator}x)`);
console.log('perfil dos 10 quadros apos a morte (ms):',JSON.stringify(r.perfil));
console.log(`jogador moveu: ${r.jogadorMoveu} m   camera moveu: ${r.cameraMoveu} m`);
console.log(`pos antes ${JSON.stringify(r.posAntes)} -> depois ${JSON.stringify(r.posDepois)}`);}
await b.close(); vite.kill();
