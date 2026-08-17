/**
 * generators/alvenaria.js — tijolo baiano, reboco pintado, grafite e azulejo.
 * Dono: MAT.
 *
 * O tijolo baiano de 8 furos é a assinatura visual da favela: bloco cerâmico
 * vermelho-alaranjado de 29×19×9 cm, assentado em fiada corrida com junta de argamassa
 * de ~2 cm, os oito furos retangulares (4×2) virados para fora. É o que o jogador vai
 * olhar de perto o tempo todo, então é a superfície com mais camadas aqui.
 *
 * Tile: 2,4 m × 2,4 m = 8 blocos × 12 fiadas (ambos inteiros ⇒ tileável).
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, campoMusgo, campoSol,
  dGrao, dGraoFino, dCel, dCelId, dRiscoV, dRiscoH, dFbm, dMancha, dRidged,
  dRacha, dEscorrimento,
  hex, sujar, SUJEIRA, MUSGO, EFLOR, CIMENTO,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

// --- Geometria do bloco, em unidades de célula -------------------------------
const COLS = 8;            // blocos por tile (2,4 m / 0,30 m)
const ROWS = 12;           // fiadas por tile (2,4 m / 0,20 m)
// Junta de pedreiro de favela é grossa e irregular: 2,5–3 cm, não os 1 cm de obra.
const JXH = 0.034;         // meia-junta horizontal (2,0 cm em célula de 30 cm)
const JYH = 0.050;         // meia-junta vertical   (2,0 cm em célula de 20 cm)
const BISEL = 0.015;       // chanfro/quebra da aresta do bloco

// --- Furos: 4 colunas × 2 linhas na face do bloco ----------------------------
// A parede externa do bloco é mais grossa que os septos internos — é o que
// diferencia um tijolo baiano de uma grade de waffle.
const MARG_U = 0.078, RIB_U = 0.044;
const FURO_U = (1 - 2 * MARG_U - 3 * RIB_U) / 4;   // ≈ 0,171 → 4,8 cm
const PASSO_U = FURO_U + RIB_U;
const MARG_V = 0.115, RIB_V = 0.086;
const FURO_V = (1 - 2 * MARG_V - RIB_V) / 2;       // ≈ 0,319 → 5,7 cm
const PASSO_V = FURO_V + RIB_V;

/** Máscara dos 8 furos na face do bloco. bu,bv ∈ [0,1] sobre a face. */
function mascaraFuros(bu, bv) {
  const tu = (bu - MARG_U) / PASSO_U;
  const ju = tu < 0 ? -1 : tu | 0;
  if (ju < 0 || ju > 3) return 0;
  const tv = (bv - MARG_V) / PASSO_V;
  const jv = tv < 0 ? -1 : tv | 0;
  if (jv < 0 || jv > 1) return 0;

  const fu = (tu - ju) * PASSO_U;
  const fv = (tv - jv) * PASSO_V;
  const du = fu < FURO_U - fu ? fu : FURO_U - fu;
  const dv = fv < FURO_V - fv ? fv : FURO_V - fv;
  if (du <= 0 || dv <= 0) return 0;
  return smoothstep(0, 0.010, du) * smoothstep(0, 0.012, dv);
}

/**
 * Resolve a topologia da parede de tijolo num ponto (u,v). Escreve em `saida`
 * (Float32Array de 8) para não alocar no loop:
 *   0 face · 1 furo · 2 hash do bloco · 3 segundo hash · 4 distância à junta
 *   5 fy (posição na fiada) · 6 bu · 7 bv (locais na face do bloco)
 */
export function topologiaTijolo(u, v, semente, saida) {
  const gy = v * ROWS;
  const linha = Math.floor(gy);
  const fy = gy - linha;
  const lw = wrapi(linha, ROWS);

  // Fiada corrida: linhas ímpares deslocam meio bloco.
  const gx = u * COLS + ((lw & 1) ? 0.5 : 0);
  const coluna = Math.floor(gx);
  const fx = gx - coluna;
  const cw = wrapi(coluna, COLS);

  const hb = hash1f(cw * 131 + lw * 977, semente);
  const hb2 = hash2f(cw, lw, semente + 4441);

  // Assentamento torto: cada peça desloca alguns milímetros dentro da célula.
  const sx = (hb - 0.5) * 0.020;
  const sy = (hb2 - 0.5) * 0.028;

  const dEsq = fx - (JXH + sx);
  const dDir = (1 - JXH + sx) - fx;
  const dBai = fy - (JYH + sy);
  const dCim = (1 - JYH + sy) - fy;

  const face =
    smoothstep(0, BISEL, dEsq) * smoothstep(0, BISEL, dDir) *
    smoothstep(0, BISEL * 0.8, dBai) * smoothstep(0, BISEL * 0.8, dCim);

  const bu = clamp01((fx - JXH - sx) / (1 - 2 * JXH));
  const bv = clamp01((fy - JYH - sy) / (1 - 2 * JYH));

  // ~14% dos blocos foram assentados de lado (furos não aparecem);
  // ~9% tiveram os furos tomados por argamassa.
  let furo = 0;
  if (face > 0.05 && hb2 > 0.14) {
    furo = mascaraFuros(bu, bv);
    if (hb > 0.91) furo *= 0.15;
    furo *= face;
  }

  const dx = dEsq < dDir ? dEsq : dDir;
  const dy = dBai < dCim ? dBai : dCim;
  const dJunta = Math.min(dx / (JXH * 2), dy / (JYH * 2));

  saida[0] = face;
  saida[1] = furo;
  saida[2] = hb;
  saida[3] = hb2;
  saida[4] = clamp01(dJunta);
  saida[5] = fy;
  saida[6] = bu;
  saida[7] = bv;
  return saida;
}

