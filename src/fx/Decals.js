/**
 * Decals — buracos de bala e manchas PROJETADOS na geometria. Dono: FX.
 *
 * Nada de quad flutuante colado na normal: cada decal e uma caixa orientada que
 * RECORTA os triangulos do mundo (Sutherland-Hodgman contra os 6 planos da
 * caixa). O resultado acompanha quina, degrau e batente — se a bala pega o canto
 * de um muro, o buraco dobra junto com o canto.
 *
 * A fonte de triangulos e a malha de colisao do WORLD (`ctx.world.collision`),
 * que ja esta em espaco de mundo e ja tem BVH pronto (`shapecast` com a caixa do
 * decal e O(log n)). Ela e simplificada em relacao a visual, mas em alvenaria —
 * que e 95% do mapa — coincide. Sem colisao disponivel, cai para um quad
 * orientado pela normal do impacto.
 *
 * Pool CIRCULAR de `settings.q.decalBudget` slots num UNICO BufferGeometry
 * (1 draw call). Cada slot tem orcamento fixo de vertices; slot livre fica com
 * triangulos degenerados, que custam zero na rasterizacao. O envelhecimento e
 * feito no vertex shader (atributo `aVida` + uniform de tempo), entao um decal
 * apagando nao gasta CPU nenhuma.
 */
import * as THREE from 'three';

/** Ladrilhos do atlas de decals (grade 4x2). */
export const DECAL = {
  CONCRETO: 0,
  TIJOLO: 1,
  METAL: 2,
  MADEIRA: 3,
  VIDRO: 4,
  TERRA: 5,
  SANGUE: 6,
  FULIGEM: 7,
};

const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
const VERTS_POR_DECAL = 60;      // 20 triangulos: suficiente para quina dupla

/* ------------------------------------------------------------------------ */
/* Atlas procedural                                                          */
/* ------------------------------------------------------------------------ */

function h2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function sm(t) { return t * t * (3 - 2 * t); }
function nz(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = sm(x - xi), yf = sm(y - yi);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s);
  const c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  const t = a + (b - a) * xf;
  return t + ((c + (d - c) * xf) - t) * yf;
}
function fbm(x, y, s, oct = 4) {
  let v = 0, amp = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { v += amp * nz(x * f, y * f, s + i * 31); n += amp; amp *= 0.5; f *= 2.03; }
  return v / n;
}

function novoCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Gera 3 atlas coerentes a partir de uma unica descricao por ladrilho:
 *   albedo (RGB + alpha de recorte), normal (do campo de altura), rugosidade+metal.
 * @param {number} lado lado do ladrilho em px
 * @returns {{albedo:THREE.CanvasTexture, normal:THREE.CanvasTexture, rm:THREE.CanvasTexture}}
 */
