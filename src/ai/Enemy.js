/**
 * Enemy — um combatente. Maquina de estados + navegacao + tiro.
 *
 * Principio de projeto: a IA nao trapaceia. Ela so sabe o que a Perception
 * deixa saber (cone de visao, linha de visada, som), e mira com erro que
 * converge no tempo. Dificuldade escala tempo de reacao e precisao, NUNCA
 * dano bruto nem onisciencia — IA que acerta 100% do outro lado do mapa e
 * a forma mais rapida de fazer um FPS parecer injusto.
 */
import * as THREE from 'three';
import { Soldier } from './Soldier.js';
import { Perception } from './Perception.js';
import { Ragdoll } from './Ragdoll.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _frente = new THREE.Vector3();
const _olho = new THREE.Vector3();

export const ESTADO = {
  OCIOSO: 'ocioso', PATRULHA: 'patrulha', SUSPEITO: 'suspeito',
  ALERTA: 'alerta', PERSEGUIR: 'perseguir', COBERTURA: 'cobertura',
  ATIRAR: 'atirar', RECARREGAR: 'recarregar', FLANQUEAR: 'flanquear',
  MORTO: 'morto',
};

/** Multiplicadores de hitbox por parte do corpo. */
export const MULT_PARTE = { cabeca: 2.5, torso: 1.0, bracos: 0.75, pernas: 0.75 };

/**
 * Perfis de dificuldade.
 *
 * Os eixos que sobem sao TEMPO DE REACAO e PRECISAO, mais o quanto o hostil
 * sustenta fogo (rajada/pausa). `dano` esta congelado de proposito em todos os
 * tres — subir dano por bala e o atalho que faz o jogador morrer sem entender
 * o que aconteceu, e o contrato do ARCHITECTURE.md proibe.
 *
 * `erroMin` em radianos, comparado com a tolerancia de acerto: o tiro so pega
 * se passar a menos de 0,45 m do alvo, ou seja 0,45/dist rad. A 14 m isso da
 * 0,032 — e por isso que `facil` com 0,032 erra bastante a media distancia e
 * `dificil` com 0,009 quase nao erra quem esta parado. Contra alvo em
 * movimento vale a lideranca de tiro, que tambem escala com o perfil.
 */
export const DIFICULDADE = {
  facil:   { reacao: [0.48, 0.86], erro0: 0.13, erroMin: 0.032, converge: 1.8, rajada: [3, 5], pausa: [0.62, 1.25], dano: 7 },
  normal:  { reacao: [0.27, 0.52], erro0: 0.10, erroMin: 0.017, converge: 2.8, rajada: [4, 7], pausa: [0.44, 0.95], dano: 10 },
  dificil: { reacao: [0.18, 0.34], erro0: 0.07, erroMin: 0.009, converge: 3.9, rajada: [5, 9], pausa: [0.30, 0.68], dano: 13 },
};

const VEL_ANDAR = 2.1;
const VEL_TROTE = 3.3;      // quem foi avisado e vai investigar nao passeia
const VEL_CORRER = 4.6;
/* Vigia: quanto o hostil parado gira a cada olhada, e quanto espera entre elas.
 * Com giro medio de ~1,65 rad a cada ~1,65 s o azimute fecha uma volta em ~7 s
 * no pior caso e em ~3 s no tipico — e com o meio-cone de 55 graus qualquer
 * rumo entra no campo de visao dentro dessa janela. */
const VIGIA_GIRO = [1.0, 2.3];      // rad
const VIGIA_ESPERA = [0.45, 1.0];   // s parado entre uma olhada e outra
const VIGIA_VEL = 3.0;              // ganho do giro do corpo enquanto varre
/** Teto de tempo investigando um mesmo aviso, em segundos.
 * 22 s a 3,3 m/s cobre os 46 m da faixa de reforco com folga para desvio. */
const SUSPEITA_MAX = 22;
const ALCANCE_TIRO = 42;
const DIST_IDEAL = 14;      // distancia que tenta manter do alvo
const MUNICAO_PENTE = 30;


let proximoId = 1;

export class Enemy {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.id = proximoId++;
    this.ativo = false;

    this.soldado = new Soldier(ctx, { variante: opts.variante ?? (this.id % 3) });
    this.soldado.grupo.visible = false;
    this.percepcao = new Perception(ctx, this);
    this.ragdoll = null;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.yawAlvo = 0;

    this.vidaMax = 100;
    this.vida = 100;
    this.morto = false;
    this.estado = ESTADO.OCIOSO;
    this.tEstado = 0;

    this.dif = DIFICULDADE[opts.dificuldade ?? 'normal'];
    this.municao = MUNICAO_PENTE;

    // caminho
    this.caminho = [];
    this.iCaminho = 0;
    this.destino = new THREE.Vector3();
    this.temDestino = false;
    this._tRepath = 0;
    this._chaveNav = `e${this.id}`;

