/**
 * Impacts — receitas de efeito por superficie e a tabela que liga
 * `weapon:hit` -> particulas + decal + som + luz.
 *
 * Uma "receita" e um objeto lido por PoolParticulas.emite(). Campos numericos
 * aceitam escalar ou faixa [min,max] (ver val() em Particles.js).
 *
 * Regra de ouro das receitas: TRES camadas por impacto.
 *   1. flash/nucleo curto e brilhante (2-4 particulas, vida < 0.12s)
 *   2. detrito direcional rapido (faisca ou lasca, ~0.4-0.9s)
 *   3. poeira/fumaca lenta que sobe e dissipa (~1.2-2.5s)
 * Impacto de uma camada so e o erro classico que faz o tiro parecer sem peso.
 */
import { PT } from './Particles.js';
import { DECAL } from './Decals.js';

/* ------------------------------------------------------------------------ */
/* Receitas de particula                                                     */
/* ------------------------------------------------------------------------ */

/** Poeira fina de concreto: nuvem clara que sobe e fica pendurada. */
const POEIRA_CONCRETO = {
  atlas: [PT.POEIRA, PT.FUMACA, PT.FUMACA2],
  count: [7, 11], speed: [0.6, 2.4], spread: 0.85, upBias: 0.35, jitter: 0.05,
  life: [0.9, 1.9], drag: 2.6, grav: -0.55,
  tam0: [0.09, 0.16], tam1: [0.55, 0.95],
  cor: 0xbdb3a4, cor2: 0x8d8377, alpha: [0.30, 0.5],
  rot: [-3.14, 3.14], rotVel: [-1.1, 1.1],
  fadeIn: 0.06, fadeOut: 1.5, turb: 0.35, brilho: 1.0,
};

const LASCAS_CONCRETO = {
  atlas: PT.FRAGMENTO,
  count: [5, 9], speed: [3.5, 8.5], spread: 0.55, upBias: 0.15, jitter: 0.02,
  life: [0.45, 0.85], drag: 1.1, grav: -9.2,
  tam0: [0.022, 0.05], tam1: [0.018, 0.04],
  cor: 0xa89e90, cor2: 0x6f6759, alpha: 1,
  rotVel: [-9, 9], fadeIn: 0.01, fadeOut: 2.4,
};

/** Nucleo quente do impacto — o "clarao" de 2 frames. */
const NUCLEO = {
  atlas: PT.GLOW,
  count: [1, 2], speed: [0.2, 0.7], spread: 0.6, jitter: 0.01,
  life: [0.06, 0.11], drag: 4, grav: 0,
  tam0: [0.16, 0.30], tam1: [0.05, 0.10],
  cor: 0xffd9a0, alpha: 1, brilho: 3.2,
  fadeIn: 0.0, fadeOut: 1.0,
};

const POEIRA_TIJOLO = {
  ...POEIRA_CONCRETO,
  count: [8, 13],
  cor: 0xb5714a, cor2: 0x7d4630, alpha: [0.34, 0.55],
};

const LASCAS_TIJOLO = {
  ...LASCAS_CONCRETO,
  count: [6, 11], speed: [3.0, 7.5],
  cor: 0xa85f3c, cor2: 0x6b3a25,
  tam0: [0.025, 0.055], tam1: [0.02, 0.045],
};

/** Faiscas de metal: risco esticado pela velocidade, quica no chao. */
const FAISCAS_METAL = {
  atlas: [PT.FAISCA, PT.RISCO],
  count: [14, 24], speed: [5.5, 16], spread: 0.7, upBias: 0.12, jitter: 0.015,
  life: [0.28, 0.7], drag: 0.9, grav: -11,
  tam0: [0.035, 0.075], tam1: [0.008, 0.02],
  cor: 0xfff0c0, cor2: 0xff8420, alpha: 1, brilho: 4.5,
  stretch: 0.11, fadeIn: 0.0, fadeOut: 2.2,
};

const FUMACA_METAL = {
  atlas: [PT.FUMACA, PT.WISP],
  count: [2, 4], speed: [0.4, 1.3], spread: 0.8, upBias: 0.5,
  life: [0.5, 1.0], drag: 3.2, grav: -0.3,
  tam0: [0.06, 0.11], tam1: [0.3, 0.5],
  cor: 0x4a4643, cor2: 0x2a2724, alpha: [0.22, 0.38],
  rotVel: [-1.4, 1.4], fadeIn: 0.05, fadeOut: 1.4, turb: 0.4,
};

