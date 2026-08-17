/**
 * generators/concreto.js — concreto sujo, concreto liso, asfalto e calçada portuguesa.
 * Dono: MAT.
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, campoMusgo, campoSol, dBandaLarga,
  dGrao, dGraoFino, dCel, dCelF1, dCelId, dCelBorda, dRiscoV, dRiscoH, dFbm, dMancha, dRidged,
  dRacha, dEscorrimento,
  hex, sujar, SUJEIRA, MUSGO, CIMENTO,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

const _rgb = new Float32Array(3);

// ===========================================================================
// CONCRETO — parede/laje de concreto sujo, com escorrimento de chuva
// ===========================================================================

export async function gerarConcreto(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 2203;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 2);
  const fSol = campoSol(lab, N, semente + 5);
  const fMusgo = campoMusgo(lab, N, semente + 7, 0.13);
  // Descascamento do cobrimento (spalling): a laje solta lascas e expõe o agregado.
  const fLasca = assar(lab, N, (u, v) =>
    smoothstep(0.64, 0.80, dMancha(det, u, v, 1, 0.19, 0.73)));
  // Foco de ferrugem da armadura exposta (a mancha desce depois, por pixel)
  const fFerro = assar(lab, N, (u, v) =>
    smoothstep(0.76, 0.92, dMancha(det, u, v, 1, 0.61, 0.23)));

  // Marcas de fôrma de madeira: tábuas horizontais de ~20 cm (tile de 2 m ⇒ 10)
  const TABUAS = 10;

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x;
      const i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const sol = ler(fSol, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const lasca = ler(fLasca, N, u, v);
      const foco = ler(fFerro, N, u, v);
      const rachas = dRacha(det, u, v, L(1), 0.10, 0.17, 0.53);

      // Escorrimento em duas escalas: mancha larga + veio fino. É ESTE detalhe
      // que faz uma parede de concreto parecer concreto de verdade.
      const escorreLargo = dEscorrimento(det, u, v, L(1), 0.07, 0);
      const escorreFino = dEscorrimento(det, u, v, L(2), 0.43, 0);
      const escorre = clamp01(escorreLargo * 0.95 + escorreFino * 0.80);
      // Ferrugem: nasce no foco e desce em veio
      const ferrugem = clamp01(foco * 0.8 + smoothstep(0.62, 0.92, dRiscoV(det, u, v, L(6), 0.29, 0)) * foco * 2.0);

      // --- micro-superfície ---
      const bolhas = smoothstep(0.70, 0.93, dCel(det, u, v, L(4), 0.31, 0.11));
      const agregado = dCel(det, u, v, L(8), 0.83, 0.47);
      const poro = dGraoFino(det, u, v, L(3));
      const nata = dGrao(det, u, v, L(8));

      // Marcas de fôrma
      const ty = v * TABUAS;
      const fTab = ty - (ty | 0);
      const dTab = fTab < 1 - fTab ? fTab : 1 - fTab;
      const junta = (1 - smoothstep(0, 0.045, dTab)) * smoothstep(0.25, 0.6, macro);
      const veioTabua = dRiscoH(det, u, v, L(2), 0.5, 0.5) * junta * 0.4;

      // --- altura ---
      let hgt = 0.62 + nata * 0.10 + poro * 0.05;
      hgt -= bolhas * 0.10;
      hgt += junta * 0.06 + veioTabua * 0.05;
      hgt += (0.44 + agregado * 0.24 - hgt) * lasca;   // agregado em relevo onde lascou
      hgt -= rachas * 0.13;
      altura[i] = clamp01(hgt);

      // --- albedo ---
      // Concreto de verdade é MUITO mais escuro do que a intuição diz: cimento
      // curado e sujo fica em 0,32–0,45 de albedo, não em 0,6. Concreto claro
      // demais é o erro que faz a cena parecer maquete de papel.
      const tomBase = 0.36 + (macro - 0.5) * 0.20 + nata * 0.13 - bolhas * 0.09;
      let r = tomBase, g = tomBase * 0.995, b = tomBase * 0.96;

      if (lasca > 0.02) {
        // Agregado exposto: brita cinza-azulada e areia amarelada
        const pedra = dCelId(det, u, v, L(3), 0.83, 0.47);
        const lp = 0.8 + agregado * 0.5;
        const pr = (0.40 + 0.20 * pedra) * lp;
        r += (pr - r) * lasca;
        g += (pr * 0.98 - g) * lasca;
        b += (pr * 0.93 - b) * lasca;
      }

      // Sol clareia e amarela levemente o topo
      const claro = sol * 0.22;
      r += (r * 1.16 + 0.05 - r) * claro;
      g += (g * 1.14 + 0.05 - g) * claro;
      b += (b * 1.08 + 0.04 - b) * claro;

      // Ferrugem escorrida da armadura
      const fr = ferrugem * 0.85;
      r += (0.42 - r) * fr; g += (0.21 - g) * fr; b += (0.11 - b) * fr;

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(escorre * 0.62 + macro * 0.20));

      const m = musgo * 0.45;
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      const rk = rachas * 0.78;
      _rgb[0] += (0.11 - _rgb[0]) * rk;
      _rgb[1] += (0.105 - _rgb[1]) * rk;
      _rgb[2] += (0.10 - _rgb[2]) * rk;

      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // --- rugosidade ---
      let rug = 0.80 + (nata - 0.5) * 0.12 - bolhas * 0.04;
      rug += (0.93 - rug) * (lasca * 0.8);       // agregado bruto
      rug += (0.58 - rug) * (escorre * 0.50);    // trilha de água encardida e lisa
      rug += (0.97 - rug) * (musgo * 0.85);
      rug += (0.88 - rug) * (fr * 0.6);
      rugosidade[i] = clamp(rug, 0.40, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fSol, fMusgo, fLasca, fFerro]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.5,
    aoRaioLargo: 14, aoRaioFino: 3, aoForca: 1.1,
    props: {},
  };
}

// ===========================================================================
// CONCRETO LISO — laje desempenada/queimada, mais nova
// ===========================================================================

export async function gerarConcretoLiso(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 3307;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 3);
  // Marcas de desempenadeira: arcos largos deixados pela colher de pedreiro
  const fArcos = assar(lab, N, (u, v) => {
    const a = dFbm(det, u, v, 1, 0.13, 0.29);
    return clamp01(dFbm(det, u + a * 0.5, v, 2, 0.71, 0.03));
  });

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const arcos = ler(fArcos, N, u, v);
      const rachas = dRacha(det, u, v, L(1), 0.05, 0.61, 0.19);
      const escorre = dEscorrimento(det, u, v, L(1), 0.11, 0);

      const nata = dGrao(det, u, v, L(8));
      const poro = smoothstep(0.88, 0.99, dGraoFino(det, u, v, L(4)));

      altura[i] = clamp01(0.66 + (nata - 0.5) * 0.05 + (arcos - 0.5) * 0.035 - poro * 0.14 - rachas * 0.09);

      // Ver nota em gerarConcreto: cimento queimado fica em ~0,44, não em 0,55.
      const tom = 0.44 + (macro - 0.5) * 0.16 + (nata - 0.5) * 0.07 + (arcos - 0.5) * 0.05;
      _rgb[0] = tom; _rgb[1] = tom * 0.995; _rgb[2] = tom * 0.965;
      sujar(_rgb, clamp01(escorre * 0.32 + macro * 0.14 + (1 - v) * 0.08));
      const rk = rachas * 0.7;
      _rgb[0] += (0.13 - _rgb[0]) * rk;
      _rgb[1] += (0.125 - _rgb[1]) * rk;
      _rgb[2] += (0.12 - _rgb[2]) * rk;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      // Concreto queimado é bem mais liso — mas nunca uniforme.
      let rug = 0.58 + (nata - 0.5) * 0.16 + poro * 0.22 + (arcos - 0.5) * 0.10;
      rug += (0.44 - rug) * (escorre * 0.4);
      rugosidade[i] = clamp(rug, 0.30, 0.95);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fArcos]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 0.9,
    aoRaioLargo: 10, aoRaioFino: 2.5, aoForca: 0.85,
    props: {},
  };
}

// ===========================================================================
// ASFALTO — rua de favela: remendado, oleoso, gasto pelo pneu
// ===========================================================================

export async function gerarAsfalto(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 4409;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const s0 = (semente % 79) / 79;
  // Variação de banda larga — ver dBandaLarga em comum.js. A versão anterior
  // usava smoothstep estreito sobre dMancha aqui, e era isso que produzia os
  // "rabiscos ondulados" que faziam a rua ler como água corrente.
  const fMacro = assar(lab, N, (u, v) => dBandaLarga(det, u, v, s0));
  // Remendo de tapa-buraco: mancha larga e chapada, com borda própria.
  const fRemendo = assar(lab, N, (u, v) =>
    smoothstep(0.62, 0.74, dBandaLarga(det, u, v, s0 + 0.41)));
  /**
   * Umidade residual. **Deliberadamente fraca e sem forma de fita.**
   * O defeito antigo: `smoothstep(0.56, 0.78, dMancha(…))` recortava uma faixa
   * de nível do FBM com domain warp — ou seja, fitas sinuosas de largura
   * constante — e a rugosidade caía a 0,13 dentro delas. Fita espelhada sobre
   * albedo quase preto = reflexo do céu do entardecer em forma de onda: o
   * cérebro lê RIO, não rua. Agora a máscara é banda larga (mancha, não fita) e
   * a rugosidade mínima é 0,42, longe de espelho.
   */
  const fUmido = assar(lab, N, (u, v) =>
    smoothstep(0.66, 0.92, dBandaLarga(det, u, v, s0 + 0.77)));
  const fOleo = assar(lab, N, (u, v) =>
    smoothstep(0.80, 0.94, dBandaLarga(det, u, v, s0 + 0.13)));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const remendo = ler(fRemendo, N, u, v);
      const umido = ler(fUmido, N, u, v);
      const oleo = ler(fOleo, N, u, v);
      const rachas = dRacha(det, u, v, L(2), 0.085, 0.71, 0.41);

      // Agregado: britas de 1–2 cm coladas no betume, em duas granulometrias.
      const f1 = dCelF1(det, u, v, L(4), 0.17, 0.83);
      const brita = 1 - clamp01(f1 * 1.2);
      const idBrita = dCelId(det, u, v, L(4), 0.17, 0.83);
      const britaFina = dCel(det, u, v, L(13), 0.29, 0.53);
      const areia = dGraoFino(det, u, v, L(4));
      const grao = dGrao(det, u, v, L(18), 0.61, 0.23);

      // A brita só aparece onde o betume já foi embora (desgaste)
      const desgaste = clamp01(macro * 0.9 + (1 - remendo) * 0.4);
      const exposto = smoothstep(0.42, 0.90, brita) * desgaste;

      let hgt = 0.55 + britaFina * 0.13 + grao * 0.07 + areia * 0.05;
      hgt += exposto * 0.16;
      hgt -= rachas * 0.15;
      altura[i] = clamp01(hgt);

      /**
       * Cor: betume cinza-escuro LEVEMENTE QUENTE, não preto neutro.
       * O albedo antigo era (42,42,42) — neutro perfeito e escuro demais. Um
       * cinza neutro tão fundo quase não tem difusa própria, então em sombra ele
       * assume inteiro a cor do que o ilumina; com céu de entardecer, isso é
       * azul. Subir o valor e puxar a matiz para o quente dá ao material difusa
       * suficiente para continuar lendo "asfalto" mesmo iluminado só pelo céu.
       */
      const betume = 0.150 + macro * 0.105 + areia * 0.040 + grao * 0.025;
      let r = betume * 1.05, g = betume * 1.0, b = betume * 0.93;
      // Brita cinza-média: agregado claro demais lê como neve no asfalto, mas
      // agregado sem contraste nenhum lê como borracha. É o agregado que dá a
      // escala de centímetros da via.
      const cinzaBrita = (0.275 + 0.215 * idBrita) * (0.78 + britaFina * 0.44);
      const ex = exposto * 0.92;
      r += (cinzaBrita * 1.03 - r) * ex;
      g += (cinzaBrita - g) * ex;
      b += (cinzaBrita * 0.93 - b) * ex;
      // Remendo de tapa-buraco: betume novo, mais escuro e mais liso que a via.
      const rm = remendo * 0.75;
      r += (0.125 - r) * rm; g += (0.119 - g) * rm; b += (0.112 - b) * rm;
      // Poeira clara assentada — o que dá o tom empoeirado de rua de morro
      const poeira = clamp01((1 - umido) * macro * 0.45) * 0.42;
      r += (0.40 - r) * poeira; g += (0.375 - g) * poeira; b += (0.325 - b) * poeira;
      // Mancha de óleo: escura e levemente esverdeada
      const ol = oleo * 0.80;
      r += (0.085 - r) * ol; g += (0.090 - g) * ol; b += (0.082 - b) * ol;
      // Umidade escurece um pouco e satura — sem virar espelho
      const um = umido * 0.45;
      r += (r * 0.72 - r) * um; g += (g * 0.72 - g) * um; b += (b * 0.74 - b) * um;
      const rk = rachas * 0.80;
      r += (0.062 - r) * rk; g += (0.058 - g) * rk; b += (0.055 - b) * rk;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      /**
       * Rugosidade: asfalto é FOSCO. Piso 0,42 — bem longe de espelho.
       * O valor antigo (piso 0,08, poça a 0,13) transformava as fitas de umidade
       * em espelhos do céu. Um asfalto que reflete o céu inteiro não lê como
       * rua molhada: lê como lâmina d'água.
       */
      let rug = 0.90 - exposto * 0.07 + (areia - 0.5) * 0.09 + (grao - 0.5) * 0.05;
      rug += (0.80 - rug) * (remendo * 0.55);
      rug += (0.68 - rug) * (umido * 0.70);
      rug += (0.62 - rug) * (oleo * 0.65);
      rugosidade[i] = clamp(rug, 0.58, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fRemendo, fUmido, fOleo]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 1.5,
    aoRaioLargo: 10, aoRaioFino: 2.5, aoForca: 1.05,
    props: {},
  };
}

