/**
 * Engine — renderer, cenas, cameras, alvos HDR e resize.
 * Dono: CORE. UNICO lugar do projeto que instancia THREE.WebGLRenderer.
 *
 * Duas cenas:
 *   ctx.scene     + ctx.camera      -> mundo (FOV de settings.fov)
 *   ctx.viewScene + ctx.viewCamera  -> viewmodel da arma (FOV proprio, menor),
 *                                      desenhado por cima com o depth zerado,
 *                                      de modo que a arma nunca clipa na parede.
 *
 * O alvo HDR (RGBA16F) tem uma DepthTexture anexada. Ela e a "meia G-buffer"
 * que SSAO, motion blur, DOF e TAA consomem. Optamos por NAO fazer pre-passe de
 * geometria nem MRT: as normais sao reconstruidas do depth num passe de
 * meia-resolucao (1 draw call) em vez de duplicar todas as draw calls do mundo.
 * Ver PostFX/NORMAL_DEPTH_FRAG.
 */
import * as THREE from 'three';
import { makeHDRTarget, disposeTarget } from './shaders/FullScreen.js';

const RESIZE_DEBOUNCE_MS = 120;

export class Engine {
  /**
   * @param {object} ctx GameContext
   * @param {HTMLCanvasElement} canvas
   */
  constructor(ctx, canvas) {
    this.ctx = ctx;
    this.canvas = canvas;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.viewScene = null;
    this.viewCamera = null;

    /** Escala de resolucao efetiva (preset + DPR). */
    this.renderScale = 1;
    this.maxPixelRatio = 1.5;
    this.renderWidth = 1;
    this.renderHeight = 1;
    this.cssWidth = 1;
    this.cssHeight = 1;

    /** Alvo HDR da cena + depth. Preenchido em init(). */
    this.sceneTarget = null;

    this._lastFov = -1;
    this._lastVmFov = -1;
    this._resizeTimer = 0;
    this._resizeObserver = null;
    this._onWindowResize = null;
    this._disposed = false;
  }