const _t = new Float32Array(8);
const _rgb = new Float32Array(3);

// Paleta cerâmica do tijolo baiano (variação real de forno: da telha alaranjada
// ao vermelho queimado quase marrom).
const TIJOLO_CLARO = hex('#b06a45');
const TIJOLO_MEDIO = hex('#93472f');
const TIJOLO_ESCURO = hex('#6d3324');
const FURO_INT = hex('#3a2019');

// ===========================================================================
// TIJOLO
// ===========================================================================

export async function gerarTijolo(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 1301;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 11, 2);
  const fMusgo = campoMusgo(lab, N, semente + 37, 0.26);
  const fSol = campoSol(lab, N, semente + 41);
  // Eflorescência (salitre): floresce em placas onde a parede transpira.
  const fEflor = assar(lab, N, (uu, vv) =>
    clamp01(smoothstep(0.56, 0.82, dMancha(det, uu, vv, 1, 0.21, 0.63))));
  // Fuligem/poluição: mancha ampla e independente, senão a parede fica "limpa
  // demais". É a camada que amarra o tijolo ao resto da favela.
  const fFuligem = assar(lab, N, (uu, vv) => clamp01(
    dMancha(det, uu, vv, 1, 0.71, 0.19) * 1.15 - 0.12));
  // Argamassa lambuzada por cima dos blocos: pedreiro apressado sempre deixa.
  const fLambuzo = assar(lab, N, (uu, vv) =>
    smoothstep(0.63, 0.80, dMancha(det, uu, vv, 2, 0.37, 0.83)));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x;
      const i4 = i * 4;

      topologiaTijolo(u, v, semente, _t);
      const face = _t[0], furo = _t[1], hb = _t[2], hb2 = _t[3];
      const dJunta = _t[4], fy = _t[5], bu = _t[6], bv = _t[7];

      const macro = ler(fMacro, N, u, v);
      const sol = ler(fSol, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const eflor = ler(fEflor, N, u, v);
      const fuligem = ler(fFuligem, N, u, v);
      const lambuzo = ler(fLambuzo, N, u, v);

      // Escorrimento: mais forte logo abaixo das juntas horizontais.
      const sobJunta = smoothstep(0.30, 0.02, fy);
      const escorre = dEscorrimento(det, u, v, L(1), 0.13, 0) * (0.45 + sobJunta * 0.85);

      // ---------- ALTURA ----------
      // Cerâmica extrudada: grão fino e marcas direcionais da fieira.
      const graoCer = dGrao(det, u, v, L(12)) * 0.10 + dRiscoV(det, u, v, L(4)) * 0.05;
      // Argamassa: agregado grosso com bolhas. Só interessa perto da junta —
      // pular nos 70% de pixels que são face de bloco vale ~15% do tempo total.
      let graoArg = 0.5;
      if (face < 0.995) {
        graoArg = dCel(det, u, v, L(8), 0.37, 0.11) * 0.68 + dGraoFino(det, u, v, L(3)) * 0.26;
      }

      // A junta às vezes é rebaixada, às vezes espremida para fora (macro decide).
      const espremido = smoothstep(0.55, 0.85, macro);
      const hJunta = 0.30 + graoArg * 0.16 + espremido * 0.30;
      const hFace = 0.66 + (hb - 0.5) * 0.055 + graoCer;

      // Quinas quebradas: alguns blocos perderam um canto.
      let quebrado = 0;
      if (hb2 > 0.93) {
        const qx = bu - (hb > 0.5 ? 1 : 0);
        const qy = bv - (hb2 > 0.965 ? 1 : 0);
        quebrado = smoothstep(0.55, 0.0, Math.sqrt(qx * qx + qy * qy) * 2.2);
      }

      let hgt = hJunta + (hFace - hJunta) * face;
      hgt -= quebrado * 0.14;
      hgt += (0.08 + (1 - bv) * 0.02 - hgt) * furo;   // furo = cavidade funda
      altura[i] = clamp01(hgt);

      // ---------- ALBEDO ----------
      let r, g, b;
      const gA = dGrao(det, u, v, L(8), 0.61, 0.29);
      if (face > 0.5) {
        // Cor da peça: a rampa entre as três queimas dá o matiz…
        const t = clamp01(hb * 0.75 + macro * 0.45 - 0.1);
        let ca, cb, tt;
        if (t < 0.5) { ca = TIJOLO_ESCURO; cb = TIJOLO_MEDIO; tt = t * 2; }
        else { ca = TIJOLO_MEDIO; cb = TIJOLO_CLARO; tt = (t - 0.5) * 2; }
        r = ca[0] + (cb[0] - ca[0]) * tt;
        g = ca[1] + (cb[1] - ca[1]) * tt;
        b = ca[2] + (cb[2] - ca[2]) * tt;

        // …e um ganho POR PEÇA dá a diferença de lote. Sem isto a parede fica
        // com aquele vermelho uniforme de textura de banco de imagens: peças de
        // fornadas diferentes variam muito mais de claro/escuro do que de matiz.
        const ganho = 0.62 + hb2 * 0.72;
        r *= ganho; g *= ganho * 0.99; b *= ganho * 0.98;
        // ~7% das peças são bem mais escuras (queima passada ou peça encharcada)
        if (hb2 < 0.07) { r *= 0.62; g *= 0.60; b *= 0.62; }
        // ~6% ficaram com resto de caiação de uma pintura antiga
        if (hb > 0.94) {
          const cal = 0.55 + hb2 * 0.3;
          r += (0.74 - r) * cal; g += (0.73 - g) * cal; b += (0.70 - b) * cal;
        }

        // Grão cerâmico + pontinhos escuros (impurezas do barro)
        const gc = dGrao(det, u, v, L(12), 0.13, 0.41);
        const impureza = smoothstep(0.88, 0.99, dGraoFino(det, u, v, L(4), 0.7, 0.3));
        const l = 0.84 + gc * 0.30 - impureza * 0.36;
        r *= l; g *= l; b *= l;

        // A aresta chanfrada é mais clara (cerâmica exposta/desgastada)
        const aresta = (1 - smoothstep(0, 0.22, dJunta)) * face * 0.55;
        r += (r * 1.32 + 0.05 - r) * aresta;
        g += (g * 1.30 + 0.05 - g) * aresta;
        b += (b * 1.26 + 0.05 - b) * aresta;
      } else {
        // Argamassa: cinza sujo, com areia. Escura — argamassa de favela não é
        // branca de rejunte, é cimento e areia de barranco.
        const areia = smoothstep(0.55, 0.92, dCel(det, u, v, L(12), 0.9, 0.5));
        const l = 0.56 + gA * 0.34 + areia * 0.16;
        r = CIMENTO[0] * l; g = CIMENTO[1] * l; b = CIMENTO[2] * l;
        // A peça sangra cor de barro na junta
        const sangra = 0.28 * (1 - dJunta);
        r += (TIJOLO_MEDIO[0] * 0.8 - r) * sangra;
        g += (TIJOLO_MEDIO[1] * 0.8 - g) * sangra;
        b += (TIJOLO_MEDIO[2] * 0.8 - b) * sangra;
      }

      // Argamassa lambuzada por cima da peça (não só na junta)
      const lb = lambuzo * face * 0.7;
      if (lb > 0.01) {
        const cl = 0.58 + gA * 0.30;
        r += (CIMENTO[0] * cl - r) * lb;
        g += (CIMENTO[1] * cl - g) * lb;
        b += (CIMENTO[2] * cl - b) * lb;
      }

      // Interior do furo: escuro, mas nunca preto puro (o AO completa)
      if (furo > 0.01) {
        const prof = furo * (0.75 + (1 - bv) * 0.25);
        r += (FURO_INT[0] - r) * prof;
        g += (FURO_INT[1] - g) * prof;
        b += (FURO_INT[2] - b) * prof;
      }

      // Camadas de intemperismo, na ordem em que a vida as deposita:
      // 1) sol desbota e dessatura o topo
      const desbota = sol * 0.30 * (0.4 + macro * 0.8);
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      r += (luma * 1.22 + 0.06 - r) * desbota;
      g += (luma * 1.18 + 0.06 - g) * desbota;
      b += (luma * 1.12 + 0.07 - b) * desbota;

      // 2) eflorescência (salitre branco), preferindo a junta
      const eflorLocal = eflor * (0.45 + (1 - dJunta) * 0.8) * (1 - furo * 0.7);
      const ef = eflorLocal * 0.50;
      r += (EFLOR[0] - r) * ef; g += (EFLOR[1] - g) * ef; b += (EFLOR[2] - b) * ef;

      // 3) respingo de cal/argamassa espalhado pela parede
      const respingo = smoothstep(0.80, 0.96, dCel(det, u, v, L(12), 0.05, 0.77)) * 0.42;
      r += (0.74 - r) * respingo; g += (0.73 - g) * respingo; b += (0.70 - b) * respingo;

      // 4) fuligem e escorrimento de chuva suja — a camada que dá idade
      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(fuligem * 0.52 + escorre * 0.46 + furo * 0.34));

      // 5) limo
      const m = musgo * (0.6 + (1 - dJunta) * 0.5) * 0.85;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;

      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // ---------- RUGOSIDADE ----------
      // Cerâmica queimada é semi-fosca; argamassa é bem mais áspera; limo é fosco
      // total; onde a água escorreu, a superfície ficou lisa e levemente polida.
      let rug = 0.90 + (0.71 - 0.90) * face;
      rug += (graoArg - 0.5) * 0.14;
      rug += (0.62 - rug) * (escorre * 0.55);
      rug += (0.97 - rug) * (m);
      rug += (0.94 - rug) * (eflorLocal * 0.6);
      rug += (0.99 - rug) * (furo * 0.8);
      rug += (0.64 - rug) * ((1 - smoothstep(0, 0.18, dJunta)) * face * 0.45);
      rugosidade[i] = clamp(rug, 0.35, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo, fSol, fEflor, fFuligem, fLambuzo]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 2.6,
    aoRaioLargo: 16, aoRaioFino: 3.5, aoForca: 1.35,
    props: { normalEscala: 1.0 },
  };
}

