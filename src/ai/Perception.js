/**
 * Perception — sentidos de um agente.
 *
 * Visao: cone de 110 graus, alcance 45 m, com raycast de linha de visada saindo
 * dos OLHOS (osso da cabeca) para peito e cabeca do alvo, alternando por frame
 * para caber no orcamento de raios do AIManager.
 *
 * Consciencia gradual: uma barra 0..1 que enche mais rapido quanto mais perto e
 * mais centralizado o alvo estiver, e decai devagar quando o contato se perde.
 * Nada de omnisciencia instantanea — e isso que separa IA boa de IA injusta.
 *
 * Audicao: reage a `weapon:fire` com raio por arma, atenuado quando ha parede
 * entre a fonte e o agente.
 *
 * Dono: agente AI.
 */
import * as THREE from 'three';

const _dir = new THREE.Vector3();
const _olho = new THREE.Vector3();
const _alvoPt = new THREE.Vector3();
const _frente = new THREE.Vector3();

/** Constantes do modelo de consciencia. */
const TAXA_BASE = 3.0;          // 1/s no melhor caso (perto e centrado)
const DECAIMENTO = 0.26;        // 1/s quando nao ve
const ATRASO_DECAIR = 1.4;      // s de "inercia" antes de comecar a esquecer
const LIMIAR_SUSPEITA = 0.35;
const LIMIAR_ALERTA = 1.0;
const PERIFERIA_TOQUE = 3.0;    // m: tao perto que o FOV nao importa

export class Perception {
  /**
   * @param {object} ctx GameContext
   * @param {object} dono Enemy
   */
  constructor(ctx, dono) {
    this.ctx = ctx;
    this.dono = dono;

    this.fov = 110 * Math.PI / 180;     // angulo TOTAL
    this.alcance = 45;
    this.alcanceProximo = 14;           // dentro disso a visao periferica e melhor
    this.ganho = 1.0;                   // escala de dificuldade

    this.consciencia = 0;
    this.visivel = false;
    this.viuAlgumaVez = false;
    this.tempoSemVer = 999;
    this.tempoVendo = 0;
    this.distAlvo = Infinity;
    this.anguloAlvo = Math.PI;

    this.ultimaPos = new THREE.Vector3();      // ultima posicao conhecida do alvo
    this.ultimaVel = new THREE.Vector3();
    this.temUltima = false;
    this.origemSom = new THREE.Vector3();
    this.temSom = false;
    this.tempoDesdeSom = 999;

    this._alternaAlvo = 0;
    this._raioValidoAte = 0;    // resultado de LOS vale ate este tempo (economia)
    this._losCache = false;
    this._t = 0;
  }

  reset() {
    this.consciencia = 0;
    this.visivel = false;
    this.viuAlgumaVez = false;
    this.tempoSemVer = 999;
    this.tempoVendo = 0;
    this.temUltima = false;
    this.temSom = false;
    this.tempoDesdeSom = 999;
    this._losCache = false;
    this._raioValidoAte = 0;
  }

