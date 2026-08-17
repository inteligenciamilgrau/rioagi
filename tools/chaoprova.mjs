/**
 * chaoprova.mjs — prova medida do azul do chao, superficie por superficie.
 *
 * O melhor alvo de validacao do mapa e a CALCADA PORTUGUESA: pedra portuguesa
 * e basalto PRETO com calcario BRANCO, e o albedo dela ja foi medido e esta
 * certo (contraste 111, o maior do conjunto). Se depois da correcao ela voltar
 * a ler preto-e-branco, a causa foi acertada. Se continuar azul-e-branca, nao
 * foi — independentemente do que o numero do asfalto disser.
 *
 * Por isso este script mede as faixas CLARA e ESCURA separadamente: numa
 * superficie de dois tons, a media esconde exatamente o que interessa.
 *
 * Camera a pino (pitch -88) sobre o alvo: o recorte inteiro e a superficie,
 * sem parede nem ceu contaminando a media.
 *
 * Uso: PORT=5200 node tools/chaoprova.mjs [nome-da-variante]
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.env.PORT || 5199;
const SO = process.argv[2] || null;

function lerPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('nao e PNG');
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

function medir(buf) {
  const { larg, alt, canais, passo, linhas } = lerPNG(buf);
  const px = [];
  let R = 0, G = 0, B = 0;
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      const k = y * passo + x * canais;
      const r = linhas[k], g = linhas[k + 1], bl = linhas[k + 2];
      R += r; G += g; B += bl;
      px.push([r * 0.299 + g * 0.587 + bl * 0.114, r, g, bl]);
    }
  }
  const n = px.length;
  px.sort((a, c) => a[0] - c[0]);
  const faixa = (i0, i1) => {
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = Math.floor(n * i0); i < Math.floor(n * i1); i++) { r += px[i][1]; g += px[i][2]; b += px[i][3]; c++; }
    c = c || 1;
    return { r: Math.round(r / c), g: Math.round(g / c), b: Math.round(b / c), dAzul: +((b - r) / c).toFixed(1) };
  };
  return {
    media: { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), dAzul: +((B - R) / n).toFixed(1) },
    escuro: faixa(0.05, 0.30),
    claro: faixa(0.70, 0.95),
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
  const ctx = window.__game.ctx;
  ctx.sky._envInterval = 1e9; ctx.sky._cloudInterval = 1e9;
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
  ctx.hud?.setVisible?.(false); ctx.menu?.hideAll?.();
});

/* --- Alvos: asfalto e calcada, ao sol e na sombra ------------------------- */
const alvos = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const col = ctx.world.collision, lib = ctx.materials, sd = ctx.sky.sunDirection;
  // Candidatos por superficie; quem e sol e quem e sombra so se decide DEPOIS,
  // medindo o brilho na tela. O raio ate o sol usa a malha simplificada de
  // colisao, que nao tem todos os beirais — sozinho ele erra o rotulo.
  const cand = { asfalto: [], calcada_portuguesa: [] };
  const vistos = new Set();
  const guardar = (nome, x, z) => {
    const chave = nome + x + '_' + z;
    if (vistos.has(chave)) return;
    const h = col.raycast({ x, y: 95, z }, { x: 0, y: -1, z: 0 }, 220);
    if (!h.hit || h.normal.y < 0.90) return;
    vistos.add(chave);
    const s = col.raycast({ x, y: h.point.y + 0.35, z }, { x: sd.x, y: sd.y, z: sd.z }, 160);
    cand[nome].push({ x, y: h.point.y, z, livre: !s.hit, d: x * x + z * z });
  };

  // Asfalto: o BVH ja carrega a superficie por face.
  for (let x = -80; x <= 80; x += 2) {
    for (let z = -80; z <= 80; z += 2) {
      const h = col.raycast({ x, y: 95, z }, { x: 0, y: -1, z: 0 }, 220);
      if (h.hit && h.normal.y >= 0.90 && h.surface === 'asfalto') guardar('asfalto', x, z);
    }
  }

  // Calcada: a colisao nao a distingue de concreto, entao achamos pelas malhas
  // que usam o material e amostramos vertices delas.
  const v = new ctx.camera.position.constructor();
  ctx.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (lib.getNomeSuperficie(o.material) !== 'calcada_portuguesa') return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const passo = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += passo) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      guardar('calcada_portuguesa', Math.round(v.x), Math.round(v.z));
    }
  });

  // Telhado de fibrocimento: nao esta no chao, entao a camera vai direto para
  // cima dele. E o segundo teste de "so o que aponta para cima ficou azul".
  cand.telha_fibrocimento = [];
  const nrm = new ctx.camera.position.constructor();
  ctx.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some((m) => lib.getNomeSuperficie(m) === 'telha_fibrocimento')) return;
    const pos = o.geometry.getAttribute('position');
    const nor = o.geometry.getAttribute('normal');
    if (!pos || !nor) return;
    const passo = Math.max(1, Math.floor(pos.count / 200));
    for (let i = 0; i < pos.count; i += passo) {
      nrm.fromBufferAttribute(nor, i).transformDirection(o.matrixWorld);
      if (nrm.y < 0.80) continue;                        // so o que aponta p/ cima
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const s = col.raycast({ x: v.x, y: v.y + 0.25, z: v.z }, { x: sd.x, y: sd.y, z: sd.z }, 160);
      cand.telha_fibrocimento.push({ x: v.x, y: v.y, z: v.z, livre: !s.hit, d: v.x * v.x + v.z * v.z });
    }
  });
  // Poucos candidatos, espalhados: metade com raio de sol livre, metade sem.
  const escolher = (lista) => {
    const livres = lista.filter((c) => c.livre).sort((a, b) => a.d - b.d);
    const tapados = lista.filter((c) => !c.livre).sort((a, b) => a.d - b.d);
    const pega = (arr, n) => {
      const passo = Math.max(1, Math.floor(arr.length / n));
      const out = [];
      for (let i = 0; i < arr.length && out.length < n; i += passo) out.push(arr[i]);
      return out;
    };
    return [...pega(livres, 5), ...pega(tapados, 3)];
  };
  const out = {};
  for (const k of Object.keys(cand)) out[k] = escolher(cand[k]);
  return out;
});

