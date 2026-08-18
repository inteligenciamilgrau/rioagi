/**
 * DroneMalha — a malha do batedor aereo da AGI. Procedural, sem asset.
 *
 * PARENTESCO. O drone tem de ser lido como a MESMA maquina do `Soldier`, vista
 * de outro angulo — nao como um objeto de outro jogo que por acaso e inimigo.
 * O que garante isso nao e "usar uma cor parecida": e usar literalmente o mesmo
 * `Construtor` (mesmo chanfro de quina, mesma normal por diferenca finita), o
 * mesmo `materialSoldado()` (mesmos tres canais por vertice: rugosidade,
 * metalicidade, emissao) e os MESMOS acabamentos numericos — chapa jateada
 * 0.80/0.32, placa escovada 0.60/0.58, junta usinada nua 0.42/1.00.
 *
 * A assinatura e a FENDA OPTICA horizontal em ciano frio. No soldado ela vai de
 * tempora a tempora; aqui ela atravessa o nariz inteiro do chassi. As duas
 * medidas que a fizeram ler em pleno sol (ver o bloco da fenda em Soldier.js)
 * valem igual e foram respeitadas:
 *
 *   1. TAMANHO — 1 px vale 1.94 mrad com FOV 80 num quadro de 720 px. A fenda
 *      do drone tem 40 mm de altura => ~1.4 px a 15 m, uma fileira inteira
 *      acesa. Sub-pixel o rasterizador simplesmente perde.
 *   2. VIZINHANCA — o emissivo fica em ~3.0, no topo da faixa em que o ACES
 *      ainda segura o croma (acima disso a fenda vira uma barra BRANCA e a
 *      identidade se apaga em vez de reforcar). Quem faz a fenda ler a
 *      distancia e o PRETO ao lado dela: a banda `visor` e desenhada bem mais
 *      alta e mais larga que a propria fenda.
 *
 * FICCAO. O morro e o unico setor que a malha nunca conseguiu MAPEAR — viela
 * que nao esta em planta nenhuma, laje que virou rua. O drone e a resposta dela
 * a isso: nao e uma arma que voa, e um OLHO que voa e que atira quando precisa.
 * Dai o casulo do sensor pendurado sob o nariz, apontando para baixo, varrendo
 * o beco. Ele mapeia; o que ele mapeia e o que mata depois.
 *
 * ORCAMENTO. Corpo = uma geometria compartilhada por todos os drones, um
 * `Mesh` por drone (1 draw call cada). As helices sao uma geometria a parte,
 * desenhada por um unico `InstancedMesh` para o enxame INTEIRO (ver
 * `RotoresEnxame`): 4 rotores x 14 drones = 56 instancias em 1 draw call. Sem
 * isso, helice que gira custaria 4 draw calls por drone.
 *
 * Convencao: metros, Y para cima, **frente do drone = -Z** (igual ao Soldier).
 * Origem no centro de massa do chassi.
 *
 * Dono: agente AI.
 */
import * as THREE from 'three';
import { Construtor } from './Soldier.js';

const _cor = new THREE.Color();
function rgb(hex) { _cor.setHex(hex); return [_cor.r, _cor.g, _cor.b]; }

/* Acabamentos — os MESMOS numeros do Soldier. Nao "parecidos": os mesmos.
 * Calibrados dentro do jogo contra o ceu do Rio a 2.8 de intensidade. */
const R_CASCO = 0.80, M_CASCO = 0.32;   // chapa jateada e pintada
const R_PLACA = 0.60, M_PLACA = 0.58;   // placa escovada
const R_JUNTA = 0.42, M_JUNTA = 1.00;   // junta usinada exposta (metal nu)
const R_PIST = 0.28, M_PIST = 1.00;     // haste cromada
const R_CHASSI = 0.82, M_CHASSI = 0.18; // estrutura interna
const R_LUZ = 0.30;                     // superficie emissiva

