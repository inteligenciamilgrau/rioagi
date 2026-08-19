/** O aquecimento de audio realmente assa os caches durante o boot? */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT=process.cwd(), PORT=Number(process.env.PORT??5282);
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b=await chromium.launch({headless:true,executablePath:process.env.PW_CHROME||undefined,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('PAGEERR:',String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__game?.ready,undefined,{timeout:240000});
await p.waitForTimeout(1500);
let falhas=0; const checa=(n,ok,d='')=>{console.log((ok?'  OK  ':' FALHA')+'  '+n+(d?'   '+d:''));if(!ok)falhas++;};
const r = await p.evaluate(async () => {
  const ctx = window.__game.ctx, A = ctx.audio;
  const chaves = [...A._bufs.keys()];
  // Quanto custa tocar um som cujo cache JA existe (deve ser trivial).
  await A.resume?.();
  const t0 = performance.now();
  for (let i=0;i<40;i++) A.tiro('fuzil', {x:0,y:0,z:0}, false);
  const custo40 = performance.now() - t0;
  return { assados: ctx.debug?.aquecimentoAudio ?? null, total: A._bufs.size, chaves: chaves.slice(0,6), custo40 };
});
console.log('');
console.log('=== aquecimento de audio no boot ===');
checa('assou caches durante o boot', (r.assados ?? 0) > 0, r.assados + ' chaves');
checa('ha caches prontos antes do primeiro tiro', r.total > 10, r.total + ' no total');
console.log('   exemplos: ' + r.chaves.join(', '));
checa('40 tiros com cache pronto custam pouco', r.custo40 < 15, r.custo40.toFixed(2) + ' ms para 40');
await b.close(); vite.kill();
console.log('');
console.log(falhas===0?'>>> OK':'>>> '+falhas+' FALHA(S)');
process.exit(falhas===0?0:1);
