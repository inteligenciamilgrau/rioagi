/**
 * generators/natural.js — terra batida, grama e água. Dono: MAT.
 */

import {
  novoAlvo, setRGB, assar, ler, N_MACRO, tetoEscala,
  campoManchasMacro, dBandaLarga,
  dGrao, dGraoFino, dCel, dCelF1, dCelId, dRiscoV, dRiscoH, dFbm, dMancha, dRidged,
  dRacha,
  hex, sujar, MUSGO,
  hash1f, hash2f, clamp01, clamp, mix, smoothstep, wrapi,
} from './comum.js';

const _rgb = new Float32Array(3);

// ===========================================================================
// TERRA — chão batido de beco, barro vermelho carioca
// ===========================================================================

/**
 * Terra batida de morro carioca: laterita vermelho-alaranjada, compactada pelo
 * pisoteio, com brita solta, caco de tijolo e raiz seca.
 *
 * ## O que foi corrigido aqui (não reintroduza)
 * A versão anterior derivava as três máscaras principais (`umido`, `trilha`,
 * `rachas`) de um `smoothstep` ESTREITO sobre `det.mancha`/`det.risco`. Faixa de
 * nível estreita sobre FBM com domain warp = **risco sinuoso de espessura
 * constante**, e era isso que o jogador via: "feltro com rabisco de minhoca".
 * Aqui toda variação de valor vem de `dBandaLarga` (soma de campos distintos em
 * seis escalas), e as máscaras que sobraram usam janela LARGA — mancha, não risco.
 *
 * A rugosidade também mudou de contrato: piso de terra **nunca** espelha. O piso
 * é 0,78 e o teto 1,0; sem isso o chão pega o azul do céu e vira poça.
 */
