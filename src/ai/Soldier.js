/**
 * Soldier — a MAQUINA da AGI. Personagem procedural com esqueleto de verdade.
 *
 * O nome ficou por causa dos contratos (Enemy, Ragdoll, AIManager, Etiquetas
 * chamam `soldado`), mas o inimigo nao e mais gente: e chapa metalica escovada,
 * junta usinada exposta, haste de pistao e uma FENDA OPTICA horizontal em ciano
 * frio no lugar do rosto. A silhueta humanoide pesada continua — o esqueleto,
 * as hitboxes e a animacao sao exatamente os mesmos.
 *
 * Sem assets: a malha e gerada por lofts de secao superelipse ao longo de curvas,
 * com pesos de skinning calculados por distancia aos SEGMENTOS de osso (topo 4,
 * normalizados) — e o que da a dobra suave em cotovelo, joelho e cintura. As
 * pecas rigidas (pino de junta, rotula, placa) sao amarradas a UM osso so: um
 * eixo de maquina nao pode esticar entre dois ossos como se fosse carne.
 *
 * Esqueleto (22 ossos):
 *   quadril > coluna1 > coluna2 > peito > pescoco > cabeca
 *                                 peito > clavicula_{D,E} > ombro > cotovelo > punho
 *   quadril > perna_{D,E} > joelho > tornozelo > pe
 *
 * Convencoes: metros, Y para cima, **frente do soldado = -Z** (padrao Object3D),
 * +X = lado direito do soldado. Bind pose com TODAS as rotacoes identidade — o
 * `boneInverse` vira uma translacao pura e o rig fica previsivel.
 *
 * Animacao 100% procedural, em camadas somaveis:
 *   base (respiracao) + locomocao (ciclo senoidal com contra-rotacao de quadril
 *   e ombro) + agachamento + mira (torso com look-at ponderado + IK dos bracos
 *   travados na arma) + recarga (curvas em codigo) + flinch + recuo.
 *
 * A altura do quadril NAO e uma senoide solta: sai da cinematica direta das
 * pernas (o pe mais baixo fica no chao). O bob emerge da geometria, como no
 * corpo real — e por isso o passo nao "patina".
 *
 * Dono: agente AI.
 */
import * as THREE from 'three';

/* ======================================================================== *
 * Esqueleto
 * ======================================================================== */

/** [nome, pai, x, y, z] em espaco do personagem (pes no y=0). */
const DEF_OSSOS = [
  ['quadril', null, 0, 0.980, 0],
  ['coluna1', 'quadril', 0, 1.100, 0.006],
  ['coluna2', 'coluna1', 0, 1.240, 0.006],
  ['peito', 'coluna2', 0, 1.372, 0],
  ['pescoco', 'peito', 0, 1.520, -0.008],
  ['cabeca', 'pescoco', 0, 1.612, -0.006],

  ['clavicula_D', 'peito', 0.046, 1.476, 0],
  ['ombro_D', 'clavicula_D', 0.186, 1.462, 0.004],
  ['cotovelo_D', 'ombro_D', 0.243, 1.170, 0.024],
  ['punho_D', 'cotovelo_D', 0.286, 0.900, 0.034],

  ['clavicula_E', 'peito', -0.046, 1.476, 0],
  ['ombro_E', 'clavicula_E', -0.186, 1.462, 0.004],
  ['cotovelo_E', 'ombro_E', -0.243, 1.170, 0.024],
  ['punho_E', 'cotovelo_E', -0.286, 0.900, 0.034],

  ['perna_D', 'quadril', 0.097, 0.942, 0],
  ['joelho_D', 'perna_D', 0.103, 0.506, -0.020],
  ['tornozelo_D', 'joelho_D', 0.103, 0.092, 0.022],
  ['pe_D', 'tornozelo_D', 0.103, 0.034, -0.058],

  ['perna_E', 'quadril', -0.097, 0.942, 0],
  ['joelho_E', 'perna_E', -0.103, 0.506, -0.020],
  ['tornozelo_E', 'joelho_E', -0.103, 0.092, 0.022],
  ['pe_E', 'tornozelo_E', -0.103, 0.034, -0.058],
];

/** Ponta de cada osso sem filho (para o segmento de skinning). */
const PONTAS = {
  cabeca: [0, 1.800, 0.005],
  punho_D: [0.300, 0.812, 0.046],
  punho_E: [-0.300, 0.812, 0.046],
  pe_D: [0.103, 0.014, -0.150],
  pe_E: [-0.103, 0.014, -0.150],
};

/** Indice por nome + segmentos em espaco de bind. */
const IDX = new Map();
const SEG = [];
(function montarSegmentos() {
  for (let i = 0; i < DEF_OSSOS.length; i++) IDX.set(DEF_OSSOS[i][0], i);
  const posDe = (n) => { const d = DEF_OSSOS[IDX.get(n)]; return [d[2], d[3], d[4]]; };
  for (let i = 0; i < DEF_OSSOS.length; i++) {
    const [nome] = DEF_OSSOS[i];
    const a = posDe(nome);
    let b = PONTAS[nome];
    if (!b) {
      // media dos filhos (a cintura tem dois: usa o primeiro que continua o eixo)
      const filhos = DEF_OSSOS.filter((d) => d[1] === nome);
      if (filhos.length === 1) b = [filhos[0][2], filhos[0][3], filhos[0][4]];
      else if (filhos.length > 1) {
        // prefere o filho alinhado ao eixo do corpo (coluna/perna), nao a clavicula
        const eixo = filhos.find((f) => Math.abs(f[2] - a[0]) < 0.02) || filhos[0];
        b = [eixo[2], eixo[3], eixo[4]];
      } else b = [a[0], a[1] + 0.1, a[2]];
    }
    SEG.push({ nome, i, ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2] });
  }
})();

const SEG_POR_NOME = new Map(SEG.map((s) => [s.nome, s]));

