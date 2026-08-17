/**
 * PRNG deterministico (mulberry32) + acucar sintatico.
 * Mesma seed => mesmo mapa, sempre. Nenhum uso de Math.random() em src/world/.
 * Dono: WORLD.
 */

/** Gerador base: 32 bits de estado, ~2^32 de periodo, rapido e sem dependencia. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash de string -> inteiro 32 bits (para derivar sub-seeds nomeadas). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1337) {
    this.seed = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    this._n = mulberry32(this.seed);
  }

  /** [0,1) */
  next() { return this._n(); }

  /** Real em [a,b). */
  range(a, b) { return a + (b - a) * this._n(); }

  /** Inteiro em [a,b] inclusive. */
  int(a, b) { return a + Math.floor(this._n() * (b - a + 1)); }

  /** true com probabilidade p. */
  chance(p) { return this._n() < p; }

  /** -1 ou +1. */
  sign() { return this._n() < 0.5 ? -1 : 1; }

  pick(arr) { return arr[Math.floor(this._n() * arr.length) % arr.length]; }

  /** Escolha ponderada: pesos paralelos ao array. */
  weighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this._n() * total;
    for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }

  /** Gaussiana aproximada (soma de 3 uniformes), media 0 desvio ~1. */
  gauss() { return (this._n() + this._n() + this._n() - 1.5) * 1.1547; }

  /** Fisher-Yates in-place, deterministico. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._n() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Sub-gerador nomeado: isola sequencias para que mudar um sistema nao mova os outros. */
  fork(name) { return new Rng((this.seed ^ hashString(name)) >>> 0); }
}

/** Interpolacao suave classica. */
export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