const CLIP = { x: 300, y: 200, width: 300, height: 220 };
const ALTURA = 2.0;

const olhar = async (q) => {
  await p.evaluate((c) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.camera.position.set(c.x, c.y + c.h, c.z);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.rotation.set(-88 * Math.PI / 180, 25 * Math.PI / 180, 0, 'YXZ');
    ctx.camera.updateMatrixWorld(true);
    ctx.viewScene.visible = false;
    window.__game.settle(22);
  }, { ...q, h: ALTURA });
  await p.waitForTimeout(200);
};

const aplicar = (cfg) => p.evaluate((c) => {
  const ctx = window.__game.ctx, S = ctx.sky, L = ctx.lighting, u = ctx.postfx.pTonemap.uniforms;
  if (c.bounce !== undefined) S.bounceStrength = c.bounce;
  if (c.reach !== undefined) S.bounceReach = c.reach;
  if (c.gain !== undefined) S.bounceGain = c.gain;
  if (c.chroma !== undefined) S.lightingChroma = c.chroma;
  if (c.alb) S.morroAlbedo.setRGB(c.alb[0], c.alb[1], c.alb[2]);
  if (c.mix !== undefined) L.bounceMix = c.mix;
  if (c.st) u.uShadowTint.value.fromArray(c.st);
  if (c.ht) u.uHighlightTint.value.fromArray(c.ht);
  if (c.lift) u.uLift.value.fromArray(c.lift);
  if (c.gam) u.uGamma.value.fromArray(c.gam);
  S._computeSunParams();
  S._pushUniforms();
  S._renderEnv();
  L._syncFromSky(true);
}, cfg);

/* --- Rotula sol/sombra MEDINDO, com a luz antiga --------------------------- */
const ANTES_ROT = { bounce: 0, chroma: 1, mix: 0, gain: 0.62, reach: 0.78, st: [0.945, 0.985, 1.055], ht: [1.075, 1.005, 0.912], lift: [0, 0, 0.012], gam: [1, 1, 1.03] };
await p.evaluate((c) => {
  const ctx = window.__game.ctx, S = ctx.sky, L = ctx.lighting, u = ctx.postfx.pTonemap.uniforms;
  S.bounceStrength = c.bounce; S.lightingChroma = c.chroma; L.bounceMix = c.mix;
  u.uShadowTint.value.fromArray(c.st); u.uHighlightTint.value.fromArray(c.ht);
  u.uLift.value.fromArray(c.lift); u.uGamma.value.fromArray(c.gam);
  S._renderEnv(); L._syncFromSky(true);
}, ANTES_ROT);

const escolhidos = {};
console.log('=== ESCOLHA DOS ALVOS (luminancia medida com a luz antiga) ===');
for (const [nome, lista] of Object.entries(alvos)) {
  if (!lista || !lista.length) { console.log(`  ${nome}: SEM CANDIDATOS — pulando`); continue; }
  const medidos = [];
  for (const c of lista) {
    await olhar(c);
    const m = medir(await p.screenshot({ clip: CLIP }));
    const lum = 0.299 * m.media.r + 0.587 * m.media.g + 0.114 * m.media.b;
    medidos.push({ c, lum: +lum.toFixed(1), m });
    console.log(`  ${nome.padEnd(20)} (${String(c.x).padStart(3)},${String(c.z).padStart(4)})  raioSol=${c.livre ? 'livre ' : 'tapado'}  lum=${lum.toFixed(1)}`);
  }
  medidos.sort((a, b) => b.lum - a.lum);
  escolhidos[nome + ':sol'] = medidos[0].c;
  escolhidos[nome + ':sombra'] = medidos[medidos.length - 1].c;
}
console.log('\n=== ALVOS ESCOLHIDOS ===');
for (const [k, v] of Object.entries(escolhidos)) console.log('  ' + k.padEnd(28) + `(${v.x}, ${v.y.toFixed(2)}, ${v.z})`);
Object.assign(alvos, escolhidos);

