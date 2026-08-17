/**
 * generators/telhado.js — telha colonial de barro e telha ondulada de fibrocimento.
 * Dono: MAT.
 *
 * Os dois telhados que cobrem 100% da favela. Vistos de cima e de longe o tempo todo,
 * então o que importa é a silhueta do relevo (normal forte) e a mancha de limo.
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, campoMusgo, campoSol,
  dGrao, dGraoFino, dCel, dCelF1, dCelId, dRiscoV, dRiscoH, dFbm, dMancha,
  dEscorrimento,
  hex, sujar, MUSGO, CIMENTO,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

const _rgb = new Float32Array(3);

const BARRO_CLARO = hex('#c07242');
const BARRO_MEDIO = hex('#9d5330');
const BARRO_ESCURO = hex('#6d3a24');
const LIQUEN = [0.62, 0.63, 0.55];   // líquen branco-esverdeado, muito comum no Rio

// ===========================================================================
// TELHA DE BARRO (colonial capa-e-canal)
// ===========================================================================

/**
 * Tile: 6 pares capa/canal na horizontal (1,68 m) × 4 fiadas (1,40 m).
 * A superfície é dominada pelo perfil semicilíndrico — o normal map faz quase
 * todo o trabalho, daí `normalForca` alto.
 */
export async function gerarTelhaBarro(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 7703;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const PARES = 6;      // capa+canal por tile
  const FIADAS = 4;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fSol = campoSol(lab, N, semente + 5);
  const fLimo = assar(lab, N, (u, v) =>
    smoothstep(0.42, 0.76, dMancha(det, u, v, 2, 0.07, 0.31)));
  // Líquen: manchas circulares esbranquiçadas
  const fLiquen = assar(lab, N, (u, v) => {
    const disco = 1 - smoothstep(0.15, 0.45, dCelF1(det, u, v, 1, 0.53, 0.19));
    const id = dCelId(det, u, v, 1, 0.53, 0.19);
    const recorte = smoothstep(0.42, 0.62, dFbm(det, u, v, 2, 0.13, 0.71));
    return clamp01(disco * recorte * (id > 0.45 ? 1 : 0));
  });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    const gy = v * FIADAS;
    const fiada = wrapi(gy | 0, FIADAS);
    const fy = gy - (gy | 0);
    // Degrau da sobreposição: a telha de cima cobre a de baixo (sombra na beirada).
    const degrau = (1 - smoothstep(0.02, 0.10, fy)) * 0.16;

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const gx = u * PARES;
      const par = wrapi(gx | 0, PARES);
      const fx = gx - (gx | 0);

      const hp = hash2f(par, fiada, semente);
      const hp2 = hash2f(par, fiada, semente + 991);

      // Perfil: metade canal (côncavo), metade capa (convexo).
      let perfil, ehCapa;
      if (fx < 0.5) {
        const t = Math.abs(fx * 2 - 0.5) * 2;
        ehCapa = 0;
        perfil = 0.30 + 0.26 * (t * Math.sqrt(t));   // ≈ t^1.7, sem pow()
      } else {
        const t = (fx - 0.5) * 2;
        ehCapa = 1;
        perfil = 0.44 + 0.52 * Math.sin(Math.PI * t);
      }

      const desnivel = (hp - 0.5) * 0.055 + (hp2 - 0.5) * 0.03 * (1 - fy);
      // Micro: barro extrudado, com ondulações longitudinais e poros
      const micro = dGrao(det, u, v, L(12)) * 0.055 + dRiscoV(det, u, v, L(2)) * 0.045;

      let quebrou = 0;
      if (hp2 > 0.94) {
        const qx = fx - (hp > 0.5 ? 1 : 0), qy = fy - 1;
        quebrou = smoothstep(0.30, 0.0, Math.sqrt(qx * qx + qy * qy));
      }

      let hgt = perfil + desnivel + micro - degrau;
      hgt += (hgt * 0.55 - hgt) * quebrou;
      altura[i] = clamp01(hgt);

      const macro = ler(fMacro, N, u, v);
      const sol = ler(fSol, N, u, v);
      // O limo prefere o fundo do canal (perfil baixo) e a sombra da beirada
      const fundo = 1 - smoothstep(0.32, 0.75, perfil);
      const limo = clamp01(ler(fLimo, N, u, v) * (0.35 + fundo * 1.3));
      const liquen = ler(fLiquen, N, u, v) * (0.5 + ehCapa * 0.7);

      // --- albedo ---
      const t = clamp01(hp * 0.8 + macro * 0.5 - 0.15);
      let ca, cb, tt;
      if (t < 0.5) { ca = BARRO_ESCURO; cb = BARRO_MEDIO; tt = t * 2; }
      else { ca = BARRO_MEDIO; cb = BARRO_CLARO; tt = (t - 0.5) * 2; }
      let r = ca[0] + (cb[0] - ca[0]) * tt;
      let g = ca[1] + (cb[1] - ca[1]) * tt;
      let b = ca[2] + (cb[2] - ca[2]) * tt;

      const gm = dGrao(det, u, v, L(12), 0.23, 0.67);
      const l = 0.88 + gm * 0.24;
      r *= l; g *= l; b *= l;

      // Sol desbota o topo da capa (onde bate direto)
      const exposto = sol * (0.4 + ehCapa * 0.6) * smoothstep(0.5, 0.95, perfil);
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      const ex = exposto * 0.45;
      r += (luma * 1.26 + 0.08 - r) * ex;
      g += (luma * 1.20 + 0.08 - g) * ex;
      b += (luma * 1.14 + 0.09 - b) * ex;

      // Líquen — a mancha esbranquiçada que todo telhado velho tem
      const lq = liquen * 0.80;
      r += (LIQUEN[0] - r) * lq; g += (LIQUEN[1] - g) * lq; b += (LIQUEN[2] - b) * lq;
      // Limo verde escuro no canal
      const lm = limo * 0.82;
      r += (MUSGO[0] - r) * lm; g += (MUSGO[1] - g) * lm; b += (MUSGO[2] - b) * lm;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(degrau * 2.2 + macro * 0.16 + fundo * 0.14));
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // --- rugosidade ---
      let rug = 0.76 + (gm - 0.5) * 0.16;
      rug += (0.97 - rug) * (limo * 0.85);
      rug += (0.90 - rug) * (liquen * 0.7);
      rug += (0.60 - rug) * (exposto * 0.25);     // barro calcinado meio vitrificado
      rugosidade[i] = clamp(rug, 0.40, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fSol, fLimo, fLiquen]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 4.2,
    aoRaioLargo: 22, aoRaioFino: 4, aoForca: 1.4,
    props: {},
  };
}

