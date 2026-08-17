/**
 * generators/comum.js — vocabulário compartilhado pelos geradores de superfície.
 * Dono: MAT.
 *
 * ## Como o detalhe é amostrado (leia antes de mexer num gerador)
 * FBM com domain warping custa ~400 operações por pixel; Worley de 2 oitavas, ~450.
 * Chamar isso dezenas de vezes por pixel em 26 superfícies é o que separa 2 s de 16 s
 * de geração. Por isso **ninguém calcula ruído por pixel aqui**: o `TextureLab` assa
 * uma vez um banco de campos tileáveis (`lab.det`) e os geradores só amostram
 * (`dGrao`, `dCel`, `dRisco`…), a ~18 operações.
 *
 * Cada helper `d*` recebe `esc` = **quantas vezes o campo se repete no tile**.
 * Precisa ser INTEIRO, senão a textura deixa de fechar o tile. `ox`/`oy` deslocam
 * a amostragem e funcionam como troca de semente de graça.
 *
 * Regra prática de `esc`: para o detalhe ficar 1:1 com os texels, use
 * `esc = resolucaoDaTextura / lab.det.n`. Valores maiores viram grão mais fino.
 */

import {
  perlin2, perlin2n, fbm2n, fbmValor2, fbmWarp, worley2, worleyFbm, ridged2, billow2,
  riscosVerticais, amostra, amostraNN, amostrarCampo, hash1f, hash2f, hash2i,
  clamp01, clamp, mix, smoothstep, remap01, hsl2rgb, wrapi, fract,
} from '../noise.js';
import { BANCO } from '../TextureLab.js';

// ---------------------------------------------------------------------------
// Alvo de geração
// ---------------------------------------------------------------------------

/**
 * Cria o conjunto de buffers que todo gerador preenche.
 * `aoExtra = null` significa "deixe o TextureLab derivar a oclusão por cavidade
 * a partir do height", que é o caminho normal.
 */
export function novoAlvo(lab, w, h) {
  return {
    w, h,
    albedo: lab.bufferRGBA(w, h),
    altura: lab.campo(w, h, 0.5),
    rugosidade: lab.campo(w, h, 0.85),
    metalico: lab.campo(w, h, 0),
    aoExtra: null,
  };
}

/** Escreve um pixel de albedo. r,g,b em [0,1] (espaço sRGB — é assim que albedo é autorado). */
export function setRGB(albedo, i4, r, g, b) {
  albedo[i4] = r * 255;
  albedo[i4 + 1] = g * 255;
  albedo[i4 + 2] = b * 255;
  albedo[i4 + 3] = 255;
}

// ---------------------------------------------------------------------------
// Amostradores do banco de detalhes (caminho quente)
// ---------------------------------------------------------------------------

