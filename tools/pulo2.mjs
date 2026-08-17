/**
 * Verifica o contrato do pulo direto no capsuleSweep: um deslocamento para cima
 * do tamanho de um quadro (7,8 cm a 60 fps) NÃO pode ser colado de volta ao chão.
 * Simula a trajetória completa e mede a altura de pico.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5184;

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
  const col = ctx.world.collision;
  const V = ctx.camera.position.constructor;
  const pts = ctx.world.getSpawnPoints();
  const G = 9.81, V0 = Math.sqrt(2 * G * 1.10);

  const simular = (fps, spawnIdx) => {
    const dt = 1 / fps;
    const p = pts[spawnIdx].position ?? pts[spawnIdx];
    const pos = new V(p.x, p.y, p.z);
    const start = new V(), end = new V();

    // assenta
    for (let i = 0; i < 20; i++) {
      start.copy(pos); end.set(pos.x, pos.y - 0.05, pos.z);
      const sw = col.capsuleSweep(start, end, 0.35, 1.80);
      pos.copy(sw.position);
    }
    const chaoY = pos.y;

    // pula
    let vy = V0, pico = 0, quadrosNoAr = 0;
    for (let i = 0; i < Math.ceil(fps * 1.5); i++) {
      vy -= G * dt;
      start.copy(pos);
      end.set(pos.x, pos.y + vy * dt, pos.z);
      const sw = col.capsuleSweep(start, end, 0.35, 1.80);
      pos.copy(sw.position);
      pico = Math.max(pico, pos.y - chaoY);
      if (!sw.grounded) quadrosNoAr++;
      if (sw.grounded && vy < 0) break;
      if (sw.grounded && vy > 0) vy = vy;   // não deve acontecer após a correção
    }
    return { fps, pico: +pico.toFixed(3), quadrosNoAr };
  };

  const out = [];
  for (const fps of [30, 60, 120, 144, 240]) {
    for (const s of [0, 9, 15]) out.push({ spawn: s, ...simular(fps, s) });
  }
  return { V0: +V0.toFixed(2), out };
});

console.log(`velocidade inicial do pulo: ${r.V0} m/s  (alvo de altura: 1,10 m)\n`);
console.log('fps   spawn   pico(m)   quadros no ar');
console.log('-'.repeat(40));
let falhas = 0;
for (const o of r.out) {
  const ok = o.pico > 0.9;
  if (!ok) falhas++;
  console.log(
    String(o.fps).padStart(3), String(o.spawn).padStart(7),
    String(o.pico).padStart(9), String(o.quadrosNoAr).padStart(14),
    ok ? '' : '  <-- FALHOU',
  );
}
console.log(falhas === 0
  ? '\nOK: o pulo atinge a altura esperada em todos os framerates.'
  : `\n${falhas} caso(s) falharam.`);

await browser.close();
vite.kill();
