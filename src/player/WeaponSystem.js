/**
 * WeaponSystem — disparo, balística hitscan, recuo, recarga e troca de arma.
 * Dono: PLAYER.
 *
 * Balística:
 *   1. raio a partir do olho na direção da mira (+ spread aleatório pequeno);
 *   2. `ctx.world.collision.raycast` para o mundo e `ctx.ai.raycastEnemies`
 *      para as hitboxes — vence o mais próximo;
 *   3. penetração por material: cada superfície tem um custo; enquanto sobrar
 *      poder de perfuração a bala segue com dano reduzido;
 *   4. queda de dano por distância + multiplicador por parte do corpo.
 *
 * Recuo (modelo Call of Duty):
 *   - `recoilPattern` é DETERMINÍSTICO e desloca a mira de forma permanente:
 *     é o que o jogador decora e compensa com o mouse;
 *   - por cima, um kick visual com mola (volta sozinho) e um spread aleatório
 *     pequeno para que dois pentes nunca sejam idênticos.
 */

import * as THREE from 'three';
import {
  WEAPONS, LOADOUT, fireInterval, falloffAt,
  PENETRATION_COST, PENETRATION_DAMAGE, PART_MULT,
} from './Weapons.js';

const DEG = Math.PI / 180;

/** Marcos da recarga em fração do tempo total. */
const RELOAD_KEYS = {
  magout: 0.24,   // mão sai do punho e solta o carregador
  magdrop: 0.34,  // carregador cai
  magin: 0.58,    // novo carregador encaixa
  magseat: 0.70,  // tapa para assentar — munição entra aqui
  bolt: 0.84,     // ferrolho (só quando entrou vazio)
  end: 1.0,
};

/* --- temporários --- */
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _perp2 = new THREE.Vector3();
const _step = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);

export class WeaponSystem {
  constructor(ctx, cameraRig) {
    this.ctx = ctx;
    this.rig = cameraRig;

    /** Inventário: cada slot guarda seu próprio estado de munição. */
    this.slots = LOADOUT.map((id) => ({
      id,
      def: WEAPONS[id],
      ammo: WEAPONS[id].magSize,
      reserve: WEAPONS[id].reserveAmmo,
      fireMode: WEAPONS[id].fireMode,
      shotIndex: 0,
    }));
    this.index = 0;
    this.prevIndex = 1;

    /* --- disparo --- */
    this._cool = 0;          // tempo até poder disparar de novo
    this._triggerHeld = false;
    this._triggerLatch = false;
    this._burstLeft = 0;
    this._burstWait = 0;
    this.shotsSinceRelease = 0;
    this.timeSinceShot = 99;

    /* --- spread dinâmico --- */
    this.bloom = 0;
    this.spread = 0;

    /* --- ADS --- */
    this.adsRaw = 0;
    this.adsT = 0;
    this.adsWanted = false;

    /* --- recarga --- */
    this.reloading = false;
    this.reloadT = 0;
    this.reloadDur = 0;
    this.reloadEmpty = false;
    this._reloadPhase = -1;

    /* --- troca --- */
    this.switching = false;
    this.switchT = 0;
    this.switchDur = 0;
    this.switchPhase = 'none';   // 'holster' | 'draw'
    this._pendingIndex = -1;

    /* --- inspeção --- */
    this.inspecting = false;
    this.inspectT = 0;
    this.inspectDur = 2.4;

    this.enabled = true;
    this._lastStateKey = '';

    this._applyWeaponToRig();
  }

  /* ================================================================ */
  get slot() { return this.slots[this.index]; }
  get weapon() { return this.slots[this.index].def; }
  get ammo() { return this.slots[this.index].ammo; }
  get reserve() { return this.slots[this.index].reserve; }
  get busy() { return this.reloading || this.switching; }

  _applyWeaponToRig() {
    const w = this.weapon;
    this.rig?.setRecoilRecovery(w.recoilRecovery, w.recoilRecoveryDelay);
  }

