/**
 * generators/madeira.js — compensado velho e tábua pintada. Dono: MAT.
 *
 * Na favela madeira é sempre material de reaproveitamento: chapa de compensado
 * de obra, tábua de caixote, porta velha. Nunca é madeira nobre — o veio é
 * grosseiro, tem mancha d'água, prego e tinta de outra vida por cima.
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, campoMusgo,
  dGrao, dGraoFino, dCel, dCelF1, dCelId, dRiscoV, dRiscoH, dFbm, dMancha,
  dEscorrimento,
  hex, sujar, MUSGO,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

const _rgb = new Float32Array(3);

const MAD_CLARA = hex('#c2a173');
const MAD_MEDIA = hex('#96764c');
const MAD_ESCURA = hex('#5e462c');

/**
 * Veio de madeira: anéis de crescimento deformados por domain warping barato.
 * `dir` 0 = anéis correm ao longo de X, 1 = ao longo de Y.
 */
function veio(det, u, v, freq, dir, escFibra) {
  const b = dir ? u : v;
  const a = dir ? v : u;      // eixo ao longo do veio
  // A perturbação transversal cria os "arcos" do desdobro tangencial. A amplitude
  // é deliberadamente pequena (±0,45 anel): com deslocamento grande os anéis se
  // cruzam e o resultado vira rastro de minhoca, não madeira. E a perturbação
  // varia sobretudo AO LONGO do veio — é assim que a tábua real se comporta.
  const warp = dFbm(det, a * 0.35, b * 1.6, 1, 0.13, 0.29) - 0.5;
  const warp2 = dFbm(det, a * 0.5, b, 2, 0.71, 0.03) - 0.5;
  const t = b * freq + warp * 0.9 + warp2 * 0.3;
  const aneis = Math.abs(Math.sin(t * Math.PI));
  const fibra = dir ? dRiscoV(det, u, v, escFibra) : dRiscoH(det, u, v, escFibra);
  // sqrt em vez de pow(_, 0.65): visualmente equivalente e ~5× mais barato num
  // laço que roda 1 M de vezes por superfície.
  return clamp01(Math.sqrt(aneis) * 0.75 + fibra * 0.35);
}

// ===========================================================================
// MADEIRA — compensado (plywood) velho
// ===========================================================================

