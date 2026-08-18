/**
 * Movement — locomoção do jogador no estilo Call of Duty moderno.
 * Dono: PLAYER.
 *
 * Modelo Quake/Source adaptado: aceleração e atrito SEPARADOS para solo e ar,
 * com velocidade-alvo por estado. Parar nunca é instantâneo (o atrito é
 * exponencial até `stopSpeed`, depois linear) — é daí que vem a inércia.
 *
 * Colisão: `ctx.world.collision.capsuleSweep(start, end, radius, height)`
 *   `start`/`end` são a posição dos PÉS (base da cápsula).
 *   Retorna `{position, grounded, normal}`.
 * Se o WORLD ainda não existir, cai num plano infinito em y=0 (só para teste).
 */

import * as THREE from 'three';

const G = 9.81;

/** Dimensões da cápsula e do olho (metros). */
export const DIM = {
  radius: 0.35,
  heightStand: 1.80,
  heightCrouch: 1.05,
  eyeStand: 1.68,
  eyeCrouch: 0.95,
  eyeSlide: 0.78,
  stepHeight: 0.40,
  mantleMax: 1.30,
  mantleMin: 0.35,
};

/** Velocidades-alvo (m/s). */
export const SPEED = {
  walk: 4.3,
  sprint: 6.6,
  crouch: 2.2,
  ads: 2.9,
  slideEntry: 8.6,
  slideMin: 2.7,
  air: 6.8,
};

const TUNE = {
  groundAccel: 11.0,
  groundFriction: 6.4,
  stopSpeed: 1.55,
  airAccel: 30.0,
  airWishCap: 3.0,       // teto de wishSpeed no ar: controle sem virar voo
  airFriction: 0.06,
  slideFriction: 1.55,
  slideMaxTime: 1.45,
  slideCooldown: 0.55,
  jumpHeight: 1.10,   // medido ~1,05 m de pico com passo discreto
  crouchLerp: 9.5,       // 1/s
  coyoteTime: 0.11,
  jumpBuffer: 0.14,
};

/* --- temporários de módulo (zero alocação por frame) --- *
 * Cada um tem um dono claro: reaproveitar o mesmo vetor em dois lugares que
 * se cruzam (sweep dentro de raycast, por exemplo) corrompe silenciosamente. */
const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _end = new THREE.Vector3();
const _prevPos = new THREE.Vector3();
const _sweepPos = new THREE.Vector3();
const _castOrigin = new THREE.Vector3();
const _castPoint = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _dest = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _fallbackHit = { hit: false, point: _castPoint, normal: _up, surface: 'concreto', distance: Infinity };
const _fallbackMiss = { hit: false, point: null, normal: null, surface: null, distance: Infinity };

export class Movement {
  constructor(ctx) {
    this.ctx = ctx;

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.surface = 'concreto';

    this.state = 'parado';   // parado|andando|correndo|agachado|deslizando|ar|mantle
    this.speed = 0;
    this.planarSpeed = 0;
    this.stepDelta = 0;

    this.crouchT = 0;        // 0 em pé, 1 agachado
    this.sprintT = 0;
    this.slideT = 0;
    this.slideSide = 1;
    this.strafe = 0;         // -1..1, suavizado (usado no tilt de câmera)
    this.eyeHeight = DIM.eyeStand;
    this.capsuleHeight = DIM.heightStand;

    this.wantCrouch = false;
    this.sprinting = false;
    this.wishDir = new THREE.Vector3();

    this._slideTime = 0;
    this._slideCooldown = 0;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._airTime = 0;
    this._stepAccum = 0;
    this._surfaceCheck = 0;
    this._prevGrounded = true;

    /* --- mantle --- */
    this.mantling = false;
    this.mantleOffset = new THREE.Vector3();
    this.mantleRoll = 0;
    this._mantleT = 0;
    this._mantleDur = 0.5;
    this._mantleFrom = new THREE.Vector3();
    this._mantleTo = new THREE.Vector3();
    this._mantleHeight = 0;
    this._mantleCooldown = 0;
  }

