/**
 * ViewModel — a arma na tela, renderizada em `ctx.viewScene` com `ctx.viewCamera`.
 * Dono: PLAYER.
 *
 * Todas as animações são procedurais, sem um único frame importado:
 *   · idle    — respiração (duas ondas de período incomensurável) + micro-sway
 *   · walk    — bob em oito, amplitude pela velocidade
 *   · sprint  — arma inclinada ~35° e abaixada
 *   · ADS     — pose RESOLVIDA geometricamente para alinhar os ferros de mira
 *               no centro exato da tela + lerp de FOV, com curva ease-out
 *   · recuo   — mola com overshoot em posição e rotação
 *   · reload  — sequência de keyframes: baixar → soltar carregador → cair →
 *               pegar novo → inserir → bater → puxar ferrolho (se vazio) → levantar
 *   · troca   — guardar/sacar
 *   · inspeção
 *
 * A ejeção do estojo é emitida no ponto certo do ciclo (`weapon:eject`).
 */

import * as THREE from 'three';
import { buildWeapon, createWeaponMaterials, disposeWeapon, countTriangles } from './WeaponMeshes.js';
import { LOADOUT } from './Weapons.js';
import { Spring, Spring3 } from './CameraRig.js';

/* --- temporários --- */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _xA = new THREE.Vector3();
const _yA = new THREE.Vector3();
const _zA = new THREE.Vector3();
const _upA = new THREE.Vector3(0, 1, 0);

/**
 * Distância do olho à alça de mira em ADS (metros).
 * A arma inteira vive à frente da câmera: o eixo local da arma tem a origem no
 * punho, e a coronha se estende +0,25 m para trás dele — se a origem ficar
 * colada na câmera, a coronha atravessa o near plane e vira uma parede.
 */
const ADS_EYE_DIST = { ia2: 0.155, smt40: 0.150, pt92: 0.420 };

/** Pose de quadril: onde a arma descansa quando não se está mirando. */
const HIP_POSE = {
  ia2: { p: [0.130, -0.215, -0.380], r: [0.030, -0.060, 0.035] },
  smt40: { p: [0.120, -0.164, -0.300], r: [0.030, -0.065, 0.035] },
  pt92: { p: [0.100, -0.178, -0.335], r: [0.045, -0.080, 0.045] },
};

/** Pose de corrida: arma abaixada e atravessada (~35°). */
const SPRINT_POSE = {
  ia2: { p: [0.170, -0.290, -0.300], r: [0.190, 0.640, -0.620] },
  smt40: { p: [0.164, -0.276, -0.270], r: [0.190, 0.660, -0.650] },
  pt92: { p: [0.140, -0.280, -0.330], r: [0.270, 0.540, -0.510] },
};

/* ------------------------------------------------------------------ *
 * Trilha de keyframes: [{t, p:[x,y,z], r:[x,y,z]}] com suavização
 * ------------------------------------------------------------------ */
function smoother(x) { return x * x * x * (x * (x * 6 - 15) + 10); }

function evalTrack(track, t, outP, outR) {
  if (t <= track[0].t) { outP.fromArray(track[0].p); outR.fromArray(track[0].r); return; }
  const last = track[track.length - 1];
  if (t >= last.t) { outP.fromArray(last.p); outR.fromArray(last.r); return; }
  for (let i = 1; i < track.length; i++) {
    if (t <= track[i].t) {
      const a = track[i - 1], b = track[i];
      const k = smoother((t - a.t) / Math.max(1e-6, b.t - a.t));
      outP.set(
        a.p[0] + (b.p[0] - a.p[0]) * k,
        a.p[1] + (b.p[1] - a.p[1]) * k,
        a.p[2] + (b.p[2] - a.p[2]) * k);
      outR.set(
        a.r[0] + (b.r[0] - a.r[0]) * k,
        a.r[1] + (b.r[1] - a.r[1]) * k,
        a.r[2] + (b.r[2] - a.r[2]) * k);
      return;
    }
  }
}