export function criarAtlasDecals(lado = 256) {
  const W = lado * ATLAS_COLS, H = lado * ATLAS_ROWS;
  const cAlb = novoCanvas(W, H), cNor = novoCanvas(W, H), cRM = novoCanvas(W, H);
  const gAlb = cAlb.getContext('2d'), gNor = cNor.getContext('2d'), gRM = cRM.getContext('2d');
  for (const g of [gAlb, gNor, gRM]) { g.clearRect(0, 0, W, H); }

  const n = lado | 0;
  const imgA = gAlb.createImageData(n, n);
  const imgN = gNor.createImageData(n, n);
  const imgR = gRM.createImageData(n, n);
  const altura = new Float32Array(n * n);

  /**
   * @param {number} idx ladrilho
   * @param {(nx:number,ny:number)=>[number,number,number,number,number,number,number]}
   *        f -> [r,g,b,a, altura, rugosidade, metal] (0..1; altura em -1..1)
   */
  const pinta = (idx, f) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const nx = (x + 0.5) / n * 2 - 1;
        const ny = (y + 0.5) / n * 2 - 1;
        const o = (y * n + x) * 4;
        const c = f(nx, ny);
        imgA.data[o] = c[0] * 255; imgA.data[o + 1] = c[1] * 255;
        imgA.data[o + 2] = c[2] * 255; imgA.data[o + 3] = Math.max(0, Math.min(1, c[3])) * 255;
        altura[y * n + x] = c[4];
        imgR.data[o] = 255; imgR.data[o + 1] = c[5] * 255; imgR.data[o + 2] = c[6] * 255; imgR.data[o + 3] = 255;
      }
    }
    // normal a partir do gradiente de altura (Sobel simples)
    const forca = 2.6;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const xm = Math.max(0, x - 1), xp = Math.min(n - 1, x + 1);
        const ym = Math.max(0, y - 1), yp = Math.min(n - 1, y + 1);
        const dx = (altura[y * n + xp] - altura[y * n + xm]) * forca;
        const dy = (altura[yp * n + x] - altura[ym * n + x]) * forca;
        let vx = -dx, vy = dy, vz = 1;   // +Y do normal map aponta pra cima
        const inv = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
        const o = (y * n + x) * 4;
        imgN.data[o] = (vx * inv * 0.5 + 0.5) * 255;
        imgN.data[o + 1] = (vy * inv * 0.5 + 0.5) * 255;
        imgN.data[o + 2] = (vz * inv * 0.5 + 0.5) * 255;
        imgN.data[o + 3] = 255;
      }
    }
    const px = (idx % ATLAS_COLS) * n, py = Math.floor(idx / ATLAS_COLS) * n;
    gAlb.putImageData(imgA, px, py);
    gNor.putImageData(imgN, px, py);
    gRM.putImageData(imgR, px, py);
  };

  const raio = (x, y) => Math.sqrt(x * x + y * y);

  /**
   * Buraco generico: cratera central + halo de po + trincas radiais.
   * @param {object} o parametros do material atingido
   */
  const buraco = (o) => (nx, ny) => {
    const r0 = raio(nx, ny);
    const ang = Math.atan2(ny, nx);
    // borda irregular
    const irr = 0.82 + 0.36 * fbm((nx + 1.3) * o.freq, (ny + 1.3) * o.freq, o.semente, 4);
    const r = r0 / irr;

    if (r > 0.98) return [0, 0, 0, 0, 0, 0.9, 0];

    // buraco propriamente dito
    const dentro = Math.max(0, 1 - r / o.rBuraco);
    const cratera = Math.pow(dentro, 0.55);
    // trincas radiais
    let trinca = 0;
    if (o.trincas > 0) {
      const t = Math.abs(Math.sin(ang * o.trincas + fbm(nx * 3, ny * 3, o.semente + 5, 3) * 6.0));
      trinca = Math.pow(Math.max(0, 1 - t), 26) * Math.max(0, 1 - Math.abs(r - 0.55) * 1.5) * o.trincaGanho;
    }
    // halo de po / estilhaco em volta
    const halo = Math.pow(Math.max(0, 1 - Math.abs(r - o.rHalo) / o.wHalo), 1.6)
      * (0.35 + 0.65 * fbm((nx + 2.1) * o.freq * 2.2, (ny + 2.1) * o.freq * 2.2, o.semente + 17, 4));

    let a = Math.min(1, cratera * 1.5 + trinca + halo * o.haloAlpha);
    a *= Math.min(1, (0.98 - r) * 6);
    if (a <= 0.004) return [0, 0, 0, 0, 0, 0.9, 0];

    // cor: fundo do buraco escuro, halo com a cor do po do material
    const mix = Math.min(1, cratera * 1.35);
    const rr = o.poeira[0] * (1 - mix) + o.fundo[0] * mix + trinca * o.trincaCor[0];
    const gg = o.poeira[1] * (1 - mix) + o.fundo[1] * mix + trinca * o.trincaCor[1];
    const bb = o.poeira[2] * (1 - mix) + o.fundo[2] * mix + trinca * o.trincaCor[2];

    const alt = -cratera * o.prof + halo * 0.25;
    const rug = o.rug0 * (1 - mix) + o.rug1 * mix;
    return [rr, gg, bb, a, alt, rug, o.metal * mix];
  };

  pinta(DECAL.CONCRETO, buraco({
    semente: 7, freq: 5.5, rBuraco: 0.34, rHalo: 0.62, wHalo: 0.44, haloAlpha: 0.55,
    trincas: 5, trincaGanho: 0.5, trincaCor: [0.05, 0.05, 0.05],
    fundo: [0.045, 0.043, 0.042], poeira: [0.78, 0.76, 0.72],
    prof: 1.0, rug0: 0.95, rug1: 0.8, metal: 0,
  }));
  pinta(DECAL.TIJOLO, buraco({
    semente: 23, freq: 4.2, rBuraco: 0.38, rHalo: 0.66, wHalo: 0.4, haloAlpha: 0.68,
    trincas: 3, trincaGanho: 0.35, trincaCor: [0.1, 0.05, 0.03],
    fundo: [0.06, 0.03, 0.022], poeira: [0.76, 0.42, 0.29],
    prof: 1.0, rug0: 0.93, rug1: 0.85, metal: 0,
  }));
  pinta(DECAL.METAL, buraco({
    semente: 41, freq: 7.5, rBuraco: 0.26, rHalo: 0.44, wHalo: 0.3, haloAlpha: 0.9,
    trincas: 8, trincaGanho: 0.75, trincaCor: [0.55, 0.52, 0.46],
    fundo: [0.02, 0.02, 0.022], poeira: [0.72, 0.7, 0.66],
    prof: 0.7, rug0: 0.26, rug1: 0.45, metal: 0.9,
  }));
  pinta(DECAL.MADEIRA, buraco({
    semente: 61, freq: 3.0, rBuraco: 0.3, rHalo: 0.6, wHalo: 0.5, haloAlpha: 0.5,
    trincas: 2, trincaGanho: 0.55, trincaCor: [0.32, 0.22, 0.12],
    fundo: [0.05, 0.033, 0.02], poeira: [0.55, 0.4, 0.24],
    prof: 0.9, rug0: 0.9, rug1: 0.86, metal: 0,
  }));

  // --- vidro: teia de trincas concentricas + radiais ----------------------
  pinta(DECAL.VIDRO, (nx, ny) => {
    const r = raio(nx, ny);
    if (r > 0.97) return [0, 0, 0, 0, 0, 0.1, 0];
    let ang = Math.atan2(ny, nx);
    const jit = fbm(nx * 4, ny * 4, 99, 3) * 0.55;
    // radiais
    const nRad = 11;
    const tr = Math.abs(Math.sin((ang + jit) * nRad * 0.5));
    const radial = Math.pow(Math.max(0, 1 - tr), 40);
    // concentricas (aneis irregulares)
    const rr = r * (1 + jit * 0.35);
    const anel = Math.pow(Math.abs(Math.sin(rr * 13.0)), 22) * Math.min(1, r * 3.5);
    const nucleo = Math.pow(Math.max(0, 1 - r / 0.16), 0.6);
    let a = Math.min(1, radial * (1 - r * 0.55) + anel * 0.85 + nucleo);
    a *= Math.min(1, (0.97 - r) * 5);
    if (a <= 0.004) return [0, 0, 0, 0, 0, 0.1, 0];
    const l = 0.88 - nucleo * 0.75;
    return [l * 0.92, l * 0.97, l, a, (radial + anel) * 0.4 - nucleo * 0.9, 0.12, 0];
  });

  // --- terra/asfalto: cratera rasa, sem trinca ----------------------------
  pinta(DECAL.TERRA, buraco({
    semente: 83, freq: 3.4, rBuraco: 0.42, rHalo: 0.7, wHalo: 0.42, haloAlpha: 0.45,
    trincas: 0, trincaGanho: 0, trincaCor: [0, 0, 0],
    fundo: [0.07, 0.055, 0.04], poeira: [0.5, 0.4, 0.3],
    prof: 0.8, rug0: 0.98, rug1: 0.95, metal: 0,
  }));

  // --- respingo de sangue na parede ---------------------------------------
  pinta(DECAL.SANGUE, (nx, ny) => {
    const r = raio(nx, ny);
    // mancha central irregular
    const f = fbm((nx + 1.5) * 3.1, (ny + 1.5) * 3.1, 151, 5);
    const rd = r / (0.30 + 0.34 * f);
    let a = Math.pow(Math.max(0, 1 - rd), 0.5);
    // gotas satelite
    for (let i = 0; i < 14; i++) {
      const ga = h2(i, 3, 11) * Math.PI * 2;
      const gr = 0.35 + h2(i, 7, 13) * 0.6;
      const gs = 0.025 + h2(i, 11, 17) * 0.07;
      const dx = nx - Math.cos(ga) * gr, dy = ny - Math.sin(ga) * gr;
      const dd = Math.sqrt(dx * dx + dy * dy * (1 + h2(i, 5, 19) * 1.4));
      a = Math.max(a, Math.pow(Math.max(0, 1 - dd / gs), 0.45));
    }
    // escorrido: rabinhos verticais saindo da mancha
    if (ny > 0) {
      const col = Math.floor((nx + 1) * 9);
      const ph = h2(col, 2, 29);
      if (ph > 0.62) {
        const larg = 0.018 + ph * 0.02;
        const cx = (col + 0.5) / 9 * 2 - 1 + (ph - 0.5) * 0.05;
        const comp = 0.35 + ph * 0.55;
        const d = Math.abs(nx - cx);
        if (d < larg && ny < comp) a = Math.max(a, (1 - d / larg) * Math.max(0, 1 - ny / comp) * 0.95);
      }
    }
    a *= Math.min(1, (0.99 - r) * 4.5);
    if (a <= 0.004) return [0, 0, 0, 0, 0, 0.5, 0];
    const dens = Math.min(1, a * 1.4);
    const v = 0.30 - dens * 0.20;
    return [v + 0.10, v * 0.20, v * 0.16, a, dens * 0.15, 0.55 - dens * 0.32, 0];
  });

  // --- fuligem / queimado --------------------------------------------------
  pinta(DECAL.FULIGEM, (nx, ny) => {
    const r = raio(nx, ny);
    const f = fbm((nx + 1.1) * 2.6, (ny + 1.1) * 2.6, 211, 5);
    const rd = r / (0.45 + 0.5 * f);
    let a = Math.pow(Math.max(0, 1 - rd), 1.1) * 0.85;
    a *= Math.min(1, (0.99 - r) * 4);
    if (a <= 0.004) return [0, 0, 0, 0, 0, 0.95, 0];
    const v = 0.035 + f * 0.05;
    return [v, v * 0.96, v * 0.92, a, 0, 0.97, 0];
  });

  const mk = (canvas, srgb, nome) => {
    const t = new THREE.CanvasTexture(canvas);
    t.name = nome;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return {
    albedo: mk(cAlb, true, 'fx.decal.albedo'),
    normal: mk(cNor, false, 'fx.decal.normal'),
    rm: mk(cRM, false, 'fx.decal.rm'),
  };
}

