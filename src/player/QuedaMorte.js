/**
 * QuedaMorte — a encenacao da morte do jogador: o corpo desaba e a vista tomba
 * para o chao, em camera lenta, antes de a tela final entrar.
 * Dono: PLAYER.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NAO O `Ragdoll.js` DA IA (avaliado, e nao serve)
 * ---------------------------------------------------------------------------
 * O pedido era reaproveitar o ragdoll dos hostis. Fui ver, e ele nao cabe aqui
 * por tres motivos, nesta ordem de peso:
 *
 * 1. **O contrato dele e escrever OSSO.** `Ragdoll.aplicar(soldier)` semeia as
 *    15 particulas a partir de `soldier.ossoPorNome(...)` e devolve o resultado
 *    como quaternion de cada osso de um `THREE.Skeleton`. O jogador nao tem
 *    malha, nao tem esqueleto e nao tem osso nenhum — em primeira pessoa ele e
 *    uma camera. Para usar o Ragdoll eu teria de FABRICAR um esqueleto falso so
 *    para ler a posicao de uma particula ('cabeca') e jogar as outras
 *    quatorze fora, com 7 iteracoes de restricao por quadro em cima disso.
 *
 * 2. **Ragdoll em primeira pessoa le como defeito, nao como drama.** O que o
 *    Verlet entrega e emergencia: a cabeca gira em torno de qualquer eixo,
 *    inclusive o de rolagem, e quica. Preso a uma camera isso vira enjoo e
 *    "bug de fisica" — e a razao pela qual o genero faz a morte em primeira
 *    pessoa com queda DIRIGIDA. O que esta cena precisa e de uma tombada
 *    LEGIVEL, com um eixo so e uma direcao escolhida.
 *
 * 3. **`Ragdoll._colidir` so conhece o CHAO** (um raycast vertical por
 *    particula, com cache por celula). Parede ele nao trata — nao ha uma linha
 *    sobre isso no arquivo. O requisito "a camera nao pode terminar dentro de
 *    geometria" teria de ser escrito do zero de qualquer jeito.
 *
 * O que EU reaproveito dele, e esta anotado onde aparece: a gravidade
 * exagerada (`GRAVIDADE = 14.5`, com a mesma justificativa — 9,81 le como
 * camera lenta), o cache de altura de chao por celula, e a ideia de sanear
 * valor nao-finito antes de deixar propagar para a camera.
 *
 * ---------------------------------------------------------------------------
 * O MODELO: barra rigida articulada no pe, que ainda por cima encolhe
 * ---------------------------------------------------------------------------
 * O corpo e uma barra que gira em torno dos PES. `theta` e o angulo em relacao
 * a vertical; a aceleracao angular de uma barra homogenea presa pela base e
 *
 *     alpha = (3g / 2L) * sin(theta)
 *
 * So isso ja daria um poste caindo. O que faz ler como CORPO e o comprimento
 * encolher junto (`comprimento`): o joelho cede, o tronco dobra, e o olho chega
 * ao chao a ~0,7 m de onde os pes estavam, nao a 1,7 m. Poste cai inteiro;
 * gente desaba.
 *
 * A camera e rigida na ponta da barra, entao a rotacao e UMA so — um quaternion
 * em torno do eixo `cross(cima, dirQueda)` (a ORDEM importa; ver a nota em
 * `_compor`). Nao ha decomposicao em pitch e roll: quem cai de lado ve o
 * horizonte girar, quem cai para a frente ve o chao subir, e a mistura sai
 * certa sozinha para qualquer direcao.
 *
 * A POSICAO, essa sim, e decomposta em alcance horizontal e altura — nao por
 * gosto, mas porque so assim da para garantir que a camera nao entre em parede.
 * Ver `_avancar`.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

/* --- fisica ------------------------------------------------------------- */
/* Mesmo valor (e mesma razao) do `Ragdoll.js`: 9,81 desaba devagar demais e ja
 * le como camera lenta. Aqui a camera lenta e de verdade, entao o corpo
 * precisa ainda mais de peso para nao parecer que esta boiando. */
