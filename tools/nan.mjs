import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5206;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:600}});
const avisos=[];
p.on('console',m=>{const t=m.text(); if(/Ragdoll|NaN/i.test(t)) avisos.push(t.slice(0,120));});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const V=ctx.camera.position.constructor;
  ctx.bus.emit('game:start',{});
  const alvos=[];
  const checar=()=>{
    const out=[];
    for(const e of ctx.ai.pool){ if(!e.ativo) continue;
      const s=e.soldado; s.grupo.updateMatrixWorld(true);
      const vq=new V(), vc=new V();
      s.porNome.quadril.getWorldPosition(vq); s.porNome.cabeca.getWorldPosition(vc);
      out.push({id:e.id, morto:e.morto,
        quadrilOk:Number.isFinite(vq.x+vq.y+vq.z),
        cabecaOk:Number.isFinite(vc.x+vc.y+vc.z),
        dQC:+vc.distanceTo(vq).toFixed(2)});
    }
    return out;
  };
  // mata pelo caminho real: raycast + damageEnemy
  const olho=ctx.player.eyePosition.clone();
  const e0=ctx.ai.getEnemies()[0];
  if(!e0) return {erro:'sem inimigo'};
  const dir=e0.pos.clone().setY(e0.pos.y+1.2).sub(olho).normalize();
  let tiros=0;
  for(let t=0;t<40;t++){
    const h=ctx.ai.raycastEnemies(olho,dir,60);
    if(!h) break;
    ctx.ai.damageEnemy(h.enemyId,40,h.point,h.part,'ia2'); tiros++;
    for(let f=0;f<4;f++) ctx.ai.update(1/60);
    if(!ctx.ai.getEnemies().length) break;
  }
  const logo=checar();
  for(let f=0;f<200;f++) ctx.ai.update(1/60);
  const depois=checar();
  return {tiros, logo, depois};
});
if(r.erro){console.log(r.erro);}else{
console.log(`matou em ${r.tiros} tiros\n`);
const mostra=(t,l)=>{console.log('--- '+t+' ---');
  for(const x of l) console.log(`  #${x.id} ${x.morto?'MORTO':'vivo '} quadrilOk=${x.quadrilOk} cabecaOk=${x.cabecaOk} dQC=${x.dQC}`);};
mostra('logo apos a morte', r.logo);
mostra('200 quadros depois', r.depois);
const ruim=[...r.logo,...r.depois].some(x=>!x.cabecaOk||!x.quadrilOk);
console.log(ruim?'\n>>> AINDA HA NaN':'\n>>> NENHUM NaN — corpo integro');}
if(avisos.length) console.log('\navisos do Ragdoll:',[...new Set(avisos)].slice(0,3));
await b.close(); vite.kill();
