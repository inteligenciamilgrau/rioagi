/**
 * Ragdoll — simulacao de corpo mole por integracao de Verlet.
 *
 * Por que Verlet e nao um solver de corpos rigidos: precisamos de queda
 * plausivel, nao de fisica correta. Verlet com restricoes de distancia da
 * estabilidade de graca (sem matriz de massa, sem impulso explosivo) e roda em
 * ~15 particulas por corpo, o que permite varios mortos em cena sem custo.
 *
 * O contrato com o Soldier e um metodo so: `aplicar(soldier)` escreve as
 * rotacoes dos ossos a partir das posicoes das particulas.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _qOsso = new THREE.Quaternion();

const GRAVIDADE = -14.5;    // exagerado de proposito: 9.81 le como camera lenta
const AMORT = 0.986;        // amortecimento do ar
const ATRITO_SOLO = 0.62;   // perda de velocidade tangencial ao raspar no chao
const ITER_RESTRICAO = 7;   // iteracoes do solver por frame
const RAIO = 0.085;         // raio de colisao de cada particula

/**
 * Particulas simuladas. Um subconjunto do esqueleto: os ossos intermediarios
 * (clavicula, pescoco, pe) sao interpolados na hora de aplicar.
 */
const PARTICULAS = [
  'quadril', 'peito', 'cabeca',
  'ombro_D', 'cotovelo_D', 'punho_D',
  'ombro_E', 'cotovelo_E', 'punho_E',
  'perna_D', 'joelho_D', 'tornozelo_D',
  'perna_E', 'joelho_E', 'tornozelo_E',
];

/** Ligacoes rigidas [a, b, rigidez]. */
const LIGACOES = [
  ['quadril', 'peito', 1.0],
  ['peito', 'cabeca', 1.0],
  ['peito', 'ombro_D', 1.0], ['ombro_D', 'cotovelo_D', 1.0], ['cotovelo_D', 'punho_D', 1.0],
  ['peito', 'ombro_E', 1.0], ['ombro_E', 'cotovelo_E', 1.0], ['cotovelo_E', 'punho_E', 1.0],
  ['quadril', 'perna_D', 1.0], ['perna_D', 'joelho_D', 1.0], ['joelho_D', 'tornozelo_D', 1.0],
  ['quadril', 'perna_E', 1.0], ['perna_E', 'joelho_E', 1.0], ['joelho_E', 'tornozelo_E', 1.0],
  // Diagonais de sustentacao: impedem o tronco de dobrar como papel e os
  // ombros de colapsarem um dentro do outro.
  ['quadril', 'ombro_D', 0.55], ['quadril', 'ombro_E', 0.55],
  ['ombro_D', 'ombro_E', 0.75],
  ['perna_D', 'perna_E', 0.55],
  ['cabeca', 'ombro_D', 0.35], ['cabeca', 'ombro_E', 0.35],
  ['quadril', 'joelho_D', 0.20], ['quadril', 'joelho_E', 0.20],
];

/** Filho usado para orientar cada osso. null = herda a rotacao do pai. */
const ORIENTA = {
  quadril: 'peito',
  coluna1: 'peito', coluna2: 'peito', peito: 'cabeca',
  pescoco: 'cabeca', cabeca: null,
  clavicula_D: 'ombro_D', ombro_D: 'cotovelo_D', cotovelo_D: 'punho_D', punho_D: null,
  clavicula_E: 'ombro_E', ombro_E: 'cotovelo_E', cotovelo_E: 'punho_E', punho_E: null,
  perna_D: 'joelho_D', joelho_D: 'tornozelo_D', tornozelo_D: null, pe_D: null,
  perna_E: 'joelho_E', joelho_E: 'tornozelo_E', tornozelo_E: null, pe_E: null,
};