const LASCAS_MADEIRA = {
  atlas: PT.FRAGMENTO,
  count: [8, 14], speed: [2.8, 7.0], spread: 0.6, upBias: 0.1,
  life: [0.6, 1.15], drag: 1.6, grav: -8.6,
  tam0: [0.03, 0.075], tam1: [0.025, 0.06],
  cor: 0xa87a45, cor2: 0x5e4224, alpha: 1,
  rotVel: [-12, 12], fadeIn: 0.01, fadeOut: 2.0,
};

const POEIRA_MADEIRA = {
  ...POEIRA_CONCRETO,
  count: [4, 7], cor: 0xa07f52, cor2: 0x6d5535, alpha: [0.22, 0.36],
  tam1: [0.35, 0.6],
};

const CACOS_VIDRO = {
  atlas: PT.VIDRO,
  count: [12, 20], speed: [2.5, 7.5], spread: 0.75, upBias: 0.08,
  life: [0.7, 1.4], drag: 1.2, grav: -9.5,
  tam0: [0.03, 0.08], tam1: [0.025, 0.07],
  cor: 0xd8ecf2, cor2: 0x8fb6c4, alpha: 0.85, brilho: 1.5,
  rotVel: [-14, 14], fadeIn: 0.0, fadeOut: 1.8,
};

const TERRA_LEVANTADA = {
  atlas: [PT.POEIRA, PT.FUMACA2],
  count: [9, 15], speed: [1.2, 3.8], spread: 0.7, upBias: 0.55, jitter: 0.06,
  life: [0.8, 1.6], drag: 2.2, grav: -1.8,
  tam0: [0.10, 0.20], tam1: [0.45, 0.85],
  cor: 0x8a6141, cor2: 0x54392a, alpha: [0.4, 0.62],
  rotVel: [-1.3, 1.3], fadeIn: 0.05, fadeOut: 1.4, turb: 0.3,
};

const TORROES_TERRA = {
  atlas: PT.FRAGMENTO,
  count: [5, 9], speed: [2.5, 6.5], spread: 0.55, upBias: 0.35,
  life: [0.5, 0.95], drag: 1.5, grav: -9.5,
  tam0: [0.03, 0.07], tam1: [0.025, 0.06],
  cor: 0x6d4c33, cor2: 0x3f2c1e, alpha: 1,
  rotVel: [-8, 8], fadeOut: 2.2,
};

const RESPINGO_AGUA = {
  atlas: PT.GOTA,
  count: [16, 26], speed: [2.0, 6.0], spread: 0.5, upBias: 0.85,
  life: [0.5, 1.0], drag: 1.0, grav: -9.81,
  tam0: [0.02, 0.055], tam1: [0.015, 0.04],
  cor: 0xcfe4ea, alpha: 0.75, brilho: 1.4,
  fadeIn: 0.0, fadeOut: 1.6,
};

const NEVOA_AGUA = {
  atlas: PT.NEVOA,
  count: [3, 5], speed: [0.5, 1.5], spread: 0.9, upBias: 0.6,
  life: [0.5, 1.1], drag: 3, grav: -0.4,
  tam0: [0.1, 0.2], tam1: [0.4, 0.7],
  cor: 0xdfeef2, alpha: [0.18, 0.32], fadeOut: 1.5, turb: 0.4,
};

const FOLHAS = {
  atlas: PT.FOLHA,
  count: [6, 11], speed: [1.0, 3.5], spread: 0.9, upBias: 0.2,
  life: [1.0, 2.2], drag: 2.8, grav: -2.2,
  tam0: [0.04, 0.09], tam1: [0.04, 0.09],
  cor: 0x4f7a32, cor2: 0x2d4a1c, alpha: 1,
  rotVel: [-5, 5], fadeOut: 1.3, turb: 0.8,
};

