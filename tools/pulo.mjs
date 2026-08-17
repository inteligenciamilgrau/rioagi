/**
 * Reprodução do bug de pulo: injeta a tecla de pulo e roda o loop de movimento
 * quadro a quadro, imprimindo o estado interno. Mostra qual ramo do código
 * consumiu (ou engoliu) o pulo.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;

const vite = spawn(process.execPath,
  [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) res(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => rej(new Error('timeout vite')), 40000);
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const P = ctx.player;
  const M = P.movement ?? P.mov ?? P._movement;
  if (!M) return { erro: 'não achei o Movement em ctx.player', chaves: Object.keys(P) };

  ctx.state = 'jogando';
  const linhas = [];
  const V = ctx.camera.position.constructor;

  // Posiciona num spawn e deixa assentar no chão
  const pts = ctx.world.getSpawnPoints();
  const p = pts[9].position ?? pts[9];
  M.position.set(p.x, p.y + 0.5, p.z);
  M.velocity.set(0, 0, 0);
  for (let i = 0; i < 40; i++) P.update(1 / 60);

  const snap = (tag) => linhas.push(
    `${tag.padEnd(14)} y=${M.position.y.toFixed(3)} vy=${M.velocity.y.toFixed(2)} ` +
    `chao=${M.grounded ? 'S' : 'N'} coyote=${(M._coyote ?? -1).toFixed(3)} ` +
    `buf=${(M._jumpBuffer ?? -1).toFixed(3)} estado=${M.state} mantle=${M.mantling ? 'S' : 'N'}`);

  snap('assentado');

  // --- caso A: parado, sem direção (wishLen 0) ---
  ctx.input.keys.clear(); ctx.input._pressedThisFrame.clear();
  ctx.input.keys.add('Space'); ctx.input._pressedThisFrame.add('Space');
  P.update(1 / 60);
  snap('A: pulo parado');
  ctx.input._pressedThisFrame.clear();
  for (let i = 0; i < 6; i++) { P.update(1 / 60); }
  snap('A: +6 quadros');

  // volta ao chão
  ctx.input.keys.clear();
  for (let i = 0; i < 80; i++) P.update(1 / 60);
  snap('reassentado');

  // --- caso B: andando para frente + pulo (dispara o teste de mantle) ---
  ctx.input.keys.add('KeyW');
  for (let i = 0; i < 20; i++) P.update(1 / 60);
  snap('B: andando');
  ctx.input.keys.add('Space'); ctx.input._pressedThisFrame.add('Space');
  P.update(1 / 60);
  snap('B: pulo andando');
  ctx.input._pressedThisFrame.clear();
  for (let i = 0; i < 6; i++) P.update(1 / 60);
  snap('B: +6 quadros');

  // --- caso C: quantos pulos em 20 tentativas espaçadas ---
  ctx.input.keys.clear();
  let sucessos = 0, mantles = 0;
  for (let t = 0; t < 20; t++) {
    for (let i = 0; i < 30; i++) P.update(1 / 60);   // assenta
    const y0 = M.position.y;
    ctx.input.keys.add('Space'); ctx.input._pressedThisFrame.add('Space');
    P.update(1 / 60);
    ctx.input._pressedThisFrame.clear();
    ctx.input.keys.delete('Space');
    const subiu = M.velocity.y > 1.0;
    if (M.mantling) mantles++;
    else if (subiu) sucessos++;
    for (let i = 0; i < 45; i++) P.update(1 / 60);
    void y0;
  }

  return {
    linhas,
    tentativas: 20, pulosOk: sucessos, mantles,
    tune: {
      jumpBuffer: M.constructor?.TUNE?.jumpBuffer ?? null,
    },
  };
});

if (r.erro) { console.log(r.erro, r.chaves); }
else {
  for (const l of r.linhas) console.log(l);
  console.log(`\npulos em ${r.tentativas} tentativas (parado): ${r.pulosOk} ok, ${r.mantles} viraram mantle`);
}

await browser.close();
vite.kill();
