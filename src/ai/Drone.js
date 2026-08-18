/**
 * Drone — o batedor aereo da AGI. Voa, mapeia, e atira quando precisa.
 *
 * FICCAO (HISTORIA.md). O Cantagalo e o unico setor que a malha nunca fechou
 * porque nunca conseguiu MAPEAR: viela que nao esta em planta nenhuma, laje que
 * virou rua, casa que e tres casas. Onde o mapa falha, o algoritmo erra. O drone
 * e a resposta dela a isso — um olho que nao depende de planta, que entra no
 * beco por cima e desenha o que ve. Ele nao e "mais um inimigo com asas": ele e
 * a tentativa da malha de resolver o unico problema que a impede de vencer.
 *
 * Por isso ele PAIRA. Um bicho que so passa voando nao mapeia nada.
 *
 * ---------------------------------------------------------------------------
 * JUSTICA — por que este inimigo e construido assim e nao de outro jeito
 * ---------------------------------------------------------------------------
 * Alvo pequeno, rapido e no ar e a receita mais curta para frustracao num FPS.
 * Quatro decisoes existem so para desarmar isso, e nenhuma delas e "baixar o
 * dano":
 *
 *  1. ELE PARA ANTES DE ATIRAR. `PAIRAR` e um estado de verdade, de ~1,0 s, em
 *     que a velocidade e freada a quase zero a 10-16 m do jogador. Essa e a
 *     janela de tiro, e ela existe TODA vez — nao ha caminho para `ATIRAR` que
 *     nao passe por `PAIRAR`. O ciclo completo (pairar, rajada, reposicionar)
 *     dura ~4 s, entao o jogador recebe uma janela de alvo parado a cada 4 s.
 *  2. A INVESTIDA E TELEGRAFADA, nos dois sentidos. Som: um chiado ascendente
 *     no instante em que ele trava (`audio.droneInvestida`). Imagem: a fenda
 *     optica sai do ciano fixo e passa a PULSAR, e o pulso acelera ate o tiro.
 *     Quem olha para o drone sabe que vem tiro; quem esta de costas ouve.
 *  3. A HITBOX E GENEROSA DE PROPOSITO. Uma esfera envolvente de 42 cm cobre o
 *     drone inteiro, inclusive o ar entre os bracos — o corpo real tem 13 cm de
 *     altura, e acertar isso em voo com mira de fuzil seria tiro de sorte. A
 *     generosidade e so no ENVELOPE: quem acerta o nucleo (13 cm) leva o dobro,
 *     entao precisao continua sendo recompensada.
 *  4. A VELOCIDADE CABE NA MIRA. Cruzeiro 6,5 m/s, reposicionamento 7,8 m/s. A
 *     10 m, 7,8 m/s de travessia sao 0,78 rad/s — dentro do que um jogador
 *     acompanha com mouse sem arrancar. Drone de 14 m/s a 8 m e 1,75 rad/s: dai
 *     para cima vira sorteio, nao mira.
 *
 * E ele NAO escapa do teto de atiradores simultaneos: `PAIRAR` e `ATIRAR` ambos
 * ocupam vaga de fogo (`AIManager.vagaDeFogo`). Um enxame de dez drones tem os
 * mesmos 3-4 canos apontados que qualquer outra onda; os outros seis ficam
 * cercando, que e pressao de POSICAO, nao parede de dano.
 *
 * ---------------------------------------------------------------------------
 * VOO — nao usa navGrid
 * ---------------------------------------------------------------------------
 * `world.navGrid` e uma grade 2D de andavel; nao serve para quem voa. O drone
 * tem direcao propria em 3D com desvio local por raycast contra a colisao.
 *
 * FAIXA DE ALTITUDE, e por que ela e BAIXA. O gato de fiacao do morro vive
 * entre ~4,5 m e ~8,5 m acima do chao (poste de 6,6-8,6 m, fio saindo a
 * `h - 0,5` com barriga de ate 1,8 m no meio do vao) e NAO esta na malha de
 * colisao — `Props.postesEFios` so registra o poste, nunca o fio. Ou seja:
 * nenhum raycast vai avisar o drone de que ha um fio na frente dele. A unica
 * defesa possivel e nao subir ate la. Por isso a faixa de cruzeiro e 2,6-4,4 m
 * sobre o chao LOCAL, teto duro em 5,4 m, e so um desvio de obstaculo pode
 * empurrar acima disso, por pouco tempo.
 *
 * Isso tambem e a escolha certa de jogo, nao so de bug: drone a 20 m de altura
 * nao ve beco nenhum, nao pertence ao morro e vira um ponto no ceu que ninguem
 * acerta. O lugar dele e DENTRO da viela, na altura do segundo andar.
 *
 * ARMADILHAS PAGAS (nao repita):
 *   - `collision.raycast` devolve SEMPRE o mesmo objeto. Ler `r.point` depois
 *     de disparar outro raio le o raio errado. Aqui todo resultado e consumido
 *     na hora.
 *   - Sondar o chao com `groundAt` (raio de y=200) acerta o TELHADO quando o
 *     drone esta sob um beiral ou dentro de um vao coberto, e o drone tenta
 *     "subir" para 3 m acima do telhado que esta em cima dele. A sonda daqui
 *     sai de pouco acima do proprio drone e desce, entao ela ve o piso que o
 *     drone tem embaixo, que e o que importa.
 *
 * Dono: agente AI.
 */
import * as THREE from 'three';
import { ESTADO, DIFICULDADE } from './Enemy.js';
import { Perception } from './Perception.js';
import { recursosDrone, definirGanhoEmissivo, sincronizarIBLDrone } from './DroneMalha.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _frente = new THREE.Vector3();
const _baixo = new THREE.Vector3(0, -1, 0);
const _cima = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

/**
 * Meia-volta entre o `yaw` LOGICO da IA e a orientacao da MALHA.
 *
 * As duas convencoes do projeto nao batem, e isto reconcilia as duas no unico
 * lugar onde a malha e girada:
 *
 *   - LOGICA: `Perception` recebe `_frente = (sin(yaw), 0, cos(yaw))`, que e o
 *     +Z local. `Enemy._apontar` e `Drone._apontar` escrevem
 *     `yawAlvo = atan2(alvo.x - pos.x, alvo.z - pos.z)`, e `spawnPerto` usa a
 *     mesma conta com o comentario "vira de frente para o jogador". Ou seja: no
 *     codigo, FRENTE = +Z local.
 *   - MALHA: o corpo e autorado com a cara em -Z (padrao Object3D) — no drone a
 *     fenda optica fica em z = -0,322 e o casulo do sensor em z = -0,248; no
 *     `Soldier` o nucleo aceso do peito esta em z = -0,150 e a barra de sinal
 *     das costas em z = +0,186.
 *
 * Sem o offset, o inimigo vira as COSTAS para quem ele esta olhando. Medido em
 * `tools/frente.mjs`: com o yaw de "virar de frente", o +Z local aponta para a
 * camera (0,25 / -0,97 contra um rumo de 1,3 / -5,0) e a foto mostra a traseira.
 *
 * Somar PI aqui — e nao mexer em `_frente` — e o caminho certo: a percepcao, a
 * mira, o giro do corpo e a varredura de vigia continuam com exatamente o
 * comportamento que ja foi medido, e so o desenho e reconciliado. Como
 * `posOlho()` e a boca do cano tambem derivam de `corpo.quaternion`, os dois
 * passam a sair do lado certo de graca.
 *
 * ATENCAO: o `Soldier` tem o MESMO desencontro e continua sem correcao — ver o
 * bloco [AI] no NOTES.md. Corrigi-lo exige revalidar o ciclo de caminhada e a
 * IK de mira, que nao cabia nesta tarefa.
 */
