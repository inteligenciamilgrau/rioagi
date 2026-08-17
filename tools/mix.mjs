import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5212;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.mouse.click(400,300);
await p.waitForTimeout(2000);
const r=await p.evaluate(async ()=>{
  const ctx=window.__game.ctx, A=ctx.audio, M=ctx.musica;
  const esperar=(s)=>new Promise(r=>setTimeout(r,s*1000));
  // para onde cada barramento aponta
  const rota = {
    ambiente: A.busAmb.numberOfOutputs>0 ? 'busSfx' : '?',
  };
  const ler=()=>({master:+A.master.gain.value.toFixed(3), sfx:+A.busSfx.gain.value.toFixed(3),
                  mus:+A.busMus.gain.value.toFixed(3), amb:+A.busAmb.gain.value.toFixed(3),
                  faixaCalma:+M.faixas.calma.gain.gain.value.toFixed(3)});
  const out={inicial:ler()};
  ctx.settings.set('sfxVolume',0.2); await esperar(0.5); out.sfx20=ler();
  ctx.settings.set('sfxVolume',1.0); await esperar(0.5);
  ctx.settings.set('musicVolume',0.8); M.setQuality(); await esperar(0.5); out.mus80=ler();
  ctx.settings.set('masterVolume',0.3); await esperar(0.5); out.master30=ler();
  return {rota, out, sliders:[...document.querySelectorAll('#folha-config input[type=range]')].map(i=>i.dataset.cfg).filter(x=>/Volume/.test(x))};
});
console.log('sliders de audio no menu:', JSON.stringify(r.sliders));
console.log('\ncenario      | master |  sfx  | musica | ambiente | faixa');
console.log('-'.repeat(62));
for(const [k,v] of Object.entries(r.out))
  console.log(`${k.padEnd(12)} | ${String(v.master).padStart(6)} | ${String(v.sfx).padStart(5)} | ${String(v.mus).padStart(6)} | ${String(v.amb).padStart(8)} | ${String(v.faixaCalma).padStart(5)}`);
console.log('\nambiente pendurado no busSfx (ganho fixo 0.5, segue o slider de efeitos)');
await b.close(); vite.kill();
