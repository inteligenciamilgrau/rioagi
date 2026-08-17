/**
 * varrechao.mjs — varredura medida dos parametros de luz do chao.
 *
 * Diferencas para o azulprobe (que continua valendo como metrica historica):
 *  - separa SOL de SOMBRA por GEOMETRIA (raio ate o sol), nao pelo brilho do
 *    quadro. No pique das 17h30 a rua inteira esta em sombra de casario, entao
 *    o "quartil claro" do azulprobe nao e sol nenhum — e sombra menos escura.
 *  - mede a media absoluta do recorte, nao percentis, para dois quadros de
 *    brilhos diferentes continuarem comparaveis.
 *  - mede tambem uma PAREDE e o CEU, para pegar dano colateral do ajuste.
 *
 * Uso: PORT=5200 node tools/varrechao.mjs
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';

const PORT = process.env.PORT || 5199;

function lerPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('nao e PNG');
  let i = 8, larg = 0, alt = 0, prof = 0, tipo = 0;
  const pedacos = [];
  while (i < buf.length) {
    const n = buf.readUInt32BE(i), nome = buf.toString('ascii', i + 4, i + 8);
    const d = buf.subarray(i + 8, i + 8 + n);
    if (nome === 'IHDR') { larg = d.readUInt32BE(0); alt = d.readUInt32BE(4); prof = d[8]; tipo = d[9]; }
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
    const filtro = cru[o++];
    const lin = cru.subarray(o, o + passo); o += passo;
    const dst = linhas.subarray(y * passo, (y + 1) * passo);
    const ant = y > 0 ? linhas.subarray((y - 1) * passo, y * passo) : null;
    for (let x = 0; x < passo; x++) {
      const a = x >= canais ? dst[x - canais] : 0;
      const b = ant ? ant[x] : 0;
      const c = (ant && x >= canais) ? ant[x - canais] : 0;
      let v = lin[x];
      if (filtro === 1) v += a; else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      dst[x] = v & 255;
    }
  }
  return { larg, alt, canais, passo, linhas };
}

function media(buf) {
  const { larg, alt, canais, passo, linhas } = lerPNG(buf);
  let R = 0, G = 0, B = 0;
  const n = larg * alt;
  const px = [];
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      const k = y * passo + x * canais;
      const r = linhas[k], g = linhas[k + 1], bl = linhas[k + 2];
      R += r; G += g; B += bl;
      px.push([r * 0.299 + g * 0.587 + bl * 0.114, r, g, bl]);
    }
  }
  // Banda escura 5–30%: mesma definicao do azulprobe, onde o defeito e pior.
  px.sort((a, c) => a[0] - c[0]);
  let dr = 0, dg = 0, db = 0, dn = 0;
  for (let i = Math.floor(px.length * 0.05); i < Math.floor(px.length * 0.30); i++) {
    dr += px[i][1]; dg += px[i][2]; db += px[i][3]; dn++;
  }
  dn = dn || 1;
  return {
    r: +(R / n).toFixed(1), g: +(G / n).toFixed(1), b: +(B / n).toFixed(1),
    dAzul: +((B - R) / n).toFixed(1),
    escuro: { r: Math.round(dr / dn), g: Math.round(dg / dn), b: Math.round(db / dn), dAzul: +((db - dr) / dn).toFixed(1) },
  };
}

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForTimeout(2000);

await p.evaluate(() => {
  const S = window.__game.ctx.sky;
  S._envInterval = 1e9; S._cloudInterval = 1e9;
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
  window.__game.ctx.hud?.setVisible?.(false);
  window.__game.ctx.menu?.hideAll?.();
});

/* --- Acha asfalto no sol e asfalto na sombra, por geometria --------------- */
const alvos = await p.evaluate(() => {
  const ctx = window.__game.ctx, col = ctx.world.collision;
  const sd = ctx.sky.sunDirection;
  const baixo = { x: 0, y: -1, z: 0 };
  let sol = null, sombra = null;
  for (let x = -85; x <= 85 && (!sol || !sombra); x += 2) {
    for (let z = -85; z <= 85; z += 2) {
      const h = col.raycast({ x, y: 95, z }, baixo, 220);
      if (!h.hit || h.normal.y < 0.85 || h.surface !== 'asfalto') continue;
      const o = { x, y: h.point.y + 0.08, z };
      const s = col.raycast(o, { x: sd.x, y: sd.y, z: sd.z }, 140);
      if (!s.hit && !sol) sol = { x, y: h.point.y, z, livre: true };
      if (s.hit && !sombra) sombra = { x, y: h.point.y, z, livre: false };
      if (sol && sombra) break;
    }
  }
  return { sol, sombra };
});
console.log('asfalto no sol   :', JSON.stringify(alvos.sol));
console.log('asfalto na sombra:', JSON.stringify(alvos.sombra));

const CLIP = { x: 250, y: 190, width: 400, height: 300 };

