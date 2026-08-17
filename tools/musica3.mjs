import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5211;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
// SEM --autoplay-policy: politica real, autoplay bloqueado ate haver gesto
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(2000);
const antes=await p.evaluate(()=>{
  const M=window.__game.ctx.musica;
  return {ligado:M._ligado, pausadoAcao:M.faixas.acao.el.paused, pausadoCalma:M.faixas.calma.el.paused};
});
console.log('ANTES de qualquer gesto (autoplay bloqueado):');
console.log('  _ligado =', antes.ligado, '| faixas pausadas:', antes.pausadoAcao, antes.pausadoCalma);
// gesto real do usuario
await p.mouse.click(400, 300);
await p.waitForTimeout(1800);
const depois=await p.evaluate(()=>{
  const M=window.__game.ctx.musica, ctx=window.__game.ctx;
  return {ligado:M._ligado, pausadoAcao:M.faixas.acao.el.paused, pausadoCalma:M.faixas.calma.el.paused,
    tempoCalma:+M.faixas.calma.el.currentTime.toFixed(2),
    ganhoCalma:+M.faixas.calma.gain.gain.value.toFixed(3),
    ganhoAcao:+M.faixas.acao.gain.gain.value.toFixed(3),
    estado:ctx.state, actx:ctx.audio?.actx?.state};
});
console.log('\nDEPOIS de um clique:');
console.log('  _ligado =', depois.ligado, '| faixas pausadas:', depois.pausadoAcao, depois.pausadoCalma);
console.log('  AudioContext:', depois.actx, '| estado do jogo:', depois.estado);
console.log('  tempo tocado da calma:', depois.tempoCalma, 's');
console.log('  ganhos -> calma', depois.ganhoCalma, '| acao', depois.ganhoAcao);
console.log(depois.ligado && depois.tempoCalma>0 ? '\n>>> MUSICA TOCANDO' : '\n>>> AINDA MUDA');
await b.close(); vite.kill();