// ===========================================================================
// REBOCO — argamassa pintada descascando, mostrando o tijolo por baixo
// ===========================================================================

/**
 * @param {object} o  { w, h, semente, cor:[r,g,b], descasque:0..1, reuso }
 *
 * ## Repintura barata
 * As casas da favela são o MESMO reboco em cinco tintas. Rodar o gerador inteiro
 * cinco vezes custava ~20% do tempo total de carregamento para produzir cinco
 * texturas que só diferem no matiz da tinta.
 *
 * Então a primeira execução guarda três camadas intermediárias em `reuso`:
 *   `sub`    — tudo que existe DEBAIXO da tinta (tijolo + reboco cru + rachadura)
 *   `tinta`  — quanto de tinta há em cada texel (0–255)
 *   `mod`    — a modulação de luz/sujeira que a tinta recebe (grão, sol, remendo)
 * e as variantes só fazem `sub·(1−tinta) + cor·mod·tinta` + sujeira: ~15 operações
 * por pixel em vez de ~400. Altura, normal, AO e roughness são compartilhados,
 * porque a geometria da superfície é literalmente a mesma parede.
 */
export async function gerarReboco(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 907;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const cor = o.cor || hex('#cfc7b4');
  const descasque = o.descasque ?? 0.42;
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;
  const reusando = !!o.reuso;

  // --- Caminho rápido: repintura de uma variante já cozida ---
  if (reusando) {
    const { sub, tintaMask, mod, campos, sujidade } = o.reuso;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const i4 = i * 4;
      const t = tintaMask[i] * (1 / 255);
      const m = mod[i] * (1 / 255);
      // A tinta recebe a modulação já calculada (grão + remendo + desbotamento).
      const pr = cor[0] * m, pg = cor[1] * m, pb = cor[2] * m;
      const sr = sub[i4] * (1 / 255), sg = sub[i4 + 1] * (1 / 255), sb = sub[i4 + 2] * (1 / 255);
      _rgb[0] = sr + (pr - sr) * t;
      _rgb[1] = sg + (pg - sg) * t;
      _rgb[2] = sb + (pb - sb) * t;
      sujar(_rgb, sujidade[i] * (1 / 255));
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));
    }
    lab.liberarCampo(alvo.altura);
    lab.liberarCampo(alvo.rugosidade);
    alvo.altura = o.reuso.altura;
    alvo.rugosidade = o.reuso.rugosidade;
    return {
      ...alvo,
      normalForca: 1.9,
      aoRaioLargo: 14, aoRaioFino: 3, aoForca: 1.15,
      reuso: o.reuso,
      props: { normalEscala: 1.0 },
    };
  }

  // Camadas intermediárias guardadas para as variantes repintarem barato.
  const sub = lab.bufferRGBA(w, h);
  const tintaMask = new Uint8ClampedArray(w * h);
  const mod = new Uint8ClampedArray(w * h);
  const sujidade = new Uint8ClampedArray(w * h);

  const N = N_MACRO;
  const campos = {
    macro: campoManchasMacro(lab, N, semente + 3, 2),
    musgo: campoMusgo(lab, N, semente + 7, 0.24),
    sol: campoSol(lab, N, semente + 9),
    // Máscara de casca: onde a tinta ainda existe. A borda precisa ser rendilhada
    // como tinta velha soltando de verdade — daí o domain warp do campo `mancha`.
    // O viés vertical é leve de propósito (ver nota em comum.js sobre tiling).
    casca: assar(lab, N, (uu, vv) => {
      const n = dMancha(det, uu, vv, 1, 0.11, 0.29) * 0.75 + dFbm(det, uu, vv, 1, 0.4, 0.7) * 0.35;
      const umidade = (1 - smoothstep(0.0, 0.75, vv)) * 0.09;
      return clamp01(n - umidade);
    }),
    // Remendos de reboco/caiação de outra época
    remendo: assar(lab, N, (uu, vv) =>
      smoothstep(0.58, 0.74, dMancha(det, uu, vv, 1, 0.83, 0.07))),
  };

  const limiar = 0.34 + (0.60 - 0.34) * descasque;
  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x;
      const i4 = i * 4;

      const macro = ler(campos.macro, N, u, v);
      const sol = ler(campos.sol, N, u, v);
      const musgo = ler(campos.musgo, N, u, v);
      const cascaN = ler(campos.casca, N, u, v);
      const remendo = ler(campos.remendo, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.29, 0);

      // Borda da casca: onde a tinta levanta, cria um degrau fino e uma sombra.
      const d = cascaN - limiar;
      const tinta = smoothstep(-0.010, 0.022, d);         // 1 = tinta intacta
      const borda = 1 - smoothstep(0, 0.045, d < 0 ? -d : d);

      // Tijolo por baixo (mesma topologia da parede de tijolo)
      topologiaTijolo(u, v, semente + 313, _t);
      const faceT = _t[0], furoT = _t[1], hbT = _t[2];

      // Reboco cru: argamassa grossa desempenada
      const graoReb = dCel(det, u, v, L(8), 0.19, 0.55) * 0.55 + dGrao(det, u, v, L(8)) * 0.45;
      const desempeno = dRiscoV(det, u, v, L(1), 0.67, 0.23);   // marcas da desempenadeira
      const rachas = dRacha(det, u, v, L(1), 0.09, 0.31, 0.47);
      const expoeTijolo = (1 - tinta) * smoothstep(0.45, 0.06, cascaN);

      // ---------- ALTURA ----------
      {
        const hReboco = 0.60 + graoReb * 0.16 + (desempeno - 0.5) * 0.07;
        const hTijolo = 0.30 + (0.56 - 0.30) * faceT - furoT * 0.34;
        let hgt = hReboco + (hTijolo - hReboco) * expoeTijolo;
        hgt += tinta * 0.035;                    // camada de tinta tem espessura
        hgt += borda * tinta * 0.045;            // a casca levanta na borda
        hgt -= rachas * 0.10;
        altura[i] = clamp01(hgt);
      }

      // ---------- ALBEDO ----------
      // 1) tijolo exposto por baixo de tudo
      const tj = 0.34 + 0.28 * hbT;
      let tr = TIJOLO_ESCURO[0] + (TIJOLO_CLARO[0] - TIJOLO_ESCURO[0]) * tj;
      let tg = TIJOLO_ESCURO[1] + (TIJOLO_CLARO[1] - TIJOLO_ESCURO[1]) * tj;
      let tb = TIJOLO_ESCURO[2] + (TIJOLO_CLARO[2] - TIJOLO_ESCURO[2]) * tj;
      if (faceT < 0.5) { tr = CIMENTO[0] * 0.85; tg = CIMENTO[1] * 0.85; tb = CIMENTO[2] * 0.85; }
      if (furoT > 0.01) {
        tr += (FURO_INT[0] - tr) * furoT; tg += (FURO_INT[1] - tg) * furoT; tb += (FURO_INT[2] - tb) * furoT;
      }

      // 2) reboco cru por cima do tijolo — esta é a SUBCAMADA que as variantes
      //    de cor reaproveitam sem recalcular nada.
      const cinzaReb = 0.48 + graoReb * 0.22 + (desempeno - 0.5) * 0.10;
      let sr = cinzaReb * 0.98 + (tr - cinzaReb * 0.98) * expoeTijolo;
      let sg = cinzaReb * 0.95 + (tg - cinzaReb * 0.95) * expoeTijolo;
      let sb = cinzaReb * 0.88 + (tb - cinzaReb * 0.88) * expoeTijolo;
      // rachaduras entram na subcamada (independem da tinta)
      const rk = rachas * 0.75;
      sr += (0.10 - sr) * rk; sg += (0.09 - sg) * rk; sb += (0.085 - sb) * rk;
      // sombra de contato da lasca também
      const sombraBorda = borda * tinta * 0.5 * 0.42;
      sr *= 1 - sombraBorda; sg *= 1 - sombraBorda; sb *= 1 - sombraBorda;
      setRGB(sub, i4, clamp01(sr), clamp01(sg), clamp01(sb));

      // 3) modulação da tinta: grão do rolo + remendo de outro lote + sol.
      //    Fica separada da COR para a repintura ser uma multiplicação.
      const gTinta = dGrao(det, u, v, L(12), 0.43, 0.91);
      let mTinta = 0.90 + gTinta * 0.18;
      mTinta += remendo * 0.55 * 0.16;                        // remendo mais claro
      mTinta *= (1 - sombraBorda);
      const dsat = sol * 0.34 * (0.5 + macro * 0.7);
      mTinta *= 1 + dsat * 0.45;                              // sol clareia o pigmento
      mTinta = clamp01(mTinta * 0.78);                        // cabe em 0–255
      mod[i] = mTinta * 255;
      tintaMask[i] = tinta * 255;

      // 4) sujeira: escorrimento + fuligem + limo, também comum a todas as cores
      const sujo = clamp01(escorre * 0.46 + macro * 0.20 + musgo * 0.55);
      sujidade[i] = sujo * 255;

      // Albedo desta primeira cor
      const pr = cor[0] * mTinta, pg = cor[1] * mTinta, pb = cor[2] * mTinta;
      _rgb[0] = sr + (pr - sr) * tinta;
      _rgb[1] = sg + (pg - sg) * tinta;
      _rgb[2] = sb + (pb - sb) * tinta;
      sujar(_rgb, sujo);
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // ---------- RUGOSIDADE ----------
      // Tinta acrílica velha: semi-fosca. Reboco cru: bem áspero.
      let rug = 0.93 + (0.60 - 0.93) * tinta;
      rug += (gTinta - 0.5) * 0.10;
      rug += (0.55 - rug) * (escorre * 0.45);
      rug += (0.97 - rug) * (musgo * 0.85);
      rug += (0.99 - rug) * (expoeTijolo * 0.35);
      rug += (0.85 - rug) * (borda * 0.4);
      rugosidade[i] = clamp(rug, 0.35, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  return {
    ...alvo,
    normalForca: 1.9,
    aoRaioLargo: 14, aoRaioFino: 3, aoForca: 1.15,
    reuso: { campos, sub, tintaMask, mod, sujidade, altura: alvo.altura, rugosidade: alvo.rugosidade },
    props: { normalEscala: 1.0 },
  };
}

