/**
 * Particles — sistema de particulas do jogo. Dono: FX.
 *
 * Tres subsistemas, todos com budget FIXO e pool circular (zero alocacao no
 * caminho quente — nenhum `new` acontece dentro de emit/update):
 *
 *   1. PoolParticulas  — quads billboard em InstancedMesh, simulados 100% no
 *      VERTEX SHADER por solucao analitica de `dv/dt = -k*v + g`. A CPU so
 *      escreve as condicoes iniciais de cada instancia uma unica vez, no
 *      instante do disparo. Custo por frame = 1 draw call e zero JS.
 *   2. PoolDestrocos   — fragmentos solidos (lascas de tijolo, cacos, terra)
 *      com fisica na CPU: gravidade, arrasto, rotacao e QUIQUE no chao.
 *   3. PoolCartuchos   — estojos ejetados. Mesma fisica, mas com geometria de
 *      casquilho, brilho metalico e callback de som a cada quique.
 *
 * O plano do chao para o quique vem de UM raycast por rajada (nao por particula
 * por frame): quem emite pergunta a altura do chao logo abaixo do impacto e
 * passa esse `floorY` adiante. Erra em degrau, acerta em 95% dos casos e custa
 * ~1/1000 do que custaria colidir de verdade.
 *
 * Soft particles: o fragment compara a profundidade linear da particula com a
 * profundidade da CENA (copia de meia resolucao feita pelo FXManager) e apaga a
 * borda. Sem isso a particula corta a parede numa linha reta — o denunciador
 * classico de amadorismo.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------------ */
/* Atlas procedural                                                          */
/* ------------------------------------------------------------------------ */

/** Indices de quadro no atlas 4x4. */
export const PT = {
  FUMACA: 0,      // pluma macia, nucleada
  FUMACA2: 1,     // variacao mais densa
  WISP: 2,        // fiapo alongado (fumaca de cano)
  POEIRA: 3,      // poeira granulada
  FAISCA: 4,      // risco quente com nucleo
  GLOW: 5,        // gaussiana pura (nucleo de luz)
  FLASH_A: 6,     // estrela irregular, quadro 1
  FLASH_B: 7,     // estrela irregular, quadro 2
  ANEL: 8,        // anel de choque
  SANGUE: 9,      // gota de sangue
  NEVOA: 10,      // nevoa muito suave (sangue/vapor)
  FRAGMENTO: 11,  // lasca irregular opaca
  VIDRO: 12,      // caco pontiagudo, borda brilhante
  GOTA: 13,       // gota d'agua com rebordo claro
  FOLHA: 14,      // silhueta de folha
  RISCO: 15,      // risco fino (trilha de faisca)
};

const ATLAS_COLS = 4;

/* --- ruido de valor, so usado na geracao do atlas (init) --- */
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function suave(t) { return t * t * (3 - 2 * t); }
function ruido(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = suave(x - xi), yf = suave(y - yi);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return (a + (b - a) * xf) + ((c + (d - c) * xf) - (a + (b - a) * xf)) * yf;
}
function fbm(x, y, s, oct = 4, gain = 0.5, lac = 2.07) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * ruido(x * f, y * f, s + i * 37);
    norm += amp; amp *= gain; f *= lac;
  }
  return v / norm;
}

/**
 * Gera o atlas 4x4 de particulas em canvas. RGB = cor base (quase sempre
 * branco/cinza; a cor real vem por instancia), A = mascara.
 * O conteudo fica dentro de ~88% do ladrilho para o mip nao sangrar vizinho.
 * @param {number} tam lado do atlas em pixels (512 ou 256)
 * @returns {THREE.CanvasTexture}
 */