  /* ================================================================ *
   * Colisão (contrato do WORLD, com fallback de plano)
   * ================================================================ */
  get _col() { return this.ctx.world?.collision ?? null; }

  _sweep(start, end, radius, height) {
    const c = this._col;
    if (c?.capsuleSweep) return c.capsuleSweep(start, end, radius, height);
    // Fallback: plano infinito em y=0 (só enquanto o WORLD não existe).
    const grounded = end.y <= 0.0001;
    _sweepPos.copy(end);
    if (grounded) _sweepPos.y = 0;
    this._fbSweep = this._fbSweep || { position: _sweepPos, grounded: false, normal: _up };
    this._fbSweep.grounded = grounded;
    return this._fbSweep;
  }

  _raycast(origin, dir, maxDist) {
    const c = this._col;
    if (c?.raycast) return c.raycast(origin, dir, maxDist);
    if (dir.y < -0.5 && origin.y > 0) {
      const d = origin.y / -dir.y;
      if (d <= maxDist) {
        _castPoint.set(origin.x, 0, origin.z);
        _fallbackHit.hit = true; _fallbackHit.distance = d;
        return _fallbackHit;
      }
    }
    return _fallbackMiss;
  }

  /* ================================================================ *
   * Aceleração estilo Quake
   * ================================================================ */
  _accelerate(wishDir, wishSpeed, accel, dt) {
    const cur = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    let a = accel * wishSpeed * dt;
    if (a > add) a = add;
    this.velocity.x += a * wishDir.x;
    this.velocity.z += a * wishDir.z;
  }

