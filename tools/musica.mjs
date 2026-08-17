import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5209;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']});
const p=await b.newPage({viewport:{width:640,height:360}});
const logs=[]; p.on('console',m=>{const t=m.text(); if(/Musica/i.test(t)) logs.push(t.slice(0,140));});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(3000);
const r=await p.evaluate(()=>{
  const M=window.__game.ctx.musica;
  const st=(n)=>{const f=M.faixas[n]; return f?{ok:f.ok, dur:+(f.el.duration||0).toFixed(1)}:null;};
  return {pronta:M.pronta, acao:st('acao'), calma:st('calma')};
});
console.log('  sistema pronto :', r.pronta);
console.log('  becoemchamas   :', JSON.stringify(r.acao));
console.log('  tensaonoar     :', JSON.stringify(r.calma));
if(logs.length) console.log('  log:', logs[0]);
// HTTP das faixas
for(const f of ['becoemchamas.mp3','tensaonoar.mp3']){
  const res=await p.evaluate(u=>fetch(u).then(r=>r.status), '/audio/musica/'+f);
  console.log(`  HTTP ${f}: ${res}`);
}
await b.close(); vite.kill();