/* --- carne: spray direcional + nevoa + gotas --- */
const SANGUE_SPRAY = {
  atlas: PT.SANGUE,
  count: [10, 18], speed: [2.5, 7.5], spread: 0.45, upBias: 0.1,
  life: [0.4, 0.9], drag: 1.4, grav: -9.0,
  tam0: [0.025, 0.06], tam1: [0.02, 0.05],
  cor: 0x8e0f12, cor2: 0x4a0508, alpha: 1,
  stretch: 0.05, fadeIn: 0.0, fadeOut: 2.0,
};

const SANGUE_NEVOA = {
  atlas: PT.NEVOA,
  count: [3, 6], speed: [0.8, 2.4], spread: 0.75, upBias: 0.15,
  life: [0.35, 0.7], drag: 3.5, grav: -1.0,
  tam0: [0.09, 0.18], tam1: [0.3, 0.55],
  cor: 0x6e0d10, cor2: 0x3a0406, alpha: [0.35, 0.55],
  fadeIn: 0.02, fadeOut: 1.6, turb: 0.3,
};

/* ------------------------------------------------------------------------ */
/* Tabela de superficie                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Para cada superficie do contrato: camadas de particula, decal, tamanho do
 * decal, cor e intensidade do flash de impacto.
 * `flash` = luz pontual curta no ponto de impacto (so em superficies faiscantes).
 */
export const SUPERFICIES = {
  concreto: {
    camadas: [
      { pool: 'brilho', receita: NUCLEO },
      { pool: 'destrocos', receita: LASCAS_CONCRETO },
      { pool: 'fumaca', receita: POEIRA_CONCRETO },
    ],
    decal: DECAL.CONCRETO, decalTam: [0.11, 0.19], decalRot: true,
    flash: null, som: 'concreto',
  },
  asfalto: {
    camadas: [
      { pool: 'brilho', receita: NUCLEO },
      { pool: 'destrocos', receita: { ...LASCAS_CONCRETO, cor: 0x4a4744, cor2: 0x2b2927 } },
      { pool: 'fumaca', receita: { ...POEIRA_CONCRETO, cor: 0x7d7a75, cor2: 0x4f4d4a } },
    ],
    decal: DECAL.CONCRETO, decalTam: [0.10, 0.17], decalRot: true,
    flash: null, som: 'concreto',
  },
  tijolo: {
    camadas: [
      { pool: 'brilho', receita: NUCLEO },
      { pool: 'destrocos', receita: LASCAS_TIJOLO },
      { pool: 'fumaca', receita: POEIRA_TIJOLO },
    ],
    decal: DECAL.TIJOLO, decalTam: [0.12, 0.21], decalRot: true,
    flash: null, som: 'tijolo',
  },
  metal: {
    camadas: [
      { pool: 'brilho', receita: NUCLEO },
      { pool: 'brilho', receita: FAISCAS_METAL },
      { pool: 'fumaca', receita: FUMACA_METAL },
    ],
    decal: DECAL.METAL, decalTam: [0.07, 0.12], decalRot: true,
    flash: { cor: 0xffc070, intensidade: 5.5, distancia: 4.5, ms: 55 },
    som: 'metal',
  },
  madeira: {
    camadas: [
      { pool: 'brilho', receita: { ...NUCLEO, count: 1, brilho: 2.0 } },
      { pool: 'destrocos', receita: LASCAS_MADEIRA },
      { pool: 'fumaca', receita: POEIRA_MADEIRA },
    ],
    decal: DECAL.MADEIRA, decalTam: [0.09, 0.15], decalRot: true,
    flash: null, som: 'madeira',
  },
  vidro: {
    camadas: [
      { pool: 'brilho', receita: { ...NUCLEO, brilho: 2.2 } },
      { pool: 'destrocos', receita: CACOS_VIDRO },
    ],
    decal: DECAL.VIDRO, decalTam: [0.18, 0.30], decalRot: true,
    flash: { cor: 0xcfe8f2, intensidade: 2.0, distancia: 3, ms: 40 },
    som: 'vidro',
  },
  terra: {
    camadas: [
      { pool: 'destrocos', receita: TORROES_TERRA },
      { pool: 'fumaca', receita: TERRA_LEVANTADA },
    ],
    decal: DECAL.TERRA, decalTam: [0.14, 0.24], decalRot: true,
    flash: null, som: 'terra',
  },
  agua: {
    camadas: [
      { pool: 'brilho', receita: RESPINGO_AGUA },
      { pool: 'fumaca', receita: NEVOA_AGUA },
    ],
    decal: null, flash: null, som: 'agua',
  },
  folhagem: {
    camadas: [{ pool: 'destrocos', receita: FOLHAS }],
    decal: null, flash: null, som: 'folhagem',
  },
  carne: {
    camadas: [
      { pool: 'fumaca', receita: SANGUE_NEVOA },
      { pool: 'brilho', receita: { ...SANGUE_SPRAY, brilho: 0.85 } },
    ],
    decal: DECAL.SANGUE, decalTam: [0.22, 0.40], decalRot: true,
    decalNoChao: true,   // sangue vai na geometria atras do alvo, nao no corpo
    flash: null, som: 'carne',
  },
};

