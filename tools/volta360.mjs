/**
 * volta360.mjs — fotografa um spawn de 45 em 45 graus, para conferir A OLHO se o
 * criterio de `Player._rumoInicial` escolheu mesmo a melhor vista.
 * Uso: node tools/volta360.mjs [indiceDoSpawn]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const IDX = Number(process.argv[2] ?? 0);
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
// Outro agente pode estar salvando arquivos: sem o cliente de HMR a pagina nao
// recarrega no meio da sessao de fotos.
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(2000);
await p.evaluate(() => { window.__game.ctx.state = 'pausado'; });

const escolhido = await p.evaluate((i) => {
  const ctx = window.__game.ctx;
  const pts = ctx.world.getSpawnPoints();
  const q = (pts[i % pts.length].position ?? pts[i % pts.length]);
  return +(ctx.player._rumoInicial(q) * 180 / Math.PI).toFixed(1);
}, IDX);
console.log(`spawn ${IDX}: _rumoInicial escolheu ${escolhido}°`);

for (const g of [0, 45, 90, 135, 180, 225, 270, 315]) {
  const info = await p.evaluate(([i, graus]) => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getSpawnPoints();
    const s = pts[i % pts.length];
    const q = s.position ?? s;
    ctx.player.movement.teleport(q.x, q.y + 0.1, q.z);
    ctx.player.rig.reset(graus * Math.PI / 180, 0);
    for (let k = 0; k < 60; k++) ctx.player.update(1 / 60);
    const h = ctx.world.collision.raycast(ctx.player.eyePosition, ctx.player.rig.aimDir, 200);
    return { d: h.hit ? +h.distance.toFixed(1) : null, sup: h.hit ? h.surface : 'ceu' };
  }, [IDX, g]);
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    // o menu volta sozinho por timer; esconder a raiz da UI e definitivo
    const ui = document.getElementById('ui-root');
    if (ui) ui.style.display = 'none';
    window.__game.settle(16);
  });
  await p.screenshot({ path: `${ROOT}/shots/spawn-${IDX}-g${String(g).padStart(3, '0')}.png` });
  console.log(`  ${String(g).padStart(3)}°  frente: ${info.d ?? 'ceu'} m  (${info.sup})`);
}
await b.close();
