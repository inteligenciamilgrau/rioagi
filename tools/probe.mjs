/**
 * Sonda de luminância: renderiza a MESMA tomada com um componente alterado por
 * vez e mede o brilho médio. O que mudar a média é o culpado pela escuridão.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5180;
const OUT = path.join(ROOT, 'shots', 'probe');

const vite = spawn(process.execPath,
  [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) res(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => rej(new Error('timeout vite')), 40000);
});
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await page.waitForTimeout(1500);

// Instala utilitários de medição na página
await page.evaluate(() => {
  const ctx = window.__game.ctx;
  window.__probe = {
    /** Média de luminância do canvas via readPixels do framebuffer default. */
    medir() {
      const c = ctx.renderer.domElement;
      const cv = document.createElement('canvas');
      cv.width = c.width; cv.height = c.height;
      const g = cv.getContext('2d');
      g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let soma = 0, escuros = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        soma += l;
        if (l < 8) escuros++;
      }
      return { media: +(soma / n).toFixed(1), pctEscuro: +(100 * escuros / n).toFixed(1) };
    },
    materiais() {
      const s = new Set();
      ctx.scene.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && m.isMeshStandardMaterial) s.add(m);
      });
      return [...s];
    },
  };
});

const VARIANTES = [
  ['baseline', 0], ['exp-1.0', 0], ['exp-1.6', 0], ['amb-3x', 0], ['amb-6x', 0],
  ['grade-suave', 0], ['calib-A', 0], ['calib-B', 0],
];

console.log('variante'.padEnd(16), 'média'.padStart(7), 'pct<8'.padStart(8));
console.log('-'.repeat(34));

for (const [nome, aplica] of VARIANTES) {
  // recarrega estado limpo entre variantes
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    window.__probe = window.__probe || {};
    window.__probe.materiais = () => {
      const s = new Set();
      ctx.scene.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && m.isMeshStandardMaterial) s.add(m);
      });
      return [...s];
    };
    window.__probe.medir = () => {
      const c = ctx.renderer.domElement;
      const cv = document.createElement('canvas');
      cv.width = c.width; cv.height = c.height;
      cv.getContext('2d').drawImage(c, 0, 0);
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let soma = 0, escuros = 0; const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        soma += l; if (l < 8) escuros++;
      }
      return { media: +(soma / n).toFixed(1), pctEscuro: +(100 * escuros / n).toFixed(1) };
    };
  });

  const r = await page.evaluate(async (nomeVar) => {
    const g = window.__game, ctx = g.ctx;
    const P = window.__probe;
    // aplica a variante
    // uniforms da grade ficam no estagio de tonemap do PostFX
    const gradeU = () => {
      for (const k of ['tonemap', 'grade', 'grading', 'finish']) {
        const p = ctx.postfx?.passes?.[k] ?? ctx.postfx?.[k];
        if (p?.material?.uniforms?.uExposure) return p.material.uniforms;
      }
      // varredura: acha qualquer material com uExposure
      let achado = null;
      const busca = (o) => {
        if (o?.material?.uniforms?.uExposure) achado = o.material.uniforms;
      };
      ctx.postfx?.cena?.traverse?.(busca);
      return achado;
    };
    const amb = (env, hemi) => {
      ctx.scene.environmentIntensity = env;
      ctx.scene.traverse((o) => { if (o.isHemisphereLight) o.intensity = hemi; });
    };
    const fns = {
      'baseline': () => {},
      'exp-1.0': () => { ctx.postfx.exposureScale = 1.0; },
      'exp-1.6': () => { ctx.postfx.exposureScale = 1.6; },
      'amb-3x': () => amb(2.1, 1.9),
      'amb-6x': () => amb(4.2, 3.7),
      'grade-suave': () => {
        const u = gradeU();
        if (u) {
          u.uContrast.value = 1.04;
          u.uBlackPoint.value = 0.004;
        }
      },
      'calib-A': () => {
        ctx.postfx.exposureScale = 1.15;
        amb(2.1, 1.9);
        const u = gradeU();
        if (u) { u.uContrast.value = 1.06; u.uBlackPoint.value = 0.006; }
      },
      'calib-B': () => {
        ctx.postfx.exposureScale = 1.45;
        amb(3.2, 2.8);
        const u = gradeU();
        if (u) { u.uContrast.value = 1.05; u.uBlackPoint.value = 0.004; }
      },
    };
    fns[nomeVar]?.();
    g.poseAt(9, 90, -3, { fov: 80, hideViewmodel: true });
    ctx.hud?.setVisible?.(false);
    ctx.menu?.hideAll?.();
    g.settle(30);
    return P.medir();
  }, nome);

  console.log(nome.padEnd(16), String(r.media).padStart(7), String(r.pctEscuro + '%').padStart(8));
  await page.screenshot({ path: path.join(OUT, `${nome}.png`) });
}

await browser.close();
vite.kill();