const OFFSET_MALHA = Math.PI;

/** Estados exclusivos do drone. Os demais vem de `ESTADO` (Enemy.js). */
export const ESTADO_DRONE = {
  PAIRAR: 'pairar',              // travado no ar, mirando — a JANELA DE TIRO
  REPOSICIONAR: 'reposicionar',  // arco lateral, nao atira
  QUEDA: 'queda',                // abatido, caindo
};

/* --- voo ---------------------------------------------------------------- */
const VEL_RONDA = 4.2;
const VEL_CRUZEIRO = 6.5;
const VEL_REPOSICIONAR = 7.8;
const ACEL = 9.0;                 // m/s^2 — resposta do controle de voo
const FREIO_PAIRAR = 7.5;         // desaceleracao ao travar para atirar
const ALT_ALVO = 3.2;             // metros acima do chao local
const ALT_MIN = 2.4;
const ALT_MAX = 4.2;
const ALT_TETO = 5.4;             // teto duro: acima disso comeca a fiacao
const GANHO_ALT = 2.6;            // quao forte o controle puxa para a faixa
const RAIO_CORPO = 0.42;          // envelope de colisao/acerto
const SEPARACAO = 2.6;            // metros entre dois drones em voo
const SONDA_FRENTE = 3.4;         // alcance da sonda de obstaculo (m)
const REPULSA_DECAI = 3.2;        // 1/s

/* --- combate ------------------------------------------------------------ */
const ALCANCE_TIRO = 26;          // curto de proposito: ele TEM de chegar perto
const DIST_PAIRAR = [10, 16];     // faixa em que ele trava para atirar
const T_PAIRAR = [0.85, 1.15];    // duracao da janela de tiro, em segundos
const TIROS_RAJADA = 3;
const CADENCIA_RAJADA = 0.15;     // s entre tiros da rajada
const T_REPOSICIONAR = [1.6, 2.6];
const FATOR_DANO = 0.55;          // do dano do perfil; rajada curta compensa
const VIDA_MAX = 70;              // 3 tiros de fuzil no casco, 2 no nucleo
/** Segundos que a carcaca fica no chao antes de liberar a vaga do pool. */
const VIDA_DO_CORPO = 14;

/**
 * Hitboxes: esferas em espaco local do drone.
 *
 * NAO sao testadas por proximidade ao longo do raio, e sim por PRIORIDADE (ver
 * `AIManager._raycastDrone`). As tres se contem umas as outras: a envolvente e
 * sempre a primeira que o raio encontra, entao ordenar por distancia faria o
 * nucleo nunca ser acertado e a mira precisa nao valeria nada.
 */
export const PARTES_DRONE = [
  { parte: 'nucleo', x: 0, y: 0.11, z: -0.02, raio: 0.135, mult: 2.0 },
  { parte: 'casco', x: 0, y: 0.00, z: -0.04, raio: 0.255, mult: 1.0 },
  { parte: 'rotores', x: 0, y: 0.02, z: 0.00, raio: RAIO_CORPO, mult: 0.65 },
];

let proximoId = 9000;

export class Drone {
  constructor(ctx) {
    this.ctx = ctx;
    this.id = proximoId++;
    this.eDrone = true;
    this.ativo = false;

    const rec = recursosDrone();
    this.corpo = new THREE.Mesh(rec.geo, rec.material);
    this.corpo.name = 'drone';
    this.corpo.castShadow = true;
    this.corpo.receiveShadow = true;
    this.corpo.frustumCulled = false;
    this.corpo.visible = false;
    /* O pulso do telegrafo entra por uniform, escrito imediatamente antes do
     * draw DESTE drone. `onBeforeRender` e o unico gancho por objeto que o
     * three oferece com o material ja selecionado — e por isso que um uniform
     * compartilhado consegue carregar um valor diferente por drone. */
    this.corpo.onBeforeRender = () => definirGanhoEmissivo(1 + this.pulsoTelegrafo * 1.5);

    this.percepcao = new Perception(ctx, this);
    /* Camera em gimbal, nao cabeca dentro de capacete: o cone e mais largo e o
     * alcance maior porque ele esta ALTO. Isso nao e onisciencia — ele continua
     * dependendo de linha de visada, continua sem saber onde o alvo esta quando
     * o perde, e nao consegue atirar antes de descer para 26 m. Enxergar longe
     * so decide para onde ele VOA. */
    this.percepcao.fov = 130 * Math.PI / 180;
    this.percepcao.alcance = 52;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.yawAlvo = 0;
    this.rolagem = 0;
    this.arfagem = 0;

    this.vidaMax = VIDA_MAX;
    this.vida = VIDA_MAX;
    this.morto = false;
    this.estado = ESTADO.PATRULHA;
    this.tEstado = 0;
    this.vidaDoCorpo = VIDA_DO_CORPO;

    /* Perfil PADRAO, como o `Enemy` ja tinha. A `Progressao` sobrescreve por
     * onda, mas quem instancia direto (ferramenta de medicao, cena de teste)
     * nao passa por ela.
     *
     * MEDIDO com `dif = null`: `_atirar` saia no primeiro `if`, `_naRajada`
     * nunca subia, e o drone ficava preso em ATIRAR PARA SEMPRE — censo com
     * `atirar: 3` constante por 90 s e ZERO tiros disparados. Pior: os tres
     * seguravam as tres vagas de fogo permanentemente, entao nenhum outro drone
     * chegava a atacar. O bug se disfarcava de "teto de atiradores funcionando". */
    this.dif = DIFICULDADE.normal;
    this._lento = 0;               // contador de LOD (contrato do AIManager)

    this.patrulha = [];
    this.iPatrulha = 0;
    this.destino = new THREE.Vector3();
    this.temDestino = false;

    // voo
    this._alvoVoo = new THREE.Vector3();
    this._repulsa = new THREE.Vector3();
    this._iSonda = 0;
    this._chaoY = 0;
    this._temChao = false;
    this._giroHelice = Math.random() * 6.283;
    this._bob = Math.random() * 6.283;
    this._tTravado = 0;
    this._ultimoPonto = new THREE.Vector3();

    // combate
    this._tReacao = 0;
    this._tPairar = 0;
    this._naRajada = 0;
    this._tProxTiro = 0;
    this._erro = 0.1;
    this._ladoArco = Math.random() < 0.5 ? 1 : -1;
    this._alertouEsquadrao = false;
    this._pulso = 0;               // 0..1, brilho extra da fenda no telegrafo
    /* 0..1 — quanto ele esta 'espiando': sobe e fecha distancia quando perde
     * a visada. Ver o bloco de PERSEGUIR. */
    this._espiar = 0;

    // queda
    this._velQueda = 0;
    this._giroQueda = new THREE.Vector3();
  }

