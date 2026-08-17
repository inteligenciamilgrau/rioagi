import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5186;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('ERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
const r=await p.evaluate(()=>{
  const lib=window.__game.ctx.materials; const out=[];
  for(const nome of ['terra','concreto','concreto_liso','madeira','azulejo','tijolo','asfalto','grama','calcada_portuguesa','reboco']){
    const m=lib.get(nome); const d=m?.map?.image?.data;
    if(!d){out.push({nome,erro:'sem dados'});continue;}
    let R=0,G=0,B=0; const n=d.length/4;
    for(let i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];}
    out.push({nome,r:Math.round(R/n),g:Math.round(G/n),b:Math.round(B/n),
      hex:'#'+[R,G,B].map(v=>Math.round(v/n).toString(16).padStart(2,'0')).join('')});
  }
  return out;
});
console.log('material              R    G    B   hex       leitura');
console.log('-'.repeat(62));
for(const m of r){
  if(m.erro){console.log(m.nome.padEnd(20),m.erro);continue;}
  const quente = m.r>m.b+12 ? 'quente (marrom/laranja)' : (m.b>m.r+12 ? 'FRIO (azulado)' : 'neutro (cinza)');
  console.log(m.nome.padEnd(20),String(m.r).padStart(4),String(m.g).padStart(4),String(m.b).padStart(4),' ',m.hex,' ',quente);
}
await b.close(); vite.kill();