/**
 * Paleta do drone.
 *
 * `optica` e exatamente o ciano da variante LINHA do soldado (0x1fcdff) —
 * medido como o valor em que o indice de ciano do pixel final ((g+b)/2 - r)
 * ainda vale 66 com ganho 3.0. Trocar o tom quebraria o parentesco no unico
 * ponto em que ele e lido a distancia.
 *
 * O casco e um degrau MAIS ESCURO que o do soldado de linha (0x3c434b contra
 * 0x444b53) de proposito: o drone aparece contra o CEU, nao contra a parede.
 * Silhueta clara contra ceu claro ao entardecer some; a escura recorta.
 */
const P = {
  casco: 0x3c434b, placa: 0x4b535c, chassi: 0x17191e, junta: 0x5b636a,
  pistao: 0x7b838a, optica: 0x1fcdff, sinal: 0x24b8e8, visor: 0x090b0d,
  emiOptica: 3.0,
};

/** Meia-envergadura do braco (centro do rotor) e raio da carenagem. */
export const RAIO_ROTOR = 0.108;
export const BRACO_X = 0.268;
export const BRACO_Z = 0.238;
export const BRACO_Y = 0.028;

const EIXO_X = [1, 0, 0];
const EIXO_Y = [0, 1, 0];
const EIXO_Z = [0, 0, 1];

/** Anel de secao no plano XY, empilhado ao longo de Z (o eixo do fuselado). */
function anelXY(z, rx, ry, exp, cor, rug, dx = 0, dy = 0, met, emi) {
  return { c: [dx, dy, z], u: EIXO_X, v: EIXO_Y, rx, ry, exp, cor, rug, met, emi };
}

/** Anel de secao no plano XZ, empilhado ao longo de Y. */
function anelXZ(y, rx, rz, exp, cor, rug, dx = 0, dz = 0, met, emi) {
  return { c: [dx, y, dz], u: EIXO_X, v: EIXO_Z, rx, ry: rz, exp, cor, rug, met, emi };
}

/** Tubo reto entre dois pontos quaisquer. */
function tubo(C, a, b, r0, r1, cor, rug, met, lados = 7) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / L, dy / L, dz / L];
  const up = Math.abs(d[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  let u = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  const lu = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / lu, u[1] / lu, u[2] / lu];
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  C.loft([
    { c: a, u, v, rx: r0, ry: r0, exp: 1, cor, rug },
    { c: b, u, v, rx: r1, ry: r1, exp: 1, cor, rug },
  ], { lados, ossos: [], expo: 1, tampaA: true, tampaB: true, rug, met });
}

/** Caixa chanfrada — atalho para `C.caixa` com a assinatura sem ossos. */
function bloco(C, met, emi, cx, cy, cz, sx, sy, sz, rot, cor, rug, chanfro = 0.22) {
  C.pincel(met, emi);
  C.caixa(cx, cy, cz, sx, sy, sz, rot, cor, rug, [], 1, chanfro);
  C.pincel(0, 0);
}

/* ======================================================================== *
 * Corpo
 * ======================================================================== */