  /* ------------------------------------------------------------------ */
  /* Contrato compartilhado com Enemy                                    */
  /* ------------------------------------------------------------------ */

  get alive() { return this.ativo && !this.morto; }
  get position() { return this.pos; }
  get eyePosition() { return this.posOlho(new THREE.Vector3()); }
  /** Objeto de cena que o AIManager pendura no grupo da IA. */
  get objeto3d() { return this.corpo; }
  /** Ocupa uma das vagas do teto de atiradores simultaneos? */
  get ocupaVagaDeFogo() {
    return this.estado === ESTADO_DRONE.PAIRAR || this.estado === ESTADO.ATIRAR;
  }
  /** Compatibilidade com quem le `e.atirando` (mapa do TAB, minimapa). */
  get atirando() { return this.estado === ESTADO.ATIRAR; }

  /** Onde ficam os "olhos": a fenda optica, no nariz. */
  posOlho(out = _v3) {
    return out.set(0, 0.006, -0.32).applyQuaternion(this.corpo.quaternion).add(this.pos);
  }

  _trocar(novo) {
    if (this.estado === novo) return;
    this.estado = novo;
    this.tEstado = 0;
  }

  /* ------------------------------------------------------------------ */

  spawn(pos, yaw = 0, patrulha = null) {
    this.pos.copy(pos);
    /* Nasce JA no ar, na faixa de cruzeiro. Nascer no chao e subir daria um
     * segundo de drone brotando do asfalto, que le como bug de spawn. */
    this.pos.y = this._sondarChao(pos.x, pos.y + 2.0, pos.z) + ALT_ALVO;
    this.vel.set(0, 0, 0);
    this.yaw = this.yawAlvo = yaw;
    this.rolagem = 0;
    this.arfagem = 0;
    this.vida = this.vidaMax;
    this.morto = false;
    this.ativo = true;
    this.temDestino = false;
    this._repulsa.set(0, 0, 0);
    this._tTravado = 0;
    this._ultimoPonto.copy(this.pos);
    this._naRajada = 0;
    this._tReacao = 0;
    this._pulso = 0;
    this._espiar = 0;
    this._alertouEsquadrao = false;
    this._velQueda = 0;
    this.percepcao.reset();
    this.corpo.visible = true;
    this.corpo.position.copy(this.pos);
    this.corpo.rotation.set(0, yaw + OFFSET_MALHA, 0);
    this.corpo.quaternion.setFromEuler(this.corpo.rotation);

    this.patrulha = (patrulha && patrulha.length) ? patrulha : this._rotaLocal(this.pos);
    this.iPatrulha = 0;
    this._trocar(ESTADO.PATRULHA);
  }

