import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5203;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:900,height:650}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  ctx.bus.emit('game:start',{});
  ctx.etiquetas.ativo=true;
  const e=ctx.ai.getEnemies()[0];
  if(!e) return {erro:'sem inimigo'};
  for(let i=0;i<30;i++){ctx.ai.update(1/60); ctx.etiquetas.update();}
  // camera olhando o inimigo
  const j=ctx.player.position;
  ctx.camera.up.set(0,1,0);
  ctx.camera.position.set(j.x,j.y+1.68,j.z);
  ctx.camera.lookAt(e.pos.x,e.pos.y+1.2,e.pos.z);
  ctx.camera.updateMatrixWorld(true);
  ctx.menu?.hideAll?.(); ctx.viewScene.visible=false;
  window.__game.settle(14);
  return {dist:+e.pos.distanceTo(j).toFixed(1), id:e.id, estado:e.estado, temEtiqueta:ctx.etiquetas.pool.length};
});
console.log(JSON.stringify(r));
await p.waitForTimeout(300);
await p.screenshot({path:ROOT+'/shots/inimigo/etiquetas.png'});
await b.close(); vite.kill();
