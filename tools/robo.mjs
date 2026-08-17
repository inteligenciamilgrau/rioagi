/**
 * Renderiza o robo em todos os estados que importam (parado, andando,
 * atirando, morto) de frente e de lado, em luz de dia e no escuro.
 *
 *   node tools/robo.mjs
 *
 * Sai em shots/robo-*.png. Sobe o proprio vite numa porta separada.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5197;
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
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

// ---------------------------------------------------------------- parado
await tira('robo-1-parado-frente', () => {
  const R = window.__robo;
  R.montar(3); R.luzAmbiente(1);
  for (const s of R.soldados) { s.setLocomocao(0, 0, false); s.setMira(null, 0); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 90);
  R.olhar(5.2, 1.10, 0);
});
await tira('robo-2-parado-lado', () => {
  const R = window.__robo;
  R.olhar(5.2, 1.10, Math.PI / 2);
});
await tira('robo-3-parado-costas', () => {
  const R = window.__robo;
  R.olhar(5.2, 1.10, Math.PI);
});

// ------------------------------------------------------------------ perto
await tira('robo-4-cabeca', () => {
  const R = window.__robo;
  R.montar(1); R.olhar(1.05, 1.71, 0, 1.70);
  R.passo(1 / 60, 60);
});
await tira('robo-5-cabeca-lado', () => {
  const R = window.__robo;
  R.olhar(1.05, 1.71, Math.PI * 0.35, 1.70);
});
for (const [i, nome] of [[0, 'batedor'], [1, 'linha'], [2, 'pesado']]) {
  await tira(`robo-5${'abc'[i]}-cabeca-${nome}`, new Function('V', `
    const R = window.__robo;
    R.montar(1, 1.15, [${i}]); R.olhar(0.95, 1.71, 0, 1.70);
    R.passo(1 / 60, 40);
  `));
}
await tira('robo-6-torso', () => {
  const R = window.__robo;
  R.montar(3); R.olhar(2.3, 1.30, 0, 1.28);
  for (const s of R.soldados) { s.setLocomocao(0, 0, false); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 60);
});

// ---------------------------------------------------------------- andando
await tira('robo-7-andando-frente', () => {
  const R = window.__robo;
  R.montar(3); R.olhar(5.0, 1.10, 0);
  for (const s of R.soldados) { s.setLocomocao(0, 2.6, false); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 42);
});
await tira('robo-8-andando-lado', () => {
  const R = window.__robo;
  R.olhar(5.0, 1.05, Math.PI / 2);
  R.passo(1 / 60, 9);
});

// ---------------------------------------------------------------- atirando
await tira('robo-9-atirando-frente', () => {
  const R = window.__robo;
  R.montar(3); R.olhar(4.6, 1.35, 0, 1.30);
  for (const s of R.soldados) {
    s.setLocomocao(0, 0, false);
    s.setMira(new window.__robo.THREE.Vector3(0, 1.4, -8), 1);
    s.setPoseArma('mira');
  }
  R.passo(1 / 60, 70);
  for (const s of R.soldados) s.dispararRecuo(1);
  R.passo(1 / 60, 3);
});
await tira('robo-10-atirando-lado', () => {
  const R = window.__robo;
  R.olhar(4.2, 1.35, Math.PI * 0.62, 1.30);
});

// ------------------------------------------------------------------- morto
await tira('robo-11-morto', () => {
  const R = window.__robo;
  R.montar(3, 1.5);
  for (const s of R.soldados) { s.setLocomocao(0, 1.5, false); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 30);
  for (const s of R.soldados) {
    const rd = new R.Ragdoll(R.ctx, s);
    s.aoRagdoll(rd);
    s._rag = rd;
  }
  for (let i = 0; i < 150; i++) {
    for (const s of R.soldados) { s._rag.update(1 / 60); s.update(1 / 60); }
  }
  R.olhar(5.0, 1.55, Math.PI * 0.25, 0.35);
});

// ----------------------------------------------------- no escuro (a optica)
await tira('robo-12-escuro-frente', () => {
  const R = window.__robo;
  R.montar(3); R.luzAmbiente(0.06);
  for (const s of R.soldados) { s.setLocomocao(0, 0, false); s.setPoseArma('pronto'); }
  R.passo(1 / 60, 60);
  R.olhar(4.4, 1.45, 0, 1.35);
});
await tira('robo-13-escuro-perto', () => {
  const R = window.__robo;
  R.montar(1); R.olhar(1.0, 1.70, Math.PI * 0.12, 1.70);
  R.passo(1 / 60, 30);
});
await tira('robo-14-escuro-lado', () => {
  const R = window.__robo;
  R.montar(3); R.olhar(4.4, 1.45, Math.PI * 0.5, 1.35);
});

await p.evaluate(() => window.__robo.luzAmbiente(1));
console.log('ok');
await b.close();
vite.kill();
