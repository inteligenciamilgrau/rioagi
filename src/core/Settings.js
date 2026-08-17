/**
 * Settings — presets de qualidade + preferencias do jogador.
 * Persistido em localStorage. Emite 'quality:changed' no bus quando muda.
 */

export const QUALITY = {
  baixo: {
    name: 'baixo',
    textureSize: 512, detailTextures: false, anisotropy: 4,
    shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 60, softShadows: false,
    ssao: 'off', bloom: 'simples', bloomIterations: 3,
    motionBlur: false, dof: false, taa: false, fxaa: true,
    particleScale: 0.25, decalBudget: 32, maxTracers: 24,
    renderScale: 0.75, volumetrics: false, reflections: false,
    vegetationDensity: 0.35, propDensity: 0.5,
  },
  medio: {
    name: 'medio',
    textureSize: 1024, detailTextures: true, anisotropy: 8,
    shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 90, softShadows: true,
    ssao: 'half', bloom: 'simples', bloomIterations: 4,
    motionBlur: false, dof: false, taa: false, fxaa: true,
    particleScale: 0.5, decalBudget: 64, maxTracers: 48,
    renderScale: 1.0, volumetrics: false, reflections: false,
    vegetationDensity: 0.6, propDensity: 0.75,
  },
  alto: {
    name: 'alto',
    textureSize: 2048, detailTextures: true, anisotropy: 16,
    shadowMapSize: 2048, shadowCascades: 4, shadowDistance: 120, softShadows: true,
    ssao: 'full', bloom: '5tap', bloomIterations: 5,
    motionBlur: true, dof: true, taa: true, fxaa: false,
    particleScale: 1.0, decalBudget: 128, maxTracers: 96,
    renderScale: 1.0, volumetrics: true, reflections: true,
    vegetationDensity: 1.0, propDensity: 1.0,
  },
  ultra: {
    name: 'ultra',
    textureSize: 2048, detailTextures: true, anisotropy: 16,
    shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 160, softShadows: true,
    ssao: 'full', bloom: '5tap', bloomIterations: 6,
    motionBlur: true, dof: true, taa: true, fxaa: false,
    particleScale: 1.0, decalBudget: 192, maxTracers: 128,
    renderScale: 1.0, volumetrics: true, reflections: true,
    vegetationDensity: 1.0, propDensity: 1.0,
  },
};

const DEFAULTS = {
  quality: 'alto',
  sensitivity: 0.0022,     // rad por pixel de mouse
  adsSensitivityScale: 0.65,
  fov: 80,                 // FOV do mundo, graus
  viewmodelFov: 60,        // FOV do viewmodel
  invertY: false,
  masterVolume: 0.8,
  sfxVolume: 1.0,
  musicVolume: 0.35,
  showFps: true,
  crosshair: true,
  filmGrain: 0.35,
  chromaticAberration: 0.4,
  vignette: 0.6,
  exposure: 1.0,
};

const STORAGE_KEY = 'oca:settings:v1';

/**
 * Faixa valida por chave numerica. Quem nao aparece aqui ainda herda a
 * checagem de TIPO, deduzida do proprio DEFAULTS.
 */
const FAIXAS = {
  sensitivity: [0.0001, 0.05],
  adsSensitivityScale: [0.05, 3],
  fov: [55, 130],
  viewmodelFov: [30, 110],
  masterVolume: [0, 1],
  sfxVolume: [0, 1],
  musicVolume: [0, 1],
  filmGrain: [0, 1],
  chromaticAberration: [0, 1],
  vignette: [0, 1],
  exposure: [0.1, 4],
};

/**
 * Valida um valor lido do localStorage; devolve o padrao se nao servir.
 *
 * PORQUE ISTO EXISTE: o localStorage e editavel e sobrevive a mudanca de
 * versao. Um valor corrompido ali nao fica contido — `masterVolume` vai parar
 * num AudioParam do WebAudio, e AudioParam LANCA EXCECAO com valor nao finito.
 * Ou seja: uma chave estragada no armazenamento derrubava o audio do jogo
 * inteiro, com um erro que nao aponta para a causa.
 *
 * `Number.isFinite` reprova NaN, Infinity, string, null e objeto de uma vez —
 * ele nao converte, diferente do `isFinite` global.
 */
function sanear(chave, valor) {
  const padrao = DEFAULTS[chave];
  if (chave === 'quality') {
    return (typeof valor === 'string' && valor in QUALITY) ? valor : padrao;
  }
  if (typeof padrao === 'boolean') return typeof valor === 'boolean' ? valor : padrao;
  if (typeof padrao === 'number') {
    if (!Number.isFinite(valor)) return padrao;
    const f = FAIXAS[chave];
    return f ? Math.min(Math.max(valor, f[0]), f[1]) : valor;
  }
  return typeof valor === typeof padrao ? valor : padrao;
}

export class Settings {
  constructor(bus) {
    this.bus = bus;
    Object.assign(this, DEFAULTS);
    this._load();
  }

  /** Preset de qualidade ativo (objeto de QUALITY). */
  get q() { return QUALITY[this.quality] ?? QUALITY.alto; }

  setQuality(name) {
    if (!QUALITY[name] || name === this.quality) return;
    this.quality = name;
    this._save();
    this.bus?.emit('quality:changed', { preset: this.q });
  }

  set(key, value) {
    if (!(key in DEFAULTS)) { console.warn(`[Settings] chave desconhecida: ${key}`); return; }
    this[key] = value;
    this._save();
  }

  /** Detecta um preset inicial razoavel a partir do hardware. */
  autoDetect(renderer) {
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '').toLowerCase();
      const cores = navigator.hardwareConcurrency || 4;
      const mem = navigator.deviceMemory || 8;
      const discrete = /rtx|radeon rx|geforce|arc a|quadro|nvidia/.test(gpu);
      const weak = /swiftshader|llvmpipe|software|uhd graphics 6|hd graphics/.test(gpu);
      if (weak || cores <= 2 || mem <= 2) return 'baixo';
      if (discrete && cores >= 8 && mem >= 8) return 'alto';
      return 'medio';
    } catch { return 'medio'; }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      // JSON valido nem sempre e objeto: "null", "3" e '"txt"' passam pelo parse
      // e fariam o `in` abaixo lancar TypeError.
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      // Percorrer DEFAULTS (e nao as chaves do armazenamento) e o que impede
      // chave arbitraria de entrar no objeto. Manter assim.
      for (const k of Object.keys(DEFAULTS)) {
        if (Object.hasOwn(obj, k)) this[k] = sanear(k, obj[k]);
      }
    } catch { /* localStorage indisponivel (modo headless/privado) — usa defaults */ }
  }

  _save() {
    try {
      const out = {};
      for (const k of Object.keys(DEFAULTS)) out[k] = this[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch { /* ignora */ }
  }
}
