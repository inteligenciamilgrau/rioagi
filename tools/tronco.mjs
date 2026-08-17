import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5192;
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
  const e=ctx.ai.spawn(P,0,null); window.__e=e;
  ctx.player.movement.teleport(P.x, P.y+0.1, P.z+5);
  ctx.camera.up.set(0,1,0);
  ctx.camera.position.set(P.x,P.y+1.3,P.z+4.5);
  ctx.camera.rotation.set(0,0,0,'YXZ'); ctx.camera.updateMatrixWorld(true);
  e.percepcao.consciencia=1; e.percepcao.visivel=true; e._trocar('atirar');
  for(let i=0;i<40;i++) ctx.ai.update(1/60);
  const dump=(tag)=>{
    const s=e.soldado; s.grupo.updateMatrixWorld(true);
    const q=s.porNome.quadril, v=new V(), vq=new V();
    q.getWorldPosition(vq);
    const linhas=[];
    for(const nome of ['quadril','coluna1','coluna2','peito','pescoco','cabeca','ombro_D','cotovelo_D','punho_D','perna_D','joelho_D','tornozelo_D']){
      const bo=s.porNome[nome]; if(!bo){linhas.push(nome+': AUSENTE');continue;}
      bo.getWorldPosition(v);
      const ok=Number.isFinite(v.x+v.y+v.z);
      linhas.push(`${nome.padEnd(11)} ${ok?('y='+v.y.toFixed(2)+'  dQuadril='+v.distanceTo(vq).toFixed(2)+'m'):'NaN'}  escala=${bo.scale.x.toFixed(2)}`);
    }
    return {tag, linhas};
  };
  const antes=dump('VIVO');
  // mata com tiro na cabeca, como o usuario descreveu
  ctx.ai.damageEnemy(e.id, 500, e.pos.clone(), 'cabeca', 'ia2');
  ctx.ai.update(1/60);
  const d1=dump('MORTO 1 quadro');
  for(let i=0;i<30;i++) ctx.ai.update(1/60);
  const d2=dump('MORTO 30 quadros');
  for(let i=0;i<120;i++) ctx.ai.update(1/60);
  const d3=dump('MORTO 150 quadros');
  return {antes,d1,d2,d3};
});
for(const d of [r.antes,r.d1,r.d2,r.d3]){ console.log('--- '+d.tag+' ---'); d.linhas.forEach(l=>console.log('  '+l)); }
await p.evaluate(()=>{const c=window.__game.ctx;c.menu?.hideAll?.();c.hud?.setVisible?.(false);c.viewScene.visible=false;window.__game.settle(14);});
await p.screenshot({path:ROOT+'/shots/inimigo/tronco.png'});
await b.close(); vite.kill();
