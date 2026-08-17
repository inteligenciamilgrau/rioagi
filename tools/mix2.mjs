import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5214;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.mouse.click(400,300);
await p.waitForTimeout(1800);
const r=await p.evaluate(async ()=>{
  const ctx=window.__game.ctx, A=ctx.audio;
  const esperar=(s)=>new Promise(r=>setTimeout(r,s*1000));
  // Analisador logo antes do limiter: mede o que REALMENTE sai.
  const an=A.actx.createAnalyser(); an.fftSize=2048;
  A.master.connect(an);
  const buf=new Float32Array(an.fftSize);
  const pico=async(seg)=>{ let m=0; const fim=performance.now()+seg*1000;
    while(performance.now()<fim){ an.getFloatTimeDomainData(buf);
      for(let i=0;i<buf.length;i++) m=Math.max(m,Math.abs(buf[i]));
      await new Promise(r=>setTimeout(r,16)); }
    return +m.toFixed(4); };
  const medir=async(rot)=>{
    // dispara uma rajada e mede o pico durante e DEPOIS (cauda de reverb)
    for(let i=0;i<5;i++){ A.tiro('fuzil', null, true); await esperar(0.09); }
    const durante=await pico(0.5);
    const cauda=await pico(2.2);   // so o eco
    return {rot, durante, cauda};
  };
  const out=[];
  ctx.settings.set('sfxVolume',1.0); ctx.settings.set('musicVolume',0); await esperar(0.5);
  out.push(await medir('efeitos 1.0'));
  ctx.settings.set('sfxVolume',0.0); await esperar(0.6);
  out.push(await medir('efeitos 0.0'));
  return out;
});
console.log('cenario       | pico durante | pico da cauda (eco)');
console.log('-'.repeat(52));
for(const o of r) console.log(`${o.rot.padEnd(13)} | ${String(o.durante).padStart(12)} | ${String(o.cauda).padStart(18)}`);
const mudo=r[1].durante<0.002 && r[1].cauda<0.002;
console.log(mudo ? '\n>>> com efeitos em 0 nao sai NADA, nem eco' : '\n>>> AINDA VAZA SOM');
await b.close(); vite.kill();
