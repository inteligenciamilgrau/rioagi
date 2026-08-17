/** Diagnóstico de iluminação e materiais na cena viva. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5179;

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const luzes = [];
  ctx.scene.traverse((o) => {
    if (o.isLight) luzes.push({
      tipo: o.type, nome: o.name || '(sem nome)',
      intensidade: +o.intensity.toFixed(3),
      cor: '#' + o.color.getHexString(),
      chao: o.groundColor ? '#' + o.groundColor.getHexString() : null,
      sombra: !!o.castShadow, visivel: o.visible,
    });
  });

  // amostra de materiais
  const mats = new Map();
  ctx.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m || mats.has(m.uuid)) continue;
      mats.set(m.uuid, {
        nome: m.name || m.type,
        envIntensity: m.envMapIntensity,
        rough: m.roughness, metal: m.metalness,
        temEnv: !!m.envMap, temMap: !!m.map, temNormal: !!m.normalMap,
        temAO: !!m.aoMap, temRough: !!m.roughnessMap,
      });
    }
  });

  return {
    luzes,
    environment: !!ctx.scene.environment,
    envIntensityCena: ctx.scene.environmentIntensity,
    background: ctx.scene.background ? ctx.scene.background.type || 'cor' : null,
    fog: ctx.scene.fog ? { tipo: ctx.scene.fog.type || 'FogExp2', cor: '#' + ctx.scene.fog.color.getHexString(), densidade: ctx.scene.fog.density } : null,
    exposure: ctx.renderer.toneMappingExposure,
    toneMapping: ctx.renderer.toneMapping,
    postfxAtivo: !!(ctx.postfx?.enabled && ctx.postfx?.ready),
    exposureScale: ctx.postfx?.exposureScale,
    materiais: [...mats.values()].slice(0, 14),
    totalMateriais: mats.size,
    sol: ctx.sky ? {
      dir: ctx.sky.sunDirection ? [+ctx.sky.sunDirection.x.toFixed(2), +ctx.sky.sunDirection.y.toFixed(2), +ctx.sky.sunDirection.z.toFixed(2)] : null,
      cor: ctx.sky.sunColor ? '#' + ctx.sky.sunColor.getHexString() : null,
    } : null,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
vite.kill();