// Estado "antigo" = tudo desligado + grade com sombra teal, como era.
const ANTIGO = { bounce: 0, chroma: 1, mix: 0, gain: 1.30, reach: 0.90, alb: [0.62, 0.42, 0.30], st: [0.945, 0.985, 1.055], ht: [1.075, 1.005, 0.912], lift: [0, 0, 0.012], gam: [1, 1, 1.03] };
const GRADE_NOVA = { st: [1.012, 1.0, 0.978], ht: [1.07, 1.005, 0.918], lift: [0, 0, 0], gam: [1, 1, 1] };

// Grade: G0 = como era (sombra puxada para o teal). G1 = sem tinta nenhuma na
// sombra (deixa a fisica decidir). G2 = leve quente.
const G3 = { st: [0.985, 0.998, 1.015], ht: [1.075, 1.005, 0.912], lift: [0, 0, 0], gam: [1, 1, 1] };
const G1 = { st: [1, 1, 1], ht: [1.075, 1.005, 0.912], lift: [0, 0, 0], gam: [1, 1, 1] };
const G2 = GRADE_NOVA;
const ALB = [0.55, 0.44, 0.34];
let VARIANTES = [
  { nome: 'ANTIGO', cfg: ANTIGO },
  // Cada perna da correcao isolada, para o relatorio atribuir credito.
  { nome: '+ casario no IBL', cfg: { ...ANTIGO, bounce: 0.66, alb: ALB } },
  { nome: '+ croma do ceu', cfg: { ...ANTIGO, bounce: 0.66, chroma: 0.83, alb: ALB } },
  { nome: '+ hemisferica', cfg: { ...ANTIGO, bounce: 0.66, chroma: 0.83, mix: 0.30, alb: ALB } },
  { nome: '+ grade sem teal = CODIGO', cfg: { ...ANTIGO, bounce: 0.66, chroma: 0.83, mix: 0.30, alb: ALB, ...G1 } },
];
void G2; void G3;
if (SO) VARIANTES = VARIANTES.filter((v) => v.nome.includes(SO));

const ordem = ['asfalto:sombra', 'calcada_portuguesa:sombra', 'telha_fibrocimento:sombra', 'asfalto:sol', 'calcada_portuguesa:sol', 'telha_fibrocimento:sol'];
console.log('\nB-R por faixa.  Alvo: perto de 0 ou levemente NEGATIVO (o albedo das duas e quente).');
console.log('Calcada: a faixa CLARA e o calcario branco, a ESCURA e o basalto preto.\n');
let cab = 'variante'.padEnd(26);
for (const k of ordem) cab += k.replace('calcada_portuguesa', 'calcada').replace('asfalto', 'asf').padEnd(26);
console.log(cab);
console.log('                          ' + 'med/esc/cla   '.padEnd(26).repeat(ordem.length));
console.log('-'.repeat(130));

const guarda = {};
for (const v of VARIANTES) {
  await aplicar(v.cfg);
  let linha = v.nome.padEnd(26);
  guarda[v.nome] = {};
  for (const k of ordem) {
    if (!alvos[k]) { linha += '(sem alvo)'.padEnd(26); continue; }
    await olhar(alvos[k]);
    const m = medir(await p.screenshot({ clip: CLIP }));
    guarda[v.nome][k] = m;
    linha += `${String(m.media.dAzul).padStart(6)} ${String(m.escuro.dAzul).padStart(6)} ${String(m.claro.dAzul).padStart(6)}`.padEnd(26);
  }
  console.log(linha);
}

console.log('\nRGB detalhado (media / escuro / claro):');
for (const [nome, alvo] of Object.entries(guarda)) {
  console.log('  ' + nome);
  for (const [k, m] of Object.entries(alvo)) {
    console.log('    ' + k.padEnd(26) +
      `med(${m.media.r},${m.media.g},${m.media.b})`.padEnd(20) +
      `esc(${m.escuro.r},${m.escuro.g},${m.escuro.b})`.padEnd(20) +
      `cla(${m.claro.r},${m.claro.g},${m.claro.b})`);
  }
}

mkdirSync('shots', { recursive: true });
writeFileSync('shots/chaoprova.json', JSON.stringify(guarda, null, 1));
await b.close();
