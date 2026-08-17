/**
 * PostFX — cadeia de pos-processamento em fullscreen quads.
 * Dono: CORE.
 *
 * Ordem (contrato do ARCHITECTURE.md):
 *   SSAO -> Bloom -> Motion Blur -> DOF -> Tonemap+Grade -> TAA/FXAA -> Grain/Vinheta/CA
 *
 * Nao usamos EffectComposer: precisamos ler a DepthTexture da cena em varios
 * estagios, compor o viewmodel no meio da cadeia e controlar exatamente quais
 * alvos participam de cada ping-pong.
 *
 * Fluxo de alvos por frame:
 *   mundo      -> sceneHDR (+DepthTexture)
 *   depth      -> normalDepth (meia res)
 *   GTAO       -> ao (meia res) -> blur H -> blur V
 *   AO+cena    -> pingA          (alpha = 0, marca "mundo")
 *   viewmodel  -> pingA          (alpha = 1, marca "arma"; depth limpo antes)
 *   bloom      -> piramide de mips a partir de pingA
 *   motionblur -> pingA -> pingB
 *   dof        -> pingB -> pingA
 *   tonemap    -> pingA (+bloom) -> ldr
 *   TAA        -> ldr + historico -> historico'
 *   finish     -> tela
 */
import * as THREE from 'three';
import { Pass, makeHDRTarget, makeLDRTarget, disposeTarget } from './shaders/FullScreen.js';
import {
  NORMAL_DEPTH_FRAG, GTAO_FRAG, AO_BLUR_FRAG, AO_COMPOSITE_FRAG,
  BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, MOTION_BLUR_FRAG,
  FOCUS_FRAG, DOF_FRAG, TONEMAP_FRAG, TAA_FRAG, FINISH_FRAG,
} from './shaders/post.glsl.js';

/** Sequencia de Halton — base do jitter sub-pixel do TAA. */
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
const JITTER = [];
for (let i = 1; i <= 16; i++) JITTER.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);