/** Curva escalar por keyframes [[t, v], ...]. */
function evalCurve(curve, t) {
  if (t <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const a = curve[i - 1], b = curve[i];
      const k = smoother((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return last[1];
}

/* --- trilha do corpo da arma durante a recarga --- */
const RELOAD_BODY = [
  { t: 0.00, p: [0, 0, 0], r: [0, 0, 0] },
  { t: 0.16, p: [-0.056, 0.066, -0.030], r: [0.220, 0.430, -0.330] },
  { t: 0.42, p: [-0.064, 0.076, -0.038], r: [0.245, 0.490, -0.345] },
  { t: 0.66, p: [-0.054, 0.064, -0.032], r: [0.205, 0.440, -0.295] },
  { t: 0.86, p: [-0.018, 0.026, -0.010], r: [0.090, 0.180, -0.115] },
  { t: 1.00, p: [0, 0, 0], r: [0, 0, 0] },
];

/* --- trilha da inspeção: gira a arma para o jogador olhar --- */
const INSPECT_BODY = [
  { t: 0.00, p: [0, 0, 0], r: [0, 0, 0] },
  { t: 0.18, p: [-0.070, 0.080, -0.040], r: [0.120, 0.900, -0.260] },
  { t: 0.42, p: [-0.076, 0.092, -0.050], r: [-0.180, 1.250, 0.140] },
  { t: 0.64, p: [-0.052, 0.066, -0.036], r: [0.360, 0.620, -0.420] },
  { t: 0.84, p: [-0.020, 0.028, -0.014], r: [0.140, 0.260, -0.160] },
  { t: 1.00, p: [0, 0, 0], r: [0, 0, 0] },
];

export class ViewModel {
  constructor(ctx, weaponSystem, cameraRig) {
    this.ctx = ctx;
    this.ws = weaponSystem;
    this.rig = cameraRig;

    this.root = new THREE.Group();
    this.root.name = 'viewmodel-rig';
    this.body = new THREE.Group();
    this.body.name = 'viewmodel-body';
    this.root.add(this.body);

    this.weapons = new Map();     // id -> {group, meta, adsPose}
    this.current = null;
    this.currentId = null;

    /* --- molas de animação --- */
    this.pos = new Spring3(17, 0.9);
    this.rot = new Spring3(19, 0.9);
    this.recoilPos = new Spring3(30, 0.42);
    this.recoilRot = new Spring3(26, 0.40);
    this.swayP = new Spring3(11, 0.85);
    this.swayR = new Spring3(10, 0.80);

    this.time = 0;
    /* 0..1 — quanto a arma ja saiu da mao na queda da morte. Escrito por
     * `QuedaMorte`; ver a camada aditiva no fim de `update()`. */
    this.quedaT = 0;
    this.fovSpring = new Spring(13, 1);
    this._boltT = 0;
    this._boltDur = 0.07;
    this._magDropped = false;
    this._lastReloadPhase = 0;
    this.triangles = {};
  }

  /**
   * Iluminação própria do viewmodel, ancorada na câmera.
   * SÓ entra se a viewScene estiver às escuras. O CORE registrou em NOTES.md que
   * a viewScene já tem sol próprio (`lighting.vmSun`) e que o número de luzes muda
   * a chave de programa — então, com o Engine real no ar, não acendo nada.
   */
  _buildLightRig() {
    let jaTemLuz = false;
    this.ctx.viewScene?.traverse?.((o) => { if (o.isLight) jaTemLuz = true; });
    if (jaTemLuz) return;
    this._buildFallbackLights();
  }

  _buildFallbackLights() {
    const key = new THREE.DirectionalLight(0xffeedd, 2.05);
    key.position.set(-0.55, 0.75, 0.42);
    const fill = new THREE.DirectionalLight(0x8ea8c8, 0.55);
    fill.position.set(0.85, -0.15, 0.35);
    const rim = new THREE.DirectionalLight(0xffd9ae, 1.15);
    rim.position.set(0.25, 0.35, -1.0);
    this.root.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.16));
    this._lights = [key, fill, rim];
  }

  /**
   * Ambiente para reflexo do metal. Só entra se ninguém definiu
   * `viewScene.environment` — o CORE/MAT tem prioridade.
   */
  _ensureEnvironment() {
    const vs = this.ctx.viewScene;
    const r = this.ctx.renderer;
    if (!vs || !r || vs.environment) return;
    const pmrem = new THREE.PMREMGenerator(r);
    const envScene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(8, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { sunDir: { value: new THREE.Vector3(-0.55, 0.28, -0.79).normalize() } },
      vertexShader: `varying vec3 vD;
        void main(){ vD = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vD; uniform vec3 sunDir;
        void main(){
          float h = clamp(vD.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 chao  = vec3(0.045, 0.040, 0.036);
          vec3 horiz = vec3(0.30, 0.20, 0.13);
          vec3 topo  = vec3(0.09, 0.13, 0.22);
          vec3 c = mix(chao, horiz, smoothstep(0.30, 0.52, h));
          c = mix(c, topo, smoothstep(0.52, 0.95, h));
          float s = pow(max(dot(vD, sunDir), 0.0), 180.0);
          c += vec3(1.7, 1.05, 0.55) * s * 2.0;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    envScene.add(new THREE.Mesh(geo, mat));
    const rt = pmrem.fromScene(envScene, 0.02);
    vs.environment = rt.texture;
    this._envRT = rt;
    geo.dispose(); mat.dispose(); pmrem.dispose();
  }

  async init() {
    const mats = createWeaponMaterials(this.ctx);
    this.materials = mats;
    for (const id of LOADOUT) {
      const { group, meta } = buildWeapon(id, mats);
      group.visible = false;
      const adsPose = this._solveAdsPose(meta, ADS_EYE_DIST[id] ?? 0.14);
      this.weapons.set(id, { group, meta, adsPose });
      this.triangles[id] = meta.triangles;
      this.body.add(group);
    }
    (this.ctx.viewScene ?? this.ctx.scene).add(this.root);
    this._buildLightRig();
    this._ensureEnvironment();
    this._select(this.ws.weapon.id, true);
  }

  /* ================================================================ *
   * ADS: resolve a pose que põe a linha de mira no centro da tela
   * ================================================================ *
   * Queremos, no espaço da câmera:
   *   q·(frente - alça) ∥ (0,0,-1)   e   q·alça + p = (0, 0, -d)
   * Assim alça e massa de mira projetam exatamente no centro. Sem chute.
   */
  _solveAdsPose(meta, eyeDist) {
    const a = _v.copy(meta.sightFront).sub(meta.sightRear).normalize();
    _zA.copy(a).negate();
    _xA.crossVectors(_upA, _zA).normalize();
    if (_xA.lengthSq() < 1e-8) _xA.set(1, 0, 0);
    _yA.crossVectors(_zA, _xA).normalize();
    _m.makeBasis(_xA, _yA, _zA);
    const q = new THREE.Quaternion().setFromRotationMatrix(_m).invert();
    const p = new THREE.Vector3(0, 0, -eyeDist)
      .sub(_v2.copy(meta.sightRear).applyQuaternion(q));
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return { p, q, e: new THREE.Vector3(e.x, e.y, e.z) };
  }

  _select(id, instant = false) {
    if (this.currentId === id) return;
    for (const [wid, w] of this.weapons) w.group.visible = wid === id;
    this.current = this.weapons.get(id);
    this.currentId = id;
    this._magDropped = false;
    if (this.current) {
      const m = this.current.meta;
      m.parts.mag.visible = true;
      m.parts.mag.position.copy(m.magRest);
      m.parts.mag.rotation.set(0, 0, 0);
      m.parts.bolt.position.set(0, 0, 0);
      m.parts.handL.position.copy(m.handLRest);
      m.parts.handL.rotation.copy(m.handLRestRot);
    }
    if (instant) { this.pos.reset(); this.rot.reset(); }
  }

  /* ================================================================ *
   * Update
   * ================================================================ */
  update(dt, s) {
    this.time += dt;
    const ws = this.ws;
    const w = ws.weapon;

    // Durante o holster a arma antiga fica; só troca ao começar o saque.
    const wantId = ws.weapon.id;
    if (this.currentId !== wantId && !(ws.switching && ws.switchPhase === 'holster')) {
      this._select(wantId);
    }
    if (!this.current) return;

    const meta = this.current.meta;
    const parts = meta.parts;
    const adsT = ws.adsT;

    /* Arma com luneta: some da tela quando a optica assume.
     *
     * PORQUE: o viewmodel e desenhado POR CIMA da cena com o depth zerado (ver
     * Engine._renderViewmodel), entao ele nao e ocluido por nada — em mira com
     * luneta o corpo do fuzil ficava dentro do circulo da optica, comendo a
     * metade de baixo do campo. Um atirador olhando pela luneta nao ve a
     * propria arma; ve so o que a lente mostra.
     *
     * O limiar 0.6 e o MESMO que o HUD usa em `_atualizarLuneta()`. Tem de ser
     * o mesmo numero: com limiares diferentes existiria um intervalo de adsT em
     * que a luneta ja esta na tela e a arma ainda desenhada (ou o contrario, um
     * quadro sem arma e sem luneta). Se um dia mudar la, mude aqui junto.
     *
     * `ws.weapon` JA E o def (WeaponSystem: `get weapon(){ return slot.def }`),
     * entao e `w.scope` e nao `w.def.scope`.
     *
     * So a visibilidade muda; o update segue inteiro de proposito. Sair daqui
     * com `return` congelaria as molas e, pior, a transformacao da boca do cano
     * — e da para ATIRAR com a luneta, entao fogacho e tracante sairiam de uma
     * posicao velha. O custo de continuar e um punhado de lerps invisiveis. */
    this.root.visible = !(w?.scope && adsT > 0.6);

    const hip = HIP_POSE[wantId] ?? HIP_POSE.ia2;
    const sprintPose = SPRINT_POSE[wantId] ?? SPRINT_POSE.ia2;

    /* ---------------------------------------------------------- *
     * 1. Pose base: quadril → ADS → corrida
     * ---------------------------------------------------------- */
    const ads = this.current.adsPose;
    let px = THREE.MathUtils.lerp(hip.p[0], ads.p.x, adsT);
    let py = THREE.MathUtils.lerp(hip.p[1], ads.p.y, adsT);
    let pz = THREE.MathUtils.lerp(hip.p[2], ads.p.z, adsT);
    let rx = THREE.MathUtils.lerp(hip.r[0], ads.e.x, adsT);
    let ry = THREE.MathUtils.lerp(hip.r[1], ads.e.y, adsT);
    let rz = THREE.MathUtils.lerp(hip.r[2], ads.e.z, adsT);

    const sprintT = (s.sprintT ?? 0) * (1 - adsT) * (ws.reloading ? 0.25 : 1);
    if (sprintT > 0.001) {
      px = THREE.MathUtils.lerp(px, sprintPose.p[0], sprintT);
      py = THREE.MathUtils.lerp(py, sprintPose.p[1], sprintT);
      pz = THREE.MathUtils.lerp(pz, sprintPose.p[2], sprintT);
      rx = THREE.MathUtils.lerp(rx, sprintPose.r[0], sprintT);
      ry = THREE.MathUtils.lerp(ry, sprintPose.r[1], sprintT);
      rz = THREE.MathUtils.lerp(rz, sprintPose.r[2], sprintT);
    }

    // Deslizar: abaixa e inclina um pouco mais que a corrida.
    const slideT = s.slideT ?? 0;
    if (slideT > 0.001) {
      px = THREE.MathUtils.lerp(px, 0.16, slideT);
      py = THREE.MathUtils.lerp(py, -0.19, slideT);
      rx = THREE.MathUtils.lerp(rx, 0.30, slideT);
      ry = THREE.MathUtils.lerp(ry, 0.50, slideT);
      rz = THREE.MathUtils.lerp(rz, -0.42, slideT);
    }

    /* ---------------------------------------------------------- *
     * 2. Troca de arma (guardar/sacar)
     * ---------------------------------------------------------- */
    if (ws.switching) {
      const t = THREE.MathUtils.clamp(ws.switchT, 0, 1);
      const k = ws.switchPhase === 'holster' ? smoother(t) : smoother(1 - t);
      py -= 0.26 * k;
      pz += 0.10 * k;
      rx += 0.85 * k;
      rz -= 0.35 * k;
      if (ws.switchPhase === 'draw' && this.currentId !== wantId) this._select(wantId);
    }

    /* ---------------------------------------------------------- *
     * 3. Aditivos: respiração, bob, sway, salto
     *    (atenuados em ADS para não desalinhar a mira)
     * ---------------------------------------------------------- */
    const addScale = 1 - adsT * 0.86;
    const t = this.time;

    // Respiração: dois períodos incomensuráveis + deriva lenta
    const breath = Math.sin(t * 1.13) * 0.55 + Math.sin(t * 0.71 + 1.7) * 0.45;
    const breath2 = Math.sin(t * 0.83 + 0.6) * 0.6 + Math.sin(t * 0.47) * 0.4;
    const idleAmp = (1 - Math.min(1, (s.planarSpeed ?? 0) / 2.2)) * addScale;
    px += breath2 * 0.0042 * idleAmp;
    py += breath * 0.0055 * idleAmp;
    rx += breath * 0.0180 * idleAmp;
    ry += breath2 * 0.0150 * idleAmp;
    rz += breath2 * 0.0090 * idleAmp;

    // Bob de caminhada: figura em oito na fase do passo do CameraRig
    const ph = this.rig?.bobPhase ?? 0;
    const bobAmp = THREE.MathUtils.clamp((s.planarSpeed ?? 0) / 6.6, 0, 1.15)
      * (s.grounded ? 1 : 0) * addScale;
    px += Math.sin(ph * 0.5) * 0.020 * bobAmp;
    py += (-Math.abs(Math.sin(ph)) + 0.5) * 0.018 * bobAmp;
    pz += Math.sin(ph * 0.5 + 1.2) * 0.010 * bobAmp;
    rz += Math.sin(ph * 0.5 + 0.4) * 0.055 * bobAmp;
    rx += Math.abs(Math.sin(ph)) * 0.030 * bobAmp;

    // Sway: a arma atrasa em relação ao giro do mouse
    const sw = (w.swayScale ?? 1) * addScale / Math.max(0.3, w.weight ?? 1);
    this.swayP.setTarget(
      THREE.MathUtils.clamp((this.rig?.lookDX ?? 0) * 0.16, -0.05, 0.05) * sw,
      THREE.MathUtils.clamp((this.rig?.lookDY ?? 0) * -0.14, -0.05, 0.05) * sw,
      0);
    this.swayR.setTarget(
      THREE.MathUtils.clamp((this.rig?.lookDY ?? 0) * 0.42, -0.22, 0.22) * sw,
      THREE.MathUtils.clamp((this.rig?.lookDX ?? 0) * 0.50, -0.26, 0.26) * sw,
      THREE.MathUtils.clamp((this.rig?.lookDX ?? 0) * -0.34, -0.20, 0.20) * sw);
    this.swayP.step(dt); this.swayR.step(dt);
    px += this.swayP.x.x; py += this.swayP.y.x;
    rx += this.swayR.x.x; ry += this.swayR.y.x; rz += this.swayR.z.x;

    // No ar: a arma sobe/desce um pouco atrás do corpo
    if (!s.grounded) {
      const vy = THREE.MathUtils.clamp((s.velocityY ?? 0) / 8, -1, 1);
      py -= vy * 0.030 * addScale;
      rx -= vy * 0.070 * addScale;
    }

    /* ---------------------------------------------------------- *
     * 4. Recarga e inspeção (trilhas de keyframe)
     * ---------------------------------------------------------- */
    if (ws.reloading) {
      evalTrack(RELOAD_BODY, ws.reloadT, _v, _v2);
      px += _v.x; py += _v.y; pz += _v.z;
      rx += _v2.x; ry += _v2.y; rz += _v2.z;
      this._animateReload(ws, meta, parts, dt);
    } else if (ws.inspecting) {
      evalTrack(INSPECT_BODY, ws.inspectT, _v, _v2);
      px += _v.x; py += _v.y; pz += _v.z;
      rx += _v2.x; ry += _v2.y; rz += _v2.z;
      this._restParts(meta, parts, dt);
    } else {
      this._restParts(meta, parts, dt);
    }

    /* ---------------------------------------------------------- *
     * 5. Molas: a arma tem peso, não teleporta para a pose alvo
     * ---------------------------------------------------------- */
    const wgt = 1 / Math.max(0.3, w.weight ?? 1);
    this.pos.x.omega = 15 + 7 * wgt; this.pos.y.omega = this.pos.x.omega; this.pos.z.omega = this.pos.x.omega;
    this.rot.x.omega = 17 + 8 * wgt; this.rot.y.omega = this.rot.x.omega; this.rot.z.omega = this.rot.x.omega;
    this.pos.setTarget(px, py, pz);
    this.rot.setTarget(rx, ry, rz);
    this.pos.step(dt); this.rot.step(dt);

    /* ---------------------------------------------------------- *
     * 6. Recuo (mola com overshoot) e ciclo do ferrolho
     * ---------------------------------------------------------- */
    this.recoilPos.setTarget(0, 0, 0); this.recoilPos.step(dt);
    this.recoilRot.setTarget(0, 0, 0); this.recoilRot.step(dt);

    if (this._boltT > 0) {
      this._boltT = Math.max(0, this._boltT - dt / this._boltDur);
      const k = Math.sin(Math.PI * (1 - this._boltT));
      parts.bolt.position.z = meta.boltTravel * k;
    } else if (!ws.reloading) {
      parts.bolt.position.z *= Math.max(0, 1 - dt * 22);
    }

    /* ---------------------------------------------------------- *
     * 7. Composição final
     * ---------------------------------------------------------- */
    this.body.position.set(
      this.pos.x.x + this.recoilPos.x.x,
      this.pos.y.x + this.recoilPos.y.x,
      this.pos.z.x + this.recoilPos.z.x);
    this.body.rotation.set(
      this.rot.x.x + this.recoilRot.x.x,
      this.rot.y.x + this.recoilRot.y.x,
      this.rot.z.x + this.recoilRot.z.x);

    /* --- morte: a arma cai da mao (escrito por QuedaMorte) ---------------
     *
     * `quedaT` vai de 0 a 1 durante a queda. A arma afunda e rola para fora do
     * quadro, e some de vez no fim. NAO da para so apagar no primeiro quadro:
     * o viewmodel e desenhado com o depth zerado, POR CIMA de tudo, entao uma
     * arma deixada parada enquanto o mundo tomba vira um adesivo deslizando
     * sobre o chao — e apagar de estalo le como falha de render. Descer e
     * girar em 0,2 s de simulacao le como "soltou o fuzil".
     *
     * Camada ADITIVA, depois da composicao final e nao dentro dela: assim a
     * pose de quadril/ADS/corrida continua sendo calculada normalmente e nao
     * ha um segundo caminho de codigo para manter. */
    if (this.quedaT > 0) {
      const q = Math.min(1, this.quedaT);
      this.body.position.y -= q * 0.42;
      this.body.position.z += q * 0.12;
      this.body.rotation.z += q * 1.15;
      this.body.rotation.x -= q * 0.55;
    }
    this.root.visible = this.root.visible && this.quedaT < 0.995;

    /* --- rig acompanha a câmera do viewmodel --- */
    const vc = this.ctx.viewCamera;
    if (vc) {
      this.root.position.copy(vc.position);
      this.root.quaternion.copy(vc.quaternion);
      const base = this.ctx.settings?.viewmodelFov ?? 60;
      this.fovSpring.target = THREE.MathUtils.lerp(base, w.viewFovADS ?? 50, adsT);
      this.fovSpring.step(dt);
      if (Math.abs(vc.fov - this.fovSpring.x) > 1e-3) {
        vc.fov = this.fovSpring.x;
        vc.updateProjectionMatrix();
      }
    }

    /* --- ejeção de estojo no ponto certo do ciclo --- */
    if (this.ws.consumeEject(dt)) this._ejectShell(meta);
  }

  /* ================================================================ *
   * Recuo do viewmodel (chamado pelo Player no evento de tiro)
   * ================================================================ */
  addRecoil(weapon) {
    const k = weapon.kickPunch ?? 0.04;
    const wgt = 1 / Math.max(0.35, weapon.weight ?? 1);
    this.recoilPos.kick(
      (Math.random() - 0.5) * k * 6 * wgt,
      k * 5.5 * wgt,
      k * 34 * wgt);
    this.recoilRot.kick(
      -k * 26 * wgt,
      (Math.random() - 0.5) * k * 16 * wgt,
      (Math.random() - 0.5) * k * 22 * wgt);
    // O ferrolho/carro do ferrolho cicla no tiro.
    this._boltT = 1;
    this._boltDur = Math.min(0.075, 30 / (weapon.rpm ?? 700));
  }

  /* ================================================================ *
   * Sequência de recarga: carregador, mãos e ferrolho
   * ================================================================ */
  _animateReload(ws, meta, parts, dt) {
    const t = ws.reloadT;
    const rest = meta.magRest;
    const mag = parts.mag;
    const handL = parts.handL;
    const empty = ws.reloadEmpty;

    /* --- carregador --- */
    if (t < 0.24) {
      mag.visible = true;
      mag.position.copy(rest);
      mag.rotation.set(0, 0, 0);
      this._magDropped = false;
    } else if (t < 0.40) {
      // sai do poço e cai
      const k = (t - 0.24) / 0.16;
      mag.visible = k < 0.95;
      mag.position.set(rest.x, rest.y - k * k * 0.42, rest.z + k * 0.05);
      mag.rotation.set(k * 0.55, 0, k * 0.25);
      if (!this._magDropped && k > 0.35) {
        this._magDropped = true;
        this.ctx.bus?.emit('weapon:magdrop', {
          weapon: ws.weapon.id,
          position: this._worldOf(mag, _v),
        });
      }
    } else if (t < 0.58) {
      // novo carregador sobe pela mão esquerda
      const k = (t - 0.40) / 0.18;
      mag.visible = true;
      const kk = smoother(k);
      mag.position.set(
        rest.x + (1 - kk) * 0.055,
        rest.y - (1 - kk) * 0.30,
        rest.z + (1 - kk) * 0.030);
      mag.rotation.set((1 - kk) * 0.42, 0, (1 - kk) * -0.18);
    } else if (t < 0.72) {
      // assenta com um tapa (pequeno overshoot)
      const k = (t - 0.58) / 0.14;
      const over = Math.sin(k * Math.PI) * 0.010;
      mag.visible = true;
      mag.position.set(rest.x, rest.y - over, rest.z);
      mag.rotation.set(0, 0, 0);
    } else {
      mag.visible = true;
      mag.position.copy(rest);
      mag.rotation.set(0, 0, 0);
    }

    /* --- mão esquerda: solta o punho, busca o carregador, bate, volta --- */
    const hr = meta.handLRest, hrr = meta.handLRestRot;
    const lx = evalCurve([[0, 0], [0.18, -0.05], [0.34, -0.10], [0.50, -0.06], [0.68, -0.01], [0.86, 0]], t);
    const ly = evalCurve([[0, 0], [0.18, -0.10], [0.34, -0.26], [0.50, -0.12], [0.68, -0.02], [0.86, 0]], t);
    const lz = evalCurve([[0, 0], [0.18, 0.10], [0.34, 0.16], [0.50, 0.10], [0.68, 0.02], [0.86, 0]], t);
    handL.position.set(hr.x + lx, hr.y + ly, hr.z + lz);
    handL.rotation.set(hrr.x + ly * 1.2, hrr.y - lx * 2.0, hrr.z + lz * 0.8);

    /* --- ferrolho: só quando entrou vazio --- */
    if (empty) {
      const bk = evalCurve([[0.72, 0], [0.82, 1], [0.90, 0]], t);
      parts.bolt.position.z = meta.boltTravel * bk;
      if (bk > 0.05) {
        // a mão esquerda vai ao ferrolho no puxão
        const g = evalCurve([[0.72, 0], [0.82, 1], [0.92, 0]], t);
        handL.position.set(hr.x - 0.02 * g, hr.y + 0.10 * g, hr.z + 0.30 * g);
      }
      if (this._lastReloadPhase < 1 && t >= 0.86) {
        this._lastReloadPhase = 1;
        this.ctx.bus?.emit('weapon:boltrelease', { weapon: ws.weapon.id });
      }
    }
    if (t < 0.5) this._lastReloadPhase = 0;
  }

  /** Volta as peças móveis para o repouso quando não há animação. */
  _restParts(meta, parts, dt) {
    const k = Math.min(1, dt * 16);
    const mag = parts.mag, rest = meta.magRest;
    mag.visible = true;
    mag.position.lerp(rest, k);
    mag.rotation.x += (0 - mag.rotation.x) * k;
    mag.rotation.z += (0 - mag.rotation.z) * k;
    const handL = parts.handL, hr = meta.handLRest, hrr = meta.handLRestRot;
    handL.position.lerp(hr, k);
    handL.rotation.x += (hrr.x - handL.rotation.x) * k;
    handL.rotation.y += (hrr.y - handL.rotation.y) * k;
    handL.rotation.z += (hrr.z - handL.rotation.z) * k;
  }

  _worldOf(obj, out) {
    obj.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(obj.matrixWorld);
  }

  /**
   * Emite a ejeção do estojo com posição e direção MUNDIAIS aproximadas
   * (o viewmodel vive no espaço da câmera; o FX precisa do mundo).
   */
  _ejectShell(meta) {
    const cam = this.ctx.camera;
    const port = meta.parts.shellAnchor;
    port.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(port.matrixWorld);
    if (cam) {
      // Reprojeta do espaço do viewmodel para o mundo pela câmera do jogador.
      _v2.copy(_v).sub(this.root.position).applyQuaternion(_q.copy(this.root.quaternion).invert());
      _v.copy(_v2).applyQuaternion(cam.quaternion).add(cam.position);
      _v2.set(1, 0.55, 0.15).applyQuaternion(cam.quaternion).normalize();
    } else {
      _v2.set(1, 0.55, 0.15);
    }
    this.ctx.bus?.emit('weapon:eject', {
      weapon: this.currentId,
      position: _v,
      direction: _v2,
      speed: 2.6 + Math.random() * 1.2,
    });
  }

  /** Total de triângulos de todas as armas carregadas. */
  getTriangleReport() {
    const out = {};
    for (const [id, w] of this.weapons) out[id] = countTriangles(w.group);
    return out;
  }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    for (const [, w] of this.weapons) disposeWeapon(w.group);
    this.weapons.clear();
    for (const k in this.materials) this.materials[k]?.dispose?.();
    this._envRT?.dispose?.();
    this.root.parent?.remove(this.root);
  }
}
