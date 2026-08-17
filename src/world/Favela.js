/**
 * Favela — o PLANO da favela. Este modulo nao cria mesh nenhum: ele decide
 * topografia, rede de vias e onde cada casa encosta na outra. Buildings/Props/
 * Vegetation leem o plano e constroem.
 *
 * Ideia central: favela nao nasce de grade, nasce de caminho. Primeiro a rua
 * serpenteia o morro em zigue-zague, depois os becos brotam dela subindo pela
 * linha de maior declive, e as casas se penduram nas bordas dos becos com o
 * angulo que sobrar. Por isso nada aqui e ortogonal.
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { Rng, clamp, lerp, smoothstep } from './gen/rng.js';
import { fbm2, ridged2, noise2 } from './gen/noise.js';

export const TAM_MUNDO = 180;

// ------------------------------------------------------------------ terreno

/** Campo de altura regular com edicao (achatamento de plataformas e vias). */
export class HeightField {
  constructor(size = TAM_MUNDO, cell = 1) {
    this.size = size;
    this.cell = cell;
    this.n = Math.round(size / cell) + 1;
    this.origin = -size / 2;
    this.data = new Float32Array(this.n * this.n);
  }

  _i(ix, iz) { return iz * this.n + ix; }

  /** Preenche com a funcao de relevo do morro. */
  gerar(seed) {
    const { n, cell, origin, data } = this;
    for (let iz = 0; iz < n; iz++) {
      const z = origin + iz * cell;
      for (let ix = 0; ix < n; ix++) {
        const x = origin + ix * cell;
        data[this._i(ix, iz)] = alturaMorro(x, z, seed);
      }
    }
    return this;
  }

  heightAt(x, z) {
    const fx = (x - this.origin) / this.cell;
    const fz = (z - this.origin) / this.cell;
    const ix = clamp(Math.floor(fx), 0, this.n - 2);
    const iz = clamp(Math.floor(fz), 0, this.n - 2);
    const tx = clamp(fx - ix, 0, 1), tz = clamp(fz - iz, 0, 1);
    const d = this.data;
    const a = d[this._i(ix, iz)], b = d[this._i(ix + 1, iz)];
    const c = d[this._i(ix, iz + 1)], e = d[this._i(ix + 1, iz + 1)];
    return lerp(lerp(a, b, tx), lerp(c, e, tx), tz);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const h = this.cell;
    const dx = this.heightAt(x + h, z) - this.heightAt(x - h, z);
    const dz = this.heightAt(x, z + h) - this.heightAt(x, z - h);
    return out.set(-dx, 2 * h, -dz).normalize();
  }

  /** Inclinacao em radianos. */
  slopeAt(x, z) {
    const n = this.normalAt(x, z, _tmpN);
    return Math.acos(clamp(n.y, -1, 1));
  }

  /** Direcao de maior subida no plano XZ (unitaria). */
  upslopeAt(x, z, out = new THREE.Vector2()) {
    const h = 2;
    const dx = this.heightAt(x + h, z) - this.heightAt(x - h, z);
    const dz = this.heightAt(x, z + h) - this.heightAt(x, z - h);
    out.set(dx, dz);
    if (out.lengthSq() < 1e-8) out.set(0, -1);
    return out.normalize();
  }

  /** Achata um disco para a altura y, com transicao suave `feather`. */
  flattenDisk(cx, cz, r, y, feather = 1.2) {
    const R = r + feather;
    const i0 = clamp(Math.floor((cx - R - this.origin) / this.cell), 0, this.n - 1);
    const i1 = clamp(Math.ceil((cx + R - this.origin) / this.cell), 0, this.n - 1);
    const j0 = clamp(Math.floor((cz - R - this.origin) / this.cell), 0, this.n - 1);
    const j1 = clamp(Math.ceil((cz + R - this.origin) / this.cell), 0, this.n - 1);
    for (let j = j0; j <= j1; j++) {
      const z = this.origin + j * this.cell;
      for (let i = i0; i <= i1; i++) {
        const x = this.origin + i * this.cell;
        const d = Math.hypot(x - cx, z - cz);
        if (d > R) continue;
        const w = 1 - smoothstep(r, R, d);
        const k = this._i(i, j);
        this.data[k] = lerp(this.data[k], y, w);
      }
    }
  }

