/**
 * AIManager — pool de inimigos, ondas, hitboxes e orcamento de CPU.
 *
 * Orcamento: raycast de linha de visada e a parte cara da IA. Em vez de deixar
 * cada agente pedir o que quiser, o manager distribui um numero fixo de
 * "fichas" por frame e os agentes sem ficha reaproveitam o ultimo resultado.
 * Sem isso, 20 inimigos vivos derrubam o frame sozinhos.
 */
import * as THREE from 'three';
import { Enemy, MULT_PARTE } from './Enemy.js';
import { NavGrid } from './NavGrid.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

/** Hitboxes: segmentos entre ossos + raio. Ordem importa (cabeca primeiro). */
const HITBOXES = [
  { parte: 'cabeca', de: 'pescoco', ate: 'cabeca', raio: 0.135, estende: 0.09 },
  { parte: 'torso',  de: 'quadril', ate: 'pescoco', raio: 0.235, estende: 0 },
  { parte: 'bracos', de: 'ombro_D', ate: 'cotovelo_D', raio: 0.088, estende: 0 },
  { parte: 'bracos', de: 'cotovelo_D', ate: 'punho_D', raio: 0.075, estende: 0 },
  { parte: 'bracos', de: 'ombro_E', ate: 'cotovelo_E', raio: 0.088, estende: 0 },
  { parte: 'bracos', de: 'cotovelo_E', ate: 'punho_E', raio: 0.075, estende: 0 },
  { parte: 'pernas', de: 'perna_D', ate: 'joelho_D', raio: 0.115, estende: 0 },
  { parte: 'pernas', de: 'joelho_D', ate: 'tornozelo_D', raio: 0.095, estende: 0 },
  { parte: 'pernas', de: 'perna_E', ate: 'joelho_E', raio: 0.115, estende: 0 },
  { parte: 'pernas', de: 'joelho_E', ate: 'tornozelo_E', raio: 0.095, estende: 0 },
];

const RAIO_GROSSO = 1.15;      // esfera envolvente para rejeicao rapida
const ALTURA_CENTRO = 1.0;
const FICHAS_LOS = 6;          // raycasts de percepcao por frame
const DIST_LOD = 38;           // alem disso o agente pensa a 5Hz
/** Distancia minima entre dois inimigos ao nascer (evita sobreposicao). */
const SEPARACAO_SPAWN = 7;
/** Segundos que um corpo fica na cena antes de liberar a vaga do pool. */
const VIDA_DO_CORPO = 26;