/** Superficie padrao quando a colisao nao informa. */
export const SUPERFICIE_PADRAO = 'concreto';

export function receitaDe(superficie) {
  return SUPERFICIES[superficie] || SUPERFICIES[SUPERFICIE_PADRAO];
}

/* ------------------------------------------------------------------------ */
/* Efeitos de boca de cano                                                   */
/* ------------------------------------------------------------------------ */

/** Fumaca que sai do cano e sobe — acumula com a cadencia. */
export const FUMACA_CANO = {
  atlas: [PT.WISP, PT.FUMACA],
  count: [1, 2], speed: [0.35, 1.1], spread: 0.35, upBias: 0.45, offset: [0.02, 0.12],
  life: [0.8, 1.7], drag: 2.4, grav: -0.35,
  tam0: [0.035, 0.07], tam1: [0.28, 0.5],
  cor: 0x8f8b85, cor2: 0x565350, alpha: [0.13, 0.24],
  rotVel: [-0.9, 0.9], fadeIn: 0.1, fadeOut: 1.6, turb: 0.5,
};

/** Poeira de queima expelida junto do projetil. */
export const SOPRO_CANO = {
  atlas: [PT.FUMACA2, PT.POEIRA],
  count: [3, 5], speed: [2.5, 6.5], spread: 0.22, upBias: 0.05, offset: [0.05, 0.2],
  life: [0.18, 0.4], drag: 6.5, grav: 0,
  tam0: [0.05, 0.10], tam1: [0.22, 0.42],
  cor: 0xb0a89c, cor2: 0x6b655d, alpha: [0.18, 0.32],
  rotVel: [-3, 3], fadeIn: 0.02, fadeOut: 1.8,
};

/** Faiscas de polvora nao queimada saindo do cano. */
export const FAISCAS_CANO = {
  atlas: [PT.FAISCA, PT.RISCO],
  count: [3, 7], speed: [3.5, 11], spread: 0.28, upBias: 0.04, offset: [0.03, 0.15],
  life: [0.12, 0.32], drag: 3.5, grav: -6,
  tam0: [0.02, 0.045], tam1: [0.005, 0.014],
  cor: 0xfff3cc, cor2: 0xffa030, alpha: 1, brilho: 4.0,
  stretch: 0.09, fadeOut: 2.4,
};

/**
 * Parametros do clarao. `escala` multiplica tamanho e luz por arma —
 * fuzil estoura mais que pistola.
 */
export const CLARAO = {
  fuzil:    { escala: 1.00, cor: 0xffd48a, luz: 7.5, dist: 9.0, ms: 42 },
  smg:      { escala: 0.85, cor: 0xffcf82, luz: 6.0, dist: 7.5, ms: 38 },
  pistola:  { escala: 0.72, cor: 0xffc978, luz: 5.0, dist: 6.0, ms: 34 },
  inimigo:  { escala: 0.90, cor: 0xffcc80, luz: 5.5, dist: 8.0, ms: 40 },
};

export function claraoDe(armaId) {
  if (!armaId) return CLARAO.fuzil;
  const s = String(armaId).toLowerCase();
  if (s.includes('pt92') || s.includes('pistol')) return CLARAO.pistola;
  if (s.includes('smt') || s.includes('smg')) return CLARAO.smg;
  if (s.includes('inimig') || s.includes('enemy')) return CLARAO.inimigo;
  return CLARAO.fuzil;
}
