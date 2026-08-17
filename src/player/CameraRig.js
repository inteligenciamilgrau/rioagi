/**
 * CameraRig — a câmera do jogador montada em CAMADAS SOMÁVEIS.
 * Dono: PLAYER.
 *
 * Cada camada é uma mola com amortecimento (implícita, incondicionalmente
 * estável). Nada de senoide crua entrando direto na câmera: a senoide só
 * define o ALVO das molas de bob; o que a câmera vê é sempre a resposta
 * amortecida. É isso que dá peso.
 *
 * Camadas: bob de passo (elíptico) · sway por mouse · tilt de strafe ·
 * roll de deslize · kick de recuo (com overshoot) · shake direcional de dano ·
 * punch de explosão · dip de aterrissagem · offset de mantle · FOV dinâmico.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ *
 * Mola amortecida — integração implícita (estável para qualquer dt)
 *   v' = (v - h·ω²·(x - alvo)) / (1 + 2ζhω + h²ω²)
 *   x' = x + h·v'
 * ζ = 1 → crítica (sem overshoot). ζ < 1 → overshoot (kick de recuo).
 * ------------------------------------------------------------------ */
class Spring {
  constructor(omega = 14, zeta = 1) {
    this.x = 0; this.v = 0; this.target = 0;
    this.omega = omega; this.zeta = zeta;
  }
  step(h) {
    const w = this.omega, z = this.zeta;
    const den = 1 + 2 * z * h * w + h * h * w * w;
    this.v = (this.v - h * w * w * (this.x - this.target)) / den;
    this.x += h * this.v;
    return this.x;
  }
  /** Empurrão instantâneo de velocidade (recuo, impacto). */
  kick(a) { this.v += a; }
  reset(x = 0) { this.x = x; this.v = 0; this.target = x; }
}

/** Três molas idênticas para um vetor. */
class Spring3 {
  constructor(omega = 14, zeta = 1) {
    this.x = new Spring(omega, zeta);
    this.y = new Spring(omega, zeta);
    this.z = new Spring(omega, zeta);
  }
  setTarget(x, y, z) { this.x.target = x; this.y.target = y; this.z.target = z; }
  step(h) { this.x.step(h); this.y.step(h); this.z.step(h); }
  kick(x, y, z) { this.x.kick(x); this.y.kick(y); this.z.kick(z); }
  toVector(v) { return v.set(this.x.x, this.y.x, this.z.x); }
  reset() { this.x.reset(); this.y.reset(); this.z.reset(); }
}

/* ------------------------------------------------------------------ *
 * Ruído de valor 1D suavizado — usado no shake (nunca senoide pura)
 * ------------------------------------------------------------------ */
