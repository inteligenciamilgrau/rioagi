/**
 * generators/folhagem.js — ATLAS DE FOLHA com recorte por alfa. Dono: MAT/WORLD.
 *
 * ## Por que este arquivo existe
 * A vegetação usava a superfície `grama` — um ladrilho de gramado, opaco, sem
 * canal alfa. Colado num cartão de folha o resultado é um quadrilátero verde
 * chapado: o "paredão" que o jogador via ao nascer. Uma folha de verdade tem
 * silhueta recortada e vão por onde passa luz, e isso só existe com ALFA.
 *
 * O contrato proíbe asset externo, não proíbe alfa: aqui o recorte é gerado por
 * código, como todo o resto.
 *
 * ## Formato
 * Grade de 4x4 = 16 células. Cada célula é uma folha (ou um tufo de folíolos)
 * desenhada com margem transparente. Quem monta a geometria (`Vegetation.js`)
 * mapeia cada cartão de folha numa célula: u atravessa a largura, v corre da
 * base até a ponta. Ver `celulaUV()`.
 *
 * Células 0..8  — folha inteira (lanceolada, ondulada, rasgada, seca)
 * Células 9..15 — TUFO: 5 a 7 folíolos com vão entre eles. É o que transforma
 *                 um cartão só numa moita legível, sem inchar a malha.
 *
 * ## Custo
 * `alphaTest` (recorte binário) e não `transparent`: zero ordenação, zero
 * blending, escreve no depth normalmente. É a opção barata — `transparent:true`
 * em 5 mil instâncias custaria a ordenação por profundidade e ainda daria
 * artefato de ordem entre folhas do mesmo tufo.
 *
 * A margem transparente de cada célula é generosa de propósito: o mip acaba
 * misturando células vizinhas, e é melhor misturar com vazio do que com a folha
 * do lado.
 */

import {
  novoAlvo, setRGB,
  dGrao, dMancha, dFbm,
  hash1f, clamp01, clamp, smoothstep,
} from './comum.js';

/** Lado da grade do atlas. 4x4 = 16 variações de folha. */
export const ATLAS_LADO = 4;
/** Índice da primeira célula de TUFO (folíolos com vão). */
export const PRIMEIRO_TUFO = 9;

/**
 * Retângulo UV da célula `k`, já com a margem de segurança descontada.
 * @returns {[number,number,number,number]} [u0, v0, largura, altura]
 */
export function celulaUV(k) {
  const n = ATLAS_LADO;
  const i = ((k % n) + n) % n;
  const j = (Math.floor(k / n) % n + n) % n;
  const p = 1 / n;
  // 4% de recuo em cada borda: o cartão nunca amostra o texel da célula vizinha.
  const m = p * 0.04;
  return [i * p + m, j * p + m, p - 2 * m, p - 2 * m];
}

// ---------------------------------------------------------------------------
// Desenho de uma folha em coordenadas locais da célula
// ---------------------------------------------------------------------------

/**
 * Perfil de uma lâmina: distância máxima da nervura em função de b (0 base,
 * 1 ponta). `bico` controla quão afilada é a ponta.
 */
function meiaLargura(b, largura, bico) {
  if (b <= 0 || b >= 1) return 0;
  return largura * Math.sin(Math.PI * Math.pow(b, bico));
}

/**
 * Avalia uma lâmina no ponto (a, b) local. Devolve, num objeto reaproveitado,
 * cobertura (0..1), distância normalizada à nervura e posição ao longo dela.
 */
const _lam = { cob: 0, dn: 0, b: 0, borda: 0 };

