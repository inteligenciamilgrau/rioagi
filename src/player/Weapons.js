/**
 * Weapons — catálogo de armas com stats reais e distintos.
 * Dono: PLAYER. Nenhum outro módulo escreve aqui.
 *
 * Unidades:
 *   - distâncias em metros, tempos em segundos, ângulos em GRAUS.
 *   - `spread*` é o meio-ângulo do cone de dispersão (graus).
 *   - `recoilPattern` é uma lista determinística [yaw, pitch] em graus por tiro:
 *     é o deslocamento PERMANENTE da mira (o que o jogador decora e compensa).
 *     Por cima dele o WeaponSystem soma um kick visual com mola (recupera sozinho)
 *     e um spread aleatório pequeno — igual ao modelo do Call of Duty moderno.
 *
 * Penetração: `penetration` é "poder de perfuração" em unidades arbitrárias.
 * Cada superfície tem um custo (ver PENETRATION_COST). Se o poder restante cobre
 * o custo, a bala atravessa perdendo dano; senão, para na parede.
 */

/** Custo de perfuração por superfície (contrato de superfícies do ARCHITECTURE.md). */
export const PENETRATION_COST = {
  folhagem: 0.15,
  vidro: 0.30,
  madeira: 1.00,
  carne: 1.10,
  metal: 1.90,   // chapa fina / lataria
  agua: 2.20,
  terra: 2.60,
  tijolo: 3.20,
  asfalto: 5.00,
  concreto: 6.00,
  default: 3.00,
};

/** Quanto de dano sobra depois de atravessar cada superfície. */
export const PENETRATION_DAMAGE = {
  folhagem: 0.95,
  vidro: 0.90,
  madeira: 0.68,
  carne: 0.72,
  metal: 0.48,
  agua: 0.55,
  terra: 0.40,
  tijolo: 0.38,
  default: 0.45,
};

/** Multiplicador de dano por parte do corpo (a IA reporta `part`). */
export const PART_MULT = {
  head: null,     // usa weapon.headMult
  torso: 1.0,
  chest: 1.0,
  stomach: 0.9,
  arm: 0.72,
  leg: 0.68,
  limb: 0.72,
  default: 1.0,
};

/**
 * Padrões de recuo desenhados à mão. Cada par é [yaw, pitch] em graus.
 * Depois do fim do array o padrão repete os últimos 6 valores com sinal alternado
 * (ver WeaponSystem._patternAt), então mesmo pente cheio continua legível.
 */
const PADRAO_IA2 = [
  [0.00, 0.44], [-0.04, 0.56], [0.06, 0.60], [-0.09, 0.58], [0.14, 0.55], [-0.06, 0.52],
  [0.19, 0.49], [0.12, 0.46], [0.26, 0.43], [0.31, 0.40], [0.23, 0.37], [0.36, 0.35],
  [0.43, 0.33], [0.31, 0.31], [0.19, 0.30], [0.04, 0.29], [-0.16, 0.28], [-0.31, 0.27],
  [-0.44, 0.26], [-0.52, 0.25], [-0.41, 0.25], [-0.26, 0.24], [-0.11, 0.24], [0.06, 0.23],
  [0.21, 0.23], [0.33, 0.22], [0.24, 0.22], [0.08, 0.21], [-0.12, 0.21], [-0.28, 0.20],
];

const PADRAO_SMT40 = [
  [0.00, 0.38], [0.09, 0.44], [-0.11, 0.46], [0.16, 0.44], [-0.18, 0.42], [0.23, 0.40],
  [-0.14, 0.38], [0.29, 0.36], [0.36, 0.34], [0.27, 0.32], [0.41, 0.31], [0.48, 0.30],
  [0.34, 0.29], [0.16, 0.28], [-0.09, 0.27], [-0.33, 0.27], [-0.51, 0.26], [-0.62, 0.26],
  [-0.55, 0.25], [-0.38, 0.25], [-0.17, 0.24], [0.05, 0.24], [0.26, 0.23], [0.44, 0.23],
  [0.35, 0.22], [0.13, 0.22], [-0.14, 0.21], [-0.39, 0.21], [-0.55, 0.20], [-0.42, 0.20],
];

const PADRAO_PT92 = [
  [0.00, 0.95], [0.10, 0.98], [-0.12, 1.02], [0.14, 0.99], [-0.16, 1.05], [0.18, 1.00],
  [-0.13, 1.03], [0.15, 0.97], [-0.17, 1.01], [0.12, 0.96],
];

/**
 * Catálogo. `id` é a chave usada em eventos; `name` é o texto do HUD.
 */