export async function gerarTerra(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 3119;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const s0 = (semente % 89) / 89;
  // Variação macro de banda larga: é o que dá "várias escalas de cor e valor"
  // sem nenhuma forma reconhecível. Assado a 128² porque é de baixa frequência.
  const fMacro = assar(lab, N, (u, v) => dBandaLarga(det, u, v, s0));
  // Zona compactada (caminho de pé). Janela LARGA de propósito: vira mancha
  // difusa de terra batida, não um risco de espessura constante.
  const fBatido = assar(lab, N, (u, v) =>
    clamp01(smoothstep(0.30, 0.86, dBandaLarga(det, u, v, s0 + 0.37)) * 1.15));
  // Poeira clara assentada: a escala GRANDE de valor. É o que impede o chão de
  // ser um marrom só — placas de pó âmbar sobre barro fundo.
  const fPoeira = assar(lab, N, (u, v) =>
    clamp01(smoothstep(0.34, 0.78, dBandaLarga(det, u, v, s0 + 0.61))));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const macro = ler(fMacro, N, u, v);
      const batido = ler(fBatido, N, u, v);
      const poeira = ler(fPoeira, N, u, v);

      // --- relevo: torrão, brita, grão fino, tudo em escalas separadas ---
      const torrao = dCel(det, u, v, L(3), 0.71, 0.29);
      const gravilha = dCel(det, u, v, L(9), 0.23, 0.61);
      const areia = dGraoFino(det, u, v, L(4));
      const grao = dGrao(det, u, v, L(16), 0.37, 0.91);

      // Pedra solta: célula inteira levantada, com borda definida.
      const f1 = dCelF1(det, u, v, L(6), 0.13, 0.53);
      const idPedra = dCelId(det, u, v, L(6), 0.13, 0.53);
      const pedra = idPedra > 0.70 ? (1 - smoothstep(0.06, 0.30, f1)) : 0;

      // Caco de tijolo/telha: célula de outra grade, recortada — nunca quadrado
      // alinhado ao eixo (a versão anterior usava hash de grade e dava quadradinho).
      const idCaco = dCelId(det, u, v, L(11), 0.61, 0.17);
      const f1Caco = dCelF1(det, u, v, L(11), 0.61, 0.17);
      const caco = (idCaco > 0.955)
        ? (1 - smoothstep(0.05, 0.22, f1Caco)) * smoothstep(0.35, 0.55, grao)
        : 0;

      // Raiz/graveto seco: risco fino em diagonal, esparso e quebrado.
      const raiz = smoothstep(0.80, 0.95, dRiscoH(det, u * 0.72 - v * 0.69, v, L(2), 0.29, 0.83))
        * smoothstep(0.45, 0.70, dFbm(det, u, v, L(3), 0.11, 0.47));

      // Rachadura de barro seco: mantida, mas fina e só onde a terra está batida.
      const rachas = dRacha(det, u, v, L(2), 0.075, 0.19, 0.61) * (0.35 + batido * 0.5);

      let hgt = 0.50 + torrao * 0.17 + gravilha * 0.12 + grao * 0.07 + areia * 0.04;
      hgt += pedra * 0.13 + caco * 0.10;
      hgt += raiz * 0.06;
      hgt -= rachas * 0.11;
      hgt += (hgt * 0.88 + 0.07 - hgt) * (batido * 0.55);   // pisoteado = achatado
      altura[i] = clamp01(hgt);

      // --- cor: laterita quente, variando em várias escalas ---
      // A crominância varia junto com o valor (terra clara é mais amarela, terra
      // funda é mais vermelha). Variar só o brilho é o que dá aspecto de feltro.
      const mv = (macro - 0.5);                    // -0.5..0.5, banda larga
      const claro = clamp01(0.5 + mv * 1.05 + (poeira - 0.5) * 0.75
        + (torrao - 0.5) * 0.60 + (grao - 0.5) * 0.34);

      // âmbar seco  <-  ->  barro fundo avermelhado.
      // Faixa ampla de propósito: 0.22..0.72 de luminância. Terra real tem duas
      // paradas de diafragma entre o pó do sol e o barro da sombra.
      let r = 0.225 + claro * 0.495;
      let g = 0.128 + claro * 0.385;
      let b = 0.078 + claro * 0.250;
      // Empurra a matiz: quanto mais claro, mais amarelo/âmbar (poeira de sol).
      const amb = claro * claro * 0.6;
      g += amb * 0.060; b += amb * 0.028;
      // Quanto mais escuro, mais vermelho saturado (barro úmido de sombra).
      const fundo = (1 - claro) * (1 - claro) * 0.7;
      r += fundo * 0.055; g -= fundo * 0.024; b -= fundo * 0.020;

      // Terra batida acinzenta e escurece um pouco (compactação + poeira presa)
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      const tb = batido * 0.34;
      r += (luma * 1.02 - r) * tb; g += (luma * 0.98 - g) * tb; b += (luma * 0.92 - b) * tb;

      // Seixo/brita: cinza-quente CLARO. Precisa destacar do barro, senão o
      // chão perde a escala de leitura de perto — pedra é o que diz ao olho
      // "isto tem 3 cm" e ancora o tamanho de tudo o mais.
      const cp = 0.335 + 0.235 * idPedra + gravilha * 0.115;
      const pd = pedra * 0.92;
      r += (cp * 1.05 - r) * pd; g += (cp - g) * pd; b += (cp * 0.88 - b) * pd;

      // Caco de tijolo: vermelho de cerâmica, não marrom de terra
      const ck = caco * 0.90;
      r += (0.505 - r) * ck; g += (0.205 - g) * ck; b += (0.130 - b) * ck;

      // Raiz seca: marrom escuro acinzentado
      const rz = raiz * 0.75;
      r += (0.175 - r) * rz; g += (0.140 - g) * rz; b += (0.105 - b) * rz;

      // Rachadura: sombra da fenda, não risco preto chapado
      const rk = rachas * 0.70;
      r += (0.088 - r) * rk; g += (0.058 - g) * rk; b += (0.042 - b) * rk;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      // --- rugosidade: terra é sempre fosca. Piso 0,78: sem isso o chão
      // reflete o céu do entardecer e o jogador lê poça d'água.
      let rug = 0.95 + (areia - 0.5) * 0.06 + (grao - 0.5) * 0.05;
      rug += (0.86 - rug) * (batido * 0.55);      // compactado fica levemente liso
      rug += (0.80 - rug) * (pedra * 0.6);        // seixo é mais liso que barro
      rug += (0.88 - rug) * (caco * 0.7);
      rugosidade[i] = clamp(rug, 0.78, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fMacro, fBatido, fPoeira]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 2.3,
    aoRaioLargo: 14, aoRaioFino: 3, aoForca: 1.25,
    props: {},
  };
}

// ===========================================================================
// GRAMA — capim ralo de terreno baldio, com terra aparecendo
// ===========================================================================

