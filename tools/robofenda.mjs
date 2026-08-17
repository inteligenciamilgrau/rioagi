/**
 * robofenda.mjs — a fenda optica ciano da maquina REGREDIU com a correcao de
 * cor da luz do chao?
 *
 * A prova nao pode ser "olhei e achei parecido". Aqui a mesma maquina, na mesma
 * pose, a 5 m e a 15 m, e fotografada com a luz ANTIGA e com a NOVA no mesmo
 * boot, e a fenda e medida: cor, brilho e CONTRASTE contra a cabeca em volta.
 * Contraste e o que decide legibilidade a 15 m — nao o valor absoluto.
 *
 * Uso: PORT=5200 node tools/robofenda.mjs
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5199;
mkdirSync(ROOT + '/shots', { recursive: true });

const ANTIGO = {
  bounce: 0, chroma: 1, mix: 0,
  st: [0.945, 0.985, 1.055], lift: [0, 0, 0.012], gam: [1, 1, 1.03],
};

function lerPNG(buf) {
  let i = 8, larg = 0, alt = 0, tipo = 0;
  const pedacos = [];
  while (i < buf.length) {
    const n = buf.readUInt32BE(i), nome = buf.toString('ascii', i + 4, i + 8);
    const d = buf.subarray(i + 8, i + 8 + n);
    if (nome === 'IHDR') { larg = d.readUInt32BE(0); alt = d.readUInt32BE(4); tipo = d[9]; }
    else if (nome === 'IDAT') pedacos.push(d);
    else if (nome === 'IEND') break;
    i += 12 + n;
  }
  const canais = tipo === 6 ? 4 : 3;
  const cru = inflateSync(Buffer.concat(pedacos));
  const passo = larg * canais;
  const linhas = Buffer.alloc(alt * passo);
  let o = 0;
  for (let y = 0; y < alt; y++) {
    const f = cru[o++];
    const lin = cru.subarray(o, o + passo); o += passo;
    const dst = linhas.subarray(y * passo, (y + 1) * passo);
    const ant = y > 0 ? linhas.subarray((y - 1) * passo, y * passo) : null;
    for (let x = 0; x < passo; x++) {
      const a = x >= canais ? dst[x - canais] : 0;
      const b = ant ? ant[x] : 0;
      const c = (ant && x >= canais) ? ant[x - canais] : 0;
      let v = lin[x];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      dst[x] = v & 255;
    }
  }
  return { larg, alt, canais, passo, linhas };
}

/**
 * Acha a fenda pelo que ela e: os pixels mais CIANO do recorte (B-R alto e
 * claros). Mede a media deles e a media do resto (a cabeca), e o contraste.
 */
function medirFenda(buf) {
  const { larg, alt, canais, passo, linhas } = lerPNG(buf);
  const px = [];
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      const k = y * passo + x * canais;
      const r = linhas[k], g = linhas[k + 1], b = linhas[k + 2];
      px.push({ r, g, b, lum: 0.299 * r + 0.587 * g + 0.114 * b, ciano: (b - r) + (g - r) * 0.5 });
    }
  }
  const ord = [...px].sort((a, c) => c.ciano - a.ciano);
  const nF = Math.max(12, Math.round(px.length * 0.004));   // 0,4% mais ciano
  const fenda = ord.slice(0, nF);
  const media = (arr) => {
    let r = 0, g = 0, b = 0, l = 0;
    for (const q of arr) { r += q.r; g += q.g; b += q.b; l += q.lum; }
    const n = arr.length || 1;
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), lum: +(l / n).toFixed(1) };
  };
  // "cabeca" = a metade central do histograma de ciano (nem fenda nem fundo)
  const corpo = media(ord.slice(Math.floor(px.length * 0.35), Math.floor(px.length * 0.65)));
  const f = media(fenda);
  return {
    fenda: f, corpo,
    contraste: +(f.lum / Math.max(corpo.lum, 0.5)).toFixed(2),
    croma: +(f.b - f.r).toFixed(1),
    nPixels: nF,
  };
}

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 300000 });
await p.waitForTimeout(1800);