export function criarAtlasParticulas(tam = 512) {
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(tam, tam)
    : Object.assign(document.createElement('canvas'), { width: tam, height: tam });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, tam, tam);

  const T = tam / ATLAS_COLS;              // lado do ladrilho
  const img = g.createImageData(T | 0, T | 0);
  const px = img.data;

  const PADRAO = 0.88;                     // fracao util do ladrilho

  /** Preenche o ladrilho `idx` com f(nx, ny) -> [r,g,b,a] em 0..1. nx,ny em -1..1. */
  const pinta = (idx, f) => {
    const n = T | 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const nx = ((x + 0.5) / n * 2 - 1) / PADRAO;
        const ny = ((y + 0.5) / n * 2 - 1) / PADRAO;
        const o = (y * n + x) * 4;
        if (nx * nx + ny * ny > 2.25) { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0; continue; }
        const c = f(nx, ny, x, y, n);
        px[o] = Math.max(0, Math.min(255, c[0] * 255)) | 0;
        px[o + 1] = Math.max(0, Math.min(255, c[1] * 255)) | 0;
        px[o + 2] = Math.max(0, Math.min(255, c[2] * 255)) | 0;
        px[o + 3] = Math.max(0, Math.min(255, c[3] * 255)) | 0;
      }
    }
    g.putImageData(img, (idx % ATLAS_COLS) * T, Math.floor(idx / ATLAS_COLS) * T);
  };

  const raio = (nx, ny) => Math.sqrt(nx * nx + ny * ny);

  // --- fumaca macia: gaussiana modulada por fbm, com nucleo mais escuro ----
  const pluma = (semente, densidade, contraste) => (nx, ny) => {
    const r = raio(nx, ny);
    const f = fbm((nx + 1.6) * 2.4, (ny + 1.6) * 2.4, semente, 5, 0.55);
    // deforma o raio pelo ruido: da a borda "estufada" de nuvem
    const rd = r * (0.72 + 0.62 * f);
    let a = Math.max(0, 1 - rd);
    a = Math.pow(a, contraste) * densidade;
    // sombreamento interno: o topo-esquerda recebe luz, o resto adensa
    const som = 0.62 + 0.38 * fbm((nx + 2.2) * 3.6, (ny + 2.2) * 3.6, semente + 91, 3);
    return [som, som, som, a];
  };

  pinta(PT.FUMACA, pluma(11, 1.0, 1.35));
  pinta(PT.FUMACA2, pluma(57, 1.0, 0.95));

  // --- fiapo alongado (fumaca de cano subindo) -----------------------------
  pinta(PT.WISP, (nx, ny) => {
    const f = fbm((nx + 1.5) * 3.2, (ny + 1.5) * 1.5, 203, 5, 0.58);
    const rd = Math.sqrt(nx * nx * 1.9 + ny * ny * 0.55) * (0.7 + 0.7 * f);
    const a = Math.pow(Math.max(0, 1 - rd), 1.5) * 0.95;
    const som = 0.66 + 0.34 * f;
    return [som, som, som, a];
  });

  // --- poeira: granulada, borda irregular, alpha baixo ---------------------
  pinta(PT.POEIRA, (nx, ny) => {
    const r = raio(nx, ny);
    const f = fbm((nx + 1.4) * 4.6, (ny + 1.4) * 4.6, 707, 5, 0.6);
    const gr = ruido((nx + 1.4) * 26, (ny + 1.4) * 26, 33);
    const rd = r * (0.66 + 0.8 * f);
    let a = Math.pow(Math.max(0, 1 - rd), 1.15);
    a *= 0.55 + 0.45 * gr;
    const som = 0.7 + 0.3 * f;
    return [som, som, som, a];
  });

  // --- faisca: nucleo branco quente com halo curto -------------------------
  pinta(PT.FAISCA, (nx, ny) => {
    const r = Math.sqrt(nx * nx * 3.4 + ny * ny * 0.9);
    const nucleo = Math.exp(-r * r * 7.0);
    const halo = Math.exp(-r * r * 1.2) * 0.55;
    const a = Math.min(1, nucleo + halo);
    const q = Math.min(1, nucleo * 1.6 + 0.25);
    return [1, q * 0.92 + 0.08, q * 0.6, a];
  });

  // --- glow: gaussiana pura ------------------------------------------------
  pinta(PT.GLOW, (nx, ny) => {
    const r = raio(nx, ny);
    const a = Math.exp(-r * r * 3.4);
    return [1, 1, 1, a];
  });

  // --- flash em estrela irregular (2 quadros) ------------------------------
  const estrela = (semente, pontas) => {
    // comprimento aleatorio por ponta, congelado: da o desenho irregular
    const comp = [];
    for (let i = 0; i < pontas; i++) comp.push(0.35 + hash2(i, semente, 5) * 0.95);
    return (nx, ny) => {
      const r = raio(nx, ny);
      let th = Math.atan2(ny, nx);
      if (th < 0) th += Math.PI * 2;
      const k = th / (Math.PI * 2) * pontas;
      const i0 = Math.floor(k) % pontas;
      const i1 = (i0 + 1) % pontas;
      const t = suave(k - Math.floor(k));
      const lp = comp[i0] * (1 - t) + comp[i1] * t;
      // perfil da ponta: cai rapido, mas o nucleo e' um disco quente
      const braco = Math.max(0, 1 - r / (lp * 1.05));
      const nucleo = Math.exp(-r * r * 16.0);
      let a = Math.pow(braco, 2.2) * 0.85 + nucleo;
      a = Math.min(1, a);
      // cor: nucleo branco-azulado -> bordas laranja
      const quente = Math.min(1, nucleo * 2.0 + 0.15);
      return [1, 0.72 + quente * 0.28, 0.34 + quente * 0.6, a];
    };
  };
  pinta(PT.FLASH_A, estrela(3, 6));
  pinta(PT.FLASH_B, estrela(19, 9));

  // --- anel de choque ------------------------------------------------------
  pinta(PT.ANEL, (nx, ny) => {
    const r = raio(nx, ny);
    const d = Math.abs(r - 0.78);
    const a = Math.exp(-d * d * 150) * (0.55 + 0.45 * ruido(Math.atan2(ny, nx) * 6, 0, 12));
    return [1, 0.95, 0.85, a];
  });

  // --- gota de sangue: nucleo denso, borda irregular ----------------------
  pinta(PT.SANGUE, (nx, ny) => {
    const f = fbm((nx + 1.3) * 4.0, (ny + 1.3) * 4.0, 421, 4, 0.5);
    const rd = raio(nx, ny) * (0.78 + 0.5 * f);
    const a = Math.pow(Math.max(0, 1 - rd), 0.75);
    // rebordo mais escuro (sangue absorve luz nas bordas finas)
    const esc = 0.55 + 0.45 * Math.min(1, (1 - rd) * 2.2);
    return [esc, esc * 0.42, esc * 0.36, a];
  });

  // --- nevoa: gaussiana larguissima e fraca --------------------------------
  pinta(PT.NEVOA, (nx, ny) => {
    const r = raio(nx, ny);
    const f = fbm((nx + 1.2) * 2.0, (ny + 1.2) * 2.0, 88, 3, 0.5);
    const a = Math.exp(-r * r * 2.1) * (0.45 + 0.55 * f);
    return [1, 1, 1, a];
  });

  // --- lasca opaca: poligono irregular com quina viva ---------------------
  const lasca = (semente, brilhoBorda, cor) => {
    const lados = 5 + (Math.floor(hash2(semente, 3, 7) * 3));
    const raios = [];
    for (let i = 0; i < lados; i++) raios.push(0.45 + hash2(i, semente, 2) * 0.55);
    return (nx, ny) => {
      const r = raio(nx, ny);
      let th = Math.atan2(ny, nx); if (th < 0) th += Math.PI * 2;
      const k = th / (Math.PI * 2) * lados;
      const i0 = Math.floor(k) % lados, i1 = (i0 + 1) % lados;
      const t = k - Math.floor(k);
      const lp = raios[i0] * (1 - t) + raios[i1] * t;   // interp linear = quina viva
      const d = lp - r;
      const a = d > 0 ? Math.min(1, d * 14) : 0;
      const borda = Math.max(0, 1 - Math.abs(d) * 6);
      const l = cor[0] + borda * brilhoBorda;
      return [l, cor[1] + borda * brilhoBorda, cor[2] + borda * brilhoBorda, a];
    };
  };
  pinta(PT.FRAGMENTO, lasca(5, 0.25, [0.72, 0.68, 0.62]));
  pinta(PT.VIDRO, lasca(23, 0.9, [0.55, 0.68, 0.74]));

  // --- gota d'agua: transparente com rebordo claro -------------------------
  pinta(PT.GOTA, (nx, ny) => {
    const r = Math.sqrt(nx * nx * 1.5 + ny * ny * 0.8);
    if (r > 1) return [0, 0, 0, 0];
    const rebordo = Math.pow(r, 4.0);
    const a = (0.22 + 0.78 * rebordo) * Math.min(1, (1 - r) * 8);
    return [0.82, 0.9, 0.95, a];
  });

  // --- folha ---------------------------------------------------------------
  pinta(PT.FOLHA, (nx, ny) => {
    // elipse pontuda nas duas extremidades
    const t = ny * 0.5 + 0.5;
    const largura = Math.sin(Math.PI * Math.max(0, Math.min(1, t))) * 0.62;
    const d = Math.abs(nx) - largura;
    if (d > 0 || t < 0 || t > 1) return [0, 0, 0, 0];
    const a = Math.min(1, -d * 16);
    const nervura = Math.exp(-nx * nx * 420);
    const v = 0.34 + 0.30 * fbm((nx + 1) * 6, (ny + 1) * 3, 66, 3) - nervura * 0.12;
    return [v * 0.75, v * 1.15, v * 0.5, a];
  });

  // --- risco fino (trilha) -------------------------------------------------
  pinta(PT.RISCO, (nx, ny) => {
    const a = Math.exp(-nx * nx * 60) * Math.max(0, 1 - Math.abs(ny)) * (0.6 + 0.4 * ruido(0, ny * 14, 9));
    return [1, 0.93, 0.78, a];
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'fx.atlasParticulas';
  tex.colorSpace = THREE.NoColorSpace;   // mascara linear, nao albedo sRGB
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ */
/* Shaders                                                                   */
/* ------------------------------------------------------------------------ */

const VERT = /* glsl */`
precision highp float;

attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iA;    // birth, life, drag, gravidade
attribute vec4 iB;    // tam0, tam1, rot0, rotVel
attribute vec4 iCol;  // rgb, alpha
attribute vec4 iC;    // atlas, fadeIn, fadeOutPow, stretch
attribute vec2 iD;    // turbulencia, semente

uniform float uTime;
uniform float uEscala;      // multiplicador global de tamanho

varying vec2 vUv;
varying vec4 vCor;
varying float vEyeZ;

vec3 turbulencia(vec3 p, float t, float s) {
  float a = p.x * 0.75 + t * 0.55 + s * 6.283;
  float b = p.y * 0.62 - t * 0.40 + s * 3.117;
  float c = p.z * 0.83 + t * 0.47 + s * 1.733;
  return vec3(sin(b) * cos(c), sin(c) * cos(a) * 0.5 + 0.35, sin(a) * cos(b));
}

void main() {
  float t = uTime - iA.x;
  float vida = iA.y;

  // fora da janela de vida: degenera o triangulo (custo zero de rasterizacao)
  if (t < 0.0 || t >= vida || vida <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0); vCor = vec4(0.0); vEyeZ = 0.0;
    return;
  }

  float u = t / vida;

  // --- integracao analitica de dv/dt = -k v + g ---------------------------
  float k = max(iA.z, 0.05);
  vec3 g = vec3(0.0, -9.81 * iA.w, 0.0);
  vec3 gk = g / k;
  float e = exp(-k * t);
  vec3 vel = (iVel - gk) * e + gk;
  vec3 pos = iPos + (iVel - gk) * (1.0 - e) / k + gk * t;

  if (iD.x > 0.0) pos += turbulencia(pos, t, iD.y) * (iD.x * t);

  // --- billboard -----------------------------------------------------------
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float tam = mix(iB.x, iB.y, u) * uEscala;
  vec2 canto = position.xy;

  if (iC.w > 0.0) {
    // alinhado a velocidade: estica no eixo do movimento (faisca, tracante)
    vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    vec2 d = vv.xy;
    float ld = length(d);
    d = ld > 1e-4 ? d / ld : vec2(0.0, 1.0);
    float comp = tam * (1.0 + ld * iC.w);
    mv.xy += d * (canto.y * comp) + vec2(-d.y, d.x) * (canto.x * tam);
  } else {
    float rot = iB.z + iB.w * t;
    float cs = cos(rot), sn = sin(rot);
    mv.xy += vec2(canto.x * cs - canto.y * sn, canto.x * sn + canto.y * cs) * tam;
  }

  vEyeZ = -mv.z;
  gl_Position = projectionMatrix * mv;

  // --- uv no atlas ---------------------------------------------------------
  float idx = iC.x;
  float col = mod(idx, ${ATLAS_COLS}.0);
  float row = floor(idx / ${ATLAS_COLS}.0);
  vUv = (uv * 0.995 + 0.0025 + vec2(col, row)) / ${ATLAS_COLS}.0;

  // --- envelope de alpha ---------------------------------------------------
  float aIn = smoothstep(0.0, max(iC.y, 1e-4), u);
  float aOut = pow(max(1.0 - u, 0.0), max(iC.z, 0.05));
  vCor = vec4(iCol.rgb, iCol.a * aIn * aOut);
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uProfundidade;
uniform vec2 uInvRes;
uniform float uSoft;         // 0 = sem depth valido
uniform float uSoftDist;     // metros de transicao
uniform float uNearFade;     // apaga o que encosta na camera
uniform vec3 uFogCor;
uniform vec2 uFog;           // near, far  (x<0 => sem fog)
uniform float uFogDens;      // >0 => exp2

varying vec2 vUv;
varying vec4 vCor;
varying float vEyeZ;

void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vCor.a;
  if (a <= 0.002) discard;

  vec3 cor = vCor.rgb * tex.rgb;

  // soft particles: apaga contra a geometria da cena
  if (uSoft > 0.5) {
    float cena = texture2D(uProfundidade, gl_FragCoord.xy * uInvRes).r;
    a *= clamp((cena - vEyeZ) / uSoftDist, 0.0, 1.0);
  }
  // e contra o proprio plano de corte da camera
  a *= clamp((vEyeZ - uNearFade) * 6.0, 0.0, 1.0);

  // neblina (o ShaderMaterial nao herda o fog da cena)
  float f = 1.0;
  if (uFogDens > 0.0) {
    f = exp(-uFogDens * uFogDens * vEyeZ * vEyeZ);
  } else if (uFog.x >= 0.0) {
    f = 1.0 - smoothstep(uFog.x, uFog.y, vEyeZ);
  }
  f = clamp(f, 0.0, 1.0);

  #ifdef ADITIVO
    cor *= f;
    gl_FragColor = vec4(cor * a, 0.0);
  #else
    cor = mix(uFogCor, cor, f);
    gl_FragColor = vec4(cor * a, a);
  #endif
}
`;

/* ------------------------------------------------------------------------ */
/* Pool GPU                                                                  */
/* ------------------------------------------------------------------------ */

const _cor = new THREE.Color();
const _cor2 = new THREE.Color();
const _v = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();

/** rng barato e deterministico o suficiente para efeito visual */
let _semente = 0x9e3779b9 >>> 0;
function rnd() {
  _semente ^= _semente << 13; _semente >>>= 0;
  _semente ^= _semente >>> 17;
  _semente ^= _semente << 5; _semente >>>= 0;
  return _semente / 4294967296;
}
function faixa(a, b) { return a + (b - a) * rnd(); }
/** Le `v` como numero fixo ou par [min,max]. */
function val(v, d = 0) {
  if (v === undefined || v === null) return d;
  return Array.isArray(v) ? faixa(v[0], v[1]) : v;
}

export class PoolParticulas {
  /**
   * @param {number} capacidade numero maximo de particulas vivas
   * @param {THREE.Texture} atlas
   * @param {{aditivo?:boolean, nome?:string, ordem?:number}} opts
   */
  constructor(capacidade, atlas, opts = {}) {
    this.capacidade = Math.max(16, capacidade | 0);
    this.aditivo = !!opts.aditivo;
    this.cursor = 0;
    this.vivas = 0;
    this._loSujo = Infinity;
    this._hiSujo = -Infinity;
    this._tempo = 0;
    /** birth+life de cada slot, para contar vivas sem ler a GPU */
    this._fim = new Float32Array(this.capacidade);

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    geo.instanceCount = this.capacidade;
    // nunca culla: o billboard pode estar em qualquer lugar do mundo
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    quad.dispose();

    const N = this.capacidade;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2);
    this._attrs = [this.aPos, this.aVel, this.aA, this.aB, this.aCol, this.aC, this.aD];
    for (const a of this._attrs) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iA', this.aA);
    geo.setAttribute('iB', this.aB);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iC', this.aC);
    geo.setAttribute('iD', this.aD);

    this.uniforms = {
      uTime: { value: 0 },
      uEscala: { value: 1 },
      uAtlas: { value: atlas },
      uProfundidade: { value: null },
      uInvRes: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uSoft: { value: 0 },
      uSoftDist: { value: 0.35 },
      uNearFade: { value: 0.12 },
      uFogCor: { value: new THREE.Color(0, 0, 0) },
      uFog: { value: new THREE.Vector2(-1, -1) },
      uFogDens: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      name: opts.nome || 'fx.particulas',
      uniforms: this.uniforms,
      defines: this.aditivo ? { ADITIVO: '' } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      lights: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      // aditivo escreve alpha 0 no shader, entao OneMinusSrcAlpha vira "One"
      blendDst: this.aditivo ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      // NAO tocar no canal alpha do alvo HDR: 0=mundo / 1=viewmodel (ver NOTES)
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = opts.nome || 'fx.particulas';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.ordem ?? (this.aditivo ? 12 : 10);
    this.mesh.matrixAutoUpdate = false;
    this.material = mat;
    this.geometry = geo;
  }

  /** Escreve uma particula no proximo slot do anel. Zero alocacao. */
  _escreve(px, py, pz, vx, vy, vz, vida, drag, grav, t0, t1, rot, rotV,
    r, g, b, alpha, atlas, fadeIn, fadeOut, stretch, turb) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacidade;

    let o = i * 3;
    this.aPos.array[o] = px; this.aPos.array[o + 1] = py; this.aPos.array[o + 2] = pz;
    this.aVel.array[o] = vx; this.aVel.array[o + 1] = vy; this.aVel.array[o + 2] = vz;
    o = i * 4;
    const A = this.aA.array; A[o] = this._tempo; A[o + 1] = vida; A[o + 2] = drag; A[o + 3] = grav;
    const B = this.aB.array; B[o] = t0; B[o + 1] = t1; B[o + 2] = rot; B[o + 3] = rotV;
    const C = this.aCol.array; C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = alpha;
    const D = this.aC.array; D[o] = atlas; D[o + 1] = fadeIn; D[o + 2] = fadeOut; D[o + 3] = stretch;
    o = i * 2;
    this.aD.array[o] = turb; this.aD.array[o + 1] = rnd();

    this._fim[i] = this._tempo + vida;
    if (i < this._loSujo) this._loSujo = i;
    if (i > this._hiSujo) this._hiSujo = i;
  }

  /**
   * Emite uma rajada a partir de uma receita.
   * @param {object} s receita (ver EFEITOS em Impacts.js)
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} dir direcao principal (normalizada)
   * @param {number} mult multiplicador de quantidade/intensidade
   */
  emite(s, pos, dir, mult = 1) {
    let n = Math.round(val(s.count, 1) * mult);
    if (n <= 0) return;
    if (n > this.capacidade) n = this.capacidade;

    const espalha = s.spread ?? 0.4;
    const upBias = s.upBias ?? 0;
    const jit = s.jitter ?? 0;
    const c0 = s.cor ?? 0xffffff;
    const c1 = s.cor2 ?? c0;

    for (let k = 0; k < n; k++) {
      // direcao em cone: gera vetor aleatorio e mistura com `dir`
      _v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
      _v.normalize();
      _u.copy(dir).addScaledVector(_v, espalha);
      _u.y += upBias;
      if (_u.lengthSq() < 1e-8) _u.copy(dir);
      _u.normalize();

      const sp = val(s.speed, 1);
      _w.copy(pos).addScaledVector(_v, jit);
      if (s.offset) _w.addScaledVector(dir, val(s.offset, 0));

      _cor.setHex(c0, THREE.SRGBColorSpace);
      if (c1 !== c0) {
        _cor2.setHex(c1, THREE.SRGBColorSpace);
        _cor.lerp(_cor2, rnd());
      }
      const ganho = val(s.brilho, 1);

      const atlas = Array.isArray(s.atlas)
        ? s.atlas[(rnd() * s.atlas.length) | 0]
        : s.atlas;

      this._escreve(
        _w.x, _w.y, _w.z,
        _u.x * sp + val(s.velExtraX, 0),
        _u.y * sp + val(s.velExtraY, 0),
        _u.z * sp + val(s.velExtraZ, 0),
        val(s.life, 1), val(s.drag, 1), val(s.grav, 0),
        val(s.tam0, 0.2), val(s.tam1, 0.4),
        val(s.rot, [-3.14, 3.14]), val(s.rotVel, [-1, 1]),
        _cor.r * ganho, _cor.g * ganho, _cor.b * ganho, val(s.alpha, 1),
        atlas, s.fadeIn ?? 0.08, s.fadeOut ?? 1.2, s.stretch ?? 0, s.turb ?? 0,
      );
    }
  }

  /** Emissao unitaria com controle total (usada pelo muzzle flash). */
  emiteUm(pos, vel, opts) {
    _cor.setHex(opts.cor ?? 0xffffff, THREE.SRGBColorSpace);
    const ganho = opts.brilho ?? 1;
    this._escreve(
      pos.x, pos.y, pos.z, vel.x, vel.y, vel.z,
      opts.life ?? 0.3, opts.drag ?? 2, opts.grav ?? 0,
      opts.tam0 ?? 0.3, opts.tam1 ?? 0.3,
      opts.rot ?? 0, opts.rotVel ?? 0,
      _cor.r * ganho, _cor.g * ganho, _cor.b * ganho, opts.alpha ?? 1,
      opts.atlas ?? PT.GLOW, opts.fadeIn ?? 0.02, opts.fadeOut ?? 1.0,
      opts.stretch ?? 0, opts.turb ?? 0,
    );
  }

  /** Envia a GPU so o intervalo escrito neste frame. */
  flush(tempo) {
    this._tempo = tempo;
    this.uniforms.uTime.value = tempo;
    if (this._loSujo > this._hiSujo) return;
    const lo = this._loSujo, hi = this._hiSujo;
    for (const a of this._attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize);
      a.needsUpdate = true;
    }
    this._loSujo = Infinity; this._hiSujo = -Infinity;
  }

  /** Conta particulas vivas (varredura barata sobre Float32Array). */
  conta(tempo) {
    let n = 0;
    const f = this._fim;
    for (let i = 0; i < f.length; i++) if (f[i] > tempo) n++;
    this.vivas = n;
    return n;
  }

  limpa() {
    this._fim.fill(0);
    this.aA.array.fill(0);
    this.aA.clearUpdateRanges();
    this.aA.needsUpdate = true;
    this.cursor = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------ */
/* Destrocos solidos com fisica na CPU                                       */
/* ------------------------------------------------------------------------ */

const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _esc = new THREE.Vector3();

/**
 * Fragmentos solidos que quicam. Usado para lascas de tijolo, cacos de vidro,
 * torroes de terra. Um InstancedMesh, uma draw call, cor por instancia.
 */
export class PoolDestrocos {
  /**
   * @param {number} capacidade
   * @param {THREE.BufferGeometry} geo geometria do fragmento (~1 m, escalada por instancia)
   * @param {THREE.Material} mat
   */
  constructor(capacidade, geo, mat) {
    this.capacidade = Math.max(8, capacidade | 0);
    const N = this.capacidade;
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.name = 'fx.destrocos';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = N;

    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.rot = new Float32Array(N * 4);     // quaternion
    this.angVel = new Float32Array(N * 3);
    this.escala = new Float32Array(N * 3);
    this.vida = new Float32Array(N);
    this.vidaMax = new Float32Array(N);
    this.chao = new Float32Array(N);
    this.restit = new Float32Array(N);
    this.ativo = new Uint8Array(N);
    this.cursor = 0;
    this.vivos = 0;

    // esconde tudo no inicio
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} vel
   * @param {number} floorY altura do chao para o quique
   * @param {object} o { life, escala:[min,max], achatado, restit, cor:THREE.Color }
   */
  gera(pos, vel, floorY, o) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacidade;
    let p = i * 3;
    this.pos[p] = pos.x; this.pos[p + 1] = pos.y; this.pos[p + 2] = pos.z;
    this.vel[p] = vel.x; this.vel[p + 1] = vel.y; this.vel[p + 2] = vel.z;
    this.angVel[p] = faixa(-18, 18);
    this.angVel[p + 1] = faixa(-18, 18);
    this.angVel[p + 2] = faixa(-18, 18);
    const s = val(o.escala, 0.03);
    this.escala[p] = s * faixa(0.7, 1.3);
    this.escala[p + 1] = s * faixa(0.7, 1.3) * (o.achatado ?? 1);
    this.escala[p + 2] = s * faixa(0.7, 1.3);
    const q = i * 4;
    _q.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    this.rot[q] = _q.x; this.rot[q + 1] = _q.y; this.rot[q + 2] = _q.z; this.rot[q + 3] = _q.w;
    this.vida[i] = this.vidaMax[i] = val(o.life, 2.5);
    this.chao[i] = floorY;
    this.restit[i] = o.restit ?? 0.32;
    this.ativo[i] = 1;
    if (o.cor && this.mesh.instanceColor !== undefined) this.mesh.setColorAt(i, o.cor);
  }

  update(dt) {
    let vivos = 0;
    const N = this.capacidade;
    const g = 9.81 * dt;
    for (let i = 0; i < N; i++) {
      if (!this.ativo[i]) continue;
      this.vida[i] -= dt;
      if (this.vida[i] <= 0) {
        this.ativo[i] = 0;
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      const p = i * 3;
      let vx = this.vel[p], vy = this.vel[p + 1], vz = this.vel[p + 2];
      vy -= g;
      // arrasto do ar
      const k = 1 - Math.min(0.9, 0.9 * dt);
      vx *= k; vy *= k; vz *= k;
      let x = this.pos[p] + vx * dt;
      let y = this.pos[p + 1] + vy * dt;
      let z = this.pos[p + 2] + vz * dt;

      const solo = this.chao[i] + this.escala[p + 1] * 0.5;
      if (y < solo && vy < 0) {
        y = solo;
        const e = this.restit[i];
        vy = -vy * e;
        vx *= 0.62; vz *= 0.62;
        this.angVel[p] *= 0.5; this.angVel[p + 1] *= 0.5; this.angVel[p + 2] *= 0.5;
        if (vy < 0.35) { vy = 0; vx *= 0.2; vz *= 0.2; this.chao[i] = y - this.escala[p + 1] * 0.5; }
      }
      this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
      this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz;

      // rotacao
      const q = i * 4;
      _q.set(this.rot[q], this.rot[q + 1], this.rot[q + 2], this.rot[q + 3]);
      _v.set(this.angVel[p], this.angVel[p + 1], this.angVel[p + 2]);
      const w = _v.length();
      if (w > 1e-4) {
        _v.multiplyScalar(1 / w);
        _qd.setFromAxisAngle(_v, w * dt);
        _q.premultiply(_qd).normalize();
        this.rot[q] = _q.x; this.rot[q + 1] = _q.y; this.rot[q + 2] = _q.z; this.rot[q + 3] = _q.w;
      }

      // encolhe no fim da vida em vez de sumir de repente
      const f = Math.min(1, this.vida[i] / Math.max(0.001, this.vidaMax[i] * 0.28));
      _esc.set(this.escala[p] * f, this.escala[p + 1] * f, this.escala[p + 2] * f);
      _v.set(x, y, z);
      _m.compose(_v, _q, _esc);
      this.mesh.setMatrixAt(i, _m);
      vivos++;
    }
    this.vivos = vivos;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  limpa() {
    this.ativo.fill(0);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacidade; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.vivos = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) this.mesh.material.forEach((m) => m.dispose());
    else this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

/* ------------------------------------------------------------------------ */
/* Cartuchos ejetados                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Estojos de latao. Fisica identica a dos destrocos, mais: eixo longo alinhado
 * ao giro (o estojo roda no ar como uma vareta) e callback de som por quique.
 */
export class PoolCartuchos {
  constructor(capacidade, geo, mat, aoQuicar) {
    this.capacidade = Math.max(4, capacidade | 0);
    const N = this.capacidade;
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.name = 'fx.cartuchos';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = N;

    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.rot = new Float32Array(N * 4);
    this.angVel = new Float32Array(N * 3);
    this.vida = new Float32Array(N);
    this.chao = new Float32Array(N);
    this.quiques = new Uint8Array(N);
    this.ativo = new Uint8Array(N);
    this.cursor = 0;
    this.vivos = 0;
    this.aoQuicar = aoQuicar || null;
    this.escala = 1;

    _m.makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  ejeta(pos, vel, floorY, vida = 6) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacidade;
    const p = i * 3;
    this.pos[p] = pos.x; this.pos[p + 1] = pos.y; this.pos[p + 2] = pos.z;
    this.vel[p] = vel.x; this.vel[p + 1] = vel.y; this.vel[p + 2] = vel.z;
    this.angVel[p] = faixa(-26, 26);
    this.angVel[p + 1] = faixa(-8, 8);
    this.angVel[p + 2] = faixa(-26, 26);
    const q = i * 4;
    _q.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    this.rot[q] = _q.x; this.rot[q + 1] = _q.y; this.rot[q + 2] = _q.z; this.rot[q + 3] = _q.w;
    this.vida[i] = vida;
    this.chao[i] = floorY;
    this.quiques[i] = 0;
    this.ativo[i] = 1;
  }

  update(dt) {
    let vivos = 0;
    const g = 9.81 * dt;
    for (let i = 0; i < this.capacidade; i++) {
      if (!this.ativo[i]) continue;
      this.vida[i] -= dt;
      if (this.vida[i] <= 0) {
        this.ativo[i] = 0;
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      const p = i * 3;
      let vx = this.vel[p], vy = this.vel[p + 1] - g, vz = this.vel[p + 2];
      const k = 1 - Math.min(0.9, 0.55 * dt);
      vx *= k; vy *= k; vz *= k;
      let x = this.pos[p] + vx * dt;
      let y = this.pos[p + 1] + vy * dt;
      let z = this.pos[p + 2] + vz * dt;

      const solo = this.chao[i] + 0.005 * this.escala;
      if (y < solo && vy < 0) {
        y = solo;
        const forca = -vy;
        vy = forca * 0.42;
        vx *= 0.55; vz *= 0.55;
        this.angVel[p] *= 0.4; this.angVel[p + 1] *= 0.4; this.angVel[p + 2] *= 0.4;
        if (this.quiques[i] < 3 && forca > 0.5) {
          this.quiques[i]++;
          _v.set(x, y, z);
          this.aoQuicar?.(_v, Math.min(1, forca / 3));
        }
        if (vy < 0.25) { vy = 0; vx *= 0.15; vz *= 0.15; }
      }
      this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
      this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz;

      const q = i * 4;
      _q.set(this.rot[q], this.rot[q + 1], this.rot[q + 2], this.rot[q + 3]);
      _v.set(this.angVel[p], this.angVel[p + 1], this.angVel[p + 2]);
      const w = _v.length();
      if (w > 1e-4) {
        _v.multiplyScalar(1 / w);
        _qd.setFromAxisAngle(_v, w * dt);
        _q.premultiply(_qd).normalize();
        this.rot[q] = _q.x; this.rot[q + 1] = _q.y; this.rot[q + 2] = _q.z; this.rot[q + 3] = _q.w;
      }
      const f = Math.min(1, this.vida[i] / 0.6);
      _esc.setScalar(this.escala * f);
      _v.set(x, y, z);
      _m.compose(_v, _q, _esc);
      this.mesh.setMatrixAt(i, _m);
      vivos++;
    }
    this.vivos = vivos;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  limpa() {
    this.ativo.fill(0);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacidade; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.vivos = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) this.mesh.material.forEach((m) => m.dispose());
    else this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

export { rnd as _rnd, faixa as _faixa };