  despawn() {
    this.ativo = false;
    this.corpo.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* Dano                                                                */
  /* ------------------------------------------------------------------ */

  levarDano(dano, ponto, parte, dirTiro) {
    if (this.morto) return false;
    const p = PARTES_DRONE.find((x) => x.parte === parte);
    const total = dano * (p?.mult ?? 1);
    this.vida -= total;

    this.ctx.bus?.emit('enemy:damaged', {
      enemyId: this.id, damage: total, point: ponto,
      headshot: parte === 'nucleo',
      /* Marca de MAQUINA QUE VOA: o AudioEngine usa para nao soltar grito
       * humano em cima do drone (ficcao) e para nao sintetizar ~12 nos ao vivo
       * a cada acerto num enxame (custo). */
      eDrone: true,
    });

    if (this.vida <= 0) { this._morrer(ponto, dirTiro); return true; }

    /* Levar tiro sempre revela o atirador — senao o jogador derruba o enxame
     * inteiro um a um sem nunca ser notado. E o empurrao do impacto: um corpo
     * de 3 kg no ar reage ao tiro, e essa sacudida e o retorno visual de acerto
     * que substitui o flinch de esqueleto que o drone nao tem. */
    const alvo = this.ctx.player;
    if (alvo?.position) this.percepcao.avisar(alvo.position, 1.0);
    if (dirTiro) {
      this.vel.addScaledVector(dirTiro, 1.3);
      this._giroQueda.x += (Math.random() - 0.5) * 2.2;
      this._giroQueda.z += (Math.random() - 0.5) * 2.2;
    }
    if (this.estado === ESTADO.PATRULHA || this.estado === ESTADO.OCIOSO) {
      this._trocar(ESTADO.ALERTA);
    }
    return false;
  }

  /**
   * Abatido.
   *
   * `enemy:killed` sai com `point` NO CHAO sob o drone, e nao onde a bala
   * pegou. Nao e detalhe: `Pickups._assentarNoChao` desce o item por um raio de
   * 4 m a partir do ponto do evento, e um drone abatido a 4,5 m de altura
   * deixaria a municao boiando no ar, fora da linha de visao de quem chega
   * olhando para o chao. O mesmo ponto serve ao FX, que passa a estourar a
   * poeira onde a carcaca de fato cai.
   */
  _morrer(ponto, dirTiro) {
    this.morto = true;
    this._trocar(ESTADO_DRONE.QUEDA);
    this._velQueda = Math.min(0, this.vel.y);
    this._giroQueda.set(
      (Math.random() - 0.5) * 5.5, (Math.random() - 0.5) * 4.0, (Math.random() - 0.5) * 5.5,
    );
    if (dirTiro) this.vel.addScaledVector(dirTiro, 2.2);
    this.vel.y = Math.min(this.vel.y, 0.6);

    const chao = this._sondarChao(this.pos.x, this.pos.y + 0.5, this.pos.z);
    _v.set(this.pos.x, Number.isFinite(chao) ? chao : this.pos.y, this.pos.z);

    this.ctx.bus?.emit('enemy:killed', {
      enemyId: this.id, headshot: false,
      weapon: this.ctx.player?.weaponSystem?.current?.id ?? null,
      point: _v.clone(),
      eDrone: true,
    });
    this.ctx.audio?.droneQueda?.(this.pos);
    void ponto;
  }

  /* ------------------------------------------------------------------ */
  /* Update                                                              */
  /* ------------------------------------------------------------------ */

  update(dt, temOrcamento = true) {
    if (!this.ativo) return;
    sincronizarIBLDrone(this.ctx);
    this.tEstado += dt;

    if (this.morto) { this._cair(dt); return; }

    const alvo = this.ctx.player;
    this.posOlho(_v3);
    _frente.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.percepcao.update(dt, _v3, _frente, alvo, temOrcamento);

    this._pensar(dt, alvo);
    this._mover(dt);
    this._apontar(dt, alvo);
    this._pose(dt);
  }

  /* --- decisao --- */
  _pensar(dt, alvo) {
    const P = this.percepcao;
    const temAlvo = alvo && alvo.alive !== false;
    /* `_espiar` so e ALIMENTADO em PERSEGUIR; aqui ele desce em qualquer outro
     * estado. Decai em vez de zerar de uma vez porque ele mexe na altitude de
     * voo, e altura que cai de golpe le como o drone despencando. */
    if (this.estado !== ESTADO.PERSEGUIR) {
      this._espiar = Math.max(0, this._espiar - dt * 1.2);
    }

    switch (this.estado) {
      case ESTADO.OCIOSO:
      case ESTADO.PATRULHA:
        if (P.suspeito) {
          /* LARGA A ROTA DE RONDA NA HORA.
           *
           * Sem esta linha o drone entrava em SUSPEITO carregando o destino
           * ANTERIOR — o ponto de patrulha para onde ele já estava indo — e o
           * bloco de SUSPEITO só troca de destino depois de `chegou`. Ou seja:
           * ele ouvia alguma coisa e continuava a ronda até o fim do trecho
           * antes de ir investigar. Com um ponto de ronda a 40 m e o teto de
           * 20 s de suspeita, ele DESISTIA antes de sequer começar a andar na
           * direção certa. MEDIDO: 10 de 10 drones de um enxame terminaram 90 s
           * em `patrulha`, com ZERO janelas de tiro e ZERO tiros. */
          this.temDestino = false;
          this._trocar(ESTADO.SUSPEITO);
          break;
        }
        if (!this.temDestino || this._chegou(2.4)) this._proximoPontoPatrulha();
        break;

      case ESTADO.SUSPEITO: {
        if (P.alerta) { this._trocar(ESTADO.ALERTA); break; }
        const chegou = this.temDestino && this._chegou(3.0);
        /* Mesma paciencia do hostil de chao: desiste quando CHEGOU e olhou, ou
         * depois de 20 s. Desistir porque a barra de consciencia secou fazia o
         * reforco dar meia-volta a 20 m do alvo (ver NOTES [AI]). */
        if ((chegou && this.tEstado > 2.6) || this.tEstado > 20) {
          this._trocar(ESTADO.PATRULHA);
          break;
        }
        if (!this.temDestino || chegou) {
          const p = P.temSom ? P.origemSom : (P.temUltima ? P.ultimaPos : null);
          if (p) this._irPara(p);
        }
        break;
      }

      case ESTADO.ALERTA:
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        if (this._tReacao <= 0) {
          const [a, b] = this.dif?.reacao ?? [0.3, 0.6];
          this._tReacao = a + Math.random() * (b - a);
          this._erro = this.dif?.erro0 ?? 0.1;
          if (!this._alertouEsquadrao) {
            this._alertouEsquadrao = true;
            const onde = P.temUltima ? P.ultimaPos : alvo.position;
            this.ctx.ai?.alertarProximos?.(this, onde, 26);
          }
        }
        this._tReacao -= dt;
        if (this._tReacao <= 0) this._trocar(ESTADO.PERSEGUIR);
        break;

      case ESTADO.PERSEGUIR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        /* Aproxima ate a faixa de parada. So trava (e so ai atira) quando esta
         * dentro da faixa E com visada — nunca de surpresa, nunca de longe. */
        const d = P.distAlvo;
        if (P.visivel && d < DIST_PAIRAR[1] && d > DIST_PAIRAR[0] * 0.55) {
          if (this.ctx.ai?.vagaDeFogo?.(this) === false) {
            this._trocar(ESTADO_DRONE.REPOSICIONAR);
            break;
          }
          const [t0, t1] = T_PAIRAR;
          this._tPairar = t0 + Math.random() * (t1 - t0);
          this._trocar(ESTADO_DRONE.PAIRAR);
          this.ctx.audio?.droneInvestida?.(this.pos);
          break;
        }
        /* CEGO NA PERSEGUICAO: sobe para espiar e fecha a distancia.
         *
         * Antes ele parava na faixa de parada (13 m) e ficava la esperando ver.
         * Se houvesse casa no meio, nunca via — e voltava a patrulhar sem
         * nunca ter encontrado ninguem. MEDIDO: 4 de 12 tentativas de TTK
         * terminaram com `estado=patrulha, consciencia=0, NUNCA visto`, com o
         * drone a 18-24 m do jogador. Um terco das aproximacoes simplesmente
         * nao acontecia.
         *
         * A correcao e a propria razao de o bicho existir. A malha nunca
         * mapeou o morro porque o morro tem parede onde a planta diz rua; a
         * resposta dela e uma coisa que SOBE E OLHA POR CIMA. Aqui isso e
         * literal: quanto mais tempo sem ver, mais alto ele voa (ate +2,0 m,
         * ainda abaixo do teto da fiacao) e mais perto ele chega (ate 6,5 m).
         * Nao e mais informacao — ele continua sem saber onde o alvo esta —,
         * e mais ESFORCO para conseguir a informacao. */
        /* O relogio da desistencia e o TEMPO NESTE ESTADO, nao `tempoSemVer`.
         *
         * `tempoSemVer` nasce em 999 e so zera quando o alvo e de fato
         * avistado. Um drone alertado apenas por SOM — que e o caso normal:
         * `weapon:fire` chega a 70 m — entra em PERSEGUIR ja com
         * `tempoSemVer = 999`, satisfaz a condicao de desistencia no PRIMEIRO
         * quadro e cai em SUSPEITO. La `P.alerta` ainda esta valendo (o tiro
         * seguinte renova), entao ele volta para ALERTA, espera a reacao, entra
         * em PERSEGUIR e desiste de novo. MEDIDO: enxame de 10 preso nesse
         * ciclo, censo com `alerta: 9` estavel por 90 s, ZERO tiros — e o drone
         * parado no ar a 20 m, porque ALERTA nao escreve alvo de voo.
         *
         * Com `tEstado` a leitura vira a certa: "faz 14 s que persigo e nao
         * consegui ver" — que e o que deveria mandar rebaixar para investigar. */
        this._espiar = P.visivel ? 0 : Math.min(1, this.tEstado / 4.5);
        if (this.tEstado > 14 && !P.visivel) { this._trocar(ESTADO.SUSPEITO); break; }
        this._mirarNoAlvo(alvo, P);
        break;
      }

      case ESTADO_DRONE.PAIRAR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        /* JANELA DE TIRO. O drone esta praticamente parado; o alvo de voo e a
         * propria posicao, entao `_mover` so freia. A fenda pulsa cada vez mais
         * rapido — o telegrafo visual do que vem. */
        this._alvoVoo.copy(this.pos);
        this._pulso = Math.min(1, this.tEstado / Math.max(0.2, this._tPairar));
        if (!this.percepcao.visivel && this.percepcao.tempoSemVer > 0.6) {
          this._trocar(ESTADO.PERSEGUIR);
          break;
        }
        if (this.tEstado >= this._tPairar) {
          this._naRajada = 0;
          this._tProxTiro = 0;
          this._trocar(ESTADO.ATIRAR);
        }
        break;
      }

      case ESTADO.ATIRAR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        this._alvoVoo.copy(this.pos);     // continua travado durante a rajada
        this._pulso = 1;
        if (!this.percepcao.visivel && this.percepcao.tempoSemVer > 0.5) {
          this._trocar(ESTADO.PERSEGUIR);
          break;
        }
        this._atirar(dt, alvo);
        /* Sai por rajada cheia OU por tempo. O prazo nao e enfeite: com `dif`
         * ausente, `_atirar` saia cedo e o drone ficava preso aqui PARA SEMPRE,
         * segurando uma das tres vagas de fogo — dez drones em campo e nenhum
         * conseguia atacar, e o censo mostrava `atirar: 3` estavel, que parece
         * exatamente com o teto de atiradores funcionando. Estado de combate
         * sem prazo de validade e armadilha; este tem. */
        if (this._naRajada >= TIROS_RAJADA || this.tEstado > 1.4) {
          this._ladoArco = Math.random() < 0.5 ? 1 : -1;
          this._trocar(ESTADO_DRONE.REPOSICIONAR);
        }
        break;
      }

