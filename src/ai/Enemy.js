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

/** Perfis de dificuldade. */
export const DIFICULDADE = {
  facil:   { reacao: [0.55, 0.95], erro0: 0.13, erroMin: 0.035, converge: 1.6, rajada: [2, 4], pausa: [0.7, 1.4], dano: 7 },
  normal:  { reacao: [0.32, 0.62], erro0: 0.10, erroMin: 0.020, converge: 2.4, rajada: [3, 6], pausa: [0.5, 1.1], dano: 10 },
  dificil: { reacao: [0.22, 0.42], erro0: 0.075, erroMin: 0.011, converge: 3.4, rajada: [4, 8], pausa: [0.35, 0.8], dano: 13 },
};

const VEL_ANDAR = 2.1;
const VEL_CORRER = 4.6;
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

      case ESTADO.SUSPEITO:
        // Vai investigar a ultima posicao conhecida / origem do som.
        if (P.alerta) { this._trocar(ESTADO.ALERTA); break; }
        if (P.consciencia <= 0.05) { this._trocar(this.patrulha.length ? ESTADO.PATRULHA : ESTADO.OCIOSO); break; }
        if (!this.temDestino || this._chegou(1.5)) {
          const p = P.temSom ? P.origemSom : (P.temUltima ? P.ultimaPos : null);
          if (p) this._irPara(p);
        }
        break;

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
          this._trocar(P.visivel ? ESTADO.ATIRAR : ESTADO.PERSEGUIR);
        }
        break;

      case ESTADO.PERSEGUIR: {
        if (!temAlvo) { this._trocar(ESTADO.PATRULHA); break; }
        if (P.visivel && P.distAlvo < ALCANCE_TIRO) { this._trocar(ESTADO.ATIRAR); break; }
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
        // Sob fogo prolongado, procura cobertura.
        if (this.tEstado > 3.5 + Math.random() * 2.5) this._trocar(ESTADO.COBERTURA);
        this._atirar(dt, alvo);
        break;
      }

      case ESTADO.COBERTURA: {
        if (this.municao <= 0) { this._trocar(ESTADO.RECARREGAR); break; }
        if (!this.cobertura || this._tCobertura <= 0) {
          const c = this._acharCobertura(alvo);
          if (c) { this.cobertura = c; this._irPara(c); this._tCobertura = 6 + Math.random() * 4; }
          else { this._trocar(ESTADO.ATIRAR); break; }
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
          this._trocar(ESTADO.ATIRAR);
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
          this._trocar(this.percepcao.visivel ? ESTADO.ATIRAR : ESTADO.PERSEGUIR);
        }
        break;
    }
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
    const vMax = correndo ? VEL_CORRER : VEL_ANDAR;

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

    // suaviza o giro do corpo
    let d = this.yawAlvo - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 7);
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

  dispose() {
    this.ragdoll?.dispose();
    this.soldado.dispose();
  }
}

export default Enemy;