// ===========================================================================
// GRAFITE — muro com pichação e grafite colorido
// ===========================================================================

/** Paletas típicas de lata de spray de rua. */
const CORES_SPRAY = [
  hex('#e8342c'), hex('#f2a30f'), hex('#f5e13c'), hex('#2fa84f'),
  hex('#1e63c8'), hex('#7a30a8'), hex('#e8e6df'), hex('#12b8c4'),
  hex('#ef5aa0'), hex('#f07018'),
];

/**
 * Rasteriza traços de spray num campo de distância. Cada traço é uma polilinha
 * com largura variável; o campo guarda a menor distância e o índice do grupo.
 * Feito em resolução cheia porque grafite pede borda nítida — mas só ~15% dos
 * pixels são tocados, então o custo é baixo.
 */
function rasterizarTracos(w, h, semente, opts) {
  const dist = new Float32Array(w * h).fill(1e6);
  const grupo = new Uint8Array(w * h);

  for (let gI = 0; gI < opts.grupos; gI++) {
    const nTracos = 3 + Math.floor(hash1f(gI * 31 + 5, semente) * 5);
    const cx = hash1f(gI * 7 + 1, semente + 3);
    const cy = 0.25 + hash1f(gI * 7 + 2, semente + 5) * 0.5;
    const largura = (opts.larguraMin + hash1f(gI, semente + 11) * (opts.larguraMax - opts.larguraMin)) * w;
    const espalha = 0.10 + hash1f(gI * 13, semente + 17) * 0.16;

    for (let t = 0; t < nTracos; t++) {
      const nP = 4;
      const px = new Float32Array(nP), py = new Float32Array(nP);
      for (let p = 0; p < nP; p++) {
        const k = gI * 401 + t * 37 + p;
        px[p] = cx + (hash1f(k, semente + 23) - 0.5) * espalha * 2.4;
        py[p] = cy + (hash1f(k, semente + 29) - 0.5) * espalha * 1.5;
      }
      const passos = Math.max(48, w >> 3);
      for (let s = 0; s <= passos; s++) {
        const tt = (s / passos) * (nP - 1);
        const i0 = Math.min(nP - 2, tt | 0);
        const f = tt - i0;
        const sm = f * f * (3 - 2 * f);
        const ux = (px[i0] + (px[i0 + 1] - px[i0]) * sm) * w;
        const uy = (py[i0] + (py[i0 + 1] - py[i0]) * sm) * h;
        // Largura varia ao longo do traço (pressão do dedo na válvula)
        const lw = largura * (0.65 + 0.5 * Math.sin(s * 0.14 + gI));
        estampar(dist, grupo, w, h, ux, uy, lw, gI + 1);
      }
    }
  }
  return { dist, grupo };
}