const NOISE_N = 256;
const NOISE = new Float32Array(NOISE_N);
for (let i = 0; i < NOISE_N; i++) NOISE[i] = Math.random() * 2 - 1;
function vnoise(t, seed = 0) {
  const p = t * 1 + seed * 97.13;
  const i = Math.floor(p), f = p - i;
  const a = NOISE[((i % NOISE_N) + NOISE_N) % NOISE_N];
  const b = NOISE[(((i + 1) % NOISE_N) + NOISE_N) % NOISE_N];
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/* ------------------------------------------------------------------ *
 * Temporários (nenhuma alocação por frame)
 * ------------------------------------------------------------------ */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();

export class CameraRig {
  constructor(ctx) {
    this.ctx = ctx;
    this.settings = ctx.settings;

    /* --- ângulos base (o que o jogador controla com o mouse) --- */
    this.yaw = 0;
    this.pitch = 0;
    this.pitchLimit = 89 * DEG;

    /* --- recuo --- */
    // Parte PERMANENTE: é o padrão que o jogador decora e compensa.
    this.recoilView = { pitch: 0, yaw: 0 };
    this.recoilRate = 10;        // graus/s de retorno
    this.recoilDelay = 0.15;     // espera antes de começar a voltar
    this._sinceShot = 99;
    // Parte VISUAL: mola com overshoot, some sozinha.
    this.kickPitch = new Spring(26, 0.42);
    this.kickYaw = new Spring(22, 0.40);
    this.kickRoll = new Spring(18, 0.45);
    this.kickPos = new Spring3(24, 0.5);

    /* --- bob de passo --- */
    this.bobPhase = 0;
    this.bobAmp = new Spring(9, 1);      // amplitude segue a velocidade
    this.bob = new Spring3(30, 1);       // offset final suavizado
    this.bobRoll = new Spring(24, 1);

    /* --- sway por mouse (a arma/câmera "atrasa" o giro) --- */
    this.swayX = new Spring(9, 0.8);
    this.swayY = new Spring(9, 0.8);
    this.lookDX = 0; this.lookDY = 0;    // delta suavizado, lido pelo ViewModel

    /* --- inclinações --- */
    this.strafeTilt = new Spring(7.5, 1);
    this.slideRoll = new Spring(6.5, 1);
    this.landDip = new Spring(16, 0.55);

    /* --- shake / punch --- */
    this.trauma = 0;
    this.traumaDir = new THREE.Vector3(0, 0, 0);
    this.punch = new Spring3(15, 0.35);
    this.punchRot = new Spring(13, 0.32);

    /* --- FOV --- */
    this.fov = new Spring(11, 1);
    this.fovBase = this.settings?.fov ?? 80;
    this.fov.reset(this.fovBase);
    this.fovSprintBonus = 8;
    this.fovAdsDelta = 0;

    /* --- estado externo --- */
    this.eyeHeight = 1.68;
    this.position = new THREE.Vector3();
    this.mantleOffset = new THREE.Vector3();
    this.time = 0;

    /* --- saída --- */
    this.worldPosition = new THREE.Vector3();
    this.worldQuaternion = new THREE.Quaternion();
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this.viewRoll = 0;
  }

  /* ================================================================ *
   * Entrada de mouse
   * ================================================================ */
  /**
   * Aplica o delta do mouse. `sens` em rad/pixel.
   * Compensação de recuo: se o jogador puxa contra o recuo acumulado, o
   * movimento consome o recuo em vez de girar a mira — é o que torna o
   * padrão determinístico realmente controlável (modelo Call of Duty).
   */
  look(dx, dy, sens, invertY = false) {
    let dYaw = -dx * sens;
    let dPitch = (invertY ? dy : -dy) * sens;

    const rv = this.recoilView;
    if (rv.pitch > 0 && dPitch < 0) {
      const use = Math.min(rv.pitch, -dPitch);
      rv.pitch -= use; dPitch += use;
    } else if (rv.pitch < 0 && dPitch > 0) {
      const use = Math.min(-rv.pitch, dPitch);
      rv.pitch += use; dPitch -= use;
    }
    if (rv.yaw > 0 && dYaw < 0) {
      const use = Math.min(rv.yaw, -dYaw);
      rv.yaw -= use; dYaw += use;
    } else if (rv.yaw < 0 && dYaw > 0) {
      const use = Math.min(-rv.yaw, dYaw);
      rv.yaw += use; dYaw -= use;
    }

    this.yaw += dYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, -this.pitchLimit, this.pitchLimit);

    // Alimenta o sway: a arma fica para trás do giro.
    this.swayX.kick(-dx * 0.020);
    this.swayY.kick(-dy * 0.020);
  }

  /* ================================================================ *
   * API pública de impacto
   * ================================================================ */

  /**
   * Recuo de um disparo.
   * @param {number} pitch graus de subida PERMANENTE (padrão da arma)
   * @param {number} yaw   graus laterais PERMANENTES
   * @param {number} kickP graus do kick visual (mola, volta sozinho)
   * @param {number} kickY graus laterais do kick visual
   * @param {number} punch metros de recuo do viewmodel/câmera em +Z
   */
  addRecoil(pitch, yaw, kickP = pitch * 2.0, kickY = yaw * 2.0, punch = 0.02) {
    this.recoilView.pitch += pitch * DEG;
    this.recoilView.yaw += yaw * DEG;
    this._sinceShot = 0;
    this.kickPitch.kick(kickP * DEG * 26);
    this.kickYaw.kick(kickY * DEG * 22);
    this.kickRoll.kick((Math.random() - 0.5) * kickP * DEG * 14);
    this.kickPos.kick(-kickY * 0.004, kickP * 0.002, punch * 22);
  }

  /** Configura a recuperação do recuo (chamado ao trocar de arma). */
  setRecoilRecovery(rate, delay) { this.recoilRate = rate; this.recoilDelay = delay; }

  /**
   * Tremor direcional. `amount` 0..1 (acumula, satura em 1).
   * `dir` = direção MUNDIAL de onde veio o dano (opcional).
   */
  addShake(amount, dir = null) {
    this.trauma = Math.min(1, this.trauma + amount);
    if (dir) this.traumaDir.copy(dir).normalize();
    else this.traumaDir.set(0, 0, 0);
  }

  /** Sopro de explosão: empurrão forte de posição + rotação. */
  addPunch(amount, dir = null) {
    this.punch.kick(
      (dir ? dir.x : (Math.random() - 0.5)) * amount * 6,
      (dir ? Math.abs(dir.y) + 0.4 : 0.6) * amount * 6,
      (dir ? dir.z : 0.3) * amount * 6);
    this.punchRot.kick(amount * 5);
    this.addShake(amount * 0.9, dir);
  }

  /** Dip ao aterrissar. `impact` = velocidade vertical no toque (m/s, positivo). */
  addLand(impact) {
    const a = THREE.MathUtils.clamp(impact / 9, 0, 1.4);
    this.landDip.kick(-a * 3.4);
    if (a > 0.45) this.addShake(a * 0.22);
  }

  /* ================================================================ *
   * Update
   * ================================================================ */

  /**
   * @param {number} dt
   * @param {object} s estado vindo do Movement/Player:
   *   {position, eyeHeight, speed, planarSpeed, grounded, state, strafe,
   *    stepDelta, ads, adsT, sprintT, slideT, crouchT, mantleOffset, weapon}
   */
  update(dt, s) {
    this.time += dt;

    /* --- recuperação do recuo permanente --- */
    this._sinceShot += dt;
    if (this._sinceShot > this.recoilDelay) {
      const rate = this.recoilRate * DEG * dt;
      const rv = this.recoilView;
      const mag = Math.hypot(rv.pitch, rv.yaw);
      if (mag > 1e-5) {
        const k = Math.min(1, rate * (0.35 + mag * 6) / mag);
        rv.pitch -= rv.pitch * k;
        rv.yaw -= rv.yaw * k;
      }
    }

    /* --- bob de passo: fase por DISTÂNCIA percorrida, não por tempo --- */
    const planar = s.planarSpeed ?? 0;
    const stride = 1.35;                       // metros por passada
    if (s.grounded && planar > 0.4) {
      this.bobPhase += (s.stepDelta ?? planar * dt) / stride * Math.PI;
    } else {
      // No ar a fase converge para o "pé no chão" para não cair torto.
      const tgt = Math.round(this.bobPhase / Math.PI) * Math.PI;
      this.bobPhase += (tgt - this.bobPhase) * Math.min(1, dt * 8);
    }
    const speedN = THREE.MathUtils.clamp(planar / 6.6, 0, 1.25);
    this.bobAmp.target = (s.grounded ? 1 : 0) * speedN * (1 - 0.72 * (s.adsT ?? 0));
    const amp = this.bobAmp.step(dt);

    const ph = this.bobPhase;
    // Elíptico: vertical bate a cada passo, lateral fecha a cada duas passadas.
    const bx = Math.sin(ph * 0.5) * 0.028 * amp;
    const by = (-Math.abs(Math.sin(ph)) + 0.5) * 0.024 * amp;
    const bz = Math.sin(ph * 0.5 + 1.1) * 0.010 * amp;
    this.bob.setTarget(bx, by, bz);
    this.bob.step(dt);
    this.bobRoll.target = Math.sin(ph * 0.5 + 0.4) * 0.55 * DEG * amp;
    this.bobRoll.step(dt);

    /* --- sway --- */
    this.swayX.target = 0; this.swayY.target = 0;
    this.lookDX = this.swayX.step(dt);
    this.lookDY = this.swayY.step(dt);

    /* --- tilt de strafe e roll de deslize --- */
    const adsT = s.adsT ?? 0;
    this.strafeTilt.target = -(s.strafe ?? 0) * 2.0 * DEG * (1 - 0.6 * adsT);
    this.strafeTilt.step(dt);
    this.slideRoll.target = (s.slideT ?? 0) * 6.5 * DEG * (s.slideSide ?? 1);
    this.slideRoll.step(dt);
    this.landDip.target = 0; this.landDip.step(dt);

    /* --- kick de recuo --- */
    this.kickPitch.target = 0; this.kickPitch.step(dt);
    this.kickYaw.target = 0; this.kickYaw.step(dt);
    this.kickRoll.target = 0; this.kickRoll.step(dt);
    this.kickPos.setTarget(0, 0, 0); this.kickPos.step(dt);

    /* --- punch e shake --- */
    this.punch.setTarget(0, 0, 0); this.punch.step(dt);
    this.punchRot.target = 0; this.punchRot.step(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.35);
    const tr = this.trauma * this.trauma;      // resposta quadrática
    const t = this.time * 34;
    const shX = vnoise(t, 1) * tr * 0.055;
    const shY = vnoise(t, 2) * tr * 0.055;
    const shPitch = vnoise(t, 3) * tr * 3.2 * DEG;
    const shYaw = vnoise(t, 4) * tr * 3.2 * DEG;
    const shRoll = vnoise(t, 5) * tr * 4.5 * DEG;

    /* --- FOV --- */
    const wpn = s.weapon;
    this.fovBase = this.settings?.fov ?? 80;
    this.fovAdsDelta = wpn?.adsFovDelta ?? 14;
    this.fov.target = this.fovBase
      + (s.sprintT ?? 0) * this.fovSprintBonus
      + (s.slideT ?? 0) * 5
      - adsT * this.fovAdsDelta;
    this.fov.step(dt);

    /* ============================================================== *
     * Composição final
     * ============================================================== */
    const pitch = this.pitch + this.recoilView.pitch + this.kickPitch.x + shPitch;
    const yaw = this.yaw + this.recoilView.yaw + this.kickYaw.x + shYaw;
    const roll = this.bobRoll.x + this.strafeTilt.x + this.slideRoll.x
      + this.kickRoll.x + shRoll + this.punchRot.x * DEG + (s.mantleRoll ?? 0);
    this.viewRoll = roll;

    _e.set(pitch, yaw, roll, 'YXZ');
    this.worldQuaternion.setFromEuler(_e);

    // Offsets locais (bob/kick/shake/punch) levados para o mundo pela rotação.
    _v1.set(
      this.bob.x.x + this.kickPos.x.x + shX + this.punch.x.x,
      this.bob.y.x + this.kickPos.y.x + shY + this.punch.y.x + this.landDip.x * 0.03,
      this.bob.z.x + this.kickPos.z.x + this.punch.z.x,
    );
    _v1.applyQuaternion(this.worldQuaternion);

    this.eyeHeight = s.eyeHeight ?? this.eyeHeight;
    this.worldPosition.copy(s.position ?? this.position);
    this.worldPosition.y += this.eyeHeight;
    this.worldPosition.add(_v1);
    if (s.mantleOffset) this.worldPosition.add(s.mantleOffset);

    // Direção de tiro: base + recuo (SEM bob/sway/shake — senão o tiro mente).
    _e.set(this.pitch + this.recoilView.pitch + this.kickPitch.x * 0.35,
      this.yaw + this.recoilView.yaw + this.kickYaw.x * 0.35, 0, 'YXZ');
    _q.setFromEuler(_e);
    this.aimDir.set(0, 0, -1).applyQuaternion(_q);
  }

  /** Escreve o resultado na câmera do mundo. */
  applyTo(camera) {
    camera.position.copy(this.worldPosition);
    camera.quaternion.copy(this.worldQuaternion);
    const f = this.fov.x;
    if (Math.abs(camera.fov - f) > 1e-3) {
      camera.fov = f;
      camera.updateProjectionMatrix();
    }
  }

  /** Origem do raio de tiro (olho, sem bob). */
  getMuzzleOrigin(out, position, eyeHeight) {
    return out.set(position.x, position.y + eyeHeight, position.z);
  }

  reset(yaw = 0, pitch = 0) {
    this.yaw = yaw; this.pitch = pitch;
    this.recoilView.pitch = 0; this.recoilView.yaw = 0;
    this.trauma = 0;
    this.bobPhase = 0;
    this.bob.reset(); this.kickPos.reset(); this.punch.reset();
    this.kickPitch.reset(); this.kickYaw.reset(); this.kickRoll.reset();
    this.strafeTilt.reset(); this.slideRoll.reset(); this.landDip.reset();
    this.fov.reset(this.settings?.fov ?? 80);
  }
}

export { Spring, Spring3 };