  _friction(fric, dt) {
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp < 1e-4) { this.velocity.x = 0; this.velocity.z = 0; return; }
    const control = sp < TUNE.stopSpeed ? TUNE.stopSpeed : sp;
    const drop = control * fric * dt;
    const ns = Math.max(0, sp - drop) / sp;
    this.velocity.x *= ns;
    this.velocity.z *= ns;
  }

  /* ================================================================ *
   * Update
   * ================================================================ */

  /**
   * @param {number} dt
   * @param {object} cmd {move:{x,y}, yaw, jump, jumpDown, crouchDown, crouchPressed,
   *                      sprint, ads, frozen}
   */
  update(dt, cmd) {
    this._slideCooldown = Math.max(0, this._slideCooldown - dt);
    this._mantleCooldown = Math.max(0, this._mantleCooldown - dt);
    _prevPos.copy(this.position);

    if (this.mantling) { this._updateMantle(dt); this._finishFrame(dt, _prevPos, cmd); return; }

    /* --- eixos horizontais a partir do yaw --- */
    const yaw = cmd.yaw ?? 0;
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const mv = cmd.move ?? { x: 0, y: 0 };
    _wish.set(0, 0, 0)
      .addScaledVector(_fwd, mv.y)
      .addScaledVector(_right, mv.x);
    const wishLen = _wish.length();
    if (wishLen > 1e-4) _wish.multiplyScalar(1 / wishLen);
    this.wishDir.copy(_wish);

    // Strafe suavizado para o tilt de câmera
    this.strafe += (mv.x - this.strafe) * Math.min(1, dt * 9);

    /* --- buffers de pulo / coyote time --- */
    if (cmd.jump) this._jumpBuffer = TUNE.jumpBuffer;
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    this._coyote = this.grounded ? TUNE.coyoteTime : Math.max(0, this._coyote - dt);

    /* --- agachar / deslizar --- */
    const planar0 = Math.hypot(this.velocity.x, this.velocity.z);
    const wantSprint = !!cmd.sprint && !cmd.ads && mv.y > 0.35 && !this.wantCrouch;

    if (cmd.crouchPressed && this.state !== 'deslizando'
      && this.grounded && planar0 > 5.0 && this._slideCooldown === 0) {
      this._startSlide(planar0);
    } else if (cmd.crouchDown) {
      this.wantCrouch = true;
    } else if (this.wantCrouch && this._canStand()) {
      this.wantCrouch = false;
    }

    if (this.state === 'deslizando') {
      this._slideTime += dt;
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      const cancel = !cmd.crouchDown || sp < SPEED.slideMin
        || this._slideTime > TUNE.slideMaxTime || !this.grounded || this._jumpBuffer > 0;
      if (cancel) {
        this.state = 'agachado';
        this._slideCooldown = TUNE.slideCooldown;
        this.wantCrouch = cmd.crouchDown && !this._canStand() ? true : !!cmd.crouchDown;
      }
    }

    const sliding = this.state === 'deslizando';
    const crouched = this.wantCrouch || sliding || !this._canStand();
    this.sprinting = wantSprint && this.grounded && !sliding && !crouched;

    /* --- alturas: cápsula e olho interpolados --- */
    const crouchTarget = sliding ? 1 : (crouched ? 1 : 0);
    this.crouchT += (crouchTarget - this.crouchT) * Math.min(1, dt * TUNE.crouchLerp);
    this.sprintT += ((this.sprinting && planar0 > 4.2 ? 1 : 0) - this.sprintT) * Math.min(1, dt * 7);
    this.slideT += ((sliding ? 1 : 0) - this.slideT) * Math.min(1, dt * (sliding ? 14 : 7));
    this.capsuleHeight = THREE.MathUtils.lerp(DIM.heightStand, DIM.heightCrouch, this.crouchT);
    const eyeBase = THREE.MathUtils.lerp(DIM.eyeStand, DIM.eyeCrouch, this.crouchT);
    this.eyeHeight = THREE.MathUtils.lerp(eyeBase, DIM.eyeSlide, this.slideT * 0.85);

    /* --- velocidade-alvo --- */
    let maxSpeed;
    if (sliding) maxSpeed = SPEED.slideEntry;
    else if (crouched) maxSpeed = SPEED.crouch;
    else if (cmd.ads) maxSpeed = SPEED.ads;
    else if (this.sprinting) maxSpeed = SPEED.sprint;
    else maxSpeed = SPEED.walk;
    // Andar para trás/lado é mais lento (ninguém corre de ré).
    if (!sliding && mv.y < -0.1) maxSpeed *= 0.82;

    /* --- integração horizontal --- */
    if (this.grounded) {
      if (sliding) {
        this._friction(TUNE.slideFriction, dt);
        // Controle residual: dá pra curvar o slide, não pra acelerar.
        this._accelerate(_wish, Math.min(SPEED.crouch, maxSpeed), 2.2, dt);
      } else {
        if (wishLen < 1e-4) this._friction(TUNE.groundFriction, dt);
        else this._friction(TUNE.groundFriction * 0.55, dt);
        this._accelerate(_wish, maxSpeed * wishLen, TUNE.groundAccel, dt);
      }
    } else {
      this._friction(TUNE.airFriction, dt);
      this._accelerate(_wish, Math.min(TUNE.airWishCap, maxSpeed * wishLen), TUNE.airAccel, dt);
    }

    /* --- mantle tem prioridade sobre o pulo: apertar espaço encarando uma
     *     borda alcançável sobe nela em vez de pular contra a parede. --- */
    if (!this.mantling && this._mantleCooldown === 0 && wishLen > 0.2 && this._jumpBuffer > 0) {
      if (this._tryMantle()) { this._jumpBuffer = 0; this._finishFrame(dt, _prevPos, cmd); return; }
    }

    /* --- pulo --- */
    if (this._jumpBuffer > 0 && (this.grounded || this._coyote > 0) && this._canStand()) {
      this.velocity.y = Math.sqrt(2 * G * TUNE.jumpHeight);
      this._jumpBuffer = 0; this._coyote = 0;
      this.grounded = false;
      if (sliding) {
        // Cancelar o slide pulando devolve um empurrão (slide-hop).
        this.state = 'ar';
        this._slideCooldown = TUNE.slideCooldown;
        const sp = Math.hypot(this.velocity.x, this.velocity.z);
        if (sp > 0.1) { const k = Math.min(1.12, SPEED.slideEntry / sp); this.velocity.x *= k; this.velocity.z *= k; }
      }
      this.wantCrouch = false;
    }

    /* --- gravidade --- */
    if (!this.grounded) {
      this.velocity.y -= G * dt;
      if (this.velocity.y < -55) this.velocity.y = -55;
      this._airTime += dt;
    } else if (this.velocity.y < 0) {
      this.velocity.y = -2.0;   // cola no chão em rampas/degraus
    }

    /* --- vault automático no ar (pulou e encostou numa borda) --- */
    if (!this.mantling && this._mantleCooldown === 0 && wishLen > 0.2
      && !this.grounded && this.velocity.y < 2.0 && this._airTime > 0.06) {
      if (this._tryMantle()) { this._finishFrame(dt, _prevPos, cmd); return; }
    }

    /* --- varredura da cápsula --- */
    _end.copy(this.position).addScaledVector(this.velocity, dt);
    const res = this._sweep(this.position, _end, DIM.radius, this.capsuleHeight);
    const blockedX = Math.abs(res.position.x - _end.x) > 1e-4;
    const blockedZ = Math.abs(res.position.z - _end.z) > 1e-4;
    this.position.copy(res.position);

    const wasGrounded = this.grounded;
    this.grounded = !!res.grounded;
    if (res.normal) this.groundNormal.copy(res.normal);

    // Mata a componente da velocidade que entrou na parede.
    if (blockedX) this.velocity.x = 0;
    if (blockedZ) this.velocity.z = 0;
    if (this.grounded) {
      if (!wasGrounded) this._onLand();
      this._airTime = 0;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    this._finishFrame(dt, _prevPos, cmd);
  }

  /* ================================================================ *
   * Estado derivado, passos, aterrissagem
   * ================================================================ */
  _finishFrame(dt, prevPos, cmd) {
    this.speed = this.velocity.length();
    this.planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.stepDelta = Math.hypot(this.position.x - prevPos.x, this.position.z - prevPos.z);

    if (this.mantling) this.state = 'mantle';
    else if (this.state !== 'deslizando') {
      if (!this.grounded) this.state = 'ar';
      else if (this.crouchT > 0.5) this.state = 'agachado';
      else if (this.sprinting && this.planarSpeed > 4.2) this.state = 'correndo';
      else if (this.planarSpeed > 0.35) this.state = 'andando';
      else this.state = 'parado';
    }

    /* --- superfície sob os pés (amostrada a 10 Hz) --- */
    this._surfaceCheck -= dt;
    if (this._surfaceCheck <= 0) {
      this._surfaceCheck = 0.1;
      _castOrigin.copy(this.position); _castOrigin.y += 0.25;
      const r = this._raycast(_castOrigin, _down, 0.9);
      if (r?.hit && r.surface) this.surface = r.surface;
    }

    /* --- passos por DISTÂNCIA, não por timer --- */
    if (this.grounded && !this.mantling && this.state !== 'deslizando' && this.planarSpeed > 0.6) {
      this._stepAccum += this.stepDelta;
      const stride = this.state === 'correndo' ? 1.95
        : this.state === 'agachado' ? 1.35 : 1.55;
      if (this._stepAccum >= stride) {
        this._stepAccum -= stride;
        this.ctx.bus?.emit('player:footstep', {
          surface: this.surface,
          position: this.position,
          running: this.state === 'correndo',
        });
      }
    } else if (this.planarSpeed < 0.4) {
      // Ao parar, adianta a fase para o próximo passo sair no pé certo.
      this._stepAccum = Math.min(this._stepAccum, 1.0);
    }
  }

  _onLand() {
    // Só conta como aterrissagem se houve queda de verdade: sem isso um degrau
    // de 2 cm dispara som e dip de câmera a cada frame.
    const impact = Math.abs(this.velocity.y);
    if (impact < 1.2 || this._airTime < 0.08) return;
    this.ctx.bus?.emit('player:land', { velocity: impact, surface: this.surface });
    this._landImpact = impact;
  }

  /** Consome (e zera) o impacto da última aterrissagem. */
  consumeLandImpact() {
    const v = this._landImpact ?? 0;
    this._landImpact = 0;
    return v;
  }

  /* ================================================================ *
   * Deslize
   * ================================================================ */
  _startSlide(planar) {
    this.state = 'deslizando';
    this._slideTime = 0;
    this.wantCrouch = true;
    const dir = _dirTmp.set(this.velocity.x, 0, this.velocity.z);
    if (dir.lengthSq() < 1e-6) dir.copy(this.wishDir);
    dir.normalize();
    const target = Math.max(SPEED.slideEntry, planar * 1.18);
    this.velocity.x = dir.x * target;
    this.velocity.z = dir.z * target;
    // Lado do roll: alterna conforme o strafe para não ficar mecânico.
    this.slideSide = this.strafe >= 0 ? 1 : -1;
    if (Math.abs(this.strafe) < 0.15) this.slideSide = Math.random() < 0.5 ? 1 : -1;
  }

  /** Há espaço para levantar? */
  _canStand() {
    if (this.crouchT < 0.02) return true;
    _castOrigin.copy(this.position); _castOrigin.y += DIM.heightCrouch - 0.05;
    const need = DIM.heightStand - DIM.heightCrouch + 0.12;
    const r = this._raycast(_castOrigin, _up, need);
    return !(r?.hit);
  }

  /* ================================================================ *
   * Mantle / vault
   * ================================================================ */
  _tryMantle() {
    const dir = _dirTmp.copy(this.wishDir);
    if (dir.lengthSq() < 1e-4) return false;
    dir.y = 0; dir.normalize();

    // 1) tem parede logo à frente? Sonda em três alturas — uma borda de 0,5 m
    //    passa por baixo de um raio na altura do peito.
    let hitDist = -1;
    for (const h of [0.22, 0.55, 0.85]) {
      const o = _castOrigin.set(this.position.x, this.position.y + h, this.position.z);
      const wall = this._raycast(o, dir, DIM.radius + 0.45);
      if (!wall?.hit) continue;
      if (wall.normal && Math.abs(wall.normal.y) > 0.5) continue;   // é rampa, não borda
      hitDist = wall.distance;
      break;
    }
    if (hitDist < 0) return false;
    // 2) onde está o topo? sonda de cima para baixo, um pouco além da parede.
    const probe = _probe.set(
      this.position.x + dir.x * (hitDist + 0.30),
      this.position.y + DIM.mantleMax + 0.35,
      this.position.z + dir.z * (hitDist + 0.30));
    const top = this._raycast(probe, _down, DIM.mantleMax + 0.45);
    if (!top?.hit) return false;

    const h = top.point.y - this.position.y;
    if (h < DIM.mantleMin || h > DIM.mantleMax) return false;
    if (top.normal && top.normal.y < 0.6) return false;               // topo inclinado demais

    // 3) cabe em pé lá em cima?
    const dest = _dest.set(
      this.position.x + dir.x * (hitDist + 0.42),
      top.point.y + 0.02,
      this.position.z + dir.z * (hitDist + 0.42));
    const head = _castOrigin.set(dest.x, dest.y + 0.15, dest.z);
    const clear = this._raycast(head, _up, DIM.heightCrouch);
    if (clear?.hit) return false;

    this.mantling = true;
    this.state = 'mantle';
    this._mantleT = 0;
    this._mantleHeight = h;
    this._mantleDur = 0.34 + h * 0.20;
    this._mantleFrom.copy(this.position);
    this._mantleTo.copy(dest);
    this.velocity.set(0, 0, 0);
    this._jumpBuffer = 0;
    this.wantCrouch = false;
    return true;
  }

  _updateMantle(dt) {
    this._mantleT += dt / this._mantleDur;
    const t = Math.min(1, this._mantleT);

    // Sobe primeiro (ease-out), depois entra para dentro (ease-in-out).
    const up = 1 - Math.pow(1 - Math.min(1, t / 0.62), 3);
    const fw = THREE.MathUtils.smoothstep(t, 0.30, 1.0);

    this.position.x = THREE.MathUtils.lerp(this._mantleFrom.x, this._mantleTo.x, fw);
    this.position.z = THREE.MathUtils.lerp(this._mantleFrom.z, this._mantleTo.z, fw);
    this.position.y = THREE.MathUtils.lerp(this._mantleFrom.y, this._mantleTo.y, up);

    // Câmera: mergulha, cabeceia e rola um pouco — sensação de puxar o corpo.
    const s = Math.sin(Math.PI * t);
    this.mantleOffset.set(0, -0.16 * s * (0.5 + this._mantleHeight * 0.4), 0);
    this.mantleRoll = -0.14 * s;
    this.eyeHeight = THREE.MathUtils.lerp(DIM.eyeCrouch + 0.12, DIM.eyeStand, Math.min(1, t * 1.5));
    this.capsuleHeight = DIM.heightCrouch;
    this.crouchT = 1 - Math.min(1, t * 1.4);

    if (t >= 1) {
      this.mantling = false;
      this.mantleOffset.set(0, 0, 0);
      this.mantleRoll = 0;
      this.grounded = true;
      this.state = 'parado';
      this._mantleCooldown = 0.25;
      this.velocity.set(0, 0, 0);
      this.crouchT = 0;
    }
  }

  /* ================================================================ *
   * Utilidades
   * ================================================================ */
  /**
   * Teleporte com guarda contra POUSO DEBAIXO DO MORRO.
   *
   * O terreno nao tem fundo: a "saia" das bordas e so malha visual, nao entra
   * no BVH. Quem for posto ABAIXO da cota do terreno nao penetra nada, entao a
   * depenetracao nao tem em que se apoiar e a sonda de chao nao acha piso
   * nenhum — o personagem cai em queda livre ate `Player._checarQueda` o
   * resgatar dezenas de metros abaixo. De dentro do jogo isso le exatamente
   * como "atravessei o chao", e foi o que uma ferramenta de medicao produziu
   * ao largar o jogador numa cota FIXA (`cotaMin + 30`) numa borda onde o
   * morro sobe a 32 m — 5,8 m dentro da encosta. Ver `tools/piso.mjs`.
   *
   * A referencia e o PLANO do terreno (`world.heightAt`), nao um raio de cima
   * para baixo: o raio devolveria o telhado de quem esta dentro de casa e o
   * teleporte para o interior de uma casa passaria a jogar o jogador em cima
   * dela. O piso de qualquer construcao esta na cota do terreno ou acima, entao
   * a guarda so pega quem realmente ficou dentro do morro.
   *
   * Avisa em vez de corrigir calado: destino ruim e defeito de quem chamou.
   */
  teleport(x, y, z) {
    const chao = this.ctx?.world?.heightAt?.(x, z);
    if (Number.isFinite(chao) && y < chao - 0.5) {
      console.warn(`[Movement] teleporte para dentro do morro em (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}); `
        + `terreno esta em ${chao.toFixed(1)} m, subindo para a cota do chao`);
      y = chao + 0.10;
    }
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.mantling = false;
    this.state = 'ar';
    this.crouchT = 0; this.slideT = 0; this.sprintT = 0;
    this._stepAccum = 0;
  }

  /** Estado empacotado para o CameraRig e o ViewModel. */
  readState(out) {
    out.position = this.position;
    out.eyeHeight = this.eyeHeight;
    out.speed = this.speed;
    out.planarSpeed = this.planarSpeed;
    out.grounded = this.grounded;
    out.state = this.state;
    out.strafe = this.strafe;
    out.stepDelta = this.stepDelta;
    out.sprintT = this.sprintT;
    out.slideT = this.slideT;
    out.slideSide = this.slideSide;
    out.crouchT = this.crouchT;
    out.mantleOffset = this.mantling ? this.mantleOffset : null;
    out.mantleRoll = this.mantleRoll;
    return out;
  }
}
