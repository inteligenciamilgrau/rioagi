import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5205;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const rig=ctx.player.rig;
  const V=ctx.camera.position.constructor;
  const passo=()=>{const t0=performance.now();
    ctx.player.update(1/60); ctx.hud?.update?.(1/60); ctx.engine.render();
    return performance.now()-t0;};
  for(let i=0;i<120;i++) passo();     // assenta
  const olhoA=ctx.player.eyePosition.clone();
  const camA=ctx.camera.position.clone();
  const offA=camA.clone().sub(olhoA);
  const pitA=rig.pitch, yawA=rig.yaw;
  const base=[]; for(let i=0;i<30;i++) base.push(passo());
  const mBase=base.reduce((a,c)=>a+c,0)/base.length;

  // rajada de dano como o inimigo faz (10 acertos/s por 2 s)
  const t=[]; let pior=0, piorEm=-1;
  const dir=new V(0,0,1);
  for(let i=0;i<20;i++){
    ctx.player.takeDamage(6, dir);
    for(let f=0;f<6;f++){ const ms=passo(); t.push(ms); if(ms>pior){pior=ms;piorEm=i;} }
  }
  for(let i=0;i<180;i++) passo();     // 3 s de calma
  const olhoD=ctx.player.eyePosition.clone();
  const camD=ctx.camera.position.clone();
  const offD=camD.clone().sub(olhoD);
  return {
    mBase:+mBase.toFixed(2), pico:+pior.toFixed(2), fator:+(pior/mBase).toFixed(1), piorNoAcerto:piorEm,
    perfil:t.slice(0,14).map(x=>+x.toFixed(1)),
    offsetAntes:[+offA.x.toFixed(4),+offA.y.toFixed(4),+offA.z.toFixed(4)],
    offsetDepois:[+offD.x.toFixed(4),+offD.y.toFixed(4),+offD.z.toFixed(4)],
    driftOffset:+offA.distanceTo(offD).toFixed(4),
    dPitch:+(rig.pitch-pitA).toFixed(5), dYaw:+(rig.yaw-yawA).toFixed(5),
    trauma:+rig.trauma.toFixed(4), vida:Math.round(ctx.player.health),
  };
});
console.log(`quadro base ${r.mBase} ms  ·  pico durante o dano ${r.pico} ms (${r.fator}x, no acerto #${r.piorNoAcerto})`);
console.log('perfil (ms):',JSON.stringify(r.perfil));
console.log(`\noffset camera-olho antes  ${JSON.stringify(r.offsetAntes)}`);
console.log(`offset camera-olho depois ${JSON.stringify(r.offsetDepois)}`);
console.log(`DESVIO do offset apos 3 s de calma: ${r.driftOffset} m  (deveria ser ~0)`);
console.log(`desvio de pitch ${r.dPitch} rad · yaw ${r.dYaw} rad · trauma residual ${r.trauma} · vida ${r.vida}`);
await b.close(); vite.kill();
