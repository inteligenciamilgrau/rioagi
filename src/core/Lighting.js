/**
 * Lighting — sol direcional com Cascaded Shadow Maps, hemisferica, IBL e fog.
 * Dono: CORE.
 *
 * CSM de verdade:
 *  - 2 a 4 cascatas, split "pratico" (mistura de uniforme e logaritmico).
 *  - Cada cascata e ajustada pela ESFERA ENVOLVENTE da fatia do frustum, nao
 *    pela caixa. A esfera e invariante a rotacao da camera, entao o tamanho do
 *    mapa nunca muda quando o jogador olha em volta — primeira condicao para a
 *    sombra nao ferver.
 *  - Segunda condicao: o centro da cascata e "snapado" na grade de texels do
 *    mapa (em espaco de luz). Sem isso a sombra anda em sub-texel e cintila.
 *  - Blend suave entre cascatas (CSM_FADE) para nao aparecer a emenda.
 *  - Filtro Poisson 16 taps + receiver-plane bias + PCSS barato (ver
 *    shaders/csm.glsl.js).
 *
 * Os materiais do mundo sao gerados pelo modulo MAT (arquivo que nao podemos
 * editar), entao a habilitacao do CSM e feita por varredura periodica da cena:
 * todo material iluminado que ainda nao foi registrado recebe os defines e as
 * uniforms compartilhadas.
 */
import * as THREE from 'three';
import { installCSMChunks, uninstallCSMChunks } from './shaders/csm.glsl.js';

const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _center = new THREE.Vector3();
const _centerLS = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _lightDir = new THREE.Vector3();
const _orient = new THREE.Matrix4();
const _orientInv = new THREE.Matrix4();
const _col = new THREE.Color();

/** Materiais que participam do pipeline de luzes do three. */
function isLitMaterial(m) {
  return !!(m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial ||
    m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial));
}

export class Lighting {
  constructor(ctx) {
    this.ctx = ctx;

    // --- Parametros artisticos ---------------------------------------------
    this.sunIntensity = 34.0;      // unidades coerentes com a escala do Sky
    /* Ambiente calibrado por medicao (tools/probe.mjs). Com 0,55/0,70 a razao
     * entre sol (27) e ceu era ~1:44; no mundo real a sombra aberta recebe
     * ~1/8 do sol. Becos e interiores ficavam pretos chapados. */
    this.hemiIntensity = 2.40;
    this.envIntensity = 2.80;
    this.envMapIntensity = 1.0;
    /* A hemisferica e um substituto barato do AMBIENTE, nao do ceu. Com a cor
     * de cima igual ao zenite puro, toda superficie horizontal recebia luz de
     * B/R = 3,7 e so isso — o chao virava agua. Aqui a cor de cima e uma
     * mistura entre o zenite e a radiancia do casario (`sky.bounceColor`),
     * que e o que um beco de morro realmente tem acima da cabeca.
     * MEDIDO (tools/chaofrio.mjs): neutralizar so o croma da hemisferica ja
     * tirava 11 dos 29 pontos de B-R do asfalto em sombra. */
    this.bounceMix = 0.30;
    this.fogDensity = 0.0030;      // neblina de calor no vale
    this.fogHeightTint = 0.78;

    // --- CSM ----------------------------------------------------------------
    this.cascades = 4;
    this.shadowMapSize = 2048;
    this.shadowDistance = 120;
    this.lambda = 0.72;            // 0 = uniforme, 1 = logaritmico
    this.lightMargin = 55;         // profundidade extra atras da cascata p/ casters
    this.softShadows = true;

    /** @type {THREE.DirectionalLight[]} */
    this.lights = [];
    this.splits = [];              // distancias absolutas dos cortes (metros)
    this.sunDirection = new THREE.Vector3(0, 1, 0);

    this.hemi = null;
    this.vmSun = null;             // luz do viewmodel (sem sombra)
    this.vmHemi = null;

    this._pmrem = null;
    this._envRT = null;
    this._envVersion = -1;
    this._frame = 0;
    this._scanCountdown = 0;
    this._lastCascadeCount = -1;

    // Uniforms compartilhadas por TODOS os materiais registrados. Uma unica
    // escrita por frame atualiza a cena inteira.
    this._u = {
      CSM_cascades: { value: [] },
      cameraNear: { value: 0.05 },
      shadowFar: { value: 120 },
    };
  }

