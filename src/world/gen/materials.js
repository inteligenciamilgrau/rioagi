/**
 * Ponte para a biblioteca de materiais do agente MAT.
 *
 * O codigo do mundo SEMPRE consome `ctx.materials.get(nome)`. Este modulo so
 * existe para o mundo continuar gerando e sendo testavel enquanto MAT ainda nao
 * publicou `src/world/materials/MaterialLibrary.js` — ai entra um fallback
 * procedural local (ruido em canvas + normal derivado), nunca cor chapada.
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { noise2, fbm2 } from './noise.js';

/** Mapa nome-de-material -> tipo de superficie do contrato (FX/AUDIO). */
export const SURFACE_OF = {
  tijolo: 'tijolo', reboco: 'concreto', reboco_azul: 'concreto', reboco_amarelo: 'concreto',
  reboco_rosa: 'concreto', reboco_verde: 'concreto', concreto: 'concreto', concreto_liso: 'concreto',
  telha_barro: 'tijolo', telha_fibrocimento: 'concreto', metal_ondulado: 'metal', metal_pintado: 'metal',
  madeira: 'madeira', madeira_pintada: 'madeira', asfalto: 'asfalto', calcada_portuguesa: 'concreto',
  terra: 'terra', grama: 'folhagem', folha: 'folhagem', agua: 'agua', grafite: 'concreto', azulejo: 'concreto',
  vidro: 'vidro', pano: 'madeira', borracha: 'madeira', plastico: 'madeira',
};

// ------------------------------------------------------------ fallback local

const PALETA = {
  tijolo: { cor: 0x8d5a47, rug: 0.92, tipo: 'tijolo' },
  reboco: { cor: 0xc0b8a8, rug: 0.88, tipo: 'reboco' },
  reboco_azul: { cor: 0x7d9ab0, rug: 0.85, tipo: 'reboco' },
  reboco_amarelo: { cor: 0xcfba7e, rug: 0.85, tipo: 'reboco' },
  reboco_rosa: { cor: 0xc39a94, rug: 0.85, tipo: 'reboco' },
  reboco_verde: { cor: 0x8aa07e, rug: 0.85, tipo: 'reboco' },
  concreto: { cor: 0xa39e94, rug: 0.93, tipo: 'concreto' },
  concreto_liso: { cor: 0xb0aba2, rug: 0.72, tipo: 'concreto' },
  telha_barro: { cor: 0xa06a4c, rug: 0.9, tipo: 'onda' },
  telha_fibrocimento: { cor: 0xa5a49e, rug: 0.95, tipo: 'onda' },
  metal_ondulado: { cor: 0x93826f, rug: 0.68, met: 0.45, tipo: 'ferrugem' },
  metal_pintado: { cor: 0x6c7880, rug: 0.5, met: 0.35, tipo: 'ferrugem' },
  madeira: { cor: 0x86694a, rug: 0.85, tipo: 'madeira' },
  madeira_pintada: { cor: 0x9aa8ab, rug: 0.72, tipo: 'madeira' },
  asfalto: { cor: 0x4a4846, rug: 0.95, tipo: 'concreto' },
  calcada_portuguesa: { cor: 0xbdb7ab, rug: 0.8, tipo: 'calcada' },
  terra: { cor: 0x8a6f52, rug: 0.98, tipo: 'concreto' },
  grama: { cor: 0x66784a, rug: 0.95, tipo: 'concreto' },
  folha: { cor: 0x5a7a30, rug: 0.6, tipo: 'concreto' },
  agua: { cor: 0x445f68, rug: 0.15, tipo: 'concreto' },
  grafite: { cor: 0x7a7674, rug: 0.85, tipo: 'grafite' },
  azulejo: { cor: 0xc4ccc8, rug: 0.35, tipo: 'azulejo' },
  vidro: { cor: 0x35464a, rug: 0.08, met: 0.1, tipo: 'liso' },
  pano: { cor: 0xd2ccc0, rug: 0.95, tipo: 'reboco' },
  borracha: { cor: 0x2e2c2b, rug: 0.9, tipo: 'concreto' },
  plastico: { cor: 0xb5b8b9, rug: 0.45, tipo: 'liso' },
};