    // tiro
    this._tReacao = 0;
    this._reagindo = false;
    this._tProxTiro = 0;
    this._naRajada = 0;
    this._tPausa = 0;
    this._erro = 0.1;
    this._tremor = 0;

    // cobertura
    this.cobertura = null;
    this._tCobertura = 0;
    this._espiando = false;

    this.patrulha = [];
    this.iPatrulha = 0;
    this._lento = 0;   // contador de LOD

    // vigia (varredura de olhar quando parado)
    this._tVigia = 0;
    this._ladoVigia = Math.random() < 0.5 ? 1 : -1;
    this._varrendo = false;
  }

  /* ------------------------------------------------------------------ */

  spawn(pos, yaw = 0, patrulha = null) {
    this.pos.copy(pos);
    this.yaw = this.yawAlvo = yaw;
    this.vel.set(0, 0, 0);
    this.vida = this.vidaMax;
    this.morto = false;
    this.ativo = true;
    this.municao = MUNICAO_PENTE;
    this.ragdoll = null;
    this.caminho.length = 0;
    this.temDestino = false;
    this.cobertura = null;
    this._reagindo = false;
    this._naRajada = 0;
    this._alertouEsquadrao = false;
    /* O vigia SEGURA o rumo de nascimento por um instante antes da primeira
     * olhada. Com `_tVigia = 0` ele virava as costas no primeiro quadro, e um
     * hostil posto de frente para o jogador perdia o contato antes de a
     * consciencia subir: medido, notar a 30 m de frente foi de 0,3 s para 5,4 s
     * so por causa disso. O posto e para ser olhado primeiro. */
    this._tVigia = 0.5 + Math.random() * 1.5;
    this._varrendo = false;
    this.percepcao.reset();
    this.soldado.reviver();
    this.soldado.grupo.visible = true;
    this.soldado.grupo.position.copy(pos);
    this.soldado.grupo.rotation.set(0, yaw, 0);
    /* Sem rota explícita, monta uma. Antes o agente caía em OCIOSO e ficava
     * plantado até alguém aparecer — parado no meio da favela, sem ronda e
     * sem barulho, o que fazia o mapa parecer vazio. */
    this.patrulha = (patrulha && patrulha.length) ? patrulha : this._rotaLocal(pos);
    this.iPatrulha = 0;
    this._distPasso = 0;
    this._trocar(this.patrulha.length ? ESTADO.PATRULHA : ESTADO.OCIOSO);
  }

  despawn() {
    this.ativo = false;
    this.soldado.grupo.visible = false;
    this.ctx.ai?.nav?.cancelar?.(this._chaveNav);
  }

  _trocar(novo) {
    if (this.estado === novo) return;
    this.estado = novo;
    this.tEstado = 0;
  }



  /* ------------------------------------------------------------------ */
  /* Dano                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @returns {boolean} true se este dano matou
   */
  levarDano(dano, ponto, parte, dirTiro) {
    if (this.morto) return false;
    const mult = MULT_PARTE[parte] ?? 1;
    const total = dano * mult;
    this.vida -= total;

    this.ctx.bus?.emit('enemy:damaged', {
      enemyId: this.id, damage: total, point: ponto,
      headshot: parte === 'cabeca',
    });

    if (this.vida <= 0) {
      this._morrer(ponto, parte, dirTiro);
      return true;
    }

    // Flinch e alerta imediato: levar tiro sempre revela o atirador,
    // senao o jogador consegue matar um a um sem nunca ser notado.
    this.soldado.flinch(dirTiro?.x ?? 0, dirTiro?.z ?? 0);
    const alvo = this.ctx.player;
    if (alvo?.position) this.percepcao.avisar(alvo.position, 1.0);
    if (this.estado === ESTADO.OCIOSO || this.estado === ESTADO.PATRULHA) {
      this._trocar(ESTADO.ALERTA);
    }
    return false;
  }

  _morrer(ponto, parte, dirTiro) {
    this.morto = true;
    this._trocar(ESTADO.MORTO);
    this.ctx.ai?.nav?.cancelar?.(this._chaveNav);

    this.ragdoll = new Ragdoll(this.ctx, this.soldado);
    if (dirTiro) {
      const forca = parte === 'cabeca' ? 1.6 : 1.0;
      this.ragdoll.impulso(dirTiro, forca, parte === 'cabeca' ? 'cabeca' : 'peito');
    }
    this.soldado.aoRagdoll(this.ragdoll);

    this.ctx.bus?.emit('enemy:killed', {
      enemyId: this.id, headshot: parte === 'cabeca',
      weapon: this.ctx.player?.weaponSystem?.current?.id ?? null,
      point: ponto ?? this.pos,
    });
    this.ctx.audio?.grito?.(this.pos, 'morte');
  }

  /* ------------------------------------------------------------------ */
  /* Update                                                              */
  /* ------------------------------------------------------------------ */

  update(dt, temOrcamento = true) {
    if (!this.ativo) return;

    if (this.morto) {
      // tEstado tem de correr tambem depois de morto: o AIManager usa ele
      // para saber quando o corpo ja pode sumir e liberar a vaga do pool.
      this.tEstado += dt;
      this.ragdoll?.update(dt);
      this.soldado.update(dt);
      return;
    }

    this.tEstado += dt;

    const alvo = this.ctx.player;
    this.soldado.posOlho(_olho);
    _frente.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.percepcao.update(dt, _olho, _frente, alvo, temOrcamento);

    this._pensar(dt, alvo);
    this._vigiar(dt);
    this._mover(dt);
    this._apontar(dt, alvo);

    this.soldado.grupo.position.copy(this.pos);
    this.soldado.grupo.rotation.y = this.yaw;
    this.soldado.setLocomocao(this.vel.x, this.vel.z, this.estado === ESTADO.COBERTURA && !this._espiando);
    this.soldado.update(dt);
  }

  /* --- decisao --- */
  _pensar(dt, alvo) {
    const P = this.percepcao;
    const temAlvo = alvo && alvo.alive !== false;

    switch (this.estado) {
      case ESTADO.OCIOSO:
        if (P.suspeito) this._trocar(ESTADO.SUSPEITO);
        else if (this.patrulha.length) this._trocar(ESTADO.PATRULHA);
        break;

      case ESTADO.PATRULHA:
        if (P.suspeito) { this._trocar(ESTADO.SUSPEITO); break; }
        if (!this.temDestino || this._chegou(1.2)) this._proximoPontoPatrulha();
        break;

      case ESTADO.SUSPEITO: {
        /* Vai investigar a ultima posicao conhecida / origem do som.
         *
         * A desistencia NAO e mais "a barra de consciencia secou". Era: um
         * reforco avisado nascia com 0,55, e 0,55 vira 0,05 em 3,3 s de
         * decaimento — ou seja, ele andava tres segundos na direcao do jogador,
         * dava meia-volta e voltava a patrulhar, a 20 m do alvo. O jogo ficava
         * vazio com sete hostis em campo. Agora ele desiste quando CHEGOU e
         * olhou em volta, ou quando o tempo total estoura. Isso e paciencia de
         * sentinela, nao onisciencia: ele continua sem saber onde o alvo esta. */
        if (P.alerta) { this._trocar(ESTADO.ALERTA); break; }
        const chegou = this.temDestino && this._chegou(1.8);
        if ((chegou && this.tEstado > 3.0) || this.tEstado > SUSPEITA_MAX) {
          this._trocar(this.patrulha.length ? ESTADO.PATRULHA : ESTADO.OCIOSO);
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
        this._reagindo = true;
        if (this._tReacao <= 0) {
          const [a, b] = this.dif.reacao;
          this._tReacao = a + Math.random() * (b - a);
          this._erro = this.dif.erro0;
          this.ctx.audio?.grito?.(this.pos, 'alerta');
          // Grita para o esquadrao: quem esta perto vem investigar.
          if (!this._alertouEsquadrao) {
            this._alertouEsquadrao = true;
            const onde = P.temUltima ? P.ultimaPos : alvo.position;
            this.ctx.ai?.alertarProximos?.(this, onde, 22);
          }
        }
        this._tReacao -= dt;
        if (this._tReacao <= 0) {
          if (!P.visivel) { this._trocar(ESTADO.PERSEGUIR); break; }
          /* Se a frente ja esta cheia de fuzil, este contorna em vez de somar
           * mais um cano na mesma linha (ver AIManager.vagaDeFogo). */
          this._abrirFogo();
        }
        break;

      case ESTADO.PERSEGUIR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        if (P.visivel && P.distAlvo < ALCANCE_TIRO) { this._abrirFogo(); break; }
        this._tRepath -= dt;
        const destino = P.temUltima ? P.ultimaPos : alvo.position;
        if (this._tRepath <= 0 || !this.temDestino) {
          this._irPara(destino);
          this._tRepath = 0.55 + Math.random() * 0.4;
        }
        if (P.tempoSemVer > 9 && !P.visivel) this._trocar(ESTADO.SUSPEITO);
        break;
      }

      case ESTADO.ATIRAR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        if (this.municao <= 0) { this._trocar(ESTADO.RECARREGAR); break; }
        if (!P.visivel) {
          // perdeu visada: espera um pouco antes de sair correndo
          if (P.tempoSemVer > 1.1) this._trocar(ESTADO.PERSEGUIR);
          break;
        }
        /* Mantem distancia: muito perto recua, muito longe aproxima.
         *
         * O repath e ESTRANGULADO. Pedir caminho todo quadro zera `iCaminho`
         * antes de o agente andar dois passos: ele reinicia a rota sem parar e
         * vibra no lugar — em jogo isso aparece como o inimigo "tremendo"
         * parado. Uma rota nova a cada ~0,6 s e mais que suficiente. */
        this._tRepath -= dt;
        if (this._tRepath <= 0) {
          if (P.distAlvo > ALCANCE_TIRO * 0.85) {
            this._irPara(alvo.position);
            this._tRepath = 0.6 + Math.random() * 0.3;
          } else if (P.distAlvo < DIST_IDEAL * 0.5) {
            _dir.subVectors(this.pos, alvo.position).setY(0).normalize();
            _v.copy(this.pos).addScaledVector(_dir, 4);
            this._irPara(_v);
            this._tRepath = 0.6 + Math.random() * 0.3;
          } else if (this.temDestino && this._chegou(1.2)) {
            this.temDestino = false;
          }
        }
        /* Sob fogo prolongado sai da linha. PARA ONDE depende de ter companhia:
         * se ha outro hostil engajado, este contorna (FLANQUEAR) em vez de se
         * enfiar atras de um muro, e o par vira "um segura, o outro aparece do
         * lado". Sozinho, cobertura — nao ha quem segure a frente.
         *
         * E o unico jeito de subir a tensao sem subir dano nem precisao: o que
         * aperta o jogador nao e a bala do sujeito a sua frente, e o segundo
         * sujeito chegando pela lateral enquanto ele olha para o primeiro. */
        if (this.tEstado > 3.2 + Math.random() * 2.4) {
          this._trocar(this._temCompanhiaEngajada() && Math.random() < 0.55
            ? ESTADO.FLANQUEAR : ESTADO.COBERTURA);
        }
        this._atirar(dt, alvo);
        break;
      }

      case ESTADO.COBERTURA: {
        if (this.municao <= 0) { this._trocar(ESTADO.RECARREGAR); break; }
        if (!this.cobertura || this._tCobertura <= 0) {
          const c = this._acharCobertura(alvo);
          if (c) { this.cobertura = c; this._irPara(c); this._tCobertura = 3.5 + Math.random() * 3; }
          else { this._abrirFogo(); break; }
        }
        this._tCobertura -= dt;
        if (this._chegou(1.0)) {
          // Ciclo de espiar e atirar: 1.2s escondido, ~1.4s exposto.
          const fase = (this.tEstado % 2.6);
          this._espiando = fase > 1.2;
          if (this._espiando && this.percepcao.visivel) this._atirar(dt, alvo);
        }
        if (this._tCobertura <= 0) { this.cobertura = null; this._trocar(ESTADO.FLANQUEAR); }
        break;
      }

      case ESTADO.FLANQUEAR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        if (!this.temDestino || this._chegou(1.5)) {
          // ponto lateral em relacao ao alvo
          const ang = this.yaw + (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random() * 0.8);
          _v.copy(alvo.position);
          _v.x += Math.sin(ang) * 9;
          _v.z += Math.cos(ang) * 9;
          this._irPara(_v);
        }
        if (this.tEstado > 4 || (this.percepcao.visivel && this.percepcao.distAlvo < DIST_IDEAL)) {
          // so volta a atirar se houver vaga; senao segue contornando
          if (!this._abrirFogo(ESTADO.FLANQUEAR)) this.tEstado = 0;
        }
        break;
      }

      case ESTADO.RECARREGAR:
        if (this.tEstado === 0 || this.tEstado < dt * 1.5) {
          this.soldado.iniciarRecarga(2.3);
          /* Com posicao: a troca de pente do hostil sai espacializada, com
           * atenuacao por distancia, em vez de estalar centrada na cabeca do
           * jogador no mesmo volume da recarga dele. Ouvir de que canto vem o
           * "tunk" do pente e uma abertura de combate; ouvi-lo em 2D so confunde. */
          this.ctx.audio?.recarga?.('magout', this.pos);
        }
        if (this.tEstado > 2.3) {
          this.municao = MUNICAO_PENTE;
          if (this.percepcao.visivel) this._abrirFogo(ESTADO.COBERTURA);
          else this._trocar(ESTADO.PERSEGUIR);
        }
        break;
    }
  }

  /**
   * Entra em ATIRAR se houver vaga de fogo; senao vai manobrar.
   *
   * Tem de passar por AQUI em TODOS os caminhos que levam a ATIRAR. Na primeira
   * versao o teto so era checado em dois dos cinco (ALERTA e FLANQUEAR) e o
   * censo continuou mostrando cinco fuzis simultaneos com teto de quatro: a
   * maioria entra em ATIRAR vinda de PERSEGUIR.
   */
  _abrirFogo(alternativa = ESTADO.FLANQUEAR) {
    if (this.ctx.ai?.vagaDeFogo?.(this) === false) { this._trocar(alternativa); return false; }
    this._trocar(ESTADO.ATIRAR);
    return true;
  }

  /** Ha outro hostil vivo empenhado no alvo agora? (decide flanquear x cobrir) */
  _temCompanhiaEngajada() {
    const vivos = this.ctx.ai?.vivos;
    if (!vivos) return false;
    for (const o of vivos) {
      if (o === this || !o.alive) continue;
      if (o.estado === ESTADO.ATIRAR || o.estado === ESTADO.ALERTA) return true;
    }
    return false;
  }

  /**
   * Vigia: hostil PARADO e sem nenhuma consciencia gira o corpo para varrer o
   * entorno, como qualquer sentinela faz.
   *
   * PORQUE isto existe (medido, `tools/reacao.mjs`): o cone de visao tem 110
   * graus e o `yaw` de um hostil parado nao era escrito por ninguem. Resultado:
   * 250 graus de arco cego PERMANENTE. Um jogador em pe, a vista, com linha de
   * visada livre, a 6/12/20/30 m e 90 ou 180 graus do rumo do sentinela nunca
   * era notado — 25 s de medicao, consciencia final 0,00 nas oito celulas.
   * De frente (0 grau) o mesmo hostil notava em 0,2 s: a percepcao nunca foi o
   * problema, a imobilidade do olhar era.
   *
   * COMO nao brigar com quem mais escreve `yawAlvo`: `_mover` so escreve quando
   * ha ponto de caminho, e `_apontar` so quando o hostil ja esta mirando (logo,
   * ja consciente). A varredura roda exatamente no complemento disso — parado e
   * inconsciente — entao nenhum dos dois e sobrescrito.
   *
   * O giro guarda um LADO (`_ladoVigia`) e so o troca de vez em quando. Uma
   * varredura de lado sorteado a cada olhada e um passeio aleatorio: ela demora
   * a fechar a volta e pode ficar bailando no mesmo setor, que foi o que
   * derrubou a tentativa anterior de varredura.
   */
  _vigiar(dt) {
    const parado = !this.caminho.length && this.vel.lengthSq() < 0.05;
    const inconsciente = this.percepcao.consciencia < 0.35;
    const podeVarrer = this.estado === ESTADO.OCIOSO || this.estado === ESTADO.PATRULHA;
    if (!parado || !inconsciente || !podeVarrer) {
      this._varrendo = false;
      return;
    }
    this._varrendo = true;
    this._tVigia -= dt;
    // so escolhe novo azimute quando ja chegou perto do anterior: senao a
    // olhada nova comeca antes de a anterior terminar e o corpo nunca assenta
    let d = this.yawAlvo - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (this._tVigia > 0 || Math.abs(d) > 0.12) return;

    if (Math.random() < 0.22) this._ladoVigia = -this._ladoVigia;
    const [g0, g1] = VIGIA_GIRO;
    this.yawAlvo = this.yaw + (g0 + Math.random() * (g1 - g0)) * this._ladoVigia;
    const [e0, e1] = VIGIA_ESPERA;
    this._tVigia = e0 + Math.random() * (e1 - e0);
  }

  /* --- tiro --- */
  _atirar(dt, alvo) {
    // Convergencia da mira: o erro cai enquanto mantem o alvo a vista.
    this._erro += (this.dif.erroMin - this._erro) * Math.min(1, dt * this.dif.converge);
    this._tremor += dt;

    if (this._tPausa > 0) { this._tPausa -= dt; return; }
    this._tProxTiro -= dt;
    if (this._tProxTiro > 0) return;

    if (this.municao <= 0) return;
    this.municao--;
    this._naRajada++;

    // origem = boca do cano do soldado
    this.soldado.posCano(_v);

    /* Mira preditiva: aponta para onde o alvo VAI estar, não onde está.
     *
     * Sem isso o jogador anda de lado e a IA erra sempre, o que a faz parecer
     * burra mesmo com boa precisão. A antecipação é proporcional à competência
     * do perfil — recruta quase não lidera, veterano lidera quase tudo. */
    _v2.copy(alvo.eyePosition ?? alvo.position);
    const velAlvo = alvo.movement?.velocity ?? alvo.velocity;
    if (velAlvo) {
      const bruta = _v2.distanceTo(_v) / 380;          // tempo de voo aproximado
      const lideranca = THREE.MathUtils.clamp(1 - this.dif.erroMin / 0.04, 0, 1);
      _v2.addScaledVector(velAlvo, bruta * 60 * lideranca * 0.55);
    }

    _dir.subVectors(_v2, _v);
    const dist = _dir.length();
    _dir.normalize();

    // erro angular: base + tremor senoidal (mao humana nao fica parada)
    const e = this._erro * (1 + 0.25 * Math.sin(this._tremor * 9.1));
    _dir.x += (Math.random() * 2 - 1) * e;
    _dir.y += (Math.random() * 2 - 1) * e * 0.7;
    _dir.z += (Math.random() * 2 - 1) * e;
    _dir.normalize();

    this.soldado.dispararRecuo(1);
    this.ctx.bus?.emit('enemy:fire', { enemyId: this.id, origin: _v.clone(), dir: _dir.clone() });

    // Resolve o tiro: acerta o jogador so se a linha estiver realmente livre.
    const col = this.ctx.world?.collision;
    let bateuMundo = null;
    if (col?.raycast) bateuMundo = col.raycast(_v, _dir, Math.min(dist, ALCANCE_TIRO));
    const distParede = bateuMundo?.hit ? bateuMundo.distance : Infinity;

    if (dist < distParede && dist < ALCANCE_TIRO) {
      // checa se o raio com erro ainda passa perto o suficiente do jogador
      _v2.copy(_v).addScaledVector(_dir, dist);
      const alvoPt = alvo.eyePosition ?? alvo.position;
      if (_v2.distanceTo(alvoPt) < 0.45) {
        const queda = dist > 25 ? 0.7 : 1.0;
        alvo.takeDamage?.(this.dif.dano * queda, _dir);
      }
    } else if (bateuMundo?.hit) {
      this.ctx.bus?.emit('weapon:hit', {
        point: bateuMundo.point, normal: bateuMundo.normal,
        surface: bateuMundo.surface, target: 'world', enemyId: null,
      });
    }

    this._tProxTiro = 0.095 + Math.random() * 0.02;   // ~600 rpm

    const [rmin, rmax] = this.dif.rajada;
    if (this._naRajada >= rmin + Math.random() * (rmax - rmin)) {
      this._naRajada = 0;
      const [pmin, pmax] = this.dif.pausa;
      this._tPausa = pmin + Math.random() * (pmax - pmin);
    }
  }

  /* --- navegacao --- */
  _irPara(destino) {
    this.destino.copy(destino);
    this.temDestino = true;
    const nav = this.ctx.ai?.nav;
    if (!nav) return;
    const prio = (this.estado === ESTADO.ATIRAR || this.estado === ESTADO.PERSEGUIR) ? 2 : 0;
    nav.pedir(this._chaveNav, this.pos, destino, (pontos, n, ok) => {
      this.caminho.length = 0;
      if (ok && n > 0) for (let i = 0; i < n; i++) this.caminho.push(pontos[i].clone());
      else this.caminho.push(this.destino.clone());
      this.iCaminho = 0;
    }, prio);
  }

  _chegou(tol = 1.0) {
    if (!this.temDestino) return true;
    return this.pos.distanceTo(this.destino) < tol;
  }

  /**
   * Monta uma ronda curta em volta do ponto de nascimento, usando os pontos de
   * spawn do mundo que estejam a até 40 m. É ronda de vigia, não travessia de
   * mapa: 3 pontos bastam para o agente ficar em movimento e fazer barulho.
   */
  _rotaLocal(pos) {
    const pts = this.ctx.world?.getSpawnPoints?.() ?? [];
    const perto = [];
    for (const s of pts) {
      const p = s.position ?? s;
      const d = p.distanceTo(pos);
      if (d > 6 && d < 40) perto.push(p);
    }
    if (perto.length < 2) return [];
    // embaralha e pega 3
    for (let i = perto.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [perto[i], perto[j]] = [perto[j], perto[i]];
    }
    return perto.slice(0, 3).map((p) => p.clone());
  }

  _proximoPontoPatrulha() {
    if (!this.patrulha.length) { this.temDestino = false; return; }
    this.iPatrulha = (this.iPatrulha + 1) % this.patrulha.length;
    this._irPara(this.patrulha[this.iPatrulha]);
  }

  _acharCobertura(alvo) {
    const pontos = this.ctx.world?.getCoverPoints?.();
    if (!pontos?.length || !alvo) return null;
    let melhor = null, melhorNota = -Infinity;
    const amostras = Math.min(24, pontos.length);
    for (let k = 0; k < amostras; k++) {
      const p = pontos[(Math.random() * pontos.length) | 0];
      const pos = p.position ?? p;
      const d = this.pos.distanceTo(pos);
      if (d > 22 || d < 1.5) continue;
      // boa cobertura: perto de mim, longe do alvo, e sem linha de visada dele
      const dAlvo = pos.distanceTo(alvo.position);
      let nota = dAlvo * 0.6 - d * 0.9;
      const col = this.ctx.world?.collision;
      if (col?.raycast) {
        _v.copy(pos); _v.y += 1.5;
        _dir.subVectors(alvo.eyePosition ?? alvo.position, _v);
        const dd = _dir.length(); _dir.normalize();
        const r = col.raycast(_v, _dir, dd);
        if (r?.hit) nota += 14;    // bloqueado = e cobertura de verdade
      }
      if (nota > melhorNota) { melhorNota = nota; melhor = pos; }
    }
    return melhor;
  }

  _mover(dt) {
    const correndo = this.estado === ESTADO.PERSEGUIR || this.estado === ESTADO.FLANQUEAR
      || this.estado === ESTADO.COBERTURA;
    /* Trote no SUSPEITO. Investigar a 2,1 m/s de um ponto a 25 m custa 12 s de
     * caminhada mansa; com o reforco nascendo a 15 m ou mais, era isso que
     * fazia o combate ficar RALO (medido: 56 tiros de IA em 240 s com sete
     * hostis vivos). Nao e mais dano nem mais precisao — e chegar. */
    const vMax = correndo ? VEL_CORRER
      : (this.estado === ESTADO.SUSPEITO ? VEL_TROTE : VEL_ANDAR);

    let alvoPonto = null;
    if (this.caminho.length && this.iCaminho < this.caminho.length) {
      alvoPonto = this.caminho[this.iCaminho];
      if (this.pos.distanceTo(alvoPonto) < 0.7) {
        this.iCaminho++;
        if (this.iCaminho >= this.caminho.length) { this.caminho.length = 0; this.temDestino = false; }
      }
    }

    if (!alvoPonto) {
      this.vel.multiplyScalar(Math.max(0, 1 - dt * 8));
    } else {
      _dir.subVectors(alvoPonto, this.pos).setY(0);
      const d = _dir.length();
      if (d > 1e-3) {
        _dir.divideScalar(d);
        this.vel.x += (_dir.x * vMax - this.vel.x) * Math.min(1, dt * 7);
        this.vel.z += (_dir.z * vMax - this.vel.z) * Math.min(1, dt * 7);
        // vira o corpo para onde anda (a menos que esteja mirando)
        if (this.estado !== ESTADO.ATIRAR) this.yawAlvo = Math.atan2(_dir.x, _dir.z);
      }
    }

    /* Separação: empurra para longe de aliados muito próximos.
     *
     * Sem isto vários agentes convergem para o mesmo waypoint e viram um bolo
     * andando junto — fácil de matar e visivelmente burro. Uma repulsão fraca
     * já basta para eles se espalharem e ocuparem ângulos diferentes. */
    const aliados = this.ctx.ai?.vivos;
    if (aliados) {
      const RAIO_SEP = 2.2;
      for (const o of aliados) {
        if (o === this || !o.alive) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > RAIO_SEP * RAIO_SEP || d2 < 1e-4) continue;
        const d = Math.sqrt(d2);
        const forca = (1 - d / RAIO_SEP) * 2.6;
        this.vel.x += (dx / d) * forca * dt;
        this.vel.z += (dz / d) * forca * dt;
      }
    }

    // Integra e cola no chao. Sem cápsula completa: o inimigo anda em navGrid
    // valido, entao basta acompanhar a altura do terreno.
    _v.copy(this.pos).addScaledVector(this.vel, dt);
    const col = this.ctx.world?.collision;
    let superficie = 'concreto';
    let noChao = false;
    /* A sonda de chao e CONTABILIZADA no orcamento do `AIManager` (prioridade
     * de seguranca), mas NUNCA negada.
     *
     * MEDIDO NA MARRA: a versao que podia negar segurava a altura por um quadro
     * em vez de sondar. Parecia inofensivo — 8 cm de erro a 5 m/s. Nao e: a
     * boca do cano do hostil sai da matriz do esqueleto, que sai da altura do
     * corpo, e o tiro so acerta se o raio da boca ate o jogador estiver livre.
     * Com a altura defasada num morro de 36 m de desnivel o tiro passa a bater
     * no proprio chao. `tools/pressao.mjs` acusou: acerto da IA caindo de
     * 74,8% para 41,9% e dano por minuto de 392 para 114, com os hostis
     * parando a 13-33 m em vez de fechar para 4-19 m.
     *
     * A economia aqui era de 2 raios por quadro no p99. Nao vale o preco. */
    this.ctx.ai?.pedirRaio?.(2);
    if (col?.raycast) {
      /* Sonda longa: 2 m acima e 12 m abaixo. A anterior olhava só 4 m no
       * total, então ao sair de uma laje o raio não achava nada, o `y` ficava
       * congelado e o inimigo seguia ANDANDO NO AR até reencontrar terreno. */
      _v2.set(0, -1, 0);
      _olho.set(_v.x, _v.y + 2.0, _v.z);
      const r = col.raycast(_olho, _v2, 14);
      if (r?.hit) {
        const alvoY = r.point.y;
        superficie = r.surface || 'concreto';
        if (alvoY <= _v.y + 0.45) {
          // queda: acelera até o chão em vez de teleportar
          this.velY = (this.velY ?? 0) - 18 * dt;
          _v.y = Math.max(alvoY, _v.y + this.velY * dt);
          if (_v.y <= alvoY + 1e-3) { _v.y = alvoY; this.velY = 0; noChao = true; }
        } else {
          _v.y = alvoY;        // degrau para cima: sobe direto
          this.velY = 0;
          noChao = true;
        }
      } else {
        // sem terreno sob os pés: cai. Nunca fica parado no ar.
        this.velY = (this.velY ?? 0) - 18 * dt;
        _v.y += this.velY * dt;
      }
    } else { noChao = true; }
    /* Passo audível por DISTÂNCIA percorrida, não por timer: assim a cadência
     * acompanha a velocidade sozinha e não descola da animação. Sem isso o
     * inimigo se aproximava em silêncio absoluto e só era notado no tiro. */
    const andou = Math.hypot(_v.x - this.pos.x, _v.z - this.pos.z);
    this._distPasso = (this._distPasso ?? 0) + andou;
    const passada = correndo ? 1.05 : 0.78;
    /* Passo só toca com o pé no chão e dentro do alcance em que informa algo.
     *
     * HISTORICO: o corte ja foi 26 m, escolhido para conter estalo de audio —
     * diagnostico errado. O estalo era custo de sintese por som (~18 nos), nao
     * numero de passos; resolvido com cache de forma de onda no AudioEngine.
     * 26 m tirava do jogador a informacao mais util que o som carrega: dá para
     * ouvir a maquina subindo antes de ela aparecer na esquina.
     *
     * 42 m é o alcance em que o passo ainda diz de que lado vem alguem. Além
     * disso a atenuacao por distancia ja o deixa inaudivel de qualquer forma. */
    if (noChao && this._distPasso >= passada) {
      this._distPasso = 0;
      const cam = this.ctx.camera;
      if (!cam || cam.position.distanceToSquared(this.pos) < 42 * 42) {
        this.ctx.audio?.passo?.(superficie, this.pos, correndo);
      }
    }

    this.pos.copy(_v);

    /* Suaviza o giro do corpo. Varrendo o entorno o giro e LENTO: com o ganho
     * de combate (7) um sentinela viraria 90 graus em dois quadros, o que le
     * como teleporte de cabeca, nao como vigia olhando em volta. */
    let d = this.yawAlvo - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * (this._varrendo ? VIGIA_VEL : 7));
  }

  _apontar(dt, alvo) {
    const P = this.percepcao;
    const mirando = this.estado === ESTADO.ATIRAR
      || (this.estado === ESTADO.COBERTURA && this._espiando)
      || this.estado === ESTADO.ALERTA;

    if (mirando && alvo && (P.visivel || P.temUltima)) {
      const pt = P.visivel ? (alvo.eyePosition ?? alvo.position) : P.ultimaPos;
      this.soldado.setMira(pt, 1);
      this.soldado.setPoseArma('mira');
      _dir.subVectors(pt, this.pos).setY(0);
      if (_dir.lengthSq() > 1e-4) this.yawAlvo = Math.atan2(_dir.x, _dir.z);
    } else {
      this.soldado.setMira(null, 0);
      this.soldado.setPoseArma(this.estado === ESTADO.RECARREGAR ? 'recarga' : 'baixa');
    }
  }

  /* ------------------------------------------------------------------ */

  /** Posicao dos olhos (para a IA e para hit tests). */
  get eyePosition() { return this.soldado.posOlho(_olho).clone(); }
  get alive() { return this.ativo && !this.morto; }
  get position() { return this.pos; }

  /* ---------------------------------------------------------------------
   * Contrato compartilhado com o `Drone`.
   *
   * O drone nao tem `soldado`, nao tem esqueleto e nao tem ragdoll — mas o
   * `AIManager` precisa tratar os dois pela MESMA lista (`vivos`), pelo mesmo
   * orcamento de raycast, pelo mesmo LOD e pelo mesmo teto de atiradores. Estes
   * tres acessores sao a costura: quem chama nao precisa saber qual e qual.
   * ------------------------------------------------------------------- */

  /** Objeto de cena que o manager pendura no grupo da IA. */
  get objeto3d() { return this.soldado.grupo; }

  /** Posicao dos olhos, sem alocar (o getter acima clona). */
  posOlho(out) { return this.soldado.posOlho(out); }

  /** Ocupa uma das vagas do teto de atiradores simultaneos? */
  get ocupaVagaDeFogo() { return this.estado === ESTADO.ATIRAR; }

  /** Segundos que o corpo fica em cena antes de liberar a vaga do pool. */
  get vidaDoCorpo() { return 26; }

  dispose() {
    this.ragdoll?.dispose();
    this.soldado.dispose();
  }
}

export default Enemy;
