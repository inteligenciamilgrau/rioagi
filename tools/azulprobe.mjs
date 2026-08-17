/**
 * azulprobe.mjs — de onde vem o azul das superficies horizontais?
 *
 * Pergunta que este script responde com numero, e nao com opiniao: quando a rua
 * (ou a calcada, ou o telhado) aparece azul na tela, a culpa e do ALBEDO do
 * material ou da LUZ que cai nele?
 *
 * Metodo: fotografa a mesma pose duas vezes.
 *   A) iluminacao do jogo como esta
 *   B) contrafactual — cor do hemisferico forcada a neutro e IBL do ceu
 *      desligada, mantendo a mesma intensidade aproximada
 * Se o desvio azul (B-R) desaba de A para B, o azul e da luz. Se sobrevive,
 * e do material.
 *
 * Uso: node tools/azulprobe.mjs
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';

const PORT = process.env.PORT || 5199;

function medirPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('nao e PNG');
  let i = 8, larg = 0, alt = 0, prof = 0, tipo = 0;
  const pedacos = [];
  while (i < buf.length) {
    const n = buf.readUInt32BE(i), nome = buf.toString('ascii', i + 4, i + 8);
    const dados = buf.subarray(i + 8, i + 8 + n);
    if (nome === 'IHDR') {
      larg = dados.readUInt32BE(0); alt = dados.readUInt32BE(4); prof = dados[8]; tipo = dados[9];
    } else if (nome === 'IDAT') pedacos.push(dados);
    else if (nome === 'IEND') break;
    i += 12 + n;
  }
  if (prof !== 8 || (tipo !== 6 && tipo !== 2)) throw new Error(`so 8 bits RGB/RGBA (${prof}/${tipo})`);
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
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      dst[x] = v & 255;
    }
  }
  // Separa SOL de SOMBRA pelo proprio brilho: o quartil escuro do quadro e o
  // que esta so sob luz do ceu, e e ali que o azul aparece. Medir a media do
  // quadro inteiro mistura os dois regimes e esconde o defeito.
  const px = [];
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      const k = y * passo + x * canais;
      const r = linhas[k], g = linhas[k + 1], bl = linhas[k + 2];
      px.push([r * 0.299 + g * 0.587 + bl * 0.114, r, g, bl]);
    }
  }
  px.sort((a, c) => a[0] - c[0]);
  const faixa = (i0, i1) => {
    let R = 0, G = 0, B = 0, n = 0;
    for (let i = Math.floor(px.length * i0); i < Math.floor(px.length * i1); i++) {
      R += px[i][1]; G += px[i][2]; B += px[i][3]; n++;
    }
    n = n || 1;
    return { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), dAzul: +((B - R) / n).toFixed(1) };
  };
  return { sombra: faixa(0.05, 0.30), sol: faixa(0.70, 0.95), tudo: faixa(0, 1) };
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

// Onde estao as cores das luzes (para o relatorio)
const luzes = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const hx = (c) => '#' + c.getHexString();
  const L = ctx.lighting;
  return {
    hemiCeu: L?.hemi ? hx(L.hemi.color) : null,
    hemiChao: L?.hemi ? hx(L.hemi.groundColor) : null,
    hemiIntensidade: L?.hemi?.intensity ?? null,
    envIntensidade: ctx.scene.environmentIntensity ?? null,
    temEnv: !!ctx.scene.environment,
    solIntensidade: L?.dirs?.[0]?.intensity ?? L?.sun?.intensity ?? null,
  };
});
console.log('\n=== LUZES ===', JSON.stringify(luzes, null, 1));

const ALVOS = ['asfalto', 'calcada_portuguesa', 'telha_fibrocimento', 'terra'];

// Acha, para cada superficie, uma pose olhando direto para ela e de perto.
const poses = await p.evaluate((alvos) => {
  const ctx = window.__game.ctx;
  const col = ctx.world.collision;
  const lib = ctx.materials;
  const baixo = { x: 0, y: -1, z: 0 };
  const out = {};
  // varre o mapa procurando cada superficie virada para cima
  for (let x = -85; x <= 85; x += 2) {
    for (let z = -85; z <= 85; z += 2) {
      const h = col.raycast({ x, y: 95, z }, baixo, 220);
      if (!h.hit || h.normal.y < 0.80) continue;
      const nome = h.surface;
      const chave = nome === 'asfalto' ? 'asfalto' : nome === 'terra' ? 'terra' : null;
      if (chave && !out[chave]) out[chave] = { x, y: h.point.y, z };
    }
  }
  // calcada e telha: acha pelo material da malha
  const porMat = {};
  ctx.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      const n = lib?.getNomeSuperficie?.(m);
      if (!n || porMat[n] || !alvos.includes(n)) continue;
      o.geometry?.computeBoundingBox?.();
      const bb = o.geometry?.boundingBox; if (!bb) continue;
      porMat[n] = { x: (bb.min.x + bb.max.x) / 2, y: bb.max.y, z: (bb.min.z + bb.max.z) / 2 };
    }
  });
  for (const k of ['calcada_portuguesa', 'telha_fibrocimento']) if (porMat[k]) out[k] = porMat[k];
  return out;
}, ALVOS);

const neutralizar = async (ligado) => {
  await p.evaluate((neutro) => {
    const ctx = window.__game.ctx;
    const L = ctx.lighting;
    if (neutro) {
      window.__bk = {
        ceu: L.hemi.color.clone(), chao: L.hemi.groundColor.clone(),
        env: ctx.scene.environment, envI: ctx.scene.environmentIntensity,
      };
      // Mesma luminancia, crominancia zero: isola COR da luz de QUANTIDADE de luz.
      const l = 0.2126 * L.hemi.color.r + 0.7152 * L.hemi.color.g + 0.0722 * L.hemi.color.b;
      L.hemi.color.setRGB(l, l, l);
      const lg = 0.2126 * L.hemi.groundColor.r + 0.7152 * L.hemi.groundColor.g + 0.0722 * L.hemi.groundColor.b;
      L.hemi.groundColor.setRGB(lg, lg, lg);
      ctx.scene.environment = null;
      // compensa a perda do IBL com hemisferico equivalente
      L.hemi.intensity *= 2.2;
    } else if (window.__bk) {
      L.hemi.color.copy(window.__bk.ceu);
      L.hemi.groundColor.copy(window.__bk.chao);
      ctx.scene.environment = window.__bk.env;
      ctx.scene.environmentIntensity = window.__bk.envI;
      L.hemi.intensity /= 2.2;
    }
  }, ligado);
};

const olhar = async (q) => {
  await p.evaluate((c) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.camera.position.set(c.x + 0.6, c.y + 2.6, c.z + 0.6);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.rotation.set(-72 * Math.PI / 180, 40 * Math.PI / 180, 0, 'YXZ');
    ctx.camera.updateMatrixWorld(true);
    ctx.viewScene.visible = false;
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
    window.__game.settle(20);
  }, q);
  await p.waitForTimeout(250);
};

// Albedo do material, para comparar com o que sai na tela.
const albedos = await p.evaluate((alvos) => {
  const lib = window.__game.ctx.materials;
  const out = {};
  for (const n of alvos) {
    const d = lib.get(n)?.map?.image?.data; if (!d) continue;
    let R = 0, G = 0, B = 0; const c = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
    out[n] = { r: Math.round(R / c), g: Math.round(G / c), b: Math.round(B / c), dAzul: +((B - R) / c).toFixed(1) };
  }
  return out;
}, ALVOS);

const clip = { x: 220, y: 150, width: 460, height: 340 };
const res = {};
for (const [nome, q] of Object.entries(poses)) {
  await neutralizar(false);
  await olhar(q);
  res[nome] = medirPNG(await p.screenshot({ clip }));
}

console.log('\n=== O AZUL E DO MATERIAL OU DA LUZ? ===');
console.log('Compara o desvio azul (B-R) do ALBEDO com o da TELA, no sol e na sombra.');
console.log('Albedo quente (B-R negativo) virando tela fria (B-R positivo) = a luz esta azulando.\n');
console.log('superficie            albedo B-R    tela/sol B-R   tela/sombra B-R   deriva na sombra');
console.log('-'.repeat(94));
for (const [n, r] of Object.entries(res)) {
  const alb = albedos[n]?.dAzul ?? 0;
  const deriva = (r.sombra.dAzul - alb).toFixed(1);
  console.log(
    n.padEnd(22) +
    String(alb).padStart(9) + '  ' +
    `${r.sol.dAzul} (${r.sol.r},${r.sol.g},${r.sol.b})`.padStart(22) + '  ' +
    `${r.sombra.dAzul} (${r.sombra.r},${r.sombra.g},${r.sombra.b})`.padStart(22) +
    String(deriva).padStart(10),
  );
}

// ---------------------------------------------------------------------------
// Receita: qual ajuste de LUZ tira o azul da sombra sem apagar a hora do dia?
// Testa candidatos no proprio jogo e mede. Nada aqui e gravado — o arquivo e
// src/core/Lighting.js, que pertence ao CORE.
// ---------------------------------------------------------------------------
if (poses.asfalto) {
  const CANDIDATOS = [
    { nome: 'como esta hoje', ceu: null, env: null },
    { nome: 'ceu #a8c4e0 (menos saturado)', ceu: '#a8c4e0', env: null },
    { nome: 'ceu #b9c6d2 (quase neutro)', ceu: '#b9c6d2', env: null },
    { nome: 'ceu #8ec6ff + env 1.8', ceu: null, env: 1.8 },
    { nome: 'ceu #b9c6d2 + env 1.8', ceu: '#b9c6d2', env: 1.8 },
  ];
  console.log('\n=== RECEITA DE LUZ (nao aplicada — arquivo do CORE) ===');
  console.log('Alvo: asfalto na sombra com B-R perto de 0 e sem perder brilho.\n');
  console.log('ajuste                              sombra RGB        B-R');
  console.log('-'.repeat(66));
  for (const c of CANDIDATOS) {
    await p.evaluate((cfg) => {
      const ctx = window.__game.ctx, L = ctx.lighting;
      window.__orig ??= { ceu: L.hemi.color.getHexString(), env: ctx.scene.environmentIntensity };
      L.hemi.color.set(cfg.ceu ?? ('#' + window.__orig.ceu));
      ctx.scene.environmentIntensity = cfg.env ?? window.__orig.env;
    }, c);
    await olhar(poses.asfalto);
    const m = medirPNG(await p.screenshot({ clip }));
    console.log(c.nome.padEnd(36) + `(${m.sombra.r},${m.sombra.g},${m.sombra.b})`.padEnd(18) + String(m.sombra.dAzul).padStart(6));
  }
  await p.evaluate(() => {
    const ctx = window.__game.ctx, L = ctx.lighting;
    if (window.__orig) { L.hemi.color.set('#' + window.__orig.ceu); ctx.scene.environmentIntensity = window.__orig.env; }
  });
}

await b.close();