function distSegmento(px, py, pz, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, dz = s.bz - s.az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-9 ? ((px - s.ax) * dx + (py - s.ay) * dy + (pz - s.az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = s.ax + dx * t - px, qy = s.ay + dy * t - py, qz = s.az + dz * t - pz;
  return Math.sqrt(qx * qx + qy * qy + qz * qz);
}

/* ======================================================================== *
 * Construtor de malha
 * ======================================================================== */

const _cor = new THREE.Color();
const _tmpPesos = [];

class Construtor {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.col = []; this.rug = [];
    this.met = []; this.emi = [];
    this.si = []; this.sw = []; this.idx = [];
    // "pincel" corrente: metalicidade e brilho proprio aplicados a cada vertice
    // emitido. Evita mudar a assinatura de vert()/caixa() em todo o arquivo.
    this._met = 0.0;
    this._emi = 0.0;
  }

  get nVerts() { return this.pos.length / 3; }

  /** Define metalicidade (0..1) e emissao (0 = apagado) dos proximos vertices. */
  pincel(met = 0, emi = 0) { this._met = met; this._emi = emi; return this; }

  /**
   * Pesos por distancia ao segmento: w = 1/(d+eps)^expo, top 4 normalizado.
   * `ossos` restringe os candidatos — impede o braco puxar a costela.
   */
  _pesos(x, y, z, ossos, expo) {
    _tmpPesos.length = 0;
    for (let i = 0; i < ossos.length; i++) {
      const s = SEG_POR_NOME.get(ossos[i]);
      if (!s) continue;
      const d = distSegmento(x, y, z, s);
      _tmpPesos.push(s.i, Math.pow(1 / (d + 0.02), expo));
    }
    // seleciona os 4 maiores (lista curta: insercao simples)
    let i0 = 0, i1 = 0, i2 = 0, i3 = 0, w0 = 0, w1 = 0, w2 = 0, w3 = 0;
    for (let k = 0; k < _tmpPesos.length; k += 2) {
      const bi = _tmpPesos[k], bw = _tmpPesos[k + 1];
      if (bw > w0) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = i0; w1 = w0; i0 = bi; w0 = bw; }
      else if (bw > w1) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = bi; w1 = bw; }
      else if (bw > w2) { i3 = i2; w3 = w2; i2 = bi; w2 = bw; }
      else if (bw > w3) { i3 = bi; w3 = bw; }
    }
    const soma = w0 + w1 + w2 + w3 || 1;
    this.si.push(i0, i1, i2, i3);
    this.sw.push(w0 / soma, w1 / soma, w2 / soma, w3 / soma);
  }

  vert(x, y, z, nx, ny, nz, u, v, cor, rug, ossos, expo) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(cor[0], cor[1], cor[2]);
    this.rug.push(rug);
    this.met.push(this._met);
    this.emi.push(this._emi);
    this._pesos(x, y, z, ossos, expo);
  }

  tri(a, b, c) { this.idx.push(a, b, c); }

  /**
   * Loft: sequencia de aneis de secao superelipse.
   * anel = {c:[x,y,z], u:[..], v:[..], rx, ry, exp?, cor?, rug?}
   */
  loft(aneis, opts) {
    const lados = opts.lados ?? 10;
    const ossos = opts.ossos;
    const expo = opts.expo ?? 4;
    const corPadrao = opts.cor;
    const rugPadrao = opts.rug ?? 0.9;
    // pincel: guarda o estado e resolve o padrao do loft (anel pode sobrescrever)
    const metAntes = this._met, emiAntes = this._emi;
    const metPadrao = opts.met ?? metAntes, emiPadrao = opts.emi ?? emiAntes;
    const n = aneis.length;
    const base = this.nVerts;

    // Orientacao das faces: o anel e percorrido de u para v, entao a normal
    // "natural" do anel e u x v. Se ela apontar contra a direcao de empilhamento
    // a ordem dos triangulos precisa inverter, senao o corpo fica com backface.
    let flip = false;
    if (n > 1) {
      const a0 = aneis[0], a1 = aneis[1];
      const cx = a0.u[1] * a0.v[2] - a0.u[2] * a0.v[1];
      const cy = a0.u[2] * a0.v[0] - a0.u[0] * a0.v[2];
      const cz = a0.u[0] * a0.v[1] - a0.u[1] * a0.v[0];
      const sx = a1.c[0] - a0.c[0], sy = a1.c[1] - a0.c[1], sz = a1.c[2] - a0.c[2];
      flip = (cx * sx + cy * sy + cz * sz) < 0;
    }

    // 1) posicoes
    const G = new Float32Array(n * lados * 3);
    for (let i = 0; i < n; i++) {
      const a = aneis[i];
      const e = a.exp ?? opts.exp ?? 1.0;
      const ux = a.u[0], uy = a.u[1], uz = a.u[2];
      const vx = a.v[0], vy = a.v[1], vz = a.v[2];
      for (let k = 0; k < lados; k++) {
        const th = (k / lados) * Math.PI * 2;
        let ca = Math.cos(th), sa = Math.sin(th);
        if (e !== 1) {
          ca = Math.sign(ca) * Math.pow(Math.abs(ca), e);
          sa = Math.sign(sa) * Math.pow(Math.abs(sa), e);
        }
        const rx = a.rx * ca, ry = a.ry * sa;
        const o = (i * lados + k) * 3;
        G[o] = a.c[0] + ux * rx + vx * ry;
        G[o + 1] = a.c[1] + uy * rx + vy * ry;
        G[o + 2] = a.c[2] + uz * rx + vz * ry;
      }
    }

    // 2) vertices com normal por diferenca finita na grade
    for (let i = 0; i < n; i++) {
      const a = aneis[i];
      const cor = a.cor ?? corPadrao;
      const rug = a.rug ?? rugPadrao;
      this._met = a.met ?? metPadrao; this._emi = a.emi ?? emiPadrao;
      const iA = Math.max(0, i - 1), iB = Math.min(n - 1, i + 1);
      for (let k = 0; k < lados; k++) {
        const kA = (k + lados - 1) % lados, kB = (k + 1) % lados;
        const o = (i * lados + k) * 3;
        const oT0 = (i * lados + kA) * 3, oT1 = (i * lados + kB) * 3;
        const oS0 = (iA * lados + k) * 3, oS1 = (iB * lados + k) * 3;
        const tx = G[oT1] - G[oT0], ty = G[oT1 + 1] - G[oT0 + 1], tz = G[oT1 + 2] - G[oT0 + 2];
        const sx = G[oS1] - G[oS0], sy = G[oS1 + 1] - G[oS0 + 1], sz = G[oS1 + 2] - G[oS0 + 2];
        let nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
        let L = Math.hypot(nx, ny, nz);
        if (L < 1e-9) { nx = G[o] - a.c[0]; ny = G[o + 1] - a.c[1]; nz = G[o + 2] - a.c[2]; L = Math.hypot(nx, ny, nz) || 1; }
        nx /= L; ny /= L; nz /= L;
        // garante que aponta para fora do eixo
        const rx = G[o] - a.c[0], ry = G[o + 1] - a.c[1], rz = G[o + 2] - a.c[2];
        if (nx * rx + ny * ry + nz * rz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        this.vert(G[o], G[o + 1], G[o + 2], nx, ny, nz, k / lados, i / (n - 1 || 1), cor, rug, ossos, expo);
      }
    }

    // 3) faces
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < lados; k++) {
        const k2 = (k + 1) % lados;
        const a = base + i * lados + k, b = base + i * lados + k2;
        const c = base + (i + 1) * lados + k2, d = base + (i + 1) * lados + k;
        this.tri(a, b, c); this.tri(a, c, d);
      }
    }

    // 4) tampas
    const tampa = (i, sinal) => {
      const a = aneis[i];
      const iv = Math.max(0, Math.min(n - 1, i + sinal));
      let dx = aneis[iv].c[0] - a.c[0], dy = aneis[iv].c[1] - a.c[1], dz = aneis[iv].c[2] - a.c[2];
      let L = Math.hypot(dx, dy, dz) || 1;
      dx = -dx / L * sinal * sinal; dy = -dy / L; dz = -dz / L;
      // normal aponta para fora (contrario ao vizinho)
      const nx = (a.c[0] - aneis[iv].c[0]) / L, ny = (a.c[1] - aneis[iv].c[1]) / L, nz = (a.c[2] - aneis[iv].c[2]) / L;
      const cor = a.cor ?? corPadrao, rug = a.rug ?? rugPadrao;
      this._met = a.met ?? metPadrao; this._emi = a.emi ?? emiPadrao;
      const centro = this.nVerts;
      this.vert(a.c[0], a.c[1], a.c[2], nx, ny, nz, 0.5, 0.5, cor, rug, ossos, expo);
      const anel0 = this.nVerts;
      for (let k = 0; k < lados; k++) {
        const o = (i * lados + k) * 3;
        this.vert(G[o], G[o + 1], G[o + 2], nx, ny, nz, k / lados, 0, cor, rug, ossos, expo);
      }
      for (let k = 0; k < lados; k++) {
        const k2 = (k + 1) % lados;
        if (sinal < 0) this.tri(centro, anel0 + k, anel0 + k2);
        else this.tri(centro, anel0 + k2, anel0 + k);
      }
    };
    if (opts.tampaA) tampa(0, 1);
    if (opts.tampaB) tampa(n - 1, -1);
    this._met = metAntes; this._emi = emiAntes;
  }

  /** Caixa com cantos levemente chanfrados (nada de quina viva perfeita). */
  caixa(cx, cy, cz, sx, sy, sz, rot, cor, rug, ossos, expo = 6, chanfro = 0.12) {
    const q = rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])) : null;
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const c = Math.min(chanfro, 0.45);
    const faces = [
      [[1, 0, 0], hx], [[-1, 0, 0], hx], [[0, 1, 0], hy],
      [[0, -1, 0], hy], [[0, 0, 1], hz], [[0, 0, -1], hz],
    ];
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    for (const [nrm, ext] of faces) {
      const [nx, ny, nz] = nrm;
      // dois eixos tangentes
      const t1 = Math.abs(ny) > 0.5 ? [1, 0, 0] : [0, 1, 0];
      const t2 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
      // Extensao de CADA tangente (t1, t2), nao "as duas que sobraram": nas
      // faces +-Z o t1 e Y e o t2 e X. Trocado, uma placa 3x20x14 cm era
      // desenhada 20 cm de largura nas faces da frente e de tras — o robo
      // ganhava "asas" na coxa e na canela.
      const e1 = Math.abs(nx) > 0.5 ? hy : Math.abs(ny) > 0.5 ? hx : hy;
      const e2 = Math.abs(nx) > 0.5 ? hz : Math.abs(ny) > 0.5 ? hz : hx;
      const base = this.nVerts;
      for (let s = 0; s < 4; s++) {
        const su = (s === 0 || s === 3) ? -1 : 1;
        const sv = (s < 2) ? -1 : 1;
        v.set(
          nx * ext + t1[0] * e1 * su * (1 - c) + t2[0] * e2 * sv * (1 - c),
          ny * ext + t1[1] * e1 * su * (1 - c) + t2[1] * e2 * sv * (1 - c),
          nz * ext + t1[2] * e1 * su * (1 - c) + t2[2] * e2 * sv * (1 - c),
        );
        nv.set(nx, ny, nz);
        if (q) { v.applyQuaternion(q); nv.applyQuaternion(q); }
        this.vert(cx + v.x, cy + v.y, cz + v.z, nv.x, nv.y, nv.z, s & 1, s >> 1, cor, rug, ossos, expo);
      }
      this.tri(base, base + 1, base + 2); this.tri(base, base + 2, base + 3);
      // "cinta" do chanfro: liga com a face vizinha por um anel simples
      const base2 = this.nVerts;
      for (let s = 0; s < 4; s++) {
        const su = (s === 0 || s === 3) ? -1 : 1;
        const sv = (s < 2) ? -1 : 1;
        v.set(
          nx * ext * (1 - c * 0.9) + t1[0] * e1 * su + t2[0] * e2 * sv,
          ny * ext * (1 - c * 0.9) + t1[1] * e1 * su + t2[1] * e2 * sv,
          nz * ext * (1 - c * 0.9) + t1[2] * e1 * su + t2[2] * e2 * sv,
        );
        nv.set(nx * 0.55 + t1[0] * su * 0.6 + t2[0] * sv * 0.6,
          ny * 0.55 + t1[1] * su * 0.6 + t2[1] * sv * 0.6,
          nz * 0.55 + t1[2] * su * 0.6 + t2[2] * sv * 0.6).normalize();
        if (q) { v.applyQuaternion(q); nv.applyQuaternion(q); }
        this.vert(cx + v.x, cy + v.y, cz + v.z, nv.x, nv.y, nv.z, s & 1, s >> 1, cor, rug, ossos, expo);
      }
      for (let s = 0; s < 4; s++) {
        const s2 = (s + 1) % 4;
        this.tri(base + s, base2 + s, base2 + s2);
        this.tri(base + s, base2 + s2, base + s2);
      }
    }
  }

  /**
   * Corrige triangulos com winding invertido.
   *
   * Partes espelhadas (lado esquerdo do corpo, placas, ombreiras) sao geradas
   * negando um eixo de escala, o que inverte a ordem dos vertices. Com
   * `side: FrontSide` essas faces sao descartadas pelo backface culling e o
   * jogador ve o INTERIOR escuro do modelo — o tronco parecia sumir e sobravam
   * as pernas.
   *
   * Em vez de mascarar com DoubleSide (que dobra o custo de raster e estraga a
   * sombra), comparamos a normal geometrica de cada triangulo com a media das
   * normais dos seus vertices: se apontarem para lados opostos, trocamos dois
   * indices.
   */
  _corrigirWinding() {
    const pos = this.pos, nor = this.nor, idx = this.idx;
    let trocados = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      // arestas
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      // normal geometrica = e1 x e2
      const gx = e1y * e2z - e1z * e2y;
      const gy = e1z * e2x - e1x * e2z;
      const gz = e1x * e2y - e1y * e2x;
      // normal media dos vertices (a autorada, sempre para fora)
      const mx = nor[a] + nor[b] + nor[c];
      const my = nor[a + 1] + nor[b + 1] + nor[c + 1];
      const mz = nor[a + 2] + nor[b + 2] + nor[c + 2];
      if (gx * mx + gy * my + gz * mz < 0) {
        const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp;
        trocados++;
      }
    }
    return trocados;
  }

  paraGeometria() {
    const invertidos = this._corrigirWinding();
    if (invertidos > 0) {
      console.info(`[Soldier] ${invertidos} triangulo(s) com winding invertido corrigidos`);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('rugAttr', new THREE.Float32BufferAttribute(this.rug, 1));
    g.setAttribute('metAttr', new THREE.Float32BufferAttribute(this.met, 1));
    g.setAttribute('emiAttr', new THREE.Float32BufferAttribute(this.emi, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ======================================================================== *
 * Paleta e variantes
 * ======================================================================== */

function rgb(hex) { _cor.setHex(hex); return [_cor.r, _cor.g, _cor.b]; }

/**
 * Variantes = MODELOS DE MAQUINA, nao roupas.
 *
 * O inimigo e o exercito da AGI subindo o morro: chapa escovada escura, junta
 * usinada a mostra, haste de pistao cromada e uma FENDA OPTICA horizontal em
 * ciano frio no lugar do rosto — a assinatura visual do jogo, o oposto exato do
 * laranja quente da favela.
 *
 *   0 BATEDOR — chassi leve, quase sem placa, antena alta, fenda estreita.
 *   1 LINHA   — infantaria padrao, peitoral em duas placas, nucleo aceso.
 *   2 PESADO  — placas grossas, ombreiras grandes, viseira com sobrancelha.
 *
 * `optica` e `sinal` sao cores EMISSIVAS: a cor do vertice vira radiancia
 * multiplicada por `emiAttr` (ver materialSoldado). `visor` e o oposto — a
 * banda quase preta em que a fenda se encaixa, e que garante o contraste local
 * dela em pleno sol.
 *
 * As tres tem de ser distinguiveis A OLHO no jogo, nao so no estudio. O que
 * separa uma da outra e `casco`/`placa`; para essa diferenca chegar ao pixel,
 * o difuso tem de participar — ver o bloco de acabamentos em construirCorpo().
 */
const PALETAS = [
  { // 0 — BATEDOR
    classe: 'batedor',
    casco: 0x57616a, placa: 0x687079, chassi: 0x21242a, junta: 0x6a7178,
    pistao: 0x858d93, optica: 0x2ad6ff, sinal: 0x2ec8f0, sola: 0x121216,
    visor: 0x0c0e11,
    volume: 0.90, ombreira: 0.72, emiOptica: 3.2,
    nucleo: false, antena: true, sobrancelha: false, olhosDuplos: false, dorsal: false,
  },
  { // 1 — LINHA
    classe: 'linha',
    casco: 0x444b53, placa: 0x545c65, chassi: 0x1b1d22, junta: 0x5f676d,
    pistao: 0x7f878e, optica: 0x1fcdff, sinal: 0x24b8e8, sola: 0x0f1013,
    visor: 0x0a0c0e,
    volume: 1.00, ombreira: 1.00, emiOptica: 3.0,
    nucleo: true, antena: false, sobrancelha: false, olhosDuplos: false, dorsal: true,
  },
  { // 2 — PESADO
    classe: 'pesado',
    casco: 0x333940, placa: 0x404750, chassi: 0x131518, junta: 0x525961,
    pistao: 0x727a82, optica: 0x17c2f7, sinal: 0x1aa8dc, sola: 0x0c0d0f,
    visor: 0x08090b,
    volume: 1.13, ombreira: 1.28, emiOptica: 2.8,
    nucleo: true, antena: false, sobrancelha: true, olhosDuplos: true, dorsal: true,
  },
];

/* ======================================================================== *
 * Geracao da malha do corpo
 * ======================================================================== */

const OSSOS_TORSO = ['quadril', 'coluna1', 'coluna2', 'peito', 'pescoco', 'clavicula_D', 'clavicula_E'];
const OSSOS_CABECA = ['cabeca', 'pescoco'];
const OSSOS_PESCOCO = ['pescoco', 'cabeca', 'peito'];

function ossosBraco(l) { return [`clavicula_${l}`, `ombro_${l}`, `cotovelo_${l}`, `punho_${l}`, 'peito']; }
function ossosMao(l) { return [`punho_${l}`, `cotovelo_${l}`]; }
function ossosPerna(l) { return [`perna_${l}`, `joelho_${l}`, `tornozelo_${l}`, 'quadril']; }
function ossosPe(l) { return [`tornozelo_${l}`, `pe_${l}`, `joelho_${l}`]; }

const EIXO_X = [1, 0, 0];
const EIXO_Z = [0, 0, 1];

/** Aneis empilhados em Y (secao no plano XZ). `met`/`emi` sobrescrevem o loft. */
function anelXZ(y, rx, rz, exp, cor, rug, dx = 0, dz = 0, met, emi) {
  return { c: [dx, y, dz], u: EIXO_X, v: EIXO_Z, rx, ry: rz, exp, cor, rug, met, emi };
}

/** Aneis ao longo de um segmento arbitrario (membros). */
function aneisMembro(a, b, perfil, cor, rug, exp = 1) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / L, dy / L, dz / L];
  // base perpendicular estavel
  let up = Math.abs(d[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  let u = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  let lu = Math.hypot(u[0], u[1], u[2]) || 1; u = [u[0] / lu, u[1] / lu, u[2] / lu];
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const out = [];
  for (const p of perfil) {
    const t = p[0];
    out.push({
      c: [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t],
      u, v, rx: p[1], ry: p[2], exp: p[3] ?? exp,
      cor: p[4] ? rgb(p[4]) : cor, rug: p[5] ?? rug,
    });
  }
  return out;
}

function posOsso(nome) { const d = DEF_OSSOS[IDX.get(nome)]; return [d[2], d[3], d[4]]; }

/**
 * Monta a geometria completa de uma variante.
 * @returns {THREE.BufferGeometry}
 */
function construirCorpo(paletaIdx, semente) {
  const P = PALETAS[paletaIdx % PALETAS.length];
  const C = new Construtor();
  const rnd = (() => { let s = (semente * 9301 + 49297) % 233280; return () => (s = (s * 9301 + 49297) % 233280) / 233280; })();
  const jitter = (a) => (rnd() - 0.5) * 2 * a;

  const cCasco = rgb(P.casco), cPlaca = rgb(P.placa), cChassi = rgb(P.chassi);
  const cJunta = rgb(P.junta), cPistao = rgb(P.pistao);
  const cOptica = rgb(P.optica), cSinal = rgb(P.sinal), cSola = rgb(P.sola);
  const cVisor = rgb(P.visor);

  /* Acabamentos: rugosidade e metalicidade por tipo de superficie — os dois
   * canais por vertice do material.
   *
   * CALIBRADOS DENTRO DO JOGO (tools/roboCor.mjs), nao no estudio. O estudio
   * tem um RoomEnvironment a 0.75; o jogo tem o ceu do Rio a 2.8. Metal com
   * metalicidade alta e rugosidade baixa quase nao tem cor difusa propria: ele
   * DEVOLVE o ambiente. Com os valores antigos (chapa .74/.48, placa .86/.34) o
   * corpo virava espelho de ceu, subia para a parte comprimida do ACES e as
   * tres variantes chegavam ao mesmo pixel — medido: a 15 m, em sombra aberta,
   * lum 129.1 / 130.0 / 129.2, indistinguiveis.
   *
   * A correcao nao e escurecer a cor base (com metal alto ela mal participa):
   * e admitir que blindagem militar e chapa jateada e FOSFATIZADA/PINTADA —
   * dieletrica e aspera —, e que so a junta usinada e a haste de pistao sao
   * metal nu. Com metalicidade menor volta o difuso, e o difuso e quem carrega
   * a cor da variante. */
  const R_CASCO = 0.80, M_CASCO = 0.32;   // chapa jateada e pintada (o grosso do corpo)
  const R_PLACA = 0.60, M_PLACA = 0.58;   // placa escovada (blindagem aplicada)
  const R_JUNTA = 0.42, M_JUNTA = 1.00;   // junta usinada exposta (metal nu)
  const R_PIST = 0.28, M_PIST = 1.00;     // haste de pistao cromada (o brilho da maquina)
  const R_CHASSI = 0.82, M_CHASSI = 0.18; // estrutura interna / conduite
  const R_BORR = 0.96, M_BORR = 0.00;     // borracha da sola
  const R_LUZ = 0.30;                     // vidro da optica

  /** Volume geral da variante (+ variacao por semente: nenhuma sai igual). */
  const b = P.volume * (1 + jitter(0.035));
  const ro = P.ombreira * (1 + jitter(0.03));

  // ---------------------------------------------------------------- helpers
  /** Tubo reto entre dois pontos (haste, conduite, pino). */
  const tubo = (a, z, r1, r2, cor, rug, met, ossos, lados = 8, tampas = true) =>
    C.loft(aneisMembro(a, z, [[0, r1, r1], [1, r2, r2]], cor, rug),
      { lados, ossos, expo: 5, tampaA: tampas, tampaB: tampas, rug, met });

  /**
   * Pino de junta: cilindro no eixo X. Fica RIGIDO num osso so — um eixo de
   * maquina nao pode esticar entre dois ossos como se fosse carne.
   */
  const pino = (x, y, z, comp, r, cor, rug, met, osso, lados = 9) =>
    tubo([x - comp / 2, y, z], [x + comp / 2, y, z], r, r, cor, rug, met, [osso], lados);

  /** Caixa com pincel (metalicidade/emissao) explicito. */
  const bloco = (met, emi, ...args) => { C.pincel(met, emi); C.caixa(...args); C.pincel(0, 0); };

  /** Ponto interpolado entre dois ossos, com deslocamento. */
  const entre = (A, Z, t, ox = 0, oy = 0, oz = 0) => [
    A[0] + (Z[0] - A[0]) * t + ox, A[1] + (Z[1] - A[1]) * t + oy, A[2] + (Z[2] - A[2]) * t + oz,
  ];

  /* ------------------------------------------------------------- chassi
   * Coluna interna. Fica exposta na cintura, entre a pelve e o torso: e o
   * "esqueleto" da maquina aparecendo por baixo da blindagem. */
  C.loft([
    anelXZ(0.928, 0.074, 0.070, 1.0, cChassi, R_CHASSI),
    anelXZ(1.020, 0.062, 0.058, 1.0, cChassi, R_CHASSI),
    anelXZ(1.074, 0.052, 0.049, 1.0, cChassi, R_CHASSI),
    anelXZ(1.120, 0.055, 0.052, 1.0, cChassi, R_CHASSI),
    anelXZ(1.240, 0.070, 0.064, 1.0, cChassi, R_CHASSI),
    anelXZ(1.430, 0.072, 0.066, 1.0, cChassi, R_CHASSI),
    anelXZ(1.500, 0.058, 0.054, 1.0, cChassi, R_CHASSI),
  ], { lados: 9, ossos: OSSOS_TORSO, expo: 2.6, tampaA: true, tampaB: true, rug: R_CHASSI, met: M_CHASSI });

  // vertebras usinadas: dois aneis de junta em volta do chassi exposto
  for (const y of [1.058, 1.092]) {
    C.loft([
      anelXZ(y - 0.009, 0.059, 0.056, 1.0, cJunta, R_JUNTA),
      anelXZ(y + 0.009, 0.059, 0.056, 1.0, cJunta, R_JUNTA),
    ], { lados: 9, ossos: ['coluna1', 'quadril'], expo: 3, rug: R_JUNTA, met: M_JUNTA });
  }

  /* --------------------------------------------------------------- pelve */
  C.loft([
    anelXZ(0.856, 0.106 * b, 0.088 * b, 0.55, cCasco, R_CASCO),
    anelXZ(0.910, 0.138 * b, 0.106 * b, 0.46, cCasco, R_CASCO),
    anelXZ(0.972, 0.140 * b, 0.108 * b, 0.44, cCasco, R_CASCO),
    anelXZ(1.028, 0.118 * b, 0.090 * b, 0.50, cCasco, R_CASCO),
  ], { lados: 12, ossos: ['quadril', 'coluna1'], expo: 2.6, tampaA: true, tampaB: true, rug: R_CASCO, met: M_CASCO });

  // placa frontal da pelve
  bloco(M_PLACA, 0, 0, 0.948, -0.104 * b, 0.150 * b, 0.118, 0.030, [0.14, 0, 0],
    cPlaca, R_PLACA, ['quadril'], 5, 0.22);

  /* --------------------------------------------------------------- torso */
  C.loft([
    anelXZ(1.108, 0.114 * b, 0.094 * b, 0.55, cCasco, R_CASCO),
    anelXZ(1.180, 0.150 * b, 0.116 * b, 0.46, cCasco, R_CASCO),
    anelXZ(1.284, 0.180 * b, 0.128 * b, 0.42, cCasco, R_CASCO),
    anelXZ(1.378, 0.196 * b, 0.132 * b, 0.40, cCasco, R_CASCO),
    anelXZ(1.452, 0.190 * b, 0.124 * b, 0.44, cCasco, R_CASCO),
    anelXZ(1.500, 0.144 * b, 0.096 * b, 0.55, cCasco, R_CASCO),
  ], { lados: 12, ossos: ['coluna1', 'coluna2', 'peito', 'pescoco'], expo: 2.4, tampaA: true, tampaB: true, rug: R_CASCO, met: M_CASCO });

  // peitoral: duas placas anguladas em cima (nada de "colete" arredondado) e
  // uma placa abdominal embaixo — o sulco entre elas quebra o painel unico
  for (const s of [1, -1]) {
    bloco(M_PLACA, 0, s * 0.074 * b, 1.362, -0.128 * b, 0.128 * b, 0.148, 0.042,
      [0.05, s * 0.15, 0], cPlaca, R_PLACA, ['peito', 'coluna2'], 3, 0.22);
  }
  bloco(M_PLACA, 0, 0, 1.232, -0.122 * b, 0.188 * b, 0.104, 0.038,
    [-0.10, 0, 0], cPlaca, R_PLACA, ['coluna2', 'coluna1'], 3, 0.22);

  // unidade dorsal (reator/refrigeracao) + aletas
  bloco(M_CHASSI, 0, 0, 1.298, 0.144 * b, 0.168 * b, 0.248, 0.070, null,
    cChassi, R_CHASSI, ['coluna2', 'peito'], 3, 0.16);
  for (const y of [1.244, 1.352]) {
    bloco(M_JUNTA, 0, 0, y, 0.182 * b, 0.148 * b, 0.016, 0.030, null,
      cJunta, R_JUNTA, ['coluna2', 'peito'], 3, 0.30);
  }
  if (P.dorsal) {
    // barra de sinal nas costas: identifica a unidade de longe, por tras
    bloco(0, 2.3, 0, 1.402, 0.186 * b, 0.086, 0.014, 0.012, null,
      cSinal, R_LUZ, ['peito'], 3, 0.30);
  }

  // nucleo do peito: losango aceso na frente, entre as duas placas
  if (P.nucleo) {
    bloco(M_JUNTA, 0, 0, 1.226, -0.150 * b, 0.074, 0.074, 0.020, [0, 0, 0.785],
      cJunta, R_JUNTA, ['coluna2'], 4, 0.25);
    bloco(0, 2.2, 0, 1.226, -0.160 * b, 0.046, 0.046, 0.018, [0, 0, 0.785],
      cOptica, R_LUZ, ['coluna2'], 4, 0.30);
  }

  /* ------------------------------------------------------------- pescoco
   * Atuador cilindrico, sem nenhuma pretensao organica. */
  tubo([0, 1.480, -0.004], [0, 1.584, -0.008], 0.040, 0.035, cJunta, R_JUNTA, M_JUNTA, OSSOS_PESCOCO, 8);
  C.loft([
    anelXZ(1.510, 0.049, 0.047, 1.0, cPistao, R_PIST, 0, -0.005),
    anelXZ(1.526, 0.049, 0.047, 1.0, cPistao, R_PIST, 0, -0.005),
  ], { lados: 8, ossos: OSSOS_PESCOCO, expo: 3, rug: R_PIST, met: M_PIST });

  /* -------------------------------------------------------------- cabeca
   * Casco anguloso com um SULCO horizontal na altura dos olhos: e nele que a
   * fenda optica se encaixa e de onde ela parece nascer. */
  C.loft([
    anelXZ(1.574, 0.054, 0.058, 0.70, cCasco, R_CASCO, 0, 0.004),
    anelXZ(1.606, 0.070, 0.082, 0.50, cCasco, R_CASCO, 0, -0.006),
    anelXZ(1.646, 0.080, 0.092, 0.42, cCasco, R_CASCO, 0, -0.014),
    anelXZ(1.668, 0.080, 0.092, 0.42, cCasco, R_CASCO, 0, -0.014),
    anelXZ(1.678, 0.073, 0.083, 0.48, cChassi, R_CHASSI, 0, -0.012, M_CHASSI),
    anelXZ(1.704, 0.072, 0.082, 0.48, cChassi, R_CHASSI, 0, -0.012, M_CHASSI),
    anelXZ(1.714, 0.086, 0.098, 0.40, cCasco, R_CASCO, 0, -0.016),
    anelXZ(1.756, 0.082, 0.090, 0.44, cCasco, R_CASCO, 0, -0.010),
    anelXZ(1.788, 0.058, 0.060, 0.55, cCasco, R_CASCO, 0, -0.002),
    anelXZ(1.804, 0.026, 0.028, 0.80, cCasco, R_CASCO, 0, 0.002),
  ], { lados: 10, ossos: OSSOS_CABECA, expo: 5, tampaA: true, tampaB: true, rug: R_CASCO, met: M_CASCO });

  // crista no alto do cranio: quebra o domo liso e da direcao ao "olhar"
  bloco(M_PLACA, 0, 0, 1.786, -0.014, 0.030, 0.024, 0.112, [0.10, 0, 0],
    cPlaca, R_PLACA, ['cabeca'], 6, 0.30);

  /* ---- FENDA OPTICA — a assinatura visual do jogo ----------------------
   * Precisa ler EM LUZ DE DIA, a distancia de combate. Duas medidas mataram a
   * versao anterior (tools/roboCor.mjs):
   *
   *  1. TAMANHO. Com FOV 80 num quadro de 720 px, 1 px vale 1.94 mrad; a 15 m
   *     isso e 29 mm. A fenda tinha 18 mm de altura => 0.62 px. Sub-pixel: o
   *     rasterizador simplesmente a perdia, e o TAA acabava com o resto.
   *     Medido a 15 m: pico de ciano -13 (o vermelho ganhava), zero pixel ciano.
   *     Agora tem 34 mm => ~1.2 px a 15 m, uma fileira inteira acesa.
   *  2. VIZINHANCA, nao brilho bruto. O caminho obvio — subir muito o
   *     emissivo — e uma armadilha, e a medicao mostrou isso: o ACES do
   *     tonemap DESSATURA. Com a cor 0x1fcdff, o indice de ciano do pixel
   *     final ((g+b)/2 - r) vale 143 com ganho 1.0, 92 com 2.0, 66 com 3.0 e
   *     so 32 com 6.4 — a partir dali a fenda vira uma barra BRANCA, que e
   *     justamente o que ja acontecia com o corpo. Subir o emissivo apaga a
   *     identidade em vez de reforca-la.
   *     O que faz a fenda ler a distancia e a media de area do pixel: quando
   *     ela cobre meio pixel, o outro meio tem de ser PRETO, nao metal claro.
   *     Dai a banda escura (`visor`, quase preta) bem mais alta em volta —
   *     e o emissivo ficar em ~3.0, no topo da faixa em que o ACES ainda
   *     segura o croma.
   *
   * Bloom nao entra na conta: o limiar do PostFX (1.05) e global, e de dia o
   * ceu inteiro passa por ele. Quem tem de perder e o metal ao lado da fenda. */

  // moldura/visor escuro do sulco (vai de tempora a tempora, com labio saliente)
  bloco(M_CHASSI, 0, 0, 1.691, -0.092, 0.176, 0.094, 0.020, null,
    cVisor, 0.58, ['cabeca'], 6, 0.20);

  C.pincel(0, P.emiOptica);
  const fendaLarg = P.classe === 'batedor' ? 0.134 : 0.154;
  const fendaAlt = P.classe === 'batedor' ? 0.038 : 0.046;
  C.caixa(0, 1.691, -0.104, fendaLarg, fendaAlt, 0.016, null, cOptica, R_LUZ, ['cabeca'], 6, 0.28);
  // as pontas dobram para a tempora: de perfil a maquina continua acesa
  for (const s of [1, -1]) {
    C.caixa(s * 0.071, 1.691, -0.064, 0.019, fendaAlt * 0.85, 0.052, [0, s * 0.62, 0],
      cOptica, R_LUZ, ['cabeca'], 6, 0.30);
  }
  C.pincel(0, 0);

  // mandibula/queixo blindado
  bloco(M_PLACA, 0, 0, 1.630, -0.094, 0.080, 0.044, 0.038, [-0.22, 0, 0],
    cPlaca, R_PLACA, ['cabeca'], 6, 0.25);

  if (P.sobrancelha) {
    // aba/capuz sobre a fenda — deixa o pesado com cara de carranca
    bloco(M_PLACA, 0, 0, 1.722, -0.108, 0.172, 0.026, 0.056, [0.30, 0, 0],
      cPlaca, R_PLACA, ['cabeca'], 6, 0.22);
  }
  if (P.olhosDuplos) {
    C.pincel(0, P.emiOptica * 0.75);
    for (const s of [1, -1]) {
      C.caixa(s * 0.044, 1.724, -0.136, 0.020, 0.012, 0.010, null, cOptica, R_LUZ, ['cabeca'], 6, 0.30);
    }
    C.pincel(0, 0);
  }
  if (P.antena) {
    tubo([0.030, 1.778, 0.042], [0.050, 1.958, 0.078], 0.007, 0.003,
      cPistao, R_PIST, M_PIST, ['cabeca'], 5);
    bloco(0, 2.0, 0.050, 1.964, 0.078, 0.016, 0.016, 0.016, null,
      cSinal, R_LUZ, ['cabeca'], 6, 0.35);
  }

  /* -------------------------------------------------------------- bracos */
  for (const l of ['D', 'E']) {
    const s = l === 'D' ? 1 : -1;
    const oOmbro = posOsso(`ombro_${l}`), oCot = posOsso(`cotovelo_${l}`), oPun = posOsso(`punho_${l}`);
    const ob = ossosBraco(l);

    // eixo do ombro: preso a CLAVICULA (fica com o torso; o braco gira nele)
    pino(s * 0.178, 1.462, 0.004, 0.100, 0.056 * b, cJunta, R_JUNTA, M_JUNTA, `clavicula_${l}`, 9);

    // ombreira
    C.loft(aneisMembro([s * 0.138, 1.486, 0.000], [s * (0.150 + 0.100 * ro), 1.446, 0.004], [
      [0, 0.058 * b * ro, 0.066 * b * ro],
      [0.40, 0.082 * b * ro, 0.090 * b * ro],
      [0.82, 0.070 * b * ro, 0.078 * b * ro],
      [1.0, 0.032 * b * ro, 0.038 * b * ro],
    ], cPlaca, R_PLACA, 0.55), {
      lados: 10, ossos: [`ombro_${l}`], expo: 5, tampaA: true, tampaB: true, rug: R_PLACA, met: M_PLACA,
    });

    // braco
    C.loft(aneisMembro(oOmbro, oCot, [
      [0.16, 0.052 * b, 0.056 * b], [0.45, 0.048 * b, 0.052 * b],
      [0.80, 0.044 * b, 0.047 * b], [1.0, 0.040 * b, 0.043 * b],
    ], cCasco, R_CASCO, 0.60), { lados: 8, ossos: ob, expo: 3.4, tampaA: true, rug: R_CASCO, met: M_CASCO });

    // atuador do braco (haste cromada por tras)
    tubo(entre(oOmbro, oCot, 0.28, s * 0.010, 0, 0.052), entre(oOmbro, oCot, 0.95, s * 0.006, 0, 0.046),
      0.014, 0.011, cPistao, R_PIST, M_PIST, [`ombro_${l}`, `cotovelo_${l}`], 6);

    // cotovelo: junta exposta + eixo passante
    pino(oCot[0], oCot[1], oCot[2], 0.086, 0.044 * b, cJunta, R_JUNTA, M_JUNTA, `ombro_${l}`, 9);
    pino(oCot[0], oCot[1], oCot[2], 0.108, 0.019, cPistao, R_PIST, M_PIST, `ombro_${l}`, 6);

    // antebraco
    C.loft(aneisMembro(oCot, oPun, [
      [0.10, 0.046 * b, 0.050 * b], [0.42, 0.045 * b, 0.048 * b],
      [0.78, 0.038 * b, 0.040 * b], [1.0, 0.032 * b, 0.034 * b],
    ], cCasco, R_CASCO, 0.60), { lados: 8, ossos: ob, expo: 3.4, rug: R_CASCO, met: M_CASCO });

    // placa do antebraco
    const mAnte = entre(oCot, oPun, 0.5, s * 0.004, 0, -0.044);
    bloco(M_PLACA, 0, mAnte[0], mAnte[1], mAnte[2], 0.068 * b, 0.168, 0.026, [0.08, 0, 0],
      cPlaca, R_PLACA, [`cotovelo_${l}`, `punho_${l}`], 4, 0.22);

    // mao: manopla de chassi + polegar usinado (mesmo volume da mao antiga,
    // senao a IK da arma deixa de encaixar)
    const dirAnte = [oPun[0] - oCot[0], oPun[1] - oCot[1], oPun[2] - oCot[2]];
    const La = Math.hypot(dirAnte[0], dirAnte[1], dirAnte[2]);
    const pontaMao = [
      oPun[0] + dirAnte[0] / La * 0.098, oPun[1] + dirAnte[1] / La * 0.098, oPun[2] + dirAnte[2] / La * 0.098,
    ];
    C.loft(aneisMembro(oPun, pontaMao, [
      [0, 0.032, 0.035], [0.30, 0.042, 0.031], [0.80, 0.040, 0.027], [1.0, 0.024, 0.020],
    ], cChassi, 0.74, 0.50), {
      lados: 6, ossos: ossosMao(l), expo: 5, tampaA: true, tampaB: true, rug: 0.74, met: 0.28,
    });
    bloco(M_JUNTA, 0, oPun[0] - s * 0.030, oPun[1] - 0.038, oPun[2] - 0.006, 0.022, 0.048, 0.026,
      [0, 0, s * 0.5], cJunta, R_JUNTA, ossosMao(l), 5, 0.30);
  }

  /* -------------------------------------------------------------- pernas */
  for (const l of ['D', 'E']) {
    const s = l === 'D' ? 1 : -1;
    const oQ = posOsso(`perna_${l}`), oJ = posOsso(`joelho_${l}`), oT = posOsso(`tornozelo_${l}`);
    const op = ossosPerna(l);

    // eixo do quadril: preso a PELVE, a coxa gira nele
    pino(oQ[0], oQ[1], oQ[2] + 0.004, 0.088, 0.058 * b, cJunta, R_JUNTA, M_JUNTA, 'quadril', 9);

    // coxa
    C.loft(aneisMembro(oQ, oJ, [
      [-0.02, 0.082 * b, 0.088 * b], [0.18, 0.090 * b, 0.096 * b], [0.52, 0.082 * b, 0.088 * b],
      [0.82, 0.074 * b, 0.079 * b], [1.0, 0.068 * b, 0.073 * b],
    ], cCasco, R_CASCO, 0.55), { lados: 9, ossos: op, expo: 3.0, tampaA: true, rug: R_CASCO, met: M_CASCO });

    // placa lateral da coxa
    bloco(M_PLACA, 0, oQ[0] + s * 0.082 * b, 0.740, 0.004, 0.030, 0.200, 0.140, [0, 0, -s * 0.05],
      cPlaca, R_PLACA, [`perna_${l}`, `joelho_${l}`], 4, 0.18);

    // atuador frontal da coxa
    tubo([oQ[0] - s * 0.006, oQ[1] - 0.075, oQ[2] - 0.080], [oJ[0] - s * 0.004, oJ[1] + 0.090, oJ[2] - 0.064],
      0.016, 0.013, cPistao, R_PIST, M_PIST, [`perna_${l}`, `joelho_${l}`], 6);

    // joelho: junta exposta + eixo + rotula blindada
    pino(oJ[0], oJ[1], oJ[2], 0.092, 0.052 * b, cJunta, R_JUNTA, M_JUNTA, `perna_${l}`, 9);
    pino(oJ[0], oJ[1], oJ[2], 0.114, 0.021, cPistao, R_PIST, M_PIST, `perna_${l}`, 6);
    bloco(M_PLACA, 0, oJ[0], oJ[1] + 0.012, oJ[2] - 0.062, 0.088 * b, 0.108, 0.044, [0.05, 0, 0],
      cPlaca, R_PLACA, [`joelho_${l}`], 5, 0.28);

    // canela
    C.loft(aneisMembro(oJ, oT, [
      [0.02, 0.066 * b, 0.072 * b], [0.26, 0.072 * b, 0.078 * b],
      [0.62, 0.058 * b, 0.062 * b], [1.0, 0.044 * b, 0.048 * b],
    ], cCasco, R_CASCO, 0.55), { lados: 9, ossos: [...op, `pe_${l}`], expo: 3.0, rug: R_CASCO, met: M_CASCO });

    // caneleira
    bloco(M_PLACA, 0, oT[0], 0.300, -0.048, 0.078 * b, 0.248, 0.034, [-0.05, 0, 0],
      cPlaca, R_PLACA, [`joelho_${l}`, `tornozelo_${l}`], 4, 0.20);

    // atuador da panturrilha
    tubo([oJ[0], oJ[1] - 0.055, oJ[2] + 0.062], [oT[0], oT[1] + 0.120, oT[2] + 0.036],
      0.015, 0.012, cPistao, R_PIST, M_PIST, [`joelho_${l}`, `tornozelo_${l}`], 6);

    // tornozelo
    pino(oT[0], oT[1] + 0.010, oT[2] - 0.004, 0.072, 0.036 * b, cJunta, R_JUNTA, M_JUNTA, `tornozelo_${l}`, 8);

    // pe blindado (secao no plano XY, empilhada em Z)
    const pePos = posOsso(`pe_${l}`);
    C.loft([
      { c: [pePos[0], 0.090, 0.068], u: EIXO_X, v: [0, 1, 0], rx: 0.050 * b, ry: 0.050, exp: 0.50, cor: cCasco, rug: R_CASCO },
      { c: [pePos[0], 0.066, 0.010], u: EIXO_X, v: [0, 1, 0], rx: 0.056 * b, ry: 0.060, exp: 0.45, cor: cCasco, rug: R_CASCO },
      { c: [pePos[0], 0.052, -0.070], u: EIXO_X, v: [0, 1, 0], rx: 0.055 * b, ry: 0.048, exp: 0.45, cor: cCasco, rug: R_CASCO },
      { c: [pePos[0], 0.038, -0.135], u: EIXO_X, v: [0, 1, 0], rx: 0.046 * b, ry: 0.034, exp: 0.50, cor: cPlaca, rug: R_PLACA },
      { c: [pePos[0], 0.026, -0.164], u: EIXO_X, v: [0, 1, 0], rx: 0.030 * b, ry: 0.022, exp: 0.60, cor: cPlaca, rug: R_PLACA },
    ], { lados: 8, ossos: ossosPe(l), expo: 4, tampaA: true, tampaB: true, rug: R_CASCO, met: M_CASCO });

    // sola de borracha (unica coisa nao metalica da maquina)
    bloco(M_BORR, 0, pePos[0], 0.014, -0.042, 0.104 * b, 0.026, 0.230, null,
      cSola, R_BORR, ossosPe(l), 4, 0.16);
  }

  return C.paraGeometria();
}

/* ======================================================================== *
 * Arma (fuzil procedural simples — a arma "de verdade" e do PLAYER)
 * ======================================================================== */

/** Frente do fuzil = -Z. Origem no punho da pistola. */
function construirFuzil() {
  const C = new Construtor();
  const preto = rgb(0x232629), plast = rgb(0x2a2e31), metal = rgb(0x555d64);
  const ossos = ['quadril'];   // nao e skinado de verdade: 1 osso so, peso 1
  const R = 0.35;
  // A arma tambem e da fabrica da AGI: aco, nao polimero fosco.
  C.pincel(0.80, 0);

  // corpo/receiver
  C.caixa(0, 0.062, -0.055, 0.048, 0.086, 0.230, null, preto, R, ossos, 5, 0.14);
  // cano + guarda-mao
  C.loft(aneisMembro([0, 0.070, -0.168], [0, 0.070, -0.330],
    [[0, 0.032, 0.034], [0.85, 0.030, 0.032], [1, 0.026, 0.028]], plast, R),
  { lados: 7, ossos, expo: 3, tampaB: true, rug: R });
  C.loft(aneisMembro([0, 0.074, -0.320], [0, 0.074, -0.470],
    [[0, 0.011, 0.011], [1, 0.010, 0.010]], metal, 0.28),
  { lados: 6, ossos, expo: 3, tampaB: true, rug: 0.28 });
  // quebra-chamas
  C.loft(aneisMembro([0, 0.074, -0.462], [0, 0.074, -0.500],
    [[0, 0.017, 0.017], [1, 0.015, 0.015]], preto, 0.30),
  { lados: 6, ossos, expo: 3, tampaB: true, rug: 0.3 });
  // punho da pistola
  C.caixa(0, -0.012, 0.028, 0.036, 0.110, 0.048, [-0.32, 0, 0], plast, 0.55, ossos, 5, 0.22);
  // carregador curvo
  C.caixa(0, -0.028, -0.048, 0.030, 0.130, 0.062, [0.12, 0, 0], preto, R, ossos, 5, 0.16);
  // coronha
  C.caixa(0, 0.070, 0.100, 0.040, 0.070, 0.090, null, plast, 0.6, ossos, 5, 0.2);
  C.caixa(0, 0.062, 0.168, 0.046, 0.100, 0.052, [-0.06, 0, 0], plast, 0.6, ossos, 5, 0.2);
  // trilho e alca de mira
  C.caixa(0, 0.112, -0.090, 0.024, 0.014, 0.190, null, preto, 0.30, ossos, 5, 0.2);
  C.caixa(0, 0.132, -0.020, 0.020, 0.030, 0.026, null, preto, 0.30, ossos, 5, 0.25);
  C.caixa(0, 0.132, -0.300, 0.016, 0.032, 0.016, null, preto, 0.30, ossos, 5, 0.25);
  // guarda-mato
  C.caixa(0, 0.008, -0.004, 0.020, 0.012, 0.060, null, preto, R, ossos, 5, 0.2);
  // indicador de carga: o mesmo ciano da optica, para a arma pertencer a maquina
  C.pincel(0, 2.0);
  C.caixa(0.025, 0.086, 0.010, 0.006, 0.010, 0.052, null, rgb(0x1fcdff), 0.30, ossos, 5, 0.3);
  C.pincel(0, 0);

  const g = C.paraGeometria();
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  return g;
}

/* ======================================================================== *
 * Material
 * ======================================================================== */

let _matCache = null;

/**
 * Ganho do IBL (reflexo do ceu) SO da maquina — o que deveria ser
 * `material.envMapIntensity` e nao e.
 *
 * MEDIDO (tools/roboCor.mjs, pleno sol, 5 m): pondo `envMapIntensity = 0` no
 * material do robo, a cor do pixel NAO muda um unico ponto; pondo
 * `scene.environment = null`, ela cai 40%. O motivo esta no three r180,
 * WebGLRenderer.setProgram:
 *
 *     if ( material.isMeshStandardMaterial && material.envMap === null
 *          && scene.environment !== null )
 *         m_uniforms.envMapIntensity.value = scene.environmentIntensity;
 *
 * Ou seja: todo MeshStandardMaterial que depende do `scene.environment` (em vez
 * de ter envMap proprio) tem o seu envMapIntensity SOBRESCRITO, a cada quadro,
 * pelo da cena — que aqui vale 2.8 (Lighting.envIntensity). Nao ha ajuste por
 * material possivel por essa via.
 *
 * A saida esta na PROPRIA condicao: basta o material ter um envMap seu. Damos
 * a ele o mesmo mapa que a cena usa (`sincronizarIBL`, chamada no update) e
 * pomos `envMapIntensity = ENV_ROBO * scene.environmentIntensity`. O three para
 * de sobrescrever, o valor vale, e o shader nao ganha NENHUMA instrucao nova.
 * 0.30 x 2.8 = 0.84 de ambiente efetivo — perto do 0.75 em que o estudio foi
 * calibrado, e coerente com o 0.65-0.75 que o modulo PLAYER usa no metal da arma.
 *
 * As duas alternativas obvias foram medidas e descartadas por CUSTO, nao por
 * gosto (tools/roboFps.mjs, 9 maquinas ocupando ~30% do quadro):
 *   - `radiance *= k; iblIrradiance *= k;` depois de <lights_fragment_maps>:
 *     duas multiplicacoes de vec3 por fragmento = +0.44 ms/quadro;
 *   - dosar dentro do chunk do IBL (multiplicacao escalar): +0.24 ms/quadro.
 * O rasterizador do ambiente de teste e por software, entao instrucao por
 * fragmento aparece na conta; este caminho custa zero instrucoes e encerra a
 * discussao nos dois mundos.
 */
const ENV_ROBO = 0.30;

/**
 * Faz o material apontar para o mapa de ambiente da cena. Tem de rodar todo
 * quadro porque o Lighting REGERA o PMREM quando o ceu muda (`_regenerateEnvironment`
 * cria um render target novo e troca `scene.environment`); sem re-sincronizar,
 * a maquina continuaria refletindo um ceu velho.
 *
 * `needsUpdate` so na primeira vez — dali em diante a troca de textura e so
 * atualizacao de uniform, sem recompilar programa.
 */
function sincronizarIBL(ctx) {
  const m = _matCache;
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

function materialSoldado() {
  if (_matCache) return _matCache;
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    // valor real e escrito por sincronizarIBL a cada quadro (ENV_ROBO x o da
    // cena). Nasce em 1.0 so para o Lighting.registerMaterial nao reclamar.
    envMapIntensity: 1.0,
    name: 'ai_soldado',
  });
  /*
   * Tres canais por vertice num material so (1 draw call para o robo inteiro):
   *   rugAttr -> rugosidade  (chapa jateada 0.80, junta usinada 0.42, borracha 0.96)
   *   metAttr -> metalicidade (placa 0.58, chassi 0.18, optica 0)
   *   emiAttr -> ganho de emissao; a COR emitida e a propria cor do vertice.
   *
   * A fenda optica usa emiAttr bem acima de 1: em luz de dia ela nao pode
   * depender de "estourar o limiar do bloom" (PostFX.bloomThreshold = 1.05),
   * porque o ceu tambem o estoura. Ela precisa ganhar do METAL AO LADO DELA.
   * Uma PointLight por inimigo esta fora de cogitacao: recompilaria os
   * materiais da cena inteira a cada spawn.
   *
   * Definido ANTES de qualquer objeto entrar na cena, como pede o NOTES do CORE.
   */
  /* Os botoes de calibracao (ganho de albedo, escala de rugosidade/
   * metalicidade, ganho de emissao) existiram enquanto o material era medido
   * em jogo e ja foram ASSADOS nas constantes de acabamento e nas PALETAS:
   * medidos, custavam 0.66 ms/quadro com 9 maquinas — 6% do quadro, regressao
   * que nao se paga por conforto de ajuste. Para uma nova rodada de calibracao,
   * basta reintroduzi-los aqui temporariamente (ver tools/roboCor.mjs).
   *
   * O que sobrou sao os tres canais por vertice — nem uma instrucao a mais que
   * a versao anterior. A dosagem do IBL nao passa pelo shader: ver ENV_ROBO. */
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float rugAttr;\nattribute float metAttr;\nattribute float emiAttr;\n'
        + 'varying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvRug = rugAttr;\n\tvMet = metAttr;\n\tvEmi = emiAttr;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(vRug, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n\tmetalnessFactor = clamp(vMet, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * vEmi;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>');
  };
  m.customProgramCacheKey = () => 'ai_soldado_rug_met_emi';
  _matCache = m;
  return m;
}

/* ======================================================================== *
 * Recursos por variante (geometria compartilhada)
 * ======================================================================== */

const _recursos = new Map();

function recursos(variante) {
  const chave = variante % PALETAS.length;
  let r = _recursos.get(chave);
  if (r) return r;
  const geo = construirCorpo(chave, chave * 7919 + 13);
  const geoArma = construirFuzil();
  const boneInverses = DEF_OSSOS.map((d) => new THREE.Matrix4().makeTranslation(-d[2], -d[3], -d[4]));
  const tris = geo.index.count / 3;
  r = { geo, geoArma, boneInverses, material: materialSoldado(), tris, trisArma: geoArma.index.count / 3 };
  _recursos.set(chave, r);
  return r;
}

/* ======================================================================== *
 * Matematica de pose
 * ======================================================================== */

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _cotovelo = new THREE.Vector3();
// Exclusivas de _resolverBraco: ik2() clobbera _v1/_v2 e nao podem ser usadas la.
const _ombroPos = new THREE.Vector3();
const _alvoIK = new THREE.Vector3();
const _poloIK = new THREE.Vector3();

/** IK de duas barras. Escreve a articulacao do meio em `out`. */
function ik2(raiz, alvo, l1, l2, polo, out) {
  _v1.subVectors(alvo, raiz);
  let dist = _v1.length();
  const max = (l1 + l2) * 0.998;
  const min = Math.abs(l1 - l2) * 1.02 + 1e-3;
  if (dist > max) dist = max;
  if (dist < min) dist = min;
  if (dist < 1e-5) dist = 1e-5;
  _v1.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _v2.copy(polo).addScaledVector(_v1, -polo.dot(_v1));
  if (_v2.lengthSq() < 1e-8) _v2.set(0, 1, 0).addScaledVector(_v1, -_v1.y);
  _v2.normalize();
  out.copy(raiz).addScaledVector(_v1, a).addScaledVector(_v2, h);
  return dist;
}

function suave(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ======================================================================== *
 * Soldier
 * ======================================================================== */

export class Soldier {
  /**
   * @param {object} ctx GameContext (pode ser parcial em teste)
   * @param {object} opts {variante, escala}
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.variante = opts.variante ?? 0;
    const rec = recursos(this.variante);
    this.rec = rec;

    this.grupo = new THREE.Group();
    this.grupo.name = 'soldado';
    const escala = opts.escala ?? 1;
    this.grupo.scale.setScalar(escala);
    this.altura = 1.80 * escala;

    // ossos
    this.ossos = [];
    this.porNome = {};
    for (const [nome, pai, x, y, z] of DEF_OSSOS) {
      const b = new THREE.Bone();
      b.name = nome;
      if (pai) {
        const p = this.porNome[pai];
        b.position.set(x - p.position.x - (p.userData.absY !== undefined ? 0 : 0), 0, 0);
        // posicao local = delta absoluto (bind com rotacoes identidade)
        b.position.set(x - p.userData.abs[0], y - p.userData.abs[1], z - p.userData.abs[2]);
        p.add(b);
      } else {
        b.position.set(x, y, z);
        this.grupo.add(b);
      }
      b.userData.abs = [x, y, z];
      b.userData.rest = b.position.clone();
      this.ossos.push(b);
      this.porNome[nome] = b;
    }

    this.esqueleto = new THREE.Skeleton(this.ossos, rec.boneInverses.map((m) => m.clone()));
    this.malha = new THREE.SkinnedMesh(rec.geo, rec.material);
    this.malha.name = 'soldado:corpo';
    this.malha.castShadow = true;
    this.malha.receiveShadow = true;
    this.malha.frustumCulled = false;
    this.grupo.add(this.malha);
    this.malha.bind(this.esqueleto, new THREE.Matrix4());

    // arma
    this.arma = new THREE.Mesh(rec.geoArma, rec.material);
    this.arma.name = 'soldado:arma';
    this.arma.castShadow = true;
    this.arma.frustumCulled = false;
    this.porNome.peito.add(this.arma);
    this.temArma = true;

    // ancoras da arma em espaco local da arma
    this.ancoras = {
      punhoD: new THREE.Vector3(0.0, -0.020, 0.030),
      punhoE: new THREE.Vector3(0.0, 0.048, -0.250),
      cano: new THREE.Vector3(0.0, 0.074, -0.505),
      ejecao: new THREE.Vector3(0.030, 0.082, -0.010),
    };

    // comprimentos para IK
    const pa = posOsso('ombro_D'), pb = posOsso('cotovelo_D'), pc = posOsso('punho_D');
    this.lBraco = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    this.lAntebraco = Math.hypot(pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]);
    this.dirBindBraco = { D: new THREE.Vector3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]).normalize() };
    this.dirBindAnte = { D: new THREE.Vector3(pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]).normalize() };
    const pa2 = posOsso('ombro_E'), pb2 = posOsso('cotovelo_E'), pc2 = posOsso('punho_E');
    this.dirBindBraco.E = new THREE.Vector3(pb2[0] - pa2[0], pb2[1] - pa2[1], pb2[2] - pa2[2]).normalize();
    this.dirBindAnte.E = new THREE.Vector3(pc2[0] - pb2[0], pc2[1] - pb2[1], pc2[2] - pb2[2]).normalize();
    this.dirBindMao = {
      D: new THREE.Vector3(PONTAS.punho_D[0] - pc[0], PONTAS.punho_D[1] - pc[1], PONTAS.punho_D[2] - pc[2]).normalize(),
      E: new THREE.Vector3(PONTAS.punho_E[0] - pc2[0], PONTAS.punho_E[1] - pc2[1], PONTAS.punho_E[2] - pc2[2]).normalize(),
    };
    this.normalBindBraco = {
      D: new THREE.Vector3().crossVectors(this.dirBindBraco.D, this.dirBindAnte.D).normalize(),
      E: new THREE.Vector3().crossVectors(this.dirBindBraco.E, this.dirBindAnte.E).normalize(),
    };
    // cotovelos praticamente retos no bind: usa uma normal de referencia estavel
    for (const l of ['D', 'E']) {
      if (this.normalBindBraco[l].lengthSq() < 0.02) this.normalBindBraco[l].set(l === 'D' ? 1 : -1, 0, 0.35).normalize();
    }

    // cinematica das pernas (comprimentos no plano sagital)
    const q = posOsso('perna_D'), j = posOsso('joelho_D'), t = posOsso('tornozelo_D');
    this.yQuadril = q[1];
    this.lCoxa = Math.hypot(j[1] - q[1], j[2] - q[2]);
    this.lCanela = Math.hypot(t[1] - j[1], t[2] - j[2]);
    this.alturaTornozelo = t[1];

    // ---------------------------------------------------------- estado
    this.est = {
      vel: 0, velX: 0, velZ: 0, agachado: 0, mirando: 0,
      fase: Math.random() * Math.PI * 2, corrida: 0,
      respiro: Math.random() * 6.28,
      alvo: new THREE.Vector3(0, 1.6, -10), temAlvo: false,
      pesoMaoE: 1, recarga: -1, duracaoRecarga: 2.3,
      recuo: 0, recuoVel: 0, flinch: 0, flinchVel: 0, flinchDir: 0,
      morto: false, ragdoll: null, tempo: 0,
      poseArma: 'pronto',
    };

    this._alvoMaoE = new THREE.Vector3();
    this._temp = new THREE.Vector3();
    this.qRaiz = new THREE.Quaternion();
    this.qRaizInv = new THREE.Quaternion();
    this._olho = new THREE.Vector3();
    this._olharDir = new THREE.Vector3(0, 0, -1);

    this._zerarPose();
  }

  get objeto() { return this.grupo; }
  get triangulos() { return this.rec.tris + this.rec.trisArma; }
  get nOssos() { return this.ossos.length; }

  _zerarPose() {
    for (const b of this.ossos) {
      b.position.copy(b.userData.rest);
      b.rotation.set(0, 0, 0);
      b.scale.set(1, 1, 1);
    }
  }

  /**
   * Ultima barreira contra NaN nos ossos.
   *
   * Um unico quaternion NaN manda para o infinito TODOS os vertices pesados
   * naquele osso e nos filhos dele. Como o tronco, os bracos e a cabeca pendem
   * de peito/pescoco e as pernas pendem do quadril, contaminar a cadeia
   * superior deixava literalmente um par de pernas andando sozinho — e, na
   * morte, semeava o Ragdoll inteiro com particulas NaN.
   *
   * Roda depois de montar a pose. Osso invalido volta para a pose de repouso.
   */
  _sanearOssos() {
    let ruins = 0, primeiro = null;

    /* A arma entra junto: ela nao e osso, mas `posCano()` deriva da matriz dela
     * e alimenta o `origin` do evento enemy:fire. Origem NaO-finita chegava na
     * WebAudio como frequencia de filtro e derrubava o handler do tiro. */
    const alvos = this.arma ? [...this.ossos, this.arma] : this.ossos;
    for (const b of alvos) {
      const q = b.quaternion, p = b.position;
      const ok = Number.isFinite(q.x + q.y + q.z + q.w)
        && Number.isFinite(p.x + p.y + p.z)
        && q.lengthSq() > 1e-12;
      if (ok) continue;
      ruins++;
      if (!primeiro) primeiro = b.name || '(arma)';
      b.quaternion.identity();
      // a arma nao tem pose de repouso guardada; volta para junto do peito
      if (b.userData.rest) b.position.copy(b.userData.rest);
      else b.position.set(0, 0.1, 0.1);
      b.scale.set(1, 1, 1);
    }
    if (ruins && !Soldier._avisouNaN) {
      Soldier._avisouNaN = true;
      console.warn(`[Soldier] ${ruins} osso(s) com transformacao invalida `
        + `(primeiro: ${primeiro}) — pose de repouso restaurada`);
    }
    return ruins;
  }

  // ------------------------------------------------------------ controles

  /** @param {number} vx velocidade lateral local, @param {number} vz frente (m/s) */
  setLocomocao(vx, vz, agachado) {
    this.est.velX = vx; this.est.velZ = vz;
    this.est.vel = Math.hypot(vx, vz);
    this.est.agachadoAlvo = agachado ? 1 : 0;
  }

  /** @param {THREE.Vector3|null} ponto ponto do mundo para onde olhar/mirar */
  setMira(ponto, peso = 1) {
    if (ponto) { this.est.alvo.copy(ponto); this.est.temAlvo = true; }
    else this.est.temAlvo = false;
    this.est.miraAlvo = clamp(peso, 0, 1);
  }

  setPoseArma(p) { this.est.poseArma = p; }

  dispararRecuo(forca = 1) { this.est.recuoVel += 9.5 * forca; }

  flinch(dirMundoX = 0, dirMundoZ = 0) {
    this.est.flinchVel += 8.0;
    this.est.flinchDir = Math.atan2(dirMundoX, dirMundoZ);
  }

  iniciarRecarga(dur = 2.3) { this.est.recarga = 0; this.est.duracaoRecarga = dur; }
  get recarregando() { return this.est.recarga >= 0; }

  morrer() { this.est.morto = true; }
  reviver() { this.est.morto = false; this.est.ragdoll = null; this._zerarPose(); }

  /** Posicao dos olhos no mundo (osso da cabeca + deslocamento facial). */
  posOlho(out = this._olho) {
    const c = this.porNome.cabeca;
    c.updateWorldMatrix(true, false);
    out.set(0, 0.072, -0.070).applyMatrix4(c.matrixWorld);
    return out;
  }

  /** Direcao do olhar (frente da cabeca) no mundo. */
  dirOlhar(out = this._olharDir) {
    const c = this.porNome.cabeca;
    c.getWorldQuaternion(_q1);
    return out.set(0, 0, -1).applyQuaternion(_q1);
  }

  /** Origem do cano no mundo. */
  posCano(out = new THREE.Vector3()) {
    this.arma.updateWorldMatrix(true, false);
    return out.copy(this.ancoras.cano).applyMatrix4(this.arma.matrixWorld);
  }

  /** Direcao do cano no mundo. */
  dirCano(out = new THREE.Vector3()) {
    this.arma.getWorldQuaternion(_q1);
    return out.set(0, 0, -1).applyQuaternion(_q1);
  }

  // ------------------------------------------------------------ update

  update(dt) {
    const S = this.est;
    S.tempo += dt;
    sincronizarIBL(this.ctx);
    if (S.morto && S.ragdoll) { S.ragdoll.aplicar(this); return; }

    // suavizacoes
    S.agachado = lerp(S.agachado, S.agachadoAlvo ?? 0, 1 - Math.exp(-9 * dt));
    S.mirando = lerp(S.mirando, S.miraAlvo ?? 0, 1 - Math.exp(-7 * dt));
    S.corrida = lerp(S.corrida, suave(2.1, 3.8, S.vel), 1 - Math.exp(-6 * dt));
    S.respiro += dt * 1.15;

    // mola do recuo e do flinch
    S.recuo += S.recuoVel * dt; S.recuoVel -= (S.recuo * 260 + S.recuoVel * 22) * dt;
    S.flinch += S.flinchVel * dt; S.flinchVel -= (S.flinch * 150 + S.flinchVel * 15) * dt;
    if (S.recarga >= 0) { S.recarga += dt; if (S.recarga > S.duracaoRecarga) S.recarga = -1; }

    this._zerarPose();
    const pose = this._pose || (this._pose = {});
    this._locomocao(dt, pose);
    this._postura(pose);
    this._aplicarPernasTorso(pose);

    // matrizes prontas para o IK e para a arma
    this.grupo.updateMatrixWorld(true);
    this.grupo.getWorldQuaternion(this.qRaiz);
    this.qRaizInv.copy(this.qRaiz).invert();

    this._olhar(pose);
    this.grupo.updateMatrixWorld(true);

    if (this.temArma) {
      this._posicionarArma(pose);
      this._bracosNaArma(dt, pose);
    } else {
      this._bracosLivres(pose);
    }

    // Barreira final: nenhum osso invalido pode chegar ao skinning nem, na
    // morte, semear o Ragdoll.
    this._sanearOssos();
    this.grupo.updateMatrixWorld(true);
  }

  // -------------------------------------------------------- camadas

  _locomocao(dt, pose) {
    const S = this.est;
    const andando = S.vel > 0.05;
    const compPasso = lerp(0.74, 1.42, S.corrida) * (1 - S.agachado * 0.35);
    const passosPorSeg = andando ? S.vel / compPasso : 0;
    if (andando) S.fase += Math.PI * passosPorSeg * dt;   // 1 ciclo = 2 passos
    else {
      // volta suave para a pose neutra (fase 0 = pernas juntas)
      const alvoFase = Math.round(S.fase / Math.PI) * Math.PI;
      S.fase = lerp(S.fase, alvoFase, 1 - Math.exp(-8 * dt));
    }
    if (S.fase > 1e6) S.fase -= 1e6;

    const intens = clamp(S.vel / 1.4, 0, 1);
    const ampQuadril = lerp(0.40, 0.78, S.corrida) * intens;
    const ampJoelho = lerp(0.85, 1.55, S.corrida) * intens;
    const baseJoelho = 0.09 + S.agachado * 1.15;
    const f = S.fase;

    for (const l of ['D', 'E']) {
      const fl = l === 'D' ? f : f + Math.PI;
      const q = ampQuadril * Math.sin(fl) + S.agachado * 0.92;
      // flexao do joelho: pico grande no balanco (fl~0) + pequeno na recepcao
      const balanco = Math.pow(Math.max(0, Math.cos(fl)), 1.6) * ampJoelho;
      const recepcao = Math.pow(Math.max(0, Math.sin(fl - 0.3)), 2) * 0.20 * intens;
      const k = baseJoelho + balanco + recepcao;
      // tornozelo: mantem o pe plano + impulso na saida e dorsiflexao na entrada
      const impulso = -Math.pow(Math.max(0, Math.sin(fl - 4.0)), 2) * 0.55 * intens;
      const entrada = Math.pow(Math.max(0, Math.sin(fl - 1.5)), 2) * 0.24 * intens;
      const t = clamp(-(q - k) * 0.85 + impulso + entrada - S.agachado * 0.35, -0.85, 0.75);
      pose[`q${l}`] = q; pose[`k${l}`] = k; pose[`t${l}`] = t;
      // abducao leve para o passo nao cruzar
      pose[`ab${l}`] = (l === 'D' ? 1 : -1) * (0.03 + 0.03 * intens);
    }

    // contra-rotacao: quadril e ombro giram em sentidos opostos
    const torcao = lerp(0.10, 0.26, S.corrida) * intens;
    pose.quadrilYaw = -torcao * Math.sin(f);
    pose.peitoYaw = torcao * 1.15 * Math.sin(f);
    pose.quadrilRoll = 0.06 * intens * Math.sin(f);
    pose.peitoRoll = -0.05 * intens * Math.sin(f);
    pose.lean = lerp(0.02, 0.20, S.corrida) * intens + S.agachado * 0.16;
    pose.balancoLateral = 0.024 * intens * Math.sin(f);
    pose.faseLoco = f;
    pose.intens = intens;
  }

  _postura(pose) {
    const S = this.est;
    // respiracao: peito sobe/desce, ombros acompanham
    const resp = Math.sin(S.respiro) * (0.010 + 0.012 * (1 - S.mirando));
    pose.respiro = resp;

    // altura do quadril por cinematica direta: o pe mais baixo encosta no chao
    const alturaPe = (q, k) => this.yQuadril
      - this.lCoxa * Math.cos(q)
      - this.lCanela * Math.cos(q - k)
      - this.alturaTornozelo;
    const pD = alturaPe(pose.qD, pose.kD), pE = alturaPe(pose.qE, pose.kE);
    let baixo = Math.min(pD, pE);
    // no ar (corrida) permite os dois pes saindo do chao
    const voo = S.corrida * pose.intens * Math.pow(Math.max(0, Math.sin(pose.faseLoco * 2)), 2) * 0.045;
    pose.raizY = -baixo + voo;
    pose.raizX = pose.balancoLateral;
    pose.raizZ = 0;
  }

  _aplicarPernasTorso(pose) {
    const S = this.est;
    const B = this.porNome;
    const flinchAmp = S.flinch;

    B.quadril.position.set(
      B.quadril.userData.rest.x + pose.raizX,
      B.quadril.userData.rest.y + pose.raizY,
      B.quadril.userData.rest.z + pose.raizZ,
    );
    B.quadril.rotation.set(pose.lean * 0.25 + S.agachado * 0.10, pose.quadrilYaw, pose.quadrilRoll);

    const leanTotal = pose.lean;
    B.coluna1.rotation.set(leanTotal * 0.30 + pose.respiro * 0.4, pose.quadrilYaw * -0.3, 0);
    B.coluna2.rotation.set(leanTotal * 0.30 + pose.respiro * 0.5, pose.peitoYaw * 0.45, pose.peitoRoll * 0.5);
    B.peito.rotation.set(
      leanTotal * 0.28 - pose.respiro * 0.6 - flinchAmp * 0.55 * Math.cos(S.flinchDir),
      pose.peitoYaw * 0.55 + flinchAmp * 0.25 * Math.sin(S.flinchDir),
      pose.peitoRoll * 0.5,
    );

    for (const l of ['D', 'E']) {
      B[`perna_${l}`].rotation.set(pose[`q${l}`], 0, pose[`ab${l}`]);
      B[`joelho_${l}`].rotation.set(-pose[`k${l}`], 0, 0);
      B[`tornozelo_${l}`].rotation.set(pose[`t${l}`], 0, 0);
    }
  }

  /** Look-at ponderado: cabeca puxa mais, peito acompanha, coluna completa. */
  _olhar(pose) {
    const S = this.est;
    const B = this.porNome;
    if (!S.temAlvo) {
      // olhada de patrulha: varre devagar
      const varre = Math.sin(S.tempo * 0.42) * 0.34 + Math.sin(S.tempo * 0.17) * 0.16;
      B.pescoco.rotation.y += varre * 0.4;
      B.cabeca.rotation.y += varre * 0.6;
      B.cabeca.rotation.x += Math.sin(S.tempo * 0.31) * 0.06;
      return;
    }
    // direcao no espaco do personagem
    _v3.copy(S.alvo);
    this.grupo.worldToLocal(_v3);
    _v4.copy(_v3).sub(_v5.set(0, 1.52, 0));
    const L = _v4.length() || 1;
    _v4.multiplyScalar(1 / L);
    let yaw = Math.atan2(-_v4.x, -_v4.z);
    let pitch = Math.asin(clamp(_v4.y, -1, 1));
    // normaliza para (-pi, pi]
    while (yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw < -Math.PI) yaw += Math.PI * 2;

    const peso = 0.35 + 0.65 * S.mirando;
    yaw *= peso; pitch *= peso;

    const yc = clamp(yaw * 0.42, -0.95, 0.95);
    const yp = clamp(yaw * 0.30, -0.55, 0.55);
    const y2 = clamp(yaw * 0.18, -0.35, 0.35);
    const y1 = clamp(yaw * 0.10, -0.25, 0.25);

    B.coluna1.rotation.y += y1;
    B.coluna2.rotation.y += y2;
    B.peito.rotation.y += yp;
    B.pescoco.rotation.y += yc * 0.35;
    B.cabeca.rotation.y += yc * 0.65;

    const pc = clamp(pitch, -0.9, 0.7);
    B.peito.rotation.x -= pc * 0.28;
    B.pescoco.rotation.x -= pc * 0.22;
    B.cabeca.rotation.x -= pc * 0.50;

    pose.yawMira = yaw; pose.pitchMira = pitch;
  }

  /** Coloca a arma em espaco do peito, conforme a pose de porte. */
  _posicionarArma(pose) {
    const S = this.est;
    const peito = this.porNome.peito;

    // pose alvo em espaco do personagem
    let px, py, pz, rx, ry, rz;
    const mira = S.mirando;
    const sprint = S.corrida * (1 - mira) * clamp(S.vel / 3.2, 0, 1);

    // "pronto baixo"
    px = 0.075; py = 1.290; pz = -0.150;
    rx = -0.42; ry = 0.20; rz = 0.10;

    // mirando: encosta a coronha no ombro, cano no eixo do olho
    px = lerp(px, 0.052, mira); py = lerp(py, 1.455, mira); pz = lerp(pz, -0.190, mira);
    rx = lerp(rx, 0, mira); ry = lerp(ry, 0.03, mira); rz = lerp(rz, 0, mira);

    // correndo: arma cruzada e baixa
    px = lerp(px, 0.115, sprint); py = lerp(py, 1.160, sprint); pz = lerp(pz, -0.060, sprint);
    rx = lerp(rx, -0.85, sprint); ry = lerp(ry, 0.55, sprint); rz = lerp(rz, 0.30, sprint);

    // pitch de mira
    const pitch = pose.pitchMira || 0;
    rx += pitch * mira;
    // recuo: sobe o cano e empurra para tras
    rx -= S.recuo * 0.55;
    pz += S.recuo * 0.045;

    // recarga: inclina a arma para o lado do corpo
    if (S.recarga >= 0) {
      const t = S.recarga / S.duracaoRecarga;
      const k = Math.sin(clamp(t, 0, 1) * Math.PI);
      rz += k * 0.55; ry += k * 0.22; rx += k * 0.18;
      px += k * -0.02; py += k * -0.06;
    }

    _v1.set(px, py, pz);
    _e1.set(rx, ry, rz, 'YXZ');
    _q1.setFromEuler(_e1);

    // converte de espaco do personagem para espaco do osso do peito
    peito.updateWorldMatrix(true, false);
    _v1.applyMatrix4(this.grupo.matrixWorld);
    peito.worldToLocal(_v1);
    this.arma.position.copy(_v1);

    peito.getWorldQuaternion(_q2);
    _q3.copy(this.qRaiz).multiply(_q1);           // desejado no mundo
    _q2.invert().multiply(_q3);
    this.arma.quaternion.copy(_q2);
    this.arma.updateMatrixWorld(true);
  }

  /** Bracos travados nas empunhaduras da arma (IK de 2 barras + orientacao). */
  _bracosNaArma(dt, pose) {
    const S = this.est;
    // mao esquerda solta durante corrida forte e no meio da recarga
    let pesoE = 1;
    const sprint = S.corrida * (1 - S.mirando) * clamp(S.vel / 3.2, 0, 1);
    pesoE *= 1 - clamp(sprint * 1.4, 0, 1);
    if (S.recarga >= 0) {
      const t = S.recarga / S.duracaoRecarga;
      pesoE *= (t < 0.10) ? 1 - t / 0.10 : (t > 0.86 ? (t - 0.86) / 0.14 : 0);
    }
    S.pesoMaoE = lerp(S.pesoMaoE, pesoE, 1 - Math.exp(-14 * dt));

    // mao direita: sempre no punho da pistola
    _v4.copy(this.ancoras.punhoD).applyMatrix4(this.arma.matrixWorld);
    this._resolverBraco('D', _v4, 1);

    /* mao esquerda: guarda-mao, ou trajetoria da recarga, ou balanco livre.
     *
     * `_v5` e um temporario de MODULO declarado com const — atribuir null nele
     * lancava "Assignment to constant variable" a cada quadro. A excecao subia
     * por Enemy.update -> AIManager.update -> Game.frame sem ser capturada e
     * abortava o frame ANTES do render, congelando a tela. Usamos uma flag. */
    let usarMaoE = true;
    _v5.copy(this.ancoras.punhoE).applyMatrix4(this.arma.matrixWorld);
    if (S.recarga >= 0 && S.pesoMaoE < 0.98) {
      this._alvoRecarga(S.recarga / S.duracaoRecarga, _v6);
      _v5.lerp(_v6, 1 - S.pesoMaoE);
    } else if (S.pesoMaoE < 0.98) {
      // braco livre balancando com o passo (contra-fase da perna esquerda)
      const amp = lerp(0.30, 0.72, S.corrida) * pose.intens;
      const ang = -amp * Math.sin(pose.faseLoco + Math.PI);
      this._bracoLivre('E', ang, 1 - S.pesoMaoE);
      usarMaoE = false;
    }
    if (usarMaoE) this._resolverBraco('E', _v5, S.pesoMaoE);

    // maos orientadas pela arma
    this._orientarMao('D', new THREE.Vector3(0.10, -0.92, 0.38));
    if (S.pesoMaoE > 0.4) this._orientarMao('E', new THREE.Vector3(-0.22, -0.55, -0.80));
  }

  /** Trajetoria da mao esquerda durante a recarga, em espaco do personagem. */
  _alvoRecarga(t, out) {
    // 0.10 solta -> 0.28 pega o carregador -> 0.45 puxa fora -> 0.62 cinto
    // -> 0.78 encaixa -> 0.88 alavanca -> 1.0 volta
    const pts = [
      [0.10, 0.10, 1.28, -0.22],
      [0.28, 0.06, 1.18, -0.16],
      [0.45, 0.10, 1.02, -0.13],
      [0.62, 0.14, 0.96, -0.10],
      [0.78, 0.07, 1.20, -0.17],
      [0.88, 0.02, 1.35, -0.06],
      [1.00, 0.06, 1.30, -0.20],
    ];
    let i = 0;
    while (i < pts.length - 1 && t > pts[i + 1][0]) i++;
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const k = b[0] > a[0] ? suave(a[0], b[0], t) : 0;
    out.set(lerp(a[1], b[1], k), lerp(a[2], b[2], k), lerp(a[3], b[3], k));
    out.applyMatrix4(this.grupo.matrixWorld);
    return out;
  }

  /**
   * IK do braco: resolve o cotovelo e escreve os quaternions locais de
   * ombro e cotovelo. Trabalha em espaco do mundo com as direcoes de bind
   * rotacionadas pela raiz.
   */
  _resolverBraco(l, alvoMundo, peso) {
    if (peso <= 0.001) return;
    const B = this.porNome;
    const ombro = B[`ombro_${l}`], cot = B[`cotovelo_${l}`], pun = B[`punho_${l}`];
    ombro.updateWorldMatrix(true, false);

    /* ATENCAO: ik2() usa _v1 e _v2 internamente — as MESMAS temporarias de
     * modulo daqui. Guardar o ombro em _v1 e le-lo depois da chamada devolvia
     * uma direcao normalizada no lugar de uma posicao, e o braco era resolvido
     * a partir de um ponto sem sentido (bracos colapsados no tronco). Por isso
     * ombro e alvo ficam em temporarias exclusivas deste metodo. */
    _ombroPos.setFromMatrixPosition(ombro.matrixWorld);
    _alvoIK.copy(alvoMundo);

    // polo do cotovelo: para tras e para fora
    _poloIK.set(l === 'D' ? 0.55 : -0.55, -0.25, 0.80).applyQuaternion(this.qRaiz).normalize();
    ik2(_ombroPos, _alvoIK, this.lBraco, this.lAntebraco, _poloIK, _cotovelo);

    // direcoes desejadas
    _v3.subVectors(_cotovelo, _ombroPos).normalize();
    _v4.subVectors(_alvoIK, _cotovelo).normalize();
    _v5.crossVectors(_v3, _v4);
    if (_v5.lengthSq() < 1e-6) _v5.copy(_v2);
    _v5.normalize();

    // ombro
    _v6.copy(this.dirBindBraco[l]).applyQuaternion(this.qRaiz);
    _q1.setFromUnitVectors(_v6, _v3);
    // torcao para o plano de dobra bater
    _v6.copy(this.normalBindBraco[l]).applyQuaternion(this.qRaiz).applyQuaternion(_q1);
    _v6.addScaledVector(_v3, -_v6.dot(_v3));
    if (_v6.lengthSq() > 1e-8) {
      _v6.normalize();
      const cosA = clamp(_v6.dot(_v5), -1, 1);
      const sinA = _v6.clone().cross(_v5).dot(_v3);
      _q2.setFromAxisAngle(_v3, Math.atan2(sinA, cosA));
      _q1.premultiply(_q2);
    }
    ombro.parent.getWorldQuaternion(_q3);
    _q3.invert().multiply(_q1);
    if (peso >= 0.999) ombro.quaternion.copy(_q3);
    else ombro.quaternion.slerp(_q3, peso);
    ombro.updateMatrixWorld(true);

    // cotovelo
    _v6.copy(this.dirBindAnte[l]).applyQuaternion(this.qRaiz);
    _q1.setFromUnitVectors(_v6, _v4);
    cot.parent.getWorldQuaternion(_q3);
    _q3.invert().multiply(_q1);
    if (peso >= 0.999) cot.quaternion.copy(_q3);
    else cot.quaternion.slerp(_q3, peso);
    cot.updateMatrixWorld(true);
    void pun;
  }

  /** Balanco livre do braco (sem arma na mao). */
  _bracoLivre(l, ang, peso) {
    const B = this.porNome;
    const s = l === 'D' ? 1 : -1;
    const ombro = B[`ombro_${l}`], cot = B[`cotovelo_${l}`];
    _e1.set(ang, 0, s * (0.10 + Math.max(0, -ang) * 0.2), 'XYZ');
    _q1.setFromEuler(_e1);
    ombro.quaternion.slerp(_q1, peso);
    _e1.set(-0.25 - Math.max(0, ang) * 0.85, 0, 0, 'XYZ');
    _q1.setFromEuler(_e1);
    cot.quaternion.slerp(_q1, peso);
    ombro.updateMatrixWorld(true);
  }

  _bracosLivres(pose) {
    const amp = lerp(0.34, 0.80, this.est.corrida) * pose.intens;
    this._bracoLivre('D', -amp * Math.sin(pose.faseLoco), 1);
    this._bracoLivre('E', -amp * Math.sin(pose.faseLoco + Math.PI), 1);
  }

  /** Alinha a mao ao eixo pedido (em espaco da arma). */
  _orientarMao(l, dirLocalArma) {
    const pun = this.porNome[`punho_${l}`];
    this.arma.getWorldQuaternion(_q2);
    _v1.copy(dirLocalArma).normalize().applyQuaternion(_q2);
    _v2.copy(this.dirBindMao[l]).applyQuaternion(this.qRaiz);
    _q1.setFromUnitVectors(_v2, _v1);
    pun.parent.getWorldQuaternion(_q3);
    _q3.invert().multiply(_q1);
    pun.quaternion.copy(_q3);
  }

  // ------------------------------------------------------------ ragdoll

  /** Entrega o controle dos ossos ao ragdoll. */
  aoRagdoll(ragdoll) { this.est.ragdoll = ragdoll; this.est.morto = true; }

  dispose() {
    this.grupo.removeFromParent();
    this.esqueleto.dispose?.();
  }

  /** Libera geometrias/materiais compartilhados (chamado uma vez pelo manager). */
  static disposeRecursos() {
    for (const r of _recursos.values()) { r.geo.dispose(); r.geoArma.dispose(); }
    _recursos.clear();
    if (_matCache) { _matCache.dispose(); _matCache = null; }
  }

  static get nomesOssos() { return DEF_OSSOS.map((d) => d[0]); }
  static get defOssos() { return DEF_OSSOS; }
}

export default Soldier;