  /* ================================================================ *
   * Comandos (chamados pelo Player)
   * ================================================================ */

  setTrigger(down) {
    // Ao apertar o gatilho zeramos a "dívida" de cadência: sem isso, ficar
    // parado acumula crédito e o primeiro toque sai como rajada.
    if (down && !this._triggerHeld) { this._triggerLatch = true; if (this._cool < 0) this._cool = 0; }
    if (!down) { this.shotsSinceRelease = 0; this.slot.shotIndex = 0; }
    this._triggerHeld = down;
  }

  setADS(want) { this.adsWanted = want; }

  cycleFireMode() {
    const w = this.weapon;
    if (!w.fireModes || w.fireModes.length < 2) return false;
    const i = w.fireModes.indexOf(this.slot.fireMode);
    this.slot.fireMode = w.fireModes[(i + 1) % w.fireModes.length];
    this._burstLeft = 0;
    this._emitState(true);
    return true;
  }

  startReload() {
    const s = this.slot, w = s.def;
    if (this.reloading || this.switching) return false;
    if (s.ammo >= w.magSize || s.reserve <= 0) return false;
    this.reloading = true;
    this.reloadEmpty = s.ammo === 0;
    this.reloadDur = this.reloadEmpty ? w.reloadEmptyTime : w.reloadTime;
    this.reloadT = 0;
    this._reloadPhase = -1;
    this.inspecting = false;
    this._burstLeft = 0;
    this.ctx.bus?.emit('weapon:reload', { weapon: w.id, phase: 'start' });
    return true;
  }

  cancelReload() {
    if (!this.reloading) return;
    this.reloading = false;
    this.reloadT = 0;
    this._reloadPhase = -1;
    this.ctx.bus?.emit('weapon:reload', { weapon: this.weapon.id, phase: 'end' });
  }

  switchTo(index) {
    if (index === this.index || index < 0 || index >= this.slots.length) return false;
    if (this.switching) return false;
    this.cancelReload();
    this.inspecting = false;
    this._pendingIndex = index;
    this.switching = true;
    this.switchPhase = 'holster';
    this.switchT = 0;
    this.switchDur = this.weapon.holsterTime;
    return true;
  }

  swapPrevious() { return this.switchTo(this.prevIndex); }

  inspect() {
    if (this.busy || this.inspecting) return false;
    this.inspecting = true;
    this.inspectT = 0;
    return true;
  }

  /* ================================================================ *
   * Update
   * ================================================================ */
  update(dt, moveState) {
    const w = this.weapon;
    this.timeSinceShot += dt;
    // Cadência com acumulador: zerar o contador a cada frame quantizaria o RPM
    // ao passo de simulação (700 RPM viraria 600 a 60 Hz).
    this._cool -= dt;
    if (this._cool < -0.05) this._cool = -0.05;
    this._burstWait = Math.max(0, this._burstWait - dt);

    /* --- ADS: curva ease-out, não linear --- */
    const canADS = this.adsWanted && !this.switching && !this.reloading
      && moveState.state !== 'correndo' && moveState.state !== 'deslizando';
    const spd = 1 / Math.max(0.05, w.adsTime);
    this.adsRaw = THREE.MathUtils.clamp(this.adsRaw + (canADS ? dt : -dt * 1.35) * spd, 0, 1);
    this.adsT = 1 - Math.pow(1 - this.adsRaw, 3);

    /* --- troca de arma --- */
    if (this.switching) {
      this.switchT += dt / Math.max(0.01, this.switchDur);
      if (this.switchT >= 1) {
        if (this.switchPhase === 'holster') {
          const from = this.weapon.id;
          this.prevIndex = this.index;
          this.index = this._pendingIndex;
          this._applyWeaponToRig();
          this.ctx.bus?.emit('weapon:switch', { from, to: this.weapon.id });
          this.switchPhase = 'draw';
          this.switchT = 0;
          this.switchDur = this.weapon.drawTime;
          this._emitState(true);
        } else {
          this.switching = false;
          this.switchPhase = 'none';
          this.switchT = 0;
        }
      }
    }

    /* --- recarga --- */
    if (this.reloading) this._updateReload(dt);

    /* --- inspeção --- */
    if (this.inspecting) {
      this.inspectT += dt / this.inspectDur;
      if (this.inspectT >= 1) { this.inspecting = false; this.inspectT = 0; }
    }

    /* --- spread --- */
    this.bloom = Math.max(0, this.bloom - w.spreadRecovery * dt);
    this.spread = this._computeSpread(moveState);

    /* --- disparo --- */
    if (this.enabled) this._updateFire(dt, moveState);

    this._emitState(false);
  }