/* --- guarda os valores do codigo e congela o ceu -------------------------- */
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.sky._envInterval = 1e9; ctx.sky._cloudInterval = 1e9;
  window.__novo = {
    bounce: ctx.sky.bounceStrength, chroma: ctx.sky.lightingChroma,
    mix: ctx.lighting.bounceMix,
    st: ctx.postfx.pTonemap.uniforms.uShadowTint.value.toArray(),
    lift: ctx.postfx.pTonemap.uniforms.uLift.value.toArray(),
    gam: ctx.postfx.pTonemap.uniforms.uGamma.value.toArray(),
  };
});

/* --- palco: mesma busca do roboProva ------------------------------------- */
const palco = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.ai.spawnAutomatico = false;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
  for (const e of ctx.ai.pool) { e.ativo = false; e.soldado.grupo.visible = false; }
  ctx.ai.vivos.length = 0;

  const T = ctx.camera.position.constructor;
  const sol = ctx.lighting.sunDirection.clone();
  const col = ctx.world.collision;
  const pts = ctx.world.getSpawnPoints();
  const noSol = (x, y, z) => !col.raycast(new T(x, y + 1.2, z), sol, 90)?.hit;
  const chao = (x, z, yRef) => {
    const r = col.raycast(new T(x, yRef + 4, z), new T(0, -1, 0), 12);
    return r?.hit ? r.point.y : null;
  };
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i].position ?? pts[i];
    for (let g = 0; g < 24; g++) {
      const yaw = (g / 24) * Math.PI * 2;
      const dx = Math.sin(yaw), dz = -Math.cos(yaw);
      const alinhado = dx * sol.x + dz * sol.z;
      if (alinhado > -0.55) continue;             // sol atras da camera
      let ok = true; const alvos = [];
      for (const d of [5, 15]) {
        const x = q.x + dx * d, z = q.z + dz * d;
        const y = chao(x, z, q.y);
        if (y === null || Math.abs(y - q.y) > 3.0) { ok = false; break; }
        if (!noSol(x, y, z)) { ok = false; break; }
        alvos.push({ d, x, y, z });
      }
      if (!ok) continue;
      const olho = new T(q.x, q.y + 1.68, q.z);
      const a = alvos[1];
      const dir = new T(a.x - olho.x, (a.y + 1.0) - olho.y, a.z - olho.z);
      const dist = dir.length(); dir.normalize();
      if (col.raycast(olho, dir, dist - 0.7)?.hit) continue;
      window.__pal = { base: { x: q.x, y: q.y, z: q.z }, yaw, alvos };
      return { spawn: i, yaw: +yaw.toFixed(3) };
    }
  }
  return null;
});
if (!palco) { console.log('nao achei palco ao sol'); await b.close(); process.exit(1); }
console.log('palco:', JSON.stringify(palco));

/* --- poe uma maquina e enquadra a CABECA com FOV estreito ---------------- */
await p.evaluate(() => {
  window.__cena = (dist, fov) => {
    const ctx = window.__game.ctx;
    const T = ctx.camera.position.constructor;
    const pl = window.__pal;
    const olho = new T(pl.base.x, pl.base.y + 1.68, pl.base.z);
    const dx = Math.sin(pl.yaw), dz = -Math.cos(pl.yaw);
    for (const e of ctx.ai.pool) e.soldado.grupo.visible = false;
    const x = pl.base.x + dx * dist, z = pl.base.z + dz * dist;
    const yb = (pl.alvos.find((a) => a.d === dist) || pl.alvos[0]).y;
    const r = ctx.world.collision.raycast(new T(x, yb + 3, z), new T(0, -1, 0), 10);
    const y = r?.hit ? r.point.y : yb;
    const S = ctx.ai.pool.find((e) => e.soldado.variante === 1).soldado;
    S.reviver(); S.grupo.visible = true;
    S.grupo.position.set(x, y, z);
    S.grupo.rotation.set(0, Math.atan2(olho.x - x, olho.z - z), 0);
    S.setLocomocao(0, 0, false); S.setMira(olho, 1); S.setPoseArma('mira');
    for (let k = 0; k < 50; k++) S.update(1 / 60);
    const cab = S.posOlho().clone();
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.position.copy(olho);
    ctx.camera.lookAt(cab.x, cab.y, cab.z);
    ctx.camera.fov = fov;
    ctx.camera.updateProjectionMatrix();
    ctx.camera.updateMatrixWorld(true);
  };
});