export const WEAPONS = {
  /* ------------------------------------------------------------------ *
   * IA2 5,56 — fuzil de assalto padrão do Exército Brasileiro.
   * Pesado, cadência média, controlável, o melhor a média distância.
   * ------------------------------------------------------------------ */
  ia2: {
    id: 'ia2',
    name: 'IA2 5,56',
    class: 'fuzil',
    caliber: '5.56x45',

    rpm: 700,
    fireMode: 'auto',
    fireModes: ['auto', 'burst', 'semi'],
    burstCount: 3,
    burstDelay: 0.24,

    damage: 33,
    damageFalloff: [
      { dist: 0,   mult: 1.00 },
      { dist: 26,  mult: 1.00 },
      { dist: 48,  mult: 0.78 },
      { dist: 85,  mult: 0.58 },
      { dist: 140, mult: 0.48 },
    ],
    headMult: 1.65,

    spreadBase:   0.62,   // parado, quadril
    spreadMoving: 2.05,   // andando/correndo, quadril
    spreadADS:    0.10,
    spreadCrouchMult: 0.72,
    spreadAirMult: 2.60,
    spreadPerShot: 0.20,  // bloom por tiro
    spreadMax: 3.60,
    spreadRecovery: 3.20, // graus/s de fechamento

    recoilPattern: PADRAO_IA2,
    recoilScaleADS: 0.68,
    recoilRecovery: 9.5,       // graus/s de retorno do acumulado
    recoilRecoveryDelay: 0.16, // espera depois do último tiro
    kickPitch: 1.35,           // kick visual (mola, recupera sozinho)
    kickYaw: 0.55,
    kickPunch: 0.045,          // recuo do viewmodel em metros

    magSize: 30,
    reserveAmmo: 210,
    reloadTime: 2.15,
    reloadEmptyTime: 2.95,
    adsTime: 0.27,
    drawTime: 0.55,
    holsterTime: 0.35,

    muzzleVelocity: 900,
    penetration: 2.30,
    range: 260,

    adsFovDelta: 16,       // graus subtraídos do FOV do mundo em ADS
    viewFovADS: 42,        // FOV do viewmodel em ADS
    weight: 1.0,           // inércia do viewmodel (maior = mais lento)
    swayScale: 1.0,
    shellEjectDelay: 0.035,
  },

  /* ------------------------------------------------------------------ *
   * Taurus SMT-40 — submetralhadora .40 S&W. Cadência alta, ADS rápido,
   * derruba rápido de perto e vira confete depois dos 30 m.
   * ------------------------------------------------------------------ */
  smt40: {
    id: 'smt40',
    name: 'Taurus SMT-40',
    class: 'submetralhadora',
    caliber: '.40 S&W',

    rpm: 900,
    fireMode: 'auto',
    fireModes: ['auto', 'semi'],
    burstCount: 3,
    burstDelay: 0.20,

    damage: 26,
    damageFalloff: [
      { dist: 0,  mult: 1.00 },
      { dist: 14, mult: 1.00 },
      { dist: 28, mult: 0.70 },
      { dist: 45, mult: 0.50 },
      { dist: 80, mult: 0.38 },
    ],
    headMult: 1.45,

    spreadBase:   0.95,
    spreadMoving: 2.30,
    spreadADS:    0.22,
    spreadCrouchMult: 0.78,
    spreadAirMult: 2.20,
    spreadPerShot: 0.17,
    spreadMax: 4.20,
    spreadRecovery: 4.10,

    recoilPattern: PADRAO_SMT40,
    recoilScaleADS: 0.74,
    recoilRecovery: 11.0,
    recoilRecoveryDelay: 0.13,
    kickPitch: 1.05,
    kickYaw: 0.62,
    kickPunch: 0.034,

    magSize: 30,
    reserveAmmo: 240,
    reloadTime: 1.85,
    reloadEmptyTime: 2.45,
    adsTime: 0.19,
    drawTime: 0.42,
    holsterTime: 0.28,

    muzzleVelocity: 380,
    penetration: 1.20,
    range: 140,

    adsFovDelta: 10,
    viewFovADS: 46,
    weight: 0.78,
    swayScale: 1.15,
    shellEjectDelay: 0.028,
  },

  /* ------------------------------------------------------------------ *
   * Taurus PT-92 — pistola 9 mm. Semiauto, saque rápido, dano decente
   * na cabeça. Arma de emergência.
   * ------------------------------------------------------------------ */
  pt92: {
    id: 'pt92',
    name: 'Taurus PT-92',
    class: 'pistola',
    caliber: '9x19',

    rpm: 420,
    fireMode: 'semi',
    fireModes: ['semi'],
    burstCount: 1,
    burstDelay: 0,

    damage: 30,
    damageFalloff: [
      { dist: 0,  mult: 1.00 },
      { dist: 12, mult: 1.00 },
      { dist: 26, mult: 0.72 },
      { dist: 45, mult: 0.52 },
      { dist: 70, mult: 0.42 },
    ],
    headMult: 1.85,

    spreadBase:   0.80,
    spreadMoving: 1.85,
    spreadADS:    0.16,
    spreadCrouchMult: 0.80,
    spreadAirMult: 2.00,
    spreadPerShot: 0.30,
    spreadMax: 3.00,
    spreadRecovery: 5.50,

    recoilPattern: PADRAO_PT92,
    recoilScaleADS: 0.80,
    recoilRecovery: 16.0,
    recoilRecoveryDelay: 0.08,
    kickPitch: 2.10,
    kickYaw: 0.70,
    kickPunch: 0.052,

    magSize: 17,
    reserveAmmo: 85,
    reloadTime: 1.55,
    reloadEmptyTime: 2.15,
    adsTime: 0.16,
    drawTime: 0.32,
    holsterTime: 0.22,

    muzzleVelocity: 360,
    penetration: 0.85,
    range: 100,

    adsFovDelta: 7,
    viewFovADS: 48,
    weight: 0.55,
    swayScale: 1.30,
    shellEjectDelay: 0.020,
  },

  /* ------------------------------------------------------------------ *
   * IMBEL AGLC .308 — fuzil de precisão de ferrolho.
   *
   * Contrato de jogo: mata em um tiro no torso a qualquer distância útil, mas
   * cobra caro por isso — ferrolho lento entre disparos, ADS demorado, e no
   * quadril é praticamente inútil. Quem erra o primeiro tiro paga com quase
   * um segundo e meio de exposição.
   * ------------------------------------------------------------------ */
  aglc: {
    id: 'aglc',
    name: 'IMBEL AGLC .308',
    class: 'precisao',
    caliber: '7.62x51',
    scope: true,              // HUD desenha a luneta em ADS

    rpm: 48,                  // limitado pelo ciclo do ferrolho
    fireMode: 'semi',
    fireModes: ['semi'],
    boltAction: true,
    boltCycle: 1.05,          // segundos de ciclo depois de cada tiro

    damage: 115,
    damageFalloff: [
      { dist: 0,   mult: 1.00 },
      { dist: 120, mult: 1.00 },
      { dist: 200, mult: 0.92 },
      { dist: 300, mult: 0.85 },
    ],
    headMult: 2.20,

    spreadBase:   3.20,       // no quadril é um desperdício de bala
    spreadMoving: 6.40,
    spreadADS:    0.012,      // parado e mirado: praticamente pontual
    spreadCrouchMult: 0.55,
    spreadAirMult: 5.00,
    spreadPerShot: 1.40,
    spreadMax: 8.00,
    spreadRecovery: 2.60,

    recoilPattern: [
      [0.00, 2.90], [0.35, 2.70], [-0.30, 2.80], [0.20, 2.60], [-0.15, 2.75],
    ],
    recoilScaleADS: 0.82,
    recoilRecovery: 6.5,
    recoilRecoveryDelay: 0.30,
    kickPitch: 3.40,
    kickYaw: 0.85,
    kickPunch: 0.115,

    magSize: 5,
    reserveAmmo: 45,
    reloadTime: 2.85,
    reloadEmptyTime: 3.55,
    adsTime: 0.46,            // lento de propósito
    drawTime: 0.85,
    holsterTime: 0.55,

    muzzleVelocity: 810,
    penetration: 4.20,        // atravessa madeira, chapa e alvenaria fina
    range: 400,

    adsFovDelta: 52,          // ~3x de aumento no FOV do mundo
    viewFovADS: 26,
    weight: 1.9,              // viewmodel pesado, sway lento
    swayScale: 1.5,
    shellEjectDelay: 0.55,    // sai no ciclo do ferrolho, não no tiro
  },
};

/** Ordem do inventário (teclas 1/2/3). */
export const LOADOUT = ['ia2', 'aglc', 'pt92'];

/** Intervalo entre tiros, em segundos. */
export function fireInterval(w) { return 60 / w.rpm; }

/** Multiplicador de dano por distância, interpolado linearmente na curva. */
export function falloffAt(w, dist) {
  const c = w.damageFalloff;
  if (!c || c.length === 0) return 1;
  if (dist <= c[0].dist) return c[0].mult;
  for (let i = 1; i < c.length; i++) {
    if (dist <= c[i].dist) {
      const a = c[i - 1], b = c[i];
      const t = (dist - a.dist) / Math.max(1e-5, b.dist - a.dist);
      return a.mult + (b.mult - a.mult) * t;
    }
  }
  return c[c.length - 1].mult;
}

/** Estado de munição inicial de uma arma (cópia mutável por instância). */
export function makeAmmoState(w) {
  return { ammo: w.magSize, reserve: w.reserveAmmo, fireMode: w.fireMode };
}