function construirCorpo() {
  const C = new Construtor();
  const cCasco = rgb(P.casco), cPlaca = rgb(P.placa), cChassi = rgb(P.chassi);
  const cJunta = rgb(P.junta), cPistao = rgb(P.pistao);
  const cOptica = rgb(P.optica), cSinal = rgb(P.sinal), cVisor = rgb(P.visor);

  /* ------------------------------------------------------------- fuselagem
   * Casulo achatado, mais largo que alto: um drone alto le como caixa voadora.
   * A secao usa expoente de superelipse < 1 (canto cheio) na barriga e ~0.5 no
   * dorso, que e o que da a quina alta caracteristica da familia. */
  C.loft([
    anelXY(-0.352, 0.030, 0.022, 0.60, cChassi, R_CHASSI, 0, 0.004, M_CHASSI),
    anelXY(-0.320, 0.088, 0.052, 0.55, cCasco, R_CASCO, 0, 0.002),
    anelXY(-0.262, 0.140, 0.078, 0.50, cCasco, R_CASCO, 0, 0),
    anelXY(-0.150, 0.176, 0.096, 0.46, cCasco, R_CASCO, 0, 0),
    anelXY(-0.020, 0.186, 0.102, 0.44, cCasco, R_CASCO, 0, 0),
    anelXY(0.110, 0.170, 0.096, 0.48, cCasco, R_CASCO, 0, -0.002),
    anelXY(0.216, 0.126, 0.074, 0.55, cCasco, R_CASCO, 0, -0.006),
    anelXY(0.286, 0.070, 0.044, 0.70, cChassi, R_CHASSI, 0, -0.010, M_CHASSI),
    anelXY(0.318, 0.030, 0.020, 0.85, cChassi, R_CHASSI, 0, -0.012, M_CHASSI),
  ], { lados: 12, ossos: [], expo: 1, tampaA: true, tampaB: true, rug: R_CASCO, met: M_CASCO });

  /* Placa dorsal aplicada — a blindagem que se ve por cima quando ele passa
   * sobre a laje. Escovada, mais clara, com a junta aparecendo na borda. */
  bloco(C, M_PLACA, 0, 0, 0.096, -0.030, 0.244, 0.030, 0.352, null, cPlaca, R_PLACA, 0.30);
  bloco(C, M_PLACA, 0, 0, 0.112, 0.086, 0.156, 0.026, 0.152, [0.16, 0, 0], cPlaca, R_PLACA, 0.30);

  /* Costela lateral: a linha de junta que percorre a fuselagem. Sem ela o
   * casco fica com cara de bolha lisa, que e o defeito de silhueta que o
   * CRITICA.md chama de "material plastico sem variacao". */
  for (const s of [1, -1]) {
    bloco(C, M_JUNTA, 0, s * 0.176, 0.010, -0.040, 0.020, 0.036, 0.412, [0, 0, s * 0.05],
      cJunta, R_JUNTA, 0.34);
  }

  /* ---------------------------------------------------- NUCLEO DORSAL
   * O losango aceso entre as placas, igual ao do peito do soldado de linha.
   * Aqui ele tem funcao de jogo: e a caixa do sensor, e o ponto fraco (ver
   * `Drone.PARTES`). Fica em cima, visivel de quem esta ABAIXO do drone — ou
   * seja, do jogador. */
  bloco(C, M_JUNTA, 0, 0, 0.118, -0.030, 0.088, 0.088, 0.024, [0, 0, 0.785],
    cJunta, R_JUNTA, 0.26);
  bloco(C, 0, 2.2, 0, 0.126, -0.030, 0.056, 0.056, 0.022, [0, 0, 0.785],
    cOptica, R_LUZ, 0.30);

  /* ------------------------------------------------------- FENDA OPTICA
   * A assinatura. Primeiro a banda quase preta (mais alta e mais larga que a
   * fenda: e o preto vizinho que faz o ciano sobreviver a media de area do
   * pixel a 20 m), depois a fenda emissiva encaixada nela. */
  bloco(C, M_CHASSI, 0, 0, 0.006, -0.300, 0.212, 0.106, 0.030, null, cVisor, 0.58, 0.18);

  C.pincel(0, P.emiOptica);
  C.caixa(0, 0.006, -0.322, 0.196, 0.040, 0.018, null, cOptica, R_LUZ, [], 1, 0.26);
  /* As pontas dobram para a lateral: de perfil, e passando por voce, o drone
   * continua aceso. Um inimigo que so "acende" de frente desaparece justamente
   * no instante em que passa raspando. */
  for (const s of [1, -1]) {
    C.caixa(s * 0.094, 0.006, -0.286, 0.020, 0.036, 0.056, [0, s * 0.60, 0],
      cOptica, R_LUZ, [], 1, 0.30);
  }
  C.pincel(0, 0);

  // labio/aba sobre a fenda: sombra propria em cima do ciano, como a
  // sobrancelha do PESADO. E o que impede a fenda de lavar sob o sol raso.
  bloco(C, M_PLACA, 0, 0, 0.052, -0.306, 0.216, 0.024, 0.052, [0.34, 0, 0],
    cPlaca, R_PLACA, 0.22);

  /* ------------------------------------------------- casulo do sensor
   * Pendurado sob o nariz, apontado para BAIXO: e ele que varre o beco que a
   * malha nunca mapeou. Duas pecas — a rotula (junta nua) e a lente. */
  C.loft([
    anelXZ(-0.062, 0.052, 0.052, 0.85, cJunta, R_JUNTA, 0, -0.248, M_JUNTA),
    anelXZ(-0.096, 0.062, 0.062, 0.90, cChassi, R_CHASSI, 0, -0.248, M_CHASSI),
    anelXZ(-0.130, 0.050, 0.050, 0.95, cChassi, R_CHASSI, 0, -0.248, M_CHASSI),
  ], { lados: 9, ossos: [], expo: 1, tampaA: true, tampaB: true, rug: R_CHASSI, met: M_CHASSI });
  C.pincel(0, P.emiOptica * 0.55);
  C.caixa(0, -0.138, -0.248, 0.052, 0.014, 0.052, null, cOptica, R_LUZ, [], 1, 0.34);
  C.pincel(0, 0);

  /* ------------------------------------------------------------- bracos
   * Quatro, em X. Cada um: pino de junta na saida do casco (o eixo exposto que
   * a familia inteira tem), haste de pistao cromada, e a carenagem do rotor.
   * O braco sobe um pouco na ponta — nao e horizontal — para o rotor ficar
   * acima do plano do casco e a silhueta nao virar uma cruz chapada. */
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const ax = sx * 0.112, az = sz * 0.104;
      const bx = sx * BRACO_X, bz = sz * BRACO_Z;

      // pino de junta na raiz (eixo de maquina exposto)
      tubo(C, [ax * 0.72, 0.010, az * 0.72], [ax, 0.010, az], 0.034, 0.030,
        cJunta, R_JUNTA, M_JUNTA, 8);
      // haste
      tubo(C, [ax, 0.010, az], [bx, BRACO_Y, bz], 0.026, 0.019,
        cPistao, R_PIST, M_PIST, 7);
      // reforco em placa por cima da haste
      bloco(C, M_PLACA, 0, (ax + bx) * 0.5, 0.026, (az + bz) * 0.5,
        0.030, 0.014, 0.180, [0, Math.atan2(bx - ax, bz - az), 0], cPlaca, R_PLACA, 0.34);

      // carenagem do rotor: anel achatado (duto), nao um aro fino
      const aneis = [];
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * Math.PI * 2;
        const cx = bx + Math.cos(th) * RAIO_ROTOR;
        const cz = bz + Math.sin(th) * RAIO_ROTOR;
        // secao do duto: pequena elipse no plano (radial, Y)
        aneis.push({
          c: [cx, BRACO_Y + 0.006, cz],
          u: [Math.cos(th), 0, Math.sin(th)], v: [0, 1, 0],
          rx: 0.016, ry: 0.021, exp: 0.8,
          cor: i % 7 === 0 ? cJunta : cCasco, rug: i % 7 === 0 ? R_JUNTA : R_CASCO,
          met: i % 7 === 0 ? M_JUNTA : M_CASCO,
        });
      }
      C.loft(aneis, { lados: 6, ossos: [], expo: 1, rug: R_CASCO, met: M_CASCO });

      // cubo do motor no centro do duto
      C.loft([
        anelXZ(BRACO_Y - 0.014, 0.030, 0.030, 0.9, cChassi, R_CHASSI, bx, bz, M_CHASSI),
        anelXZ(BRACO_Y + 0.016, 0.034, 0.034, 0.9, cJunta, R_JUNTA, bx, bz, M_JUNTA),
        anelXZ(BRACO_Y + 0.030, 0.022, 0.022, 0.9, cPistao, R_PIST, bx, bz, M_PIST),
      ], { lados: 8, ossos: [], expo: 1, tampaA: true, tampaB: true, rug: R_JUNTA, met: M_JUNTA });

      // luz de posicao na carenagem: frente ciano, tras apagada. E o que
      // permite ao jogador saber para que lado o bicho esta olhando no escuro.
      if (sz < 0) {
        C.pincel(0, 2.4);
        C.caixa(bx, BRACO_Y + 0.014, bz - RAIO_ROTOR - 0.008, 0.030, 0.012, 0.012,
          null, cSinal, R_LUZ, [], 1, 0.30);
        C.pincel(0, 0);
      }
    }
  }

  /* ---------------------------------------------------------- trem de pouso
   * Dois patins finos. Servem a silhueta (quebram a barriga lisa) e a leitura
   * de escala — sem eles o drone poderia ter qualquer tamanho na foto. */
  for (const s of [1, -1]) {
    tubo(C, [s * 0.086, -0.088, -0.150], [s * 0.086, -0.088, 0.170], 0.011, 0.011,
      cChassi, R_CHASSI, M_CHASSI, 5);
    tubo(C, [s * 0.070, -0.014, -0.096], [s * 0.086, -0.084, -0.096], 0.010, 0.009,
      cPistao, R_PIST, M_PIST, 5);
    tubo(C, [s * 0.070, -0.014, 0.114], [s * 0.086, -0.084, 0.114], 0.010, 0.009,
      cPistao, R_PIST, M_PIST, 5);
  }

  /* ------------------------------------------------------------- antena
   * O tracinho do BATEDOR. Aqui ele nao e enfeite: e a antena da malha, e o
   * drone e o unico membro da familia que precisa dela para valer — ele voa
   * fora do alcance do resto e retransmite o que ve. */
  tubo(C, [0.028, 0.116, 0.196], [0.048, 0.300, 0.238], 0.007, 0.003,
    cPistao, R_PIST, M_PIST, 5);
  C.pincel(0, 2.0);
  C.caixa(0.048, 0.306, 0.238, 0.016, 0.016, 0.016, null, cSinal, R_LUZ, [], 1, 0.35);
  C.pincel(0, 0);

  const g = C.paraGeometria();
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
}