export class Ragdoll {
  /**
   * @param {object} ctx GameContext (usa ctx.world.collision se existir)
   * @param {Soldier} soldier corpo a congelar na pose atual
   */
  constructor(ctx, soldier) {
    this.ctx = ctx;
    this.ativo = true;
    this.tempoParado = 0;
    this.assentado = false;

    const n = PARTICULAS.length;
    this.idx = new Map();
    for (let i = 0; i < n; i++) this.idx.set(PARTICULAS[i], i);

    this.pos = new Float32Array(n * 3);
    this.ant = new Float32Array(n * 3);
    this._bom = new Float32Array(n * 3);   // ultima posicao finita conhecida
    this.travado = new Uint8Array(n);
    this._avisou = false;

    // Semeia com a pose atual do soldado (mundo), para a morte comecar
    // exatamente de onde a animacao parou — sem "pulo" de um frame.
    soldier.grupo.updateMatrixWorld(true);
    for (let i = 0; i < n; i++) {
      const osso = soldier.ossoPorNome?.(PARTICULAS[i]) ?? this._acharOsso(soldier, PARTICULAS[i]);
      if (osso) osso.getWorldPosition(_v);
      else _v.set(0, 1, 0).add(soldier.grupo.position);
      // Semente tem de ser finita: se o osso vier com matriz degenerada, cai
      // num ponto plausivel em vez de contaminar a simulacao inteira.
      if (!Number.isFinite(_v.x + _v.y + _v.z)) _v.copy(soldier.grupo.position).setY(soldier.grupo.position.y + 1);
      this.pos[i * 3] = this.ant[i * 3] = this._bom[i * 3] = _v.x;
      this.pos[i * 3 + 1] = this.ant[i * 3 + 1] = this._bom[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = this.ant[i * 3 + 2] = this._bom[i * 3 + 2] = _v.z;
    }

    // Comprimentos de repouso medidos da propria pose: o ragdoll herda as
    // proporcoes do modelo em vez de assumir uma tabela fixa.
    this.lig = LIGACOES.map(([a, b, k]) => {
      const ia = this.idx.get(a), ib = this.idx.get(b);
      const d = Math.hypot(
        this.pos[ia * 3] - this.pos[ib * 3],
        this.pos[ia * 3 + 1] - this.pos[ib * 3 + 1],
        this.pos[ia * 3 + 2] - this.pos[ib * 3 + 2],
      );
      return { ia, ib, len: d, k };
    });

    // Direcoes de repouso de cada osso, no espaco do pai. Usadas para converter
    // "para onde o osso aponta agora" em quaternion local.
    this.repouso = new Map();
    for (const [nome, alvo] of Object.entries(ORIENTA)) {
      if (!alvo) continue;
      const o = this._acharOsso(soldier, nome);
      const c = this._acharOsso(soldier, alvo);
      if (!o || !c) continue;
      // Na pose de repouso os ossos nao tem rotacao, entao a direcao local
      // e simplesmente a diferenca de posicao de repouso normalizada.
      _v.copy(c.position);
      if (c.parent !== o) {
        // alvo nao e filho direto: usa a posicao acumulada aproximada
        c.getWorldPosition(_v);
        o.getWorldPosition(_v2);
        _v.sub(_v2);
        o.parent?.getWorldQuaternion(_q);
        _v.applyQuaternion(_qInv.copy(_q).invert());
      }
      if (_v.lengthSq() < 1e-9) continue;
      this.repouso.set(nome, _v.clone().normalize());
    }

    this._chao = new Map();  // cache de altura do chao por celula, evita raycast por frame
  }

  _acharOsso(soldier, nome) {
    if (soldier.osso && typeof soldier.osso === 'function') return soldier.osso(nome);
    if (soldier.ossosPorNome instanceof Map) return soldier.ossosPorNome.get(nome);
    return soldier.ossos?.find?.((b) => b.name === nome) ?? null;
  }

  /** Empurrao inicial — direcao do tiro que matou. */
  impulso(dir, forca = 1, alvo = 'peito') {
    const i = this.idx.get(alvo) ?? this.idx.get('peito');
    const f = forca * 0.06;
    this.ant[i * 3] -= dir.x * f;
    this.ant[i * 3 + 1] -= dir.y * f * 0.5;
    this.ant[i * 3 + 2] -= dir.z * f;
    // Um pouco no quadril tambem, senao o torso gira e as pernas ficam plantadas.
    const j = this.idx.get('quadril');
    this.ant[j * 3] -= dir.x * f * 0.35;
    this.ant[j * 3 + 2] -= dir.z * f * 0.35;
  }

  /**
   * Detecta e conserta NaN nas particulas.
   *
   * Uma unica particula NaN contamina todas as restricoes ligadas a ela em uma
   * iteracao, e dai sobe para os ossos: o quaternion vira NaN, os vertices
   * pesados naquele osso saem do espaco visivel e o corpo some — na pratica o
   * jogador via so as pernas (que pesam no quadril, ainda finito) andando.
   * Em vez de deixar propagar, restauramos a particula da ultima posicao boa.
   */
  _sanear() {
    const p = this.pos, a = this.ant, bom = this._bom;
    let ruins = 0;
    for (let i = 0; i < PARTICULAS.length; i++) {
      const k = i * 3;
      if (Number.isFinite(p[k]) && Number.isFinite(p[k + 1]) && Number.isFinite(p[k + 2])) {
        bom[k] = p[k]; bom[k + 1] = p[k + 1]; bom[k + 2] = p[k + 2];
        continue;
      }
      ruins++;
      p[k] = bom[k]; p[k + 1] = bom[k + 1]; p[k + 2] = bom[k + 2];
      a[k] = bom[k]; a[k + 1] = bom[k + 1]; a[k + 2] = bom[k + 2];   // zera a velocidade
    }
    if (ruins && !this._avisou) {
      this._avisou = true;
      console.warn(`[Ragdoll] ${ruins} particula(s) viraram NaN e foram restauradas`);
    }
    return ruins;
  }

  update(dt) {
    if (!this.ativo || this.assentado) return;
    const h = Math.min(dt, 1 / 45);
    const n = PARTICULAS.length;
    const p = this.pos, a = this.ant;

    /* --- integracao de Verlet --- */
    let movimento = 0;
    for (let i = 0; i < n; i++) {
      if (this.travado[i]) continue;
      const k = i * 3;
      for (let c = 0; c < 3; c++) {
        const atual = p[k + c];
        let v = (atual - a[k + c]) * AMORT;
        if (c === 1) v += GRAVIDADE * h * h;
        a[k + c] = atual;
        p[k + c] = atual + v;
        movimento += v * v;
      }
    }

    /* --- restricoes --- */
    for (let it = 0; it < ITER_RESTRICAO; it++) {
      for (const L of this.lig) {
        const ka = L.ia * 3, kb = L.ib * 3;
        let dx = p[kb] - p[ka], dy = p[kb + 1] - p[ka + 1], dz = p[kb + 2] - p[ka + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) continue;
        const corr = ((d - L.len) / d) * 0.5 * L.k;
        dx *= corr; dy *= corr; dz *= corr;
        if (!this.travado[L.ia]) { p[ka] += dx; p[ka + 1] += dy; p[ka + 2] += dz; }
        if (!this.travado[L.ib]) { p[kb] -= dx; p[kb + 1] -= dy; p[kb + 2] -= dz; }
      }
      this._colidir();
    }
    this._sanear();

    /* --- deteccao de assentamento: para de simular quando parou de mexer --- */
    if (movimento < 1e-5) {
      this.tempoParado += dt;
      if (this.tempoParado > 0.6) this.assentado = true;
    } else {
      this.tempoParado = 0;
    }
  }

  /** Colisao com o mundo: chao por raycast + resposta simples de penetracao. */
  _colidir() {
    const col = this.ctx?.world?.collision;
    const n = PARTICULAS.length;
    const p = this.pos, a = this.ant;

    for (let i = 0; i < n; i++) {
      const k = i * 3;
      // altura do chao, cacheada por celula de 0.5m
      const cx = Math.round(p[k] * 2), cz = Math.round(p[k + 2] * 2);
      const chave = cx * 65536 + cz;
      let yChao = this._chao.get(chave);
      if (yChao === undefined) {
        yChao = -Infinity;
        if (col?.raycast) {
          _v.set(p[k], p[k + 1] + 2.2, p[k + 2]);
          _v2.set(0, -1, 0);
          const r = col.raycast(_v, _v2, 6);
          if (r?.hit) yChao = r.point.y;
        } else {
          yChao = 0;
        }
        this._chao.set(chave, yChao);
      }
      if (yChao === -Infinity) continue;

      const min = yChao + RAIO;
      if (p[k + 1] < min) {
        p[k + 1] = min;
        // atrito tangencial: sem isso o corpo desliza como no gelo
        a[k] += (p[k] - a[k]) * (1 - ATRITO_SOLO);
        a[k + 2] += (p[k + 2] - a[k + 2]) * (1 - ATRITO_SOLO);
        a[k + 1] = p[k + 1];   // mata o quique vertical
      }
    }
  }

  /**
   * Escreve as rotacoes dos ossos do soldado a partir das particulas.
   * Chamado pelo Soldier.update() quando ha ragdoll ativo.
   */
  aplicar(soldier) {
    const p = this.pos;
    const iq = this.idx.get('quadril') * 3;

    // Segunda barreira contra NaN: se o quadril nao for finito, nao escreve
    // nada e mantem a ultima pose boa. Melhor um corpo congelado do que um
    // corpo que desaparece.
    if (!Number.isFinite(p[iq] + p[iq + 1] + p[iq + 2])) return;

    // O grupo do soldado acompanha o quadril; os ossos passam a ser escritos
    // em espaco local relativo a ele.
    soldier.grupo.position.set(p[iq], p[iq + 1] - 0.98, p[iq + 2]);
    soldier.grupo.quaternion.identity();
    soldier.grupo.updateMatrixWorld(true);

    for (const [nome, alvo] of Object.entries(ORIENTA)) {
      if (!alvo) continue;
      const osso = this._acharOsso(soldier, nome);
      if (!osso) continue;
      const rest = this.repouso.get(nome);
      if (!rest) continue;

      const ia = this.idx.get(nome), ib = this.idx.get(alvo);
      if (ia === undefined || ib === undefined) continue;

      _dir.set(
        p[ib * 3] - p[ia * 3],
        p[ib * 3 + 1] - p[ia * 3 + 1],
        p[ib * 3 + 2] - p[ia * 3 + 2],
      );
      if (_dir.lengthSq() < 1e-8) continue;
      _dir.normalize();

      // leva a direcao do mundo para o espaco do pai
      if (osso.parent) {
        osso.parent.getWorldQuaternion(_q);
        // Quaternion do pai degenerado (matriz com escala zero) inverte para
        // NaN e contamina toda a cadeia abaixo. Pula em vez de propagar.
        if (!Number.isFinite(_q.x + _q.y + _q.z + _q.w) || _q.lengthSq() < 1e-12) continue;
        _dir.applyQuaternion(_qInv.copy(_q).invert());
      }
      if (!Number.isFinite(_dir.x + _dir.y + _dir.z)) continue;

      _qOsso.setFromUnitVectors(rest, _dir);
      if (!Number.isFinite(_qOsso.x + _qOsso.y + _qOsso.z + _qOsso.w)) continue;
      osso.quaternion.copy(_qOsso);
      osso.updateMatrixWorld(true);
    }
  }

  dispose() { this.ativo = false; this._chao.clear(); }
}

export default Ragdoll;
