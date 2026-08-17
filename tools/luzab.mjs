/**
 * luzab.mjs — prova visual A/B da correcao de cor da luz do chao.
 *
 * Um unico boot, os MESMOS enquadramentos fotografados duas vezes: com os
 * parametros antigos e com os novos. Enquadramento identico e a unica forma de
 * a comparacao valer alguma coisa — duas execucoes diferentes escolheriam
 * camaras diferentes e a comparacao viraria opiniao.
 *
 * Uso: PORT=5200 node tools/luzab.mjs
 * Saidas: shots/luz-ab-<pose>.png (par lado a lado) e shots/luz-ab.png (mosaico)
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5199;
mkdirSync(ROOT + '/shots', { recursive: true });

const ANTIGO = {
  bounce: 0, chroma: 1, mix: 0,
  st: [0.945, 0.985, 1.055], lift: [0, 0, 0.012], gam: [1, 1, 1.03],
};
const NOVO = null;   // null = como esta no codigo

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForTimeout(2500);

await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.sky._envInterval = 1e9; ctx.sky._cloudInterval = 1e9;
  // guarda os valores do codigo para a variante "novo"
  window.__novo = {
    bounce: ctx.sky.bounceStrength, chroma: ctx.sky.lightingChroma,
    reach: ctx.sky.bounceReach, gain: ctx.sky.bounceGain,
    mix: ctx.lighting.bounceMix,
    st: ctx.postfx.pTonemap.uniforms.uShadowTint.value.toArray(),
    lift: ctx.postfx.pTonemap.uniforms.uLift.value.toArray(),
    gam: ctx.postfx.pTonemap.uniforms.uGamma.value.toArray(),
  };
  console.log('novo', JSON.stringify(window.__novo));
});

/* ---------------------------------------------------------------- poses --- */
const poses = await p.evaluate(() => {
  const ctx = window.__game.ctx, col = ctx.world.collision, lib = ctx.materials;
  const sd = ctx.sky.sunDirection;
  const solo = (x, z) => col.raycast({ x, y: 95, z }, { x: 0, y: -1, z: 0 }, 220);

  // --- rua: ponto de asfalto mais central ---
  let rua = null;
  for (let x = -80; x <= 80; x += 2) for (let z = -80; z <= 80; z += 2) {
    const h = solo(x, z);
    if (!h.hit || h.normal.y < 0.9 || h.surface !== 'asfalto') continue;
    const d = x * x + z * z;
    if (!rua || d < rua.d) rua = { x, y: h.point.y, z, d };
  }

  // --- calcada portuguesa em SOMBRA ---
  const v = new ctx.camera.position.constructor();
  let cal = null;
  ctx.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (lib.getNomeSuperficie(o.material) !== 'calcada_portuguesa') return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const passo = Math.max(1, Math.floor(pos.count / 300));
    for (let i = 0; i < pos.count; i += passo) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const x = Math.round(v.x), z = Math.round(v.z);
      const h = solo(x, z);
      if (!h.hit || h.normal.y < 0.9) continue;
      const s = col.raycast({ x, y: h.point.y + 0.35, z }, { x: sd.x, y: sd.y, z: sd.z }, 160);
      if (!s.hit) continue;                     // queremos SOMBRA
      const d = x * x + z * z;
      if (!cal || d < cal.d) cal = { x, y: h.point.y, z, d };
    }
  });

  // --- vista ampla: terreno + rua + calcada + casario no mesmo quadro ---
  const base = rua || { x: 0, y: solo(0, 0).point?.y ?? 0, z: 0 };
  let ampla = null;
  for (let k = 0; k < 64; k++) {
    const ang = (k / 64) * Math.PI * 2;
    for (const dd of [8, 13, 18, 24]) {
      const cx = base.x + Math.sin(ang) * dd, cz = base.z + Math.cos(ang) * dd;
      const g = solo(cx, cz);
      if (!g.hit) continue;
      const cy = g.point.y + 1.68;
      const yaw = Math.atan2(base.x - cx, base.z - cz);
      const vistos = {};
      for (let a = -34; a <= 34; a += 4) for (const t of [3, 6, 10, 16, 24, 34]) {
        const ra = yaw + a * Math.PI / 180;
        const q = solo(cx + Math.sin(ra) * t, cz + Math.cos(ra) * t);
        if (q.hit) vistos[q.surface] = (vistos[q.surface] || 0) + 1;
      }
      if ((vistos.terra || 0) < 4 || (vistos.asfalto || 0) < 4) continue;
      const frente = col.raycast({ x: cx, y: cy, z: cz }, { x: Math.sin(yaw), y: -0.28, z: Math.cos(yaw) }, 9);
      if (frente.hit && frente.distance < 6 && frente.normal.y < 0.5) continue;
      const pts = Math.min(vistos.terra, vistos.asfalto) + Object.keys(vistos).length * 3;
      if (!ampla || pts > ampla.pts) ampla = { pts, cx, cy, cz, yaw };
    }
  }

  // --- mirante: ponto alto para o ceu e o casario ---
  let alto = null;
  for (let x = -70; x <= 70; x += 4) for (let z = -70; z <= 70; z += 4) {
    const h = solo(x, z);
    if (!h.hit || h.normal.y < 0.85) continue;
    if (!alto || h.point.y > alto.y) alto = { x, y: h.point.y, z };
  }
  return { rua, cal, ampla, alto };
});
console.log('poses:', JSON.stringify(poses, null, 1));