/* ======================================================================== *
 * Helice
 * ======================================================================== */

/**
 * Uma helice de tres pas, centrada na origem, girando em torno de Y.
 *
 * Geometria PROPRIA (nao entra no corpo) porque ela e a unica peca do drone que
 * se move sozinha. Desenhada por `RotoresEnxame` como `InstancedMesh`: o enxame
 * inteiro cabe em 1 draw call, contra 4 por drone se cada rotor fosse um `Mesh`.
 */
function construirHelice() {
  const C = new Construtor();
  const cChassi = rgb(P.chassi), cPistao = rgb(P.pistao);
  /* Folga para a carenagem: o duto tem secao de 16 mm no raio, com a face
   * interna em RAIO_ROTOR - 0.016. Pa de 0.082 deixa 10 mm de folga — sem isso
   * a ponta atravessa o duto e o drone parece quebrado justamente de perto. */
  const R = RAIO_ROTOR - 0.026;

  // cubo
  C.loft([
    anelXZ(-0.008, 0.017, 0.017, 0.9, cPistao, R_PIST, 0, 0, M_PIST),
    anelXZ(0.010, 0.013, 0.013, 0.9, cPistao, R_PIST, 0, 0, M_PIST),
  ], { lados: 7, ossos: [], expo: 1, tampaA: true, tampaB: true, rug: R_PIST, met: M_PIST });

  // tres pas com passo (torcao): a pa e uma caixa fina inclinada
  for (let i = 0; i < 3; i++) {
    const th = (i / 3) * Math.PI * 2;
    const mx = Math.cos(th) * R * 0.56, mz = Math.sin(th) * R * 0.56;
    bloco(C, M_CHASSI, 0, mx, 0.001, mz, R * 0.86, 0.005, 0.030,
      [0, -th, 0.34], cChassi, 0.55, 0.30);
  }

  const g = C.paraGeometria();
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
}

