/**
 * curva.mjs — a curva de ondas, antes e depois, lado a lado.
 *
 * O "depois" sai da `Progressao` VIVA dentro do jogo, não de uma cópia das
 * fórmulas: fórmula copiada para dentro da ferramenta é a maneira clássica de
 * medir um código que não é o que roda. O "antes" está escrito à mão aqui
 * porque ele não existe mais em lugar nenhum — são as fórmulas anteriores,
 * preservadas só para a comparação.
 *
 * Uso: node tools/curva.mjs [ate]
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5283);
const ATE = Number(process.argv[2] ?? 10);

/* Fórmulas ANTERIORES, para comparação. Não são usadas pelo jogo. */
const antes = {
  meta: (n) => 4 + Math.floor(n * 1.6),
  simult: (n) => Math.min(6 + Math.floor(n * 0.75), 12),
  atir: (n) => (n <= 4 ? 3 : (n <= 10 ? 4 : 5)),
  interv: (n) => Math.max(3.0, 8.5 - n * 0.6),
};

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } });
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });

const dep = await page.evaluate((ATE) => {
  const p = window.__game.ctx.progressao;
  const out = [];
  for (let n = 1; n <= ATE; n++) {
    const perfil = p.perfilDaOnda(n);
    const c = p.composicaoDaOnda(n);
    out.push({
      n,
      meta: p.metaDaOnda(n),
      simult: p.simultaneosDaOnda(n),
      drones: p.dronesDaOnda(n),
      atir: p.atiradoresDaOnda(n),
      interv: +p.intervaloReforco(n).toFixed(1),
      rotulo: c.rotulo ?? '',
      reacao: perfil.reacao.map((x) => x.toFixed(2)).join('-'),
      erroMin: perfil.erroMin.toFixed(3),
    });
  }
  return out;
}, ATE);

const c = (v, n) => String(v).padStart(n);
console.log('');
console.log('CURVA DE ONDAS — antes (IA passiva) x depois');
console.log('');
console.log('       |        meta      |    simultaneos   |   atiradores  |  reforco (s)  | drones |');
console.log(' onda  |  antes    depois |  antes    depois | antes  depois | antes  depois |  novo  | rotulo');
console.log('-'.repeat(104));
for (const d of dep) {
  const a = { meta: antes.meta(d.n), simult: antes.simult(d.n), atir: antes.atir(d.n), interv: +antes.interv(d.n).toFixed(1) };
  const seta = (x, y) => (y === x ? ' ' : (y > x ? '+' : '-'));
  console.log(
    c(d.n, 5) + '  |' + c(a.meta, 7) + c(d.meta, 10) + seta(a.meta, d.meta)
    + ' |' + c(a.simult, 7) + c(d.simult, 10) + seta(a.simult, d.simult)
    + ' |' + c(a.atir, 6) + c(d.atir, 8) + seta(a.atir, d.atir)
    + ' |' + c(a.interv, 6) + c(d.interv, 8) + seta(a.interv, d.interv)
    + ' |' + c(d.drones, 7) + ' | ' + d.rotulo,
  );
}
console.log('');
console.log('perfil de IA por onda (reacao em s, erroMin em rad):');
for (const d of dep) {
  console.log('  onda ' + c(d.n, 2) + '   reacao ' + d.reacao + '   erroMin ' + d.erroMin);
}

await browser.close();
vite.kill();
