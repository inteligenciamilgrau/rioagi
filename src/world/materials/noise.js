/**
 * noise.js — biblioteca de ruído procedural do projeto (implementação própria, sem libs).
 * Dono: MAT.
 *
 * Tudo aqui é **periódico/tileable**: as funções recebem o período em células (px, py)
 * e repetem exatamente nesse intervalo. Isso é o que permite gerar texturas que dão
 * tile sem costura visível. Se você usar frequência não-inteira o tile quebra —
 * mantenha `freq` inteiro e `lacunaridade` = 2.
 *
 * Convenção de espaço: os geradores trabalham em "espaço de tile" u,v ∈ [0,1).
 * Para amostrar com N células por tile: perlin2(u*N, v*N, N, N, semente).
 *
 * Performance: nada aqui aloca. Funções que devolvem múltiplos valores escrevem em
 * um array de saída passado pelo chamador (pré-alocado em escopo de módulo).
 */

// ---------------------------------------------------------------------------
// Utilidades escalares
// ---------------------------------------------------------------------------

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export const fract = (x) => x - Math.floor(x);

/**
 * smoothstep clássico do GLSL. Está no caminho quente de todo gerador (dezenas de
 * chamadas por pixel), por isso é escrito sem guardas: `borda1 === borda0` é erro
 * de chamada, não caso a tratar.
 */