const N = 256;

function temCanvas() {
  return typeof OffscreenCanvas !== 'undefined'
    || (typeof document !== 'undefined' && typeof document.createElement === 'function');
}

function canvas2d() {
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(N, N)
    : Object.assign(document.createElement('canvas'), { width: N, height: N });
  return { c, g: c.getContext('2d', { willReadFrequently: true }) };
}

/** Campo de altura procedural por tipo — vira albedo + normal + roughness. */
function campo(tipo, x, y, seed) {
  const u = x / N, v = y / N;
  switch (tipo) {
    case 'tijolo': {
      const linhaH = 0.0714;                       // ~14 fiadas por metro de textura
      const fila = Math.floor(v / linhaH);
      const off = (fila % 2) * 0.5;
      const cx = (u * 3.5 + off) % 1;
      const cy = (v / linhaH) % 1;
      const arg = Math.min(cx, 1 - cx, cy * 0.5, (1 - cy) * 0.5) * 8;
      const junta = Math.min(1, arg);
      return junta * 0.75 + fbm2(u * 22, v * 22, 3, 2, 0.5, seed) * 0.2 + noise2(fila * 7.3, 0, seed) * 0.08;
    }
    case 'reboco': {
      const n = fbm2(u * 7, v * 7, 4, 2.1, 0.55, seed);
      const descasca = Math.max(0, fbm2(u * 3.2 + 11, v * 3.2, 3, 2, 0.5, seed + 5) - 0.22) * 3;
      return 0.55 + n * 0.25 - descasca * 0.35;
    }
    case 'concreto':
      return 0.55 + fbm2(u * 9, v * 9, 5, 2.05, 0.55, seed) * 0.28
        + Math.max(0, noise2(u * 3, v * 3, seed + 9)) * 0.12;
    case 'onda': {
      const w = Math.sin(u * Math.PI * 2 * 9) * 0.5 + 0.5;
      return w * 0.6 + 0.2 + fbm2(u * 14, v * 14, 3, 2, 0.5, seed) * 0.18;
    }
    case 'ferrugem': {
      const cor = fbm2(u * 5, v * 5, 4, 2.1, 0.6, seed);
      const w = Math.sin(u * Math.PI * 2 * 7) * 0.5 + 0.5;
      return 0.4 + w * 0.25 + cor * 0.3;
    }
    case 'madeira': {
      const veio = Math.sin((v * 6 + fbm2(u * 2, v * 9, 3, 2, 0.5, seed) * 2.5) * Math.PI * 2);
      return 0.55 + veio * 0.14 + fbm2(u * 30, v * 6, 2, 2, 0.5, seed) * 0.1;
    }
    case 'calcada': {
      const s = 16;
      const gx = Math.floor(u * s), gy = Math.floor(v * s);
      const onda = Math.sin((gx / s) * Math.PI * 3 + Math.sin((gy / s) * Math.PI * 4) * 1.6);
      const pedra = onda > 0 ? 0.86 : 0.12;
      const jx = Math.min((u * s) % 1, 1 - (u * s) % 1), jy = Math.min((v * s) % 1, 1 - (v * s) % 1);
      const junta = Math.min(1, Math.min(jx, jy) * 9);
      return pedra * (0.55 + junta * 0.45) + noise2(gx * 3.1, gy * 3.1, seed) * 0.06;
    }
    case 'grafite': {
      const a = fbm2(u * 4 + 3, v * 4, 3, 2, 0.5, seed);
      const b = Math.sin(u * 13 + Math.sin(v * 9 + seed) * 3);
      return 0.45 + a * 0.3 + (b > 0.55 ? 0.35 : 0);
    }
    case 'azulejo': {
      const s = 8;
      const jx = Math.min((u * s) % 1, 1 - (u * s) % 1), jy = Math.min((v * s) % 1, 1 - (v * s) % 1);
      return Math.min(1, Math.min(jx, jy) * 14) * 0.8 + 0.15 + fbm2(u * 20, v * 20, 2, 2, 0.5, seed) * 0.05;
    }
    default:
      return 0.55 + fbm2(u * 6, v * 6, 3, 2, 0.5, seed) * 0.12;
  }
}