const GRAVIDADE = 14.5;
const THETA0 = 0.10;          // rad — o corpo ja parte fora da vertical
const OMEGA0 = 1.25;          // rad/s — o empurrao do tiro que derrubou
const OMEGA0_SORTE = 0.55;    // variacao, para duas mortes nao serem iguais
/* Angulo final. 90 seria o corpo perfeitamente deitado, e foi o primeiro
 * valor. Trocado por 81 depois de olhar a foto: a 88 graus a camera fica
 * paralela ao chao a 30 cm dele e o terreno ocupa dois tercos do quadro como
 * uma mancha borrada — a tomada termina em textura de terra, nao em favela.
 * A 81 o horizonte volta para dentro do quadro e da para VER onde se caiu, que
 * e o ponto da cena. Nao e realismo: e a mesma licenca que o genero toma na
 * camera de morte, e vale mais que os 9 graus. */
const THETA_FIM = 81 * DEG;
const OMEGA_MAX = 7.0;        // teto: sem ele a barra chicoteia no fim

/* Encolhimento do corpo ao longo da queda. 0,42 = o olho termina a ~0,71 m do
 * pe (1,68 x 0,42), que e a altura de uma cabeca deitada de lado. */
const ENCOLHE_ATE = 0.42;

/* --- tempo (segundos de PAREDE, nao de simulacao) ------------------------ */
/* ESCALA e o quanto o tempo desacelera. Escolhida medindo (tools/queda.mjs):
 * com 0,42 a queda inteira leva 1,34 s de relogio de parede, medidos, e a tela
 * final entra logo depois — o jogador chega no primeiro clique em ~6,3 s
 * (1,3 de queda + a trava de 5 s que ja existia), contra 5,9 s antes.
 *
 * Mais lento que isso e a tomada passa de dramatica a arrastada, e quem ja
 * perdeu dez vezes quer que acabe. Mais rapido e o beat nao existe: sem escala
 * nenhuma a queda dura 0,56 s e o jogador nao registra que caiu — a tela
 * aparece antes de ele entender por que a imagem virou. */
const ESCALA = 0.42;
const RAMPA = 0.09;           // s de parede para o tempo desacelerar de 1 a ESCALA
const POUSO = 0.20;           // s de parede segurando a imagem no chao
const DUR_MAX = 1.60;         // s de parede — teto duro, aconteca o que acontecer

/* --- geometria e colisao ------------------------------------------------- */
/* A camera e tratada como uma esfera deste raio. Ele faz dois trabalhos ao
 * mesmo tempo: e a folga minima ate qualquer geometria (depenetracao) e, na
 * pratica, a altura em que o olho para sobre o chao — por isso 0,34 e nao
 * 0,15. Um olho a 15 cm do piso ve so terra desfocada. */
const RAIO_OLHO = 0.34;
/* Altura minima do olho sobre o PISO no fim da queda.
 *
 * Maior que o raio de colisao de proposito, e escolhida olhando a foto: a
 * 0,34 m o terreno entra no campo proximo do desfoque de profundidade e a
 * tomada termina numa mancha borrada ocupando meio quadro. A 0,52 m — a
 * cabeca apoiada no ombro, nao esborrachada no chao — o chao sai do limiar de
 * desfoque e o casario volta a ser legivel atras da tipografia. */
const FOLGA_CHAO = 0.52;
const ITER_DEPEN = 3;         // passadas de depenetracao por quadro

/* Temporarios de modulo — nenhuma alocacao por quadro (regra 6 do contrato). */
const _cima = new THREE.Vector3(0, 1, 0);
const _eixo = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _base = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qBase = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _cand = new THREE.Vector3();

export class QuedaMorte {
  /**
   * @param {object} ctx GameContext
   * @param {import('./Player.js').Player} player
   */
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;

