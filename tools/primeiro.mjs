/**
 * primeiro.mjs — o primeiro frame REAL do jogo, sem nenhum truque:
 * so carrega a pagina, esconde a UI e fotografa onde o Player.init() parou.
 * Tambem mede quanto custa a varredura de spawn no boot.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(2000);

// Enquanto esta no menu quem manda na camera e a cena de capa; so em 'jogando'
// o Player.update roda e escreve a pose do rig. E o mesmo que clicar em JOGAR.
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando';
  ctx.bus.emit('game:start', {});
});
await p.waitForTimeout(700);

const r = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const pl = ctx.player;
  const pos = pl.position;
  const pts = ctx.world.getSpawnPoints();
  // qual dos 80 pontos foi escolhido?
  let idx = -1, melhorD = 1e9;
  pts.forEach((s, i) => {
    const q = s.position ?? s;
    const d = Math.hypot(q.x - pos.x, q.z - pos.z);
    if (d < melhorD) { melhorD = d; idx = i; }
  });
  const t0 = performance.now();
  const esc = pl._escolherSpawn();
  const ms = performance.now() - t0;
  const h = ctx.world.collision.raycast(pl.eyePosition, pl.rig.aimDir, 200);
  return {
    pos: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)],
    idx, yaw: +(pl.rig.yaw * 180 / Math.PI).toFixed(1),
    frente: h.hit ? +h.distance.toFixed(1) : null,
    ms: +ms.toFixed(0), spawns: pts.length,
    nota: +pl._avaliarRumo(esc.p).nota.toFixed(2),
  };
});
console.log(`spawn escolhido: indice ${r.idx} de ${r.spawns}, em (${r.pos[0]}, ${r.pos[2]})`);
console.log(`yaw inicial ${r.yaw}°   obstaculo a frente: ${r.frente ?? 'ceu'} m   nota ${r.nota}`);
console.log(`custo da varredura dos ${r.spawns} spawns no boot: ${r.ms} ms`);

await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
  const ui = document.getElementById('ui-root');
  if (ui) ui.style.display = 'none';
  window.__game.settle(16);
});
await p.screenshot({ path: `${ROOT}/shots/spawn-primeiro-frame.png` });
console.log('-> shots/spawn-primeiro-frame.png');
await b.close();