// ===========================================================================
// TELHA DE FIBROCIMENTO (Brasilit ondulada)
// ===========================================================================

/**
 * Onda senoidal de ~17,7 cm de passo, cinza-cimento manchado, muito musgo.
 * Tile: 1,42 m (8 ondas) × 1,40 m.
 */
export async function gerarTelhaFibrocimento(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 8803;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade, metalico } = alvo;

  const ONDAS = 8;
  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fMusgo = assar(lab, N, (u, v) =>
    smoothstep(0.46, 0.80, dMancha(det, u, v, 2, 0.31, 0.07)));
  // Placas mais claras/escuras: as telhas foram trocadas em épocas diferentes
  const fLote = assar(lab, N, (u, v) => dFbm(det, u, v, 1, 0.11, 0.83));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;
  const TAU = Math.PI * 2;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    // Emenda horizontal entre placas (transpasse)
    const gy = v * 2;
    const fy = gy - (gy | 0);
    const emenda = (1 - smoothstep(0.0, 0.035, fy)) * 0.10;

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      // O perfil real da telha ondulada é quase perfeitamente senoidal.
      const onda = Math.sin(u * ONDAS * TAU);
      const vale = 1 - (onda * 0.5 + 0.5);        // 1 no fundo da calha

      // Micro do fibrocimento: fibras de celulose prensadas + poros grossos
      const fibra = dRiscoH(det, u, v, L(4));
      const poros = dCel(det, u, v, L(8), 0.17, 0.53);
      const micro = fibra * 0.05 + poros * 0.06 + dGraoFino(det, u, v, L(3)) * 0.03;

      // Parafuso com arruela de vedação no topo das ondas, a cada duas ondas
      const ondaIdx = (u * ONDAS) | 0;
      let parafuso = 0;
      if ((ondaIdx & 1) === 0) {
        const du = (u - (ondaIdx + 0.25) / ONDAS) * 8;
        const dv = (v - 0.5) * 8;
        parafuso = 1 - smoothstep(0.05, 0.085, Math.sqrt(du * du + dv * dv));
      }

      const macro = ler(fMacro, N, u, v);
      const musgo = clamp01(ler(fMusgo, N, u, v) * (0.30 + vale * 1.4));
      const lote = ler(fLote, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.07, 0) * (0.4 + vale * 0.9);

      let hgt = 0.50 + onda * 0.34 + micro - emenda;
      hgt -= parafuso * 0.10;
      altura[i] = clamp01(hgt);

      // Cor: cimento cinza levemente esverdeado, lote mais claro ou mais escuro
      const base = 0.46 + (lote - 0.5) * 0.16 + (macro - 0.5) * 0.10 + poros * 0.10;
      _rgb[0] = base; _rgb[1] = base * 1.005; _rgb[2] = base * 0.98;
      sujar(_rgb, clamp01(escorre * 0.42 + macro * 0.18 + emenda * 2.0));
      let r = _rgb[0], g = _rgb[1], b = _rgb[2];
      // Musgo — em telhado de fibrocimento é sempre muito
      const m = musgo * 0.62;
      r += (MUSGO[0] - r) * m; g += (MUSGO[1] - g) * m; b += (MUSGO[2] - b) * m;
      if (parafuso > 0.05) {
        const p = parafuso * 0.85;
        r += (0.34 - r) * p; g += (0.28 - g) * p; b += (0.22 - b) * p;
      }
      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      let rug = 0.88 + (poros - 0.5) * 0.10;
      rug += (0.97 - rug) * (musgo * 0.85);
      rug += (0.66 - rug) * (escorre * 0.35);
      rug += (0.45 - rug) * (parafuso * 0.7);
      rugosidade[i] = clamp(rug, 0.35, 1);
      metalico[i] = parafuso > 0.5 ? 0.85 : 0;
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo, fLote]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 3.4,
    aoRaioLargo: 18, aoRaioFino: 3.5, aoForca: 1.2,
    props: {},
  };
}
