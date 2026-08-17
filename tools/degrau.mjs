import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5189;
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
  const baixos=[], altos=[]; let travas=0;
  const down=new V(0,-1,0);
  for(const si of [0,1,3,5,7,9,11,13,15,17]){
   for(const a of [0,30,60,90,120,150,180,210,240,270,300,330]){
    const rad=a*Math.PI/180, dx=-Math.sin(rad), dz=-Math.cos(rad);
    const p0=pts[si].position??pts[si];
    const pos=new V(p0.x,p0.y,p0.z), start=new V(), end=new V();
    for(let i=0;i<12;i++){start.copy(pos);end.set(pos.x,pos.y-0.06,pos.z);pos.copy(col.capsuleSweep(start,end,0.35,1.80).position);}
    const passo=4.3/60;
    for(let f=0;f<120;f++){
      start.copy(pos); end.set(pos.x+dx*passo,pos.y-0.06,pos.z+dz*passo);
      const sw=col.capsuleSweep(start,end,0.35,1.80);
      const av=Math.hypot(sw.position.x-pos.x,sw.position.z-pos.z);
      if(av<passo*0.25){
        // travou: mede a altura do topo do obstaculo a 0,6 m a frente
        travas++;
        const ox=pos.x+dx*0.6, oz=pos.z+dz*0.6;
        const o=new V(ox,pos.y+2.5,oz);
        const h=col.raycast(o,down,4.0);
        if(h.hit){ const alt=h.point.y-pos.y;
          if(alt<0.45 && alt>-0.2) baixos.push({spawn:si,ang:a,alt:+alt.toFixed(2),sup:h.surface});
          else altos.push(+alt.toFixed(2)); }
        break;
      }
      pos.copy(sw.position);
    }
   }
  }
  return {travas, baixos:baixos.slice(0,20), nBaixos:baixos.length, nAltos:altos.length};
});
console.log(`bloqueios encontrados: ${r.travas}`);
console.log(`  obstaculo ALTO (parede legitima) : ${r.nAltos}`);
console.log(`  obstaculo BAIXO (<45cm = BUG)    : ${r.nBaixos}`);
if(r.baixos.length){console.log('\nbloqueios indevidos:');for(const x of r.baixos)console.log(`  spawn ${x.spawn} ang ${x.ang}°  altura ${x.alt} m  superficie ${x.sup}`);}
await b.close(); vite.kill();