/**
 * Capim ralo de morro — a SEGUNDA camada do chão de terreno, não um gramado.
 *
 * `World._terrenoMesh` mistura esta superfície com `terra` no shader; por isso as
 * duas partem do MESMO substrato de barro. Se o substrato daqui não casar com o
 * de `gerarTerra`, a transição aparece como emenda de cor. Mexeu numa, confira a outra.
 *
 * Leitura pretendida: mato rasteiro seco de encosta — muito mais palha e terra
 * do que verde, verde puxado para oliva/caqui (capim tropical no fim da seca),
 * nunca o verde-esmeralda de jardim que fazia a versão anterior parecer feltro.
 */
export async function gerarGrama(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 3719;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  const s0 = (semente % 83) / 83;
  // Densidade do capim em banda larga: manchas de mato disputando com falhas de
  // terra pelada, em várias escalas ao mesmo tempo.
  const fDens = assar(lab, N, (u, v) =>
    clamp01(smoothstep(0.26, 0.80, dBandaLarga(det, u, v, s0)) * 1.2));
  // Queimado de sol — janela larga, senão vira faixa.
  const fSeco = assar(lab, N, (u, v) =>
    clamp01(smoothstep(0.28, 0.84, dBandaLarga(det, u, v, s0 + 0.53))));
  const fMacro = assar(lab, N, (u, v) => dBandaLarga(det, u, v, s0 + 0.21));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const dens = ler(fDens, N, u, v);
      const seco = ler(fSeco, N, u, v);
      const macro = ler(fMacro, N, u, v);

      // Lâminas de capim: o mesmo ruído esticado em três direções; o máximo
      // entre elas produz o emaranhado cruzado. Duas escalas para o tufo ter
      // folha grossa e folha fina.
      const lam1 = dRiscoV(det, u, v, L(5));
      const lam2 = dRiscoV(det, v * 0.9 + u * 0.4, u, L(5), 0.31, 0.17);
      const lam3 = dRiscoH(det, u * 0.7 - v * 0.6, v, L(4), 0.71, 0.53);
      let lamina = lam1 > lam2 ? lam1 : lam2;
      if (lam3 > lamina) lamina = lam3;
      const fina = dRiscoV(det, u * 1.3 + v * 0.2, v, L(11), 0.47, 0.29);
      lamina = clamp01(lamina * 0.78 + fina * 0.30);

      // --- substrato de barro: o MESMO de gerarTerra ---
      const torrao = dCel(det, u, v, L(3), 0.71, 0.29);
      const gravilha = dCel(det, u, v, L(9), 0.23, 0.61);
      const grao = dGrao(det, u, v, L(16), 0.37, 0.91);
      const areia = dGraoFino(det, u, v, L(4));
      const claroT = clamp01(0.5 + (macro - 0.5) * 1.7 + (torrao - 0.5) * 0.55 + (grao - 0.5) * 0.30);
      let tr = 0.30 + claroT * 0.34, tg = 0.185 + claroT * 0.265, tb = 0.115 + claroT * 0.175;
      const ambT = claroT * claroT * 0.5;
      tg += ambT * 0.055; tb += ambT * 0.030;

      // Cobertura de capim sobre o barro
      const cobertura = clamp01(dens * 1.15 + (lamina - 0.5) * 0.55);
      const mato = smoothstep(0.20, 0.62, cobertura);

      let hgt = 0.48 + torrao * 0.15 + gravilha * 0.10 + grao * 0.06 + areia * 0.03;
      hgt += mato * 0.26 + (lamina - 0.5) * 0.18 * mato;
      altura[i] = clamp01(hgt);

      // --- cor do capim: oliva/caqui seco, NUNCA verde de jardim ---
      // tv separa folha iluminada (ponta) de base do tufo.
      const tv = clamp01((lamina - 0.34) * 1.8 + (macro - 0.5) * 0.7);
      // verde-oliva escuro  ->  verde-caqui claro
      let r = 0.155 + (0.355 - 0.155) * tv;
      let g = 0.195 + (0.395 - 0.195) * tv;
      let b = 0.082 + (0.150 - 0.082) * tv;
      // Palha seca. Peso contido de propósito: capim de morro é oliva puxando
      // para o caqui, não feno claro. Com `pal` alto o chão vira palheiro
      // uniforme e perde a disputa com a terra, que é a leitura pretendida.
      const pal = clamp01(seco * 0.90 + (1 - dens) * 0.40) * 0.60;
      r += (0.455 - r) * pal; g += (0.365 - g) * pal; b += (0.172 - b) * pal;
      // Micro variação por lâmina (nenhuma folha tem o valor da vizinha)
      const ld = 0.90 + dGrao(det, u, v, L(20), 0.13, 0.77) * 0.24;
      r *= ld; g *= ld; b *= ld;

      // Auto-sombra: a base do tufo é bem mais escura que a ponta
      const sombra = (1 - clamp01(lamina * 1.25)) * mato * 0.52;
      r *= 1 - sombra; g *= 1 - sombra; b *= 1 - sombra;

      // Compõe sobre o barro
      const inv = 1 - mato;
      r += (tr - r) * inv; g += (tg - g) * inv; b += (tb - b) * inv;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      // Folha tem cutícula (um pouco menos fosca); barro é áspero. Piso 0,62 —
      // capim não espelha, mas reflete mais que terra.
      let rug = 0.95 + (areia - 0.5) * 0.06;
      rug += (0.70 - rug) * clamp01(lamina * mato);
      rug += (0.90 - rug) * (pal * 0.7);
      rugosidade[i] = clamp(rug, 0.62, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fDens, fSeco, fMacro]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 2.0,
    aoRaioLargo: 12, aoRaioFino: 2.5, aoForca: 1.35,
    props: {},
  };
}

