/**
 * Fotografa o banco isolado tools/unolab.html: perfil ortografico, silhueta
 * chapada e tres-quartos, sem a favela atras. E aqui que a forma se prova.
 * Uso: node tools/unolab.mjs [porta]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 5201);
const PASTA = path.join(ROOT, 'shots');
mkdirSync(PASTA, { recursive: true });

const vite = spawn(process.execPath,
  [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
    '--port', String(PORT), '--strictPort', '--config', path.join(ROOT, 'tools/vite.diag.config.js')],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) res(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => rej(new Error('timeout vite')), 60000);
});

const browser = await chromium.launch({
  headless: true,
  // Sem PW_CHROME definido, deixa a propria Playwright resolver o Chromium.
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 620 } });
page.setDefaultTimeout(180000);
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`http://127.0.0.1:${PORT}/tools/unolab.html`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__pronto === true, null, { timeout: 180000 });

const tiro = async (nome, fn) => {
  await page.evaluate(fn);
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(PASTA, `${nome}.png`) });
  console.log('  ->', nome);
};

// --- perfil ortografico do Uno: 8 m de largura cobre a escada inteira ---
await tiro('lab-uno-perfil-orto', () => window.__orto([0, 1.0, 14], [0, 1.0, 0], 8));
await tiro('lab-uno-perfil-silhueta', () => { window.__silhueta(true); window.__orto([0, 1.0, 14], [0, 1.0, 0], 8); });
await tiro('lab-uno-perfil-silhueta-oposto', () => window.__orto([0, 1.0, -14], [0, 1.0, 0], 8));
await tiro('lab-fusca-perfil-silhueta', () => window.__orto([14, 1.0, 14], [14, 1.0, 0], 8));
await page.evaluate(() => window.__silhueta(false));
await tiro('lab-uno-perfil-oposto', () => window.__orto([0, 1.0, -14], [0, 1.0, 0], 8));
await tiro('lab-uno-frente-34', () => window.__pose([5.0, 1.9, -4.2], [0.1, 0.9, 0], 46));
await tiro('lab-uno-traseira-34', () => window.__pose([-5.4, 1.9, 4.2], [-0.7, 0.9, 0], 46));
await tiro('lab-uno-olho-jogador', () => window.__pose([3.9, 1.65, -4.6], [-0.5, 1.05, 0], 75));
await tiro('lab-uno-topo', () => window.__orto([0, 14, 0.001], [0, 0, 0], 8));
// comparacao direta: Uno e fusca lado a lado, mesma camera
await tiro('lab-comparacao-uno-fusca', () => window.__orto([7, 1.1, 16], [7, 1.1, 0], 20));

await browser.close();
vite.kill();
