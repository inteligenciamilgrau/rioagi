/**
 * chaofrio.mjs — de QUAL fonte de luz vem o azul do chao?
 *
 * azulprobe.mjs provou que o azul nao e do albedo. Este script vai um passo
 * adiante e decompoe a luz que chega no asfalto em sombra, apagando uma fonte
 * de cada vez e medindo o que sobra:
 *
 *   sol direcional (CSM) · hemisferica · IBL do ceu (scene.environment) · grade
 *
 * ARMADILHA que este script evita (e que invalidou a medicao anterior):
 * `Lighting.update()` roda em TODO frame, mesmo com o jogo pausado, e
 * `_syncFromSky()` reescreve `hemi.color`, `hemi.groundColor` e `hemi.intensity`
 * a partir do ceu. Mexer direto no objeto `THREE.HemisphereLight` e apagado
 * antes do proximo render — por isso "mexer em hemi.color nao move nada".
 * Aqui mexemos nos CAMPOS DE Lighting (hemiIntensity, envIntensity,
 * sunIntensity, corrigeChao...), que sobrevivem a sincronizacao.
 *
 * Uso: PORT=5200 node tools/chaofrio.mjs
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';

const PORT = process.env.PORT || 5199;

/* ------------------------------------------------------------------ */
/* Leitor de PNG + medicao por faixa de brilho (mesmo metodo do azulprobe) */
/* ------------------------------------------------------------------ */
function decodePNG(buf) {
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
  return { larg, alt, canais, passo, linhas };
}

export function medirPNG(buf) {
  const { larg, alt, canais, passo, linhas } = decodePNG(buf);
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

/* ------------------------------------------------------------------ */

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

const clip = { x: 220, y: 150, width: 460, height: 340 };

/* --- 1. Prova de que o sync do Lighting apaga mexidas no objeto de luz ---- */
const prova = await p.evaluate(async () => {
  const ctx = window.__game.ctx, L = ctx.lighting;
  const antes = L.hemi.color.getHexString();
  L.hemi.color.setRGB(1, 0, 0);
  const logo = L.hemi.color.getHexString();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const depois = L.hemi.color.getHexString();
  return { antes, logo, depois };
});
console.log('\n=== O sync do Lighting sobrescreve mexidas diretas na luz? ===');
console.log(`  hemi.color antes=${prova.antes}  escrito=${prova.logo}  apos 2 frames=${prova.depois}`);
console.log(`  VEREDITO: ${prova.depois === prova.logo ? 'sobrevive' : 'SOBRESCRITO -> testar via campos de Lighting'}`);

/* --- 2. Cores do ceu e das luzes ----------------------------------------- */
const luzes = await p.evaluate(() => {
  const ctx = window.__game.ctx, L = ctx.lighting, S = ctx.sky;
  const c = (x) => x ? [+x.r.toFixed(4), +x.g.toFixed(4), +x.b.toFixed(4)] : null;
  return {
    zenite: c(S.zenithColor), horizonte: c(S.horizonColor), sol: c(S.sunColor),
    elevacaoSol: +S.sunElevationDeg.toFixed(1), hora: S.hours,
    hemiCor: c(L.hemi.color), hemiChao: c(L.hemi.groundColor), hemiInt: +L.hemi.intensity.toFixed(3),
    solInt: +L.lights[0].intensity.toFixed(2), solCor: c(L.lights[0].color),
    envInt: ctx.scene.environmentIntensity,
    fog: c(ctx.scene.fog.color),
  };
});
console.log('\n=== CEU / LUZES (linear) ===');
for (const [k, v] of Object.entries(luzes)) console.log('  ' + k.padEnd(14), JSON.stringify(v));

// Razao B/R de cada fonte, para saber quem e o mais azul.
const br = (a) => a ? +(a[2] / Math.max(a[0], 1e-6)).toFixed(2) : null;
console.log('\n  B/R zenite=' + br(luzes.zenite), 'horizonte=' + br(luzes.horizonte),
  'sol=' + br(luzes.sol), 'hemiCor=' + br(luzes.hemiCor));

/* --- 3. Pose no asfalto -------------------------------------------------- */
const pose = await p.evaluate(() => {
  const col = window.__game.ctx.world.collision;
  const baixo = { x: 0, y: -1, z: 0 };
  for (let x = -85; x <= 85; x += 2) {
    for (let z = -85; z <= 85; z += 2) {
      const h = col.raycast({ x, y: 95, z }, baixo, 220);
      if (h.hit && h.normal.y >= 0.80 && h.surface === 'asfalto') return { x, y: h.point.y, z };
    }
  }
  return null;
});
if (!pose) { console.log('nao achei asfalto'); await b.close(); process.exit(1); }

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
  await p.waitForTimeout(220);
};

/* --- 4. Congela o ciclo do ceu ------------------------------------------- */
// `Sky.update()` regenera o mapa de ambiente a cada 96 frames e o
// `_regenerateEnvironment` do Lighting reescreve `scene.environment` e
// `scene.environmentIntensity`. Sem congelar isso, qualquer medicao que dure
// mais de ~1,6 s corre uma corrida com o proprio motor.
await p.evaluate(() => {
  const S = window.__game.ctx.sky;
  S._envInterval = 1e9; S._cloudInterval = 1e9;
  S._needsEnv = false; S._needsClouds = false;
});

