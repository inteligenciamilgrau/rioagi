import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5207;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:900,height:650}});
const logs=[];
p.on('console',m=>{const t=m.text(); if(/Itens|item/i.test(t)) logs.push(t.slice(0,90));});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const V=ctx.camera.position.constructor;
  const P=ctx.pickups;
  const fixos=P.estatisticas();
  // mata um inimigo e ve se dropa
  ctx.bus.emit('game:start',{});
  const e=ctx.ai.getEnemies()[0];
  const antesDrop=P.estatisticas().ativos;
  ctx.ai.damageEnemy(e.id,500,e.pos.clone(),'torso','ia2');
  for(let i=0;i<10;i++){ctx.ai.update(1/60); P.update(1/60);}
  const depoisDrop=P.estatisticas().ativos;
  // gasta municao e vida, depois anda ate o drop
  const ws=ctx.player.weapons;
  for(const s of ws.slots){ s.reserve=0; }
  ctx.player.health=40;
  const item=P.itens.find(i=>i.ativo && !i.fixo);
  const reservaAntes=ws.slots.reduce((a,s)=>a+s.reserve,0);
  const vidaAntes=ctx.player.health;
  if(item) ctx.player.movement.teleport(item.base.x, item.base.y-0.1, item.base.z);
  for(let i=0;i<30;i++){ ctx.player.update(1/60); P.update(1/60); }
  return {
    fixosNoBoot:fixos.ativos, antesDrop, depoisDrop,
    reservaAntes, reservaDepois: ws.slots.reduce((a,s)=>a+s.reserve,0),
    vidaAntes, vidaDepois: Math.round(ctx.player.health),
    aindaAtivos: P.estatisticas().ativos,
  };
});
console.log('itens fixos no boot   :', r.fixosNoBoot);
console.log('drop ao matar         :', r.antesDrop, '->', r.depoisDrop);
console.log('reserva de municao    :', r.reservaAntes, '->', r.reservaDepois);
console.log('vida                  :', r.vidaAntes, '->', r.vidaDepois);
console.log('itens ativos no fim   :', r.aindaAtivos);
if(logs.length) console.log('\nlog:',[...new Set(logs)].slice(0,3));
await b.close(); vite.kill();
