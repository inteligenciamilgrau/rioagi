import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5201;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; const g=ctx.world.navGrid;
  if(!g) return {erro:'world.navGrid nao existe'};
  const chaves=Object.keys(g);
  const funcs=chaves.filter(k=>typeof g[k]==='function');
  const jog=ctx.player.position;
  // testa isWalkable com coordenadas de MUNDO e com CELULA
  let mundoOk=0, celOk=0, erroMundo=null, erroCel=null;
  try{ for(let a=0;a<24;a++){const ang=a/24*6.283;
    if(g.isWalkable(jog.x+Math.cos(ang)*12, jog.z+Math.sin(ang)*12)) mundoOk++; } }catch(e){erroMundo=String(e.message)}
  try{ const c=g.worldToCell? g.worldToCell(jog,{x:0,y:0}) : null;
    if(c) for(let a=0;a<24;a++){const ang=a/24*6.283;
      const i=Math.round(c.x+Math.cos(ang)*12/g.cellSize), j=Math.round((c.y??c.z)+Math.sin(ang)*12/g.cellSize);
      if(g.isWalkable(i,j)) celOk++; } }catch(e){erroCel=String(e.message)}
  // fracao andavel global
  let and=0; if(g.data) for(let i=0;i<g.data.length;i++) if(g.data[i]) and++;
  return {chaves, funcs, cellSize:g.cellSize, width:g.width, height:g.height,
    origin:g.origin?[g.origin.x,g.origin.z]:null,
    andavelPct:g.data?+(100*and/g.data.length).toFixed(1):null,
    mundoOk, celOk, erroMundo, erroCel};
});
console.log(JSON.stringify(r,null,2));
await b.close(); vite.kill();