/* ======================================================================== *
 * Material
 * ======================================================================== */

let _mat = null;
let _uEmi = null;

/**
 * Ganho do IBL so da maquina. MESMO valor do Soldier, e pelo MESMO motivo —
 * ver o bloco `ENV_ROBO` em Soldier.js: o three sobrescreve `envMapIntensity`
 * de todo `MeshStandardMaterial` que dependa de `scene.environment`, e a unica
 * saida e o material ter um envMap proprio.
 */
const ENV_ROBO = 0.30;

/**
 * O drone tem material PROPRIO, e nao o `materialSoldado()`. Por que:
 *
 * O telegrafo da investida e a fenda PULSANDO, e pulso e um valor por DRONE.
 * Como todos compartilham o material, o unico jeito barato de variar por objeto
 * e um uniform escrito em `onBeforeRender` — que roda por objeto, logo antes do
 * draw dele. Se esse uniform morasse no material do soldado, o ultimo drone
 * desenhado deixaria o pulso dele valendo para todo soldado desenhado depois.
 *
 * O custo de separar e um programa a mais e um material a mais; o custo de nao
 * separar seria mexer no material do soldado, que foi calibrado e medido
 * (roboCor.mjs, roboFps.mjs) e cuja conclusao explicita foi: nada de instrucao
 * nova no FRAGMENTO. Aqui o ganho entra no VERTICE (`vEmi = emiAttr * uEmiGanho`),
 * uma multiplicacao por vertice — o drone tem ~1,5 mil vertices contra centenas
 * de milhares de fragmentos, entao e custo que nao aparece na conta.
 */