  async init() {
    const ctx = this.ctx;
    const settings = ctx.settings;

    // --- Renderer -----------------------------------------------------------
    // antialias:false de proposito: o AA e feito no pos-processamento (TAA/FXAA).
    // MSAA no framebuffer default nao ajuda num pipeline que escreve em RT HDR.
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });

    if (!renderer.capabilities.isWebGL2) {
      throw new Error('WebGL2 e obrigatorio (float render targets, MRT-less GTAO).');
    }

    renderer.setPixelRatio(1);              // controlamos a escala manualmente
    renderer.autoClear = true;
    // A cadeia de pos-processamento faz ~20 render() por frame; com autoReset
    // o info so mostraria o ultimo passe. Zeramos no inicio do frame para que
    // renderer.info some o custo REAL do pipeline inteiro.
    renderer.info.autoReset = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = settings?.exposure ?? 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // PCFShadowMap mantem o empacotamento RGBA de profundidade que o nosso
    // filtro Poisson (csm.glsl.js) espera. PCFSoft/VSM mudariam isso.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x000000, 1);

    this.renderer = renderer;
    ctx.renderer = renderer;

    // --- Cenas e cameras ----------------------------------------------------
    const scene = new THREE.Scene();
    scene.name = 'mundo';
    const viewScene = new THREE.Scene();
    viewScene.name = 'viewmodel';

    const aspect = this._measure();

    const camera = new THREE.PerspectiveCamera(settings?.fov ?? 80, aspect, 0.05, 500);
    camera.name = 'cameraJogador';
    camera.position.set(0, 1.68, 0);

    // A arma vive entre 0.10 m e 1.00 m da camera: near minusculo e far curto
    // concentram a precisao do depth exatamente onde ela esta.
    const viewCamera = new THREE.PerspectiveCamera(settings?.viewmodelFov ?? 60, aspect, 0.01, 40);
    viewCamera.name = 'cameraViewmodel';
    // PLAYER pode assumir o controle setando viewCamera.userData.autoFollow = false.
    viewCamera.userData.autoFollow = true;
    // A camera do viewmodel entra na cena para que a arma possa ser filha dela
    // (transform em espaco de camera) e para que luzes anexadas a ela sigam a
    // mira. Ver NOTES.md.
    viewScene.add(viewCamera);

    this.scene = ctx.scene = scene;
    this.camera = ctx.camera = camera;
    this.viewScene = ctx.viewScene = viewScene;
    this.viewCamera = ctx.viewCamera = viewCamera;
    ctx.clock = new THREE.Clock(false);

    // --- Alvo HDR + depth ---------------------------------------------------
    this._allocTargets();

    // --- Resize -------------------------------------------------------------
    this._installResize();
    this._applySize(true);

    return this;
  }

  /* ---------------------------------------------------------------------- */
  /* Tamanho / alvos                                                         */
  /* ---------------------------------------------------------------------- */

  /** Le o tamanho CSS do canvas; devolve o aspect. */
  _measure() {
    const c = this.canvas;
    let w = c.clientWidth;
    let h = c.clientHeight;
    if (!w || !h) {
      // O CSS do modulo UI ainda nao carregou (ou estamos numa pagina de teste):
      // damos ao canvas um layout minimo para nao renderizar 0x0.
      c.style.display = 'block';
      c.style.width = '100%';
      c.style.height = '100%';
      w = c.clientWidth || window.innerWidth || 1280;
      h = c.clientHeight || window.innerHeight || 720;
    }
    this.cssWidth = Math.max(1, w);
    this.cssHeight = Math.max(1, h);
    return this.cssWidth / this.cssHeight;
  }

  /** Escala final = preset.renderScale * min(DPR, maxPixelRatio). */
  _effectiveScale() {
    const preset = this.ctx.settings?.q;
    const base = preset?.renderScale ?? 1;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    return base * dpr;
  }

  _applySize(force = false) {
    if (this._disposed) return;
    const aspect = this._measure();
    const scale = this._effectiveScale();
    const w = Math.max(2, Math.round(this.cssWidth * scale));
    const h = Math.max(2, Math.round(this.cssHeight * scale));

    if (!force && w === this.renderWidth && h === this.renderHeight) return;

    this.renderScale = scale;
    this.renderWidth = w;
    this.renderHeight = h;

    // updateStyle=false: o tamanho CSS do canvas continua sendo do layout/UI.
    this.renderer.setSize(w, h, false);

    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();

    this._resizeTargets(w, h);
    this.ctx.postfx?.setSize?.(w, h);
    this.ctx.bus?.emit('engine:resize', { width: w, height: h, cssWidth: this.cssWidth, cssHeight: this.cssHeight });
  }

  _allocTargets() {
    const w = Math.max(2, this.renderWidth);
    const h = Math.max(2, this.renderHeight);
    const rt = makeHDRTarget(w, h, { depthBuffer: true, name: 'sceneHDR' });
    // DepthTexture 24 bits: precisao suficiente para near=0.05/far=500 e
    // amostravel no shader (DEPTH_COMPONENT24).
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    rt.depthTexture = depth;
    this.sceneTarget = rt;
  }

  _resizeTargets(w, h) {
    if (!this.sceneTarget) { this._allocTargets(); return; }
    this.sceneTarget.setSize(w, h);
    this.sceneTarget.depthTexture.image.width = w;
    this.sceneTarget.depthTexture.image.height = h;
    this.sceneTarget.depthTexture.needsUpdate = true;
  }

  _installResize() {
    const schedule = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._applySize(), RESIZE_DEBOUNCE_MS);
    };
    this._onWindowResize = schedule;
    window.addEventListener('resize', schedule, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(schedule);
      this._resizeObserver.observe(this.canvas);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Renderiza o mundo no alvo indicado (ou na tela).
   * @param {THREE.WebGLRenderTarget|null} target
   */
  renderWorld(target) {
    const r = this.renderer;
    r.setRenderTarget(target ?? null);
    r.autoClear = true;
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
  }

  /**
   * Desenha o viewmodel POR CIMA do conteudo existente, com o depth limpo.
   * O alvo precisa ter depth buffer.
   */
  renderViewmodel(target) {
    const vs = this.viewScene;
    if (!vs.visible || vs.children.length === 0) return false;
    const r = this.renderer;
    r.setRenderTarget(target ?? null);
    r.autoClear = false;
    r.clearDepth();                 // a arma sempre vence o depth do mundo
    r.render(vs, this.viewCamera);
    r.autoClear = true;
    return true;
  }

  /**
   * Sincroniza FOV/transform das cameras antes de desenhar.
   *
   * Politica de FOV: o Engine so ESCREVE `camera.fov` quando o valor em
   * `settings` muda. Fora disso, quem lerpa o FOV por frame (CameraRig do
   * PLAYER, para ADS/sprint) e o dono — se empurrassemos o valor de settings
   * todo frame, a mira nunca conseguiria fechar o FOV.
   * As matrizes de projecao sao reconstruidas sempre, entao qualquer escrita
   * feita por outro modulo entra em vigor no mesmo frame.
   */
  syncCameras() {
    const s = this.ctx.settings;
    if (s) {
      if (s.fov !== this._lastFov) { this._lastFov = s.fov; this.camera.fov = s.fov; }
      if (s.viewmodelFov !== this._lastVmFov) {
        this._lastVmFov = s.viewmodelFov;
        this.viewCamera.fov = s.viewmodelFov;
      }
    }
    this.camera.updateProjectionMatrix();
    this.viewCamera.updateProjectionMatrix();

    const vc = this.viewCamera;
    if (vc.userData.autoFollow !== false) {
      vc.position.copy(this.camera.position);
      vc.quaternion.copy(this.camera.quaternion);
    }
    this.camera.updateMatrixWorld();
    vc.updateMatrixWorld();
  }

  /**
   * Ponto de entrada do frame. Se o PostFX existir e estiver pronto ele assume
   * a orquestracao; senao caimos no caminho direto — o jogo NUNCA fica preto
   * enquanto os outros modulos estao sendo escritos em paralelo.
   */
  render() {
    if (this._disposed) return;
    this.renderer.info.reset();
    this.syncCameras();

    const postfx = this.ctx.postfx;
    const usePost = !!(postfx && postfx.ready && postfx.enabled);

    const r = this.renderer;
    // Com pos-processamento o tonemap acontece no shader de grade; deixar o
    // ACES do renderer ligado tonemaparia duas vezes e mataria o HDR do bloom.
    const wanted = usePost ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    if (r.toneMapping !== wanted) r.toneMapping = wanted;
    // No caminho direto compensamos a escala HDR do Sky aqui, para o fallback
    // nao sair estourado de branco em relacao ao caminho com PostFX.
    const eScale = usePost ? 1 : (postfx?.exposureScale ?? 0.5);
    r.toneMappingExposure = (this.ctx.settings?.exposure ?? 1.0) * eScale;

    if (usePost) {
      postfx.render();
    } else {
      this.renderWorld(null);
      this.renderViewmodel(null);
      r.setRenderTarget(null);
    }
  }

  /* ---------------------------------------------------------------------- */

  setQuality() {
    // renderScale vem do preset; realoca alvos com o novo tamanho.
    this._applySize(true);
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._resizeTimer);
    if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize);
    this._resizeObserver?.disconnect();
    disposeTarget(this.sceneTarget);
    this.sceneTarget = null;
    this.renderer?.dispose();
  }
}