  /** Achata um retangulo orientado. */
  flattenRect(cx, cz, w, d, yaw, y, feather = 1.0) {
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const R = Math.hypot(w, d) * 0.5 + feather;
    const i0 = clamp(Math.floor((cx - R - this.origin) / this.cell), 0, this.n - 1);
    const i1 = clamp(Math.ceil((cx + R - this.origin) / this.cell), 0, this.n - 1);
    const j0 = clamp(Math.floor((cz - R - this.origin) / this.cell), 0, this.n - 1);
    const j1 = clamp(Math.ceil((cz + R - this.origin) / this.cell), 0, this.n - 1);
    const hw = w * 0.5, hd = d * 0.5;
    for (let j = j0; j <= j1; j++) {
      const pz = this.origin + j * this.cell;
      for (let i = i0; i <= i1; i++) {
        const px = this.origin + i * this.cell;
        const lx = (px - cx) * c - (pz - cz) * s;
        const lz = (px - cx) * s + (pz - cz) * c;
        const dx = Math.abs(lx) - hw, dz = Math.abs(lz) - hd;
        const dist = Math.max(dx, dz);
        if (dist > feather) continue;
        const wgt = 1 - smoothstep(0, feather, Math.max(0, dist));
        const k = this._i(i, j);
        this.data[k] = lerp(this.data[k], y, wgt);
      }
    }
  }

  /** Altura media do terreno sob um retangulo orientado. */
  averageIn(cx, cz, w, d, yaw) {
    let soma = 0, cnt = 0, mn = Infinity, mx = -Infinity;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nu = Math.max(2, Math.round(w / 1.2)), nv = Math.max(2, Math.round(d / 1.2));
    for (let u = 0; u <= nu; u++) {
      for (let v = 0; v <= nv; v++) {
        const lx = (u / nu - 0.5) * w, lz = (v / nv - 0.5) * d;
        const x = cx + lx * c + lz * s;
        const z = cz - lx * s + lz * c;
        const h = this.heightAt(x, z);
        soma += h; cnt++;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    }
    return { media: soma / cnt, min: mn, max: mx };
  }
}

const _tmpN = new THREE.Vector3();

/**
 * Relevo do morro. Sobe do sul (+Z, baixo, onde passa a rua e o campinho) para o
 * norte (-Z, alto). A crista e curvada para nao virar uma rampa reta.
 */
export function alturaMorro(x, z, seed = 0) {
  const desvio = Math.sin(x / 58) * 13 + Math.sin(x / 23 + 1.7) * 4;
  const u = clamp((88 - (z + desvio)) / 172, 0, 1);
  const p = clamp((u - 0.10) / 0.86, 0, 1);
  const perfil = (p * p * (3 - 2 * p)) * 0.82 + p * 0.18;
  let h = 32.5 * perfil;
  h += fbm2(x * 0.017, z * 0.017, 4, 2.05, 0.5, seed) * 3.4;      // ondulacao ampla
  h += (ridged2(x * 0.0115, z * 0.0115, 3, seed + 61) - 0.45) * 4.2; // escarpas
  h += fbm2(x * 0.085, z * 0.085, 3, 2.1, 0.5, seed + 7) * 0.55;   // detalhe
  // vale raso no pe do morro, onde fica a rua e o campo
  h -= Math.max(0, 1 - Math.abs((z - 60) / 26)) * 1.1;
  return h;
}

// --------------------------------------------------------------- utilitarios

/** Hash espacial 2D para consultas de vizinhanca (O(1) amortizado). */
class HashGrid {
  constructor(cell = 4) { this.cell = cell; this.m = new Map(); }
  _k(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  insert(x, z, item) {
    const ix = Math.floor(x / this.cell), iz = Math.floor(z / this.cell);
    const k = this._k(ix, iz);
    let a = this.m.get(k);
    if (!a) { a = []; this.m.set(k, a); }
    a.push(item);
  }
  query(x, z, r, out) {
    out.length = 0;
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const a = this.m.get(this._k(i, j));
      if (a) for (const it of a) out.push(it);
    }
    return out;
  }
}

/** Teste SAT entre dois retangulos orientados no plano XZ. */
function obbOverlap(a, b, margin = 0) {
  const aw = a.w * 0.5 + margin, ad = a.d * 0.5 + margin;
  const bw = b.w * 0.5 + margin, bd = b.d * 0.5 + margin;
  const axes = [
    [Math.cos(a.yaw), -Math.sin(a.yaw)], [Math.sin(a.yaw), Math.cos(a.yaw)],
    [Math.cos(b.yaw), -Math.sin(b.yaw)], [Math.sin(b.yaw), Math.cos(b.yaw)],
  ];
  const dx = b.x - a.x, dz = b.z - a.z;
  const au = [Math.cos(a.yaw), -Math.sin(a.yaw)], av = [Math.sin(a.yaw), Math.cos(a.yaw)];
  const bu = [Math.cos(b.yaw), -Math.sin(b.yaw)], bv = [Math.sin(b.yaw), Math.cos(b.yaw)];
  for (const ax of axes) {
    const proj = Math.abs(dx * ax[0] + dz * ax[1]);
    const ra = aw * Math.abs(au[0] * ax[0] + au[1] * ax[1]) + ad * Math.abs(av[0] * ax[0] + av[1] * ax[1]);
    const rb = bw * Math.abs(bu[0] * ax[0] + bu[1] * ax[1]) + bd * Math.abs(bv[0] * ax[0] + bv[1] * ax[1]);
    if (proj > ra + rb) return false;
  }
  return true;
}

/** Catmull-Rom por uma lista de pontos 2D, reamostrada a passo fixo. */
function suavizar(pontos, passo = 2) {
  if (pontos.length < 3) return pontos.slice();
  const out = [];
  const P = (i) => pontos[clamp(i, 0, pontos.length - 1)];
  for (let i = 0; i < pontos.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.round(seg / passo));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const z = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, z]);
    }
  }
  out.push(pontos[pontos.length - 1].slice());
  return out;
}