  _updateReload(dt) {
    const s = this.slot, w = s.def;
    this.reloadT += dt / this.reloadDur;
    const t = this.reloadT;
    const bus = this.ctx.bus;

    const fire = (phase, key) => {
      if (this._reloadPhase < key && t >= RELOAD_KEYS[phase]) {
        this._reloadPhase = key;
        bus?.emit('weapon:reload', { weapon: w.id, phase: phase === 'magseat' ? 'magin' : phase });
      }
    };
    fire('magout', 0);
    fire('magdrop', 1);
    fire('magin', 2);

    if (this._reloadPhase < 3 && t >= RELOAD_KEYS.magseat) {
      this._reloadPhase = 3;
      const need = w.magSize - s.ammo;
      const take = Math.min(need, s.reserve);
      s.ammo += take;
      s.reserve -= take;
      this._emitState(true);
    }

    if (t >= 1) {
      this.reloading = false;
      this.reloadT = 0;
      this._reloadPhase = -1;
      bus?.emit('weapon:reload', { weapon: w.id, phase: 'end' });
    }
  }

  _computeSpread(m) {
    const w = this.weapon;
    const moving = THREE.MathUtils.clamp((m.planarSpeed ?? 0) / 4.3, 0, 1);
    let sp = THREE.MathUtils.lerp(w.spreadBase, w.spreadMoving, moving);
    sp = THREE.MathUtils.lerp(sp, w.spreadADS, this.adsT);
    if ((m.crouchT ?? 0) > 0.5) sp *= w.spreadCrouchMult;
    if (!m.grounded) sp *= w.spreadAirMult;
    sp += this.bloom * (1 - this.adsT * 0.6);
    return Math.min(sp, w.spreadMax);
  }

  _updateFire(dt, m) {
    const s = this.slot, w = s.def;
    const mode = s.fireMode;

    // Correr, trocar ou recarregar impede o tiro (recarga é cancelável).
    const blocked = this.switching || m.state === 'deslizando'
      || (m.state === 'correndo' && (m.planarSpeed ?? 0) > 5.2);

    let wantShot = false;
    if (mode === 'auto') wantShot = this._triggerHeld;
    else if (mode === 'semi') wantShot = this._triggerLatch;
    else if (mode === 'burst') {
      if (this._triggerLatch && this._burstLeft === 0 && this._burstWait === 0) {
        this._burstLeft = w.burstCount;
      }
      wantShot = this._burstLeft > 0 && this._burstWait === 0;
    }
    this._triggerLatch = false;

    if (!wantShot || blocked) return;

    if (this.reloading) {
      // Atirar cancela a recarga se já houver bala no pente.
      if (s.ammo > 0) this.cancelReload(); else return;
    }

    if (s.ammo <= 0) {
      if (this._cool <= 0) {
        this._cool = 0.28;
        this.ctx.bus?.emit('weapon:empty', { weapon: w.id });
        if (s.reserve > 0) this.startReload();
      }
      return;
    }

    if (this._cool > 0) return;
    this._cool += fireInterval(w);
    this._shoot(m);

    if (mode === 'burst') {
      this._burstLeft--;
      if (this._burstLeft === 0) this._burstWait = w.burstDelay;
    }
  }