/** Estampa um disco de raio `r` guardando a menor distância (com wrap). */
function estampar(dist, grupo, w, h, cx, cy, r, id) {
  const R = Math.ceil(r) + 2;
  const x0 = Math.round(cx), y0 = Math.round(cy);
  for (let dy = -R; dy <= R; dy++) {
    const yy = wrapi(y0 + dy, h) * w;
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy) - r;
      if (d > 2.5) continue;
      const idx = yy + wrapi(x0 + dx, w);
      if (d < dist[idx]) { dist[idx] = d; grupo[idx] = id; }
    }
  }
}

export async function gerarGrafite(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 5501;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fMusgo = campoMusgo(lab, N, semente + 7, 0.18);

  // Duas camadas: grafite colorido grande + pichação preta fina por cima.
  const peca = rasterizarTracos(w, h, semente + 101, { grupos: 5, larguraMin: 0.022, larguraMax: 0.055 });
  const pixo = rasterizarTracos(w, h, semente + 211, { grupos: 7, larguraMin: 0.0045, larguraMax: 0.010 });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x;
      const i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.71, 0);
      const rachas = dRacha(det, u, v, L(1), 0.09, 0.13, 0.29);

      // Muro de reboco cru como base
      const graoReb = dCel(det, u, v, L(8), 0.41, 0.19) * 0.55 + dGrao(det, u, v, L(8)) * 0.45;
      const baseL = 0.34 + graoReb * 0.24 + macro * 0.10;
      let r = baseL * 0.98, g = baseL * 0.96, b = baseL * 0.90;

      altura[i] = clamp01(0.58 + graoReb * 0.17 - rachas * 0.12);
      let rug = 0.90 + (graoReb - 0.5) * 0.10;

      // --- grafite colorido ---
      const dp = peca.dist[i];
      const gp = peca.grupo[i];
      if (gp > 0 && dp < 6) {
        // Borda do spray é difusa (overspray) e a tinta tem falhas.
        const bordaRuido = (dGrao(det, u, v, L(12), 0.23, 0.5) - 0.5) * 3.2;
        const cobertura = 1 - smoothstep(-1.5, 1.8, dp + bordaRuido);
        const falha = smoothstep(0.18, 0.55, dGrao(det, u, v, L(5), gp * 0.13, 0.6));
        const a = clamp01(cobertura * (0.55 + falha * 0.6));
        if (a > 0.01) {
          const c = CORES_SPRAY[(gp * 3 + 1) % CORES_SPRAY.length];
          const sombraInterna = smoothstep(-8, -1.5, dp) * 0.12;
          r += (c[0] * (1 - sombraInterna) - r) * a;
          g += (c[1] * (1 - sombraInterna) - g) * a;
          b += (c[2] * (1 - sombraInterna) - b) * a;
          rug += (0.58 - rug) * a;
          altura[i] = clamp01(altura[i] + a * 0.02);
        }
        // Contorno preto (outline) que todo grafite de rua tem
        const outline = 1 - smoothstep(0.5, 3.2, Math.abs(dp - 1.2));
        if (outline > 0.02) {
          const ao = outline * 0.8;
          r += (0.06 - r) * ao; g += (0.05 - g) * ao; b += (0.06 - b) * ao;
          rug += (0.55 - rug) * ao;
        }
      }

      // --- pichação preta por cima ---
      const dx2 = pixo.dist[i];
      if (dx2 < 3) {
        const aa = clamp01((1 - smoothstep(-0.8, 1.2, dx2)) * (0.7 + dGrao(det, u, v, L(12), 0.41, 0.9) * 0.4));
        r += (0.055 - r) * aa; g += (0.05 - g) * aa; b += (0.055 - b) * aa;
        rug += (0.62 - rug) * aa;
      }

      // Escorrido de tinta (a lata pinga)
      if (gp > 0) {
        const pingo = smoothstep(0.80, 0.95, dRiscoV(det, u, v, L(10), 0.53, 0)) *
          smoothstep(0.4, 0.0, v) * 0.6;
        if (pingo > 0.02) {
          const c = CORES_SPRAY[(gp * 3 + 1) % CORES_SPRAY.length];
          r += (c[0] * 0.8 - r) * pingo; g += (c[1] * 0.8 - g) * pingo; b += (c[2] * 0.8 - b) * pingo;
        }
      }

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(escorre * 0.40 + macro * 0.16));
      const m = musgo * 0.70;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      const rk = rachas * 0.7;
      _rgb[0] += (0.09 - _rgb[0]) * rk;
      _rgb[1] += (0.085 - _rgb[1]) * rk;
      _rgb[2] += (0.08 - _rgb[2]) * rk;

      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));
      rugosidade[i] = clamp(rug + (0.97 - rug) * (musgo * 0.8), 0.35, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.6,
    aoRaioLargo: 12, aoRaioFino: 3, aoForca: 1.0,
    props: {},
  };
}