/** Granulação média [0,1] — poros de reboco, grão de cerâmica, fibra grossa. */
export function dGrao(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.grao, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Poro fino [0,1] — a última escala de detalhe antes do texel. */
export function dGraoFino(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.graoFino, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Agregado celular [0,1] — brita, areia, crosta de ferrugem, bolha. */
export function dCel(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.celular, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Distância à célula mais próxima [0,1] — 0 no centro da pedra, 1 na borda. */
export function dCelF1(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.celF1, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Identificador da célula [0,1), constante dentro de cada célula (sem interpolação). */
export function dCelId(det, u, v, esc, ox = 0, oy = 0) {
  return amostraNN(det.celId, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/**
 * Fronteira de Voronoi da MESMA grade de `dCelF1`/`dCelId`: 0 exatamente na fresta
 * entre duas células, 1 no miolo. É o que dá pedra de calçada, paralelepípedo e
 * placa de pedra — células que preenchem o plano com uma junta fina entre elas.
 */
export function dCelBorda(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.celBorda, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Ruído esticado no eixo vertical — escorrimento de chuva, fibra, ondulação. */
export function dRiscoV(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.risco, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** O mesmo campo, esticado no eixo horizontal (basta trocar u por v). */
export function dRiscoH(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.risco, det.n, det.mask, v * esc + ox, u * esc + oy);
}

/** FBM de Perlin genérico [0,1]. */
export function dFbm(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.fbm, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** FBM com domain warp [0,1] — a mancha orgânica que quebra a repetição. */
export function dMancha(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.mancha, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Arestas de Voronoi: 0 exatamente na fresta, 1 no miolo da célula. */
export function dRachaBruta(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.rachas, det.n, det.mask, u * esc + ox, v * esc + oy);
}

/** Cristas [0,1] — veio de pedra, craquelê de esmalte. */
export function dRidged(det, u, v, esc, ox = 0, oy = 0) {
  return amostra(det.ridged, det.n, det.mask, u * esc + ox, v * esc + oy);
}

// ---------------------------------------------------------------------------
// Camadas de intemperismo compostas (ainda no caminho quente, mas baratas)
// ---------------------------------------------------------------------------

/**
 * Rachadura pronta: 1 na fenda, 0 fora. `largura` em unidades de aresta de Voronoi.
 * Um segundo campo apaga trechos, porque rachadura real não percorre a célula inteira.
 */
export function dRacha(det, u, v, esc, largura = 0.10, ox = 0, oy = 0) {
  const borda = dRachaBruta(det, u, v, esc, ox, oy);
  const linha = 1 - smoothstep(0, largura, borda);
  if (linha <= 0) return 0;
  const quebra = smoothstep(0.35, 0.62, dFbm(det, u, v, Math.max(1, esc >> 1), ox + 0.31, oy + 0.17));
  return linha * quebra;
}

/**
 * Escorrimento de chuva: riscos verticais finos, com intensidade variando de
 * risco para risco. `esc` controla quantos riscos cabem na horizontal
 * (esc = 1 ⇒ ~40 riscos por tile, que é o certo para uma parede de 2–3 m).
 *
 * **Não depende de `v` de propósito.** Um degradê vertical dentro do tile fica
 * lindo numa amostra isolada e péssimo no jogo: quando WORLD repete a textura
 * duas vezes na altura de uma parede, o degradê vira faixa e denuncia o tiling.
 * A variação de altura real fica por conta da geometria/UV de quem monta a cena.
 */
export function dEscorrimento(det, u, v, esc, ox = 0, oy = 0) {
  const risco = dRiscoV(det, u, v, esc, ox, oy);
  const fino = smoothstep(0.54, 0.86, risco);
  if (fino <= 0) return 0;
  // Cada trilha tem uma intensidade própria (campo de baixa frequência em u).
  const forca = dFbm(det, u, v * 0.12, 1, ox + 0.53, oy);
  return fino * (0.45 + forca * 0.75);
}

/**
 * Teto de escala de amostragem para uma resolução. Acima de ~4 amostras do banco
 * por texel o campo só produz ruído aliasado, então não adianta pedir mais.
 * Note que `esc` em si é INDEPENDENTE de resolução: um tijolo gerado a 512 e a
 * 2048 precisa ter o grão do MESMO tamanho no mundo.
 */
export function tetoEscala(w, det) {
  return Math.max(2, Math.round((w / det.n) * 4));
}

// ---------------------------------------------------------------------------
// Assar campos macro (baixa frequência ⇒ 128² basta e sai quase de graça)
// ---------------------------------------------------------------------------

export const N_MACRO = 128;

/** Assa um campo escalar n×n a partir de fn(u, v). */
export function assar(lab, n, fn) {
  const c = lab.campo(n, n);
  const inv = 1 / n;
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < n; x++) c[y * n + x] = fn((x + 0.5) * inv, v);
  }
  return c;
}

/** Amostra bilinear com wrap num campo macro quadrado. `n` DEVE ser potência de dois. */
export function ler(campo, n, u, v) {
  return amostra(campo, n, n - 1, u, v);
}

/**
 * ## Variação de BANDA LARGA — o antídoto do "rabisco de minhoca"
 *
 * O erro que esta função existe para corrigir: `det.mancha` é um FBM com domain
 * warp forte (`ampWarp = 0.5`). Sozinho ele tem uma assinatura visual muito
 * marcante — filamentos curvos, tipo veio de mármore. Quando um gerador o
 * transforma em máscara com um `smoothstep` ESTREITO (`smoothstep(0.50, 0.80, …)`),
 * o que sai não é uma mancha: é a **faixa de nível** daquele campo, ou seja um
 * risco sinuoso de espessura constante. Repetido no ladrilho, vira um padrão
 * reconhecível — exatamente o defeito que reprova uma textura de chão.
 *
 * Como isto evita o problema:
 *  1. **Soma campos DIFERENTES do banco**, não o mesmo campo em escalas diferentes.
 *     Campos distintos têm estatística distinta, então nenhuma forma domina.
 *  2. **Várias escalas por oitava**, de macro (1) a grão (32), com pesos decrescentes.
 *  3. O resultado é ~gaussiano e sem estrutura preferencial. Se você aplicar um
 *     `smoothstep` estreito NELE, sai mancha irregular — não risco.
 *
 * @returns [0,1] centrado em ~0,5
 */
export function dBandaLarga(det, u, v, s = 0) {
  // ox/oy distintos por termo: o mesmo campo amostrado longe de si mesmo é,
  // na prática, um campo independente.
  const a = dFbm(det, u, v, 1, s * 0.31, s * 0.73);            // macro
  const b = dMancha(det, u, v, 1, s * 0.57 + 0.13, s * 0.19);  // macro orgânico
  const c = dCel(det, u, v, 2, s * 0.41, s * 0.87);            // meso aglomerado
  const d = dRidged(det, u, v, 3, s * 0.11, s * 0.63);         // meso fibroso
  const e = dGrao(det, u, v, 8, s * 0.83, s * 0.29);           // micro
  const f = dGraoFino(det, u, v, 32, s * 0.67, s * 0.47);      // grão
  // Pesos somam 1. O macro pesa mais (é o que quebra o tiling), mas nunca tanto
  // a ponto de a forma dele ficar legível sozinha.
  const s6 = a * 0.26 + b * 0.24 + c * 0.20 + d * 0.13 + e * 0.11 + f * 0.06;
  /**
   * **Reexpansão obrigatória.** Somar seis campos quase independentes é uma
   * média: pelo teorema central do limite o desvio-padrão cai a ~0,45 do de um
   * campo só, e tudo encolhe para perto de 0,5. Sem esta linha o resultado é
   * uma textura sem contraste — troca-se "rabisco reconhecível" por "sopa", que
   * reprova igual. O `tanh` reexpande sem cortar os extremos em patamar chapado.
   */
  return clamp01(0.5 + Math.tanh((s6 - 0.5) * 4.6) * 0.5);
}

/**
 * Manchas macro — a variação de escala grande que impede a repetição visível de
 * tiling. A ausência desta camada é o erro nº 1 em textura procedural.
 */
export function campoManchasMacro(lab, n, semente, freq = 2) {
  const det = lab.det;
  const s = (semente % 97) / 97;
  return assar(lab, n, (u, v) => clamp01(
    dMancha(det, u, v, Math.max(1, Math.round(freq)), s, s * 0.61) * 0.75 +
    dFbm(det, u, v, 1, s * 0.37, s * 0.83) * 0.35,
  ));
}

/**
 * ## Sobre viés vertical (leia antes de usar `campoMusgo`/`campoSol`)
 * A tentação é escrever "musgo no rodapé, sol no topo" como um degradê em `v`.
 * Numa amostra isolada fica ótimo; no jogo é desastre — a textura repete N vezes
 * na altura de uma parede e o degradê vira faixa horizontal, o pecado nº 1 de
 * tiling visível. Aqui o padrão é: **a mancha vem do ruído macro**, e `v` entra
 * só como um peso suave (nunca como corte). Assim o tile fecha e o material
 * continua "lendo" a gravidade quando a UV cobre a parede inteira.
 */

/** Musgo/limo: placas irregulares, com leve preferência pela parte baixa. */
export function campoMusgo(lab, n, semente, intensidade = 0.22) {
  const det = lab.det;
  const s = (semente % 89) / 89;
  return assar(lab, n, (u, v) => {
    const placas = smoothstep(0.46, 0.80, dMancha(det, u, v, 2, s * 1.3, s * 0.2));
    const detalhe = smoothstep(0.35, 0.75, dMancha(det, u, v, 4, s * 0.7, s));
    const peso = 0.45 + 0.55 * (1 - v);          // viés suave, sem corte
    return clamp01(placas * (0.45 + detalhe * 0.8) * peso * (intensidade * 4.2));
  });
}

/** Desbotamento por sol: manchas macro com leve preferência pela parte alta. */
export function campoSol(lab, n, semente) {
  const det = lab.det;
  const s = (semente % 83) / 83;
  return assar(lab, n, (u, v) => {
    const mancha = dFbm(det, u, v, 1, s, s * 0.5) * 0.6 + dMancha(det, u, v, 1, s * 0.3, s) * 0.4;
    const peso = 0.5 + 0.5 * v;
    return clamp01(smoothstep(0.30, 0.80, mancha) * peso);
  });
}

/** Poeira/sujeira acumulada: manchas macro com leve peso para baixo. */
export function campoPoeira(lab, n, semente) {
  const det = lab.det;
  const s = (semente % 79) / 79;
  return assar(lab, n, (u, v) =>
    clamp01(dMancha(det, u, v, 1, s, s * 0.9) * (0.55 + 0.45 * (1 - v))));
}

/** Rede de rachaduras assada (para quando o gerador quer a máscara pronta e macia). */
export function campoRachaduras(lab, n, semente, densidade = 7, largura = 0.10) {
  const det = lab.det;
  const s = (semente % 71) / 71;
  // `densidade` está em células por tile; o campo do banco já tem BANCO.rachas.
  const esc = Math.max(1, Math.round(densidade / BANCO.rachas));
  return assar(lab, n, (u, v) => dRacha(det, u, v, esc, largura, s, s * 0.7));
}

// ---------------------------------------------------------------------------
// Paleta / cor
// ---------------------------------------------------------------------------

const _c = new Float32Array(3);

/** Cor a partir de HSL. Devolve Float32Array[3]. */
export function corHSL(h, s, l, saida = _c) {
  return hsl2rgb(h, clamp01(s), clamp01(l), saida);
}

/** Converte "#rrggbb" para [r,g,b] em [0,1]. */
export function hex(s) {
  const n = parseInt(s.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Aplica sujeira sobre uma cor (in-place): puxa em direção a um marrom fuliginoso.
 * É a camada que amarra visualmente todas as superfícies do jogo.
 */
export function sujar(rgb, quanto, corSujeira = SUJEIRA) {
  const t = clamp01(quanto);
  rgb[0] += (corSujeira[0] - rgb[0]) * t;
  rgb[1] += (corSujeira[1] - rgb[1]) * t;
  rgb[2] += (corSujeira[2] - rgb[2]) * t;
  return rgb;
}

export const SUJEIRA = [0.20, 0.175, 0.148];   // fuligem/terra
export const MUSGO = [0.16, 0.21, 0.10];       // limo verde escuro
export const EFLOR = [0.86, 0.85, 0.82];       // eflorescência (salitre)
export const CIMENTO = [0.60, 0.585, 0.55];    // argamassa curada

// ---------------------------------------------------------------------------
// Reexportações
// ---------------------------------------------------------------------------

export {
  BANCO,
  perlin2, perlin2n, fbm2n, fbmWarp, worley2, worleyFbm, ridged2, billow2,
  riscosVerticais, amostra, amostraNN, hash1f, hash2f, hash2i,
  clamp01, clamp, mix, smoothstep, remap01, wrapi, fract,
};
