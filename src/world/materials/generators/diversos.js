/**
 * generators/diversos.js — vidro sujo, pano de varal/toldo, borracha e plástico.
 * Dono: MAT.
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, campoMusgo,
  dGrao, dGraoFino, dCel, dRiscoV, dRiscoH, dFbm, dMancha, dRidged,
  dEscorrimento,
  hex, sujar, MUSGO,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

const _rgb = new Float32Array(3);

// ===========================================================================
// VIDRO — janela suja de favela (nunca vidro limpo de showroom)
// ===========================================================================

export async function gerarVidro(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 5227;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fSujeira = assar(lab, N, (u, v) => clamp01(
    dMancha(det, u, v, 1, 0.03, 0.37) * 0.8 + (1 - smoothstep(0, 0.4, v)) * 0.4));
  // Trinca radial de pedrada, centrada fora do meio para não parecer simétrica
  const fTrinca = assar(lab, N, (u, v) => {
    const dx = u - 0.62, dy = v - 0.44;
    const ang = Math.atan2(dy, dx);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const raios = Math.abs(Math.sin(ang * 7 + dFbm(det, u, v, 2, 0.11, 0.29) * 6));
    const radial = (1 - smoothstep(0, 0.10, raios)) *
      smoothstep(0.02, 0.10, dist) * (1 - smoothstep(0.18, 0.38, dist));
    const anel = 1 - smoothstep(0, 0.012, Math.abs(dist - 0.13));
    return clamp01(radial + anel * 0.7);
  });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const sujeira = ler(fSujeira, N, u, v);
      const trinca = ler(fTrinca, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(2), 0.43, 0);

      // Ondulação do vidro plano barato — é o que denuncia vidro real no reflexo
      const ondulacao = dFbm(det, u, v, L(1), 0.19, 0.71);
      const micro = dGraoFino(det, u, v, L(3));

      altura[i] = clamp01(0.62 + (ondulacao - 0.5) * 0.10 + (micro - 0.5) * 0.02 - trinca * 0.30);

      // Albedo de vidro é quase preto — o que se vê é reflexo e sujeira depositada.
      const poeira = clamp01(sujeira * 0.55 + escorre * 0.35);
      let r = 0.035 + poeira * 0.30;
      let g = 0.052 + poeira * 0.29;    // leve tom esverdeado do vidro float
      let b = 0.048 + poeira * 0.26;
      const tk = trinca * 0.7;
      r += (0.72 - r) * tk; g += (0.73 - g) * tk; b += (0.75 - b) * tk;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      let rug = 0.035 + (micro - 0.5) * 0.02;
      rug += (0.42 - rug) * (poeira * 0.85);
      rug += (0.60 - rug) * (trinca * 0.8);
      rugosidade[i] = clamp(rug, 0.02, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fSujeira, fTrinca]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 0.45,
    aoRaioLargo: 6, aoRaioFino: 2, aoForca: 0.35,
    props: {},
  };
}

// ===========================================================================
// PANO — lençol de varal / lona de toldo
// ===========================================================================

export async function gerarPano(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 6329;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const cor = o.cor || hex('#c8503f');
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const FIOS = 96;     // fios por tile de ~35 cm ⇒ trama visível de perto
  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 3);
  const fManchas = assar(lab, N, (u, v) =>
    smoothstep(0.60, 0.82, dMancha(det, u, v, 2, 0.13, 0.59)));
  const fSol = assar(lab, N, (u, v) => dFbm(det, u, v, 1, 0.71, 0.23));
  const fPuido = assar(lab, N, (u, v) =>
    smoothstep(0.78, 0.93, dMancha(det, u, v, 3, 0.37, 0.11)));
  // Dobras suaves do pano pendurado
  const fDobras = assar(lab, N, (u, v) => dFbm(det, u, v, 1, 0.29, 0.83));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    const gv = v * FIOS;
    const cv = gv | 0;
    const fv = gv - cv;
    const perfilVfio = Math.sin(fv * Math.PI);

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      // Trama tafetá: urdume e trama alternando por cima e por baixo.
      const gu = u * FIOS;
      const cu = gu | 0;
      const fu = gu - cu;
      const perfilU = Math.sin(fu * Math.PI);
      const acima = ((cu + cv) & 1) === 0;
      const fio = acima ? perfilU : perfilVfio;
      const fioBaixo = acima ? perfilVfio : perfilU;
      const trama = fio * 0.78 + fioBaixo * 0.22;

      const irreg = dGrao(det, u, v, L(12));     // algodão nunca é uniforme
      const macro = ler(fMacro, N, u, v);
      const manchas = ler(fManchas, N, u, v);
      const sol = ler(fSol, N, u, v);
      const puido = ler(fPuido, N, u, v);
      const dobras = ler(fDobras, N, u, v);

      let hgt = 0.45 + trama * 0.34 + (irreg - 0.5) * 0.08 + (dobras - 0.5) * 0.18;
      hgt -= puido * 0.25;
      altura[i] = clamp01(hgt);

      // Tecido: cor forte desbotada pelo sol e pela lavagem
      const lumaC = cor[0] * 0.299 + cor[1] * 0.587 + cor[2] * 0.114;
      const desbota = clamp01(sol * 0.85 + macro * 0.3) * 0.55;
      let r = cor[0] + (lumaC * 1.30 + 0.16 - cor[0]) * desbota;
      let g = cor[1] + (lumaC * 1.26 + 0.16 - cor[1]) * desbota;
      let b = cor[2] + (lumaC * 1.22 + 0.17 - cor[2]) * desbota;
      // Sombreamento da trama: o fio de baixo fica na sombra do de cima
      const lum = 0.68 + trama * 0.45 + (irreg - 0.5) * 0.18;
      r *= lum; g *= lum; b *= lum;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(manchas * 0.45 + (1 - v) * 0.12));
      const pu = puido * 0.6;
      _rgb[0] += (_rgb[0] * 1.5 + 0.14 - _rgb[0]) * pu;
      _rgb[1] += (_rgb[1] * 1.5 + 0.14 - _rgb[1]) * pu;
      _rgb[2] += (_rgb[2] * 1.5 + 0.14 - _rgb[2]) * pu;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // Tecido é sempre áspero, mas o topo do fio tem um brilho leve.
      let rug = 0.94 - trama * 0.14 + (irreg - 0.5) * 0.10;
      rug += (0.99 - rug) * (puido * 0.8);
      rugosidade[i] = clamp(rug, 0.55, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fManchas, fSol, fPuido, fDobras]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.5,
    aoRaioLargo: 8, aoRaioFino: 2, aoForca: 1.1,
    props: { doisLados: true },
  };
}

// ===========================================================================
// BORRACHA — pneu, tapete, mangueira
// ===========================================================================

export async function gerarBorracha(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 7433;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 4);
  const fPoeira = assar(lab, N, (u, v) => clamp01(
    dMancha(det, u, v, 2, 0.47, 0.13) * 0.8 + (1 - smoothstep(0, 0.5, v)) * 0.35));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    // Rebarba do molde: uma linha fina atravessando (todo produto moldado tem)
    const rebarba = 1 - smoothstep(0, 0.006, Math.abs(v - 0.33));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const poeira = ler(fPoeira, N, u, v);

      const molde = dCel(det, u, v, L(12), 0.17, 0.71);
      const bolha = smoothstep(0.88, 0.99, dGraoFino(det, u, v, L(4)));
      // Craquelamento por ozônio (borracha velha racha em rede fina)
      const craque = smoothstep(0.68, 0.90, dRidged(det, u, v, L(2), 0.13, 0.53)) *
        smoothstep(0.4, 0.75, macro);

      altura[i] = clamp01(0.62 + molde * 0.08 - bolha * 0.10 + rebarba * 0.05 - craque * 0.12);

      // Preto de negro-de-fumo: nunca é preto puro, tem 0,04–0,06 de albedo.
      const base = 0.045 + molde * 0.022 + (macro - 0.5) * 0.012;
      let r = base, g = base, b = base * 1.03;
      const po = poeira * 0.42;   // poeira cinza é o que dá leitura à peça
      r += (0.30 - r) * po; g += (0.295 - g) * po; b += (0.28 - b) * po;
      const ck = craque * 0.5;
      r += (0.11 - r) * ck; g += (0.11 - g) * ck; b += (0.115 - b) * ck;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      // Borracha é fosca mas não uniforme: a poeira sobe o roughness, o atrito
      // (onde a peça encosta) polida desce.
      let rug = 0.82 + (molde - 0.5) * 0.14;
      rug += (0.94 - rug) * (poeira * 0.5);
      rug += (0.55 - rug) * (smoothstep(0.55, 0.9, macro) * 0.5);
      rug += (0.97 - rug) * (craque * 0.7);
      rugosidade[i] = clamp(rug, 0.35, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fPoeira]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.1,
    aoRaioLargo: 8, aoRaioFino: 2, aoForca: 0.85,
    props: {},
  };
}

// ===========================================================================
// PLÁSTICO — caixa d'água azul, cadeira, balde, telha de PVC
// ===========================================================================

export async function gerarPlastico(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 8537;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const cor = o.cor || hex('#2f6fa8');   // o azul da caixa d'água — ícone da favela
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 3);
  const fSol = assar(lab, N, (u, v) => dFbm(det, u, v, 1, 0.53, 0.11));
  const fMusgo = campoMusgo(lab, N, semente + 11, 0.14);

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const sol = ler(fSol, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.07, 0);

      // Rotomoldagem: casca de laranja sutil + marcas de fluxo + riscos de manuseio
      const casca = dGrao(det, u, v, L(12));
      const fluxo = dRiscoV(det, u, v, L(1), 0.31, 0.17);
      const risco = smoothstep(0.88, 0.98, dRiscoH(det, u, v, L(5), 0.61, 0.29));

      altura[i] = clamp01(0.64 + (casca - 0.5) * 0.045 + (fluxo - 0.5) * 0.03 - risco * 0.05);

      // O sol destrói o pigmento: plástico velho fica claro e gizado.
      const gizado = clamp01(sol * 0.85 + macro * 0.4) * 0.55;
      const lumaC = cor[0] * 0.299 + cor[1] * 0.587 + cor[2] * 0.114;
      const lc = 0.94 + casca * 0.12;
      let r = (cor[0] + (lumaC * 1.35 + 0.22 - cor[0]) * gizado) * lc;
      let g = (cor[1] + (lumaC * 1.32 + 0.22 - cor[1]) * gizado) * lc;
      let b = (cor[2] + (lumaC * 1.28 + 0.23 - cor[2]) * gizado) * lc;
      const rs = risco * 0.5;
      r += (r * 1.4 + 0.12 - r) * rs; g += (g * 1.4 + 0.12 - g) * rs; b += (b * 1.4 + 0.12 - b) * rs;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(escorre * 0.40 + macro * 0.14 + (1 - v) * 0.10));
      const m = musgo * 0.65;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // Plástico novo é semibrilhante (~0,25); gizado pelo sol vai a 0,8.
      let rug = 0.28 + (casca - 0.5) * 0.14;
      rug += (0.80 - rug) * (gizado * 1.35);
      rug += (0.62 - rug) * (escorre * 0.4);
      rug += (0.95 - rug) * (musgo * 0.8);
      rug += (0.50 - rug) * (risco * 0.4);
      rugosidade[i] = clamp(rug, 0.12, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fSol, fMusgo]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 0.8,
    aoRaioLargo: 8, aoRaioFino: 2, aoForca: 0.7,
    props: {},
  };
}