/* ------------------------------------------------------------------------ */
/* Projetor                                                                  */
/* ------------------------------------------------------------------------ */

const _mProj = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _escala = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _caixa = new THREE.Box3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

// buffers do recorte (poligono convexo cresce ate ~3 + 6 vertices)
const MAXP = 24;
const _polyA = new Float32Array(MAXP * 3);
const _polyB = new Float32Array(MAXP * 3);
const _tri9 = new Float32Array(9);

/** Recorta o poligono `src` (nSrc vertices) contra o plano eixo=+-0.5. */
function recorta(src, nSrc, dst, eixo, sinal) {
  let nDst = 0;
  for (let i = 0; i < nSrc; i++) {
    const a = i * 3, b = ((i + 1) % nSrc) * 3;
    const da = sinal * src[a + eixo] - 0.5;
    const db = sinal * src[b + eixo] - 0.5;
    const dentroA = da <= 0, dentroB = db <= 0;
    if (dentroA) {
      if (nDst < MAXP) { dst[nDst * 3] = src[a]; dst[nDst * 3 + 1] = src[a + 1]; dst[nDst * 3 + 2] = src[a + 2]; nDst++; }
    }
    if (dentroA !== dentroB) {
      const t = da / (da - db);
      if (nDst < MAXP) {
        dst[nDst * 3] = src[a] + (src[b] - src[a]) * t;
        dst[nDst * 3 + 1] = src[a + 1] + (src[b + 1] - src[a + 1]) * t;
        dst[nDst * 3 + 2] = src[a + 2] + (src[b + 2] - src[a + 2]) * t;
        nDst++;
      }
    }
  }
  return nDst;
}