export async function gerarMadeira(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 2417;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade, metalico } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fMusgo = campoMusgo(lab, N, semente + 7, 0.16);
  // Mancha d'água: o compensado incha e escurece em auréolas
  const fAgua = assar(lab, N, (u, v) => clamp01(
    smoothstep(0.48, 0.76, dMancha(det, u, v, 1, 0.11, 0.61)) * 0.75 +
    (1 - smoothstep(0, 0.5, v)) * 0.18));
  // Delaminação: a lâmina de cima descolando em placas
  const fDelam = assar(lab, N, (u, v) =>
    smoothstep(0.70, 0.86, dMancha(det, u, v, 2, 0.53, 0.19)));
  // Restos de tinta de obra
  const fTinta = assar(lab, N, (u, v) =>
    smoothstep(0.64, 0.78, dMancha(det, u, v, 1, 0.83, 0.37)));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    const gy = v * 6;
    const cy = gy | 0;
    const dyP = (gy - cy) - 0.5;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const manchaAgua = ler(fAgua, N, u, v);
      const delam = ler(fDelam, N, u, v);
      const tintaResto = ler(fTinta, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.53, 0);

      // 14 anéis por tile de 1,2 m ≈ 12 por metro: grão de lâmina de compensado.
      const vn = veio(det, u, v, 14, 0, L(4));
      const fibraFina = dGrao(det, u, v, L(12));

      // Nós da madeira: célula esparsa com anéis concêntricos
      const f1 = dCelF1(det, u, v, L(2), 0.29, 0.07);
      const idN = dCelId(det, u, v, L(2), 0.29, 0.07);
      const noh = idN > 0.88 ? (1 - smoothstep(0.06, 0.34, f1)) : 0;
      const anelNoh = noh > 0 ? Math.abs(Math.sin(f1 * 42)) : 0;

      // Furos de prego (grade irregular)
      const gx = u * 6;
      const cx = gx | 0;
      const dxP = (gx - cx) - 0.5;
      const temPrego = hash2f(cx, cy, semente + 31) > 0.80 ? 1 : 0;
      const prego = temPrego * (1 - smoothstep(0.05, 0.10, Math.sqrt(dxP * dxP + dyP * dyP)));

      let hgt = 0.62 + (vn - 0.5) * 0.10 + (fibraFina - 0.5) * 0.06;
      hgt += delam * 0.06;                        // lâmina levantada
      hgt -= noh * 0.05;
      hgt -= prego * 0.16;
      altura[i] = clamp01(hgt);

      // Cor: mistura de tons ao longo do veio
      const t = clamp01(vn * 0.85 + macro * 0.35 - 0.15);
      let ca, cb, tt;
      if (t < 0.5) { ca = MAD_ESCURA; cb = MAD_MEDIA; tt = t * 2; }
      else { ca = MAD_MEDIA; cb = MAD_CLARA; tt = (t - 0.5) * 2; }
      const l = 0.90 + fibraFina * 0.20;
      let r = (ca[0] + (cb[0] - ca[0]) * tt) * l;
      let g = (ca[1] + (cb[1] - ca[1]) * tt) * l;
      let b = (ca[2] + (cb[2] - ca[2]) * tt) * l;

      const cn = noh * (0.55 + anelNoh * 0.45);
      r += (MAD_ESCURA[0] * 0.55 - r) * cn;
      g += (MAD_ESCURA[1] * 0.52 - g) * cn;
      b += (MAD_ESCURA[2] * 0.50 - b) * cn;

      // Mancha d'água: escurece e acinzenta
      const ma = manchaAgua * 0.75;
      r += (r * 0.62 + 0.03 - r) * ma;
      g += (g * 0.63 + 0.03 - g) * ma;
      b += (b * 0.67 + 0.04 - b) * ma;

      // Madeira exposta ao tempo fica cinza-prata (fotodegradação da lignina)
      const grisalho = clamp01(macro * 0.6 + (1 - manchaAgua) * 0.25) * 0.35;
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      r += (luma * 1.02 + 0.06 - r) * grisalho;
      g += (luma * 1.01 + 0.06 - g) * grisalho;
      b += (luma * 1.02 + 0.07 - b) * grisalho;

      // Restos de tinta de obra
      const tr = tintaResto * 0.7;
      r += (0.72 - r) * tr; g += (0.71 - g) * tr; b += (0.66 - b) * tr;

      // Delaminação expõe a cola e a lâmina interna, mais clara
      const dl = delam * 0.5;
      r += (MAD_CLARA[0] * 1.05 - r) * dl;
      g += (MAD_CLARA[1] * 1.02 - g) * dl;
      b += (MAD_CLARA[2] * 0.95 - b) * dl;

      if (prego > 0.05) {
        const p = prego * 0.9;
        r += (0.32 - r) * p; g += (0.20 - g) * p; b += (0.13 - b) * p;
      }

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(escorre * 0.22 + macro * 0.12));
      const m = musgo * 0.55;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // Madeira intemperizada é bem áspera; a mancha d'água é ainda mais.
      let rug = 0.82 + (vn - 0.5) * 0.10 + (fibraFina - 0.5) * 0.12;
      rug += (0.95 - rug) * (manchaAgua * 0.6);
      rug += (0.99 - rug) * (delam * 0.7);
      rug += (0.62 - rug) * (tr * 0.5);
      rug += (0.97 - rug) * (musgo * 0.8);
      rugosidade[i] = clamp(rug, 0.40, 1);
      metalico[i] = prego > 0.5 ? 0.7 : 0;
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo, fAgua, fDelam, fTinta]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.5,
    aoRaioLargo: 12, aoRaioFino: 3, aoForca: 1.0,
    props: {},
  };
}

// ===========================================================================
// MADEIRA PINTADA — tábuas com tinta descascando
// ===========================================================================