export function smoothstep(borda0, borda1, x) {
  let t = (x - borda0) / (borda1 - borda0);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/** Remapeia [a,b] -> [0,1] com clamp. */
export function remap01(x, a, b) {
  return clamp01((x - a) / (b - a || 1e-9));
}

/** Remapeia [a,b] -> [c,d] sem clamp. */
export function remap(x, a, b, c, d) {
  return c + ((x - a) / (b - a || 1e-9)) * (d - c);
}

/** Curva de contraste em torno de 0.5 (k>1 aumenta contraste). */
export function contraste(x, k) {
  return clamp01(0.5 + (x - 0.5) * k);
}

/** Interpolação de Hermite quíntica de Perlin: 6t⁵ − 15t⁴ + 10t³. */
export function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ---------------------------------------------------------------------------
// PRNG determinístico
// ---------------------------------------------------------------------------

/** Mulberry32 — gerador rápido e determinístico. Devolve função () -> [0,1). */
export function mulberry32(semente) {
  let a = semente >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash inteiro 2D -> uint32. Base de todo o resto. */
export function hash2i(x, y, semente) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(semente | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash 2D -> [0,1). */
export function hash2f(x, y, semente) {
  return hash2i(x, y, semente) / 4294967296;
}

/** Hash 1D -> [0,1). Útil para atributos por bloco/índice. */
export function hash1f(i, semente) {
  return hash2i(i, 0x5bf03635, semente) / 4294967296;
}

/** Módulo positivo (wrap de índice de célula). */
export function wrapi(n, p) {
  const m = n % p;
  return m < 0 ? m + p : m;
}

// ---------------------------------------------------------------------------
// Value noise periódico
// ---------------------------------------------------------------------------

/**
 * Ruído de valor periódico. Mais barato que Perlin, tem "blobs" mais moles.
 * Bom para máscaras macro (manchas grandes) onde a estrutura direcional não importa.
 * @returns [0,1]
 */
export function valor2(x, y, px, py, semente) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const x0 = wrapi(xi, px), x1 = wrapi(xi + 1, px);
  const y0 = wrapi(yi, py), y1 = wrapi(yi + 1, py);

  const a = hash2i(x0, y0, semente) / 4294967296;
  const b = hash2i(x1, y0, semente) / 4294967296;
  const c = hash2i(x0, y1, semente) / 4294967296;
  const d = hash2i(x1, y1, semente) / 4294967296;

  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

// ---------------------------------------------------------------------------
// Perlin (gradiente) periódico
// ---------------------------------------------------------------------------

const S = Math.SQRT1_2;
const GRAD_X = new Float32Array([1, -1, 0, 0, S, -S, S, -S]);
const GRAD_Y = new Float32Array([0, 0, 1, -1, S, S, -S, -S]);

function pontoGrad(hx, hy, semente, dx, dy) {
  const g = hash2i(hx, hy, semente) & 7;
  return GRAD_X[g] * dx + GRAD_Y[g] * dy;
}

/**
 * Ruído de Perlin 2D periódico.
 * @returns aproximadamente [-1,1]
 */
export function perlin2(x, y, px, py, semente) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fade(fx);
  const v = fade(fy);

  const x0 = wrapi(xi, px), x1 = wrapi(xi + 1, px);
  const y0 = wrapi(yi, py), y1 = wrapi(yi + 1, py);

  const n00 = pontoGrad(x0, y0, semente, fx, fy);
  const n10 = pontoGrad(x1, y0, semente, fx - 1, fy);
  const n01 = pontoGrad(x0, y1, semente, fx, fy - 1);
  const n11 = pontoGrad(x1, y1, semente, fx - 1, fy - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  // 1.4 normaliza o alcance dos 8 gradientes para ~[-1,1]
  return (a + (b - a) * v) * 1.4;
}

/** Perlin remapeado para [0,1]. */
export function perlin2n(x, y, px, py, semente) {
  return clamp01(perlin2(x, y, px, py, semente) * 0.5 + 0.5);
}

// ---------------------------------------------------------------------------
// FBM (Fractional Brownian Motion)
// ---------------------------------------------------------------------------

/**
 * FBM de Perlin periódico. `freq` deve ser inteiro; cada oitava dobra freq E período,
 * então o resultado continua tileable em [0,1).
 * @returns aproximadamente [-1,1]
 */
export function fbm2(x, y, freq, oitavas, semente, ganho = 0.5, lac = 2) {
  let soma = 0, amp = 1, norm = 0;
  let f = freq;
  for (let o = 0; o < oitavas; o++) {
    const p = Math.max(1, Math.round(f));
    soma += perlin2(x * p, y * p, p, p, semente + o * 1013) * amp;
    norm += amp;
    amp *= ganho;
    f *= lac;
  }
  return soma / (norm || 1);
}

/** FBM em [0,1]. */
export function fbm2n(x, y, freq, oitavas, semente, ganho = 0.5, lac = 2) {
  return clamp01(fbm2(x, y, freq, oitavas, semente, ganho, lac) * 0.5 + 0.5);
}

/** FBM de valor — mais macio, mais barato. [0,1] */
export function fbmValor2(x, y, freq, oitavas, semente, ganho = 0.5) {
  let soma = 0, amp = 1, norm = 0;
  let f = freq;
  for (let o = 0; o < oitavas; o++) {
    const p = Math.max(1, Math.round(f));
    soma += valor2(x * p, y * p, p, p, semente + o * 7919) * amp;
    norm += amp;
    amp *= ganho;
    f *= 2;
  }
  return soma / (norm || 1);
}

/**
 * FBM "ridged" (cristas): |perlin| invertido. Cria veios, rachaduras, montanhas.
 * @returns [0,1]
 */
export function ridged2(x, y, freq, oitavas, semente, ganho = 0.5) {
  let soma = 0, amp = 1, norm = 0;
  let f = freq;
  for (let o = 0; o < oitavas; o++) {
    const p = Math.max(1, Math.round(f));
    const n = 1 - Math.abs(perlin2(x * p, y * p, p, p, semente + o * 3571));
    soma += n * n * amp;
    norm += amp;
    amp *= ganho;
    f *= 2;
  }
  return clamp01(soma / (norm || 1));
}

/** FBM "billow" (bolhas): |perlin|. Bom para nuvens, ferrugem, musgo. [0,1] */
export function billow2(x, y, freq, oitavas, semente, ganho = 0.5) {
  let soma = 0, amp = 1, norm = 0;
  let f = freq;
  for (let o = 0; o < oitavas; o++) {
    const p = Math.max(1, Math.round(f));
    soma += Math.abs(perlin2(x * p, y * p, p, p, semente + o * 6151)) * amp;
    norm += amp;
    amp *= ganho;
    f *= 2;
  }
  return clamp01(soma / (norm || 1));
}

// ---------------------------------------------------------------------------
// Worley / Voronoi periódico
// ---------------------------------------------------------------------------

const _worleyTmp = new Float32Array(4);

/**
 * Worley periódico com jitter. Escreve em `saida`:
 *   [0] = F1 (distância à célula mais próxima, ~[0,1])
 *   [1] = F2 (segunda mais próxima)
 *   [2] = id aleatório [0,1) da célula vencedora
 *   [3] = índice linear da célula vencedora (para atributos por célula)
 *
 * @param {number} jitter 0 = grade regular, 1 = totalmente aleatório
 */
export function worley2(x, y, px, py, semente, saida = _worleyTmp, jitter = 1) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0, cel = 0;

  for (let j = -1; j <= 1; j++) {
    const cy = yi + j;
    const wy = wrapi(cy, py);
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const wx = wrapi(cx, px);
      const hA = hash2i(wx, wy, semente);
      const hB = hash2i(wx, wy, semente ^ 0x1e35a7bd);
      const jx = 0.5 + ((hA & 0xffff) / 65536 - 0.5) * jitter;
      const jy = 0.5 + ((hB & 0xffff) / 65536 - 0.5) * jitter;
      const dx = cx + jx - x;
      const dy = cy + jy - y;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; id = hA; cel = wy * px + wx; }
      else if (d < f2) { f2 = d; }
    }
  }
  saida[0] = Math.sqrt(f1);
  saida[1] = Math.sqrt(f2);
  saida[2] = (id >>> 8) / 16777216;
  saida[3] = cel;
  return saida;
}