export class PostFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.enabled = true;

    this.width = 2;
    this.height = 2;

    // --- Estagios ativos (preenchidos por setQuality) ----------------------
    this.useSSAO = true;
    this.ssaoQuality = 'full';
    this.useBloom = true;
    this.bloomIterations = 5;
    this.useMotionBlur = true;
    this.useDOF = true;
    this.useTAA = true;
    this.useFXAA = false;

    // --- Parametros artisticos ---------------------------------------------
    /* Calibrado por varredura medida (tools/probe.mjs): com 0,50 o beco em
     * sombra ficava com 85% dos pixels abaixo de 8/255 — preto chapado. A
     * sombra aberta real fica a ~1/8 do sol, nao a 1/100. */
    this.exposureScale = 0.95;   // casa a escala HDR do Sky com o ACES
    this.bloomThreshold = 1.05;
    this.bloomKnee = 0.62;
    this.bloomIntensity = 0.055;
    this.aoStrength = 0.85;
    this.aoRadius = 0.8;         // metros
    this.motionBlurStrength = 0.55;
    this.dofBase = 0.32;         // desfoque de distancia sempre ligado (sutil)
    this.dofAds = 0.85;
    this.taaFeedback = 0.90;

    this._dofAmount = this.dofBase;
    this._dofTarget = this.dofBase;
    this._ads = false;

    // --- Alvos --------------------------------------------------------------
    this.pingA = null; this.pingB = null;
    this.ndRT = null; this.aoRT = null; this.aoTmp = null;
    this.ldrRT = null; this.histA = null; this.histB = null;
    this.focusA = null; this.focusB = null;
    this.bloomMips = [];

    // --- Matrizes de reprojecao --------------------------------------------
    this._projClean = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._jitterIndex = 0;
    this._historyValid = 0;
    this._historySwap = false;
    this._time = 0;
    this._frame = 0;

    this._unsub = [];
  }

  async init() {
    const ctx = this.ctx;
    this.engine = ctx.engine;
    if (!this.engine) throw new Error('PostFX precisa do Engine em ctx.engine.');

    this.setQuality(ctx.settings?.q);
    this._buildPasses();
    this.setSize(this.engine.renderWidth, this.engine.renderHeight);

    // ADS aumenta o DOF (foco curto, fundo derretido) — sinal vem do PLAYER.
    const off = ctx.bus?.on('weapon:state', (s) => {
      if (!s) return;
      this._ads = !!s.ads;
      this._dofTarget = this._ads ? this.dofAds : this.dofBase;
    });
    if (off) this._unsub.push(off);

    this.ready = true;
    return this;
  }

  /* ---------------------------------------------------------------------- */
  /* Construcao                                                              */
  /* ---------------------------------------------------------------------- */

  _buildPasses() {
    const T = () => ({ value: null });

    this.pNormalDepth = new Pass(NORMAL_DEPTH_FRAG, {
      tDepth: T(),
      uInvProjParams: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.05 }, uFar: { value: 500 },
    }, {}, { name: 'NormalDepth' });

    this.pGTAO = new Pass(GTAO_FRAG, {
      tND: T(),
      uInvProjParams: { value: new THREE.Vector2(1, 1) },
      uResolution: { value: new THREE.Vector2() },
      uRadius: { value: this.aoRadius },
      uProjScale: { value: 500 },
      uIntensity: { value: 1.35 },
      uFar: { value: 500 },
      uFrame: { value: 0 },
    }, { SLICES: 3, STEPS: 5 }, { name: 'GTAO' });

    this.pAOBlur = new Pass(AO_BLUR_FRAG, {
      tAO: T(), tND: T(),
      uDir: { value: new THREE.Vector2() },
      uDepthSigma: { value: 6.0 },
    }, {}, { name: 'AOBlur' });

    this.pAOComposite = new Pass(AO_COMPOSITE_FRAG, {
      tScene: T(), tAO: T(), tND: T(), tDepth: T(),
      uHalfTexel: { value: new THREE.Vector2() },
      uStrength: { value: this.aoStrength },
      uNear: { value: 0.05 }, uFar: { value: 500 },
      uEnabled: { value: 1 },
    }, {}, { name: 'AOComposite' });

    this.pBloomPre = new Pass(BLOOM_PREFILTER_FRAG, {
      tSrc: T(), uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: this.bloomThreshold },
      uKnee: { value: this.bloomKnee },
    }, {}, { name: 'BloomPrefilter' });

    this.pBloomDown = new Pass(BLOOM_DOWN_FRAG, {
      tSrc: T(), uTexel: { value: new THREE.Vector2() },
    }, {}, { name: 'BloomDown' });

    this.pBloomUp = new Pass(BLOOM_UP_FRAG, {
      tSrc: T(), uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
    }, {}, { name: 'BloomUp', blending: THREE.AdditiveBlending, transparent: true });

    this.pMotionBlur = new Pass(MOTION_BLUR_FRAG, {
      tColor: T(), tDepth: T(),
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uStrength: { value: this.motionBlurStrength },
      uMaxVelocity: { value: 0.055 },
    }, { MB_SAMPLES: 9 }, { name: 'MotionBlur' });

    this.pFocus = new Pass(FOCUS_FRAG, {
      tDepth: T(), tPrev: T(),
      uNear: { value: 0.05 }, uFar: { value: 500 },
      uSpeed: { value: 0.1 }, uMaxFocus: { value: 90 },
    }, {}, { name: 'Focus' });

    this.pDOF = new Pass(DOF_FRAG, {
      tColor: T(), tDepth: T(), tFocus: T(),
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.05 }, uFar: { value: 500 },
      uMaxCoC: { value: 12 },
      uAmount: { value: this.dofBase },
      uNearScale: { value: 0.16 },
      uAperture: { value: 1.75 },
    }, { DOF_SAMPLES: 22 }, { name: 'DOF' });

    this.pTonemap = new Pass(TONEMAP_FRAG, {
      tColor: T(), tBloom: T(),
      uResolution: { value: new THREE.Vector2() },
      uExposure: { value: 0.26 },
      uBloomIntensity: { value: this.bloomIntensity },
      /* Split toning: realces quentes (laranja) e sombras NEUTRAS.
       *
       * A sombra era puxada para o teal (0.945, 0.985, 1.055) e mais o lift e
       * a gamma azuis logo abaixo. Somados, valiam ~12 pontos de B-R medidos
       * (tools/chaoprova.mjs) em cima de uma sombra que a fisica ja entregava
       * azul — e frio no chao inteiro e o oposto da capa, onde o ciano e
       * exclusividade dos robos. O ciano dos robos e emissivo e vive na faixa
       * de realce (acima do bloomThreshold), entao nada aqui o toca.
       * O lado quente do teal-orange fica: uHighlightTint e uGain seguem iguais. */
      uShadowTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      uHighlightTint: { value: new THREE.Vector3(1.075, 1.005, 0.912) },
      uSplitBalance: { value: 0.40 },
      uContrast: { value: 1.06 },
      uSaturation: { value: 1.07 },
      uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
      uGamma: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      uGain: { value: new THREE.Vector3(1.025, 1.0, 0.975) },
      uBlackPoint: { value: 0.005 },
    }, { USE_BLOOM: 1 }, { name: 'Tonemap' });

    this.pTAA = new Pass(TAA_FRAG, {
      tCurrent: T(), tHistory: T(), tDepth: T(),
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uFeedback: { value: this.taaFeedback },
      uHistoryValid: { value: 0 },
    }, {}, { name: 'TAA' });

    this.pFinish = new Pass(FINISH_FRAG, {
      tSrc: T(),
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uGrain: { value: 0.35 },
      uVignette: { value: 0.6 },
      uChromatic: { value: 0.4 },
      uAspect: { value: 1.777 },
    }, {}, { name: 'Finish' });

    this._applyStageDefines();
  }

  _applyStageDefines() {
    if (!this.pGTAO) return;
    const full = this.ssaoQuality === 'full';
    this.pGTAO.setDefine('SLICES', full ? 3 : 2);
    this.pGTAO.setDefine('STEPS', full ? 5 : 4);
    this.pTonemap.setDefine('USE_BLOOM', this.useBloom ? 1 : null);
    this.pFinish.setDefine('USE_FXAA', this.useFXAA ? 1 : null);
    this.pMotionBlur.setDefine('MB_SAMPLES', 9);
    this.pDOF.setDefine('DOF_SAMPLES', this.useTAA ? 22 : 16);
  }

  /* ---------------------------------------------------------------------- */
  /* Tamanho                                                                 */
  /* ---------------------------------------------------------------------- */

  setSize(w, h) {
    w = Math.max(2, w | 0); h = Math.max(2, h | 0);
    if (w === this.width && h === this.height && this.pingA) return;
    this.width = w; this.height = h;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);

    this._freeTargets();

    // pingA precisa de depth buffer: o viewmodel e desenhado nele.
    this.pingA = makeHDRTarget(w, h, { depthBuffer: true, name: 'pingA' });
    this.pingB = makeHDRTarget(w, h, { name: 'pingB' });
    this.ndRT = makeHDRTarget(hw, hh, { name: 'normalDepth', filter: THREE.NearestFilter });
    this.aoRT = makeLDRTarget(hw, hh, { name: 'ao' });
    this.aoTmp = makeLDRTarget(hw, hh, { name: 'aoTmp' });
    this.ldrRT = makeLDRTarget(w, h, { name: 'ldr' });
    this.histA = makeLDRTarget(w, h, { name: 'histA' });
    this.histB = makeLDRTarget(w, h, { name: 'histB' });
    this.focusA = makeHDRTarget(1, 1, { name: 'focusA', filter: THREE.NearestFilter });
    this.focusB = makeHDRTarget(1, 1, { name: 'focusB', filter: THREE.NearestFilter });

    // Piramide de bloom: mip0 em meia resolucao, halving ate o limite do preset.
    this.bloomMips = [];
    let mw = hw, mh = hh;
    for (let i = 0; i < this.bloomIterations; i++) {
      if (mw < 8 || mh < 8) break;
      this.bloomMips.push(makeHDRTarget(mw, mh, { name: `bloom${i}` }));
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
    }

    this._historyValid = 0;
  }

  _freeTargets() {
    for (const rt of [this.pingA, this.pingB, this.ndRT, this.aoRT, this.aoTmp,
      this.ldrRT, this.histA, this.histB, this.focusA, this.focusB]) disposeTarget(rt);
    for (const rt of this.bloomMips) disposeTarget(rt);
    this.bloomMips = [];
    this.pingA = this.pingB = this.ndRT = this.aoRT = this.aoTmp = null;
    this.ldrRT = this.histA = this.histB = this.focusA = this.focusB = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Qualidade                                                               */
  /* ---------------------------------------------------------------------- */

  setQuality(preset) {
    if (!preset) return;
    this.useSSAO = preset.ssao !== 'off';
    this.ssaoQuality = preset.ssao === 'full' ? 'full' : 'half';
    this.useBloom = true;
    this.bloomIterations = THREE.MathUtils.clamp(preset.bloomIterations ?? 4, 2, 7);
    this.useMotionBlur = !!preset.motionBlur;
    this.useDOF = !!preset.dof;
    this.useTAA = !!preset.taa;
    this.useFXAA = !!preset.fxaa || !preset.taa;
    // bloom "simples" = piramide curta com raio maior (menos passes, mesmo look).
    this.bloomIntensity = preset.bloom === '5tap' ? 0.055 : 0.045;

    if (this.pGTAO) {
      this._applyStageDefines();
      // Muda o numero de mips: realoca a piramide.
      if (this.bloomMips.length !== this.bloomIterations) {
        const w = this.width, h = this.height;
        this.width = -1;             // forca realocacao
        this.setSize(w, h);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                   */
  /* ---------------------------------------------------------------------- */

  update(dt) {
    this._time += dt;
    // Transicao suave do DOF ao entrar/sair da mira.
    const k = 1 - Math.exp(-dt * 9);
    this._dofAmount += (this._dofTarget - this._dofAmount) * k;
    this._focusSpeed = 1 - Math.exp(-dt * 5);
  }

  /** Aplica o jitter sub-pixel do TAA nas duas cameras. */
  _applyJitter() {
    const ctx = this.ctx;
    const cam = ctx.camera, vcam = ctx.viewCamera;
    cam.updateProjectionMatrix();
    this._projClean.copy(cam.projectionMatrix);

    if (!this.useTAA) return;

    const j = JITTER[this._jitterIndex % JITTER.length];
    this._jitterIndex++;
    const jx = (j[0] * 2) / this.width;
    const jy = (j[1] * 2) / this.height;

    cam.projectionMatrix.elements[8] += jx;
    cam.projectionMatrix.elements[9] += jy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    vcam.updateProjectionMatrix();
    vcam.projectionMatrix.elements[8] += jx;
    vcam.projectionMatrix.elements[9] += jy;
    vcam.projectionMatrixInverse.copy(vcam.projectionMatrix).invert();
  }

  _clearJitter() {
    if (!this.useTAA) return;
    const ctx = this.ctx;
    ctx.camera.projectionMatrix.copy(this._projClean);
    ctx.camera.projectionMatrixInverse.copy(this._projClean).invert();
    ctx.viewCamera.updateProjectionMatrix();
  }

  render() {
    const ctx = this.ctx;
    const r = ctx.renderer;
    const engine = this.engine;
    const cam = ctx.camera;
    const sceneRT = engine.sceneTarget;
    if (!sceneRT || !this.pingA) { engine.renderWorld(null); engine.renderViewmodel(null); return; }

    this._frame++;
    const w = this.width, h = this.height;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);

    // --- Matrizes de reprojecao (sempre SEM jitter) -------------------------
    this._applyJitter();
    this._viewProj.multiplyMatrices(this._projClean, cam.matrixWorldInverse);
    this._invViewProj.copy(this._viewProj).invert();
    if (this._frame === 1) this._prevViewProj.copy(this._viewProj);

    const p = this._projClean.elements;
    const invProjX = 1 / p[0];
    const invProjY = 1 / p[5];
    const near = cam.near, far = cam.far;

    // ======================================================================
    // 1. Mundo -> HDR
    // ======================================================================
    engine.renderWorld(sceneRT);

    const depthTex = sceneRT.depthTexture;

    // ======================================================================
    // 2. Normal + profundidade linear (meia res)
    // ======================================================================
    if (this.useSSAO) {
      let u = this.pNormalDepth.uniforms;
      u.tDepth.value = depthTex;
      u.uInvProjParams.value.set(invProjX, invProjY);
      u.uTexel.value.set(1 / hw, 1 / hh);
      u.uNear.value = near; u.uFar.value = far;
      this.pNormalDepth.render(r, this.ndRT);

      // ====================================================================
      // 3. GTAO + blur bilateral
      // ====================================================================
      u = this.pGTAO.uniforms;
      u.tND.value = this.ndRT.texture;
      u.uInvProjParams.value.set(invProjX, invProjY);
      u.uResolution.value.set(hw, hh);
      u.uRadius.value = this.aoRadius;
      // metros -> pixels a 1 m: 0.5 * altura * P11
      u.uProjScale.value = 0.5 * hh * p[5];
      u.uFar.value = far;
      u.uFrame.value = this._frame % 64;
      this.pGTAO.render(r, this.aoRT);

      u = this.pAOBlur.uniforms;
      u.tND.value = this.ndRT.texture;
      u.uDepthSigma.value = 6.0;
      u.tAO.value = this.aoRT.texture;
      u.uDir.value.set(1 / hw, 0);
      this.pAOBlur.render(r, this.aoTmp);
      u.tAO.value = this.aoTmp.texture;
      u.uDir.value.set(0, 1 / hh);
      this.pAOBlur.render(r, this.aoRT);
    }

    // ======================================================================
    // 4. Composite do AO -> pingA (alpha 0 = mundo)
    // ======================================================================
    {
      const u = this.pAOComposite.uniforms;
      u.tScene.value = sceneRT.texture;
      u.tAO.value = this.aoRT.texture;
      u.tND.value = this.ndRT.texture;
      u.tDepth.value = depthTex;
      u.uHalfTexel.value.set(1 / hw, 1 / hh);
      u.uStrength.value = this.aoStrength;
      u.uNear.value = near; u.uFar.value = far;
      u.uEnabled.value = this.useSSAO ? 1 : 0;
      this.pAOComposite.render(r, this.pingA);
    }

    // ======================================================================
    // 5. Viewmodel por cima, com depth limpo (alpha 1 = arma)
    // ======================================================================
    engine.renderViewmodel(this.pingA);

    // ======================================================================
    // 6. Bloom (piramide dual-filter). Extraido DEPOIS do viewmodel para o
    //    fogonete do cano tambem brilhar.
    // ======================================================================
    if (this.useBloom && this.bloomMips.length > 0) {
      const mips = this.bloomMips;
      let u = this.pBloomPre.uniforms;
      u.tSrc.value = this.pingA.texture;
      u.uTexel.value.set(1 / w, 1 / h);
      u.uThreshold.value = this.bloomThreshold;
      u.uKnee.value = this.bloomKnee;
      this.pBloomPre.render(r, mips[0]);

      for (let i = 1; i < mips.length; i++) {
        u = this.pBloomDown.uniforms;
        u.tSrc.value = mips[i - 1].texture;
        u.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
        this.pBloomDown.render(r, mips[i]);
      }
      for (let i = mips.length - 1; i > 0; i--) {
        u = this.pBloomUp.uniforms;
        u.tSrc.value = mips[i].texture;
        u.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
        u.uRadius.value = 1.0;
        // Aditivo sobre o mip maior — nada de feedback lendo e escrevendo o mesmo alvo.
        this.pBloomUp.render(r, mips[i - 1], false);
      }
    }

    // ======================================================================
    // 7. Motion blur
    // ======================================================================
    let src = this.pingA, dst = this.pingB;
    if (this.useMotionBlur) {
      const u = this.pMotionBlur.uniforms;
      u.tColor.value = src.texture;
      u.tDepth.value = depthTex;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._prevViewProj);
      u.uStrength.value = this.motionBlurStrength;
      this.pMotionBlur.render(r, dst);
      const t = src; src = dst; dst = t;
    }

    // ======================================================================
    // 8. Foco automatico + DOF
    // ======================================================================
    if (this.useDOF && this._dofAmount > 0.005) {
      const fSrc = this._historySwap ? this.focusB : this.focusA;
      const fDst = this._historySwap ? this.focusA : this.focusB;
      let u = this.pFocus.uniforms;
      u.tDepth.value = depthTex;
      u.tPrev.value = fSrc.texture;
      u.uNear.value = near; u.uFar.value = far;
      u.uSpeed.value = this._focusSpeed ?? 0.12;
      this.pFocus.render(r, fDst);

      u = this.pDOF.uniforms;
      u.tColor.value = src.texture;
      u.tDepth.value = depthTex;
      u.tFocus.value = fDst.texture;
      u.uTexel.value.set(1 / w, 1 / h);
      u.uNear.value = near; u.uFar.value = far;
      u.uMaxCoC.value = 12 * (h / 1080);
      u.uAmount.value = this._dofAmount;
      u.uNearScale.value = this._ads ? 0.85 : 0.16;
      this.pDOF.render(r, dst);
      const t = src; src = dst; dst = t;
    }

    // ======================================================================
    // 9. Tonemap + color grade -> LDR
    // ======================================================================
    {
      const u = this.pTonemap.uniforms;
      u.tColor.value = src.texture;
      u.tBloom.value = this.bloomMips[0] ? this.bloomMips[0].texture : null;
      u.uResolution.value.set(w, h);
      u.uExposure.value = this.exposureScale * (ctx.settings?.exposure ?? 1);
      u.uBloomIntensity.value = this.bloomIntensity;
      this.pTonemap.render(r, this.ldrRT);
    }

    // ======================================================================
    // 10. TAA (ou nada — o FXAA acontece dentro do passe final)
    // ======================================================================
    let aaResult = this.ldrRT;
    if (this.useTAA) {
      const hPrev = this._historySwap ? this.histB : this.histA;
      const hCur = this._historySwap ? this.histA : this.histB;
      const u = this.pTAA.uniforms;
      u.tCurrent.value = this.ldrRT.texture;
      u.tHistory.value = hPrev.texture;
      u.tDepth.value = depthTex;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._prevViewProj);
      u.uTexel.value.set(1 / w, 1 / h);
      u.uFeedback.value = this.taaFeedback;
      u.uHistoryValid.value = this._historyValid;
      this.pTAA.render(r, hCur);
      aaResult = hCur;
      this._historyValid = 1;
    }

    // ======================================================================
    // 11. Grain + vinheta + aberracao cromatica + dither -> tela
    // ======================================================================
    {
      const s = ctx.settings;
      const u = this.pFinish.uniforms;
      u.tSrc.value = aaResult.texture;
      u.uTexel.value.set(1 / w, 1 / h);
      u.uResolution.value.set(w, h);
      u.uTime.value = this._time;
      u.uGrain.value = s?.filmGrain ?? 0.35;
      u.uVignette.value = s?.vignette ?? 0.6;
      u.uChromatic.value = s?.chromaticAberration ?? 0.4;
      u.uAspect.value = w / h;
      this.pFinish.render(r, null);
    }

    // --- Fecha o frame ------------------------------------------------------
    this._prevViewProj.copy(this._viewProj);
    this._historySwap = !this._historySwap;
    this._clearJitter();
    r.setRenderTarget(null);
  }

  /* ---------------------------------------------------------------------- */

  dispose() {
    for (const off of this._unsub) { try { off(); } catch { /* ignora */ } }
    this._unsub.length = 0;
    this._freeTargets();
    for (const k of Object.keys(this)) {
      const v = this[k];
      if (v instanceof Pass) v.dispose();
    }
    this.ready = false;
  }
}