export async function gerarMadeiraPintada(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 2917;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const cor = o.cor || hex('#3f6f8c');
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const TABUAS = 6;          // tábuas de ~20 cm num tile de 1,2 m
  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fMusgo = campoMusgo(lab, N, semente + 7, 0.20);
  const fCasca = assar(lab, N, (u, v) => {
    const n = dMancha(det, u, v, 2, 0.17, 0.43) * 0.7 + dFbm(det, u, v, 2, 0.61, 0.29) * 0.4;
    const umidade = (1 - smoothstep(0, 0.5, v)) * 0.22;
    return clamp01(n - umidade);
  });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    // Tábuas horizontais com fresta entre elas
    const gy = v * TABUAS;
    const tab = wrapi(gy | 0, TABUAS);
    const fy = gy - (gy | 0);
    const dFresta = fy < 1 - fy ? fy : 1 - fy;
    const face = smoothstep(0.018, 0.045, dFresta);
    const ht = hash1f(tab, semente + 19);          // cada tábua com espessura própria

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const cascaN = ler(fCasca, N, u, v);
      const escorre = dEscorrimento(det, u, v, L(1), 0.29, 0);

      const d = cascaN - 0.47;
      const tinta = smoothstep(-0.012, 0.024, d);
      const borda = 1 - smoothstep(0, 0.04, d < 0 ? -d : d);

      const vn = veio(det, u, v * 0.35 + tab * 0.17, 11, 1, L(4));
      const fibra = dGrao(det, u, v, L(12), 0.43, 0.11);

      let hgt = 0.30 + (0.66 + (ht - 0.5) * 0.06 - 0.30) * face;
      hgt += (vn - 0.5) * 0.06 * face;
      hgt += tinta * face * 0.035 + borda * tinta * face * 0.04;
      altura[i] = clamp01(hgt);

      // Madeira nua sob a tinta, já acinzentada pelo tempo
      const t = clamp01(vn * 0.8 + macro * 0.3);
      const lw = 0.9 + fibra * 0.2;
      let wr = (MAD_ESCURA[0] + (MAD_CLARA[0] - MAD_ESCURA[0]) * t) * lw;
      let wg = (MAD_ESCURA[1] + (MAD_CLARA[1] - MAD_ESCURA[1]) * t) * lw;
      let wb = (MAD_ESCURA[2] + (MAD_CLARA[2] - MAD_ESCURA[2]) * t) * lw;
      const luma = wr * 0.299 + wg * 0.587 + wb * 0.114;
      wr += (luma + 0.05 - wr) * 0.35; wg += (luma + 0.05 - wg) * 0.35; wb += (luma + 0.06 - wb) * 0.35;

      // Tinta
      const gt = dGrao(det, u, v, L(12), 0.31, 0.79);
      const lumaC = cor[0] * 0.299 + cor[1] * 0.587 + cor[2] * 0.114;
      const desbota = clamp01(macro * 0.5 + v * 0.4) * 0.5;
      const lp = 0.92 + gt * 0.16;
      const pr = (cor[0] + (lumaC * 1.16 + 0.10 - cor[0]) * desbota) * lp;
      const pg = (cor[1] + (lumaC * 1.13 + 0.10 - cor[1]) * desbota) * lp;
      const pb = (cor[2] + (lumaC * 1.09 + 0.11 - cor[2]) * desbota) * lp;

      let r = wr + (pr - wr) * tinta, g = wg + (pg - wg) * tinta, b = wb + (pb - wb) * tinta;
      const sombraBorda = borda * tinta * 0.45 * 0.4;
      r *= 1 - sombraBorda; g *= 1 - sombraBorda; b *= 1 - sombraBorda;
      // Fresta escura entre tábuas
      r = 0.05 + (r - 0.05) * face; g = 0.05 + (g - 0.05) * face; b = 0.055 + (b - 0.055) * face;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(escorre * 0.34 + macro * 0.16 + (1 - face) * 0.4));
      const m = musgo * 0.72;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      let rug = 0.90 + (0.55 - 0.90) * tinta;
      rug += (gt - 0.5) * 0.10;
      rug += (0.97 - rug) * (musgo * 0.85);
      rug += (0.95 - rug) * ((1 - face) * 0.8);
      rugosidade[i] = clamp(rug, 0.32, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo, fCasca]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.8,
    aoRaioLargo: 12, aoRaioFino: 3, aoForca: 1.15,
    props: {},
  };
}
