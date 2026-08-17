import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT=process.cwd(), PORT=5215;
const vite=spawn(process.execPath,[ROOT+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{let o='';const h=d=>{o+=d;if(/ready in/.test(o))r()};vite.stdout.on('data',h);vite.stderr.on('data',h);setTimeout(()=>j(new Error('t/o')),40000)});
const b=await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,{timeout:180000});
await p.waitForTimeout(1500);
const r=await p.evaluate(async ()=>{
  const ctx=window.__game.ctx; ctx.state='jogando';
  const ws=ctx.player.weapons;
  ws.switchTo(1);                       // slot da sniper
  for(let i=0;i<90;i++) ctx.player.update(1/60);
  const def=ws.slot.def;
  const tri=ctx.player.viewModel?.getTriangleReport?.();
  ctx.player.forceADS?.(true);
  for(let i=0;i<70;i++) ctx.player.update(1/60);
  ctx.hud.update(1/60);
  const lunetaAds=document.querySelector('.hud-luneta')?.classList.contains('ativa');
  const miraSumiu=getComputedStyle(document.querySelector('.hud-mira')).opacity;
  ctx.player.forceADS?.(false);
  for(let i=0;i<70;i++) ctx.player.update(1/60);
  ctx.hud.update(1/60);
  const lunetaQuadril=document.querySelector('.hud-luneta')?.classList.contains('ativa');
  return {nome:def.name, dano:def.damage, pente:def.magSize, rpm:def.rpm,
    zoom:def.adsFovDelta, spreadAds:def.spreadADS, penetra:def.penetration,
    lunetaAds, lunetaQuadril, miraSumiu:+miraSumiu, tri};
});
console.log(`arma: ${r.nome}`);
console.log(`  dano ${r.dano} | pente ${r.pente} | ${r.rpm} rpm | zoom ${r.zoom}deg | spread ADS ${r.spreadAds} | penetracao ${r.penetra}`);
console.log(`  luneta em ADS: ${r.lunetaAds}   | no quadril: ${r.lunetaQuadril}`);
console.log(`  mira normal em ADS (opacidade): ${r.miraSumiu}`);
if(r.tri) console.log('  triangulos:', JSON.stringify(r.tri).slice(0,120));
await p.evaluate(()=>{const c=window.__game.ctx; c.menu?.hideAll?.(); c.player.forceADS?.(true);
  for(let i=0;i<80;i++) c.player.update(1/60); c.hud.update(1/60); window.__game.settle(14);});
await p.waitForTimeout(400);
await p.screenshot({path:ROOT+'/shots/sniper-ads.png'});
await b.close(); vite.kill();
