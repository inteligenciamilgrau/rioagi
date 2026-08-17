/**
 * Sky — espalhamento atmosferico fisicamente plausivel + nuvens procedurais.
 * Dono: CORE.
 *
 * Modelo: Preetham (Rayleigh + Mie com fases de Rayleigh e Henyey-Greenstein).
 * Nao e gradiente chapado: a cor de cada direcao sai da espessura optica real
 * daquele caminho, por isso o horizonte fica quente e o zenite frio, com o
 * gradiente correto entre eles.
 *
 * Nuvens: cumulus por raymarch de 12 passos + cirros por FBM, renderizados num
 * mapa equiretangular 512x256 atualizado a cada N frames (nao por frame).
 * O ceu na tela so faz uma leitura de textura por pixel.
 *
 * Expoe:
 *   sky.sunDirection      THREE.Vector3 normalizado (direcao PARA o sol)
 *   sky.sunColor          THREE.Color   cor do disco solar apos extincao
 *   sky.horizonColor      THREE.Color   cor do ceu no horizonte (base do fog)
 *   sky.zenithColor       THREE.Color
 *   sky.getEnvironmentTexture()  textura equiretangular HDR para o PMREM
 *   sky.setTimeOfDay(horas)
 */
import * as THREE from 'three';
import { Pass, FULLSCREEN_VERT, makeHDRTarget, disposeTarget } from './shaders/FullScreen.js';
import { SKY_FRAG, CLOUDS_FRAG } from './shaders/sky.glsl.js';

// --- Constantes do modelo de Preetham (identicas as do addon oficial) -------
const TOTAL_RAYLEIGH = new THREE.Vector3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
const MIE_CONST = new THREE.Vector3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;

// --- Modelo solar do Rio de Janeiro (hemisferio sul, inverno) ---------------
// O sol transita ao NORTE ao meio-dia; nasce a ENE e se poe a WNW.
const SUNRISE_H = 6.0;
const SUNSET_H = 18.3;
const MAX_ELEVATION_DEG = 60.0;
const AZIMUTH_AT_RISE_DEG = 63.0;   // medido do norte (-Z), sentido horario p/ leste (+X)
const AZIMUTH_SWING_DEG = 126.0;

const CLOUD_W = 1024, CLOUD_H = 512;
const ENV_W = 512, ENV_H = 256;

