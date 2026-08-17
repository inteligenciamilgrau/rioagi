/**
 * Prova visual da mascara usada por tools/roboCor.mjs: salva o quadro medido e
 * o recorte que o fotometro considerou "robo".  Sem isso nao da para confiar em
 * numero nenhum — a mascara pode estar pegando sombra projetada, halo de bloom
 * ou rastro de TAA em vez da maquina.
 *
 *   node tools/roboMascara.mjs
 *
 * Sai em shots/diag-mascara-*.png (nomes novos; nao toca nas capturas antigas).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5201;
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT),
  '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout do vite')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 240000 });
await p.waitForTimeout(1500);

const r = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.ai.spawnAutomatico = false;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
  ctx.lighting.update = () => {}; ctx.sky.update = () => {};
  for (const e of ctx.ai.pool) { e.ativo = false; e.soldado.grupo.visible = false; }
  ctx.ai.vivos.length = 0;

  const T = ctx.camera.position.constructor;
  const sol = ctx.lighting.sunDirection.clone();
  const col = ctx.world.collision;
  const pts = ctx.world.getSpawnPoints();
  const noSol = (x, y, z) => !col.raycast(new T(x, y + 1.2, z), sol, 90)?.hit;
  const chao = (x, z, yRef) => {
    const q = col.raycast(new T(x, yRef + 4, z), new T(0, -1, 0), 12);
    return q?.hit ? q.point.y : null;
  };
  let palco = null;
  for (let i = 0; i < pts.length && !palco; i++) {
    const q = pts[i].position ?? pts[i];
    for (let g = 0; g < 24; g++) {
      const yaw = (g / 24) * Math.PI * 2;
      const dx = Math.sin(yaw), dz = -Math.cos(yaw);
      let ok = true; const alvos = [];
      for (const d of [5, 15, 30]) {
        const x = q.x + dx * d, z = q.z + dz * d;
        const y = chao(x, z, q.y);
        if (y === null || Math.abs(y - q.y) > 3.0) { ok = false; break; }
        if (!noSol(x, y, z)) { ok = false; break; }
        alvos.push({ d, x, y, z });
      }
      if (!ok) continue;
      const olho = new T(q.x, q.y + 1.68, q.z);
      const a30 = alvos[2];
      const dir = new T(a30.x - olho.x, (a30.y + 1.0) - olho.y, a30.z - olho.z);
      const dist = dir.length(); dir.normalize();
      if (col.raycast(olho, dir, dist - 0.7)?.hit) continue;
      palco = { base: q, alvos, spawn: i };
      break;
    }
  }
  if (!palco) return { erro: 'sem palco' };

  const ler = () => {
    const c = ctx.renderer.domElement;
    const cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    return g.getImageData(0, 0, cv.width, cv.height);
  };

  const olho = new T(palco.base.x, palco.base.y + 1.68, palco.base.z);
  const saida = [];
  for (const alvo of palco.alvos) {
    const S = ctx.ai.pool.find((x) => x.soldado.variante === 1).soldado;
    for (const o of ctx.ai.pool) o.soldado.grupo.visible = false;
    S.reviver();
    S.grupo.visible = true;
    S.grupo.position.set(alvo.x, alvo.y, alvo.z);
    S.grupo.rotation.set(0, Math.atan2(olho.x - alvo.x, olho.z - alvo.z), 0);
    S.setLocomocao(0, 0, false); S.setMira(olho, 1); S.setPoseArma('mira');
    for (let i = 0; i < 50; i++) S.update(1 / 60);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.position.copy(olho);
    ctx.camera.lookAt(alvo.x, alvo.y + 1.25, alvo.z);
    ctx.camera.updateMatrixWorld(true);

    window.__game.settle(24);
    const A = ler();
    S.grupo.visible = false;
    window.__game.settle(24);
    const B = ler();
    S.grupo.visible = true;

    // mascara + erosao (igual ao fotometro)
    const w = A.width, h = A.height, a = A.data, bb = B.data;
    const m = new Uint8Array(w * h);
    for (let i = 0, q = 0; i < a.length; i += 4, q++) {
      const d = Math.max(Math.abs(a[i]-bb[i]), Math.abs(a[i+1]-bb[i+1]), Math.abs(a[i+2]-bb[i+2]));
      m[q] = d > 10 ? 1 : 0;
    }
    const e = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const q = y * w + x;
      e[q] = (m[q] && m[q-1] && m[q+1] && m[q-w] && m[q+w]) ? 1 : 0;
    }
    // pinta: robo em magenta sobre o quadro real
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const out = g.createImageData(w, h);
    let n = 0;
    for (let q = 0; q < w * h; q++) {
      const i = q * 4;
      if (e[q]) { out.data[i] = 255; out.data[i+1] = 0; out.data[i+2] = 255; n++; }
      else { out.data[i] = a[i] * 0.45; out.data[i+1] = a[i+1] * 0.45; out.data[i+2] = a[i+2] * 0.45; }
      out.data[i+3] = 255;
    }
    g.putImageData(out, 0, 0);
    // bbox da mascara
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (e[y*w+x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // quadro cru para comparar
    const cvA = document.createElement('canvas'); cvA.width = w; cvA.height = h;
    cvA.getContext('2d').putImageData(A, 0, 0);
    saida.push({
      d: alvo.d, n, bbox: [x0, y0, x1, y1],
      png: cv.toDataURL('image/png'), pngA: cvA.toDataURL('image/png'),
    });
  }
  for (const e2 of ctx.ai.pool) e2.soldado.grupo.visible = false;
  return { spawn: palco.spawn, saida };
});

if (r.erro) { console.log(r.erro); } else {
  const fs = await import('node:fs');
  for (const s of r.saida) {
    for (const [suf, dat] of [['quadro', s.pngA], ['mascara', s.png]]) {
      const arq = `${ROOT}/shots/diag-${suf}-${s.d}m.png`;
      fs.writeFileSync(arq, Buffer.from(dat.split(',')[1], 'base64'));
    }
    console.log(`  ${String(s.d).padStart(2)}m  mascara n=${String(s.n).padStart(6)}  bbox=${JSON.stringify(s.bbox)}`
      + `  (largura ${s.bbox[2]-s.bbox[0]} px, altura ${s.bbox[3]-s.bbox[1]} px)`);
  }
}
await b.close();
vite.kill();