/* --- 5. Decomposicao: apaga uma fonte por vez ---------------------------- */
// Tudo via CAMPOS de Lighting (sobrevivem ao _syncFromSky) e sem trocar
// `scene.environment` de null para nao-null, o que forcaria recompilacao de
// todos os programas no meio da medicao.
const VARIANTES = [
  { nome: 'BASE (como esta)', cfg: {} },
  { nome: 'sem SOL', cfg: { sol: 0 } },
  { nome: 'sem HEMISFERICA', cfg: { hemi: 0 } },
  { nome: 'sem IBL (envIntensity 0)', cfg: { env: 0 } },
  { nome: 'so SOL', cfg: { hemi: 0, env: 0 } },
  { nome: 'so HEMISFERICA', cfg: { sol: 0, env: 0 } },
  { nome: 'so IBL', cfg: { sol: 0, hemi: 0 } },
  { nome: 'tudo apagado (piso)', cfg: { sol: 0, hemi: 0, env: 0 } },
  { nome: 'grade NEUTRA (split-tone off)', cfg: { grade: 1 } },
  { nome: 'hemi.color forcado neutro', cfg: { hemiNeutro: 1 } },
  { nome: 'hemi.groundColor -> preto', cfg: { chaoPreto: 1 } },
  { nome: 'BASE de novo (controle)', cfg: {} },
];

console.log('\n=== DE ONDE VEM O AZUL DA SOMBRA DO ASFALTO ===');
console.log('variante                          sombra RGB          B-R      G-R       sol RGB          B-R   media crop');
console.log('-'.repeat(120));

await p.evaluate(() => {
  const ctx = window.__game.ctx, L = ctx.lighting;
  window.__sv = {
    sunI: L.sunIntensity, hemiI: L.hemiIntensity, envI: L.envIntensity,
    envInt: ctx.scene.environmentIntensity,
    st: ctx.postfx.pTonemap.uniforms.uShadowTint.value.clone(),
    ht: ctx.postfx.pTonemap.uniforms.uHighlightTint.value.clone(),
    lift: ctx.postfx.pTonemap.uniforms.uLift.value.clone(),
    gam: ctx.postfx.pTonemap.uniforms.uGamma.value.clone(),
    gain: ctx.postfx.pTonemap.uniforms.uGain.value.clone(),
  };
  // Gancho para forcar a cor da hemisferica DEPOIS do sync (a unica maneira de
  // testar hemi.color sem que o _syncFromSky apague na hora).
  window.__hemiHack = null;
  const orig = L._syncFromSky.bind(L);
  L._syncFromSky = function (force) {
    orig(force);
    const h = window.__hemiHack;
    if (h === 'neutro') {
      const c = L.hemi.color;
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      c.setRGB(l, l, l);
    } else if (h === 'chaoPreto') {
      L.hemi.groundColor.setRGB(0, 0, 0);
    }
  };
});

for (const v of VARIANTES) {
  await p.evaluate((cfg) => {
    const ctx = window.__game.ctx, L = ctx.lighting, s = window.__sv;
    const u = ctx.postfx.pTonemap.uniforms;
    // restaura
    L.sunIntensity = s.sunI; L.hemiIntensity = s.hemiI; L.envIntensity = s.envI;
    ctx.scene.environmentIntensity = s.envInt;
    u.uShadowTint.value.copy(s.st); u.uHighlightTint.value.copy(s.ht);
    u.uLift.value.copy(s.lift); u.uGamma.value.copy(s.gam); u.uGain.value.copy(s.gain);
    window.__hemiHack = null;
    // aplica
    if (cfg.sol !== undefined) L.sunIntensity = cfg.sol;
    if (cfg.hemi !== undefined) L.hemiIntensity = cfg.hemi;
    if (cfg.env !== undefined) { L.envIntensity = cfg.env; ctx.scene.environmentIntensity = cfg.env; }
    if (cfg.grade) {
      u.uShadowTint.value.set(1, 1, 1); u.uHighlightTint.value.set(1, 1, 1);
      u.uLift.value.set(0, 0, 0); u.uGamma.value.set(1, 1, 1); u.uGain.value.set(1, 1, 1);
    }
    if (cfg.hemiNeutro) window.__hemiHack = 'neutro';
    if (cfg.chaoPreto) window.__hemiHack = 'chaoPreto';
  }, v.cfg);
  await olhar(pose);
  const m = medirPNG(await p.screenshot({ clip }));
  console.log(
    v.nome.padEnd(32) +
    `(${m.sombra.r},${m.sombra.g},${m.sombra.b})`.padEnd(18) +
    String(m.sombra.dAzul).padStart(6) +
    String(+(m.sombra.g - m.sombra.r).toFixed(1)).padStart(9) + '   ' +
    `(${m.sol.r},${m.sol.g},${m.sol.b})`.padEnd(18) + String(m.sol.dAzul).padStart(6) +
    `   (${m.tudo.r},${m.tudo.g},${m.tudo.b})`,
  );
}

await b.close();
