/**
 * generators/metal.js — chapa zincada ondulada enferrujada, metal pintado e
 * aço escovado (armas). Dono: MAT.
 *
 * Metal é onde o roughness/metalness manda mais que o albedo: ferrugem é ÁSPERA e
 * DIELÉTRICA (metalness ~0), zinco intacto é liso e metálico (metalness 1).
 * Essa transição de metalness é o que faz ferrugem parecer ferrugem — sem ela,
 * fica só uma pintura laranja num metal.
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, campoMusgo,
  dGrao, dGraoFino, dCel, dCelId, dRiscoV, dRiscoH, dFbm, dMancha,
  dEscorrimento,
  hex, sujar,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

const _rgb = new Float32Array(3);

const FERR_CLARA = hex('#a4592a');   // ferrugem fresca, alaranjada
const FERR_MEDIA = hex('#7a3d20');
const FERR_ESCURA = hex('#43241a');  // ferrugem velha, quase marrom-preta
const ZINCO = hex('#9aa0a4');

// ===========================================================================
// METAL ONDULADO — chapa zincada de barraco
// ===========================================================================

/** Tile: 12 ondas de ~7,7 cm ⇒ 0,92 m × 0,92 m. Repete muito, então o macro é vital. */
export async function gerarMetalOndulado(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 9901;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade, metalico } = alvo;

  const ONDAS = 12;
  const N = N_MACRO;
  const fFocos = assar(lab, N, (u, v) =>
    smoothstep(0.32, 0.72, dMancha(det, u, v, 1, 0.03, 0.29)));
  const fEspalha = assar(lab, N, (u, v) => dMancha(det, u, v, 2, 0.41, 0.77));
  const fMacro = campoManchasMacro(lab, N, semente + 11, 2);
  // Amassados: a chapa de barraco sempre tem batidas
  const fAmassado = assar(lab, N, (u, v) => {
    const d = 1 - smoothstep(0.10, 0.55, dCel(det, u, v, 1, 0.61, 0.13));
    const id = dCelId(det, u, v, 1, 0.61, 0.13);
    return d * (id > 0.55 ? 1 : 0);
  });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;
  const TAU = Math.PI * 2;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const onda = Math.sin(u * ONDAS * TAU);
      const crista = onda * 0.5 + 0.5;              // 1 no topo da onda

      const focos = ler(fFocos, N, u, v);
      const espalha = ler(fEspalha, N, u, v);
      const macro = ler(fMacro, N, u, v);
      const amassado = ler(fAmassado, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(2), 0.19, 0);

      // Chapa de barraco é MAJORITARIAMENTE ferrugem, com ilhas de zinco que
      // ainda resistem — o offset +0,34 é o que inverte a lógica: sem ele o
      // material vira cromo espelhado, que é exatamente o oposto do referencial.
      // A corrosão avança a partir das cristas (onde o zinco raspou no transporte)
      // e das trilhas de água.
      const semeteFerr = clamp01(0.34 + focos * 0.85 + escorre * 0.40 + crista * 0.22);
      const ferrugem = smoothstep(0.26, 0.78, semeteFerr * (0.62 + espalha * 0.75));
      // Perfuração: onde a corrosão é total, a chapa vaza.
      const furo = smoothstep(0.88, 0.99, semeteFerr * espalha * 1.35);

      // Crosta de ferrugem: relevo escamado
      const crosta = dCel(det, u, v, L(12), 0.17, 0.71);
      const escama = smoothstep(0.45, 0.85, crosta) * ferrugem;

      // Micro: laminação da chapa + riscos longitudinais
      const risco = dRiscoH(det, u, v, L(4));
      const micro = risco * 0.035 + dGraoFino(det, u, v, L(3)) * 0.025;

      let hgt = 0.50 + onda * 0.32 + micro;
      hgt -= amassado * 0.13;
      hgt += escama * 0.10 - ferrugem * 0.04;
      hgt += (0.05 - hgt) * furo;
      altura[i] = clamp01(hgt);

      // --- albedo ---
      // Zinco: cinza levemente azulado com o "spangle" (cristalização) da galvanização
      const spangle = dCelId(det, u, v, L(3), 0.29, 0.47);
      const zl = 0.86 + spangle * 0.26 + (dGrao(det, u, v, L(8)) - 0.5) * 0.12;
      let r = ZINCO[0] * zl, g = ZINCO[1] * zl, b = ZINCO[2] * zl;

      // Ferrugem, do laranja fresco ao marrom podre
      const idade = clamp01(espalha * 0.7 + macro * 0.5);
      let fr, fg, fb;
      if (idade < 0.5) {
        const t = idade * 2;
        fr = FERR_CLARA[0] + (FERR_MEDIA[0] - FERR_CLARA[0]) * t;
        fg = FERR_CLARA[1] + (FERR_MEDIA[1] - FERR_CLARA[1]) * t;
        fb = FERR_CLARA[2] + (FERR_MEDIA[2] - FERR_CLARA[2]) * t;
      } else {
        const t = (idade - 0.5) * 2;
        fr = FERR_MEDIA[0] + (FERR_ESCURA[0] - FERR_MEDIA[0]) * t;
        fg = FERR_MEDIA[1] + (FERR_ESCURA[1] - FERR_MEDIA[1]) * t;
        fb = FERR_MEDIA[2] + (FERR_ESCURA[2] - FERR_MEDIA[2]) * t;
      }
      const cl = 0.80 + crosta * 0.45;
      fr *= cl; fg *= cl; fb *= cl;

      // Ilhas de zinco sobrevivente: sem elas a chapa vira um laranja chapado.
      // O `espalha` decide onde a galvanização ainda segurou.
      const ilhaZinco = smoothstep(0.66, 0.30, espalha) * (1 - focos) * 0.55;
      const ferrLocal = clamp01(ferrugem - ilhaZinco);
      r += (fr - r) * ferrLocal; g += (fg - g) * ferrLocal; b += (fb - b) * ferrLocal;

      // Sangria de ferrugem escorrendo sobre o zinco ainda são
      const sangria = clamp01(escorre * (0.3 + focos)) * (1 - ferrLocal) * 0.55;
      r += (FERR_MEDIA[0] * 1.1 - r) * sangria;
      g += (FERR_MEDIA[1] * 1.1 - g) * sangria;
      b += (FERR_MEDIA[2] * 1.1 - b) * sangria;

      r += (0.03 - r) * furo; g += (0.03 - g) * furo; b += (0.035 - b) * furo;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(macro * 0.18 + (1 - v) * 0.10));
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // --- rugosidade / metalness ---
      // Zinco de telha velha nunca é espelho: oxidação branca + poeira colada
      // deixam a rugosidade em 0,45–0,6 mesmo onde a chapa "está boa".
      let rug = 0.50 + (spangle - 0.5) * 0.14 + risco * 0.12;
      rug += (0.94 - rug) * ferrLocal;
      rug += (0.99 - rug) * (escama * 0.5);
      rug += (0.55 - rug) * (amassado * 0.25);
      rugosidade[i] = clamp(rug, 0.18, 1);
      metalico[i] = clamp01((0.95 + (0.06 - 0.95) * ferrLocal) * (1 - furo));
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fFocos, fEspalha, fMacro, fAmassado]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 3.0,
    aoRaioLargo: 16, aoRaioFino: 3, aoForca: 1.15,
    props: {},
  };
}

