// Observacao VISUAL de uma partida real: o jogo roda no PROPRIO loop rAF
// (com os mesmos aborts de frame quando ai.update lanca), jogador parado e
// imortal, ondas ligadas. A cada ~2s pausamos, aproximamos a camera do inimigo
// vivo mais proximo e tiramos uma foto; tambem salvamos o canvas cru
// (o ultimo frame que o loop de producao conseguiu renderizar).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = process.cwd(), PORT = parseInt(process.env.PORT ?? '5207', 10);
const DUR_S = parseInt(process.env.DUR_S ?? '120', 10);
const TAG = process.env.TAG ?? 'antes';
const DIR = process.env.OUTDIR ?? `${ROOT}/shots/inimigo/obs-${TAG}`;
fs.mkdirSync(DIR, { recursive: true });

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
  const p = await b.newPage({ viewport: { width: 640, height: 480 } });
  let pageErrs = 0; let firstErr = '';
  p.on('pageerror', e => { pageErrs++; if (!firstErr) firstErr = e.message.split('\n')[0]; });
  p.on('crash', () => console.log('>>> PAGINA CRASHOU (renderer)'));
  await p.addInitScript(() => {
    let s = 424242;
    Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
  // o otimizador de deps do vite pode recarregar a pagina logo apos o boot;
  // espera a poeira baixar e confirma que __game sobreviveu
  await p.waitForTimeout(4000);
  await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });

  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getSpawnPoints();
    const P0 = pts[9].position ?? pts[9];
    ctx.player.movement.teleport(P0.x, P0.y + 0.1, P0.z);
    ctx.player.takeDamage = () => {};
    ctx.ai.reset();
    ctx.ai.spawnAutomatico = true;
    ctx.ai._tOnda = 0;
    ctx.ai.spawnPerto(14);
    ctx.state = 'jogando';           // loop rAF de producao assume daqui
  });

  const t0 = Date.now();
  let shot = 0;
  const linhas = [];
  while ((Date.now() - t0) / 1000 < DUR_S) {
    await p.waitForTimeout(2000);    // partida corre no rAF real
    // 1) canvas cru: o que o jogador estaria vendo AGORA
    await p.screenshot({ path: `${DIR}/${String(shot).padStart(3, '0')}-live.png` });
    // 2) pausa, aproxima do inimigo vivo mais proximo e fotografa posado
    const info = await p.evaluate(() => {
      const ctx = window.__game.ctx;
      ctx.state = 'pausado';
      const jog = ctx.player.position;
      let alvo = null, md = 1e9;
      for (const e of ctx.ai.vivos) {
        if (!e.alive) continue;
        const d = e.pos.distanceTo(jog);
        if (d < md) { md = d; alvo = e; }
      }
      if (!alvo) { ctx.state = 'jogando'; return null; }
      const sold = alvo.soldado;
      sold.grupo.updateMatrixWorld(true);
      const V3 = ctx.camera.position.constructor;
      const v = new V3();
      const ossos = {};
      for (const n of ['quadril', 'peito', 'cabeca', 'joelho_D', 'pe_D']) {
        sold.porNome[n].getWorldPosition(v);
        ossos[n] = +v.y.toFixed(2);
      }
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.position.set(alvo.pos.x + 2.4, alvo.pos.y + 1.4, alvo.pos.z + 2.4);
      ctx.camera.lookAt(alvo.pos.x, alvo.pos.y + 0.85, alvo.pos.z);
      ctx.camera.updateMatrixWorld(true);
      ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
      window.__game.settle(10);
      return {
        id: alvo.id, estado: alvo.estado, dist: +md.toFixed(1),
        vel: +alvo.vel.length().toFixed(1),
        morto: alvo.morto, soldMorto: sold.est.morto,
        tempoAnim: +sold.est.tempo.toFixed(1), ossos,
        vivos: ctx.ai.vivos.filter(x => x.alive).length,
      };
    });
    if (info) {
      await p.screenshot({ path: `${DIR}/${String(shot).padStart(3, '0')}-posed.png` });
      linhas.push(`#${String(shot).padStart(3, '0')} id=${info.id} ${info.estado} vel=${info.vel} d=${info.dist} anim=${info.tempoAnim} ossosY=${JSON.stringify(info.ossos)} vivos=${info.vivos}`);
    }
    await p.evaluate(() => {
      const ctx = window.__game.ctx;
      ctx.hud?.setVisible?.(true); ctx.viewScene.visible = true;
      ctx.state = 'jogando';
    });
    shot++;
  }
  linhas.forEach(l => console.log(l));
  console.log(`pageErrors (loop rAF de producao): ${pageErrs}${firstErr ? ' — 1o: ' + firstErr : ''}`);
  console.log(`${shot} capturas em ${DIR}`);
} finally {
  await b?.close?.().catch(() => {});
  vite.kill();
}
