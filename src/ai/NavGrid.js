/**
 * NavGrid — navegacao da IA sobre `world.navGrid`.
 *
 *   - A* com heap binario e arrays tipados reaproveitados (zero alocacao por busca).
 *   - Custo diagonal correto (sqrt2) e proibicao de "cortar quina".
 *   - Campo de distancia a parede (chanfro 3-4) usado como penalidade: o agente
 *     prefere o meio do beco em vez de raspar no muro.
 *   - Suavizacao por linha de visada (string pulling) com teste de corredor,
 *     nao so de celula central.
 *   - Fila de pedidos com throttle: no maximo N buscas por frame no mundo todo.
 *   - Cache LRU de caminhos por par de celulas (TTL curto).
 *
 * Dono: agente AI. Consome apenas o contrato de `world.navGrid`.
 */
import * as THREE from 'three';

const CUSTO_DIAG = Math.SQRT2;
const MAX_BUSCAS_FRAME = 4;          // teto pedido pelo contrato de performance
const DIST_MAX_PAREDE = 8;           // saturacao do campo de distancia (celulas)
const PESO_PAREDE = 2.2;             // quanto custa raspar no muro
const RAIO_CONFORTO = 2.6;           // celulas: abaixo disso ja penaliza
const DEGRAU_MAX = 0.52;             // m: diferenca de altura que o agente sobe
const CACHE_MAX = 48;
const CACHE_TTL = 4.0;               // s
const NOS_MAX = 9000;                // teto de expansao por busca

const _cel = { x: 0, z: 0 };
const _celB = { x: 0, z: 0 };

/* --------------------------------------------------------------- heap ---- */

class HeapBinario {
  constructor(cap = 2048) {
    this.idx = new Int32Array(cap);
    this.f = new Float32Array(cap);
    this.n = 0;
  }

  limpar() { this.n = 0; }

  _crescer() {
    const idx = new Int32Array(this.idx.length * 2);
    const f = new Float32Array(this.f.length * 2);
    idx.set(this.idx); f.set(this.f);
    this.idx = idx; this.f = f;
  }

  inserir(i, f) {
    if (this.n >= this.idx.length) this._crescer();
    let k = this.n++;
    this.idx[k] = i; this.f[k] = f;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[p] <= this.f[k]) break;
      const ti = this.idx[p], tf = this.f[p];
      this.idx[p] = this.idx[k]; this.f[p] = this.f[k];
      this.idx[k] = ti; this.f[k] = tf;
      k = p;
    }
  }

  remover() {
    const topo = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.f[0] = this.f[this.n];
      let k = 0;
      for (;;) {
        const e = k * 2 + 1, d = e + 1;
        let m = k;
        if (e < this.n && this.f[e] < this.f[m]) m = e;
        if (d < this.n && this.f[d] < this.f[m]) m = d;
        if (m === k) break;
        const ti = this.idx[m], tf = this.f[m];
        this.idx[m] = this.idx[k]; this.f[m] = this.f[k];
        this.idx[k] = ti; this.f[k] = tf;
        k = m;
      }
    }
    return topo;
  }
}

/* ---------------------------------------------------------------- nav ---- */

export class NavGrid {
  constructor(ctx) {
    this.ctx = ctx;
    this.grid = null;
    this.pronto = false;

    this.w = 0; this.h = 0; this.cs = 1;
    this.ox = 0; this.oz = 0;

    this.distParede = null;   // Float32Array (celulas ate o obstaculo mais proximo)
    this._g = null;           // custo acumulado
    this._veio = null;        // predecessor
    this._selo = null;        // geracao em que a celula foi tocada
    this._estado = null;      // 0 nada / 1 aberto / 2 fechado
    this._geracao = 0;
    this._heap = null;

    // fila de pedidos
    this._fila = [];
    this._porChave = new Map();
    this._poolPedidos = [];

    // buffers de saida reaproveitados
    this._celPath = new Int32Array(4096);
    this._nCelPath = 0;
    this._pontos = [];        // Vector3 pool
    this._nPontos = 0;

    this._cache = new Map();
    this._tempo = 0;

    this.stats = { buscas: 0, nos: 0, cacheHit: 0, falhas: 0, ultimoMs: 0 };
  }

  /** @param {object} grid contrato world.navGrid */
  init(grid) {
    if (!grid || !grid.data) { this.pronto = false; return; }
    this.grid = grid;
    this.w = grid.width; this.h = grid.height; this.cs = grid.cellSize;
    this.ox = grid.origin.x; this.oz = grid.origin.z;
    const n = this.w * this.h;

    this._g = new Float32Array(n);
    this._veio = new Int32Array(n);
    this._selo = new Int32Array(n);
    this._estado = new Uint8Array(n);
    this._heap = new HeapBinario(Math.min(65536, Math.max(2048, n >> 3)));

    this._campoDeParede();
    this.pronto = true;
  }