function gerarTexturas(nome, def) {
  if (!temCanvas()) return {};   // ambiente sem DOM (teste headless de geracao)
  const seed = nome.length * 37 + nome.charCodeAt(0) * 13;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] = campo(def.tipo, x, y, seed);

  const base = new THREE.Color(def.cor);
  const { c: cAlb, g: gAlb } = canvas2d();
  const { c: cNrm, g: gNrm } = canvas2d();
  const { c: cRgh, g: gRgh } = canvas2d();
  const iAlb = gAlb.createImageData(N, N), iNrm = gNrm.createImageData(N, N), iRgh = gRgh.createImageData(N, N);

  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const v = h[y * N + x];
      const k = 0.74 + v * 0.42;
      iAlb.data[i] = Math.min(255, base.r * 255 * k);
      iAlb.data[i + 1] = Math.min(255, base.g * 255 * k);
      iAlb.data[i + 2] = Math.min(255, base.b * 255 * k);
      iAlb.data[i + 3] = 255;
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 3.2;
      const l = Math.hypot(-dx, -dy, 1);
      iNrm.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      iNrm.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      iNrm.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      iNrm.data[i + 3] = 255;
      const r = Math.min(1, Math.max(0.05, def.rug + (0.5 - v) * 0.25));
      iRgh.data[i] = iRgh.data[i + 1] = iRgh.data[i + 2] = r * 255;
      iRgh.data[i + 3] = 255;
    }
  }
  gAlb.putImageData(iAlb, 0, 0); gNrm.putImageData(iNrm, 0, 0); gRgh.putImageData(iRgh, 0, 0);

  const tex = (cv, srgb) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { map: tex(cAlb, true), normalMap: tex(cNrm, false), roughnessMap: tex(cRgh, false) };
}

class FallbackMaterials {
  constructor() { this.cache = new Map(); this.isFallback = true; }

  get(nome) {
    if (this.cache.has(nome)) return this.cache.get(nome);
    const def = PALETA[nome] || PALETA.concreto;
    const t = gerarTexturas(nome, def);
    const params = {
      color: 0xffffff, roughness: 1, metalness: def.met ?? 0,
      normalScale: new THREE.Vector2(1.1, 1.1), aoMapIntensity: 0.5,
    };
    if (t.map) {
      params.map = t.map; params.normalMap = t.normalMap;
      params.roughnessMap = t.roughnessMap; params.aoMap = t.roughnessMap;
    } else {
      params.color = def.cor; params.roughness = def.rug;   // headless: sem textura
    }
    const mat = new THREE.MeshStandardMaterial(params);
    if (nome === 'vidro') { mat.transparent = true; mat.opacity = 0.35; mat.roughness = 0.12; mat.metalness = 0.2; }
    if (nome === 'agua') { mat.transparent = true; mat.opacity = 0.8; mat.roughness = 0.1; }
    mat.name = nome;
    this.cache.set(nome, mat);
    return mat;
  }

  getSurfaceType(mat) { return SURFACE_OF[mat?.name] || 'concreto'; }

  dispose() {
    for (const m of this.cache.values()) {
      m.map?.dispose(); m.normalMap?.dispose(); m.roughnessMap?.dispose(); m.dispose();
    }
    this.cache.clear();
  }
}

/**
 * Devolve a fonte de materiais: a do MAT quando disponivel, senao o fallback local.
 * Envolve tudo num cache proprio para o mundo nunca chamar get() duas vezes a toa.
 */
export function resolveMaterials(ctx) {
  const lib = ctx?.materials;
  if (lib && typeof lib.get === 'function') return lib;
  return new FallbackMaterials();
}

/** Superficie do contrato a partir do nome de material do mundo. */
export function surfaceOf(matName) { return SURFACE_OF[matName] || 'concreto'; }