  get suspeito() { return this.consciencia >= LIMIAR_SUSPEITA; }
  get alerta() { return this.consciencia >= LIMIAR_ALERTA; }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} olho posicao dos olhos do agente (mundo)
   * @param {THREE.Vector3} frente direcao para onde a cabeca aponta (normalizada)
   * @param {object|null} alvo  {position, eyePosition, alive}
   * @param {boolean} temOrcamento se false, reaproveita o ultimo resultado de LOS
   */
  update(dt, olho, frente, alvo, temOrcamento = true) {
    this._t += dt;
    this.tempoSemVer += dt;
    this.tempoDesdeSom += dt;

    const vivo = alvo && alvo.alive !== false;
    this.visivel = false;

    if (vivo) {
      _olho.copy(olho);
      _frente.copy(frente);
      // mira no peito por padrao, alterna com a cabeca (silhueta parcial atras de muro)
      const alvoOlho = alvo.eyePosition || alvo.position;
      this._alternaAlvo ^= 1;
      if (this._alternaAlvo) {
        _alvoPt.copy(alvoOlho);
      } else {
        _alvoPt.copy(alvo.position); _alvoPt.y += 1.05;
      }

      _dir.subVectors(_alvoPt, _olho);
      const dist = _dir.length();
      this.distAlvo = dist;
      _dir.multiplyScalar(1 / Math.max(1e-5, dist));
      const cosAng = _dir.dot(_frente);
      this.anguloAlvo = Math.acos(Math.max(-1, Math.min(1, cosAng)));

      const dentroCone = this.anguloAlvo <= this.fov * 0.5;
      const coladoAtras = dist < PERIFERIA_TOQUE;

      if (dist <= this.alcance && (dentroCone || coladoAtras)) {
        let livre;
        if (temOrcamento || this._t > this._raioValidoAte) {
          livre = this._linhaDeVisada(_olho, _alvoPt, dist);
          this._losCache = livre;
          this._raioValidoAte = this._t + 0.12;   // ~8 Hz de reamostragem minima
        } else {
          livre = this._losCache;
        }
        if (livre) {
          this.visivel = true;
          this.tempoSemVer = 0;
          this.tempoVendo += dt;
          this.viuAlgumaVez = true;
          this.ultimaPos.copy(alvo.position);
          if (alvo.velocity) this.ultimaVel.copy(alvo.velocity);
          this.temUltima = true;
        }
      }
    }

    if (this.visivel) {
      // fator de distancia: cai suave, nunca zera dentro do alcance
      const fd = Math.pow(Math.max(0.12, 1 - this.distAlvo / this.alcance), 0.85);
      // fator de centralidade do FOV
      const fc = Math.max(0.15, 1 - (this.anguloAlvo / (this.fov * 0.5)) * 0.9);
      // alvo agachado/parado e mais dificil de notar
      let fm = 1;
      const dono = this.dono;
      if (dono?.ctx?.player) {
        const p = dono.ctx.player;
        if (p.state === 'agachado' || p.state === 'crouch') fm *= 0.62;
        if (p.velocity && p.velocity.lengthSq() > 25) fm *= 1.35;
      }
      if (this.distAlvo < PERIFERIA_TOQUE) fm *= 3.0;
      this.consciencia = Math.min(1.6, this.consciencia + TAXA_BASE * fd * fc * fm * this.ganho * dt);
    } else {
      this.tempoVendo = 0;
      if (this.tempoSemVer > ATRASO_DECAIR) {
        const taxa = DECAIMENTO * (this.consciencia > LIMIAR_ALERTA ? 0.55 : 1.0);
        this.consciencia = Math.max(0, this.consciencia - taxa * dt);
      }
    }
  }

  /** Raycast de oclusao contra o mundo. `true` se nada bloqueia. */
  _linhaDeVisada(de, para, dist) {
    const col = this.ctx?.world?.collision;
    if (!col || !col.raycast) return true;
    _dir.subVectors(para, de).multiplyScalar(1 / Math.max(1e-5, dist));
    const r = col.raycast(de, _dir, dist - 0.12);
    this.dono?.contarRaio?.();
    return !r || !r.hit;
  }

  /**
   * Som ouvido. `raio` ja e o raio nominal da arma; a atenuacao por parede e
   * calculada aqui (uma unica sondagem).
   * @returns {boolean} se o som foi de fato percebido
   */
  ouvir(posicao, raio, forca = 1.0, olho = null) {
    const p = olho || this.ultimaPos;
    const dx = posicao.x - p.x, dy = posicao.y - p.y, dz = posicao.z - p.z;
    let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > raio) return false;

    let atenuacao = 1;
    const col = this.ctx?.world?.collision;
    if (col && col.raycast && dist > 1.2) {
      _dir.set(dx / dist, dy / dist, dz / dist).negate();
      const r = col.raycast(posicao, _dir, dist - 0.3);
      this.dono?.contarRaio?.();
      if (r && r.hit) atenuacao = 0.42;     // parede no meio: abafa
    }
    const alcanceEfetivo = raio * atenuacao;
    if (dist > alcanceEfetivo) return false;

    const intensidade = (1 - dist / alcanceEfetivo) * forca * atenuacao;
    this.consciencia = Math.min(1.25, this.consciencia + 0.30 + intensidade * 0.55);
    this.origemSom.copy(posicao);
    this.temSom = true;
    this.tempoDesdeSom = 0;
    if (!this.visivel) {
      // som nao entrega posicao exata: erro proporcional a distancia
      const err = Math.min(6, dist * 0.18) * (1 - atenuacao * 0.5);
      this.ultimaPos.set(
        posicao.x + (Math.random() * 2 - 1) * err,
        posicao.y,
        posicao.z + (Math.random() * 2 - 1) * err,
      );
      this.temUltima = true;
    }
    return true;
  }

  /** Empurra a consciencia direto (dano recebido, aliado gritando). */
  avisar(posicao, quanto = 0.7) {
    this.consciencia = Math.min(1.4, this.consciencia + quanto);
    if (posicao) { this.ultimaPos.copy(posicao); this.temUltima = true; }
  }
}

export default Perception;