export class AIManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.grupo = new THREE.Group();
    this.grupo.name = 'ia';

    this.pool = [];
    this.vivos = [];
    this.nav = null;

    this._ficha = 0;
    // Nao zero: com 0 a primeira onda dispara no primeiro frame de jogo,
    // antes de o jogador sequer se mover.
    this._tOnda = 4;
    this.maxVivos = 10;
    this.dificuldade = 'normal';
    this.spawnAutomatico = true;
  }

  async init() {
    const ctx = this.ctx;
    this.nav = new NavGrid(ctx);
    if (ctx.world?.navGrid) this.nav.init(ctx.world.navGrid);

    ctx.scene.add(this.grupo);

    // Pre-aloca o pool inteiro: construir um Soldier custa caro (geometria
    // com skinning), e fazer isso no meio do tiroteio produz engasgo visivel.
    const N = this.maxVivos + 4;
    for (let i = 0; i < N; i++) {
      const e = new Enemy(ctx, { dificuldade: this.dificuldade, variante: i % 3 });
      this.grupo.add(e.soldado.grupo);
      this.pool.push(e);
    }

    // O spawn e ditado pela Progressao; aqui so limpamos o campo.
    ctx.bus?.on('game:start', () => this.reset());
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Spawn                                                               */
  /* ------------------------------------------------------------------ */

  _livre() { return this.pool.find((e) => !e.ativo) ?? null; }

  /** Spawn num ponto valido do mundo, longe do jogador. */
  spawn(pos, yaw = 0, patrulha = null) {
    const e = this._livre();
    if (!e) return null;
    e.dif = Enemy.prototype.constructor === Enemy ? e.dif : e.dif;
    e.spawn(pos, yaw, patrulha);
    this.vivos.push(e);
    return e;
  }

  /**
   * Escolhe pontos de spawn do mundo respeitando distancia minima do jogador
   * E de outros inimigos vivos.
   *
   * A checagem de ocupacao e obrigatoria: sem ela dois soldados nascem no mesmo
   * ponto e ficam perfeitamente sobrepostos. O jogador mata o da frente, o
   * ragdoll dele desaba, e o de tras continua em pe — o que se le em jogo como
   * "matei a parte de cima e sobraram as pernas", precisando matar duas vezes.
   * O segundo tambem nao atira, porque acabou de nascer com consciencia zero.
   */
  spawnOnda(quantos = 4, distMin = 22) {
    const pontos = this.ctx.world?.getSpawnPoints?.() ?? [];
    if (!pontos.length) return 0;
    const jog = this.ctx.player?.position;
    let feitos = 0;
    const usados = new Set();
    for (let tent = 0; tent < pontos.length * 2 && feitos < quantos; tent++) {
      const i = (Math.random() * pontos.length) | 0;
      if (usados.has(i)) continue;
      const sp = pontos[i];
      const p = sp.position ?? sp;
      if (jog && p.distanceTo(jog) < distMin) continue;
      if (this._ocupado(p)) continue;
      usados.add(i);
      // patrulha: alguns pontos proximos, para nao ficarem parados feito poste
      const rota = [];
      for (let k = 0; k < 3; k++) {
        const q = pontos[(Math.random() * pontos.length) | 0];
        const qp = q.position ?? q;
        if (qp.distanceTo(p) < 34) rota.push(qp.clone());
      }
      if (this.spawn(p, sp.yaw ?? 0, rota)) feitos++;
    }
    return feitos;
  }

  /**
   * Ja existe alguem (vivo ou corpo recente) perto deste ponto?
   * @param {THREE.Vector3} p
   * @param {number} raio metros de separacao minima
   */
  _ocupado(p, raio = SEPARACAO_SPAWN) {
    const r2 = raio * raio;
    for (const o of this.vivos) {
      if (!o.ativo) continue;
      if (o.pos.distanceToSquared(p) < r2) return true;
    }
    return false;
  }

  /**
   * Nasce um hostil no ponto valido mais proximo do jogador, respeitando um
   * raio minimo. Usado no inicio da partida e para teste rapido.
   * @param {number} distAlvo distancia desejada (m)
   */
  spawnPerto(distAlvo = 14, distMin = 8) {
    const jog = this.ctx.player?.position;
    const world = this.ctx.world;
    if (!jog || !world) return null;

    /* NAO usar getSpawnPoints() aqui: aqueles pontos sao amostrados por
     * distancia maxima entre si (ficam a 40 m+ uns dos outros), entao "o mais
     * proximo" pode estar a 41 m — longe demais para o jogador ver alguem ao
     * iniciar. Varremos o proprio navGrid em anel ao redor do jogador. */
    const grid = world.navGrid;
    const col = world.collision;
    const cand = [];

    if (grid && typeof grid.isWalkable === 'function') {
      // ATENCAO: isWalkable recebe INDICE DE CELULA, nao metros. Passar
      // coordenada de mundo faz a funcao devolver false sempre (o indice cai
      // fora do grid), e a busca inteira volta vazia.
      const cs = grid.cellSize ?? 0.5;
      const ox = grid.origin?.x ?? 0;
      const oz = grid.origin?.z ?? 0;
      const cel = (v, o) => Math.round((v - o) / cs);

      for (let raio = distAlvo; raio <= distAlvo + 10; raio += 2) {
        for (let a = 0; a < 24; a++) {
          const ang = (a / 24) * Math.PI * 2;
          const x = jog.x + Math.cos(ang) * raio;
          const z = jog.z + Math.sin(ang) * raio;
          if (!grid.isWalkable(cel(x, ox), cel(z, oz))) continue;
          _v.set(x, jog.y + 40, z);
          _v2.set(0, -1, 0);
          const h = col?.raycast?.(_v, _v2, 90);
          if (!h?.hit || h.normal.y < 0.5) continue;
          _v.set(x, h.point.y, z);
          if (_v.distanceTo(jog) < distMin) continue;
          if (this._ocupado(_v)) continue;
          cand.push({ pos: _v.clone(), erro: Math.abs(_v.distanceTo(jog) - distAlvo) });
        }
        if (cand.length >= 6) break;
      }
    }

    if (!cand.length) {
      // Sem navGrid utilizavel: cai nos pontos fixos, mesmo que distantes.
      const pontos = world.getSpawnPoints?.() ?? [];
      let m = null, me = Infinity;
      for (const sp of pontos) {
        const p = sp.position ?? sp;
        const d = p.distanceTo(jog);
        if (d < distMin || this._ocupado(p)) continue;
        const erro = Math.abs(d - distAlvo);
        if (erro < me) { me = erro; m = sp; }
      }
      return m ? this.spawn(m.position ?? m, m.yaw ?? 0, null) : null;
    }

    cand.sort((x, y) => x.erro - y.erro);
    const escolhido = cand[0].pos;
    // vira de frente para o jogador
    const yaw = Math.atan2(jog.x - escolhido.x, jog.z - escolhido.z);
    return this.spawn(escolhido, yaw, null);
  }

  /**
   * Manda todo mundo que ainda nao viu o jogador convergir na posicao dele.
   *
   * Justificativa de ficcao: sao maquinas em rede — quando uma detecta o alvo,
   * a malha inteira recebe a coordenada. Na pratica resolve o problema de ritmo
   * de o jogador andar minutos sem encontrar ninguem.
   *
   * Nao entrega mira: eles recebem o DESTINO e vao ate la. Quem descobre de
   * fato e quem enxerga.
   */
  convergirNoJogador(forca = 0.55) {
    const jog = this.ctx.player?.position;
    if (!jog) return 0;
    let n = 0;
    for (const e of this.vivos) {
      if (!e.alive || e.percepcao.visivel) continue;
      e.percepcao.avisar(jog, forca);
      n++;
    }
    return n;
  }

  /** Usado pela ferramenta de screenshot: inimigos visiveis perto da camera. */
  debugSpawnNear(pos, quantos = 4) {
    const pontos = this.ctx.world?.getSpawnPoints?.() ?? [];
    const ordenados = pontos
      .map((s) => ({ s, d: (s.position ?? s).distanceTo(pos) }))
      .filter((o) => o.d > 6 && o.d < 32)
      .sort((x, y) => x.d - y.d);
    let n = 0;
    for (const o of ordenados) {
      if (n >= quantos) break;
      const sp = o.s;
      const e = this.spawn(sp.position ?? sp, sp.yaw ?? 0, null);
      if (e) {
        // ja em postura de combate, para a foto mostrar a IA em acao
        e._trocar('atirar');
        e.percepcao.consciencia = 1;
        n++;
      }
    }
    return n;
  }

  reset() {
    for (const e of this.vivos) e.despawn();
    this.vivos.length = 0;
    this._tOnda = 0;
  }

  /* ------------------------------------------------------------------ */
  /* API consumida pelo PLAYER                                           */
  /* ------------------------------------------------------------------ */

  getEnemies() { return this.vivos.filter((e) => e.alive); }

  /**
   * Um hostil avistou o jogador e grita: quem estiver perto passa a suspeitar.
   *
   * É o comportamento que mais muda a percepção de inteligência. Sem isso o
   * jogador limpa um grupo inteiro um por um, com os vizinhos de costas a seis
   * metros. Não entregamos a posição exata — só a direção geral, para eles
   * INVESTIGAREM. Quem descobre de fato é quem enxerga.
   *
   * @param {Enemy} quem quem viu
   * @param {THREE.Vector3} onde última posição conhecida do jogador
   * @param {number} raio alcance do grito (m)
   */
  alertarProximos(quem, onde, raio = 22) {
    const r2 = raio * raio;
    let avisados = 0;
    for (const o of this.vivos) {
      if (o === quem || !o.alive) continue;
      const d2 = o.pos.distanceToSquared(quem.pos);
      if (d2 > r2) continue;
      // Parede no meio abafa o grito: metade do alcance efetivo.
      const col = this.ctx.world?.collision;
      let forca = 0.62;
      if (col?.raycast) {
        _v.copy(quem.pos); _v.y += 1.4;
        _v2.subVectors(o.pos, quem.pos).setY(0);
        const dist = _v2.length();
        if (dist > 0.01) {
          _v2.divideScalar(dist);
          const h = col.raycast(_v, _v2, dist);
          if (h?.hit) forca = 0.3;
        }
      }
      // Mais perto, mais convincente.
      forca *= 1 - Math.sqrt(d2) / raio * 0.5;
      o.percepcao.avisar(onde, forca);
      avisados++;
    }
    return avisados;
  }

  /**
   * Raycast contra as hitboxes de todos os inimigos vivos.
   * @returns {{enemyId, point, normal, part, distance}|null} o mais proximo
   */
  raycastEnemies(origin, dir, maxDist = 200) {
    let melhor = null;
    let melhorD = maxDist;

    for (const e of this.vivos) {
      if (!e.alive) continue;

      // Rejeicao grossa por esfera envolvente antes de testar 10 capsulas.
      _v.copy(e.pos); _v.y += ALTURA_CENTRO;
      const t = this._raioEsfera(origin, dir, _v, RAIO_GROSSO);
      if (t < 0 || t > melhorD) continue;

      const sold = e.soldado;
      sold.grupo.updateMatrixWorld(true);

      for (const hb of HITBOXES) {
        const o1 = this._osso(sold, hb.de);
        const o2 = this._osso(sold, hb.ate);
        if (!o1 || !o2) continue;
        o1.getWorldPosition(_a);
        o2.getWorldPosition(_b);
        if (hb.estende) {
          _v2.subVectors(_b, _a);
          if (_v2.lengthSq() > 1e-9) _b.addScaledVector(_v2.normalize(), hb.estende);
        }
        const d = this._raioCapsula(origin, dir, _a, _b, hb.raio, melhorD);
        if (d >= 0 && d < melhorD) {
          melhorD = d;
          melhor = melhor ?? {
            enemyId: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(),
            part: 'torso', distance: 0,
          };
          melhor.enemyId = e.id;
          melhor.part = hb.parte;
          melhor.distance = d;
          melhor.point.copy(origin).addScaledVector(dir, d);
          // normal aproximada: do eixo da capsula para o ponto
          this._maisProximoNoSegmento(melhor.point, _a, _b, _pa);
          melhor.normal.subVectors(melhor.point, _pa);
          if (melhor.normal.lengthSq() < 1e-8) melhor.normal.copy(dir).negate();
          else melhor.normal.normalize();
        }
      }
    }
    return melhor;
  }

  damageEnemy(enemyId, damage, point, part, weapon) {
    const e = this.vivos.find((x) => x.id === enemyId);
    if (!e || !e.alive) return false;
    _v.set(0, 0, 0);
    if (this.ctx.camera && point) {
      _v.subVectors(point, this.ctx.camera.position).normalize();
    }
    const matou = e.levarDano(damage, point, part, _v);
    void weapon;
    if (matou) {
      const i = this.vivos.indexOf(e);
      // Fica na lista para o ragdoll continuar simulando; sai no update.
      void i;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Geometria de teste                                                  */
  /* ------------------------------------------------------------------ */

  _osso(sold, nome) {
    if (!sold._mapaOssos) {
      sold._mapaOssos = new Map();
      for (const b of sold.ossos ?? []) sold._mapaOssos.set(b.name, b);
    }
    return sold._mapaOssos.get(nome) ?? null;
  }

  /** Distancia ao longo do raio ate a esfera, ou -1. */
  _raioEsfera(o, d, centro, r) {
    _v2.subVectors(centro, o);
    const tca = _v2.dot(d);
    if (tca < -r) return -1;
    const d2 = _v2.lengthSq() - tca * tca;
    const r2 = r * r;
    if (d2 > r2) return -1;
    const thc = Math.sqrt(r2 - d2);
    const t0 = tca - thc;
    return t0 >= 0 ? t0 : (tca + thc >= 0 ? 0 : -1);
  }

  /**
   * Raio contra capsula (segmento A-B com raio r).
   * Resolve pela menor distancia entre as duas retas e refina; e aproximado,
   * mas o erro fica abaixo do raio da hitbox — imperceptivel em jogo.
   */
  _raioCapsula(o, d, A, B, r, maxT) {
    _pa.subVectors(B, A);
    const segLen2 = _pa.lengthSq();
    if (segLen2 < 1e-9) {
      const t = this._raioEsfera(o, d, A, r);
      return (t >= 0 && t <= maxT) ? t : -1;
    }

    // Rejeicao: distancia minima entre a reta do raio e o segmento
    _v2.subVectors(A, o);
    const bDotD = _pa.dot(d) / segLen2;
    const det = 1 - _pa.dot(d) * bDotD / 1;
    void det;

    // Amostragem ao longo do segmento: 6 pontos e suficiente para membros
    // e nao tem os casos degenerados do solver analitico.
    const N = 6;
    let melhorT = -1;
    for (let i = 0; i <= N; i++) {
      _pb.copy(A).addScaledVector(_pa, i / N);
      const t = this._raioEsfera(o, d, _pb, r);
      if (t >= 0 && t <= maxT && (melhorT < 0 || t < melhorT)) melhorT = t;
    }
    return melhorT;
  }

  _maisProximoNoSegmento(p, A, B, out) {
    _v2.subVectors(B, A);
    const l2 = _v2.lengthSq();
    if (l2 < 1e-9) { out.copy(A); return out; }
    let t = (p.clone().sub(A)).dot(_v2) / l2;
    t = Math.max(0, Math.min(1, t));
    out.copy(A).addScaledVector(_v2, t);
    return out;
  }

  /* ------------------------------------------------------------------ */

  update(dt, elapsed) {
    this.nav?.update(dt);

    const jog = this.ctx.player?.position;
    this._ficha = FICHAS_LOS;

    for (let i = this.vivos.length - 1; i >= 0; i--) {
      const e = this.vivos[i];

      // Corpo velho: some e devolve a vaga do pool. Sem isto o pool esgota
      // (`ativo` continuava true para sempre) e `_ocupado` bloquearia o mapa.
      if (e.morto && e.tEstado > VIDA_DO_CORPO) {
        e.despawn();
        this.vivos.splice(i, 1);
        continue;
      }

      if (e.morto) { e.update(dt); continue; }

      // LOD: longe pensa a 5Hz. O ragdoll e a animacao seguem cheios.
      const dist = jog ? e.pos.distanceTo(jog) : 0;
      let passo = dt;
      if (dist > DIST_LOD) {
        e._lento += dt;
        if (e._lento < 0.2) { e.soldado.update(dt); continue; }
        passo = e._lento;
        e._lento = 0;
      }

      const temFicha = this._ficha > 0;
      if (temFicha) this._ficha--;
      e.update(passo, temFicha);
    }

    // Ondas: repoe inimigos conforme o jogador limpa.
    if (this.spawnAutomatico && this.ctx.state === 'jogando') {
      this._tOnda -= dt;
      const ativos = this.vivos.filter((e) => e.alive).length;
      if (ativos < 4 && this._tOnda <= 0) {
        this.spawnOnda(Math.min(4, this.maxVivos - ativos));
        this._tOnda = 8 + Math.random() * 6;
      }
    }

    void elapsed;
  }

  setQuality(preset) {
    // Menos inimigos simultaneos em preset baixo.
    this.maxVivos = preset.particleScale <= 0.25 ? 6 : (preset.particleScale <= 0.5 ? 8 : 10);
  }

  estatisticas() {
    return {
      vivos: this.vivos.filter((e) => e.alive).length,
      corpos: this.vivos.filter((e) => e.morto).length,
      pool: this.pool.length,
    };
  }

  dispose() {
    for (const e of this.pool) e.dispose();
    this.pool.length = 0;
    this.vivos.length = 0;
    this.nav?.dispose();
    this.ctx.scene?.remove(this.grupo);
  }
}

export { MULT_PARTE };
export default AIManager;
