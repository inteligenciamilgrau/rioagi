// Foto do soldado em SPRINT (o estado que lancava TypeError por frame antes
// da correcao do _v5 em _bracosNaArma) — frente e costas, 3 variantes.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = process.cwd(), PORT = parseInt(process.env.PORT ?? '5214', 10);
const OUT = process.env.OUTDIR ?? `${ROOT}/shots/inimigo`;
fs.mkdirSync(OUT, { recursive: true });
const TAG = process.env.TAG ?? 'depois';

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let b;
try {
  await new Promise((r, j) => {
    let o = '';
    const h = d => { o += d; if (/ready in/.test(o)) r(); if (/is in use|EADDRINUSE/.test(o)) j(new Error('porta em uso')); };
    vite.stdout.on('data', h); vite.stderr.on('data', h);
    setTimeout(() => j(new Error('t/o vite')), 40000);
  });
  b = await chromium.launch({ headless: true, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 900, height: 700 } });
  p.on('pageerror', e => console.log('PAGEERR:', e.message.split('\n')[0]));
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
  await p.waitForTimeout(2500);
  await p.waitForFunction(() => window.__game?.ready, { timeout: 60000 });

  const erros = await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.hud?.setVisible?.(false); ctx.menu?.hideAll?.(); ctx.viewScene.visible = false;
    ctx.ai.reset(); ctx.ai.spawnAutomatico = false;
    const pts = ctx.world.getSpawnPoints();
    const sp = pts[9]; const P = sp.position ?? sp;
    const errs = [];
    window.__es = [];
    for (let k = 0; k < 3; k++) {
      const e = ctx.ai.pool[k];              // variantes 0,1,2
      e.spawn(new (P.constructor)(P.x + k * 1.6, P.y, P.z), Math.PI, null);
      window.__es.push(e);
      // sprint puro no soldado: correndo sem mirar (o caminho do bug)
      try {
        for (let i = 0; i < 90; i++) { e.soldado.setLocomocao(0, 4.6, false); e.soldado.update(1 / 60); }
      } catch (err) { errs.push(`variante ${k}: ${err.message}`); }
    }
    // camera de frente (soldados olham para +Z por yaw=PI... frente do modelo=-Z)
    const c = ctx.camera;
    c.up.set(0, 1, 0);
    c.position.set(P.x + 1.6, P.y + 1.25, P.z + 4.6);
    c.lookAt(P.x + 1.6, P.y + 0.95, P.z);
    c.updateMatrixWorld(true);
    window.__game.settle(14);
    return errs;
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}/sprint-${TAG}-frente.png` });
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    const P = window.__es[0].pos;
    ctx.camera.position.set(P.x + 1.6, P.y + 1.25, P.z - 4.6);
    ctx.camera.lookAt(P.x + 1.6, P.y + 0.95, P.z);
    ctx.camera.updateMatrixWorld(true);
    window.__game.settle(14);
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}/sprint-${TAG}-costas.png` });
  console.log('erros durante sprint:', erros.length ? erros : 'nenhum');
  console.log(`fotos: sprint-${TAG}-frente.png / sprint-${TAG}-costas.png`);
} finally {
  await b?.close?.().catch(() => {});
  vite.kill();
}
