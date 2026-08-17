/**
 * folha.mjs — folha de contato: fotografa o primeiro frame em N spawns
 * sorteados (o mesmo caminho que `Player.respawn` usa) e monta um mosaico
 * unico, para julgar de uma vez se o criterio de rumo generaliza.
 *
 * Saida: shots/spawn-folha-antigo.png e shots/spawn-folha-novo.png
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const N = Number(process.argv[2] ?? 12);
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando'; ctx.bus.emit('game:start', {});
});
await p.waitForTimeout(500);

const total = await p.evaluate(() => window.__game.ctx.world.getSpawnPoints().length);
// espalhados pela lista, deterministico
const idx = Array.from({ length: N }, (_, k) => Math.floor(k * total / N));

const tirar = async (i, modo) => {
  const info = await p.evaluate(([k, m]) => {
    const ctx = window.__game.ctx;
    const s = ctx.world.getSpawnPoints()[k];
    const q = s.position ?? s;
    const yaw = m === 'novo' ? ctx.player._rumoInicial(q) : Math.atan2(-q.x, -q.z);
    ctx.player.movement.teleport(q.x, q.y + 0.1, q.z);
    ctx.player.rig.reset(yaw, 0);
    for (let f = 0; f < 60; f++) ctx.player.update(1 / 60);
    const h = ctx.world.collision.raycast(ctx.player.eyePosition, ctx.player.rig.aimDir, 200);
    return { d: h.hit ? +h.distance.toFixed(1) : null, sup: h.hit ? h.surface : 'ceu' };
  }, [i, modo]);
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
    window.__game.settle(16);
  });
  await p.screenshot({ path: `${ROOT}/shots/_f-${modo}-${i}.png` });
  return info;
};

const linhas = [];
for (const modo of ['antigo', 'novo']) {
  for (const i of idx) {
    const r = await tirar(i, modo);
    if (modo === 'novo') linhas.push(`spawn ${String(i).padStart(2)}: frente ${String(r.d ?? 'ceu').padStart(5)} m (${r.sup})`);
  }
  // mosaico
  const m = await b.newPage({ viewport: { width: 1460, height: Math.ceil(N / 3) * 292 + 40 } });
  const imgs = idx.map((i) => {
    const b64 = readFileSync(`${ROOT}/shots/_f-${modo}-${i}.png`).toString('base64');
    return `<figure><img src="data:image/png;base64,${b64}"><figcaption>spawn ${i}</figcaption></figure>`;
  }).join('');
  await m.setContent(`<style>body{margin:0;background:#111;font:12px monospace;color:#eee}
    main{display:grid;grid-template-columns:repeat(3,480px);gap:4px;padding:4px}
    figure{margin:0;position:relative} img{display:block;width:480px}
    figcaption{position:absolute;left:4px;top:4px;background:#000a;padding:2px 6px}</style><main>${imgs}</main>`);
  await m.screenshot({ path: `${ROOT}/shots/spawn-folha-${modo}.png`, fullPage: true });
  await m.close();
  console.log(`-> shots/spawn-folha-${modo}.png`);
}
console.log(linhas.join('\n'));
await b.close();