// ===========================================================================
// AZULEJO — 15×15 cm, banheiro/cozinha/fachada de bar
// ===========================================================================

export async function gerarAzulejo(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 8101;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const CEL = 8;              // 8 azulejos por tile (1,20 m ⇒ peça de 15 cm)
  const REJUNTE = 0.035;      // ~5 mm
  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fMusgo = campoMusgo(lab, N, semente + 5, 0.16);

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x;
      const i4 = i * 4;

      const gx = u * CEL, gy = v * CEL;
      const cx = gx | 0, cy = gy | 0;
      const fx = gx - cx, fy = gy - cy;
      const dx = fx < 1 - fx ? fx : 1 - fx;
      const dy = fy < 1 - fy ? fy : 1 - fy;
      const d = dx < dy ? dx : dy;
      const peca = smoothstep(REJUNTE * 0.5, REJUNTE * 0.5 + 0.014, d);

      const hp = hash2f(cx, cy, semente);
      const hp2 = hash2f(cx, cy, semente + 77);

      const macro = ler(fMacro, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.37, 0);

      const caiu = hp2 > 0.93 ? 1 : 0;
      const trinca = (hp2 > 0.80 && hp2 <= 0.93)
        ? smoothstep(0.05, 0.0, Math.abs(dRidged(det, u, v, L(2), cx * 0.11, cy * 0.07) - 0.70))
        : 0;

      // Altura: peça levemente convexa, rejunte fundo
      let hgt = 0.32 + (0.72 + (0.5 - (dx > dy ? dx : dy)) * 0.05 - 0.32) * peca;
      hgt -= trinca * 0.10;
      if (caiu) hgt = 0.30 + dGrao(det, u, v, L(8)) * 0.12;
      altura[i] = clamp01(hgt);

      let r, g, b, rug;
      if (caiu) {
        const gA = dGrao(det, u, v, L(8), 0.19, 0.61);
        const l = 0.72 + gA * 0.3;
        r = CIMENTO[0] * l; g = CIMENTO[1] * l; b = CIMENTO[2] * l;
        rug = 0.94;
      } else if (peca > 0.5) {
        // Paleta de azulejo popular: branco creme, azul claro, verde água
        let b0, b1, b2;
        if (hp < 0.62) { b0 = 0.90; b1 = 0.89; b2 = 0.855; }
        else if (hp < 0.82) { b0 = 0.66; b1 = 0.78; b2 = 0.83; }
        else { b0 = 0.70; b1 = 0.80; b2 = 0.72; }
        const craquele = smoothstep(0.80, 0.99, dRidged(det, u, v, L(3), 0.23, 0.71));
        const g2 = dGraoFino(det, u, v, L(4));
        const l = 0.96 + g2 * 0.08;
        r = b0 * l - craquele * 0.10; g = b1 * l - craquele * 0.10; b = b2 * l - craquele * 0.09;
        // Esmalte: bem liso, com desgaste irregular
        rug = 0.16 + craquele * 0.35 + macro * 0.14 + (1 - v) * 0.08;
      } else {
        // Rejunte encardido
        const gA = dGrao(det, u, v, L(8), 0.31, 0.83);
        const encardido = clamp01(macro * 0.7 + escorre * 0.5);
        const l = 0.85 + gA * 0.3;
        r = (0.80 + (0.34 - 0.80) * encardido) * l;
        g = (0.79 + (0.32 - 0.79) * encardido) * l;
        b = (0.76 + (0.30 - 0.76) * encardido) * l;
        rug = 0.90;
      }

      const tk = trinca * 0.8;
      r += (0.12 - r) * tk; g += (0.12 - g) * tk; b += (0.13 - b) * tk;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(escorre * 0.30 + macro * 0.12));
      const m = musgo * 0.55;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      rugosidade[i] = clamp(rug + (0.95 - rug) * (musgo * 0.8), 0.10, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 2.2,
    aoRaioLargo: 10, aoRaioFino: 2.5, aoForca: 1.1,
    props: {},
  };
}
