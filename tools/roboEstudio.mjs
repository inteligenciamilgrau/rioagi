/**
 * Estudio, so para CONFERIR GEOMETRIA e o comportamento da fenda no escuro —
 * material se calibra no jogo (tools/roboCor.mjs), nunca aqui.
 *
 * Existe separado de tools/robo.mjs porque aquele grava por cima de
 * shots/robo-*.png, que sao a linha de base da comparacao. Este grava em
 * shots/robov2-estudio-*.png.
 *
 *   node tools/roboEstudio.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5203;
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT),
  '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout do vite')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 900, height: 900 } });
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
p.on('console', (m) => { const t = m.text(); if (/winding|Soldier|ERR/i.test(t)) console.log('  ·', t.slice(0, 120)); });
await p.goto(`http://127.0.0.1:${PORT}/tools/robo.html`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__robo?.pronto, { timeout: 60000 });

const tris = await p.evaluate(() => window.__robo.montar(3));
console.log('triangulos por variante (corpo+arma):', tris.join(' · '));

const tira = async (nome, fn) => {
  await p.evaluate(fn);
  await p.evaluate(() => window.__robo.desenhar());
  await p.screenshot({ path: `${ROOT}/shots/${nome}.png` });
  console.log('  ->', nome);
};

await tira('robov2-estudio-frente', () => {
  const R = window.__robo;
  R.montar(3); R.luzAmbiente(1);
  for (const s of R.soldados) { s.setLocomocao(0, 0, false); s.setMira(null, 0); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 90);
  R.olhar(5.2, 1.10, 0);
});
await tira('robov2-estudio-lado', () => window.__robo.olhar(5.2, 1.10, Math.PI / 2));
await tira('robov2-estudio-cabeca', () => {
  const R = window.__robo;
  R.montar(1); R.olhar(1.05, 1.71, 0, 1.70);
  R.passo(1 / 60, 60);
});
await tira('robov2-estudio-escuro', () => {
  const R = window.__robo;
  R.montar(3); R.luzAmbiente(0.06);
  for (const s of R.soldados) { s.setLocomocao(0, 0, false); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 60);
  R.olhar(4.4, 1.45, 0, 1.35);
});
await tira('robov2-estudio-escuro-perto', () => {
  const R = window.__robo;
  R.montar(1); R.olhar(1.0, 1.70, Math.PI * 0.12, 1.70);
  R.passo(1 / 60, 30);
});

console.log('ok');
await b.close();
vite.kill();