/** Bordas de Voronoi (F2−F1): perto de 0 nas fronteiras. Ideal para juntas/rachaduras. */
export function voronoiBordas(x, y, px, py, semente, jitter = 1) {
  worley2(x, y, px, py, semente, _worleyTmp, jitter);
  return _worleyTmp[1] - _worleyTmp[0];
}

/** FBM de Worley invertido — granulação tipo agregado de concreto/asfalto. [0,1] */
export function worleyFbm(x, y, freq, oitavas, semente, ganho = 0.5) {
  let soma = 0, amp = 1, norm = 0;
  let f = freq;
  for (let o = 0; o < oitavas; o++) {
    const p = Math.max(1, Math.round(f));
    worley2(x * p, y * p, p, p, semente + o * 4409, _worleyTmp, 1);
    soma += (1 - clamp01(_worleyTmp[0])) * amp;
    norm += amp;
    amp *= ganho;
    f *= 2;
  }
  return clamp01(soma / (norm || 1));
}

// ---------------------------------------------------------------------------
// Domain warping
// ---------------------------------------------------------------------------

const _warpTmp = new Float32Array(2);

/**
 * Domain warping: desloca as coordenadas por outro campo de ruído antes de amostrar.
 * É o que transforma ruído "de computador" em manchas orgânicas de parede velha.
 * Escreve [x', y'] em `saida`. Continua tileable porque o deslocamento também é periódico.
 */
export function warp2(x, y, freq, amp, semente, saida = _warpTmp) {
  const p = Math.max(1, Math.round(freq));
  saida[0] = x + perlin2(x * p, y * p, p, p, semente) * amp;
  saida[1] = y + perlin2(x * p, y * p, p, p, semente + 5237) * amp;
  return saida;
}

/** FBM com domain warping embutido — o combo padrão para sujeira/manchas. [0,1] */
export function fbmWarp(x, y, freq, oitavas, semente, ampWarp = 0.35, freqWarp = 2) {
  warp2(x, y, freqWarp, ampWarp, semente + 991, _warpTmp);
  return fbm2n(_warpTmp[0], _warpTmp[1], freq, oitavas, semente);
}

// ---------------------------------------------------------------------------
// Ruídos direcionais (escorrimento de chuva, escovado, fibras)
// ---------------------------------------------------------------------------

/**
 * Ruído esticado no eixo Y — simula escorrimento vertical de água suja.
 * `esticamento` alto = riscos longos. `freq` controla quantos riscos na horizontal.
 * @returns [0,1]
 */
export function riscosVerticais(x, y, freq, esticamento, semente, oitavas = 3) {
  // Comprime Y para que as células fiquem alongadas; período em Y proporcional.
  const fy = Math.max(1, Math.round(freq / esticamento));
  let soma = 0, amp = 1, norm = 0;
  let fx = freq, fyi = fy;
  for (let o = 0; o < oitavas; o++) {
    const px = Math.max(1, Math.round(fx));
    const py = Math.max(1, Math.round(fyi));
    soma += perlin2(x * px, y * py, px, py, semente + o * 2357) * amp;
    norm += amp;
    amp *= 0.55;
    fx *= 2; fyi *= 2;
  }
  return clamp01((soma / (norm || 1)) * 0.5 + 0.5);
}

