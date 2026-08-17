/**
 * Teste do contrato de chão: dispara raios para baixo numa grade sobre o mapa e
 * classifica o que a colisão devolve. Se a normal apontar para baixo, o teste de
 * `grounded` rejeita a superfície e o pulo falha — foi o sintoma relatado.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5182;

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
  const o = new V(), d = new V(0, -1, 0);

  const hist = { semHit: 0, normalCima: 0, normalLateral: 0, normalBaixo: 0 };
  const porSuperficie = {};
  let n = 0;
  const amostras = [];

  for (let x = -85; x <= 85; x += 5) {
    for (let z = -85; z <= 85; z += 5) {
      o.set(x, 90, z); d.set(0, -1, 0);
      const h = col.raycast(o, d, 200);
      n++;
      if (!h.hit) { hist.semHit++; continue; }
      const ny = h.normal.y;
      if (ny >= 0.5) hist.normalCima++;
      else if (ny > -0.5) hist.normalLateral++;
      else hist.normalBaixo++;
      porSuperficie[h.surface] = (porSuperficie[h.surface] || 0) + 1;
      if (amostras.length < 8) {
        amostras.push({ x, z, y: +h.point.y.toFixed(2), ny: +ny.toFixed(3), sup: h.surface });
      }
    }
  }

  // Teste direto: em cada ponto de spawn, o jogador seria considerado no chão?
  const pts = ctx.world.getSpawnPoints();
  let grounded = 0, naoGrounded = 0;
  const falhas = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].position ?? pts[i];
    const start = new V(p.x, p.y + 0.05, p.z);
    const end = new V(p.x, p.y - 0.20, p.z);
    const sw = col.capsuleSweep(start, end, 0.35, 1.80);
    if (sw.grounded) grounded++;
    else { naoGrounded++; falhas.push({ i, pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] }); }
  }

  return { n, hist, porSuperficie, amostras, spawnGrounded: grounded, spawnNaoGrounded: naoGrounded, falhas: falhas.slice(0, 10) };
});

console.log(`raios verticais: ${r.n}`);
console.log(`  sem colisão nenhuma : ${r.hist.semHit}`);
console.log(`  normal para CIMA    : ${r.hist.normalCima}   <- válido para pisar`);
console.log(`  normal LATERAL      : ${r.hist.normalLateral}`);
console.log(`  normal para BAIXO   : ${r.hist.normalBaixo}   <- winding invertido`);
console.log(`\nsuperfícies atingidas:`, r.porSuperficie);
console.log(`\namostras:`);
for (const a of r.amostras) console.log(`  (${a.x},${a.z}) y=${a.y} normal.y=${a.ny} ${a.sup}`);
console.log(`\nspawns com grounded=true : ${r.spawnGrounded}`);
console.log(`spawns com grounded=false: ${r.spawnNaoGrounded}`);
if (r.falhas.length) console.log('falhas:', JSON.stringify(r.falhas));

await browser.close();
vite.kill();
