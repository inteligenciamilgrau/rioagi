/**
 * Fotografa o Uno com escada DENTRO DO JOGO (rota /), que e a unica pagina que
 * usa a MaterialLibrary de verdade — o banco de teste do WORLD cai no fallback
 * de materiais e mostra outra paleta.
 * Uso: node tools/unojogo.mjs [porta]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 5215);
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(300000);
const erros = [];
page.on('pageerror', (e) => { erros.push(e.message); console.log('[pageerror]', e.message.split('\n')[0]); });
page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) erros.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.waitForTimeout(2000);
// esconde HUD e menu: aqui so interessa o carro
await page.evaluate(() => {
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.display = 'none';
});

/**
 * ang: 0 = frente do carro, 90 = lado +Z local. Procura a distancia/altura mais
 * proxima da pedida que tenha visada livre e nao esteja enterrada no morro —
 * numa favela em encosta a maioria das posicoes cai dentro de casa ou do talude.
 */
async function tomada(nome, ang, dist, alt, alvoY, fov) {
  const r = await page.evaluate(([a, d0, h0, ay, f]) => {
    const ctx = window.__game.ctx;
    const v = ctx.world.props.posVeiculos.find((k) => k.tipo === 'uno');
    if (!v) return null;
    const col = ctx.world.collision;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const tx = v.x - 0.3 * c, tz = v.z + 0.3 * s, ty = v.y + ay;
    const V = ctx.camera.position.constructor;
    const org = new V(), dir = new V();
    for (const dang of [0, -10, 10, -20, 20, -30, 30, -45, 45]) {
      for (const d of [d0, d0 - 1, d0 + 1.5, d0 - 2, d0 + 3]) {
        for (const h of [h0, h0 + 0.6, h0 + 1.4]) {
          const rad = (a + dang) * Math.PI / 180;
          const lx = Math.cos(rad) * d, lz = Math.sin(rad) * d;
          const cx = v.x + lx * c + lz * s, cz = v.z - lx * s + lz * c, cy = v.y + h;
          const solo = col.groundAt(cx, cz, 200);
          if (!isFinite(solo) || solo > cy - 0.5) continue;
          org.set(cx, cy, cz);
          dir.set(tx - cx, ty - cy, tz - cz);
          const dd = dir.length(); dir.normalize();
          const hit = col.raycast(org, dir, dd);
          if (hit?.hit && hit.distance < dd - 2.6) continue;
          window.__game.poseAerea([cx, cy, cz], [tx, ty, tz], { fov: f, hideViewmodel: true });
          return { ang: a + dang, dist: d, alt: h };
        }
      }
    }
    return null;
  }, [ang, dist, alt, alvoY, fov]);
  if (!r) { console.log('  !! sem posicao livre para', nome); return; }
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(PASTA, `${nome}.png`) });
  console.log(`  -> ${nome.padEnd(24)} ang=${r.ang} dist=${r.dist} alt=${r.alt}`);
}

await tomada('jogo-uno-perfil', 90, 6.5, 1.5, 1.05, 50);
await tomada('jogo-uno-traseira-34', 145, 7.0, 1.65, 1.05, 55);
await tomada('jogo-uno-olho-jogador', 55, 6.0, 1.65, 1.10, 75);
await tomada('jogo-uno-frente-34', 35, 6.5, 1.65, 1.05, 55);

console.log('erros:', erros.length);
await browser.close();
vite.kill();
