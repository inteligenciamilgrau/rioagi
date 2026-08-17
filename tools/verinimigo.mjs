import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5191;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:900,height:700}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
 await p.waitForTimeout(1500);
await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='pausado';
  ctx.hud?.setVisible?.(false); ctx.menu?.hideAll?.(); ctx.viewScene.visible=false;
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const P=sp.position??sp;
  ctx.ai.spawnAutomatico=false;
  const e=ctx.ai.spawn(P, 0, null);
  window.__e=e;
  // camera a 4 m de frente, na altura do peito
  ctx.camera.up.set(0,1,0);
  ctx.camera.position.set(P.x, P.y+1.2, P.z+4.2);
  ctx.camera.rotation.set(0,0,0,'YXZ');
  ctx.camera.updateMatrixWorld(true);
  e.percepcao.consciencia=1; e.percepcao.visivel=true; e._trocar('atirar');
});
const passo=async(nome,fn)=>{
  await p.evaluate(fn);
  await p.evaluate(()=>{const c=window.__game.ctx;c.menu?.hideAll?.();c.hud?.setVisible?.(false);c.viewScene.visible=false;window.__game.settle(14);});
  await p.waitForTimeout(200);
  await p.screenshot({path:`${ROOT}/shots/inimigo/${nome}.png`});
  console.log('  ->',nome);
};
await passo('1-vivo',()=>{ for(let i=0;i<30;i++) window.__game.ctx.ai.update(1/60); });
await passo('2-dano-parcial',()=>{ const e=window.__e; for(let i=0;i<4;i++){e.levarDano(15,e.pos.clone(),'torso',{x:0,y:0,z:-1}); window.__game.ctx.ai.update(1/60);} });
await passo('3-morto-1q',()=>{ const e=window.__e; e.levarDano(500,e.pos.clone(),'torso',{x:0,y:0,z:-1}); window.__game.ctx.ai.update(1/60); });
await passo('4-morto-20q',()=>{ for(let i=0;i<20;i++) window.__game.ctx.ai.update(1/60); });
await passo('5-morto-90q',()=>{ for(let i=0;i<70;i++) window.__game.ctx.ai.update(1/60); });
console.log('ok');
await b.close(); vite.kill();