const aplicar = (cfg) => p.evaluate((c) => {
  const ctx = window.__game.ctx, S = ctx.sky, L = ctx.lighting, u = ctx.postfx.pTonemap.uniforms;
  const v = c || window.__novo;
  S.bounceStrength = v.bounce; S.lightingChroma = v.chroma; L.bounceMix = v.mix;
  u.uShadowTint.value.fromArray(v.st);
  u.uLift.value.fromArray(v.lift);
  u.uGamma.value.fromArray(v.gam);
  S._renderEnv(); L._syncFromSky(true);
}, cfg);

// FOV estreito para a cabeca ocupar o mesmo tamanho na foto de 5 m e na de 15 m:
// a fenda tem de ser julgada pelo CONTRASTE, nao pelo numero de pixels.
const TOMADAS = [
  { nome: 'fenda-5m', dist: 5, fov: 12 },
  { nome: 'fenda-15m', dist: 15, fov: 4 },
  { nome: 'fenda-15m-fovjogo', dist: 15, fov: 75 },
];
const CROP = { x: 380, y: 250, width: 240, height: 200 };

console.log('\n                          fenda RGB        lum   B-R    corpo RGB       lum   contraste');
console.log('-'.repeat(96));
const pares = [];
for (const t of TOMADAS) {
  const par = [];
  for (const [rot, cfg] of [['ANTES ', ANTIGO], ['DEPOIS', null]]) {
    await aplicar(cfg);
    await p.evaluate(([d, f]) => {
      const ctx = window.__game.ctx;
      window.__cena(d, f);
      ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
      window.__game.settle(26);
    }, [t.dist, t.fov]);
    await p.waitForTimeout(200);
    const arq = `${ROOT}/shots/_rf-${t.nome}-${rot.trim().toLowerCase()}.png`;
    await p.screenshot({ path: arq });
    par.push({ rot, arq });
    const m = medirFenda(await p.screenshot({
      clip: t.fov > 40 ? { x: 430, y: 280, width: 140, height: 120 } : CROP,
    }));
    console.log(
      `${t.nome.padEnd(16)}${rot}  (${m.fenda.r},${m.fenda.g},${m.fenda.b})`.padEnd(46) +
      String(m.fenda.lum).padStart(6) + String(m.croma).padStart(7) + '   ' +
      `(${m.corpo.r},${m.corpo.g},${m.corpo.b})`.padEnd(16) + String(m.corpo.lum).padStart(6) +
      String(m.contraste).padStart(10),
    );
  }
  pares.push({ ...t, par });
}

const m = await b.newPage({ viewport: { width: 2020, height: 800 } });
const html = pares.map((t) => `
  <section><h2>${t.nome} (dist ${t.dist} m, fov ${t.fov})</h2><div class="par">
  ${t.par.map((q) => `<figure><img src="data:image/png;base64,${readFileSync(q.arq).toString('base64')}"><figcaption>${q.rot}</figcaption></figure>`).join('')}
  </div></section>`).join('');
await m.setContent(`<style>body{margin:0;background:#0d0d0f;font:15px ui-monospace,monospace;color:#eee}
 section{padding:6px}h2{margin:6px 4px;font-size:17px}
 .par{display:grid;grid-template-columns:repeat(2,1000px);gap:6px}
 figure{margin:0;position:relative}img{display:block;width:1000px}
 figcaption{position:absolute;left:6px;top:6px;background:#000c;padding:4px 10px}</style>${html}`);
await m.setViewportSize({ width: 2020, height: pares.length * 762 + 20 });
await m.screenshot({ path: `${ROOT}/shots/robo-fenda-ab.png`, fullPage: true });
console.log('\n-> shots/robo-fenda-ab.png');
await b.close();