const olharChao = async (q) => {
  await p.evaluate((c) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.camera.position.set(c.x + 0.6, c.y + 2.6, c.z + 0.6);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.rotation.set(-72 * Math.PI / 180, 40 * Math.PI / 180, 0, 'YXZ');
    ctx.camera.updateMatrixWorld(true);
    ctx.viewScene.visible = false;
    window.__game.settle(22);
  }, q);
  await p.waitForTimeout(200);
};

// Ceu: olha bem para cima, longe do sol, para provar que o ceu VISIVEL nao mudou.
const olharCeu = async () => {
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.camera.position.set(0, 60, 0);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.rotation.set(55 * Math.PI / 180, 120 * Math.PI / 180, 0, 'YXZ');
    ctx.camera.updateMatrixWorld(true);
    ctx.viewScene.visible = false;
    window.__game.settle(22);
  });
  await p.waitForTimeout(200);
};

const aplicar = (cfg) => p.evaluate((c) => {
  const ctx = window.__game.ctx, S = ctx.sky, L = ctx.lighting, u = ctx.postfx.pTonemap.uniforms;
  if (c.bounce !== undefined) S.bounceStrength = c.bounce;
  if (c.reach !== undefined) S.bounceReach = c.reach;
  if (c.chroma !== undefined) S.lightingChroma = c.chroma;
  if (c.mix !== undefined) L.bounceMix = c.mix;
  if (c.st) u.uShadowTint.value.fromArray(c.st);
  if (c.lift) u.uLift.value.fromArray(c.lift);
  if (c.gam) u.uGamma.value.fromArray(c.gam);
  // Regenera o mapa de ambiente AGORA (senao so entraria daqui a 96 frames).
  S._renderEnv();
  L._syncFromSky(true);
}, cfg);

const ANTIGO = { bounce: 0, chroma: 1, mix: 0 };
const VARIANTES = [
  { nome: 'ANTIGO (como estava)', cfg: ANTIGO },
  { nome: 'b0.6 c1.00 m0', cfg: { bounce: 0.6, chroma: 1.00, mix: 0 } },
  { nome: 'b0.0 c0.80 m0', cfg: { bounce: 0.0, chroma: 0.80, mix: 0 } },
  { nome: 'b0.0 c1.00 m0.25', cfg: { bounce: 0.0, chroma: 1.00, mix: 0.25 } },
  { nome: 'b0.0 c1.00 m0.45', cfg: { bounce: 0.0, chroma: 1.00, mix: 0.45 } },
  { nome: 'b0.6 c0.85 m0.25', cfg: { bounce: 0.6, chroma: 0.85, mix: 0.25 } },
  { nome: 'b0.8 c0.80 m0.30', cfg: { bounce: 0.8, chroma: 0.80, mix: 0.30 } },
  { nome: 'b1.0 c0.78 m0.35', cfg: { bounce: 1.0, chroma: 0.78, mix: 0.35 } },
  { nome: 'b1.0 c0.78 m0.35 r0.85', cfg: { bounce: 1.0, chroma: 0.78, mix: 0.35, reach: 0.85 } },
  { nome: 'b0.8 c0.80 m0.30 + grade sem teal', cfg: { bounce: 0.8, chroma: 0.80, mix: 0.30, st: [1.015, 1.0, 0.972], lift: [0, 0, 0], gam: [1, 1, 1] } },
  { nome: 'b1.0 c0.78 m0.35 + grade sem teal', cfg: { bounce: 1.0, chroma: 0.78, mix: 0.35, st: [1.015, 1.0, 0.972], lift: [0, 0, 0], gam: [1, 1, 1] } },
];

const col = (m) => `(${Math.round(m.r)},${Math.round(m.g)},${Math.round(m.b)}) ${String(m.dAzul).padStart(6)}`;
console.log('\n                                          --- asfalto ao SOL ---   --- asfalto na SOMBRA ---   ------ ceu ------');
console.log('variante                                  media          escuro    media          escuro      media');
console.log('-'.repeat(126));
for (const v of VARIANTES) {
  await aplicar({ bounce: 0.62, reach: 0.62, chroma: 0.74, mix: 0.50, st: [0.945, 0.985, 1.055], lift: [0, 0, 0.012], gam: [1, 1, 1.03], ...v.cfg });
  await olharChao(alvos.sol);
  const s1 = media(await p.screenshot({ clip: CLIP }));
  await olharChao(alvos.sombra);
  const s2 = media(await p.screenshot({ clip: CLIP }));
  await olharCeu();
  const s3 = media(await p.screenshot({ clip: CLIP }));
  console.log(
    v.nome.padEnd(42) +
    col(s1).padEnd(15) + String(s1.escuro.dAzul).padStart(7) + '   ' +
    col(s2).padEnd(15) + String(s2.escuro.dAzul).padStart(7) + '    ' +
    col(s3),
  );
}

await b.close();
