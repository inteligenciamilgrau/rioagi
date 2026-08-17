/**
 * renascer.mjs — folha de contato do RESPAWN. Mata e faz renascer N vezes e
 * fotografa o primeiro frame de cada vida, para ver se o jogador volta olhando
 * para o casario (e nao para o capim ou para o vazio).
 *
 * Saida: shots/spawn-renascer.png
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const N = Number(process.argv[2] ?? 9);
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

const linhas = [];
for (let i = 0; i < N; i++) {
  const info = await p.evaluate(() => {
    const ctx = window.__game.ctx, pl = ctx.player;
    const t0 = performance.now();
    pl.respawn();
    const ms = performance.now() - t0;
    for (let f = 0; f < 30; f++) pl.update(1 / 60);
    // ATENCAO: collision.raycast devolve SEMPRE o mesmo objeto. Ler os campos
    // antes de disparar o proximo raio, senao o segundo sobrescreve o primeiro.
    const h = ctx.world.collision.raycast(pl.eyePosition, pl.rig.aimDir, 200);
    const d = h.hit ? +h.distance.toFixed(1) : null;
    const sup = h.hit ? h.surface : 'ceu';
    const o = pl.position.clone(); o.y += 2;
    const g = ctx.world.collision.raycast(o, { x: 0, y: -1, z: 0 }, 6);
    return {
      d, sup, chao: g.hit ? g.surface : '?', ms: +ms.toFixed(0),
      pos: [+pl.position.x.toFixed(0), +pl.position.z.toFixed(0)],
    };
  });
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
    window.__game.settle(16);
  });
  await p.screenshot({ path: `${ROOT}/shots/_r-${i}.png` });
  linhas.push(`vida ${i}: (${info.pos[0]},${info.pos[1]}) chao=${String(info.chao).padEnd(8)} `
    + `frente ${String(info.d ?? 'ceu').padStart(5)} m (${info.sup})  custo ${info.ms} ms`);
}

const m = await b.newPage({ viewport: { width: 1460, height: Math.ceil(N / 3) * 292 + 40 } });
const imgs = Array.from({ length: N }, (_, i) => {
  const b64 = readFileSync(`${ROOT}/shots/_r-${i}.png`).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}"><figcaption>vida ${i}</figcaption></figure>`;
}).join('');
await m.setContent(`<style>body{margin:0;background:#111;font:12px monospace;color:#eee}
  main{display:grid;grid-template-columns:repeat(3,480px);gap:4px;padding:4px}
  figure{margin:0;position:relative} img{display:block;width:480px}
  figcaption{position:absolute;left:4px;top:4px;background:#000a;padding:2px 6px}</style><main>${imgs}</main>`);
await m.screenshot({ path: `${ROOT}/shots/spawn-renascer.png`, fullPage: true });
console.log(linhas.join('\n'));
console.log('-> shots/spawn-renascer.png');
await b.close();
