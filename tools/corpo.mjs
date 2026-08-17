import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5197;
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
  const pts=ctx.world.getSpawnPoints(); const sp=pts[9]; const P=sp.position??sp;
  const e=ctx.ai.spawn(P,0,null); window.__e=e; window.__P=P;
  ctx.player.movement.teleport(P.x,P.y+0.1,P.z+6);
  for(let i=0;i<40;i++) ctx.ai.update(1/60);
  ctx.ai.damageEnemy(e.id,500,e.pos.clone(),'torso','ia2');
  for(let i=0;i<150;i++) ctx.ai.update(1/60);
  // mede a extensao real do corpo assentado
  const s=e.soldado; s.grupo.updateMatrixWorld(true);
  const v=new V(); let minY=1e9,maxY=-1e9,minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
  const dist={};
  const q=new V(); s.porNome.quadril.getWorldPosition(q);
  for(const bo of s.ossos){ bo.getWorldPosition(v);
    minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);
    minX=Math.min(minX,v.x);maxX=Math.max(maxX,v.x);
    minZ=Math.min(minZ,v.z);maxZ=Math.max(maxZ,v.z);
    dist[bo.name]=+v.distanceTo(q).toFixed(2); }
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible=false;
  return {ext:{x:+(maxX-minX).toFixed(2),y:+(maxY-minY).toFixed(2),z:+(maxZ-minZ).toFixed(2)},
    dist, centro:[(minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2]};
});
console.log('extensao do corpo assentado (m):',JSON.stringify(r.ext));
console.log('  um corpo deitado deveria medir ~1,8 m no maior eixo\n');
const ord=Object.entries(r.dist).sort((a,b)=>b[1]-a[1]).slice(0,8);
console.log('ossos mais distantes do quadril:');
for(const [n,d] of ord) console.log(`  ${n.padEnd(12)} ${d} m`);
// camera de perto, de lado
await p.evaluate((c)=>{const ctx=window.__game.ctx;
  ctx.camera.up.set(0,1,0);
  ctx.camera.position.set(c[0]+2.6,c[1]+1.1,c[2]+2.6);
  ctx.camera.lookAt(c[0],c[1],c[2]); ctx.camera.updateMatrixWorld(true);
  ctx.menu?.hideAll?.(); window.__game.settle(14);}, r.centro);
await p.waitForTimeout(250);
await p.screenshot({path:ROOT+'/shots/inimigo/corpo-perto.png'});
await b.close(); vite.kill();