  /**
   * Distancia (em celulas) ate o bloqueio mais proximo, por chanfro 3-4 em duas
   * varreduras. Barato e suficientemente isotropico para servir de penalidade.
   */
  _campoDeParede() {
    const { w, h } = this;
    const d = new Float32Array(w * h);
    const data = this.grid.data;
    const INF = 1e9;
    for (let i = 0; i < d.length; i++) d[i] = data[i] ? INF : 0;

    const A = 1.0, B = 1.41421356;
    // frente
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (d[k] === 0) continue;
        let m = d[k];
        if (i > 0) m = Math.min(m, d[k - 1] + A);
        if (j > 0) {
          m = Math.min(m, d[k - w] + A);
          if (i > 0) m = Math.min(m, d[k - w - 1] + B);
          if (i < w - 1) m = Math.min(m, d[k - w + 1] + B);
        }
        d[k] = m;
      }
    }
    // tras
    for (let j = h - 1; j >= 0; j--) {
      for (let i = w - 1; i >= 0; i--) {
        const k = j * w + i;
        if (d[k] === 0) continue;
        let m = d[k];
        if (i < w - 1) m = Math.min(m, d[k + 1] + A);
        if (j < h - 1) {
          m = Math.min(m, d[k + w] + A);
          if (i > 0) m = Math.min(m, d[k + w - 1] + B);
          if (i < w - 1) m = Math.min(m, d[k + w + 1] + B);
        }
        d[k] = Math.min(m, DIST_MAX_PAREDE);
      }
    }
    this.distParede = d;
  }

  // ------------------------------------------------------------ util grid

  andavel(i, j) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
    return this.grid.data[j * this.w + i] === 1;
  }

  alturaCel(i, j) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return this.grid.heightData[j * this.w + i];
  }

  mundoParaCel(v, out = _cel) {
    out.x = Math.min(this.w - 1, Math.max(0, Math.floor((v.x - this.ox) / this.cs)));
    out.z = Math.min(this.h - 1, Math.max(0, Math.floor((v.z - this.oz) / this.cs)));
    return out;
  }

  celParaMundo(i, j, out) {
    out.set(this.ox + (i + 0.5) * this.cs, this.alturaCel(i, j), this.oz + (j + 0.5) * this.cs);
    return out;
  }

  /** Celula andavel mais proxima, busca em anel. Devolve indice ou -1. */
  celMaisProxima(v, raioMax = 20) {
    this.mundoParaCel(v, _celB);
    const ci = _celB.x, cj = _celB.z;
    if (this.andavel(ci, cj)) return cj * this.w + ci;
    for (let r = 1; r <= raioMax; r++) {
      let melhor = -1, melhorD = Infinity;
      for (let d = -r; d <= r; d++) {
        const cand = [
          [ci + d, cj - r], [ci + d, cj + r], [ci - r, cj + d], [ci + r, cj + d],
        ];
        for (let c = 0; c < 4; c++) {
          const i = cand[c][0], j = cand[c][1];
          if (!this.andavel(i, j)) continue;
          const dd = (i - ci) * (i - ci) + (j - cj) * (j - cj);
          if (dd < melhorD) { melhorD = dd; melhor = j * this.w + i; }
        }
      }
      if (melhor >= 0) return melhor;
    }
    return -1;
  }

  /** Custo extra por proximidade de parede (0 no meio do corredor). */
  _penalidade(k) {
    const d = this.distParede[k];
    if (d >= RAIO_CONFORTO) return 0;
    const t = 1 - d / RAIO_CONFORTO;
    return PESO_PAREDE * t * t;
  }

  // ---------------------------------------------------------------- A*

  /**
   * Busca sincrona. Preenche `this._celPath` com indices de celula.
   * @returns {boolean}
   */
  _astar(kInicio, kFim) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const { w, h } = this;
    const g = this._g, veio = this._veio, selo = this._selo, est = this._estado;
    const heap = this._heap;
    const ger = ++this._geracao;
    heap.limpar();
    this.stats.buscas++;

    const fi = kFim % w, fj = (kFim / w) | 0;
    const heur = (i, j) => {
      const dx = Math.abs(i - fi), dz = Math.abs(j - fj);
      const mn = Math.min(dx, dz);
      return (dx + dz - 2 * mn) + CUSTO_DIAG * mn;
    };

    g[kInicio] = 0; veio[kInicio] = -1; selo[kInicio] = ger; est[kInicio] = 1;
    heap.inserir(kInicio, heur(kInicio % w, (kInicio / w) | 0));

    let nos = 0;
    let achou = false;
    while (heap.n > 0) {
      const k = heap.remover();
      if (selo[k] !== ger || est[k] === 2) continue;
      est[k] = 2;
      if (k === kFim) { achou = true; break; }
      if (++nos > NOS_MAX) break;

      const ki = k % w, kj = (k / w) | 0;
      const gk = g[k];
      const yk = this.grid.heightData[k];

      for (let d = 0; d < 8; d++) {
        const di = (d === 0 || d === 4 || d === 7) ? 1 : (d === 1 || d === 5 || d === 6) ? -1 : 0;
        const dj = (d === 2 || d === 4 || d === 5) ? 1 : (d === 3 || d === 6 || d === 7) ? -1 : 0;
        const ni = ki + di, nj = kj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = nj * w + ni;
        if (this.grid.data[nk] !== 1) continue;
        if (selo[nk] === ger && est[nk] === 2) continue;

        const diag = di !== 0 && dj !== 0;
        if (diag) {
          // proibido cortar quina: as duas ortogonais precisam estar livres
          if (this.grid.data[kj * w + ni] !== 1 || this.grid.data[nj * w + ki] !== 1) continue;
        }
        const dy = this.grid.heightData[nk] - yk;
        if (Math.abs(dy) > DEGRAU_MAX) continue;

        let custo = diag ? CUSTO_DIAG : 1;
        custo += this._penalidade(nk);
        custo += Math.abs(dy) * 1.6;           // subir/descer custa
        const ng = gk + custo;

        if (selo[nk] !== ger) {
          selo[nk] = ger; est[nk] = 0; g[nk] = Infinity; veio[nk] = -1;
        }
        if (ng < g[nk]) {
          g[nk] = ng; veio[nk] = k; est[nk] = 1;
          heap.inserir(nk, ng + heur(ni, nj) * 1.02);   // leve peso: mais rapido, quase otimo
        }
      }
    }

    this.stats.nos += nos;
    this.stats.ultimoMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    if (!achou) { this.stats.falhas++; this._nCelPath = 0; return false; }

    // reconstroi invertido e depois vira
    let n = 0, k = kFim;
    while (k !== -1 && n < this._celPath.length) { this._celPath[n++] = k; k = veio[k]; }
    for (let a = 0, b = n - 1; a < b; a++, b--) {
      const t = this._celPath[a]; this._celPath[a] = this._celPath[b]; this._celPath[b] = t;
    }
    this._nCelPath = n;
    return true;
  }

  // ------------------------------------------------------- linha de visada

  /**
   * Corredor livre entre duas celulas: percorre por passos de meia celula e
   * exige nao so andavel como uma folga minima de parede, senao a suavizacao
   * cola o agente na quina.
   */
  linhaLivre(i0, j0, i1, j1, folga = 0.9) {
    const di = i1 - i0, dj = j1 - j0;
    const passos = Math.ceil(Math.max(Math.abs(di), Math.abs(dj)) * 2);
    if (passos === 0) return true;
    let yAnt = this.alturaCel(i0, j0);
    for (let s = 1; s <= passos; s++) {
      const t = s / passos;
      const i = Math.round(i0 + di * t);
      const j = Math.round(j0 + dj * t);
      if (!this.andavel(i, j)) return false;
      const k = j * this.w + i;
      if (this.distParede[k] < folga) return false;
      const y = this.grid.heightData[k];
      if (Math.abs(y - yAnt) > DEGRAU_MAX) return false;
      yAnt = y;
    }
    return true;
  }

  /** Versao em coordenadas de mundo, usada por Enemy/Perception. */
  linhaLivreMundo(a, b, folga = 0.6) {
    this.mundoParaCel(a, _cel);
    this.mundoParaCel(b, _celB);
    return this.linhaLivre(_cel.x, _cel.z, _celB.x, _celB.z, folga);
  }

  /**
   * String pulling: mantem so os pontos onde a linha de visada quebra.
   * Trabalha sobre `this._celPath` e escreve em `this._pontos`.
   */
  _suavizar() {
    const n = this._nCelPath;
    this._nPontos = 0;
    if (n === 0) return;
    const w = this.w;
    const empurra = (k) => {
      const i = k % w, j = (k / w) | 0;
      let v = this._pontos[this._nPontos];
      if (!v) { v = new THREE.Vector3(); this._pontos[this._nPontos] = v; }
      this.celParaMundo(i, j, v);
      this._nPontos++;
    };

    empurra(this._celPath[0]);
    let ancora = 0;
    while (ancora < n - 1) {
      let melhor = ancora + 1;
      const ai = this._celPath[ancora] % w, aj = (this._celPath[ancora] / w) | 0;
      // procura o ponto mais longe ainda visivel (limite de 48 celulas por salto)
      const limite = Math.min(n - 1, ancora + 48);
      for (let j = limite; j > ancora + 1; j--) {
        const ci = this._celPath[j] % w, cj = (this._celPath[j] / w) | 0;
        if (this.linhaLivre(ai, aj, ci, cj)) { melhor = j; break; }
      }
      empurra(this._celPath[melhor]);
      ancora = melhor;
    }
  }

  // ------------------------------------------------------ API de pedidos

  _novoPedido() {
    const p = this._poolPedidos.pop();
    if (p) return p;
    return { chave: 0, origem: new THREE.Vector3(), destino: new THREE.Vector3(), cb: null, prio: 0, ativo: true };
  }

  /**
   * Enfileira uma busca. Um pedido novo com a mesma chave substitui o anterior.
   * @param {number|string} chave identificador do agente
   * @param {THREE.Vector3} origem
   * @param {THREE.Vector3} destino
   * @param {(pontos:THREE.Vector3[], n:number, ok:boolean)=>void} cb
   * @param {number} prio maior = antes
   */
  pedir(chave, origem, destino, cb, prio = 0) {
    if (!this.pronto) { cb(this._pontos, 0, false); return; }
    let p = this._porChave.get(chave);
    if (!p) { p = this._novoPedido(); this._porChave.set(chave, p); this._fila.push(p); }
    p.chave = chave; p.origem.copy(origem); p.destino.copy(destino);
    p.cb = cb; p.prio = prio; p.ativo = true;
  }

  cancelar(chave) {
    const p = this._porChave.get(chave);
    if (p) p.ativo = false;
  }

  /** Processa ate MAX_BUSCAS_FRAME pedidos, os de maior prioridade primeiro. */
  update(dt) {
    this._tempo += dt;
    if (!this.pronto || this._fila.length === 0) return;
    if (this._fila.length > 1) this._fila.sort((a, b) => b.prio - a.prio);

    let feitos = 0;
    while (this._fila.length && feitos < MAX_BUSCAS_FRAME) {
      const p = this._fila.shift();
      this._porChave.delete(p.chave);
      if (!p.ativo) { this._poolPedidos.push(p); continue; }
      const ok = this.buscar(p.origem, p.destino);
      try { p.cb(this._pontos, this._nPontos, ok); }
      catch (e) { console.error('[AI/NavGrid] callback de caminho lancou:', e); }
      p.cb = null;
      this._poolPedidos.push(p);
      feitos++;
    }
    // limpeza do cache por TTL
    if (this._cache.size > CACHE_MAX) {
      for (const [k, v] of this._cache) {
        if (this._tempo - v.t > CACHE_TTL) this._cache.delete(k);
        if (this._cache.size <= CACHE_MAX * 0.75) break;
      }
    }
  }

  /**
   * Busca sincrona completa (celula -> A* -> suavizacao). Resultado em
   * `this._pontos` / `this._nPontos`. Use `update()` no caminho quente.
   */
  buscar(origem, destino) {
    this._nPontos = 0;
    if (!this.pronto) return false;
    const kI = this.celMaisProxima(origem, 12);
    const kF = this.celMaisProxima(destino, 16);
    if (kI < 0 || kF < 0) return false;

    if (kI === kF) {
      let v = this._pontos[0];
      if (!v) { v = new THREE.Vector3(); this._pontos[0] = v; }
      v.copy(destino); this._nPontos = 1;
      return true;
    }

    const chave = kI * 1e7 + kF;
    const c = this._cache.get(chave);
    if (c && this._tempo - c.t < CACHE_TTL) {
      this.stats.cacheHit++;
      for (let i = 0; i < c.n; i++) {
        let v = this._pontos[i];
        if (!v) { v = new THREE.Vector3(); this._pontos[i] = v; }
        v.copy(c.pts[i]);
      }
      this._nPontos = c.n;
      return true;
    }

    if (!this._astar(kI, kF)) return false;
    this._suavizar();

    // o ultimo ponto vai exatamente no destino pedido (nao no centro da celula)
    if (this._nPontos > 0) {
      const ult = this._pontos[this._nPontos - 1];
      const dy = ult.y;
      ult.copy(destino); ult.y = dy;
    }

    const pts = new Array(this._nPontos);
    for (let i = 0; i < this._nPontos; i++) pts[i] = this._pontos[i].clone();
    this._cache.set(chave, { pts, n: this._nPontos, t: this._tempo });
    return true;
  }

  limparCache() { this._cache.clear(); }

  dispose() {
    this._fila.length = 0;
    this._porChave.clear();
    this._poolPedidos.length = 0;
    this._pontos.length = 0;
    this._cache.clear();
    this.grid = null;
    this.pronto = false;
  }
}

export default NavGrid;