// Vetores temporarios de modulo — nada de alocacao por frame.
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;

    // Parametros artisticos do modelo.
    this.turbidity = 4.2;        // Rio ao fim da tarde: ar umido com poeira
    this.rayleigh = 2.25;
    this.mieCoefficient = 0.0055;
    this.mieDirectionalG = 0.79;
    this.skyGamma = 1.62;        // compressao do range exagerado do Preetham
    this.skyIntensity = 0.55;
    this.horizonTint = 0.48;     // quanto a extincao tinge o ceu rasante
    this.sunDiskIntensity = 0.11;
    this.cloudCoverage = 0.40;
    this.cloudDensity = 0.075;
    this.cloudAmount = 1.0;

    /* --- Ceu VISIVEL x ceu de ILUMINACAO ---------------------------------
     * O mapa equiretangular que alimenta o PMREM nao e uma foto do ceu: e a
     * radiancia que uma superficie no meio do morro enxerga. Isso inclui o
     * casario, que ocupa boa parte do hemisferio de cima num beco e devolve
     * luz quente. O ceu desenhado na tela continua sendo so ceu (bounce = 0,
     * croma = 1), entao nada aqui altera o visual do ceu.
     *
     * MEDIDO (tools/iblirrad.mjs, 17h30): a irradiancia difusa numa normal
     * PARA CIMA vinha com B/R = 2,44 enquanto uma parede recebia B/R = 0,82.
     * Ou seja: so o que aponta para cima ficava azul, exatamente o defeito.
     */
    this.bounceStrength = 0.66;   // fracao do hemisferio tapada por casario
    this.bounceReach = 0.90;      // sen(elev) onde o casario acaba (~64 graus)
    this.lightingChroma = 0.83;   // croma do que sobra de ceu na iluminacao
    this.bounceGain = 1.30;       // brilho do casario, relativo ao horizonte
    /* Albedo MEDIO do morro. Nao e a cor do tijolo: e a media de tijolo com
     * concreto cinza, reboco branco e reboco pintado de azul, verde e rosa.
     * Com (0.62, 0.42, 0.30) — cor de tijolo puro — o defeito azul virava um
     * defeito laranja: telha de fibrocimento (cinza) lia marrom e a terra
     * saturava. Medido em tools/chaoprova.mjs e tools/azulprobe.mjs. */
    this.morroAlbedo = new THREE.Color(0.55, 0.44, 0.34);
    /** Radiancia media do casario. Lida pelo Lighting (cor da hemisferica). */
    this.bounceColor = new THREE.Color(0, 0, 0);

    // Estado publico
    this.sunDirection = new THREE.Vector3(-0.799, 0.211, -0.563).normalize();
    this.sunColor = new THREE.Color(1, 0.55, 0.22);
    this.horizonColor = new THREE.Color(0.6, 0.35, 0.2);
    this.zenithColor = new THREE.Color(0.1, 0.2, 0.4);
    this.sunElevationDeg = 12;
    this.hours = 17.5;
    /** Incrementa quando o mapa de ambiente muda; Lighting usa para regerar o PMREM. */
    this.version = 0;

    // Internos
    this.betaR = new THREE.Vector3();
    this.betaM = new THREE.Vector3();
    this.sunE = 0;
    this.mesh = null;
    this.cloudTarget = null;
    this.envTarget = null;
    this._cloudPass = null;
    this._envPass = null;
    this._frame = 0;
    this._needsClouds = true;
    this._needsEnv = true;
    this._cloudInterval = 24;   // frames entre atualizacoes das nuvens
    this._envInterval = 96;     // frames entre atualizacoes do mapa de ambiente
    this._time = 0;
  }

  async init() {
    const ctx = this.ctx;

    this._computeSunParams();

    // --- Alvos ---------------------------------------------------------------
    this.cloudTarget = makeHDRTarget(CLOUD_W, CLOUD_H, { name: 'cloudsEquirect' });
    this.cloudTarget.texture.wrapS = THREE.RepeatWrapping;   // costura do azimute
    this.cloudTarget.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.envTarget = makeHDRTarget(ENV_W, ENV_H, { name: 'skyEquirect' });
    this.envTarget.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.envTarget.texture.wrapS = THREE.RepeatWrapping;
    this.envTarget.texture.wrapT = THREE.ClampToEdgeWrapping;

    // --- Passes de geracao ---------------------------------------------------
    this._cloudPass = new Pass(CLOUDS_FRAG, {
      uSunDir: { value: this.sunDirection.clone() },
      uSunColor: { value: new THREE.Vector3(1, 0.6, 0.25) },
      uSkyColor: { value: new THREE.Vector3(0.1, 0.15, 0.25) },
      uTime: { value: 0 },
      uCoverage: { value: this.cloudCoverage },
      uDensity: { value: this.cloudDensity },
    }, {}, { name: 'CloudsEquirect' });

    this._envPass = new Pass(SKY_FRAG, this._makeSkyUniforms(), { EQUIRECT: 1 }, { name: 'SkyEquirect' });

    // --- Malha do ceu na cena -------------------------------------------------
    // Triangulo de tela cheia com depthTest desligado e renderOrder minimo:
    // preenche o fundo sem escrever profundidade, entao o depth dos pixels de
    // ceu continua em 1.0 (o SSAO/DOF sabem que ali e "infinito").
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const uniforms = this._makeSkyUniforms();
    uniforms.uInvProj = { value: new THREE.Matrix4() };
    uniforms.uInvView = { value: new THREE.Matrix4() };

    const mat = new THREE.ShaderMaterial({
      name: 'Sky',
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      side: THREE.FrontSide,
      fog: false,
      lights: false,
      toneMapped: true,   // relevante so no caminho sem PostFX
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'ceu';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -10000;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // A direcao de cada raio vem da inversa da projecao ATUAL — inclusive com o
    // jitter de TAA aplicado, o que mantem o ceu coerente com o resto do frame.
    mesh.onBeforeRender = (renderer, scene, camera) => {
      uniforms.uInvProj.value.copy(camera.projectionMatrix).invert();
      uniforms.uInvView.value.copy(camera.matrixWorld);
    };
    this.mesh = mesh;
    ctx.scene.add(mesh);

    this.setTimeOfDay(this.hours);

    // Primeira geracao sincrona: nuvens + ambiente prontos antes do primeiro frame.
    this._renderClouds();
    this._renderEnv();

    return this;
  }

  _makeSkyUniforms() {
    return {
      uBetaR: { value: this.betaR.clone() },
      uBetaM: { value: this.betaM.clone() },
      uSunE: { value: this.sunE },
      uSunDir: { value: this.sunDirection.clone() },
      uMieG: { value: this.mieDirectionalG },
      uSkyGamma: { value: this.skyGamma },
      uSkyIntensity: { value: this.skyIntensity },
      uSunDiskIntensity: { value: this.sunDiskIntensity },
      uGroundColor: { value: new THREE.Vector3(0.12, 0.09, 0.07) },
      uHorizonTint: { value: this.horizonTint },
      uClouds: { value: this.cloudTarget ? this.cloudTarget.texture : null },
      uCloudAmount: { value: this.cloudAmount },
      // Neutros por padrao: quem liga sao os uniforms do _envPass (ver _pushUniforms).
      uBounceColor: { value: new THREE.Vector3(0, 0, 0) },
      uBounceStrength: { value: 0 },
      uBounceReach: { value: this.bounceReach },
      uChroma: { value: 1 },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Sol                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Reposiciona o sol pela hora do dia (0-24).
   * Padrao do jogo: 17h30 -> elevacao ~12 graus, azimute WNW.
   */
  setTimeOfDay(hours) {
    this.hours = hours;
    const t = (hours - SUNRISE_H) / (SUNSET_H - SUNRISE_H);
    // Fora do intervalo diurno a elevacao fica negativa (sol abaixo do horizonte).
    const elevDeg = Math.sin(Math.PI * THREE.MathUtils.clamp(t, -0.25, 1.25)) * MAX_ELEVATION_DEG;
    const azDeg = AZIMUTH_AT_RISE_DEG - THREE.MathUtils.clamp(t, 0, 1) * AZIMUTH_SWING_DEG;
    this.setSunAngles(elevDeg, azDeg);
  }

  /**
   * @param {number} elevationDeg acima do horizonte
   * @param {number} azimuthDeg   medido a partir do norte (-Z), horario para leste (+X)
   */
  setSunAngles(elevationDeg, azimuthDeg) {
    this.sunElevationDeg = elevationDeg;
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const ce = Math.cos(el);
    this.sunDirection.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
    this._computeSunParams();
    this._pushUniforms();
    this._needsClouds = true;
    this._needsEnv = true;
  }

  /** Recalcula betaR/betaM/sunE e as cores derivadas no lado da CPU. */
  _computeSunParams() {
    const y = this.sunDirection.y;

    // sunfade: escurece o Rayleigh quando o sol mergulha (crepusculo).
    const sunfade = 1.0 - THREE.MathUtils.clamp(1.0 - Math.exp(y), 0, 1);
    const rayleighCoefficient = this.rayleigh - (1.0 - sunfade);

    this.betaR.copy(TOTAL_RAYLEIGH).multiplyScalar(rayleighCoefficient);

    const c = 0.2 * this.turbidity * 1e-17;
    this.betaM.copy(MIE_CONST).multiplyScalar(0.434 * c * this.mieCoefficient);

    const cosZenith = THREE.MathUtils.clamp(y, -1, 1);
    this.sunE = EE * Math.max(0, 1.0 - Math.exp(-((CUTOFF_ANGLE - Math.acos(cosZenith)) / STEEPNESS)));

    // --- Cor do sol: extincao ao longo do caminho ate o observador ----------
    const am = this._airMass(Math.acos(Math.max(0, y)));
    const sR = RAYLEIGH_ZENITH * am;
    const sM = MIE_ZENITH * am;
    const fx = Math.exp(-(this.betaR.x * sR + this.betaM.x * sM));
    const fy = Math.exp(-(this.betaR.y * sR + this.betaM.y * sM));
    const fz = Math.exp(-(this.betaR.z * sR + this.betaM.z * sM));
    const m = Math.max(fx, fy, fz, 1e-4);
    // Normaliza e puxa 18% para o branco: 100% do Fex fica vermelho-sangue e
    // torna a leitura de material impossivel.
    this.sunColor.setRGB(
      THREE.MathUtils.lerp(fx / m, 1, 0.18),
      THREE.MathUtils.lerp(fy / m, 1, 0.18),
      THREE.MathUtils.lerp(fz / m, 1, 0.18),
    );

    // --- Cores de referencia do ceu (fog, hemisferica, ambiente das nuvens) --
    // Horizonte medido 35 graus ao lado do sol: e a cor que a neblina do vale
    // precisa ter para o mundo distante encostar no ceu sem emenda.
    const azSun = Math.atan2(this.sunDirection.x, -this.sunDirection.z);
    const azSide = azSun + THREE.MathUtils.degToRad(35);
    _v3.set(Math.sin(azSide) * 0.997, 0.075, -Math.cos(azSide) * 0.997).normalize();
    this._evalSky(_v3, this.horizonColor);
    this._evalSky(_up, this.zenithColor);

    // --- Radiancia media do casario -----------------------------------------
    // L = albedo do morro x (o que bate nele) / PI. O que bate nele e sol raso
    // (quente, dominante) mais um resto de ceu (frio). O brilho e ancorado no
    // proprio horizonte: parede e ceu rasante recebem a mesma ordem de luz,
    // entao o casario acompanha a hora do dia sozinho, sem numero magico.
    const el = Math.max(this.sunDirection.y, 0);
    const atten = Math.pow(THREE.MathUtils.clamp(el / 0.35, 0, 1), 0.55);
    const kSol = 0.75 * (0.12 + 0.88 * atten);
    const kCeu = 0.25;
    const z = this.zenithColor;
    const zl = Math.max(z.r, z.g, z.b, 1e-4);
    const hl = Math.max(
      0.2126 * this.horizonColor.r + 0.7152 * this.horizonColor.g + 0.0722 * this.horizonColor.b, 1e-5);
    const g = this.bounceGain * hl;
    this.bounceColor.setRGB(
      this.morroAlbedo.r * (this.sunColor.r * kSol + (z.r / zl) * kCeu) * g,
      this.morroAlbedo.g * (this.sunColor.g * kSol + (z.g / zl) * kCeu) * g,
      this.morroAlbedo.b * (this.sunColor.b * kSol + (z.b / zl) * kCeu) * g,
    );
  }

  _airMass(zenithAngle) {
    const deg = (zenithAngle * 180) / Math.PI;
    return 1.0 / (Math.cos(zenithAngle) + 0.15 * Math.pow(Math.max(93.885 - deg, 1e-3), -1.253));
  }

  /**
   * Avalia o mesmo modelo do shader na CPU para uma direcao (sem nuvens nem
   * disco solar). Usado para derivar cor de fog / luz hemisferica.
   * @param {THREE.Vector3} dir
   * @param {THREE.Color} out
   */
  _evalSky(dir, out) {
    const up = Math.max(0, dir.y);
    const zenithAngle = Math.acos(up);
    const am = this._airMass(zenithAngle);
    const sR = RAYLEIGH_ZENITH * am;
    const sM = MIE_ZENITH * am;

    const fex = [
      Math.exp(-(this.betaR.x * sR + this.betaM.x * sM)),
      Math.exp(-(this.betaR.y * sR + this.betaM.y * sM)),
      Math.exp(-(this.betaR.z * sR + this.betaM.z * sM)),
    ];

    const cosTheta = dir.dot(this.sunDirection);
    const rPhase = 0.05968310365946075 * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
    const g = this.mieDirectionalG, g2 = g * g;
    const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(Math.max(1 - 2 * g * cosTheta + g2, 1e-4), 1.5));

    const bR = [this.betaR.x, this.betaR.y, this.betaR.z];
    const bM = [this.betaM.x, this.betaM.y, this.betaM.z];
    const horizonMix = THREE.MathUtils.clamp(Math.pow(1 - Math.max(this.sunDirection.y, 0), 3), 0, 1);

    // Mesma tinta de extincao rasante do shader (ver sky.glsl.js).
    const fexMax = Math.max(fex[0], fex[1], fex[2], 1e-4);
    const lowMask = 1 - THREE.MathUtils.smoothstep(dir.y, 0, 0.24);

    const rgb = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const ratio = (bR[i] * rPhase + bM[i] * mPhase) / (bR[i] + bM[i]);
      let lin = Math.pow(Math.max(this.sunE * ratio * (1 - fex[i]), 0), 1.5);
      const corr = Math.sqrt(Math.max(this.sunE * ratio * fex[i], 0));
      lin *= 1 + (corr - 1) * horizonMix;
      let v = (lin + 0.002) * 0.04;
      const tint = 1 + (Math.pow(fex[i] / fexMax, 0.30) - 1) * (this.horizonTint * lowMask);
      v *= tint;
      rgb[i] = Math.pow(Math.max(v, 0), 1 / this.skyGamma) * this.skyIntensity;
    }
    out.setRGB(rgb[0], rgb[1], rgb[2]);
    return out;
  }

  _pushUniforms() {
    const apply = (u) => {
      if (!u) return;
      u.uBetaR.value.copy(this.betaR);
      u.uBetaM.value.copy(this.betaM);
      u.uSunE.value = this.sunE;
      u.uSunDir.value.copy(this.sunDirection);
      u.uMieG.value = this.mieDirectionalG;
      u.uSkyGamma.value = this.skyGamma;
      u.uSkyIntensity.value = this.skyIntensity;
      u.uSunDiskIntensity.value = this.sunDiskIntensity;
      u.uHorizonTint.value = this.horizonTint;
      u.uCloudAmount.value = this.cloudAmount;
      u.uClouds.value = this.cloudTarget ? this.cloudTarget.texture : null;
      // O "chao" do ceu acompanha a neblina do vale.
      u.uGroundColor.value.set(
        this.horizonColor.r * 0.55,
        this.horizonColor.g * 0.5,
        this.horizonColor.b * 0.48,
      );
    };
    apply(this.mesh?.material.uniforms);
    apply(this._envPass?.uniforms);

    // O casario e a reducao de croma existem SO no mapa que alimenta o PMREM.
    // O ceu na tela fica exatamente como era (bounce 0, croma 1) — nenhuma
    // mudanca de iluminacao pode ser confundida com mudanca de ceu.
    const ue = this._envPass?.uniforms;
    if (ue) {
      ue.uBounceColor.value.set(this.bounceColor.r, this.bounceColor.g, this.bounceColor.b);
      ue.uBounceStrength.value = this.bounceStrength;
      ue.uBounceReach.value = this.bounceReach;
      ue.uChroma.value = this.lightingChroma;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Geracao                                                                 */
  /* ---------------------------------------------------------------------- */

  _renderClouds() {
    const r = this.ctx.renderer;
    if (!r || !this._cloudPass) return;
    const u = this._cloudPass.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    // Radiancia do sol nas mesmas unidades do ceu (para as nuvens nao ficarem
    // "coladas" num range diferente do fundo).
    const s = this.sunE * 0.0016;
    u.uSunColor.value.set(this.sunColor.r * s, this.sunColor.g * s, this.sunColor.b * s);
    u.uSkyColor.value.set(this.zenithColor.r, this.zenithColor.g, this.zenithColor.b);
    u.uTime.value = this._time;
    u.uCoverage.value = this.cloudCoverage;
    u.uDensity.value = this.cloudDensity;

    const prev = r.getRenderTarget();
    this._cloudPass.render(r, this.cloudTarget);
    r.setRenderTarget(prev);
    this._needsClouds = false;
  }

  _renderEnv() {
    const r = this.ctx.renderer;
    if (!r || !this._envPass) return;
    this._pushUniforms();
    const prev = r.getRenderTarget();
    this._envPass.render(r, this.envTarget);
    r.setRenderTarget(prev);
    this._needsEnv = false;
    this.version++;
  }

  /** Textura equiretangular HDR do ceu (entrada do PMREMGenerator). */
  getEnvironmentTexture() {
    return this.envTarget ? this.envTarget.texture : null;
  }

  /* ---------------------------------------------------------------------- */

  update(dt) {
    this._time += dt;
    this._frame++;

    // Nuvens: amortizadas. Com vento lento (0.9 unidade/s no dominio do noise)
    // um passo de 24 frames desloca menos de um pixel do mapa equiretangular.
    if (this._needsClouds || this._frame % this._cloudInterval === 0) {
      this._renderClouds();
    }
    if (this._needsEnv || this._frame % this._envInterval === 0) {
      this._renderEnv();
    }
  }

  setQuality(preset) {
    // Em preset baixo as nuvens atualizam com menos frequencia.
    this._cloudInterval = preset?.name === 'baixo' ? 60 : 24;
    this._envInterval = preset?.name === 'baixo' ? 240 : 96;
  }

  dispose() {
    if (this.mesh) {
      this.ctx.scene?.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this._cloudPass?.dispose();
    this._envPass?.dispose();
    disposeTarget(this.cloudTarget);
    disposeTarget(this.envTarget);
    this.cloudTarget = this.envTarget = null;
  }
}