      case ESTADO_DRONE.REPOSICIONAR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        this._pulso = 0;
        /* Arco lateral em volta do alvo. Nao e fuga: ele continua olhando para
         * o jogador enquanto se desloca, e e isso que produz a leitura de
         * "estao me cercando" sem que ninguem esteja atirando a mais. */
        const [t0, t1] = T_REPOSICIONAR;
        if (!this._tArco) this._tArco = t0 + Math.random() * (t1 - t0);
        const base = this.percepcao.temUltima ? this.percepcao.ultimaPos : alvo.position;
        _dir.subVectors(this.pos, base).setY(0);
        const r = Math.max(6, Math.min(18, _dir.length()));
        const ang = Math.atan2(_dir.x, _dir.z) + this._ladoArco * 1.25;
        this._alvoVoo.set(
          base.x + Math.sin(ang) * r, this.pos.y, base.z + Math.cos(ang) * r,
        );
        this._corrigirAltitude(this._alvoVoo);
        if (this.tEstado > this._tArco) {
          this._tArco = 0;
          this._trocar(ESTADO.PERSEGUIR);
        }
        break;
      }
    }
  }

  /** Alvo de voo = ponto na faixa de parada, na direcao do jogador. */
  _mirarNoAlvo(alvo, P) {
    const base = P.temUltima ? P.ultimaPos : alvo.position;
    _dir.subVectors(this.pos, base).setY(0);
    const d = _dir.length();
    const meio = (DIST_PAIRAR[0] + DIST_PAIRAR[1]) * 0.5;
    // cego ha mais tempo => chega mais perto (ver o bloco de PERSEGUIR)
    const desejada = meio + (6.5 - meio) * this._espiar;
    if (d > 1e-3) _dir.divideScalar(d); else _dir.set(0, 0, 1);
    this._alvoVoo.copy(base).addScaledVector(_dir, desejada);
    /* Nao chega em linha reta: um leve deslocamento lateral que troca de lado
     * de vez em quando. Aproximacao perfeitamente radial le como trilho. */
    this._alvoVoo.x += Math.sin(this.tEstado * 0.9) * this._ladoArco * 2.2;
    this._alvoVoo.z += Math.cos(this.tEstado * 0.9) * this._ladoArco * 2.2;
    this._alvoVoo.y = this.pos.y;
    this._corrigirAltitude(this._alvoVoo);
  }

  /* --- tiro --- */
  _atirar(dt, alvo) {
    const dif = this.dif;
    if (!dif) return;
    this._erro += (dif.erroMin - this._erro) * Math.min(1, dt * dif.converge);
    this._tProxTiro -= dt;
    if (this._tProxTiro > 0) return;
    if (this._naRajada >= TIROS_RAJADA) return;
    this._naRajada++;
    this._tProxTiro = CADENCIA_RAJADA;

    // origem: sob o nariz, no casulo do sensor
    _v.set(0, -0.10, -0.30).applyQuaternion(this.corpo.quaternion).add(this.pos);

    _v2.copy(alvo.eyePosition ?? alvo.position);
    const velAlvo = alvo.movement?.velocity ?? alvo.velocity;
    if (velAlvo) {
      const bruta = _v2.distanceTo(_v) / 380;
      const lideranca = THREE.MathUtils.clamp(1 - dif.erroMin / 0.04, 0, 1);
      _v2.addScaledVector(velAlvo, bruta * 60 * lideranca * 0.55);
    }

    _dir.subVectors(_v2, _v);
    const dist = _dir.length();
    _dir.normalize();
    const e = this._erro;
    _dir.x += (Math.random() * 2 - 1) * e;
    _dir.y += (Math.random() * 2 - 1) * e * 0.8;
    _dir.z += (Math.random() * 2 - 1) * e;
    _dir.normalize();

    /* SÓ o evento. NÃO chamar `audio.tiro` aqui.
     *
     * `AudioEngine._assina` ja tem `bus.on('enemy:fire', p => this.tiro(...))`
     * desde sempre — e o hostil de chao, por isso, so emite o evento. Chamar o
     * audio TAMBEM produzia DOIS sons por disparo de drone, e som duplicado nao
     * aparece como "descarte alto": aparece como o dobro do custo de sintese
     * pelo mesmo evento, que e exatamente o que o cabecalho do AudioEngine
     * identifica como a causa do estalo.
     *
     * MEDIDO em `tools/audioenxame.mjs` com o enxame em campo e o jogador
     * atirando: 34 `enemy:fire` produziram 210 chamadas de `tiro()` quando o
     * esperado eram 176 — 34 a mais, uma por disparo de drone, exatas.
     *
     * `weapon` no payload existe para o timbre sair de SMG (banda mais alta,
     * cauda curta) e nao de fuzil: `familia()` mapeia 'smt40' -> 'smg'. Um
     * enxame com o mesmo estampido do fuzil do jogador vira lama na mixagem. */
    this.ctx.bus?.emit('enemy:fire', {
      enemyId: this.id, origin: _v.clone(), dir: _dir.clone(), weapon: 'smt40',
    });
    // coice: o corpo recua um tico a cada tiro (massa pequena, arma no nariz)
    this.vel.addScaledVector(_dir, -0.55);

    const col = this.ctx.world?.collision;
    let distParede = Infinity;
    if (col?.raycast) {
      const r = col.raycast(_v, _dir, Math.min(dist, ALCANCE_TIRO));
      // `r` e reaproveitado entre chamadas: consome agora.
      if (r?.hit) distParede = r.distance;
    }
    if (dist < distParede && dist < ALCANCE_TIRO) {
      _v2.copy(_v).addScaledVector(_dir, dist);
      const alvoPt = alvo.eyePosition ?? alvo.position;
      if (_v2.distanceTo(alvoPt) < 0.45) {
        /* Dano por tiro MENOR que o do fuzil de chao, e a rajada e de tres.
         * Um enxame de dez com dano cheio seria exatamente a "parede de dano"
         * que o teto de atiradores existe para impedir. */
        alvo.takeDamage?.((dif.dano ?? 10) * FATOR_DANO, _dir);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Voo                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Sonda o piso sob (x, z) a partir de `deY`, descendo.
   *
   * NAO usar `collision.groundAt`, que desce de y=200: sob um beiral ou dentro
   * de um vao coberto ele acerta o TELHADO, e o drone passa a querer voar 3 m
   * acima do telhado que esta em cima dele — sobe, bate, desce, repete.
   */
  _sondarChao(x, deY, z) {
    const col = this.ctx.world?.collision;
    if (!col?.raycast) return 0;
    _v.set(x, deY, z);
    const r = col.raycast(_v, _baixo, 42);
    return (r?.hit && Number.isFinite(r.point.y)) ? r.point.y : (this._temChao ? this._chaoY : 0);
  }

  /** Puxa a componente Y de um ponto de destino para dentro da faixa de voo. */
  _corrigirAltitude(ponto) {
    const chao = this._temChao ? this._chaoY : this._sondarChao(ponto.x, ponto.y + 1.0, ponto.z);
    ponto.y = chao + ALT_ALVO;
  }

  _mover(dt) {
    const col = this.ctx.world?.collision;

    /* --- 1. chao local (1 raio por quadro, sempre) --------------------- */
    this._chaoY = this._sondarChao(this.pos.x, this.pos.y + 0.8, this.pos.z);
    this._temChao = true;
    const alt = this.pos.y - this._chaoY;

    /* --- 2. velocidade desejada --------------------------------------- */
    const vMax = this.estado === ESTADO_DRONE.REPOSICIONAR ? VEL_REPOSICIONAR
      : this.estado === ESTADO.PATRULHA ? VEL_RONDA
        : (this.estado === ESTADO_DRONE.PAIRAR || this.estado === ESTADO.ATIRAR) ? 0
          : VEL_CRUZEIRO;

    /* A direcao para o destino e HORIZONTAL. Quem manda em Y e so o controle de
     * altitude, logo abaixo.
     *
     * MEDIDO (tools/drone.mjs, secao A): com o Y vindo tambem daqui, o destino
     * carregava a altura do chao de ONDE O DRONE ESTAVA, nao de onde ele ia
     * parar — `_corrigirAltitude` usa `_chaoY`, que e a sonda local. Num morro
     * com 36 m de desnivel isso e grave: indo da rua para uma laje alta, o alvo
     * de voo ficava METROS abaixo do piso do destino, e a componente Y do
     * rumo empurrava o drone para dentro da encosta o caminho inteiro. Percentil
     * 5 da altura caia para 1,71 m (a faixa pedida comeca em 2,4) e 5% das
     * amostras ficavam raspando na geometria.
     *
     * Separar os dois eixos resolve a familia inteira de casos de uma vez, e e
     * como um quadricoptero de verdade voa: navegacao no plano, altitude num
     * laco proprio que segue o terreno. */
    _v.subVectors(this._alvoVoo, this.pos);
    _v.y = 0;
    const dAlvo = _v.length();
    if (dAlvo > 1e-3) _v.divideScalar(dAlvo);
    // chega freando: sem isto ele passa do ponto e volta, oscilando
    const escala = Math.min(1, dAlvo / 2.5);
    _v.multiplyScalar(vMax * escala);

    /* --- 3. controle de altitude -------------------------------------- */
    /* Espiar sobe a faixa inteira, sem furar o teto da fiacao (3,2 + 2,0 =
     * 5,2 contra ALT_TETO 5,4). O drone que procura voa mais alto que o drone
     * que ja achou — e essa diferenca de altura le em jogo. */
    const subir = this._espiar * 2.0;
    let vy = (this._chaoY + ALT_ALVO + subir - this.pos.y) * GANHO_ALT * 0.55;
    if (alt < ALT_MIN) vy += (ALT_MIN - alt) * GANHO_ALT;
    else if (alt > ALT_MAX + subir) vy -= (alt - ALT_MAX - subir) * GANHO_ALT;
    /* Teto duro: acima de ALT_TETO comeca a fiacao, que NAO esta na colisao e
     * portanto nao pode ser desviada por raycast. A unica defesa e nao subir. */
    if (alt > ALT_TETO) vy -= (alt - ALT_TETO) * GANHO_ALT * 2.5;
    _v.y = THREE.MathUtils.clamp(vy, -4.5, 4.5);

    /* --- 4. desvio de obstaculo: UMA sonda por quadro, rotativa -------
     * Quatro direcoes em rodizio (frente, cima, e as duas diagonais da
     * frente). Sondar as quatro todo quadro custaria 4 raios x 12 drones = 48
     * raios por quadro so em desvio, dentro do mesmo orcamento em que a
     * percepcao dos hostis de chao ja disputa ficha. Como a repulsao DECAI em
     * vez de zerar, uma leitura por quadro a 60 Hz da 15 Hz por direcao — mais
     * que suficiente para um bicho de 6,5 m/s. */
    if (col?.raycast) {
      const sonda = this._iSonda = (this._iSonda + 1) & 3;
      _dir.copy(this.vel);
      if (_dir.lengthSq() < 0.25) _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      _dir.normalize();
      let alcance = SONDA_FRENTE;
      if (sonda === 1) { _dir.set(0, 1, 0); alcance = 1.8; }
      else if (sonda === 2) _dir.applyAxisAngle(_cima, 0.6);
      else if (sonda === 3) _dir.applyAxisAngle(_cima, -0.6);

      _v2.copy(this.pos).addScaledVector(_dir, RAIO_CORPO * 0.5);
      const r = col.raycast(_v2, _dir, alcance + RAIO_CORPO);
      if (r?.hit) {
        // quanto mais perto, mais forte; a normal empurra para fora da parede
        const forca = (1 - r.distance / (alcance + RAIO_CORPO)) * 14.0;
        this._repulsa.addScaledVector(r.normal, forca);
        /* Parede na frente => sobe. Drone que so desvia na horizontal fica
         * costurando becos sem saida; subir resolve quase toda geometria de
         * favela, e o teto de altitude impede que "subir" vire "sumir". */
        if (sonda !== 1 && alt < ALT_TETO) this._repulsa.y += forca * 0.35;
      }
    }
    this._repulsa.multiplyScalar(Math.max(0, 1 - dt * REPULSA_DECAI));
    _v.add(this._repulsa);

    /* --- 5. separacao 3D entre drones --------------------------------- */
    const vivos = this.ctx.ai?.vivos;
    if (vivos) {
      for (const o of vivos) {
        if (o === this || !o.eDrone || !o.alive) continue;
        _v2.subVectors(this.pos, o.pos);
        const d2 = _v2.lengthSq();
        if (d2 > SEPARACAO * SEPARACAO || d2 < 1e-4) continue;
        const d = Math.sqrt(d2);
        _v2.divideScalar(d);
        _v.addScaledVector(_v2, (1 - d / SEPARACAO) * 5.5);
      }
    }

    /* --- 6. integra --------------------------------------------------- */
    const k = Math.min(1, dt * ACEL);
    this.vel.lerp(_v, k);
    if (this.estado === ESTADO_DRONE.PAIRAR || this.estado === ESTADO.ATIRAR) {
      this.vel.multiplyScalar(Math.max(0, 1 - dt * FREIO_PAIRAR));
    }
    const vLim = Math.max(vMax, VEL_REPOSICIONAR) * 1.35 + 2;
    if (this.vel.lengthSq() > vLim * vLim) this.vel.setLength(vLim);

    /* Varredura do deslocamento, e nao "anda e ve no que da".
     *
     * A repulsao por sonda e uma FORCA: ela desvia bem quando ha espaco, mas
     * chega tarde em quina fechada e em parede fina, e ai o drone termina o
     * quadro com meio corpo dentro do muro. MEDIDO antes desta varredura: 1,7%
     * das amostras com folga abaixo de 0,16 m — ou seja, um piscar de drone
     * dentro da parede a cada minuto, que e exatamente o tipo de coisa que le
     * como bug mesmo sendo rara.
     *
     * Aqui o passo do quadro e testado ANTES de ser aplicado: se ha geometria
     * no caminho, o drone para a `RAIO_CORPO` dela e a velocidade perde a
     * componente que apontava para dentro — ele DESLIZA pela parede em vez de
     * grudar nela, que e o que evita o segundo defeito (drone imantado em muro,
     * tremendo no lugar). Custa 1 raio por quadro, e so quando ele se move. */
    const passo = this.vel.length() * dt;
    if (col?.raycast && passo > 1e-4) {
      _v2.copy(this.vel).divideScalar(this.vel.length());
      const r = col.raycast(this.pos, _v2, passo + RAIO_CORPO);
      if (r?.hit) {
        const livre = Math.max(0, r.distance - RAIO_CORPO);
        this.pos.addScaledVector(_v2, Math.min(passo, livre));
        // remove a componente normal: sobra o deslizamento pela superficie
        const dot = this.vel.dot(r.normal);
        if (dot < 0) this.vel.addScaledVector(r.normal, -dot * 1.05);
        this._repulsa.addScaledVector(r.normal, 8);
      } else this.pos.addScaledVector(this.vel, dt);
    } else this.pos.addScaledVector(this.vel, dt);

    /* --- 7. depenetracao: o corpo nao pode TERMINAR o quadro dentro de nada
     *
     * A sonda rotativa e a varredura acima sao ambas defesas de MOVIMENTO: uma
     * desvia com antecedencia, a outra impede atravessar parede fina. Nenhuma
     * das duas cobre o caso que mais aparecia na medicao — o drone QUASE PARADO
     * encostado num muro. Parado, a varredura nao tem passo para testar; e a
     * repulsao da sonda DECAI (3,2/s) enquanto o muro continua ali, entao ela
     * solta o drone de volta contra a parede alguns decimos depois. Medido: 2%
     * das amostras com folga abaixo de 0,16 m, quase todas com velocidade
     * proxima de zero. Um drone pairando com o braco dentro do muro fica na
     * tela o tempo todo, ao contrario de um clipe de passagem.
     *
     * `sphereCast` com `maxDist = 0` e exatamente a pergunta "meu corpo esta
     * tocando alguma coisa, e onde" usando so a API publica da colisao. A saida
     * e por POSICAO, nao por forca: forca chega tarde por definicao. */
    if (col?.sphereCast) {
      const s = col.sphereCast(this.pos, _cima, RAIO_CORPO, 0);
      if (s.hit) {
        _v2.subVectors(this.pos, s.point);
        const d = _v2.length();
        if (d > 1e-4 && d < RAIO_CORPO) {
          _v2.divideScalar(d);
          this.pos.addScaledVector(_v2, RAIO_CORPO - d + 0.02);
          const dot = this.vel.dot(_v2);
          if (dot < 0) this.vel.addScaledVector(_v2, -dot);
          this._repulsa.addScaledVector(_v2, 10);
        }
      }
    }

    /* --- 8. piso e teto duros ----------------------------------------
     * Cinto de seguranca depois da integracao: nenhum drone pode atravessar o
     * chao nem sumir para dentro de uma laje. E barato (usa a sonda ja feita)
     * e cobre o caso em que a repulsao chegou tarde demais. */
    const pisoMin = this._chaoY + 1.2;
    if (this.pos.y < pisoMin) { this.pos.y = pisoMin; if (this.vel.y < 0) this.vel.y = 0; }

    /* --- 9. anti-travamento ------------------------------------------
     * "Drone preso na fiacao" le como bug mesmo quando e so um beco fechado.
     * Se ele quer andar e nao anda 0,7 m em 1,6 s, sobe 1,6 m e troca o lado do
     * arco — o par sobe+lado desempata praticamente todo canto de favela. */
    if (vMax > 0.5) {
      this._tTravado += dt;
      if (this._tTravado > 1.6) {
        const andou = this.pos.distanceTo(this._ultimoPonto);
        if (andou < 0.7) {
          this._repulsa.y += 6.0;
          this._ladoArco = -this._ladoArco;
          this._alvoVoo.y = Math.min(this._chaoY + ALT_TETO, this._alvoVoo.y + 1.6);
        }
        this._tTravado = 0;
        this._ultimoPonto.copy(this.pos);
      }
    } else {
      this._tTravado = 0;
      this._ultimoPonto.copy(this.pos);
    }
  }

  /* --- orientacao e pose --- */
  _apontar(dt, alvo) {
    const P = this.percepcao;
    // Olha para o alvo quando o conhece; senao, para onde voa.
    if (alvo && (P.visivel || P.temUltima)
      && this.estado !== ESTADO.PATRULHA && this.estado !== ESTADO.OCIOSO) {
      const pt = P.visivel ? (alvo.eyePosition ?? alvo.position) : P.ultimaPos;
      _dir.subVectors(pt, this.pos);
      this.yawAlvo = Math.atan2(_dir.x, _dir.z);
      const dh = Math.hypot(_dir.x, _dir.z);
      this.arfagem = THREE.MathUtils.clamp(Math.atan2(_dir.y, Math.max(0.2, dh)), -0.7, 0.5);
    } else if (this.vel.lengthSq() > 0.4) {
      this.yawAlvo = Math.atan2(this.vel.x, this.vel.z);
      this.arfagem = -0.16;
    }
    let d = this.yawAlvo - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 5.0);

    /* Rolagem por aceleracao lateral: o corpo inclina para dentro da curva,
     * como qualquer coisa que voa por vetor de empuxo. Sem isso o drone desliza
     * de lado igual a um icone, e nada nele parece ter massa. */
    _v2.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));   // lateral do drone
    const lateral = this.vel.dot(_v2);
    const alvoRol = THREE.MathUtils.clamp(-lateral * 0.055, -0.42, 0.42);
    this.rolagem += (alvoRol - this.rolagem) * Math.min(1, dt * 4.5);
  }

  _pose(dt) {
    /* Flutuacao: um quadricoptero nunca fica exatamente parado. 3 cm de bob a
     * ~1,4 Hz e o que separa "pairando" de "congelado no ar". */
    this._bob += dt * 8.6;
    const bob = Math.sin(this._bob) * 0.03 + Math.sin(this._bob * 0.43) * 0.02;
    this.corpo.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    _e.set(this.arfagem * 0.55, this.yaw + OFFSET_MALHA, this.rolagem, 'YXZ');
    this.corpo.quaternion.setFromEuler(_e);
    this.corpo.updateMatrixWorld(true);

    /* Helice: a velocidade de giro sobe com o empuxo pedido. Sentido alternado
     * entre os quatro rotores fica por conta de `RotoresEnxame`. */
    const empuxo = 1 + Math.min(1.4, this.vel.length() * 0.14);
    this._giroHelice += dt * 26 * empuxo;
  }

  /** Queda depois de abatido: gravidade + tombo, ate encostar no chao. */
  _cair(dt) {
    if (this.estado === ESTADO.MORTO) {
      // ja no chao: so envelhece, para o AIManager saber quando limpar
      this.corpo.updateMatrixWorld(true);
      return;
    }
    this._velQueda -= 17 * dt;
    this.vel.y = this._velQueda;
    this.vel.x *= Math.max(0, 1 - dt * 1.2);
    this.vel.z *= Math.max(0, 1 - dt * 1.2);
    this.pos.addScaledVector(this.vel, dt);

    this.yaw += this._giroQueda.y * dt;
    this.arfagem += this._giroQueda.x * dt;
    this.rolagem += this._giroQueda.z * dt;
    this._giroHelice += dt * 6;    // as pas desaceleram

    const chao = this._sondarChao(this.pos.x, this.pos.y + 0.6, this.pos.z);
    if (this.pos.y - 0.14 <= chao) {
      this.pos.y = chao + 0.14;
      this.vel.set(0, 0, 0);
      // assenta de barriga para cima ou de lado, nunca perfeitamente nivelado
      this.rolagem = (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 1.9);
      this.arfagem = (Math.random() - 0.5) * 0.5;
      this._trocar(ESTADO.MORTO);
      /* Só o evento, de novo. `AudioEngine` assina `weapon:hit` e toca o
       * impacto; o `FXManager` assina o mesmo evento e faz as faíscas. Chamar
       * `audio.impacto` aqui além de emitir era a mesma duplicação do tiro. */
      this.ctx.bus?.emit('weapon:hit', {
        point: this.pos.clone(), normal: _cima.clone(),
        surface: 'metal', target: 'world', enemyId: null,
      });
    }

    this.corpo.position.copy(this.pos);
    _e.set(this.arfagem, this.yaw + OFFSET_MALHA, this.rolagem, 'YXZ');
    this.corpo.quaternion.setFromEuler(_e);
    this.corpo.updateMatrixWorld(true);
  }

  /* ------------------------------------------------------------------ */
  /* Navegacao simples (sem navGrid — ele voa)                           */
  /* ------------------------------------------------------------------ */

  _irPara(destino) {
    this.destino.copy(destino);
    this.temDestino = true;
    this._alvoVoo.copy(destino);
    this._corrigirAltitude(this._alvoVoo);
  }

  _chegou(tol = 2.0) {
    if (!this.temDestino) return true;
    _v.copy(this.pos); _v.y = this.destino.y;
    return _v.distanceTo(this.destino) < tol;
  }

  /** Ronda curta em volta do ponto de nascimento. */
  _rotaLocal(pos) {
    const pts = this.ctx.world?.getSpawnPoints?.() ?? [];
    const perto = [];
    for (const s of pts) {
      const p = s.position ?? s;
      const d = p.distanceTo(pos);
      if (d > 8 && d < 48) perto.push(p);
    }
    if (perto.length < 2) return [];
    for (let i = perto.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [perto[i], perto[j]] = [perto[j], perto[i]];
    }
    return perto.slice(0, 3).map((p) => p.clone());
  }

  _proximoPontoPatrulha() {
    if (!this.patrulha.length) {
      this.temDestino = false;
      this._alvoVoo.copy(this.pos);
      this._corrigirAltitude(this._alvoVoo);
      return;
    }
    this.iPatrulha = (this.iPatrulha + 1) % this.patrulha.length;
    this._irPara(this.patrulha[this.iPatrulha]);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Brilho extra da fenda durante o telegrafo, 0..1.
   *
   * Sobe de 0 a 1 ao longo do `PAIRAR` e o pisca acelera de 4 Hz para 11 Hz —
   * a aceleracao e o que transforma "esta aceso" em "vai atirar AGORA". Fica em
   * 1 durante a rajada e volta a 0 no reposicionamento, entao o brilho conta a
   * fase do ciclo inteiro sem uma linha de HUD.
   */
  get pulsoTelegrafo() {
    if (this._pulso <= 0) return 0;
    // acelera conforme aproxima do tiro: 4 Hz -> 11 Hz
    const f = 4 + this._pulso * 7;
    return this._pulso * (0.5 + 0.5 * Math.sin(this.tEstado * f * Math.PI * 2));
  }

  get giroHelice() { return this._giroHelice; }

  dispose() {
    this.corpo.removeFromParent();
  }
}

export default Drone;
