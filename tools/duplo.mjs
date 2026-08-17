import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5194;
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
  const e=ctx.ai.spawn(P,0,null);
  const olho=new V(P.x,P.y+1.68,P.z+5);
  ctx.player.movement.teleport(olho.x,P.y+0.1,olho.z);
  for(let i=0;i<30;i++) ctx.ai.update(1/60);

  const log=[];
  const atirarEm=(alturaAlvo,rotulo)=>{
    const alvo=new V(P.x,P.y+alturaAlvo,P.z);
    const dir=alvo.clone().sub(olho).normalize();
    let tiros=0, ultima=null, mortos=[];
    for(let t=0;t<40;t++){
      const h=ctx.ai.raycastEnemies(olho,dir,60);
      if(!h){ ultima='sem alvo'; break; }
      tiros++;
      const antes=ctx.ai.getEnemies().length;
      ctx.ai.damageEnemy(h.enemyId,40,h.point,h.part,'ia2');
      ctx.ai.update(1/60);
      const dep=ctx.ai.getEnemies().length;
      if(dep<antes) mortos.push({tiro:tiros,id:h.enemyId,parte:h.part});
      ultima=h.part+' id'+h.enemyId;
      if(dep===0) break;
    }
    log.push(`${rotulo}: ${tiros} tiros, ultimoAcerto=${ultima}, mortesAqui=${JSON.stringify(mortos)}`);
    log.push(`   vivos agora=${ctx.ai.getEnemies().length}  naListaVivos=${ctx.ai.vivos.length}  poolAtivos=${ctx.ai.pool.filter(x=>x.ativo).length}`);
  };
  atirarEm(1.35,'MIRA NO PEITO');
  atirarEm(0.45,'MIRA NAS PERNAS');
  // o que ainda responde a raycast?
  const dirP=new V(P.x,P.y+0.45,P.z).sub(olho).normalize();
  const h2=ctx.ai.raycastEnemies(olho,dirP,60);
  log.push(`raycast nas pernas depois de tudo: ${h2?('ACERTA '+h2.part+' id'+h2.enemyId):'nao acerta nada'}`);
  const s=e.soldado;
  log.push(`morto=${e.morto} ativo=${e.ativo} malhaVisivel=${s.malha.visible} grupoVisivel=${s.grupo.visible} armaVisivel=${s.arma.visible}`);
  return log;
});
r.forEach(l=>console.log(l));
await b.close(); vite.kill();
