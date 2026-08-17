/**
 * semcapim.mjs — diagnostico: prova que o "paredao verde" que aparecia na cara
 * do jogador ao nascer e o material `grama`, desenhado em cartoes grandes que
 * NAO existem na malha de colisao (por isso o raycast de `Player._avaliarRumo`
 * e cego para ele).
 *
 * Fotografa a mesma vista com e sem o capim.
 * Saida: shots/spawn-diag-com-capim.png e shots/spawn-diag-sem-capim.png
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
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando'; ctx.bus.emit('game:start', {});
});
await p.waitForTimeout(700);

// Um ponto de chao de terra, onde o capim e mais denso.
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const pts = ctx.world.getSpawnPoints();
  let alvo = null;
  for (const s of pts) {
    const q = s.position ?? s;
    const o = { x: q.x, y: q.y + 2, z: q.z };
    const g = ctx.world.collision.raycast(o, { x: 0, y: -1, z: 0 }, 6);
    if (g.hit && g.surface === 'terra') { alvo = q; break; }
  }
  if (!alvo) return;
  ctx.player.movement.teleport(alvo.x, alvo.y + 0.1, alvo.z);
  ctx.player.rig.reset(ctx.player._rumoInicial(alvo), 0);
  for (let f = 0; f < 60; f++) ctx.player.update(1 / 60);
});

const foto = async (nome) => {
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
    window.__game.settle(16);
  });
  await p.screenshot({ path: `${ROOT}/shots/spawn-diag-${nome}.png` });
  console.log(`-> shots/spawn-diag-${nome}.png`);
};

await foto('com-capim');
await p.evaluate(() => {
  window.__game.ctx.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some((m) => m && m.name === 'grama')) o.visible = false;
  });
});
await foto('sem-capim');
await b.close();
