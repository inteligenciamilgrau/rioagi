import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5218;
const v=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};v.stdout.on('data',h);v.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.mouse.click(400,300); await p.waitForTimeout(1500);
const r=await p.evaluate(async ()=>{
  const ctx=window.__game.ctx, A=ctx.audio;
  const esperar=(s)=>new Promise(r=>setTimeout(r,s*1000));
  const an=A.actx.createAnalyser(); an.fftSize=2048; A.master.connect(an);
  const buf=new Float32Array(an.fftSize);
  const pico=async(seg)=>{let m=0;const fim=performance.now()+seg*1000;
    while(performance.now()<fim){an.getFloatTimeDomainData(buf);
      for(let i=0;i<buf.length;i++)m=Math.max(m,Math.abs(buf[i]));
      await new Promise(r=>setTimeout(r,16));} return +m.toFixed(4);};
  ctx.settings.set('musicVolume',0); ctx.settings.set('sfxVolume',1); await esperar(0.6);
  const silencio=await pico(0.5);
  const out={silencio};
  for(const fase of ['start','magout','magin','end']){
    A.recarga(fase);
    out[fase]=await pico(0.45);
  }
  return out;
});
console.log('silêncio de referência:', r.silencio);
for(const f of ['start','magout','magin','end']) console.log(`  fase ${f.padEnd(7)} pico ${r[f]}`);
const ok=['start','magout','magin','end'].every(f=>r[f]>r.silencio+0.004);
console.log(ok?'\n>>> todas as fases produzem som':'\n>>> ALGUMA FASE MUDA');
await b.close(); v.kill();