function lamina(det, a, b, cfg, texel) {
  _lam.cob = 0;
  if (b < 0.001 || b > 0.999) return _lam;

  // Nervura não é reta: ondula um pouco, senão a folha vira uma faca.
  const eixo = cfg.eixo + Math.sin(b * cfg.curvaF + cfg.fase) * cfg.curvaA;
  const meia = meiaLargura(b, cfg.largura, cfg.bico);
  if (meia <= 0) return _lam;

  const d = Math.abs(a - eixo);
  const lado = a < eixo ? -1 : 1;

  // Margem serrilhada / ondulada: dentes ao longo do comprimento.
  const onda = Math.sin(b * cfg.dentesF + cfg.fase * 2.1 + (lado > 0 ? 0.9 : 0));
  let limite = meia * (1 - cfg.dentes * (0.5 + 0.5 * onda));

  // Rasgo entre nervuras secundárias — assinatura de folha de bananeira.
  // O corte é POR LADO e com fase diferente em cada um: se fosse simétrico o
  // resultado seria uma fenda atravessando a folha inteira, que lida em tela
  // vira listra horizontal (parece dano de textura, não folha rasgada).
  if (cfg.rasgo > 0) {
    // deslocamento de MEIO período entre os lados: assim um corte nunca cai na
    // mesma altura do corte oposto e a folha nunca fica com uma fenda de lado a
    // lado (que na tela vira listra horizontal, não folha rasgada)
    const fx = b * cfg.rasgoF + cfg.fase + (lado > 0 ? 0 : 0.5);
    const t = fx - Math.floor(fx);
    const corte = smoothstep(0.46, 0.50, t) * (1 - smoothstep(0.50, 0.55, t));
    limite -= meia * cfg.rasgo * corte;
  }

  // Ruído fino na borda: nada de contorno matematicamente liso.
  limite *= 0.94 + dGrao(det, a * 0.5 + cfg.fase, b * 0.5, 24) * 0.12;

  let cob = clamp01((limite - d) / Math.max(texel, 1e-5));

  // Furos de inseto e manchas mortas que viraram buraco.
  if (cfg.furos > 0) {
    for (let f = 0; f < cfg.furos; f++) {
      const hx = hash1f(cfg.semente * 31 + f * 7.3);
      const hy = hash1f(cfg.semente * 17 + f * 3.1 + 5);
      const hr = 0.018 + hash1f(cfg.semente * 11 + f) * 0.035;
      const cx = eixo + (hx - 0.5) * meia * 1.7;
      const cy = 0.18 + hy * 0.72;
      const dd = Math.hypot(a - cx, (b - cy) * 0.85);
      cob = Math.min(cob, clamp01((dd - hr) / Math.max(texel * 2, 1e-5)));
    }
  }

  _lam.cob = cob;
  _lam.dn = meia > 0 ? clamp01(d / meia) : 1;
  _lam.b = b;
  _lam.borda = clamp01((limite - d) / Math.max(meia * 0.22, 1e-5));
  return _lam;
}

/**
 * Encolhe o folíolo até ele caber inteiro na célula.
 *
 * Sem isto a folha que passa da borda sai CORTADA RETA — e uma aresta reta numa
 * folha é exatamente a leitura de "placa recortada em papelão" que este atlas
 * existe para matar. Melhor uma folha menor que uma folha guilhotinada.
 */
function couberNaCelula(c) {
  const meia = c.largura * 0.60;
  for (let i = 0; i < 10; i++) {
    const tx = 0.5 + c.peX + Math.sin(c.ang) * c.comp;
    const ty = c.peY + Math.cos(c.ang) * c.comp;
    if (tx - meia > 0.05 && tx + meia < 0.95 && ty + meia * 0.5 < 0.95) return c;
    c.comp *= 0.87;
  }
  return c;
}

/** Configuração de uma lâmina a partir da semente da célula. */
function cfgLamina(k, sub, semente) {
  const h = (n) => hash1f(k * 91.7 + sub * 13.3 + n * 7.1 + semente);
  return {
    eixo: 0.5,
    largura: 0.30 + h(1) * 0.14,
    bico: 0.52 + h(2) * 0.30,
    curvaF: 2.0 + h(3) * 4.0,
    curvaA: (h(4) - 0.5) * 0.10,
    fase: h(5) * 6.28,
    dentes: h(6) < 0.45 ? 0.05 + h(7) * 0.09 : 0.14 + h(7) * 0.16,
    dentesF: 8 + Math.floor(h(8) * 22),
    // <= 0,70 de propósito: um corte que chega perto de 1 come a meia-largura
    // inteira e a folha parece serrada ao meio
    rasgo: h(9) < 0.40 ? 0.36 + h(10) * 0.34 : 0,
    rasgoF: 3 + Math.floor(h(11) * 6),
    furos: h(12) < 0.5 ? 1 + Math.floor(h(13) * 3) : 0,
    semente: k * 100 + sub + semente,
  };
}

// ---------------------------------------------------------------------------
// GERADOR
// ---------------------------------------------------------------------------

