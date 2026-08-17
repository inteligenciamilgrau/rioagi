import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5188;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx, col=ctx.world.collision;
  const V=ctx.camera.position.constructor;
  const pts=ctx.world.getSpawnPoints();
  const res=[];
  // Anda 8 m em 8 direcoes a partir de varios spawns; mede quanto avancou.
  for(const si of [0,3,5,7,9,11,13,15,17]){
    const p0=pts[si].position??pts[si];
    for(const a of [0,45,90,135,180,225,270,315]){
      const rad=a*Math.PI/180;
      const dx=-Math.sin(rad), dz=-Math.cos(rad);
      const pos=new V(p0.x,p0.y,p0.z);
      const start=new V(), end=new V();
      for(let i=0;i<12;i++){ start.copy(pos); end.set(pos.x,pos.y-0.06,pos.z);
        pos.copy(col.capsuleSweep(start,end,0.35,1.80).position); }
      const ini=pos.clone();
      const passo=4.3/60;   // velocidade de caminhada por quadro
      let travouEm=-1;
      for(let f=0;f<120;f++){
        start.copy(pos);
        end.set(pos.x+dx*passo, pos.y-0.06, pos.z+dz*passo);
        const sw=col.capsuleSweep(start,end,0.35,1.80);
        const avancou=Math.hypot(sw.position.x-pos.x, sw.position.z-pos.z);
        pos.copy(sw.position);
        if(avancou<passo*0.25 && travouEm<0) travouEm=f;
      }
      const dist=Math.hypot(pos.x-ini.x,pos.z-ini.z);
      res.push({spawn:si,ang:a,dist:+dist.toFixed(2),travouEm});
    }
  }
  const total=res.length;
  const livres=res.filter(x=>x.dist>6).length;
  const parciais=res.filter(x=>x.dist>1.5&&x.dist<=6).length;
  const travados=res.filter(x=>x.dist<=1.5).length;
  return {total,livres,parciais,travados,piores:res.filter(x=>x.dist<=1.5).slice(0,12)};
});
console.log(`percursos testados: ${r.total}  (andar 8,6 m em linha reta)`);
console.log(`  livres  (>6 m) : ${r.livres}`);
console.log(`  parciais       : ${r.parciais}`);
console.log(`  TRAVADOS (<1,5m): ${r.travados}`);
if(r.piores.length){console.log('\nexemplos travados:');for(const x of r.piores)console.log(`  spawn ${x.spawn} ang ${x.ang}°  andou ${x.dist} m  travou no quadro ${x.travouEm}`);}
await b.close(); vite.kill();
