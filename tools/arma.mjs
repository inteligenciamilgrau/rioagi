import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5204;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const vm=ctx.player.viewModel ?? ctx.player.vm ?? ctx.player._viewModel;
  if(!vm) return {erro:'ViewModel nao encontrado', chaves:Object.keys(ctx.player)};
  const grp = vm.grupo ?? vm.group ?? vm.root;
  if(!grp) return {erro:'grupo do viewmodel nao encontrado', chaves:Object.keys(vm)};
  const V=ctx.camera.position.constructor;
  const settle=(n)=>{ for(let i=0;i<n;i++){ ctx.player.update(1/60); } };
  settle(90);
  const p0=grp.position.clone(), r0=grp.rotation.clone();
  const amostras=[];
  for(let rajada=1; rajada<=6; rajada++){
    for(let t=0;t<10;t++){ ctx.player.debugFire?.(); settle(6); }
    settle(120);   // 2 s parado: deveria voltar ao repouso
    amostras.push({
      rajada, tiros:rajada*10,
      dPos:+grp.position.distanceTo(p0).toFixed(4),
      dRotX:+(grp.rotation.x-r0.x).toFixed(4),
      dRotY:+(grp.rotation.y-r0.y).toFixed(4),
      dRotZ:+(grp.rotation.z-r0.z).toFixed(4),
    });
  }
  return {repouso:[+p0.x.toFixed(3),+p0.y.toFixed(3),+p0.z.toFixed(3)], amostras};
});
if(r.erro){console.log(r.erro, JSON.stringify(r.chaves));}
else{
console.log('posicao de repouso do viewmodel:',JSON.stringify(r.repouso));
console.log('\napos cada rajada + 2 s parado (deveria voltar a ~0):');
console.log('tiros   desvio pos (m)   drot X      Y      Z');
for(const a of r.amostras) console.log(String(a.tiros).padStart(5), String(a.dPos).padStart(14), String(a.dRotX).padStart(10), String(a.dRotY).padStart(7), String(a.dRotZ).padStart(7));
}
await b.close(); vite.kill();