// ===========================================================================
// ÁGUA — poça/valão parado. Escura, oleosa, com detrito na superfície.
// ===========================================================================

export async function gerarAgua(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 4127;
  const det = lab.det;
  const T = tetoEscala(w, det);
  const L = (k) => (k > T ? T : k);   // escala absoluta, limitada pela resolução
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const N = N_MACRO;
  // Película de óleo/sujeira que flutua e irisa em partes
  const fPelicula = assar(lab, N, (u, v) =>
    smoothstep(0.48, 0.78, dMancha(det, u, v, 2, 0.03, 0.31)));
  const fEspuma = assar(lab, N, (u, v) =>
    smoothstep(0.70, 0.88, dMancha(det, u, v, 3, 0.53, 0.07)));

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const i = y * w + x, i4 = i * 4;

      const pelicula = ler(fPelicula, N, u, v);
      const espuma = ler(fEspuma, N, u, v);

      // Ondulação: duas escalas cruzadas de cristas suaves + capilar fina.
      const o1 = dRidged(det, u, v, L(1), 0.11, 0.03);
      const o2 = dRidged(det, u + 0.37, v - 0.21, L(2), 0.61, 0.29);
      const capilar = dGrao(det, u, v, L(12));
      const onda = o1 * 0.6 + o2 * 0.3 + capilar * 0.1;

      altura[i] = clamp01(0.5 + (onda - 0.5) * 0.55);

      // Água parada de favela: verde-escura, quase opaca de tão suja
      let r = 0.055 + pelicula * 0.045;
      let g = 0.075 + pelicula * 0.030;
      let b = 0.068 + pelicula * 0.020;
      // Iridescência do óleo: desloca a matiz conforme a ondulação
      const iris = pelicula * smoothstep(0.4, 0.7, onda);
      r += iris * 0.16 * (0.5 + 0.5 * Math.sin(onda * 22));
      g += iris * 0.13 * (0.5 + 0.5 * Math.sin(onda * 22 + 2.1));
      b += iris * 0.17 * (0.5 + 0.5 * Math.sin(onda * 22 + 4.2));
      const es = espuma * 0.75;
      r += (0.55 - r) * es; g += (0.55 - g) * es; b += (0.52 - b) * es;

      setRGB(albedo, i4, clamp01(r), clamp01(g), clamp01(b));

      // Água limpa é ~0,03 de rugosidade; a película e a espuma quebram o espelho.
      let rug = 0.045 + (capilar - 0.5) * 0.03;
      rug += (0.22 - rug) * (pelicula * 0.6);
      rug += (0.85 - rug) * (espuma * 0.9);
      rugosidade[i] = clamp(rug, 0.02, 1);
    }
    if ((y & 31) === 0) await lab.talvezCeder();
  }

  for (const c of [fPelicula, fEspuma]) lab.liberarCampo(c);

  return {
    ...alvo,
    normalForca: 0.55,
    aoRaioLargo: 8, aoRaioFino: 2, aoForca: 0.30,
    props: {},
  };
}
