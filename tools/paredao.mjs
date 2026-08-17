/**
 * paredao.mjs — a MESMA pose de `semcapim.mjs` (o spawn de chao de terra, yaw de
 * `_rumoInicial`, 800x450), para comparar lado a lado com as duas capturas que
 * documentam o defeito:
 *     shots/spawn-diag-com-capim.png   (o paredao verde)
 *     shots/spawn-diag-sem-capim.png   (a mesma pose sem folhagem nenhuma)
 *
 * NAO sobrescreve nenhuma das duas: escreve em nome proprio.
 * Tambem fotografa dois spawns onde a auditoria achou folha colada no olho.
 *
 * Saida: shots/spawn-paredao-corrigido.png e shots/spawn-folhanacara-*.png
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const EXTRA = (process.argv[2] ?? '23,49,60').split(',').map(Number);
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando'; ctx.bus.emit('game:start', {});
});
await p.waitForTimeout(700);

const esconder = () => p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
  window.__game.settle(16);
});

// --- a pose exata do semcapim.mjs ---
const info = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  for (const s of ctx.world.getSpawnPoints()) {
    const q = s.position ?? s;
    const g = ctx.world.collision.raycast({ x: q.x, y: q.y + 2, z: q.z }, { x: 0, y: -1, z: 0 }, 6);
    if (!g.hit || g.surface !== 'terra') continue;
    ctx.player.movement.teleport(q.x, q.y + 0.1, q.z);
    ctx.player.rig.reset(ctx.player._rumoInicial(q), 0);
    for (let f = 0; f < 60; f++) ctx.player.update(1 / 60);
    return { x: +q.x.toFixed(1), z: +q.z.toFixed(1) };
  }
  return null;
});
await esconder();
await p.screenshot({ path: `${ROOT}/shots/spawn-paredao-corrigido.png` });
console.log(`-> shots/spawn-paredao-corrigido.png  (spawn de terra em ${info.x}, ${info.z})`);

// --- os spawns com folha mais perto do olho ---
for (const i of EXTRA) {
  const d = await p.evaluate((k) => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getSpawnPoints();
    const q = pts[k % pts.length].position ?? pts[k % pts.length];
    ctx.player.movement.teleport(q.x, q.y + 0.1, q.z);
    ctx.player.rig.reset(ctx.player._rumoInicial(q), 0);
    for (let f = 0; f < 60; f++) ctx.player.update(1 / 60);
    const h = ctx.world.collision.raycast(ctx.player.eyePosition, ctx.player.rig.aimDir, 200);
    return h.hit ? +h.distance.toFixed(1) : null;
  }, i);
  await esconder();
  await p.screenshot({ path: `${ROOT}/shots/spawn-folhanacara-${i}.png` });
  console.log(`-> shots/spawn-folhanacara-${i}.png  (colisao a frente: ${d ?? 'ceu'} m)`);
}

await b.close();
