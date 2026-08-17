import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5193;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:900,height:700}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const V=ctx.camera.position.constructor;
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const P=sp.position??sp;
  // 4 inimigos lado a lado, MESMA variante forcada para 2 deles
  const es=[];
  for(let i=0;i<4;i++){
    const e=ctx.ai.spawn({x:P.x+i*1.6,y:P.y,z:P.z},0,null);
    if(e){ e.percepcao.consciencia=1; e.percepcao.visivel=true; e._trocar('atirar'); es.push(e); }
  }
  ctx.player.movement.teleport(P.x+2.4,P.y+0.1,P.z+7);
  ctx.camera.up.set(0,1,0);
  ctx.camera.position.set(P.x+2.4,P.y+1.5,P.z+7);
  ctx.camera.rotation.set(0,0,0,'YXZ'); ctx.camera.updateMatrixWorld(true);
  for(let i=0;i<40;i++) ctx.ai.update(1/60);
  const estado=(tag)=>{
    const out=[];
    for(const e of es){
      const s=e.soldado; s.grupo.updateMatrixWorld(true);
      const vq=new V(), vp=new V();
      s.porNome.quadril.getWorldPosition(vq);
      s.porNome.peito.getWorldPosition(vp);
      out.push(`  var${e.soldado.variante} id${e.id} ${e.morto?'MORTO':'vivo '} quadrilY=${vq.y.toFixed(2)} peitoY=${vp.y.toFixed(2)} dQP=${vp.distanceTo(vq).toFixed(2)}m vis=${s.grupo.visible?'S':'N'}`);
    }
    return {tag,out};
  };
  const a=estado('4 VIVOS');
  // mata SO o primeiro
  ctx.ai.damageEnemy(es[0].id, 500, es[0].pos.clone(), 'cabeca', 'ia2');
  for(let i=0;i<60;i++) ctx.ai.update(1/60);
  const c=estado('1 morto, 3 vivos (60q)');
  return {variantes:es.map(e=>e.soldado.variante), a, c};
});
console.log('variantes dos 4:',JSON.stringify(r.variantes));
for(const d of [r.a,r.c]){ console.log('--- '+d.tag+' ---'); d.out.forEach(l=>console.log(l)); }
await p.evaluate(()=>{const c=window.__game.ctx;c.menu?.hideAll?.();c.hud?.setVisible?.(false);c.viewScene.visible=false;window.__game.settle(14);});
await p.screenshot({path:ROOT+'/shots/inimigo/varios.png'});
await b.close(); vite.kill();