// ===========================================================================
// CALÇADA PORTUGUESA — pedra preta e branca, padrão de onda
// ===========================================================================

/**
 * Pedras de ~5 cm assentadas na areia, no padrão de onda de Copacabana.
 * As frequências da onda são inteiras em u e v, senão o tile não fecha.
 * Tile: 1,25 m × 1,25 m ⇒ 25 pedras por lado.
 *
 * O ponto crítico é a cor ser CONSTANTE dentro de cada pedra: se o padrão for
 * avaliado por pixel, a onda corta pedras ao meio e vira listra borrada. Por isso
 * a decisão preto/branco usa o id da célula de Voronoi como desempate.
 */
export async function gerarCalcadaPortuguesa(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 6607;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const fMacro = campoManchasMacro(lab, N, semente + 3, 3);
  const fMusgo = campoMusgo(lab, N, semente + 5, 0.30);

  // A grade celular do banco tem 20 células por lado; escala 1 ⇒ pedra de ~6 cm
  // num tile de 1,25 m. É a granulometria certa do paralelepípedo de calçada.
  const ESC_PEDRA = 1;

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;
  const TAU = Math.PI * 2;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    // A onda só depende de u e v — a parte em v sai do loop interno.
    const faseV = Math.sin(v * TAU) * 2.4;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      // Fronteira de Voronoi: as pedras preenchem o plano, separadas por uma
      // fresta fina de areia — exatamente como paralelepípedo assentado.
      const borda = dCelBorda(det, u, v, ESC_PEDRA, 0.11, 0.37);
      const idPedra = dCelId(det, u, v, ESC_PEDRA, 0.11, 0.37);
      const juntaLarg = 0.16 + (idPedra - 0.5) * 0.06;
      const pedra = smoothstep(juntaLarg * 0.35, juntaLarg, borda);

      const onda = Math.sin(u * TAU * 2 + faseV);
      const preta = (onda + (idPedra - 0.5) * 0.30) > 0;

      const macro = ler(fMacro, N, u, v);
      const musgo = ler(fMusgo, N, u, v);
      const poeira = dMancha(det, u, v, 1, 0.29, 0.61);

      // Cada pedra tem altura própria (calçada portuguesa é sempre torta)
      const hPedra = 0.62 + (idPedra - 0.5) * 0.10;
      const abaulado = smoothstep(0, 0.35, borda) * 0.05;
      const picote = dGrao(det, u, v, L(12)) * 0.08 + dCel(det, u, v, L(12), 0.7, 0.2) * 0.07;
      const areia = dGraoFino(det, u, v, L(3));
      const falta = idPedra > 0.965;

      let hgt = (0.34 + areia * 0.10) + (hPedra + abaulado + picote - (0.34 + areia * 0.10)) * pedra;
      if (falta) hgt = 0.30 + areia * 0.12;
      altura[i] = clamp01(hgt);

      let r, g, b, rug;
      if (falta) {
        r = 0.42 + areia * 0.16; g = 0.39 + areia * 0.16; b = 0.33 + areia * 0.14;
        rug = 0.95;
      } else if (pedra > 0.5) {
        if (preta) {
          // Basalto: preto-azulado, com cristais claros
          const cristal = smoothstep(0.82, 0.97, dGraoFino(det, u, v, L(4), 0.5, 0.5));
          const base = 0.115 + (idPedra - 0.5) * 0.045 + picote * 0.30;
          r = base + cristal * 0.20; g = base * 1.02 + cristal * 0.20; b = base * 1.14 + cristal * 0.20;
          rug = 0.52 + picote * 1.4;
        } else {
          // Calcário branco, amarelado pelo uso
          const veio = smoothstep(0.55, 0.85, dRidged(det, u, v, L(2), 0.29, 0.83));
          const base = 0.72 + (idPedra - 0.5) * 0.10 - picote * 0.35;
          r = base - veio * 0.10; g = base * 0.985 - veio * 0.10; b = base * 0.925 - veio * 0.09;
          rug = 0.48 + picote * 1.5;
        }
        // Pedra polida pelo pisoteio: o topo da pedra fica liso
        const polido = smoothstep(0.28, 0.5, borda) * (0.5 + macro * 0.6);
        rug += (0.30 - rug) * (polido * 0.55);
      } else {
        // Junta de areia/cimento
        r = 0.40 + areia * 0.20; g = 0.375 + areia * 0.19; b = 0.325 + areia * 0.17;
        rug = 0.96;
      }

      _rgb[0] = r; _rgb[1] = g; _rgb[2] = b;
      sujar(_rgb, clamp01(poeira * 0.30 + macro * 0.16));
      const m = musgo * (1 - pedra * 0.55) * 0.80;   // limo cresce na fresta
      _rgb[0] += (MUSGO[0] - _rgb[0]) * m;
      _rgb[1] += (MUSGO[1] - _rgb[1]) * m;
      _rgb[2] += (MUSGO[2] - _rgb[2]) * m;
      setRGB(albedo, i4, clamp01(_rgb[0]), clamp01(_rgb[1]), clamp01(_rgb[2]));

      rugosidade[i] = clamp(rug + (0.95 - rug) * m, 0.20, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fMusgo]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 2.4,
    aoRaioLargo: 9, aoRaioFino: 2.5, aoForca: 1.35,
    props: {},
  };
}