function materialDrone() {
  if (_mat) return _mat;
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    envMapIntensity: 1.0,
    name: 'ai_drone',
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uEmiGanho = { value: 1 };
    _uEmi = shader.uniforms.uEmiGanho;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float rugAttr;\nattribute float metAttr;\nattribute float emiAttr;\n'
        + 'uniform float uEmiGanho;\nvarying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvRug = rugAttr;\n\tvMet = metAttr;\n\tvEmi = emiAttr * uEmiGanho;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(vRug, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n\tmetalnessFactor = clamp(vMet, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * vEmi;');
  };
  m.customProgramCacheKey = () => 'ai_drone_rug_met_emi_pulso';
  _mat = m;
  return m;
}

/**
 * Ganho de emissao do PROXIMO objeto desenhado com o material do drone.
 * Chamado de `onBeforeRender`, que o three executa por objeto imediatamente
 * antes do draw — e por isso que um uniform compartilhado consegue carregar um
 * valor por drone.
 */
export function definirGanhoEmissivo(v) {
  if (_uEmi) _uEmi.value = v;
}

/**
 * Aponta o material para o mapa de ambiente da cena.
 *
 * Tem de rodar todo quadro: o `Lighting` REGERA o PMREM quando o ceu muda e
 * troca `scene.environment` por um render target novo. Sem re-sincronizar, o
 * drone continuaria refletindo um ceu velho — e numa onda so de drone nenhum
 * `Soldier.update` roda, entao nao da para depender da sincronia dele.
 */
export function sincronizarIBLDrone(ctx) {
  const m = _mat;
  const cena = ctx?.scene;
  if (!m || !cena) return;
  const env = cena.environment ?? null;
  if (!env) return;
  if (m.envMap !== env) {
    if (m.envMap === null) m.needsUpdate = true;
    m.envMap = env;
  }
  const k = ENV_ROBO * (cena.environmentIntensity ?? 1);
  if (m.envMapIntensity !== k) m.envMapIntensity = k;
}