    this.fase = 'parada';       // 'parada' | 'caindo' | 'pousando'
    this.theta = 0;
    this.omega = 0;
    this.tParede = 0;           // relogio de PAREDE desde o inicio
    this.tPouso = 0;
    this.comprimento = 1.68;
    this.dirQueda = new THREE.Vector3(0, 0, -1);
    this.yawBase = 0;
    this.pitchBase = 0;
    this.olho = new THREE.Vector3();
    this._bateu = false;
    this._chao = new Map();     // cache de altura do chao por celula (ideia do Ragdoll)
    this._avisou = false;
  }

  get ativa() { return this.fase !== 'parada'; }

  /* ================================================================ *
   * Inicio
   * ================================================================ */

  /**
   * @param {THREE.Vector3|null} fromDir direcao MUNDIAL em que a bala viajava
   *   (o mesmo `fromDir` de `player:damaged`). Usada so como desempate: quem
   *   manda na direcao da queda e a folga medida ao redor.
   */
  iniciar(fromDir = null) {
    if (this.fase !== 'parada') return;
    const rig = this.player.rig;

    this.fase = 'caindo';
    this.theta = THETA0;
    // `determinista` existe para as ferramentas de captura: duas mortes
    // seguidas tem de sair iguais para virarem uma sequencia comparavel.
    this.omega = OMEGA0 + (this.determinista ? 0 : Math.random() * OMEGA0_SORTE);
    this.tParede = 0;
    this.tPouso = 0;
    this._bateu = false;
    this._chao.clear();
    this.comprimento = rig.eyeHeight || 1.68;
    this.yawBase = rig.yaw;
    this.pitchBase = rig.pitch;

    this.dirQueda.copy(this._escolherDirecao(fromDir));

    // A arma sai de cena junto com o corpo (ver ViewModel: `quedaT`). O
    // viewmodel e desenhado com o depth zerado, POR CIMA de tudo — deixado no
    // lugar ele viraria um adesivo deslizando sobre o chao enquanto a vista
    // tomba, que e exatamente a leitura de "bug" que esta cena nao pode ter.
    if (this.player.viewModel) this.player.viewModel.quedaT = 0;

    this.ctx.time.scale = 1;   // a rampa desce em `update`
  }

  /**
   * Para onde o corpo tomba.
   *
   * Preferencia por CAIR PARA A FRENTE com um pe de lado: e a tombada que
   * termina com o olho virado para o chao (o pedido) e com o horizonte
   * rodando, em vez de cair de costas e terminar olhando para o ceu — que le
   * como "a tela virou", nao como "eu cai".
   *
   * Mas a preferencia perde para a FOLGA: num beco de 1,3 m cair para a frente
   * e enfiar a camera na parede. Entao medimos cinco candidatos com um
   * `sphereCast` na altura do quadril e ficamos com o de melhor pontuacao —
   * folga primeiro, gosto depois.
   */
  _escolherDirecao(fromDir) {
    const rig = this.player.rig;
    const col = this.ctx.world?.collision;

    // frente e direita no plano do chao, a partir do yaw da camera
    const frente = _v.set(-Math.sin(rig.yaw), 0, -Math.cos(rig.yaw));
    const direita = _v2.set(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw));

    // Lado sorteado, mas enviesado pela bala: levar tiro pela direita joga o
    // corpo para a esquerda.
    let lado = (this.determinista || Math.random() < 0.5) ? 1 : -1;
    if (fromDir && Number.isFinite(fromDir.x + fromDir.z)) {
      const l = fromDir.x * direita.x + fromDir.z * direita.z;
      if (Math.abs(l) > 0.25) lado = l > 0 ? 1 : -1;
    }

    const candidatos = [
      [frente.x * 0.78 + direita.x * lado * 0.62, frente.z * 0.78 + direita.z * lado * 0.62, 1.00],
      [frente.x * 0.78 - direita.x * lado * 0.62, frente.z * 0.78 - direita.z * lado * 0.62, 0.92],
      [direita.x * lado, direita.z * lado, 0.70],
      [-direita.x * lado, -direita.z * lado, 0.66],
      [-frente.x, -frente.z, 0.45],
    ];

    const pes = this.player.movement.position;
    const alcance = this.comprimento * 0.95;
    let melhor = null, melhorNota = -Infinity;
    for (const [dx, dz, gosto] of candidatos) {
      _cand.set(dx, 0, dz);
      if (_cand.lengthSq() < 1e-6) continue;
      _cand.normalize();
      let folga = alcance;
      if (col?.sphereCast) {
        // Sonda na altura do quadril: e o volume que o corpo varre ao tombar.
        _v.set(pes.x, pes.y + this.comprimento * 0.55, pes.z);
        const r = col.sphereCast(_v, _cand, RAIO_OLHO + 0.06, alcance);
        if (r?.hit) folga = Math.max(0, r.distance);
      }
      // Folga pesa 1 m por ponto; o gosto vale no maximo meio ponto. Assim a
      // preferencia so decide quando os dois lados estao igualmente livres.
      const nota = Math.min(folga, alcance) + gosto * 0.5;
      if (nota > melhorNota) { melhorNota = nota; melhor = _cand.clone(); }
    }
    return melhor ?? new THREE.Vector3(-Math.sin(rig.yaw), 0, -Math.cos(rig.yaw));
  }

  /* ================================================================ *
   * Update
   * ================================================================ */

  /**
   * @param {number} dt dt JA escalado pela camera lenta (o de simulacao).
   *   O relogio de PAREDE sai de `ctx.time.dtReal` — a duracao da encenacao e
   *   a espera do jogador, e essa nao pode esticar junto com o tempo do jogo.
   */
  update(dt) {
    if (this.fase === 'parada') return;
    const ctx = this.ctx;
    const dtReal = ctx.time.dtReal || dt;
    this.tParede += dtReal;

    /* --- camera lenta: rampa de descida ------------------------------- */
    const k = Math.min(1, this.tParede / RAMPA);
    ctx.time.scale = 1 + (ESCALA - 1) * (k * k * (3 - 2 * k));   // smoothstep

    /* --- integracao angular da barra ---------------------------------- */
    if (this.fase === 'caindo') {
      const alpha = (3 * GRAVIDADE / (2 * Math.max(0.4, this.comprimento))) * Math.sin(this.theta);
      this.omega = Math.min(OMEGA_MAX, this.omega + alpha * dt);
      this.theta += this.omega * dt;
      if (this.theta >= THETA_FIM || this.tParede >= DUR_MAX - POUSO) {
        this.theta = THETA_FIM;
        this.fase = 'pousando';
        this._impacto();
      }
    } else {
      this.tPouso += dtReal;
    }

    /* --- pose ---------------------------------------------------------- */
    this._compor(dt);

    /* --- fim ----------------------------------------------------------- */
    if ((this.fase === 'pousando' && this.tPouso >= POUSO) || this.tParede >= DUR_MAX) {
      this._terminar();
    }
  }

  /** Escreve a camera do mundo (e o espelho no rig) a partir de `theta`. */
  _compor(dt) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    if (!cam) return;
    const rig = this.player.rig;
    const t = Math.min(1, this.theta / THETA_FIM);

    // A arma sai da mao no primeiro terco da queda (ver ViewModel.quedaT).
    if (this.player.viewModel) this.player.viewModel.quedaT = Math.min(1, t * 3);

    /* Comprimento: o corpo encolhe enquanto tomba (joelho cede, tronco dobra).
     * Curva com o quadrado para o encolhimento acontecer mais no fim — no
     * comeco o corpo ainda esta inteiro. */
    const L0 = rig.eyeHeight || this.comprimento;
    this.comprimento = L0 * (1 - (1 - ENCOLHE_ATE) * t * t);

    /* Rotacao: UM quaternion em torno do eixo horizontal perpendicular a
     * direcao da queda.
     *
     * O EIXO E `cima x dirQueda`, NAO `dirQueda x cima` — a ordem importa e
     * errei nela na primeira versao. Por Rodrigues, com `a = cima x dirQueda`
     * e `v = cima`, tem-se `a x v = dirQueda` e portanto
     * `v' = cima*cos(t) + dirQueda*sin(t)`: o topo tomba PARA a direcao
     * escolhida. Com a ordem trocada da `-dirQueda`, e o corpo cai exatamente
     * para o lado oposto — na foto, o jogador tombava de costas e a tomada
     * terminava de cara para o ceu (shots/queda/02-t180ms.png, antes). */
    _eixo.crossVectors(_cima, this.dirQueda);
    if (_eixo.lengthSq() < 1e-9) _eixo.set(1, 0, 0); else _eixo.normalize();
    _q.setFromAxisAngle(_eixo, this.theta);

    /* Base: guinada preservada; a inclinacao converge para um valor unico ao
     * longo da queda, senao quem morresse olhando para cima terminaria a
     * tomada de cara para o ceu e quem morresse olhando para o chao veria so
     * terra.
     *
     * O alvo e +7 graus (acima do horizonte), nao 0 nem negativo: com o olho a
     * 34 cm do chao e a camera deitada, qualquer inclinacao para baixo enche o
     * quadro de terra desfocada. Sete graus para cima trazem o casario de
     * volta para dentro do enquadramento — da para VER onde se caiu. */
    const pitch = this.pitchBase + (7 * DEG - this.pitchBase) * t;
    _e.set(pitch, this.yawBase, 0, 'YXZ');
    _qBase.setFromEuler(_e);
    cam.quaternion.copy(_q).multiply(_qBase);

    /* Posicao: pe + barra girada, decomposta em ALCANCE HORIZONTAL e ALTURA.
     *
     * A decomposicao existe por causa da colisao. O ponto de partida — o eixo
     * da capsula do jogador — e o unico ponto do mundo que se sabe LIVRE de
     * graca: o `Movement` mantem a capsula fora de geometria a cada quadro, e
     * o eixo dela e a linha medial desse volume. Entao o alcance horizontal e
     * medido A PARTIR DALI com um `sphereCast`, e a camera nunca chega a
     * entrar em parede — em vez de entrar e ser resgatada depois. */
    _base.copy(this.player.movement.position);
    const offH = this.comprimento * Math.sin(this.theta);
    const offV = this.comprimento * Math.cos(this.theta);

    /* Tremor que o rig ja produziu (shake do tiro que matou, dip de
     * aterrissagem), amortecido: um corpo caindo nao faz bob de passo, mas o
     * baque tem de chegar na imagem. */
    _offset.copy(rig.worldPosition).sub(_base);
    _offset.y -= L0;
    if (!Number.isFinite(_offset.x + _offset.y + _offset.z)) _offset.set(0, 0, 0);
    _offset.multiplyScalar(0.35);

    const olhoY = _base.y + offV + _offset.y;
    this.olho.set(_base.x + _offset.x, olhoY, _base.z + _offset.z);
    this._avancar(offH);
    this._manterForaDaGeometria();

    if (!Number.isFinite(this.olho.x + this.olho.y + this.olho.z)) {
      // Ultima barreira: melhor uma camera parada do que uma camera em NaN.
      if (!this._avisou) { this._avisou = true; console.warn('[QuedaMorte] olho nao-finito, encerrando'); }
      this._terminar();
      return;
    }

    cam.position.copy(this.olho);
    cam.updateMatrixWorld(true);
    // Espelha no rig para que `ctx.player.eyePosition` nao minta durante a cena.
    rig.worldPosition.copy(this.olho);
    rig.worldQuaternion.copy(cam.quaternion);
  }

  /**
   * Avanca o olho `dist` metros na direcao da queda, PARANDO em parede.
   *
   * Esta e a defesa principal, e a razao de ela vir antes das outras: o olho
   * parte do eixo da capsula do jogador, que o `Movement` garante livre, e
   * caminha dali com uma esfera de `RAIO_OLHO`. Um `sphereCast` que para no
   * primeiro contato NUNCA deixa a camera entrar — e um problema diferente
   * (e muito mais facil) do que tirar a camera de dentro depois que entrou.
   *
   * A versao anterior nao tinha esta etapa: punha o olho na ponta da barra e
   * confiava so na depenetracao. Falhou em 1 de 40 quedas medidas, com a
   * camera a 0,011 m de uma face — a depenetracao nao acha superficie quando
   * o ponto ja esta mais fundo que o raio de busca.
   */
  _avancar(dist) {
    if (dist <= 1e-4) return;
    const col = this.ctx.world?.collision;
    let d = dist;
    if (col?.sphereCast) {
      const r = col.sphereCast(this.olho, this.dirQueda, RAIO_OLHO, dist);
      if (r?.hit) d = Math.max(0, r.distance - 0.02);
    }
    this.olho.addScaledVector(this.dirQueda, d);
  }

  /**
   * Piso e depenetracao — as duas defesas que sobram depois do `_avancar`.
   *
   *  1. **Piso.** Raycast vertical com cache por celula de 0,5 m (mesma ideia
   *     do `Ragdoll._colidir`, pelo mesmo motivo: um raycast por quadro seria
   *     caro e o chao nao muda). O olho nunca desce abaixo de
   *     `chao + FOLGA_CHAO`.
   *  2. **Depenetracao por esfera.** `sphereCast` com `maxDist = 0` devolve o
   *     ponto de geometria mais proximo dentro do raio; empurramos o olho ate
   *     ficar a `RAIO_OLHO` da superficie. E a mesma correcao que resolveu o
   *     drone raspando muro (ver NOTES [AI]/drone secao 3), e ela continua
   *     necessaria porque o passo 1 pode SUBIR o olho para dentro de uma laje
   *     baixa, que nenhum avanco horizontal previa.
   */
  _manterForaDaGeometria() {
    const col = this.ctx.world?.collision;
    if (!col) return;

    /* --- 1. piso --- */
    if (col.raycast) {
      const cx = Math.round(this.olho.x * 2), cz = Math.round(this.olho.z * 2);
      const chave = cx * 65536 + cz;
      let yChao = this._chao.get(chave);
      if (yChao === undefined) {
        _v.set(this.olho.x, this.olho.y + 2.5, this.olho.z);
        _v2.set(0, -1, 0);
        const r = col.raycast(_v, _v2, 8);
        yChao = r?.hit ? r.point.y : -Infinity;
        this._chao.set(chave, yChao);
      }
      if (yChao > -Infinity && this.olho.y < yChao + FOLGA_CHAO) {
        this.olho.y = yChao + FOLGA_CHAO;
      }
    }

    /* --- 2. depenetracao lateral --- */
    if (!col.sphereCast) return;
    for (let i = 0; i < ITER_DEPEN; i++) {
      const r = col.sphereCast(this.olho, _cima, RAIO_OLHO, 0);
      if (!r?.hit) break;
      _v.copy(this.olho).sub(r.point);
      const d = _v.length();
      if (d < 1e-4) {
        // Olho exatamente sobre a face: usa a normal para saber para que lado sair.
        _v.copy(r.normal);
        if (_v.lengthSq() < 1e-6) break;
        _v.normalize();
      } else {
        _v.multiplyScalar(1 / d);
      }
      this.olho.copy(r.point).addScaledVector(_v, RAIO_OLHO + 0.001);
    }
  }

  /** O corpo bate no chao: poeira, som e um ultimo tranco. */
  _impacto() {
    if (this._bateu) return;
    this._bateu = true;
    const ctx = this.ctx;
    const col = ctx.world?.collision;
    let superficie = 'terra';
    if (col?.raycast) {
      _v.copy(this.olho); _v.y += 1.2;
      _v2.set(0, -1, 0);
      const r = col.raycast(_v, _v2, 4);
      if (r?.hit && r.surface) superficie = r.surface;
    }
    this.player.rig?.addShake?.(0.55);
    /* Reuso deliberado de `player:land`: o AudioEngine ja tem a batida por
     * superficie, o FX ja levanta a poeira no ponto e o proprio Player ja
     * converte em dip de camera. Um evento novo seria tres implementacoes
     * novas para o mesmo baque. */
    ctx.bus?.emit('player:land', { velocity: 6.5, surface: superficie });
  }

  _terminar() {
    if (this.fase === 'parada') return;
    this.fase = 'parada';
    this.ctx.time.scale = 1;
    this.ctx.state = 'morto';
    if (this.player.viewModel) this.player.viewModel.quedaT = 1;
    this.ctx.bus?.emit('player:caiu', {
      duracao: this.tParede,
      posicao: this.olho.clone(),
    });
  }

  /** Corta a encenacao no meio (renascer, sair para o menu). */
  cancelar() {
    this.fase = 'parada';
    this.ctx.time.scale = 1;
    this._chao.clear();
    if (this.player.viewModel) this.player.viewModel.quedaT = 0;
  }

  dispose() { this._chao.clear(); }
}

export default QuedaMorte;
