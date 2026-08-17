/**
 * FullScreen — infraestrutura minima para passes de tela cheia.
 * Dono: CORE.
 *
 * Nao usamos EffectComposer: precisamos controlar exatamente quais alvos sao
 * lidos/escritos (o depth buffer da cena e compartilhado entre passes) e
 * queremos zero alocacao por frame.
 *
 * Triangulo de tela cheia (nao quad): um unico triangulo que cobre o viewport
 * evita a "costura" diagonal onde as derivadas (dFdx/dFdy) ficam erradas e
 * reduz overdraw de ~4% da GPU em quads.
 */
import * as THREE from 'three';

/** Geometria compartilhada por TODOS os passes — 3 vertices, 1 draw call. */
const _triangle = (() => {
  const g = new THREE.BufferGeometry();
  // Coordenadas ja em NDC: o vertex shader as repassa direto.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 2, 0, 0, 2,
  ]), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return g;
})();

export const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  // z = 1.0 (far). Como depthTest esta desligado nos passes, so importa o xy.
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

// Cena/camera descartaveis compartilhadas: renderizamos sempre a mesma malha,
// so trocando o material. Assim o three nao refaz frustum culling nem sorting.
const _scene = new THREE.Scene();
const _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const _mesh = new THREE.Mesh(_triangle, null);
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
_scene.add(_mesh);
_scene.matrixAutoUpdate = false;

/**
 * Um estagio de pos-processamento. Encapsula ShaderMaterial + render para alvo.
 */
export class Pass {
  /**
   * @param {string} fragmentShader
   * @param {Object} uniforms  mapa { nome: { value } }
   * @param {Object} [defines]
   * @param {Object} [opts] { blending, transparent, name }
   */
  constructor(fragmentShader, uniforms, defines = {}, opts = {}) {
    this.material = new THREE.ShaderMaterial({
      name: opts.name || 'Pass',
      uniforms,
      defines,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      transparent: opts.transparent ?? false,
      toneMapped: false,
      fog: false,
      lights: false,
    });
    this.uniforms = this.material.uniforms;
    this.enabled = true;
  }

  /** Recompila o shader (apos mudar defines). */
  invalidate() { this.material.needsUpdate = true; }

  setDefine(key, value) {
    if (this.material.defines[key] === value) return;
    if (value === null || value === undefined || value === false) delete this.material.defines[key];
    else this.material.defines[key] = value;
    this.material.needsUpdate = true;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget|null} target  null = canvas
   * @param {boolean} [clear=true]  false para acumular (bloom upsample aditivo)
   */
  render(renderer, target, clear = true) {
    _mesh.material = this.material;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = clear;
    renderer.setRenderTarget(target ?? null);
    renderer.render(_scene, _camera);
    renderer.autoClear = prevAutoClear;
  }

  dispose() { this.material.dispose(); }
}

/** Cria um render target HDR (RGBA16F) sem mipmaps. */
export function makeHDRTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: opts.filter ?? THREE.LinearFilter,
    magFilter: opts.filter ?? THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: opts.depthBuffer ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
  rt.texture.name = opts.name || 'hdr';
  return rt;
}

/** Cria um render target LDR (RGBA8). */
export function makeLDRTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace, // gravamos sRGB "na mao" no shader final
    minFilter: opts.filter ?? THREE.LinearFilter,
    magFilter: opts.filter ?? THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
  rt.texture.name = opts.name || 'ldr';
  return rt;
}

export function disposeTarget(rt) {
  if (!rt) return;
  rt.depthTexture?.dispose?.();
  rt.dispose();
}

export { _triangle as FULLSCREEN_GEOMETRY };
