/** Mede ONDE o item cai quando um inimigo morre, em relacao ao chao. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5274);
const vite = spawn(process.execPath, [ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], {cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({headless:true, executablePath:process.env.PW_CHROME||undefined, args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:'load', timeout:120000});
await p.waitForFunction(()=>window.__game?.ready, undefined, {timeout:240000});
await p.waitForTimeout(1200);

const r = await p.evaluate(() => {
  const ctx = window.__game.ctx, pk = ctx.pickups, col = ctx.world.collision;
  ctx.state = 'jogando';
  const casos = [];
  const alturas = { cabeca: 1.72, torso: 1.15, pernas: 0.45 };
  for (const [parte, hy] of Object.entries(alturas)) {
    const pos = ctx.player.position.clone();
    pos.x += 6;
    const chao = col.groundAt(pos.x, pos.z, 200);
    const ponto = { x: pos.x, y: chao + hy, z: pos.z };
    const antes = pk.itens.filter(i => i.ativo).length;
    ctx.bus.emit('enemy:killed', { enemyId: 999, headshot: parte === 'cabeca', point: ponto });
    const novos = pk.itens.filter(i => i.ativo).slice(antes);
    casos.push({
      parte,
      chao: +chao.toFixed(2),
      itemY: novos.length ? +novos[0].base.y.toFixed(2) : null,
      acimaDoChao: novos.length ? +(novos[0].base.y - chao).toFixed(2) : null,
    });
  }
  return casos;
});

console.log('=== onde o item cai (por parte atingida) ===');
for (const c of r) {
  console.log(`  ${c.parte.padEnd(7)} chao=${c.chao}  item Y=${c.itemY}  -> ${c.acimaDoChao} m acima do chao`);
}
await b.close(); vite.kill();
