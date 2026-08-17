import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5208;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:600}});
let erros=0; p.on('pageerror',()=>erros++);
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const G=ctx.progressao;
  ctx.bus.emit('game:start',{});
  const linhas=[]; let ondaAnt=0;
  // simula 8 ondas: mata tudo que aparece
  for(let seg=0; seg<900; seg++){
    for(let f=0;f<10;f++){ G.update(1/60); ctx.ai.update(1/60); }
    for(const e of ctx.ai.getEnemies()) ctx.ai.damageEnemy(e.id,500,e.pos.clone(),'torso','ia2');
    if(G.onda!==ondaAnt && G.onda>0){
      ondaAnt=G.onda;
      const perf=G.perfilDaOnda(G.onda);
      linhas.push(`onda ${String(G.onda).padStart(2)} | meta ${String(G.meta).padStart(2)} | simult ${G.simultaneosDaOnda(G.onda)} | ${G.rotuloDificuldade.padEnd(11)} | reacao ${perf.reacao[0].toFixed(2)}-${perf.reacao[1].toFixed(2)}s | erroMin ${perf.erroMin.toFixed(4)} | dano ${perf.dano.toFixed(1)}`);
    }
    if(G.onda>=10) break;
  }
  return {linhas, totais:G.abatesTotais, itens:ctx.pickups.estatisticas()};
});
console.log('onda | meta | simultaneos | dificuldade | reacao IA | precisao | dano');
console.log('-'.repeat(100));
r.linhas.forEach(l=>console.log(l));
console.log(`\nabates totais na simulacao: ${r.totais}`);
console.log(`itens em campo: ${JSON.stringify(r.itens)}`);
console.log(`erros de pagina: ${erros}`);
await b.close(); vite.kill();
