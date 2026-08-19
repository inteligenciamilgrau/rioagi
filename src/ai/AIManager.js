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
import { Drone, PARTES_DRONE } from './Drone.js';
import { RotoresEnxame, disposeRecursosDrone } from './DroneMalha.js';
import { NavGrid } from './NavGrid.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
/* Temporario proprio da audicao: os sons chegam por evento, de dentro do
 * `Player.update()`, fora da pilha do `AIManager` — reaproveitar `_v` daqui
 * seria pisar num temporario que outro metodo pode estar usando. */
const _ouvido = new THREE.Vector3();
/* Centro de esfera do drone. Proprio, e nao `_v2`, porque `_raioEsfera` usa
 * `_v2` internamente — ver a nota em `_raycastDrone`. */
const _dc = new THREE.Vector3();
/** Centroide do enxame, para o zumbido compartilhado. */
const _enx = new THREE.Vector3();
/** Esfera de teste do frustum, no LOD. Propria: `_raioEsfera` usa a dele. */
const _esfera = new THREE.Sphere();

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

/* ======================================================================== *
 * ORCAMENTO DE RAIOS — UM SO, COMPARTILHADO POR TODA A IA
 *
 * O que existia antes: `FICHAS_LOS = 6` cobrindo APENAS a linha de visada da
 * percepcao. Todo o resto atirava a vontade.
 *
 * MEDIDO (`tools/miolo.mjs`, 14 hostis de chao + 10 drones, 3 297 quadros):
 *
 *   raios por quadro   p50 62 · p99 85 · max 109
 *   deles, percepcao   p50  6 · p99 14 · max  16
 *   => 71 dos 85 do p99 (84%) FORA de qualquer orcamento
 *
 *   quem atira (p99):  drone.voo 40 · audicao 19 · solo.mover 16 · percepcao 14
 *
 * O `Drone._mover` sozinho atira 4 raios por drone por quadro — 47% de todos os
 * raios do jogo. E `raycast` custa ~12 us de CPU e **817 B de lixo** por chamada
 * (medido em `tools/lixoai.mjs`): 85 raios sao ~1 ms de CPU e ~70 KB de lixo por
 * quadro, sem tocar na GPU. E exatamente o sintoma que o jogador descreve.
 *
 * A saida NAO e cortar agente: e parar de deixar o custo crescer com N. O teto
 * abaixo e por QUADRO e vale para os dois tipos; quem nao recebe ficha usa o
 * ultimo resultado (todos os consumidores ja tem esse caminho, porque a
 * percepcao ja funcionava assim). A ordem de atendimento e por IMPORTANCIA
 * (perto e a vista primeiro), com giro por quadro para ninguem morrer de fome.
 * ======================================================================== */

/** Teto de raios da IA por quadro. Publico via `ai.tetoRaios`. */
const TETO_RAIOS = 30;
/** Raios que NUNCA sao negados: seguranca de corpo (drone dentro de parede). */
const PRIO_SEGURANCA = 2;
/** Distancia em que o agente e sempre tratado como importante. */
const DIST_PERTO = 20;
/** Alem disso a ARMA do hostil para de projetar sombra (o corpo nunca para). */
const DIST_ARMA_SOMBRA = 16;

/**
 * Audicao — alcance nominal por fonte, em metros.
 *
 * O `ARCHITECTURE.md` sempre listou `weapon:fire` como PLAYER -> AI e o
 * `Perception` sempre teve `ouvir()`, mas NINGUEM estava inscrito no barramento:
 * o metodo era codigo morto e o hostil era literalmente surdo. Medido em
 * `tools/reacao.mjs` antes desta mudanca: jogador andando 68 m em 25 s a 12 m
 * de um sentinela, 41 passos audiveis, consciencia final do hostil = 0,00.
 *
 * O alcance do tiro e maior que o `ALCANCE_TIRO` da IA de proposito: som de
 * fuzil em beco de morro atravessa o bairro, e ouvir de que lado veio o tiro e
 * o que faz um esquadrao convergir em vez de esperar o jogador aparecer.
 */
const RAIO_SOM = { ia2: 70, smt40: 58, pt92: 44, aglc: 85 };
const RAIO_SOM_PADRAO = 60;
/** Passo: quanto mais discreto o jogador anda, menos longe se ouve. */
const RAIO_PASSO = { correndo: 22, andando: 16, agachado: 5 };
/**
 * Forca do passo. Escala o salto INTEIRO de consciencia (ver `Perception.ouvir`).
 * 0,38 poe um caminhante a 12 m em suspeita em ~3 passos (~1,7 s) e um corredor
 * colado em suspeita no segundo passo — sem nunca chegar sozinho ao alerta.
 */
