import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5196;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:800}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='pausado';
  ctx.ai.spawnAutomatico=false;
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const P=sp.position??sp;
  const e=ctx.ai.spawn(P,Math.PI,null); window.__e=e;
  // faz ele ANDAR (estado de perseguicao) para reproduzir "pernas andando"
  e.percepcao.consciencia=1; e.percepcao.visivel=true; e._trocar('perseguir');
  e.vel.set(0,0,2.0);
  for(let i=0;i<45;i++) ctx.ai.update(1/60);
  ctx.camera.up.set(0,1,0);
  ctx.camera.position.set(P.x, P.y+1.25, P.z+3.4);
  ctx.camera.rotation.set(0,0,0,'YXZ'); ctx.camera.updateMatrixWorld(true);
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible=false;
});
const tira=async(n)=>{ await p.evaluate(()=>{const c=window.__game.ctx;c.menu?.hideAll?.();window.__game.settle(14);}); await p.waitForTimeout(200); await p.screenshot({path:`${ROOT}/shots/inimigo/${n}.png`}); console.log(' ->',n); };
await tira('w1-normal');
const info=await p.evaluate(()=>{
  const THREE=window.__game.ctx.camera.constructor;
  const s=window.__e.soldado;
  const antes=s.malha.material.side;
  // sem forcar DoubleSide: queremos ver o resultado da correcao de winding


  return {antes, mesmoMaterial: s.malha.material===s.arma.material};
});
console.log('side original =',info.antes,' (0=Front,1=Back,2=Double) · corpo e arma compartilham material:',info.mesmoMaterial);
await tira('w3-corrigido');
await b.close(); vite.kill();