  async init() {
    const ctx = this.ctx;
    const preset = ctx.settings?.q;

    // Os chunks precisam estar no lugar ANTES do primeiro material compilar.
    installCSMChunks();

    this._applyPreset(preset);
    this._buildLights();

    // --- Luz do viewmodel ---------------------------------------------------
    // O viewmodel vive em outra cena, com outra camera: ele nao pode usar as
    // cascatas (que sao calculadas no espaco de vista do mundo). Recebe um sol
    // proprio sem sombra + hemisferica + o mesmo IBL.
    // Anexada a viewCamera: a chave da arma fica FIXA em espaco de camera
    // (3/4 pela esquerda-alto), entao o volume da arma nao muda conforme o
    // jogador gira — que e exatamente o que os FPS fazem.
    this.vmSun = new THREE.DirectionalLight(0xffffff, this.sunIntensity * 0.5);
    this.vmSun.castShadow = false;
    ctx.viewCamera.add(this.vmSun);
    ctx.viewCamera.add(this.vmSun.target);

    this.vmHemi = new THREE.HemisphereLight(0x9fb8d8, 0x4a3728, this.hemiIntensity * 1.6);
    ctx.viewScene.add(this.vmHemi);

    // --- Hemisferica do mundo ----------------------------------------------
    this.hemi = new THREE.HemisphereLight(0x9fb8d8, 0x4a3728, this.hemiIntensity);
    this.hemi.position.set(0, 50, 0);
    ctx.scene.add(this.hemi);

    // --- Fog ----------------------------------------------------------------
    ctx.scene.fog = new THREE.FogExp2(0x8a6a4e, this.fogDensity);

    // --- IBL ----------------------------------------------------------------
    this._pmrem = new THREE.PMREMGenerator(ctx.renderer);
    this._pmrem.compileEquirectangularShader();

    this._syncFromSky(true);
    this.update(0, 0);
    return this;
  }

  /* ---------------------------------------------------------------------- */
  /* Construcao                                                              */
  /* ---------------------------------------------------------------------- */

  _applyPreset(preset) {
    if (!preset) return;
    this.cascades = THREE.MathUtils.clamp(preset.shadowCascades ?? 3, 1, 4);
    this.shadowMapSize = preset.shadowMapSize ?? 2048;
    this.shadowDistance = preset.shadowDistance ?? 120;
    this.softShadows = !!preset.softShadows;
  }