  /* ================================================================ *
   * Disparo
   * ================================================================ */
  _shoot(m) {
    const s = this.slot, w = s.def;
    s.ammo--;
    this.timeSinceShot = 0;
    this.shotsSinceRelease++;

    /* --- origem e direção --- */
    _origin.copy(this.rig.worldPosition);
    _dir.copy(this.rig.aimDir).normalize();

    /* --- spread aleatório dentro do cone --- */
    const spreadRad = this.spread * DEG;
    if (spreadRad > 1e-5) {
      _perp.set(0, 1, 0);
      if (Math.abs(_dir.y) > 0.95) _perp.set(1, 0, 0);
      _perp.crossVectors(_dir, _perp).normalize();
      _perp2.crossVectors(_dir, _perp).normalize();
      const ang = Math.sqrt(Math.random()) * spreadRad;
      const rot = Math.random() * Math.PI * 2;
      _dir.addScaledVector(_perp, Math.tan(ang) * Math.cos(rot));
      _dir.addScaledVector(_perp2, Math.tan(ang) * Math.sin(rot));
      _dir.normalize();
    }

    this.ctx.bus?.emit('weapon:fire', {
      weapon: w.id, origin: _origin, dir: _dir, spread: this.spread,
    });

    /* --- recuo determinístico + kick --- */
    const [px, py] = this._patternAt(s.shotIndex);
    s.shotIndex++;
    const scale = THREE.MathUtils.lerp(1, w.recoilScaleADS, this.adsT)
      * ((m.crouchT ?? 0) > 0.5 ? 0.85 : 1)
      * (m.grounded ? 1 : 1.35);
    // Micro-variação para o padrão não ser robótico (< 12% do passo).
    const jx = (Math.random() - 0.5) * 0.11 * Math.abs(py);
    const jy = (Math.random() - 0.5) * 0.09 * Math.abs(py);
    this.rig.addRecoil(
      (py + jy) * scale, (px + jx) * scale,
      w.kickPitch * scale, w.kickYaw * scale * (Math.random() < 0.5 ? -1 : 1),
      w.kickPunch);

    this.bloom = Math.min(w.spreadMax, this.bloom + w.spreadPerShot);

    /* --- ejeção de estojo no tempo certo do ciclo --- */
    this._pendingEject = w.shellEjectDelay;

    /* --- traçado --- */
    this._trace(_origin, _dir, w, m);

    this._emitState(true);
  }

  /**
   * Padrão determinístico. Depois do fim do array, continua espelhando os
   * últimos passos — o pente todo permanece legível sem tabela infinita.
   */
  _patternAt(i) {
    const p = this.weapon.recoilPattern;
    if (i < p.length) return p[i];
    const tail = p.slice(-6);
    const k = (i - p.length) % tail.length;
    const cycle = Math.floor((i - p.length) / tail.length);
    const e = tail[k];
    return [e[0] * (cycle % 2 === 0 ? -1 : 1), e[1] * 0.9];
  }