/* ------------------------------------------------------------------------ */

export class Decals {
  /** @param {object} ctx GameContext */
  constructor(ctx) {
    this.ctx = ctx;
    this.capacidade = 192;
    this.limiteUso = 128;
    this.cursor = 0;
    this.tempo = 0;
    this.vida = 24;          // segundos ate sumir
    this.mesh = null;
    this.textures = null;
    this._uTempo = { value: 0 };
    this._loSujo = Infinity;
    this._hiSujo = -Infinity;
    this.usados = 0;
  }

  async init(ladoAtlas = 256) {
    const ctx = this.ctx;
    // aloca sempre pelo teto (ultra) para nunca precisar realocar em troca de
    // preset; o preset atual so limita quantos slots do anel sao usados.
    this.capacidade = 192;
    this.limiteUso = Math.max(16, Math.min(this.capacidade, ctx.settings?.q?.decalBudget ?? 128));
    const N = this.capacidade * VERTS_POR_DECAL;

    this.textures = criarAtlasDecals(ladoAtlas);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    this.aNor = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    this.aUv = new THREE.BufferAttribute(new Float32Array(N * 2), 2);
    this.aCol = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    this.aVida = new THREE.BufferAttribute(new Float32Array(N * 2), 2);
    for (const a of [this.aPos, this.aNor, this.aUv, this.aCol, this.aVida]) a.setUsage(THREE.DynamicDrawUsage);
    this.aCol.array.fill(1);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('normal', this.aNor);
    geo.setAttribute('uv', this.aUv);
    geo.setAttribute('color', this.aCol);
    geo.setAttribute('aVida', this.aVida);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.MeshStandardMaterial({
      name: 'fx.decals',
      map: this.textures.albedo,
      normalMap: this.textures.normal,
      roughnessMap: this.textures.rm,
      metalnessMap: this.textures.rm,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.1, 1.1),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -12,
      // preserva o canal alpha do alvo HDR (0=mundo, 1=viewmodel — ver NOTES.md)
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    // IMPORTANTE (NOTES.md/CORE): o hook precisa existir ANTES de entrar na cena,
    // senao o Lighting registra o material sem preservar o nosso envelhecimento.
    const uTempo = this._uTempo;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTempo = uTempo;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aVida;
uniform float uTempo;
varying float vFade;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float t = uTempo - aVida.x;
  float L = max(aVida.y, 1e-3);
  float dentro = step(0.0, t) * step(t, L);
  // opaco ate 78% da vida, some no resto
  vFade = dentro * clamp((L - t) / (L * 0.22), 0.0, 1.0);
}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vFade;`)
        .replace('#include <alphatest_fragment>', `
  diffuseColor.a *= vFade;
  if (diffuseColor.a < 0.004) discard;
#include <alphatest_fragment>`);
    };
    mat.customProgramCacheKey = () => 'fx.decals';

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'fx.decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.material = mat;
    this.geometry = geo;
    return this;
  }

  /**
   * Coloca um decal.
   * @param {THREE.Vector3} ponto  ponto de impacto (mundo)
   * @param {THREE.Vector3} normal normal da face, apontando para fora
   * @param {number} tipo DECAL.*
   * @param {number} tamanho lado do decal em metros
   * @param {object} [o] { vida, roll, cor:THREE.Color, prof }
   */
  coloca(ponto, normal, tipo, tamanho, o = {}) {
    if (!this.mesh) return false;
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.limiteUso;

    _nrm.copy(normal);
    if (_nrm.lengthSq() < 1e-8) _nrm.set(0, 1, 0);
    _nrm.normalize();

    // base ortonormal com giro aleatorio no plano do decal
    _up.set(0, 1, 0);
    if (Math.abs(_nrm.dot(_up)) > 0.97) _up.set(1, 0, 0);
    _tan.crossVectors(_up, _nrm).normalize();
    _bit.crossVectors(_nrm, _tan).normalize();
    const roll = o.roll ?? Math.random() * Math.PI * 2;
    const cs = Math.cos(roll), sn = Math.sin(roll);
    _va.copy(_tan).multiplyScalar(cs).addScaledVector(_bit, sn);
    _vb.copy(_tan).multiplyScalar(-sn).addScaledVector(_bit, cs);
    _tan.copy(_va); _bit.copy(_vb);

    const prof = o.prof ?? Math.max(0.12, tamanho * 1.4);
    // recua um pouco a origem para dentro da parede: pega a face mesmo em
    // impacto rasante
    _pos.copy(ponto).addScaledVector(_nrm, -prof * 0.15);
    _escala.set(tamanho, tamanho, prof);

    _mProj.makeBasis(_tan, _bit, _nrm);
    _mProj.setPosition(_pos);
    _mProj.scale(_escala);
    _mInv.copy(_mProj).invert();

    const base = slot * VERTS_POR_DECAL;
    let escritos = 0;
    const P = this.aPos.array, No = this.aNor.array, U = this.aUv.array;
    const C = this.aCol.array, V = this.aVida.array;

    const col = (tipo % ATLAS_COLS), row = Math.floor(tipo / ATLAS_COLS);
    const uEsc = 1 / ATLAS_COLS, vEsc = 1 / ATLAS_ROWS;
    const cr = o.cor ? o.cor.r : 1, cg = o.cor ? o.cor.g : 1, cb = o.cor ? o.cor.b : 1;
    const vidaSeg = o.vida ?? this.vida;

    /** Emite um triangulo ja em espaco do decal. */
    const emiteTri = (ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) => {
      if (escritos + 3 > VERTS_POR_DECAL) return false;
      _tri9[0] = ax; _tri9[1] = ay; _tri9[2] = az;
      _tri9[3] = bx; _tri9[4] = by; _tri9[5] = bz;
      _tri9[6] = cx; _tri9[7] = cy; _tri9[8] = cz;
      for (let k = 0; k < 3; k++) {
        const i = base + escritos + k;
        _va.set(_tri9[k * 3], _tri9[k * 3 + 1], _tri9[k * 3 + 2]);
        // uv a partir do XY local, ANTES de voltar ao mundo
        U[i * 2] = (_va.x + 0.5) * uEsc + col * uEsc;
        U[i * 2 + 1] = (0.5 - _va.y) * vEsc + row * vEsc;
        _va.applyMatrix4(_mProj);
        _va.addScaledVector(_nrm, 0.004);      // levanta do z-fighting
        P[i * 3] = _va.x; P[i * 3 + 1] = _va.y; P[i * 3 + 2] = _va.z;
        No[i * 3] = nx; No[i * 3 + 1] = ny; No[i * 3 + 2] = nz;
        C[i * 3] = cr; C[i * 3 + 1] = cg; C[i * 3 + 2] = cb;
        V[i * 2] = this.tempo; V[i * 2 + 1] = vidaSeg;
      }
      escritos += 3;
      return true;
    };

    // --- fonte de triangulos: BVH da malha de colisao ----------------------
    const col3 = this.ctx.world?.collision;
    let projetou = false;
    if (col3?.bvh && col3.built) {
      const raioCx = Math.max(tamanho, prof) * 0.87;
      _caixa.min.set(ponto.x - raioCx, ponto.y - raioCx, ponto.z - raioCx);
      _caixa.max.set(ponto.x + raioCx, ponto.y + raioCx, ponto.z + raioCx);
      const alvo = _caixa;
      const self = this;
      let cheio = false;
      col3.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(alvo),
        intersectsTriangle: (tri) => {
          if (cheio) return true;                     // aborta a varredura
          _e1.subVectors(tri.b, tri.a);
          _e2.subVectors(tri.c, tri.a);
          _fn.crossVectors(_e1, _e2);
          if (_fn.lengthSq() < 1e-12) return false;
          _fn.normalize();
          // so faces viradas para o impacto (evita colar no verso da parede)
          if (_fn.dot(_nrm) < 0.35) return false;

          _va.copy(tri.a).applyMatrix4(_mInv);
          _vb.copy(tri.b).applyMatrix4(_mInv);
          _vc.copy(tri.c).applyMatrix4(_mInv);
          _polyA[0] = _va.x; _polyA[1] = _va.y; _polyA[2] = _va.z;
          _polyA[3] = _vb.x; _polyA[4] = _vb.y; _polyA[5] = _vb.z;
          _polyA[6] = _vc.x; _polyA[7] = _vc.y; _polyA[8] = _vc.z;

          let n = 3, src = _polyA, dst = _polyB;
          for (let eixo = 0; eixo < 3 && n >= 3; eixo++) {
            for (let s = 0; s < 2 && n >= 3; s++) {
              n = recorta(src, n, dst, eixo, s === 0 ? 1 : -1);
              const t = src; src = dst; dst = t;
            }
          }
          if (n < 3) return false;
          for (let i = 1; i < n - 1; i++) {
            if (!emiteTri(
              src[0], src[1], src[2],
              src[i * 3], src[i * 3 + 1], src[i * 3 + 2],
              src[(i + 1) * 3], src[(i + 1) * 3 + 1], src[(i + 1) * 3 + 2],
              _fn.x, _fn.y, _fn.z)) { cheio = true; break; }
          }
          projetou = true;
          void self;
          return false;
        },
      });
    }

    // --- fallback: quad orientado (sem mundo carregado / triangulo fora) ---
    if (!projetou || escritos === 0) {
      escritos = 0;
      emiteTri(-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, _nrm.x, _nrm.y, _nrm.z);
      emiteTri(-0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, _nrm.x, _nrm.y, _nrm.z);
    }

    // degenera o resto do slot
    for (let i = escritos; i < VERTS_POR_DECAL; i++) {
      const k = base + i;
      P[k * 3] = P[k * 3 + 1] = P[k * 3 + 2] = 0;
      V[k * 2] = -1e6; V[k * 2 + 1] = 0.001;
    }

    if (slot < this._loSujo) this._loSujo = slot;
    if (slot > this._hiSujo) this._hiSujo = slot;
    this.usados = Math.min(this.capacidade, this.usados + 1);
    return true;
  }

  /** Envia so os slots tocados neste frame. */
  update(dt) {
    this.tempo += dt;
    this._uTempo.value = this.tempo;
    if (this._loSujo > this._hiSujo) return;
    const v0 = this._loSujo * VERTS_POR_DECAL;
    const nv = (this._hiSujo - this._loSujo + 1) * VERTS_POR_DECAL;
    for (const a of [this.aPos, this.aNor, this.aUv, this.aCol, this.aVida]) {
      a.clearUpdateRanges();
      a.addUpdateRange(v0 * a.itemSize, nv * a.itemSize);
      a.needsUpdate = true;
    }
    this._loSujo = Infinity; this._hiSujo = -Infinity;
  }

  limpa() {
    this.aVida.array.fill(-1e6);
    for (let i = 1; i < this.aVida.array.length; i += 2) this.aVida.array[i] = 0.001;
    this.aVida.clearUpdateRanges();
    this.aVida.needsUpdate = true;
    this.cursor = 0; this.usados = 0;
  }

  setQuality(preset) {
    // Trocar a capacidade exigiria realocar o buffer; mantemos a maior alocacao
    // ja feita e apenas limitamos o uso (o pool e circular, entao basta ciclar
    // antes do fim).
    const alvo = Math.max(16, preset?.decalBudget ?? this.capacidade);
    this.limiteUso = Math.min(this.capacidade, alvo);
    if (this.cursor >= this.limiteUso) this.cursor = 0;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    if (this.textures) for (const t of Object.values(this.textures)) t.dispose();
  }
}