/** Igual, mas horizontal (metal escovado, fibras de madeira ao longo de X). */
export function riscosHorizontais(x, y, freq, esticamento, semente, oitavas = 3) {
  return riscosVerticais(y, x, freq, esticamento, semente, oitavas);
}

// ---------------------------------------------------------------------------
// Máscara de descascamento (tinta soltando)
// ---------------------------------------------------------------------------

/**
 * Máscara de casca de tinta: regiões conectadas com borda irregular e "ilhas".
 * Combina FBM com warp e um limiar suave; a borda ganha um realce (a casca levanta).
 * Escreve em `saida`: [0] = 1 onde a tinta ainda existe, [1] = proximidade da borda [0,1].
 */
const _cascaTmp = new Float32Array(2);
export function mascaraCasca(x, y, freq, limiar, semente, saida = _cascaTmp) {
  warp2(x, y, 3, 0.22, semente + 313, _warpTmp);
  const n = fbm2n(_warpTmp[0], _warpTmp[1], freq, 5, semente);
  const d = n - limiar;                      // distância assinada ao limiar
  saida[0] = smoothstep(-0.02, 0.03, d);     // 1 = tinta intacta
  saida[1] = 1 - smoothstep(0, 0.06, Math.abs(d)); // 1 = exatamente na borda da casca
  return saida;
}

// ---------------------------------------------------------------------------
// Amostragem bilinear com wrap sobre campos pré-calculados
// ---------------------------------------------------------------------------

/**
 * Amostra bilinear com wrap num campo QUADRADO de lado potência de dois.
 * É o caminho quente da geração: o wrap vira um AND, sem módulo, sem Math.floor
 * em número negativo. `mask` = n − 1.
 *
 * u,v estão em unidades de campo já escaladas (podem ser > 1 ou negativas).
 */
export function amostra(campo, n, mask, u, v) {
  const fx = u * n - 0.5;
  const fy = v * n - 0.5;
  const x0 = fx | 0, y0 = fy | 0;
  const bx = fx < 0 ? x0 - 1 : x0;          // |0 trunca em direção a zero
  const by = fy < 0 ? y0 - 1 : y0;
  const tx = fx - bx, ty = fy - by;
  const ix0 = bx & mask, ix1 = (bx + 1) & mask;
  const iy0 = (by & mask) * n, iy1 = ((by + 1) & mask) * n;
  const a = campo[iy0 + ix0], b = campo[iy0 + ix1];
  const c = campo[iy1 + ix0], d = campo[iy1 + ix1];
  const ab = a + (b - a) * tx;
  return ab + ((c + (d - c) * tx) - ab) * ty;
}

/** Amostra por vizinho mais próximo (para IDs de célula, que não podem ser interpolados). */
export function amostraNN(campo, n, mask, u, v) {
  const x = ((u * n) | 0) & mask;
  const y = ((v * n) | 0) & mask;
  return campo[y * n + x];
}

/**
 * Amostra bilinear com wrap num Float32Array w×h, em coordenadas de tile [0,1).
 * Versão genérica (não exige potência de dois). Usada fora do caminho quente.
 */
export function amostrarCampo(campo, w, h, u, v) {
  const fx = (u - Math.floor(u)) * w - 0.5;
  const fy = (v - Math.floor(v)) * h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const ix0 = wrapi(x0, w), ix1 = wrapi(x0 + 1, w);
  const iy0 = wrapi(y0, h) * w, iy1 = wrapi(y0 + 1, h) * w;
  const a = campo[iy0 + ix0], b = campo[iy0 + ix1];
  const c = campo[iy1 + ix0], d = campo[iy1 + ix1];
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

// ---------------------------------------------------------------------------
// Conversão de cor (os geradores pensam em HSL, o buffer é RGB)
// ---------------------------------------------------------------------------

const _rgbTmp = new Float32Array(3);

/** HSL -> RGB linear-ish em [0,1]. h em voltas [0,1). Escreve em `saida`. */
export function hsl2rgb(h, s, l, saida = _rgbTmp) {
  h = h - Math.floor(h);
  if (s <= 0) { saida[0] = saida[1] = saida[2] = l; return saida; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  saida[0] = hue2c(p, q, h + 1 / 3);
  saida[1] = hue2c(p, q, h);
  saida[2] = hue2c(p, q, h - 1 / 3);
  return saida;
}

function hue2c(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