  /** Hitscan com penetração. */
  _trace(origin, dir, w, m) {
    const bus = this.ctx.bus;
    const col = this.ctx.world?.collision;
    const ai = this.ctx.ai;
    let power = w.penetration;
    let dmgScale = 1;
    let travelled = 0;
    _step.copy(origin);

    for (let bounce = 0; bounce < 4; bounce++) {
      const remain = w.range - travelled;
      if (remain <= 0.1) break;

      const wr = col?.raycast ? col.raycast(_step, dir, remain) : null;
      const er = ai?.raycastEnemies ? ai.raycastEnemies(_step, dir, remain) : null;

      const wd = wr?.hit ? wr.distance : Infinity;
      const ed = er ? er.distance : Infinity;

      if (ed < wd) {
        /* --- acertou inimigo --- */
        _hitPoint.copy(er.point);
        if (er.normal) _hitNormal.copy(er.normal); else _hitNormal.copy(dir).negate();
        const dist = travelled + er.distance;
        const part = er.part || 'torso';
        const headshot = part === 'head';
        const partMult = headshot ? w.headMult : (PART_MULT[part] ?? PART_MULT.default);
        const dmg = w.damage * falloffAt(w, dist) * partMult * dmgScale;

        this._damageEnemy(er.enemyId, dmg, _hitPoint, _hitNormal, part, headshot, w);
        bus?.emit('weapon:hit', {
          point: _hitPoint, normal: _hitNormal, surface: 'carne',
          target: 'enemy', enemyId: er.enemyId,
        });

        power -= PENETRATION_COST.carne;
        if (power <= 0) break;
        dmgScale *= PENETRATION_DAMAGE.carne;
        travelled += er.distance + 0.30;
        _step.copy(_hitPoint).addScaledVector(dir, 0.30);
        continue;
      }

      if (!wr?.hit) break;

      /* --- acertou o mundo --- */
      _hitPoint.copy(wr.point);
      _hitNormal.copy(wr.normal ?? _upAxis);
      const exiting = _hitNormal.dot(dir) > 0;   // face de saída: já estamos dentro
      const surface = wr.surface || 'concreto';

      if (!exiting) {
        bus?.emit('weapon:hit', {
          point: _hitPoint, normal: _hitNormal, surface,
          target: 'world', enemyId: null,
        });
      }

      travelled += wr.distance;

      if (exiting) {
        // Saída de material já cobrado: segue reto, custo zero.
        _step.copy(_hitPoint).addScaledVector(dir, 0.02);
        travelled += 0.02;
        continue;
      }

      const cost = PENETRATION_COST[surface] ?? PENETRATION_COST.default;
      if (power < cost) break;
      power -= cost;
      dmgScale *= PENETRATION_DAMAGE[surface] ?? PENETRATION_DAMAGE.default;
      // Sem informação de espessura: avança um passo curto e tenta de novo.
      _step.copy(_hitPoint).addScaledVector(dir, 0.14);
      travelled += 0.14;
    }
  }

  _damageEnemy(id, dmg, point, normal, part, headshot, w) {
    const ai = this.ctx.ai;
    const payload = { enemyId: id, damage: dmg, point, normal, part, headshot, weapon: w.id };
    if (ai?.applyDamage) { ai.applyDamage(id, dmg, payload); return; }
    if (ai?.damageEnemy) { ai.damageEnemy(id, dmg, payload); return; }
    // Sem API da IA: emite o evento diretamente para não perder o feedback.
    this.ctx.bus?.emit('enemy:damaged', { enemyId: id, damage: dmg, point, headshot });
  }

  /* ================================================================ *
   * Estado para o HUD
   * ================================================================ */
  _emitState(force) {
    const s = this.slot;
    const key = `${s.id}|${s.ammo}|${s.reserve}|${s.fireMode}|${this.adsT > 0.5 ? 1 : 0}`;
    if (!force && key === this._lastStateKey) return;
    this._lastStateKey = key;
    this.ctx.bus?.emit('weapon:state', {
      ammo: s.ammo, reserve: s.reserve, name: s.def.name,
      fireMode: s.fireMode, ads: this.adsT > 0.5,
    });
  }

  /** Consome o pedido de ejeção de estojo (o ViewModel dispara no frame certo). */
  consumeEject(dt) {
    if (this._pendingEject === undefined || this._pendingEject === null) return false;
    this._pendingEject -= dt;
    if (this._pendingEject <= 0) { this._pendingEject = null; return true; }
    return false;
  }

  /** Recarrega tudo (usado por pickups / respawn). */
  refill() {
    for (const s of this.slots) { s.ammo = s.def.magSize; s.reserve = s.def.reserveAmmo; }
    this._emitState(true);
  }
}