// ===========================================================================
// METAL PINTADO — portão, porta de aço, grade
// ===========================================================================

export async function gerarMetalPintado(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 1213;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const cor = o.cor || hex('#2f5f4a');   // verde portão, clássico
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade, metalico } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 3);
  // Onde a tinta saltou (bolha de ferrugem por baixo empurrando a tinta)
  const fSalto = assar(lab, N, (u, v) => {
    const bolhas = dMancha(det, u, v, 2, 0.07, 0.53);
    const zonas = smoothstep(0.40, 0.72, dMancha(det, u, v, 1, 0.61, 0.11));
    return clamp01(smoothstep(0.44, 0.64, bolhas) * zonas);
  });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const salto = ler(fSalto, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.13, 0);

      // Riscos de uso: arranhões finos e direcionais
      const arranhao = smoothstep(0.86, 0.97, dRiscoH(det, u, v, L(6), 0.41, 0));
      // Casca de laranja da pintura a rolo
      const casca = dGrao(det, u, v, L(12));
      const crosta = dCel(det, u, v, L(12), 0.19, 0.83);

      const tinta = 1 - salto;
      let hgt = 0.62 + (casca - 0.5) * 0.05 + tinta * 0.03;
      hgt += (0.50 + crosta * 0.18 - hgt) * salto;
      hgt -= arranhao * 0.03;
      altura[i] = clamp01(hgt);

      // Tinta esmalte desbotada
      const desbota = clamp01(macro * 0.5 + v * 0.35) * 0.45;
      const lumaC = cor[0] * 0.299 + cor[1] * 0.587 + cor[2] * 0.114;
      const lc = 0.92 + casca * 0.16;
      let r = (cor[0] + (lumaC * 1.15 + 0.10 - cor[0]) * desbota) * lc;
      let g = (cor[1] + (lumaC * 1.12 + 0.10 - cor[1]) * desbota) * lc;
      let b = (cor[2] + (lumaC * 1.08 + 0.11 - cor[2]) * desbota) * lc;

      // Ferrugem exposta sob a tinta saltada
      const fl = 0.80 + crosta * 0.45;
      r += (FERR_MEDIA[0] * fl - r) * salto;
      g += (FERR_MEDIA[1] * fl - g) * salto;
      b += (FERR_MEDIA[2] * fl - b) * salto;
      // Sangria de ferrugem descendo sobre a tinta
      const sangria = clamp01(escorre * salto * 2.2 + escorre * macro * 0.4) * 0.6;
      r += (FERR_CLARA[0] * 0.9 - r) * sangria;
      g += (FERR_CLARA[1] * 0.9 - g) * sangria;
      b += (FERR_CLARA[2] * 0.9 - b) * sangria;
      const ar = arranhao * 0.6;
      r += (0.55 - r) * ar; g += (0.55 - g) * ar; b += (0.56 - b) * ar;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      // Sujeira leve: tinta de portão encardece, mas se o material inteiro
      // for puxado para o marrom a cor da casa some.
      sujar(_rgb, clamp01(macro * 0.10 + escorre * 0.16));
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      let rug = 0.42 + (casca - 0.5) * 0.22 + macro * 0.14;   // esmalte semibrilho gasto
      rug += (0.95 - rug) * (salto * 0.9);
      rug += (0.30 - rug) * (arranhao * 0.5);
      rugosidade[i] = clamp(rug, 0.18, 1);
      metalico[i] = clamp01(0.04 + salto * 0.06 + arranhao * 0.7);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fSalto]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.4,
    aoRaioLargo: 12, aoRaioFino: 2.5, aoForca: 0.95,
    props: {},
  };
}