/* ------------------------------------------------------------- variantes -- */
const aplicar = (cfg) => p.evaluate((c) => {
  const ctx = window.__game.ctx, S = ctx.sky, L = ctx.lighting, u = ctx.postfx.pTonemap.uniforms;
  const v = c || window.__novo;
  if (v.bounce !== undefined) S.bounceStrength = v.bounce;
  if (v.chroma !== undefined) S.lightingChroma = v.chroma;
  if (v.reach !== undefined) S.bounceReach = v.reach;
  if (v.gain !== undefined) S.bounceGain = v.gain;
  if (v.mix !== undefined) L.bounceMix = v.mix;
  u.uShadowTint.value.fromArray(v.st);
  u.uLift.value.fromArray(v.lift);
  u.uGamma.value.fromArray(v.gam);
  S._renderEnv(); L._syncFromSky(true);
}, cfg);

const esconder = () => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
  ctx.viewScene.visible = false;
};

const TOMADAS = [
  { nome: 'rua-pe', leg: 'rua ao pe do jogador', hora: 17.5,
    cam: (q) => ({ pos: [q.rua.x, q.rua.y + 1.68, q.rua.z], rot: [-46, 40] }) },
  { nome: 'calcada-sombra', leg: 'calcada portuguesa EM SOMBRA (o alvo de validacao)', hora: 17.5,
    cam: (q) => ({ pos: [q.cal.x, q.cal.y + 1.35, q.cal.z], rot: [-42, 25] }) },
  { nome: 'ampla', leg: 'terreno + rua + calcada + casario', hora: 17.5,
    cam: (q) => ({ pos: [q.ampla.cx, q.ampla.cy, q.ampla.cz], rotRad: [-17 * Math.PI / 180, q.ampla.yaw] }) },
  { nome: 'ceu-1730', leg: 'ceu + casario — 17h30, sol a 12 graus', hora: 17.5,
    cam: (q) => ({ pos: [q.alto.x, q.alto.y + 3.0, q.alto.z], rot: [8, 300] }) },
  { nome: 'ceu-1200', leg: 'ceu + casario — 12h00, sol a 60 graus', hora: 12,
    cam: (q) => ({ pos: [q.alto.x, q.alto.y + 3.0, q.alto.z], rot: [8, 300] }) },
  { nome: 'ceu-alto-1730', leg: 'zenite — 17h30', hora: 17.5,
    cam: (q) => ({ pos: [q.alto.x, q.alto.y + 3.0, q.alto.z], rot: [45, 120] }) },
];

const arquivos = [];
for (const t of TOMADAS) {
  const par = [];
  for (const [rot, cfg] of [['antes', ANTIGO], ['depois', NOVO]]) {
    await p.evaluate((h) => { window.__game.ctx.sky.setTimeOfDay(h); }, t.hora);
    await aplicar(cfg);
    const c = t.cam(poses);
    await p.evaluate(([cam, esc]) => {
      const ctx = window.__game.ctx;
      ctx.state = 'pausado';
      ctx.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
      ctx.camera.up.set(0, 1, 0);
      const rr = cam.rotRad || [cam.rot[0] * Math.PI / 180, cam.rot[1] * Math.PI / 180];
      ctx.camera.rotation.set(rr[0], rr[1], 0, 'YXZ');
      ctx.camera.updateMatrixWorld(true);
      // eslint-disable-next-line no-new-func
      new Function('return ' + esc)()();
      window.__game.settle(24);
    }, [c, esconder.toString()]);
    await p.waitForTimeout(300);
    const arq = `${ROOT}/shots/_lab-${t.nome}-${rot}.png`;
    await p.screenshot({ path: arq });
    par.push(arq);
  }
  arquivos.push({ ...t, par });
  console.log('  ok', t.nome);
}

/* --------------------------------------------------------------- mosaico -- */
const m = await b.newPage({ viewport: { width: 2580, height: 800 } });
const html = arquivos.map((t) => `
  <section>
    <h2>${t.leg}</h2>
    <div class="par">
      <figure><img src="data:image/png;base64,${readFileSync(t.par[0]).toString('base64')}"><figcaption>ANTES</figcaption></figure>
      <figure><img src="data:image/png;base64,${readFileSync(t.par[1]).toString('base64')}"><figcaption>DEPOIS</figcaption></figure>
    </div>
  </section>`).join('');
await m.setContent(`<style>
  body{margin:0;background:#0d0d0f;font:15px ui-monospace,monospace;color:#eee}
  section{padding:6px}h2{margin:6px 4px;font-size:17px;font-weight:600}
  .par{display:grid;grid-template-columns:repeat(2,1280px);gap:6px}
  figure{margin:0;position:relative}img{display:block;width:1280px}
  figcaption{position:absolute;left:6px;top:6px;background:#000c;padding:4px 10px;letter-spacing:.08em}
</style>${html}`);
await m.setViewportSize({ width: 2580, height: arquivos.length * 762 + 20 });
await m.screenshot({ path: `${ROOT}/shots/luz-ab.png`, fullPage: true });
console.log('\n-> shots/luz-ab.png');
await b.close();