export async function gerarFolha(lab, o) {
  const { w, h } = o;
  const semente = o.semente ?? 5309;
  const det = lab.det;
  const alvo = novoAlvo(lab, w, h);
  const { albedo, altura, rugosidade } = alvo;

  const n = ATLAS_LADO;
  const passo = 1 / n;
  const texel = 1.6 / (w * passo);        // ~1,6 texels de rampa na borda

  // Uma configuração por célula (folhas inteiras) ou por folíolo (tufos).
  const cfgs = [];
  for (let k = 0; k < n * n; k++) {
    if (k < PRIMEIRO_TUFO) {
      cfgs.push([cfgLamina(k, 0, semente)]);
    } else {
      /**
       * TUFO = RAMO COM FOLHAS, não leque.
       *
       * A primeira versão fazia todos os folíolos saírem do mesmo pé, abrindo em
       * leque simétrico. Renderizado, aquilo virava agave: espetos radiais,
       * todos do mesmo tamanho, todas as moitas do mapa iguais. Um arbusto de
       * morro é um ramo — folhas alternadas ao longo de uma haste, saindo para
       * os lados e encurtando na direção da ponta. É o que se monta aqui.
       */
      const nf = 5 + Math.floor(hash1f(k * 3.7 + semente) * 3);   // 5..7 folhas
      const lista = [];
      for (let f = 0; f < nf; f++) {
        const c = cfgLamina(k, f + 1, semente);
        const t = f / (nf - 1);                        // 0 no pé, 1 na ponta
        const h = (n) => hash1f(k * 13.1 + f * 5.7 + n * 2.9 + semente);
        // pé de cada folha subindo pela haste, com leve zigue-zague
        c.peY = 0.04 + t * 0.46 + (h(1) - 0.5) * 0.05;
        c.peX = (f % 2 ? 1 : -1) * (0.015 + h(2) * 0.03);
        // folhas alternadas: uma para cada lado, mais erguidas perto da ponta
        const lado = f % 2 ? 1 : -1;
        c.ang = lado * (1.16 - t * 0.62 + (h(3) - 0.5) * 0.26);
        c.comp = 0.52 - t * 0.16 + h(4) * 0.20;
        c.largura *= 0.40;
        c.bico = 0.60 + h(5) * 0.40;
        c.dentes = Math.min(0.20, c.dentes);
        c.rasgo = 0;
        c.furos = h(6) < 0.25 ? 1 : 0;
        lista.push(couberNaCelula(c));
      }
      // a folha terminal fecha a ponta do ramo, senão o topo fica cortado reto
      const topo = cfgLamina(k, 99, semente);
      topo.peY = 0.48; topo.peX = 0; topo.ang = (hash1f(k * 3.3) - 0.5) * 0.3;
      topo.comp = 0.40; topo.largura *= 0.40; topo.bico = 0.7;
      topo.dentes = Math.min(0.20, topo.dentes); topo.rasgo = 0; topo.furos = 0;
      lista.push(couberNaCelula(topo));
      cfgs.push(lista);
    }
  }

  /**
   * Paletas base -> meio -> ponta, em sRGB.
   *
   * O sol do jogo é de entardecer (alaranjado) e o tonemap é ACES: qualquer
   * amarelo no albedo vira limão na tela. Por isso o verde vivo aqui é
   * deliberadamente FRIO e escuro — é o que sobra como verde tropical depois da
   * luz quente passar por cima. A primeira versão usava (0.36, 0.47, 0.14) na
   * ponta e a folhagem saiu cor de alface murcha.
   */
  const VIVA = [[0.055, 0.115, 0.038], [0.105, 0.235, 0.070], [0.185, 0.330, 0.098]];
  const SECA = [[0.175, 0.145, 0.062], [0.325, 0.275, 0.108], [0.435, 0.385, 0.170]];

  lab.marcarInicioFatia();
  const invW = 1 / w, invH = 1 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * invH;
    const jc = Math.min(n - 1, Math.floor(v * n));
    const b0 = (v - jc * passo) / passo;                 // 0..1 dentro da célula

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * invW;
      const ic = Math.min(n - 1, Math.floor(u * n));
      const a0 = (u - ic * passo) / passo;
      const k = jc * n + ic;
      const i = y * w + x, i4 = i * 4;

      // Fora da faixa útil da célula: vazio puro (o mip só mistura com vazio).
      let cob = 0, dn = 1, bb = 0, borda = 0;

      if (a0 > 0.02 && a0 < 0.98 && b0 > 0.02 && b0 < 0.98) {
        const lista = cfgs[k];
        if (k < PRIMEIRO_TUFO) {
          const L = lamina(det, a0, b0, lista[0], texel);
          cob = L.cob; dn = L.dn; bb = L.b; borda = L.borda;
        } else {
          // Tufo: o pixel pertence ao folíolo que mais o cobre. Cada folíolo tem
          // seu próprio referencial girado em torno do pé do tufo.
          for (let f = 0; f < lista.length; f++) {
            const c = lista[f];
            const px = a0 - 0.5 - (c.peX ?? 0);
            const py = b0 - (c.peY ?? 0.06);
            const ca = Math.cos(c.ang), sa = Math.sin(c.ang);
            const lx = px * ca - py * sa;
            const ly = px * sa + py * ca;
            const bl = ly / c.comp;
            const L = lamina(det, lx + 0.5, bl, c, texel / c.comp);
            if (L.cob > cob) { cob = L.cob; dn = L.dn; bb = L.b; borda = L.borda; }
            if (cob >= 0.999) break;
          }
        }
      }

      // ---- alfa ----
      albedo[i4 + 3] = cob * 255;

      if (cob <= 0.002) {
        // Vazio: valores neutros para não contaminar normal/AO na borda.
        altura[i] = 0.5;
        rugosidade[i] = 0.9;
        setRGB(albedo, i4, 0.10, 0.14, 0.05);
        albedo[i4 + 3] = 0;
        continue;
      }

      // ---- relevo: nervura central + nervuras secundárias ----
      const nervura = Math.exp(-(dn * dn) * 90) * (0.85 - bb * 0.35);
      const secF = 14 + (k % 5) * 4;
      const sec = Math.abs(Math.sin((bb * secF - dn * 3.4) * Math.PI)) ;
      const veia = Math.pow(sec, 6) * (1 - dn * 0.35) * 0.5;
      const grao = dGrao(det, a0 * 2 + k, b0 * 2, 32);
      altura[i] = clamp01(0.44 + nervura * 0.34 + veia * 0.14 + grao * 0.06
        - (1 - borda) * 0.10);                        // margem levemente rebaixada

      // ---- cor ----
      const seca = clamp01(dMancha(det, a0 * 0.6 + k * 0.13, b0 * 0.6, 2) * 1.5 - 0.45);
      const doente = clamp01(dFbm(det, a0 + k * 0.7, b0, 3) * 1.4 - 0.55);
      // gradiente base -> ponta
      const t = bb;
      const pal = seca > 0.55 ? SECA : VIVA;
      const g0 = t < 0.5 ? pal[0] : pal[1], g1 = t < 0.5 ? pal[1] : pal[2];
      const tt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      let r = g0[0] + (g1[0] - g0[0]) * tt;
      let g = g0[1] + (g1[1] - g0[1]) * tt;
      let bl2 = g0[2] + (g1[2] - g0[2]) * tt;

      // Nervura é mais clara e levemente mais amarela que a lâmina.
      const nv = clamp01(nervura * 1.15);
      r += (0.300 - r) * nv * 0.70;
      g += (0.390 - g) * nv * 0.70;
      bl2 += (0.135 - bl2) * nv * 0.70;

      // A luz atravessa a folha: perto da margem ela clareia um pouco.
      const fino = Math.pow(dn, 2.4);
      r += (0.250 - r) * fino * 0.34;
      g += (0.400 - g) * fino * 0.34;
      bl2 += (0.115 - bl2) * fino * 0.34;

      // Mancha morta (fungo/queimado de sol) e ponta seca.
      const morta = clamp01(doente * 1.2 + Math.max(0, t - 0.88) * 2.0 * seca);
      r += (0.270 - r) * morta * 0.62;
      g += (0.200 - g) * morta * 0.62;
      bl2 += (0.085 - bl2) * morta * 0.62;

      // Sujeira de poeira de barro — é uma favela em encosta, não uma estufa.
      const po = clamp01(dMancha(det, a0 * 0.9 + k * 0.31, b0 * 0.9, 3) * 1.2 - 0.60) * 0.22;
      r += (0.330 - r) * po; g += (0.275 - g) * po; bl2 += (0.205 - bl2) * po;

      const lum = 0.93 + grao * 0.16;
      setRGB(albedo, i4, clamp01(r * lum), clamp01(g * lum), clamp01(bl2 * lum));
      albedo[i4 + 3] = cob * 255;                     // setRGB zera o alfa: repor

      // ---- rugosidade: cutícula da folha viva brilha, folha seca não ----
      let rug = 0.52 + (1 - clamp01(nervura * 1.4)) * 0.10;
      rug += (0.88 - rug) * clamp(seca, 0, 1);
      rug += (0.92 - rug) * morta * 0.8;
      rug += (0.86 - rug) * po;
      rugosidade[i] = clamp(rug, 0.35, 0.95);
    }
    if ((y & 15) === 0) await lab.talvezCeder();
  }

  return {
    ...alvo,
    normalForca: 1.15,
    aoRaioLargo: 6, aoRaioFino: 2, aoForca: 0.55,
    props: { doisLados: true },
  };
}
