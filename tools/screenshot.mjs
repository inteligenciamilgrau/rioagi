/**
 * Captura determinística de tomadas para avaliação visual.
 *
 *   node tools/screenshot.mjs                     # todas as tomadas -> shots/
 *   node tools/screenshot.mjs --only 02,05        # só algumas
 *   node tools/screenshot.mjs --out shots/rodada3 # diretório de saída
 *   node tools/screenshot.mjs --quality ultra
 *   node tools/screenshot.mjs --headed            # abre o navegador (útil pra depurar)
 *
 * Sobe o vite automaticamente, espera window.__game.ready, posiciona a câmera,
 * deixa TAA/bloom convergirem e salva PNG. Falha ruidosamente se o jogo quebrar —
 * screenshot preto passando por "ok" é o pior modo de falha possível aqui.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Porta configuravel com --port: permite varios agentes capturarem em paralelo
// sem brigar pelo mesmo socket. Sem o flag, mantem o 5178 historico.
const PORT = Number(
  (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : null)
  ?? process.env.SHOT_PORT ?? 5178,
);
const URL_BASE = `http://127.0.0.1:${PORT}`;

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const OUT = path.resolve(ROOT, arg('out', 'shots'));
const ONLY = arg('only') ? String(arg('only')).split(',').map(s => s.trim()) : null;
const QUALITY = arg('quality', 'alto');
const HEADED = argv.includes('--headed');
const PAGE_URL = arg('url', '/');

// ---------- servidor ----------
function startVite() {
  return new Promise((resolve, reject) => {
    const bin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(bin)) return reject(new Error('vite não encontrado — rode npm install'));
    const proc = spawn(process.execPath, [bin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/ready in|Local:\s+http/i.test(out)) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (c) => reject(new Error(`vite saiu com código ${c}\n${out}`)));
    setTimeout(() => reject(new Error(`timeout subindo o vite:\n${out}`)), 45000);
  });
}

// ---------- main ----------
const errors = [];
let vite, browser;

try {
  const cfg = JSON.parse(await readFile(path.join(ROOT, 'tools', 'shots.json'), 'utf8'));
  await mkdir(OUT, { recursive: true });

  console.log('· subindo vite…');
  vite = await startVite();

  console.log('· abrindo chromium…');
  browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-angle=default',
      '--enable-unsafe-swiftshader',   // fallback de software se não houver GPU
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-frame-rate-limit',
      '--mute-audio',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
    ],
  });

  // --width/--height: captura menor para iteracao rapida de agente. A avaliacao
  // final continua em 1920x1080, que e o que o manifesto registra.
  const vp = { ...(cfg.viewport ?? { width: 1920, height: 1080 }) };
  if (arg('width')) vp.width = Number(arg('width'));
  if (arg('height')) vp.height = Number(arg('height'));

  const page = await browser.newPage({
    viewport: vp,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });

  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      const txt = m.text();
      // Ruído conhecido e inofensivo do three em headless
      if (/WebGL context lost|Slow network|deprecated/i.test(txt)) return;
      errors.push(`[console.${t}] ${txt}`);
      console.log(`  ⚠ ${t}: ${txt.slice(0, 220)}`);
    }
  });
  page.on('pageerror', (e) => {
    errors.push(`[pageerror] ${e.message}`);
    console.log(`  ✖ pageerror: ${e.message.slice(0, 300)}`);
  });

  console.log(`· carregando ${PAGE_URL}…`);
  await page.goto(URL_BASE + PAGE_URL, { waitUntil: 'load', timeout: 60000 });

  // Espera o boot terminar. Geração procedural de textura pode levar segundos.
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 180000 });
  const boot = await page.evaluate(() => ({ ready: window.__game.ready, error: window.__game.error }));
  if (!boot.ready) throw new Error(`o jogo não subiu:\n${boot.error}`);

  const info = await page.evaluate((q) => {
    window.__game.setQuality(q);
    return { ua: navigator.userAgent, renderer: window.__game.ctx.renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1' };
  }, QUALITY);
  console.log(`· pronto (${info.renderer}, preset ${QUALITY})`);
  await page.waitForTimeout(2500); // deixa a troca de preset reconstruir RTs/texturas

  const manifest = [];
  for (const shot of cfg.shots) {
    if (ONLY && !ONLY.some((o) => shot.id.startsWith(o))) continue;
    process.stdout.write(`· ${shot.id} … `);

    const result = await page.evaluate(async (s) => {
      const g = window.__game, ctx = g.ctx;
      try {
        if (s.menu) {
          ctx.state = 'menu';
          ctx.hud?.setVisible?.(false);
          ctx.menu?.showMain?.();
        } else {
          ctx.menu?.hideAll?.();
          const opts = {
            fov: s.fov, hideViewmodel: s.hideViewmodel, hour: s.hour,
            simulate: !!(s.firing || s.spawnEnemies),
          };
          if (s.aerea) g.poseAerea(s.pos, s.alvo, opts);
          else g.poseAt(s.spawn ?? 0, s.yaw ?? 0, s.pitch ?? 0, opts);
          ctx.hud?.setVisible?.(!s.hideHud);
          if (s.ads) ctx.player?.forceADS?.(true); else ctx.player?.forceADS?.(false);
          if (s.spawnEnemies) ctx.ai?.debugSpawnNear?.(ctx.camera.position, s.spawnEnemies);
          if (s.hudDemo) ctx.hud?.debugDemoState?.();
          if (s.firing) ctx.player?.debugFire?.();
        }
        g.settle(24);
        return { ok: true, stats: g.stats() };
      } catch (e) { return { ok: false, error: String(e?.stack || e) }; }
    }, shot);

    if (!result.ok) {
      console.log(`FALHOU`);
      errors.push(`[${shot.id}] ${result.error}`);
      continue;
    }
    // Alguns efeitos (fumaça, flash) precisam de tempo de parede pra evoluir.
    await page.waitForTimeout(shot.firing ? 120 : 350);

    const file = path.join(OUT, `${shot.id}.png`);
    await page.screenshot({ path: file, type: 'png' });
    manifest.push({ id: shot.id, desc: shot.desc, file: path.relative(ROOT, file), stats: result.stats });
    console.log(`ok  (${result.stats.drawCalls} draws, ${(result.stats.triangles / 1000).toFixed(0)}k tris)`);
  }

  await writeFile(path.join(OUT, 'manifest.json'),
    JSON.stringify({ quality: QUALITY, capturadoEm: new Date().toISOString(), erros: errors, tomadas: manifest }, null, 2));

  console.log(`\n${manifest.length} tomada(s) em ${path.relative(ROOT, OUT)}/`);
  if (errors.length) {
    console.log(`\n${errors.length} erro(s) durante a captura:`);
    for (const e of errors.slice(0, 20)) console.log('  ' + e.slice(0, 300));
    process.exitCode = 1;
  }
} catch (err) {
  console.error('\nFALHA:', err.message);
  process.exitCode = 2;
} finally {
  await browser?.close();
  vite?.kill();
}