  _buildLights() {
    const scene = this.ctx.scene;
    // Remove as antigas (troca de preset muda o numero de cascatas).
    for (const l of this.lights) {
      scene.remove(l.target);
      scene.remove(l);
      l.shadow.map?.dispose();
      l.dispose?.();
    }
    this.lights.length = 0;

    for (let i = 0; i < this.cascades; i++) {
      const light = new THREE.DirectionalLight(0xffffff, this.sunIntensity);
      light.name = `sol_cascata_${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 500;
      light.shadow.camera.up.copy(_up);
      // radius = raio do disco de Poisson em texels (ver getShadowCSM).
      light.shadow.radius = this.softShadows ? 1.6 : 1.0;
      light.shadow.bias = 0;
      light.shadow.normalBias = 0.02;
      light.shadow.intensity = 1.0;
      scene.add(light);
      scene.add(light.target);
      this.lights.push(light);
    }

    // Redimensiona o array de uniforms das cascatas.
    const arr = this._u.CSM_cascades.value;
    arr.length = 0;
    for (let i = 0; i < this.cascades; i++) arr.push(new THREE.Vector2());

    // Materiais precisam recompilar com o novo CSM_CASCADES.
    if (this._lastCascadeCount !== this.cascades) {
      this._lastCascadeCount = this.cascades;
      this._refreshDefines();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Registro de materiais                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Ativa CSM num material. Idempotente; preserva qualquer onBeforeCompile que
   * o modulo MAT ja tenha instalado (triplanar, detail normal, etc).
   */
  registerMaterial(material) {
    if (!isLitMaterial(material)) return;
    const ud = material.userData;

    if (!ud.__ocaCsm) {
      ud.__ocaCsm = true;

      const prevOBC = material.onBeforeCompile;
      // Congela a chave de cache ANTES de trocar onBeforeCompile: o default do
      // three usa onBeforeCompile.toString(), e sem isso dois materiais com
      // hooks diferentes passariam a compartilhar programa.
      const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey() : '';
      const u = this._u;

      material.onBeforeCompile = function (shader, renderer) {
        shader.uniforms.CSM_cascades = u.CSM_cascades;
        shader.uniforms.cameraNear = u.cameraNear;
        shader.uniforms.shadowFar = u.shadowFar;
        if (typeof prevOBC === 'function') prevOBC.call(this, shader, renderer);
      };
      material.customProgramCacheKey = function () { return 'oca-csm|' + prevKey; };

      // envMapIntensity coerente — so mexemos se o material estiver no default,
      // para nao brigar com um ajuste deliberado do modulo MAT.
      if (material.envMapIntensity === 1) material.envMapIntensity = this.envMapIntensity;
    }

    material.defines = material.defines || {};
    const needFade = true;
    if (material.defines.USE_CSM !== 1 ||
        material.defines.CSM_CASCADES !== this.cascades ||
        ('CSM_FADE' in material.defines) !== needFade ||
        ('OCA_PCSS' in material.defines) !== this.softShadows) {
      material.defines.USE_CSM = 1;
      material.defines.CSM_CASCADES = this.cascades;
      if (needFade) material.defines.CSM_FADE = ''; else delete material.defines.CSM_FADE;
      if (this.softShadows) material.defines.OCA_PCSS = ''; else delete material.defines.OCA_PCSS;
      material.needsUpdate = true;
    }
  }

  /** Varre a cena do mundo e registra materiais novos. */
  refreshMaterials() {
    const scene = this.ctx.scene;
    if (!scene) return;
    scene.traverse((obj) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) this.registerMaterial(mm); }
      else this.registerMaterial(m);
    });
  }

  _refreshDefines() {
    const scene = this.ctx.scene;
    if (!scene) return;
    scene.traverse((obj) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) if (mm.userData.__ocaCsm) this.registerMaterial(mm); }
      else if (m.userData.__ocaCsm) this.registerMaterial(m);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Sincronizacao com o ceu                                                 */
  /* ---------------------------------------------------------------------- */

  _syncFromSky(force = false) {
    const sky = this.ctx.sky;
    if (!sky) return;

    this.sunDirection.copy(sky.sunDirection);

    // --- Cor/intensidade do sol --------------------------------------------
    // Sol raso: a atmosfera come o azul, sobra laranja. A intensidade tambem
    // cai porque o caminho optico e enorme.
    const el = Math.max(sky.sunDirection.y, 0);
    const atten = Math.pow(THREE.MathUtils.clamp(el / 0.35, 0, 1), 0.55);
    const intensity = this.sunIntensity * (0.18 + 0.82 * atten);
    for (const l of this.lights) {
      l.color.copy(sky.sunColor);
      l.intensity = intensity;
    }
    if (this.vmSun) {
      this.vmSun.color.copy(sky.sunColor);
      this.vmSun.intensity = intensity * 0.62;
      // Coordenadas LOCAIS a viewCamera (-Z e para frente).
      this.vmSun.position.set(-0.75, 0.85, 0.15);
      this.vmSun.target.position.set(0, 0, -1);
    }

    // --- Hemisferica --------------------------------------------------------
    const z = sky.zenithColor, h = sky.horizonColor;
    const zm = Math.max(z.r, z.g, z.b, 1e-4);
    const hm = Math.max(h.r, h.g, h.b, 1e-4);
    if (this.hemi) {
      // Cor de cima = zenite + casario. `HemisphereLight` entrega EXATAMENTE
      // `color` para uma normal com y = 1, entao e aqui — e so aqui — que se
      // decide a cor da rua em sombra. O `groundColor` abaixo nunca alcanca
      // uma superficie horizontal (medido: zera-lo nao move 1 ponto de B-R).
      // A mistura e feita em RADIANCIA, nao em cor normalizada. Normalizar
      // cada lado antes de misturar inventa uma matiz que nao existe em
      // nenhum dos dois (zenite azul + parede laranja, ambos com o maximo
      // forcado a 1, dao magenta). Em radiancia, ceu + parede da cinza — que
      // e o que a rua realmente recebe.
      const b = sky.bounceColor;
      const k = THREE.MathUtils.clamp(this.bounceMix, 0, 1);
      let cr = THREE.MathUtils.lerp(z.r, b.r, k);
      let cg = THREE.MathUtils.lerp(z.g, b.g, k);
      let cb = THREE.MathUtils.lerp(z.b, b.b, k);
      // So depois normaliza: a intensidade da hemisferica ja esta calibrada e
      // a mistura nao pode roubar (nem dar) energia, so mudar a matiz.
      const cm = Math.max(cr, cg, cb, 1e-4);
      cr /= cm; cg /= cm; cb /= cm;
      this.hemi.color.setRGB(cr, cg, cb);
      // Chao: quente, poeira/tijolo do morro devolvendo luz.
      this.hemi.groundColor.setRGB(
        Math.min(1, h.r / hm * 0.85 + 0.15),
        Math.min(1, h.g / hm * 0.55 + 0.08),
        Math.min(1, h.b / hm * 0.35 + 0.05),
      );
      this.hemi.intensity = this.hemiIntensity * (0.35 + 1.6 * Math.min(1, zm));
    }
    if (this.vmHemi) {
      this.vmHemi.color.copy(this.hemi.color);
      this.vmHemi.groundColor.copy(this.hemi.groundColor);
      this.vmHemi.intensity = this.hemi.intensity * 1.4;
    }

    // --- Fog ----------------------------------------------------------------
    const fog = this.ctx.scene?.fog;
    if (fog) {
      // Um pouco mais escura que o horizonte: da perspectiva aerea sem lavar
      // o contraste da geometria distante.
      _col.copy(sky.horizonColor).multiplyScalar(this.fogHeightTint);
      fog.color.setRGB(
        Math.min(_col.r, 6), Math.min(_col.g, 6), Math.min(_col.b, 6),
      );
      fog.density = this.fogDensity;
    }

    // --- IBL ----------------------------------------------------------------
    if (force || sky.version !== this._envVersion) {
      this._regenerateEnvironment(sky);
    }
  }

  _regenerateEnvironment(sky) {
    const tex = sky.getEnvironmentTexture();
    if (!tex || !this._pmrem) return;
    const prevTarget = this.ctx.renderer.getRenderTarget();
    const rt = this._pmrem.fromEquirectangular(tex);
    this._envRT?.dispose();
    this._envRT = rt;
    this._envVersion = sky.version;

    const scene = this.ctx.scene;
    scene.environment = rt.texture;
    scene.environmentIntensity = this.envIntensity;
    const vs = this.ctx.viewScene;
    vs.environment = rt.texture;
    vs.environmentIntensity = this.envIntensity * 0.9;
    this.ctx.renderer.setRenderTarget(prevTarget);
  }

  /* ---------------------------------------------------------------------- */
  /* Cascatas                                                                */
  /* ---------------------------------------------------------------------- */

  /** Split "pratico" de Zhang: lerp entre uniforme e logaritmico. */
  _computeSplits(near, far) {
    const n = this.cascades;
    this.splits.length = 0;
    for (let i = 1; i <= n; i++) {
      const p = i / n;
      const uniform = near + (far - near) * p;
      const log = near * Math.pow(far / near, p);
      this.splits.push(THREE.MathUtils.lerp(uniform, log, this.lambda));
    }
    this.splits[n - 1] = far;
  }

  _updateCascades() {
    const cam = this.ctx.camera;
    if (!cam || this.lights.length === 0) return;

    // O near da camera (5 cm) faria o split logaritmico colapsar na cara do
    // jogador; para dividir cascatas usamos um near pratico de 0.5 m.
    const near = Math.max(cam.near, 0.5);
    const far = Math.min(cam.far, this.shadowDistance);
    this._computeSplits(near, far);

    this._u.cameraNear.value = near;
    this._u.shadowFar.value = far;

    // Base ortonormal da luz (identica a que o three monta em LightShadow).
    _lightDir.copy(this.sunDirection).negate();       // direcao que a luz VIAJA
    if (Math.abs(_lightDir.y) > 0.999) _lightDir.y = Math.sign(_lightDir.y) * 0.999;
    _lightDir.normalize();
    _orient.lookAt(_zero, _lightDir, _up);
    _orientInv.copy(_orient).invert();

    // Meia-abertura do frustum.
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const tanW = tanH * cam.aspect;
    const a2 = tanW * tanW + tanH * tanH;

    cam.getWorldDirection(_forward);

    const denom = far - near;
    const arr = this._u.CSM_cascades.value;

    for (let i = 0; i < this.cascades; i++) {
      const zn = i === 0 ? near : this.splits[i - 1];
      const zf = this.splits[i];

      // --- Esfera envolvente da fatia (invariante a rotacao) ----------------
      let zc = 0.5 * (zn + zf) * (1 + a2);
      let radius;
      if (zc > zf) { zc = zf; radius = Math.sqrt(a2) * zf; }
      else { radius = Math.sqrt(a2 * zf * zf + (zf - zc) * (zf - zc)); }

      // Margem do blend entre cascatas: o shader (CSM_FADE) faz o cross-fade
      // numa faixa proporcional a profundidade; a cascata precisa cobrir isso.
      const linDepth = zf / denom;
      radius += 0.5 * (0.25 * linDepth * linDepth * denom);
      radius = Math.max(radius, 1.0);

      _center.copy(cam.position).addScaledVector(_forward, zc);

      // --- Snap por texel ---------------------------------------------------
      const texel = (2 * radius) / this.shadowMapSize;
      _centerLS.copy(_center).applyMatrix4(_orientInv);
      _centerLS.x = Math.floor(_centerLS.x / texel) * texel;
      _centerLS.y = Math.floor(_centerLS.y / texel) * texel;
      _centerLS.applyMatrix4(_orient);

      const light = this.lights[i];
      light.position.copy(_centerLS).addScaledVector(this.sunDirection, radius + this.lightMargin);
      light.target.position.copy(_centerLS);
      light.target.updateMatrixWorld();

      const sc = light.shadow.camera;
      sc.left = -radius; sc.right = radius;
      sc.top = radius; sc.bottom = -radius;
      sc.near = 0.1;
      sc.far = 2 * radius + 2 * this.lightMargin;
      sc.updateProjectionMatrix();

      // --- Bias ------------------------------------------------------------
      // Constante em unidades de profundidade normalizada + offset ao longo da
      // normal proporcional ao tamanho do texel em metros. Assim o bias
      // acompanha a cascata em vez de ser um numero magico global.
      const depthRange = sc.far - sc.near;
      light.shadow.bias = -(0.11 / depthRange);
      light.shadow.normalBias = texel * 2.2;
      light.shadow.radius = this.softShadows ? 1.5 : 0.9;

      // --- Uniform da faixa de profundidade normalizada ---------------------
      arr[i].set((zn - near) / denom, (zf - near) / denom);
    }
    // A ultima cascata precisa fechar em 1.0 exatamente (o shader usa
    // UNROLLED_LOOP_INDEX == CSM_CASCADES-1 como caso especial).
    arr[this.cascades - 1].y = 1.0;
  }

  /* ---------------------------------------------------------------------- */

  update(dt) {
    this._frame++;

    // Varredura de materiais: agressiva durante o boot (o World/AI/FX ainda
    // estao criando geometria), depois amortizada.
    if (this._scanCountdown-- <= 0) {
      this.refreshMaterials();
      this._scanCountdown = this._frame < 300 ? 0 : 14;
    }

    this._syncFromSky();
    this._updateCascades();
  }

  setQuality(preset) {
    this._applyPreset(preset);
    this._buildLights();
    this.refreshMaterials();
    this._updateCascades();
  }

  dispose() {
    const scene = this.ctx.scene;
    for (const l of this.lights) {
      scene?.remove(l.target);
      scene?.remove(l);
      l.shadow.map?.dispose();
      l.dispose?.();
    }
    this.lights.length = 0;
    if (this.hemi) scene?.remove(this.hemi);
    if (this.vmSun) { this.vmSun.target.removeFromParent(); this.vmSun.removeFromParent(); }
    if (this.vmHemi) this.ctx.viewScene?.remove(this.vmHemi);
    this._envRT?.dispose();
    this._pmrem?.dispose();
    if (scene) { scene.environment = null; scene.fog = null; }
    uninstallCSMChunks();
  }
}