// ------------------------------------------------------------------ gerador

export class Favela {
  constructor(seed = 20260728, opts = {}) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.size = opts.size ?? TAM_MUNDO;
    this.terrain = new HeightField(this.size, 1);
    this.vias = [];        // {pts:[[x,z]], w, tipo:'rua'|'beco', escada:bool, coberto:bool[]}
    this.casas = [];
    this.muros = [];
    this.pracas = [];
    this.campinho = null;
    this.postes = [];
    this.junc = [];        // junçoes da rede (bom lugar para praça/props)
    this._viaGrid = new HashGrid(4);
    this._casaGrid = new HashGrid(8);
    this._buf = [];
  }

  gerar() {
    const t = this.terrain;
    t.gerar(this.seed & 0xffff);
    this._campinho();
    this._ruaPrincipal();
    this._becos();
    this._pracas();
    this._nivelarVias();
    this._marcarEscadas();
    this._casas();
    this._tuneis();
    this._muros();
    this._nivelarVias(0.55);      // segunda passada: casas nao podem ondular o beco
    this._marcarEscadas();        // reavalia os lances com o terreno ja plataformado
    this._postes();
    this._cotas();
    return this;
  }

  // ---------------------------------------------------------------- vias

  _campinho() {
    const r = this.rng.fork('campinho');
    const x = 34 + r.range(-4, 4), z = 44 + r.range(-3, 3);
    const w = 30, d = 18, yaw = r.range(-0.14, 0.14);
    const y = this.terrain.averageIn(x, z, w, d, yaw).media - 0.25;
    this.terrain.flattenRect(x, z, w, d, yaw, y, 3.5);
    this.campinho = { x, z, w, d, yaw, y };
  }

  /** Rua de asfalto em zigue-zague subindo o morro. E a espinha do mapa. */
  _ruaPrincipal() {
    const r = this.rng.fork('rua');
    const passes = [
      { z: 72, x0: -86, x1: 66 },
      { z: 26, x0: 66, x1: -76 },
      { z: -20, x0: -76, x1: 64 },
      { z: -62, x0: 64, x1: -34 },
    ];
    const ctrl = [];
    for (let p = 0; p < passes.length; p++) {
      const { z, x0, x1 } = passes[p];
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const tt = i / n;
        const x = lerp(x0, x1, tt);
        const zz = z + Math.sin(tt * Math.PI * 1.7 + p) * 3.4 + r.range(-1.6, 1.6);
        ctrl.push([x, zz]);
      }
      if (p < passes.length - 1) {
        // curva de retorno (cotovelo) entre passagens
        const dirSaida = Math.sign(x1 - x0);
        const zMid = (z + passes[p + 1].z) * 0.5;
        ctrl.push([x1 + dirSaida * 9, z - (z - zMid) * 0.42]);
        ctrl.push([x1 + dirSaida * 11, zMid]);
        ctrl.push([x1 + dirSaida * 9, passes[p + 1].z + (zMid - passes[p + 1].z) * 0.42]);
      }
    }
    const pts = suavizar(ctrl, 2.2);
    const via = { pts, w: 5.4, tipo: 'rua', escada: new Array(pts.length).fill(false), coberto: new Array(pts.length).fill(false), id: 0 };
    this._registrarVia(via);
  }

  _registrarVia(via) {
    via.id = this.vias.length;
    this.vias.push(via);
    for (let i = 0; i < via.pts.length; i++) {
      this._viaGrid.insert(via.pts[i][0], via.pts[i][1], { via, i });
    }
  }

  /** Distancia livre ate a borda da via mais proxima (negativo = dentro da via). */
  distViaLivre(x, z, raio = 9) {
    const itens = this._viaGrid.query(x, z, raio, this._buf);
    let best = Infinity;
    for (const it of itens) {
      const p = it.via.pts[it.i];
      const d = Math.hypot(p[0] - x, p[1] - z) - it.via.w * 0.5;
      if (d < best) best = d;
    }
    return best;
  }

  /** Nao ha casa (nem campinho) ocupando o disco (x,z,raio)? */
  livreDeCasa(x, z, raio) {
    const viz = this._casaGrid.query(x, z, raio + 14, []);
    for (const o of viz) if (pontoEmObb(x, z, o, raio)) return false;
    const cp = this.campinho;
    if (cp && pontoEmObb(x, z, { x: cp.x, z: cp.z, w: cp.w, d: cp.d, yaw: cp.yaw }, raio)) return false;
    return true;
  }

  /** Rede de becos: brotam da rua e sobem/atravessam o morro. */
  _becos() {
    const r = this.rng.fork('becos');
    const t = this.terrain;
    const fila = [];
    const rua = this.vias[0];

    // sementes na rua principal, dos dois lados
    for (let i = 6; i < rua.pts.length - 6; i += r.int(4, 8)) {
      const p = rua.pts[i], pn = rua.pts[i + 1];
      let dx = pn[0] - p[0], dz = pn[1] - p[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const lado = r.sign();
      fila.push({ x: p[0], z: p[1], dx: -dz * lado, dz: dx * lado, prof: 0, pai: rua });
    }
    r.shuffle(fila);

    let guarda = 0;
    while (fila.length && guarda++ < 400) {
      const s = fila.shift();
      const via = this._crescerBeco(s, r);
      if (!via) continue;
      if (s.prof < 2) {
        // ramificacoes filhas
        const nRamos = via.pts.length > 12 ? r.int(1, 3) : r.int(0, 1);
        for (let k = 0; k < nRamos; k++) {
          const i = r.int(3, Math.max(4, via.pts.length - 3));
          const p = via.pts[clamp(i, 1, via.pts.length - 2)];
          const pn = via.pts[clamp(i + 1, 1, via.pts.length - 1)];
          let dx = pn[0] - p[0], dz = pn[1] - p[1];
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const lado = r.sign();
          fila.push({ x: p[0], z: p[1], dx: -dz * lado, dz: dx * lado, prof: s.prof + 1, pai: via });
        }
      }
      if (this.vias.length > 62) break;
    }

    // conexoes extras entre pontas soltas (evita beco sem saida demais — ruim de FPS)
    this._fecharCiclos(r);
    void t;
  }

  _crescerBeco(semente, r) {
    const t = this.terrain;
    const largura = r.range(1.25, 2.5);
    const modo = r.weighted(['subida', 'nivel', 'diagonal'], [0.45, 0.3, 0.25]);
    const maxPassos = r.int(9, 26);
    const passo = 2.0;
    let dx = semente.dx, dz = semente.dz;
    let x = semente.x + dx * (semente.pai.w * 0.5 + 0.8);
    let z = semente.z + dz * (semente.pai.w * 0.5 + 0.8);
    if (this.distViaLivre(x, z, 6) < 0.4) return null;

    const pts = [[semente.x + dx * semente.pai.w * 0.45, semente.z + dz * semente.pai.w * 0.45], [x, z]];
    const up = new THREE.Vector2();
    const ladoNivel = r.sign();

    for (let s = 0; s < maxPassos; s++) {
      t.upslopeAt(x, z, up);
      let tx, tz;
      if (modo === 'subida') { tx = up.x; tz = up.y; }
      else if (modo === 'nivel') { tx = -up.y * ladoNivel; tz = up.x * ladoNivel; }
      else { tx = up.x * 0.6 - up.y * ladoNivel * 0.8; tz = up.y * 0.6 + up.x * ladoNivel * 0.8; }
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      // mantem coerencia com a semente: nao deixa o beco voltar para a via-mae
      if (tx * semente.dx + tz * semente.dz < -0.2) { tx = -tx; tz = -tz; }

      const jit = r.range(-0.42, 0.42) + noise2(x * 0.07, z * 0.07, this.seed) * 0.5;
      let ndx = dx * 0.66 + tx * 0.34 - dz * jit * 0.22;
      let ndz = dz * 0.66 + tz * 0.34 + dx * jit * 0.22;
      const nl = Math.hypot(ndx, ndz) || 1; ndx /= nl; ndz /= nl;

      const nx = x + ndx * passo, nz = z + ndz * passo;
      if (Math.abs(nx) > 84 || Math.abs(nz) > 84) break;
      // colisao com o campinho
      if (this.campinho && Math.abs(nx - this.campinho.x) < this.campinho.w * 0.5 + 1
        && Math.abs(nz - this.campinho.z) < this.campinho.d * 0.5 + 1) break;
      // encontrou outra via: emenda e termina (junçao em T)
      const d = this.distViaLivre(nx, nz, 8);
      if (s > 1 && d < largura * 0.5 + 0.2) {
        pts.push([nx, nz]);
        this.junc.push([nx, nz]);
        break;
      }
      // inclinacao proibitiva (paredao)
      if (t.slopeAt(nx, nz) > 0.98) break;
      pts.push([nx, nz]);
      x = nx; z = nz; dx = ndx; dz = ndz;
    }
    if (pts.length < 4) return null;
    const suave = suavizar(pts, 1.4);
    const via = {
      pts: suave, w: largura, tipo: 'beco', modo,
      escada: new Array(suave.length).fill(false),
      coberto: new Array(suave.length).fill(false),
    };
    this._registrarVia(via);
    return via;
  }

  /** Liga pontas soltas proximas — cria loops de flanqueamento. */
  _fecharCiclos(r) {
    const pontas = [];
    for (const v of this.vias) {
      if (v.tipo !== 'beco') continue;
      pontas.push({ via: v, p: v.pts[v.pts.length - 1] });
    }
    let feitos = 0;
    for (const a of pontas) {
      if (feitos > 10) break;
      if (!r.chance(0.55)) continue;
      let melhor = null, dmin = 15;
      for (const b of pontas) {
        if (b.via === a.via) continue;
        const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
        if (d > 5 && d < dmin) { dmin = d; melhor = b; }
      }
      if (!melhor) continue;
      const mid = [
        (a.p[0] + melhor.p[0]) * 0.5 + r.range(-2, 2),
        (a.p[1] + melhor.p[1]) * 0.5 + r.range(-2, 2),
      ];
      const pts = suavizar([a.p.slice(), mid, melhor.p.slice()], 1.4);
      this._registrarVia({
        pts, w: r.range(1.2, 1.9), tipo: 'beco', modo: 'ligacao',
        escada: new Array(pts.length).fill(false), coberto: new Array(pts.length).fill(false),
      });
      feitos++;
    }
  }

  /** Pracinhas/largos: pontos abertos, bons para botequim e para duelo aberto. */
  _pracas() {
    const r = this.rng.fork('pracas');
    const cand = this.junc.slice();
    r.shuffle(cand);
    for (const c of cand) {
      if (this.pracas.length >= 5) break;
      let ok = true;
      for (const p of this.pracas) if (Math.hypot(p.x - c[0], p.z - c[1]) < 34) { ok = false; break; }
      if (!ok) continue;
      if (Math.hypot(c[0] - this.campinho.x, c[1] - this.campinho.z) < 28) continue;
      const raio = r.range(4.2, 7.0);
      const y = this.terrain.averageIn(c[0], c[1], raio * 2, raio * 2, 0).media;
      this.terrain.flattenDisk(c[0], c[1], raio, y, 2.2);
      this.pracas.push({ x: c[0], z: c[1], r: raio, y });
    }
  }

  /** Suaviza o terreno transversalmente sob cada via (beco nao pode ser montanha-russa). */
  _nivelarVias(forca = 1) {
    for (const via of this.vias) {
      const n = via.pts.length;
      // altura suavizada ao longo do eixo
      const hs = new Float32Array(n);
      for (let i = 0; i < n; i++) hs[i] = this.terrain.heightAt(via.pts[i][0], via.pts[i][1]);
      const sm = new Float32Array(n);
      const janela = via.tipo === 'rua' ? 5 : 3;
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -janela; k <= janela; k++) {
          const j = clamp(i + k, 0, n - 1);
          s += hs[j]; c++;
        }
        sm[i] = s / c;
      }
      for (let i = 0; i < n; i++) {
        const y = lerp(hs[i], sm[i], 0.8 * forca);
        this.terrain.flattenDisk(via.pts[i][0], via.pts[i][1], via.w * 0.5 + 0.15, y, 0.9);
      }
      via.alturas = sm;
    }
  }

  /** Marca trechos ingremes como escadaria e agrupa em lances. */
  _marcarEscadas() {
    for (const via of this.vias) {
      const n = via.pts.length;
      via.lances = [];
      const decl = new Float32Array(n);
      for (let i = 0; i < n - 1; i++) {
        const a = via.pts[i], b = via.pts[i + 1];
        const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const dh = this.terrain.heightAt(b[0], b[1]) - this.terrain.heightAt(a[0], a[1]);
        decl[i] = Math.abs(dh) / dl;
      }
      // rua de asfalto nunca vira escada: carro sobe rampa, e uma escadaria de
      // 5,4 m de largura nao existe. So beco ganha degrau.
      const limite = via.tipo === 'rua' ? Infinity : 0.155;
      let ini = -1;
      for (let i = 0; i < n; i++) {
        const eh = decl[i] > limite;
        via.escada[i] = eh;
        if (eh && ini < 0) ini = i;
        if ((!eh || i === n - 1) && ini >= 0) {
          if (i - ini >= 2) via.lances.push([ini, Math.min(i, n - 1)]);
          else for (let k = ini; k <= i; k++) via.escada[k] = false;
          ini = -1;
        }
      }
    }
  }

  // ---------------------------------------------------------------- casas

  _tentarCasa(spec, r, margem = 0.45) {
    // fora do mundo?
    if (Math.abs(spec.x) > 86 || Math.abs(spec.z) > 86) return false;
    // sobre uma via?
    const raio = Math.hypot(spec.w, spec.d) * 0.5;
    const itens = this._viaGrid.query(spec.x, spec.z, raio + 4, this._buf);
    for (const it of itens) {
      const p = it.via.pts[it.i];
      if (pontoEmObb(p[0], p[1], spec, it.via.w * 0.5 + 0.25)) return false;
    }
    // sobre praca / campinho?
    for (const p of this.pracas) if (Math.hypot(p.x - spec.x, p.z - spec.z) < p.r + raio * 0.55) return false;
    const cp = this.campinho;
    if (obbOverlap(spec, { x: cp.x, z: cp.z, w: cp.w + 3, d: cp.d + 3, yaw: cp.yaw }, 0)) return false;
    // sobre outra casa?
    const viz = this._casaGrid.query(spec.x, spec.z, raio + 14, []);
    for (const o of viz) if (obbOverlap(spec, o, margem)) return false;
    // terreno impossivel
    const st = this.terrain.averageIn(spec.x, spec.z, spec.w, spec.d, spec.yaw);
    if (st.max - st.min > 6.5) return false;
    spec.baseY = st.min + (st.max - st.min) * 0.62;
    spec.desnivel = st.max - st.min;
    return true;
  }

  _aceitarCasa(spec) {
    this.casas.push(spec);
    this._casaGrid.insert(spec.x, spec.z, spec);
    // plataforma: achata sob a casa, mas de leve — o terreno ainda "vaza" nas bordas
    this.terrain.flattenRect(spec.x, spec.z, spec.w * 0.94, spec.d * 0.94, spec.yaw,
      spec.baseY - 0.05, 1.1);
  }

  _casas() {
    const r = this.rng.fork('casas');

    // --- 1a passada: fileiras encostadas nas vias ---
    // Estrategia que muda tudo na densidade: se a casa cheia nao cabe, TENTA
    // MENOR antes de desistir. E assim que a favela cresce de verdade — o lote
    // que sobra vira um puxadinho de 3x3, nao um vazio.
    const ESCALAS = [1.0, 0.78, 0.6, 0.45];
    for (const via of this.vias) {
      const n = via.pts.length;
      const recuoBase = via.tipo === 'rua' ? 1.0 : 0.15;
      for (const lado of [-1, 1]) {
        let i = 2;
        while (i < n - 2) {
          const p = via.pts[i], pn = via.pts[Math.min(n - 1, i + 1)];
          let dx = pn[0] - p[0], dz = pn[1] - p[1];
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const nx = -dz * lado, nz = dx * lado;
          const frenteMax = r.range(4.6, 9.5);
          const fundoMax = r.range(5.0, 11.0);
          const recuo = recuoBase + r.range(0, 0.55);
          const yaw = Math.atan2(-dz, dx) + r.range(-0.22, 0.22);

          let colocada = null;
          for (const esc of ESCALAS) {
            const frente = frenteMax * esc, fundo = fundoMax * esc;
            if (frente < 2.8 || fundo < 3.0) break;
            const off = via.w * 0.5 + recuo + fundo * 0.5;
            const spec = {
              x: p[0] + nx * off, z: p[1] + nz * off,
              w: frente, d: fundo, yaw,
              viaId: via.id, lado, frenteZ: lado === 1 ? -1 : 1, tipoVia: via.tipo,
            };
            if (this._tentarCasa(spec, r, 0.08)) { colocada = spec; break; }
          }
          if (colocada) {
            this._perfilCasa(colocada, r, via);
            this._aceitarCasa(colocada);
            i += Math.max(2, Math.round((colocada.w + r.range(0.05, 0.9)) / 1.4));
          } else i += 2;
        }
      }
    }

    // --- 2a passada: miolo de quarteirao, casas soltas e tortas ---
    const alvo = 340;
    for (let tent = 0; tent < 14000 && this.casas.length < alvo; tent++) {
      const x = r.range(-82, 82), z = r.range(-82, 82);
      if (this.distViaLivre(x, z, 20) > 17) continue;   // longe demais de qualquer acesso
      const base = { w: r.range(3.4, 8.5), d: r.range(3.6, 9.0) };
      const yaw = r.range(-Math.PI, Math.PI);
      for (const esc of ESCALAS) {
        const spec = {
          x, z, w: base.w * esc, d: base.d * esc, yaw,
          viaId: -1, lado: 1, frenteZ: r.sign(), tipoVia: 'miolo',
        };
        if (spec.w < 2.8 || spec.d < 3.0) break;
        if (this._tentarCasa(spec, r, 0.14)) {
          this._perfilCasa(spec, r, null);
          this._aceitarCasa(spec);
          break;
        }
      }
    }
  }

  /** Decide andares, cores, telhado e adereços de uma casa. */
  _perfilCasa(spec, r, via) {
    const altitude = spec.baseY / 33;
    // mais alto no morro => casas menores; embaixo, predinhos de 3-4 lajes
    const pesos = [
      0.16 + altitude * 0.34,
      0.36,
      0.30 - altitude * 0.12,
      0.18 - altitude * 0.16,
    ].map((v) => Math.max(0.03, v));
    const nAndares = r.weighted([1, 2, 3, 4], pesos);

    const paletaReboco = ['reboco_azul', 'reboco_amarelo', 'reboco_rosa', 'reboco_verde', 'reboco'];
    spec.andares = [];
    let acumulado = 0;
    for (let a = 0; a < nAndares; a++) {
      // andar de epoca diferente: material e recuo proprios
      const cru = a === 0 ? r.chance(0.42) : r.chance(0.55);
      const mat = cru ? 'tijolo' : r.weighted(paletaReboco, [0.2, 0.2, 0.16, 0.16, 0.28]);
      const pd = r.range(2.32, 2.95);
      const recuoX = a === 0 ? 0 : r.range(-0.9, 1.15);   // negativo = puxadinho avancando
      const recuoZ = a === 0 ? 0 : r.range(-0.9, 1.15);
      const desloc = a === 0 ? [0, 0] : [r.range(-0.85, 0.85), r.range(-0.85, 0.85)];
      // andar construido depois quase nunca sai no esquadro do de baixo
      const yawA = a === 0 ? 0 : r.range(-0.075, 0.075);
      spec.andares.push({
        y0: acumulado, h: pd, mat, recuoX, recuoZ, desloc, yaw: yawA,
        lajeSalto: r.range(0.10, 0.34),      // beiral da laje
        w: Math.max(2.6, spec.w - recuoX * 2), d: Math.max(2.6, spec.d - recuoZ * 2),
      });
      acumulado += pd + r.range(0.20, 0.28);
    }
    spec.alturaTotal = acumulado;

    spec.topo = r.weighted(['laje', 'fibro', 'barro'], [0.52, 0.33, 0.15]);
    spec.vergalhoes = spec.topo === 'laje' && r.chance(0.62);
    spec.caixaDagua = spec.topo === 'laje' ? r.chance(0.72) : r.chance(0.3);
    spec.antena = r.chance(0.45);
    spec.parabolica = r.chance(0.38);
    spec.varal = r.chance(0.5);
    spec.escadaExterna = via && nAndares >= 2 && r.chance(0.26);
    spec.pilotis = spec.desnivel > 1.6;
    spec.grafite = r.chance(0.3);
    spec.ar = r.chance(0.22);
    spec.interior = via && via.tipo !== 'rua' && nAndares <= 3 && r.chance(0.2);
    spec.tunel = false;
    spec.seed = r.int(0, 1e9);
  }

  /** Escolhe algumas casas para atravessar o beco por baixo (passagem coberta). */
  _tuneis() {
    const r = this.rng.fork('tuneis');
    const becos = this.vias.filter((v) => v.tipo === 'beco' && v.pts.length > 10);
    r.shuffle(becos);
    let feitos = 0;
    for (const via of becos) {
      if (feitos >= 7) break;
      const i = r.int(4, via.pts.length - 5);
      if (via.escada[i] || via.escada[i + 1]) continue;
      const p = via.pts[i], pn = via.pts[i + 1];
      let dx = pn[0] - p[0], dz = pn[1] - p[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      // local X = direcao do beco (comprimento do tunel), local Z = travessia
      const yaw = Math.atan2(-dz, dx);
      const vao = via.w + 0.6;
      const spec = {
        x: p[0], z: p[1], w: r.range(4.5, 7.0), d: vao + r.range(5.5, 9), yaw,
        viaId: via.id, lado: 1, frenteZ: 1, tipoVia: 'beco', tunel: true,
        tunelVao: vao, tunelAltura: r.range(2.35, 2.75),
      };
      // O tunel PRECISA ficar em cima da via — entao ignora a propria via no
      // teste e, em vez de desistir quando encontra vizinhas, DEMOLE ate 4 casas
      // e ocupa o lugar delas. E assim que a passagem sob a casa aparece.
      const raio = Math.hypot(spec.w, spec.d) * 0.5;
      const viz = this._casaGrid.query(spec.x, spec.z, raio + 14, []);
      const demolir = [];
      for (const o of viz) {
        if (o.removida) continue;
        if (obbOverlap(spec, o, 0.35)) demolir.push(o);
      }
      if (demolir.length > 4) continue;
      let livre = true;
      for (const it of this._viaGrid.query(spec.x, spec.z, raio + 4, this._buf)) {
        if (it.via === via) continue;
        const q = it.via.pts[it.i];
        if (pontoEmObb(q[0], q[1], spec, it.via.w * 0.5)) { livre = false; break; }
      }
      if (!livre) continue;
      for (const o of demolir) o.removida = true;
      const st = this.terrain.averageIn(spec.x, spec.z, spec.w, spec.d, spec.yaw);
      spec.baseY = st.min;
      spec.desnivel = st.max - st.min;
      const r2 = this.rng.fork(`tunel${feitos}`);
      this._perfilCasa(spec, r2, via);
      spec.tunel = true;
      spec.pilotis = false;
      spec.interior = false;
      spec.tunelVao = vao;
      spec.tunelAltura = 2.45;
      if (spec.andares.length < 2) {
        spec.andares.push({ ...spec.andares[0], y0: spec.andares[0].h + 0.25, mat: 'reboco_amarelo' });
        spec.alturaTotal = spec.andares[1].y0 + spec.andares[1].h;
      }
      this.casas.push(spec);
      this._casaGrid.insert(spec.x, spec.z, spec);
      feitos++;
    }
    // remove as demolidas e reconstroi o indice espacial
    if (this.casas.some((c) => c.removida)) {
      this.casas = this.casas.filter((c) => !c.removida);
      this._casaGrid = new HashGrid(8);
      for (const c of this.casas) this._casaGrid.insert(c.x, c.z, c);
    }
    this.nTuneis = feitos;
  }

  /** Muros de divisa e de arrimo (a favela e feita de muro tanto quanto de casa). */
  _muros() {
    const r = this.rng.fork('muros');
    const t = this.terrain;
    for (const via of this.vias) {
      const n = via.pts.length;
      for (const lado of [-1, 1]) {
        let i = 3;
        while (i < n - 4) {
          const p = via.pts[i];
          const pn = via.pts[i + 1];
          let dx = pn[0] - p[0], dz = pn[1] - p[1];
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const nx = -dz * lado, nz = dx * lado;
          const off = via.w * 0.5 + 0.35;
          const cx = p[0] + nx * off, cz = p[1] + nz * off;
          // so onde nao ha casa colada
          const viz = this._casaGrid.query(cx, cz, 8, []);
          let livre = true;
          for (const o of viz) if (pontoEmObb(cx, cz, o, 0.9)) { livre = false; break; }
          if (livre && r.chance(0.55)) {
            const comp = r.range(3.5, 9.5);
            const hLocal = t.heightAt(cx, cz);
            const hAtras = t.heightAt(cx + nx * 2.2, cz + nz * 2.2);
            const arrimo = hAtras - hLocal > 0.9;
            this.muros.push({
              x: cx, z: cz, len: comp, yaw: Math.atan2(-dz, dx),
              h: arrimo ? clamp(hAtras - hLocal + 0.55, 1.3, 3.4) : r.range(1.55, 2.35),
              y: hLocal, arrimo,
              mat: arrimo ? 'concreto' : r.weighted(['tijolo', 'reboco', 'concreto'], [0.4, 0.35, 0.25]),
              grafite: r.chance(0.42),
              caco: !arrimo && r.chance(0.35),   // cacos de vidro no topo
            });
            i += Math.max(3, Math.round(comp / 1.4));
          } else i += 3;
        }
      }
    }
  }

  /** Postes de luz: a espinha do emaranhado de fios. */
  _postes() {
    const r = this.rng.fork('postes');
    const usados = [];
    for (const via of this.vias) {
      const passoM = via.tipo === 'rua' ? 17 : 13;
      let acc = 99;
      for (let i = 1; i < via.pts.length - 1; i++) {
        const a = via.pts[i - 1], b = via.pts[i];
        acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc < passoM) continue;
        acc = 0;
        const lado = r.sign();
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const off = via.w * 0.5 + 0.22;
        const x = b[0] - dz * lado * off, z = b[1] + dx * lado * off;
        let perto = false;
        for (const u of usados) if (Math.hypot(u[0] - x, u[1] - z) < 8) { perto = true; break; }
        if (perto) continue;
        usados.push([x, z]);
        this.postes.push({
          x, z, y: this.terrain.heightAt(x, z),
          h: r.range(6.6, 8.6), tilt: r.range(-0.075, 0.075), yaw: r.range(0, Math.PI * 2),
          trafo: r.chance(0.18), luminaria: r.chance(0.75), viaId: via.id,
        });
      }
    }
  }

  /** Estatisticas e limites uteis para os outros modulos. */
  _cotas() {
    let min = Infinity, max = -Infinity;
    const d = this.terrain.data;
    for (let i = 0; i < d.length; i++) { if (d[i] < min) min = d[i]; if (d[i] > max) max = d[i]; }
    this.cotaMin = min; this.cotaMax = max;
  }
}

/** Ponto dentro de um retangulo orientado (com margem). */
export function pontoEmObb(px, pz, obb, margem = 0) {
  const c = Math.cos(obb.yaw), s = Math.sin(obb.yaw);
  const dx = px - obb.x, dz = pz - obb.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= obb.w * 0.5 + margem && Math.abs(lz) <= obb.d * 0.5 + margem;
}

export { obbOverlap, suavizar, HashGrid };