/* ======================================================================== *
 * Recursos compartilhados
 * ======================================================================== */

let _rec = null;

/** Geometrias e material compartilhados por TODOS os drones. */
export function recursosDrone() {
  if (_rec) return _rec;
  const geo = construirCorpo();
  const geoHelice = construirHelice();
  _rec = {
    geo,
    geoHelice,
    material: materialDrone(),
    tris: geo.index.count / 3,
    trisHelice: geoHelice.index.count / 3,
  };
  return _rec;
}

export function disposeRecursosDrone() {
  if (!_rec) return;
  _rec.geo.dispose();
  _rec.geoHelice.dispose();
  _rec = null;
  _mat?.dispose();
  _mat = null;
  _uEmi = null;
}

/* ======================================================================== *
 * Rotores do enxame — 1 draw call para todas as helices de todos os drones
 * ======================================================================== */

const _mRot = new THREE.Matrix4();
const _qRot = new THREE.Quaternion();
const _pRot = new THREE.Vector3();
const _eRot = new THREE.Euler();
const _sRot = new THREE.Vector3(1, 1, 1);

/** Posicao local dos quatro rotores no espaco do drone. */
export const POS_ROTOR = [
  [BRACO_X, BRACO_Y + 0.030, BRACO_Z],
  [-BRACO_X, BRACO_Y + 0.030, BRACO_Z],
  [BRACO_X, BRACO_Y + 0.030, -BRACO_Z],
  [-BRACO_X, BRACO_Y + 0.030, -BRACO_Z],
];

export class RotoresEnxame {
  /** @param {number} maxDrones quantos drones o pool comporta */
  constructor(maxDrones) {
    const rec = recursosDrone();
    this.max = maxDrones * 4;
    this.malha = new THREE.InstancedMesh(rec.geoHelice, rec.material, this.max);
    this.malha.name = 'drone:rotores';
    this.malha.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.malha.castShadow = false;      // pa de 5 mm nao produz sombra legivel
    this.malha.receiveShadow = true;
    this.malha.frustumCulled = false;   // o enxame se espalha; culling por lote erra
    this.malha.count = 0;
    this._n = 0;
  }

  /** Inicio do quadro. */
  comecar() { this._n = 0; }

  /**
   * Escreve os quatro rotores de um drone.
   * @param {THREE.Object3D} corpo o `Mesh` do drone (ja com matrixWorld valida)
   * @param {number} giro angulo de rotacao das pas, em radianos
   */
  adicionar(corpo, giro) {
    for (let i = 0; i < 4; i++) {
      if (this._n >= this.max) return;
      const p = POS_ROTOR[i];
      // sentido alternado, como num quadricoptero de verdade: dois horarios,
      // dois anti-horarios. De perto da para ver, e e o tipo de detalhe que
      // separa "modelo de drone" de "helice girando".
      const sinal = (i === 0 || i === 3) ? 1 : -1;
      _eRot.set(0, giro * sinal, 0);
      _qRot.setFromEuler(_eRot);
      _pRot.set(p[0], p[1], p[2]);
      _mRot.compose(_pRot, _qRot, _sRot);
      _mRot.premultiply(corpo.matrixWorld);
      this.malha.setMatrixAt(this._n++, _mRot);
    }
  }

  /** Fim do quadro: fixa quantas instancias desenhar e sobe a matriz.
   *
   * Nao ha "esconder sobra": `InstancedMesh` desenha exatamente `count`
   * instancias, entao baixar o contador ja tira do quadro as helices dos
   * drones que morreram. Zerar a escala das sobras seria trabalho jogado fora. */
  terminar() {
    this.malha.count = this._n;
    this.malha.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.malha.removeFromParent();
    this.malha.dispose();
  }
}