const FORCA_PASSO = 0.38;
/** Teto de consciencia que o passo sozinho alcanca: suspeita, nunca alerta. */
const TETO_PASSO = 0.85;
/** Distancia minima entre dois inimigos ao nascer (evita sobreposicao). */
const SEPARACAO_SPAWN = 7;
/**
 * Quantos drones o pool comporta.
 *
 * Fixo, e nao `maxDrones + 4` como o dos hostis de chao: a onda tematica pede
 * enxame, e o pool tem de estar pronto ANTES dela — construir um drone no meio
 * do combate custa a geracao da malha e engasga. O corpo em si e barato (uma
 * `Mesh` com geometria compartilhada), entao pre-alocar com folga sai de graca.
 */
const POOL_DRONES = 16;
/** Raio do enxame: alem disso o zumbido do drone nao entra na mixagem. */
const ALCANCE_ZUMBIDO = 62;

export class AIManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.grupo = new THREE.Group();
    this.grupo.name = 'ia';

    /* `pool` e a lista UNIFICADA (hostis de chao + drones). Quem itera por tipo
     * usa `poolSolo`/`poolDrone`; quem trata "todo inimigo do jogo" — a
     * `Progressao` escrevendo o perfil de dificuldade, as etiquetas de
     * depuracao — continua iterando `pool` e nao precisa saber que ha dois
     * tipos. Manter esse nome com o mesmo significado e o que impede a
     * introducao do drone de virar uma mudanca de contrato. */
    this.pool = [];
    this.poolSolo = [];
    this.poolDrone = [];
    this.vivos = [];
    this.rotores = null;
    this.nav = null;

    this._ficha = 0;
    /* Orcamento unificado de raios (ver o bloco de constantes). `tetoRaios` e
     * publico: quem quiser afrouxar ou apertar mexe aqui, nao em cada agente. */
    this.tetoRaios = TETO_RAIOS;
    this._raios = 0;
    this._raiosSeg = 0;
    /** Estatistica do quadro anterior, para ferramenta e HUD de debug. */
    this.raiosNoQuadro = 0;
    this.raiosNegados = 0;
    /* Frustum da camera do jogador, recalculado uma vez por quadro. Serve ao
     * LOD: quem esta FORA da tela nao precisa da mesma taxa de quem esta nela.
     * Nao cria renderer nem toca em material — so le a matriz da camera. */
    this._frustum = new THREE.Frustum();
    this._matFrustum = new THREE.Matrix4();
    this._giro = 0;
    // Nao zero: com 0 a primeira onda dispara no primeiro frame de jogo,
    // antes de o jogador sequer se mover.
    this._tOnda = 4;
    this._tSom = 0;              // estrangulamento da audicao de tiro
    this.maxVivos = 10;
    /** Quantos dos `maxVivos` podem ser drones. Escrito pela `Progressao`. */
    this.maxDrones = 0;
    /* Teto de hostis abrindo fogo ao mesmo tempo (ver Progressao.atiradoresDaOnda).
     * Quem nao cabe manobra em vez de atirar. Vale para os DOIS tipos: o drone
     * ocupa vaga enquanto paira e enquanto atira. */
    this.maxAtiradores = 3;
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
      this.grupo.add(e.objeto3d);
      this.poolSolo.push(e);
    }
    for (let i = 0; i < POOL_DRONES; i++) {
      const d = new Drone(ctx);
      this.grupo.add(d.objeto3d);
      this.poolDrone.push(d);
    }
    this.pool = [...this.poolSolo, ...this.poolDrone];

    /* Todas as helices de todos os drones num unico `InstancedMesh`. Sem isto,
     * helice que gira custaria 4 draw calls por drone — 40 numa onda de enxame,
     * so em pas de 5 mm. Com isto, custa 1, sempre. */
    this.rotores = new RotoresEnxame(POOL_DRONES);
    this.grupo.add(this.rotores.malha);

    // O spawn e ditado pela Progressao; aqui so limpamos o campo.
    ctx.bus?.on('game:start', () => this.reset());

    /* --- ouvidos --- */
    ctx.bus?.on('weapon:fire', (p) => {
      /* Estrangulado: a 600 rpm uma rajada dispararia 10 difusoes por segundo,
       * cada uma com um raycast de oclusao por hostil vivo. Para a percepcao
       * uma rajada e UM evento — o que importa e a direcao, nao a contagem. */
      if (this._tSom > 0) return;
      this._tSom = 0.12;
      const raio = RAIO_SOM[p?.weapon] ?? RAIO_SOM_PADRAO;
      this._ouviram(p?.origin ?? ctx.player?.eyePosition, raio, 1.0, 1.25);
    });
    ctx.bus?.on('player:footstep', (p) => {
      const st = ctx.player?.movement?.state;
      const raio = p?.running ? RAIO_PASSO.correndo
        : (st === 'agachado' ? RAIO_PASSO.agachado : RAIO_PASSO.andando);
      this._ouviram(p?.position, raio, FORCA_PASSO, TETO_PASSO);
    });
    return this;
  }

  /**
   * Distribui um som para quem esta dentro do alcance.
   *
   * O corte grosso por distancia vem ANTES de `Perception.ouvir`, que dispara um
   * raycast de oclusao: sem ele um passo custaria um raio por hostil vivo, duas
   * vezes por segundo, o mapa inteiro.
   *
   * @param {THREE.Vector3} pos onde o som nasceu
   * @param {number} raio alcance nominal (m)
   * @param {number} forca escala o salto de consciencia
   * @param {number} teto ate onde este som pode levar a consciencia sozinho
   * @returns {number} quantos ouviram
   */
  _ouviram(pos, raio, forca, teto) {
    if (!pos) return 0;
    const r2 = raio * raio;
    let n = 0;
    /* RAJADA. Isto e um raio de oclusao POR HOSTIL VIVO num unico quadro —
     * medido em `tools/miolo.mjs`: p99 de 19 e MAXIMO de 24 raios num quadro so,
     * a segunda maior fonte de raios do jogo depois do voo do drone. O
     * estrangulamento de 0,12 s do `weapon:fire` limita a frequencia da rajada,
     * nao o tamanho dela — e o tamanho cresce linear com o bando.
     *
     * A rajada agora sai do mesmo orcamento do quadro, com o giro em volta da
     * lista para a mesma ponta nao ser sempre a atendida. Quem nao recebe ficha
     * ainda ouve: o `Perception.ouvir` sem oclusao trata o som como se nao
     * houvesse parede no caminho — ou seja, o hostil fica MAIS sensivel, nunca
     * surdo. Degradar para "ouve demais" e o lado certo de errar num som que
     * so leva a SUSPEITA (teto de 0,85 no passo). */
    const N = this.vivos.length;
    if (N === 0) return 0;
    const inicio = this._giro % N;
    for (let k = 0; k < N; k++) {
      const e = this.vivos[(inicio + k) % N];
      if (!e.alive) continue;
      if (e.pos.distanceToSquared(pos) > r2) continue;
      e.posOlho(_ouvido);
      const comOclusao = this.pedirRaio((e._peso ?? 3) >= 3 ? 2 : 0);
      if (e.percepcao.ouvir(pos, raio, forca, _ouvido, teto, comOclusao)) n++;
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Spawn                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Vaga no pool. Se nao houver, RECICLA o corpo mais antigo.
   *
   * O pool tem `maxVivos + 4` lugares e um corpo segura o lugar dele por
   * `e.vidaDoCorpo` (26 s no de chao, 14 s na carcaca de drone — ela e pequena
   * e some no cenario). Com a onda pedindo 12 simultaneos, bastam tres
   * baixas seguidas para o pool esgotar e o reforco parar de nascer bem no
   * momento mais quente da onda — o jogador limpa a frente e o campo esvazia.
   * Reciclar o cadaver mais velho troca "onda que mingua" por "corpo que some
   * mais cedo quando ha gente demais em campo".
   */
  _livre(tipo = 'solo') {
    const pool = tipo === 'drone' ? this.poolDrone : this.poolSolo;
    const livre = pool.find((e) => !e.ativo);
    if (livre) return livre;
    let velho = null;
    for (const e of pool) {
      if (!e.morto) continue;
      if (!velho || e.tEstado > velho.tEstado) velho = e;
    }
    if (!velho) return null;
    const i = this.vivos.indexOf(velho);
    if (i >= 0) this.vivos.splice(i, 1);
    velho.despawn();
    return velho;
  }

  /**
   * Spawn num ponto valido do mundo, longe do jogador.
   * @param {'solo'|'drone'} tipo qual pool serve o pedido
   */
  spawn(pos, yaw = 0, patrulha = null, tipo = 'solo') {
    const e = this._livre(tipo);
    if (!e) return null;
    e.spawn(pos, yaw, patrulha);
    this.vivos.push(e);
    return e;
  }

  /** Quantos drones vivos ha em campo agora. */
  contarDrones() {
    let n = 0;
    for (const e of this.vivos) if (e.eDrone && e.alive) n++;
    return n;
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
   *
   * `distMax` existe porque so havia PISO. Medido em `tools/pressao.mjs`: com
   * teto infinito, um censo a cada 20 s achava reforco a 78, 134, 152 e 176 m
   * do jogador — num mapa de 180 m, ou seja, do outro lado do morro. Eles
   * ocupavam a vaga de vivo, a `Progressao` via o campo cheio e nao chamava
   * mais ninguem, e o jogador ficava sozinho: 56 tiros de IA em 240 s com sete
   * hostis em campo. Reforco tem de vir da esquina, nao do outro bairro.
   */
  spawnOnda(quantos = 4, distMin = 22, distMax = Infinity, tipo = 'solo') {
    const pontos = this.ctx.world?.getSpawnPoints?.() ?? [];
    if (!pontos.length) return 0;
    const jog = this.ctx.player?.position;
    let feitos = 0;
    const usados = new Set();
    /* Drone nasce mais espalhado: dois drones a 7 m um do outro convergem para
     * a mesma faixa de parada e viram um par colado no ar, que le como um so
     * inimigo grande. E ele voa rapido, entao nascer separado nao custa tempo
     * de chegada como custaria a um hostil a pe. */
    const separacao = tipo === 'drone' ? 11 : SEPARACAO_SPAWN;

    /* Duas passadas: primeiro dentro da FAIXA pedida; so se ela nao render
     * gente suficiente e que o teto e afrouxado. */
    for (let passada = 0, teto = distMax; passada < 2 && feitos < quantos; passada++, teto *= 2.5) {
      for (let tent = 0; tent < pontos.length * 2 && feitos < quantos; tent++) {
        const i = (Math.random() * pontos.length) | 0;
        if (usados.has(i)) continue;
        const sp = pontos[i];
        const p = sp.position ?? sp;
        if (jog) {
          const d = p.distanceTo(jog);
          if (d < distMin || d > teto) continue;
        }
        if (this._ocupado(p, separacao)) continue;
        usados.add(i);
        // patrulha: alguns pontos proximos, para nao ficarem parados feito poste
        const rota = [];
        for (let k = 0; k < 3; k++) {
          const q = pontos[(Math.random() * pontos.length) | 0];
          const qp = q.position ?? q;
          if (qp.distanceTo(p) < 34) rota.push(qp.clone());
        }
        if (this.spawn(p, sp.yaw ?? 0, rota, tipo)) feitos++;
      }
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
   * Ha vaga para mais um fuzil apontado para o jogador agora?
   *
   * Nao e economia de CPU, e de JUSTICA. Sem teto, todo hostil que chega entra
   * em ATIRAR e o dano recebido cresce linearmente com a densidade — medido em
   * tools/pressao.mjs, subir de 7 para 9 hostis simultaneos dobrou o dano por
   * minuto e o boneco caiu 33 vezes numa onda so. O jogo nao ficou mais dificil
   * nesse ponto, ficou aritmetico.
   *
   * @param {Enemy} quem candidato
   */
  vagaDeFogo(quem) {
    let n = 0;
    for (const o of this.vivos) {
      if (o === quem || !o.alive) continue;
      /* `ocupaVagaDeFogo` e do CONTRATO, nao `estado === 'atirar'`.
       *
       * O drone gasta ~1 s travado em `PAIRAR` mirando antes de disparar, e
       * nesse segundo ele ja escolheu o alvo e ja esta comprometido. Se so
       * `ATIRAR` contasse, dez drones poderiam pairar juntos e a rajada de
       * todos cairia na mesma janela — exatamente a parede de dano que este
       * teto existe para impedir, so que atrasada em um segundo. */
      if (o.ocupaVagaDeFogo) n++;
      if (n >= this.maxAtiradores) return false;
    }
    return true;
  }

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

      if (e.eDrone) {
        const d = this._raycastDrone(e, origin, dir, melhorD);
        if (d) {
          melhorD = d.distance;
          melhor = melhor ?? {
            enemyId: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(),
            part: 'torso', distance: 0,
          };
          melhor.enemyId = e.id;
          melhor.part = d.parte;
          melhor.distance = d.distance;
          melhor.point.copy(origin).addScaledVector(dir, d.distance);
          melhor.normal.copy(melhor.point).sub(d.centro);
          if (melhor.normal.lengthSq() < 1e-8) melhor.normal.copy(dir).negate();
          else melhor.normal.normalize();
        }
        continue;
      }

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

  /**
   * Raio contra as esferas de um drone.
   *
   * Escolhe por MULTIPLICADOR, nao por proximidade — e essa a unica diferenca
   * conceitual em relacao as capsulas do hostil de chao, e ela e obrigatoria.
   * As tres esferas do drone se CONTEM (nucleo dentro do casco, casco dentro do
   * envelope), entao "a que o raio encontra primeiro" e sempre o envelope: com
   * ordenacao por distancia, o nucleo nunca seria acertado e a mira precisa nao
   * valeria nada. As capsulas do soldado sao disjuntas e nao tem esse problema.
   *
   * A distancia reportada e a da esfera ESCOLHIDA, para o desempate contra
   * outros inimigos continuar coerente.
   *
   * @returns {{parte:string, distance:number, centro:THREE.Vector3}|null}
   */
  _raycastDrone(e, origin, dir, maxDist) {
    /* ATENCAO ao temporario: `_raioEsfera` usa `_v2` por dentro. Montar o
     * centro da esfera em `_v2` e passa-lo adiante faz o proprio teste destruir
     * o centro antes de ele ser guardado — a normal do impacto sairia calculada
     * a partir de lixo. Por isso o centro mora em `_dc`, que ninguem mais toca. */
    const env = PARTES_DRONE[PARTES_DRONE.length - 1];
    _dc.set(env.x, env.y, env.z).applyQuaternion(e.corpo.quaternion).add(e.pos);
    if (this._raioEsfera(origin, dir, _dc, env.raio) < 0) return null;

    let escolhida = null;
    for (const p of PARTES_DRONE) {
      _dc.set(p.x, p.y, p.z).applyQuaternion(e.corpo.quaternion).add(e.pos);
      const t = this._raioEsfera(origin, dir, _dc, p.raio);
      if (t < 0 || t > maxDist) continue;
      if (!escolhida || p.mult > escolhida.mult) {
        escolhida = { parte: p.parte, distance: t, mult: p.mult, centro: _pa.copy(_dc) };
      }
    }
    return escolhida;
  }

  /**
   * Aplica dano a um inimigo.
   *
   * ACEITA DUAS FORMAS DE CHAMADA, e isso nao e capricho — era um defeito:
   *
   *   damageEnemy(id, dano, ponto, parte, arma)          <- forma posicional
   *   damageEnemy(id, dano, { point, part, headshot, ... }) <- forma de payload
   *
   * `WeaponSystem._damageEnemy` sempre chamou a SEGUNDA (`ai.damageEnemy(id,
   * dmg, payload)`) e este metodo so entendia a PRIMEIRA. Duas consequencias,
   * ambas silenciosas:
   *
   *  1. `parte` chegava `undefined`, entao `MULT_PARTE[undefined] ?? 1` valia
   *     1 SEMPRE. A hitbox de cabeca de 2,5x que o ARCHITECTURE.md especifica
   *     nunca foi aplicada por este caminho — e o `headMult` da arma tambem
   *     nao, porque do lado do PLAYER `headshot` e `part === 'head'` e a IA
   *     devolve `'cabeca'`. Ou seja: tiro na cabeca valia exatamente o mesmo
   *     que tiro na barriga.
   *  2. `ponto` chegava o OBJETO de payload, e `subVectors(payload, camera)`
   *     produz NaN (payload.x nao existe). Esse NaN ia para `soldado.flinch` e
   *     para `Ragdoll.impulso` como direcao do tiro.
   *
   * Achado ao ligar o drone: o `nucleo` dele (2,0x, a recompensa por mira
   * precisa contra um alvo pequeno) simplesmente nao existiria, porque depende
   * de `parte` chegar inteira. Nao da para entregar a hitbox de precisao e
   * deixar o cano dela entupido.
   *
   * A multiplicacao por parte fica de UM lado so — este. Do lado do PLAYER,
   * `PART_MULT` nao tem chave para os nomes que a IA usa (`cabeca`, `torso`,
   * `bracos`, `pernas`, `nucleo`, `casco`, `rotores`) e cai em `default: 1.0`,
   * entao nao ha dupla contagem.
   */
  damageEnemy(enemyId, damage, point, part, weapon) {
    const e = this.vivos.find((x) => x.id === enemyId);
    if (!e || !e.alive) return false;

    // Forma de payload: `point` e um objeto de dados, nao um Vector3.
    if (point && typeof point === 'object' && typeof point.x !== 'number') {
      const p = point;
      part = p.part ?? part;
      weapon = p.weapon ?? weapon;
      point = p.point ?? null;
    }

    _v.set(0, 0, 0);
    if (this.ctx.camera && point && typeof point.x === 'number') {
      _v.subVectors(point, this.ctx.camera.position);
      if (_v.lengthSq() > 1e-12) _v.normalize(); else _v.set(0, 0, 1);
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
    if (this._tSom > 0) this._tSom -= dt;

    const jog = this.ctx.player?.position;
    this._ficha = FICHAS_LOS;
    /* Os contadores fecham no FIM do `ai.update`, nao no comeco: `_ouviram` roda
     * de dentro do `Player.update()` (chega por evento de `weapon:fire` e
     * `player:footstep`), que corre ANTES da IA no laco do `main.js`. Zerar
     * aqui deixaria a rajada de audicao fora de qualquer conta. */
    this.raiosNoQuadro = this._raios + this._raiosSeg;
    this._giro++;
    this._marcarImportancia(jog);
    this.rotores?.comecar();
    let nDrones = 0, tensao = 0, maisPerto = Infinity;
    _enx.set(0, 0, 0);

    for (let i = this.vivos.length - 1; i >= 0; i--) {
      const e = this.vivos[i];

      // Corpo velho: some e devolve a vaga do pool. Sem isto o pool esgota
      // (`ativo` continuava true para sempre) e `_ocupado` bloquearia o mapa.
      if (e.morto && e.tEstado > e.vidaDoCorpo) {
        e.despawn();
        this.vivos.splice(i, 1);
        continue;
      }

      if (e.morto) {
        e.update(dt);
        // carcaca caindo ainda tem helice girando por inercia
        if (e.eDrone && e.corpo.visible) this.rotores?.adicionar(e.corpo, e.giroHelice);
        continue;
      }

      // LOD: longe pensa a 5Hz. O ragdoll e a animacao seguem cheios.
      const dist = e._dist ?? (jog ? e.pos.distanceTo(jog) : 0);
      /* Ritmo da pose do esqueleto e sombra da arma, pelo mesmo peso que rege o
       * orcamento de raios. Ver `_marcarImportancia`. */
      if (!e.eDrone) this._lodDoSoldado(e);
      let passo = dt;
      if (dist > DIST_LOD) {
        e._lento += dt;
        if (e._lento < 0.2) {
          /* O hostil de chao ainda anima o esqueleto no quadro "pulado" (a
           * animacao e barata e sem ela ele patina). O drone nao tem animacao
           * de esqueleto: ele so precisa nao sumir do lugar, e a pose e escrita
           * dentro do `update` cheio. Entao aqui ele so mantem a helice. */
          if (e.eDrone) this.rotores?.adicionar(e.corpo, e.giroHelice);
          else e.soldado.update(dt);
          if (e.eDrone) { nDrones++; _enx.add(e.pos); if (dist < maisPerto) maisPerto = dist; }
          continue;
        }
        passo = e._lento;
        e._lento = 0;
      }

      /* Ficha de linha de visada: SEM MUDANCA, de proposito.
       *
       * A tentativa de reservar fichas para quem tem peso >= 2 parecia gratis
       * (o total continua sendo `FICHAS_LOS`), mas mexe em QUEM enxerga e quando,
       * e isso e comportamento de combate, nao desempenho — o teto de 6 ja
       * limitava o custo antes e continua limitando. Nao ha um ms a ganhar
       * aqui, e ha jogo a perder. Fica como estava. */
      const temFicha = this._ficha > 0;
      if (temFicha) this._ficha--;
      e.update(passo, temFicha);

      if (e.eDrone) {
        this.rotores?.adicionar(e.corpo, e.giroHelice);
        nDrones++;
        _enx.add(e.pos);
        if (dist < maisPerto) maisPerto = dist;
        // tensao do enxame = quantos ja estao comprometidos com o tiro
        if (e.ocupaVagaDeFogo) tensao += 1;
      }
    }

    this.rotores?.terminar();
    this._zumbir(nDrones, _enx, maisPerto, tensao);

    // Ondas: repoe inimigos conforme o jogador limpa.
    if (this.spawnAutomatico && this.ctx.state === 'jogando') {
      this._tOnda -= dt;
      // Contagem sem `filter`: array novo por quadro, e este laco roda sempre.
      let ativos = 0;
      for (let i = 0; i < this.vivos.length; i++) if (this.vivos[i].alive) ativos++;
      if (ativos < 4 && this._tOnda <= 0) {
        this.spawnOnda(Math.min(4, this.maxVivos - ativos));
        this._tOnda = 8 + Math.random() * 6;
      }
    }

    /* Fecha o quadro do orcamento. Ver a nota no topo do metodo. */
    this._raios = 0;
    this._raiosSeg = 0;
    this.raiosNegados = 0;

    void elapsed;
  }

  /* ------------------------------------------------------------------ */
  /* LOD e orcamento de raios                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Uma passada por quadro que escreve, em cada agente vivo:
   *
   *   `e._dist`     distancia ao jogador
   *   `e._naTela`   se a esfera dele intersecta o frustum da camera
   *   `e._peso`     0..3 — quanto ele merece do quadro
   *   `e._passo`    de quantos em quantos quadros ele pode gastar raio de luxo
   *
   * O criterio e distancia E visibilidade, nas duas pontas: um hostil a 8 m
   * atras da sua cabeca continua importante (ele vai te matar), um a 45 m na
   * sua frente continua importante (voce esta olhando para ele), e um a 45 m
   * fora da tela nao e importante para nada. So a distancia erra os dois casos.
   *
   * Isto NAO reduz o bando: todo mundo continua vivo, pensando e atirando. O
   * que muda e a TAXA de reamostragem do que e caro, e so para quem esta longe
   * E fora da tela.
   */
  _marcarImportancia(jog) {
    const cam = this.ctx.camera;
    let temFrustum = false;
    if (cam) {
      cam.updateMatrixWorld();
      this._matFrustum.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._matFrustum);
      temFrustum = true;
    }
    let nQuentes = 0;
    for (let i = 0; i < this.vivos.length; i++) {
      const e = this.vivos[i];
      if (!e.alive) { e._peso = 0; continue; }
      const d = jog ? e.pos.distanceTo(jog) : 0;
      e._dist = d;
      let naTela = true;
      if (temFrustum) {
        _dc.copy(e.pos);
        if (!e.eDrone) _dc.y += ALTURA_CENTRO;
        _esfera.center.copy(_dc);
        _esfera.radius = e.eDrone ? 0.9 : RAIO_GROSSO;
        naTela = this._frustum.intersectsSphere(_esfera);
      }
      e._naTela = naTela;
      /* 3 = colado / 2 = perto ou na tela / 1 = longe mas na tela / 0 = longe e
       * fora da tela. Quem esta em `ATIRAR`/`PAIRAR` nunca cai abaixo de 2:
       * degradar a taxa de quem esta atirando em voce e o unico jeito de o LOD
       * virar defeito de jogo. */
      let p = 0;
      if (d < DIST_PERTO) p = 3;
      else if (naTela) p = d < DIST_LOD ? 2 : 1;
      else p = d < DIST_LOD ? 1 : 0;
      if (e.ocupaVagaDeFogo && p < 2) p = 2;
      e._peso = p;
      if (p >= 2) nQuentes++;
      /* `_passo` rege so o que e CONFORTO (sonda rotativa do voo). Quem esta na
       * tela ou a menos de 38 m sonda todo quadro; so o invisivel a distancia
       * alterna. Foi medido: cortar mais que isso vira defeito de voo. */
      e._passo = p >= 1 ? 1 : 2;
      e._minhaVez = ((this._giro + (e.id | 0)) % e._passo) === 0;
    }
    this._quentes = nQuentes;
  }

  /**
   * LOD de DESENHO e de animacao do hostil de chao.
   *
   * MEDIDO (`tools/miolo.mjs`, regressao sobre 16 180 quadros):
   *
   *   render = 4,58 ms + **0,282 ms por hostil de chao** + 0,091 ms por drone
   *
   * O hostil de chao custa 2,9x o drone no `engine.render`, e mais no `render`
   * do que no `ai.update` inteiro (0,282 contra ~0,09). A causa e estrutural e
   * mora aqui: cada `Soldier` sao DOIS objetos de desenho (corpo com skinning +
   * arma), os dois com `castShadow` e — ate agora — `frustumCulled = false`.
   * Com 4 cascatas de sombra isso da **10 submissoes de desenho por hostil por
   * quadro, sem culling nenhum, mesmo com ele atras da camera**.
   *
   * Duas alavancas, nesta ordem de seguranca:
   *
   * 1. **Culling de verdade** (feito no `Soldier`/`Drone`, com esfera
   *    envolvente escrita a mao). Nao custa qualidade nenhuma: o objeto so
   *    deixa de ser submetido quando esta comprovadamente fora do volume.
   * 2. **Sombra da ARMA some alem de `DIST_ARMA_SOMBRA`.** Sao 4 desenhos de
   *    cascata por hostil. O QUE SE PERDE: a sombra propria do fuzil a mais de
   *    16 m — uma faixa de 1 a 3 texels que cai quase sempre dentro da sombra
   *    do proprio corpo. A sombra do CORPO nunca e desligada, em distancia
   *    nenhuma: e ela que da contato com o chao, e sem contato tudo flutua
   *    (CRITICA.md, criterio 2).
   *
   * E a animacao: `Soldier.update` custa 0,70 ms de p50 com 14 em campo (metade
   * do `ai.update` inteiro). Quem esta longe E fora da tela resolve a pose a
   * cada 3 quadros (20 Hz) em vez de 60, com o `dt` somado — a fase do ciclo de
   * passo continua correta, so a reamostragem cai. Quem esta na tela, perto ou
   * atirando resolve todo quadro, como antes.
   */
  _lodDoSoldado(e) {
    const s = e.soldado;
    if (!s) return;
    const p = e._peso ?? 3;
    s.ritmoPose = p >= 2 ? 1 : (p === 1 ? 2 : 3);
    const sombraArma = (e._dist ?? 0) < DIST_ARMA_SOMBRA;
    if (s.arma && s.arma.castShadow !== sombraArma) s.arma.castShadow = sombraArma;
  }

  /**
   * Ficha de raio do quadro.
   *
   * @param {number} prio 0 conforto · 1 normal · 2 SEGURANCA (nunca negada)
   * @returns {boolean} se pode atirar o raio
   *
   * Prioridade 2 existe para um caso so, e ele foi caro de resolver: a
   * depenetracao do drone (`sphereCast` com `maxDist 0`). Sem ela o drone
   * QUASE PARADO encostado num muro termina o quadro com o corpo dentro da
   * parede, e isso fica na tela — ao contrario de um clipe de passagem
   * (ver NOTES [AI] secao 3: foi a depenetracao que levou as amostras
   * penetrando de 20 para 1-2 em 900). Nenhum orcamento pode negar isso.
   */
  pedirRaio(prio = 1) {
    /* Raio de SEGURANCA nao consome o teto — ele tem contador proprio.
     *
     * MEDIDO NA MARRA: na primeira versao ele consumia, e o resultado foi uma
     * regressao de comportamento, nao de desempenho. Os raios de seguranca do
     * voo (varredura + depenetracao) sao gastos DENTRO do `e.update()` de cada
     * agente; com 10 drones eles enchiam o teto de 30 antes de a metade da
     * lista pedir ficha de linha de visada, e o `tools/drone.mjs` acusou
     * **9 de 14 drones "NUNCA viu o jogador"** e **zero janelas de tiro em 90 s**
     * com 10 drones parados em `alerta`. Um orcamento que faz o inimigo ficar
     * cego nao e orcamento, e defeito.
     *
     * A conta certa: o teto limita o que e DISCRICIONARIO (conforto de voo,
     * sonda de chao de quem esta longe, oclusao de som de quem esta longe). O
     * que e seguranca de corpo e o que e linha de visada tem reserva propria e
     * limite proprio — a linha de visada sempre teve (`FICHAS_LOS`). */
    if (prio >= PRIO_SEGURANCA) { this._raiosSeg++; return true; }
    if (this._raios >= this.tetoRaios) { this.raiosNegados++; return false; }
    this._raios++;
    return true;
  }

  /**
   * Zumbido do enxame — UMA voz para N drones.
   *
   * Este e o ponto em que um enxame estoura o orcamento de audio se for feito
   * do jeito obvio. O `AudioEngine` tem teto de 48 vozes posicionadas e ja
   * descarta ~44% dos pedidos com 12 hostis a 600 rpm (medido, ver o cabecalho
   * dele). Dar a cada drone um zumbido proprio, em loop, seriam 10 vozes
   * PERMANENTEMENTE ocupadas — vozes que nunca terminam e portanto nunca
   * liberam a cadeia, comendo um quinto do pool o tempo todo, contra sons que
   * duram 200 ms. O descarte de tiro e impacto iria as alturas e o jogador
   * perderia justamente a informacao de combate para ouvir um zunido.
   *
   * A saida e admitir que um enxame nao SOA como dez drones: soa como uma massa
   * unica que muda de tom e de lugar. Entao e uma voz so, permanente, fora do
   * pool (como o vento do ambiente), posicionada no CENTROIDE do enxame e
   * modulada por quantos sao, quao perto esta o mais proximo e quantos ja estao
   * comprometidos com o tiro. Custo: fixo, independente do tamanho do enxame.
   *
   * O que se perde: nao da para localizar UM drone especifico pelo zumbido. O
   * que se ganha: da para localizar o enxame, e o telegrafo de investida
   * (`droneInvestida`) continua sendo som posicionado de verdade, um por drone
   * que ataca — e sao no maximo `maxAtiradores`, ou seja 3 ou 4.
   */
  _zumbir(n, soma, maisPerto, tensao) {
    const audio = this.ctx.audio;
    if (!audio?.zumbidoEnxame) return;
    if (n <= 0 || maisPerto > ALCANCE_ZUMBIDO) { audio.zumbidoEnxame(null, 0, 0, 0); return; }
    _enx.multiplyScalar(1 / n);
    void soma;
    audio.zumbidoEnxame(_enx, n, maisPerto, tensao);
  }

  setQuality(preset) {
    // Menos inimigos simultaneos em preset baixo.
    this.maxVivos = preset.particleScale <= 0.25 ? 6 : (preset.particleScale <= 0.5 ? 8 : 10);
  }

  estatisticas() {
    const vivos = this.vivos.filter((e) => e.alive);
    return {
      vivos: vivos.length,
      drones: vivos.filter((e) => e.eDrone).length,
      corpos: this.vivos.filter((e) => e.morto).length,
      pool: this.pool.length,
      poolSolo: this.poolSolo.length,
      poolDrone: this.poolDrone.length,
    };
  }

  dispose() {
    this.ctx.audio?.zumbidoEnxame?.(null, 0, 0, 0);
    for (const e of this.pool) e.dispose();
    this.pool.length = 0;
    this.poolSolo.length = 0;
    this.poolDrone.length = 0;
    this.vivos.length = 0;
    this.rotores?.dispose();
    this.rotores = null;
    disposeRecursosDrone();
    this.nav?.dispose();
    this.ctx.scene?.remove(this.grupo);
  }
}

export { MULT_PARTE };
export default AIManager;