// ===========================================================================
// METAL ESCOVADO — aço fosfatizado de arma
// ===========================================================================

/**
 * Superfície de armamento: aço parkerizado escuro, escovado no sentido do cano,
 * com desgaste que revela metal branco por baixo. Tile pequeno (~16 cm) porque
 * a arma ocupa pouca área de UV e é vista de pertíssimo no ADS.
 */
export async function gerarMetalEscovado(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 1511;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade, metalico } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 4);
  // Desgaste: zonas onde a fosfatização foi embora pelo manuseio
  const fDesgaste = assar(lab, N, (u, v) =>
    smoothstep(0.58, 0.85, dMancha(det, u, v, 2, 0.29, 0.13)));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      // Escovado: riscos MUITO alongados no eixo X (dRiscoH em alta frequência)
      const escovado = dRiscoH(det, u, v, L(10));
      const escovadoGrosso = dRiscoH(det, u, v, L(3), 0.11, 0.43);
      // Textura de fosfato: granulação fina e mate
      const fosfato = dGraoFino(det, u, v, L(4));
      const arranhao = smoothstep(0.90, 0.985, dRiscoH(det, u, v, L(8), 0.71, 0.29));

      const macro = ler(fMacro, N, u, v);
      const desgaste = ler(fDesgaste, N, u, v);

      altura[i] = clamp01(0.62 + (escovado - 0.5) * 0.05 + (fosfato - 0.5) * 0.045 - arranhao * 0.08);

      // Parkerizado: cinza-esverdeado bem escuro. O desgaste revela aço polido.
      const base = 0.115 + (macro - 0.5) * 0.035 + (fosfato - 0.5) * 0.05 + (escovadoGrosso - 0.5) * 0.03;
      let r = base, g = base * 1.03, b = base * 0.97;
      const aco = 0.52 + (escovado - 0.5) * 0.18;
      const dg = desgaste * 0.85;
      r += (aco - r) * dg; g += (aco * 1.01 - g) * dg; b += (aco * 1.03 - b) * dg;
      const ar = arranhao * 0.7;
      r += (0.62 - r) * ar; g += (0.63 - g) * ar; b += (0.64 - b) * ar;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      // Fosfatizado é fosco (0,55–0,7); o desgaste polido desce para ~0,18.
      let rug = 0.62 + (fosfato - 0.5) * 0.16 - (escovado - 0.5) * 0.10 + macro * 0.06;
      rug += (0.20 - rug) * (desgaste * 0.85);
      rug += (0.14 - rug) * (arranhao * 0.8);
      rugosidade[i] = clamp(rug, 0.10, 0.90);
      metalico[i] = 1;
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fDesgaste]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 0.7,
    aoRaioLargo: 8, aoRaioFino: 2, aoForca: 0.6,
    props: {},
  };
}
