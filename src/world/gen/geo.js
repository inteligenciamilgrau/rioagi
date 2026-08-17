/**
 * Fabrica de geometria primitiva com "peso": nada de cubo perfeito.
 * Todo volume sai daqui com quina chanfrada (1-3 cm) — quina viva perfeita e o
 * delator numero um de geometria amadora.
 *
 * Convencoes:
 *  - Tudo nao-indexado e flat-shaded (merge trivial, normais corretas nos chanfros).
 *  - UV NAO e gerado aqui: quem faz e o batcher, em espaco de mundo, com escala
 *    fixa de 1 unidade UV = 1 metro. Isso mantem a textura coerente entre pecas.
 * Dono: WORLD.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- construtor

/** Acumulador de triangulos com winding automatico a partir da normal desejada. */
export class TriBuilder {
  constructor() { this.pos = []; this.nrm = []; }

  get triangleCount() { return this.pos.length / 9; }

  /** Triangulo com normal explicita; inverte o winding se necessario. */
  tri(a, b, c, n) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-12) return;                       // triangulo degenerado, descarta
    cx /= len; cy /= len; cz /= len;
    let nx = n ? n[0] : cx, ny = n ? n[1] : cy, nz = n ? n[2] : cz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const flip = (cx * nx + cy * ny + cz * nz) < 0;
    const p = this.pos, q = this.nrm;
    if (flip) { p.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]); }
    else { p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
    for (let i = 0; i < 3; i++) q.push(nx, ny, nz);
  }

  /** Quad convexo a,b,c,d (em ordem no perimetro). */
  quad(a, b, c, d, n) { this.tri(a, b, c, n); this.tri(a, c, d, n); }

  /** Faixa entre duas polilinhas de mesmo tamanho. */
  strip(rowA, rowB, n) {
    for (let i = 0; i < rowA.length - 1; i++) this.quad(rowA[i], rowA[i + 1], rowB[i + 1], rowB[i], n);
  }

  /** Leque a partir de um centro sobre um anel fechado. */
  fan(center, ring, n) {
    for (let i = 0; i < ring.length; i++) this.tri(center, ring[i], ring[(i + 1) % ring.length], n);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    return g;
  }
}

// ---------------------------------------------------------------- primitivas

const _cornerCache = new Map();

/**
 * Caixa chanfrada centrada na origem.
 * 6 faces + 12 arestas biseladas + 8 cantos = 44 triangulos.
 * @param {number} c chanfro em metros (clampado a 24% da menor dimensao)
 * @param {object} [warp] deformacao opcional {tiltX, tiltZ, taper} para tirar o prumo perfeito
 */
export function chamferBox(w, h, d, c = 0.02, warp = null) {
  const key = warp ? null : `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}|${c.toFixed(4)}`;
  if (key && _cornerCache.has(key)) return _cornerCache.get(key).clone();

  const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
  c = Math.min(c, Math.min(w, h, d) * 0.24);
  const ix = hw - c, iy = hh - c, iz = hd - c;

  // Deformacao: leve fora-de-prumo e afinamento no topo (paredes de alvenaria "na mao").
  const tiltX = warp?.tiltX ?? 0, tiltZ = warp?.tiltZ ?? 0, taper = warp?.taper ?? 0;
  const warpP = (p) => {
    const t = (p[1] + hh) / h;             // 0 na base, 1 no topo
    const s = 1 - taper * t;
    return [p[0] * s + tiltX * t * h, p[1], p[2] * s + tiltZ * t * h];
  };

  // Tres vertices por canto: um por face adjacente.
  const vX = (sx, sy, sz) => warpP([sx * hw, sy * iy, sz * iz]);
  const vY = (sx, sy, sz) => warpP([sx * ix, sy * hh, sz * iz]);
  const vZ = (sx, sy, sz) => warpP([sx * ix, sy * iy, sz * hd]);

  const b = new TriBuilder();
  const S = [-1, 1];

  // Faces principais
  for (const sx of S) b.quad(vX(sx, -1, -1), vX(sx, 1, -1), vX(sx, 1, 1), vX(sx, -1, 1), [sx, 0, 0]);
  for (const sy of S) b.quad(vY(-1, sy, -1), vY(1, sy, -1), vY(1, sy, 1), vY(-1, sy, 1), [0, sy, 0]);
  for (const sz of S) b.quad(vZ(-1, -1, sz), vZ(1, -1, sz), vZ(1, 1, sz), vZ(-1, 1, sz), [0, 0, sz]);

  const r2 = Math.SQRT1_2;
  // Arestas ao longo de Z
  for (const sx of S) for (const sy of S)
    b.quad(vX(sx, sy, -1), vX(sx, sy, 1), vY(sx, sy, 1), vY(sx, sy, -1), [sx * r2, sy * r2, 0]);
  // Arestas ao longo de X
  for (const sy of S) for (const sz of S)
    b.quad(vY(-1, sy, sz), vY(1, sy, sz), vZ(1, sy, sz), vZ(-1, sy, sz), [0, sy * r2, sz * r2]);
  // Arestas ao longo de Y
  for (const sx of S) for (const sz of S)
    b.quad(vZ(sx, -1, sz), vZ(sx, 1, sz), vX(sx, 1, sz), vX(sx, -1, sz), [sx * r2, 0, sz * r2]);
  // Cantos
  const r3 = 1 / Math.sqrt(3);
  for (const sx of S) for (const sy of S) for (const sz of S)
    b.tri(vX(sx, sy, sz), vY(sx, sy, sz), vZ(sx, sy, sz), [sx * r3, sy * r3, sz * r3]);

  const g = b.build();
  if (key) { _cornerCache.set(key, g); return g.clone(); }
  return g;
}

/** Caixa chanfrada posicionada: retorna {geo, matrix} pronto para o batcher. */
export function boxAt(x, y, z, w, h, d, yaw = 0, c = 0.02, warp = null) {
  const geo = chamferBox(w, h, d, c, warp);
  const m = new THREE.Matrix4().makeRotationY(yaw);
  m.setPosition(x, y, z);
  return { geo, matrix: m };
}

/**
 * Caixa SEM chanfro (12 triangulos). So para detalhe menor que ~5 cm, onde o
 * chanfro nao seria percebido e custaria 4x mais triangulo: barra de grade,
 * vergalhao, ripa. Tudo acima disso usa chamferBox.
 */
export function simpleBox(w, h, d) {
  const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
  const b = new TriBuilder();
  const V = (sx, sy, sz) => [sx * hw, sy * hh, sz * hd];
  b.quad(V(1, -1, -1), V(1, 1, -1), V(1, 1, 1), V(1, -1, 1), [1, 0, 0]);
  b.quad(V(-1, -1, -1), V(-1, 1, -1), V(-1, 1, 1), V(-1, -1, 1), [-1, 0, 0]);
  b.quad(V(-1, 1, -1), V(1, 1, -1), V(1, 1, 1), V(-1, 1, 1), [0, 1, 0]);
  b.quad(V(-1, -1, -1), V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), [0, -1, 0]);
  b.quad(V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1), [0, 0, 1]);
  b.quad(V(-1, -1, -1), V(1, -1, -1), V(1, 1, -1), V(-1, 1, -1), [0, 0, -1]);
  return b.build();
}

/** Prisma vertical a partir de um poligono 2D (XZ) extrudado em Y, com topo/base chanfrados. */
export function prism(poly2d, y0, y1, chamfer = 0.02) {
  const b = new TriBuilder();
  const n = poly2d.length;
  // Encolhe o poligono pelo chanfro para as tampas
  const cx = poly2d.reduce((s, p) => s + p[0], 0) / n;
  const cz = poly2d.reduce((s, p) => s + p[1], 0) / n;
  const shrink = poly2d.map(([px, pz]) => {
    const dx = px - cx, dz = pz - cz, l = Math.hypot(dx, dz) || 1;
    return [px - (dx / l) * chamfer, pz - (dz / l) * chamfer];
  });
  const yb = y0 + chamfer, yt = y1 - chamfer;
  // Paredes
  for (let i = 0; i < n; i++) {
    const a = poly2d[i], bb = poly2d[(i + 1) % n];
    const ex = bb[0] - a[0], ez = bb[1] - a[1], el = Math.hypot(ex, ez) || 1;
    const nrm = [ez / el, 0, -ex / el];
    b.quad([a[0], yb, a[1]], [bb[0], yb, bb[1]], [bb[0], yt, bb[1]], [a[0], yt, a[1]], nrm);
    // chanfro inferior e superior
    b.quad([a[0], yb, a[1]], [shrink[i][0], y0, shrink[i][1]],
      [shrink[(i + 1) % n][0], y0, shrink[(i + 1) % n][1]], [bb[0], yb, bb[1]], [nrm[0] * 0.7, -0.7, nrm[2] * 0.7]);
    b.quad([a[0], yt, a[1]], [bb[0], yt, bb[1]],
      [shrink[(i + 1) % n][0], y1, shrink[(i + 1) % n][1]], [shrink[i][0], y1, shrink[i][1]], [nrm[0] * 0.7, 0.7, nrm[2] * 0.7]);
  }
  // Tampas
  const top = shrink.map(([px, pz]) => [px, y1, pz]);
  const bot = shrink.map(([px, pz]) => [px, y0, pz]);
  b.fan([cx, y1, cz], top, [0, 1, 0]);
  b.fan([cx, y0, cz], bot, [0, -1, 0]);
  return b.build();
}

/** Cilindro chanfrado nas bordas (poste, caixa d'agua, galao). */
export function chamferCylinder(rTop, rBot, h, seg = 12, c = 0.02) {
  const b = new TriBuilder();
  const hh = h * 0.5;
  const ring = (r, y) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    return out;
  };
  const bodyBot = ring(rBot, -hh + c), bodyTop = ring(rTop, hh - c);
  const capBot = ring(Math.max(0.001, rBot - c), -hh), capTop = ring(Math.max(0.001, rTop - c), hh);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const a = (i + 0.5) / seg * Math.PI * 2;
    const nrm = [Math.cos(a), 0, Math.sin(a)];
    b.quad(bodyBot[i], bodyBot[j], bodyTop[j], bodyTop[i], nrm);
    b.quad(capBot[i], capBot[j], bodyBot[j], bodyBot[i], [nrm[0] * 0.7, -0.7, nrm[2] * 0.7]);
    b.quad(bodyTop[i], bodyTop[j], capTop[j], capTop[i], [nrm[0] * 0.7, 0.7, nrm[2] * 0.7]);
  }
  b.fan([0, hh, 0], capTop, [0, 1, 0]);
  b.fan([0, -hh, 0], capBot.slice().reverse(), [0, -1, 0]);
  return b.build();
}

/** Plano vertical/horizontal simples (vidro, lona, pichacao, folha). */
export function plane(w, h, segW = 1, segH = 1, bulge = 0) {
  const b = new TriBuilder();
  const pt = (i, j) => {
    const u = i / segW - 0.5, v = j / segH - 0.5;
    const s = bulge * Math.sin(Math.PI * (i / segW)) * Math.sin(Math.PI * (j / segH));
    return [u * w, v * h, s];
  };
  for (let i = 0; i < segW; i++) for (let j = 0; j < segH; j++)
    b.quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), null);
  return b.build();
}

/**
 * Telha ondulada (fibrocimento / metal). Plano com senoide no eixo X e leve
 * empenamento — telha de favela nunca e reta.
 */
export function corrugatedSheet(w, d, amp = 0.028, waveLen = 0.18, sag = 0.05) {
  // 2 amostras por onda no eixo da ondulacao; no outro eixo bastam 3 faixas,
  // so para o empenamento aparecer. Barrar isso importa: telhado e o item que
  // mais multiplica triangulo na favela inteira.
  const nx = Math.max(6, Math.min(64, Math.round(w / (waveLen * 0.5))));
  const nz = Math.max(2, Math.min(6, Math.round(d / 1.2)));
  const b = new TriBuilder();
  const pt = (i, j) => {
    const x = (i / nx - 0.5) * w;
    const z = (j / nz - 0.5) * d;
    const y = Math.sin((x / waveLen) * Math.PI) * amp
      - sag * Math.sin(Math.PI * (i / nx)) * Math.sin(Math.PI * (j / nz));
    return [x, y, z];
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++)
    b.quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), null);
  // fundo chapado (2 triangulos): fecha a vista de baixo sem replicar a onda
  const t = 0.02;
  const yb = -amp - sag - t;
  b.quad([-w / 2, yb, -d / 2], [-w / 2, yb, d / 2], [w / 2, yb, d / 2], [w / 2, yb, -d / 2], [0, -1, 0]);
  return b.build();
}

/** Telhado de telha de barro: fileiras de meias-canas. Caro, usar so em poucas casas. */
export function tileRoof(w, d, waveLen = 0.22, amp = 0.05) {
  return corrugatedSheet(w, d, amp, waveLen, 0.02);
}

// ---------------------------------------------------------------- curvas

/** Catenaria entre dois pontos (fio eletrico, varal). Retorna array de Vector3. */
export function catenary(a, b, sag = 0.6, segs = 8) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t - sag * Math.sin(Math.PI * t) * (0.75 + 0.25 * Math.sin(Math.PI * t));
    const z = a.z + (b.z - a.z) * t;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

const _tv0 = new THREE.Vector3(), _tv1 = new THREE.Vector3(), _tv2 = new THREE.Vector3();

/**
 * Tubo de baixa contagem ao longo de uma polilinha (fio, cano, vergalhao, corda).
 * sides=3 e o suficiente para um fio de 8mm visto a 3 m.
 */
export function tubeAlong(points, radius, sides = 3) {
  const b = new TriBuilder();
  const rings = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    _tv0.copy(points[Math.min(i + 1, points.length - 1)]).sub(points[Math.max(i - 1, 0)]);
    if (_tv0.lengthSq() < 1e-10) _tv0.set(0, 0, 1);
    _tv0.normalize();
    _tv1.copy(Math.abs(_tv0.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).cross(_tv0).normalize();
    _tv2.copy(_tv0).cross(_tv1).normalize();
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a) * radius, sa = Math.sin(a) * radius;
      ring.push([p.x + _tv1.x * ca + _tv2.x * sa, p.y + _tv1.y * ca + _tv2.y * sa, p.z + _tv1.z * ca + _tv2.z * sa]);
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const t = (s + 1) % sides;
      b.quad(rings[i][s], rings[i][t], rings[i + 1][t], rings[i + 1][s], null);
    }
  }
  return b.build();
}

/** Fita horizontal seguindo uma polilinha, colada a uma funcao de altura (rua, piso de beco). */
export function ribbon(points2d, width, heightFn, yOffset = 0.02, widthFn = null) {
  const b = new TriBuilder();
  const left = [], right = [];
  const n = points2d.length;
  for (let i = 0; i < n; i++) {
    const p = points2d[i];
    const pPrev = points2d[Math.max(0, i - 1)], pNext = points2d[Math.min(n - 1, i + 1)];
    let dx = pNext[0] - pPrev[0], dz = pNext[1] - pPrev[1];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const w = (widthFn ? widthFn(i / (n - 1)) : width) * 0.5;
    const lx = p[0] - dz * w, lz = p[1] + dx * w;
    const rx = p[0] + dz * w, rz = p[1] - dx * w;
    left.push([lx, heightFn(lx, lz) + yOffset, lz]);
    right.push([rx, heightFn(rx, rz) + yOffset, rz]);
  }
  b.strip(left, right, [0, 1, 0]);
  return { geo: b.build(), left, right };
}

// ---------------------------------------------------------------- utilitarios

/** Aplica matriz e devolve a mesma geometria (in-place). */
export function applyMatrix(geo, matrix) {
  geo.applyMatrix4(matrix);
  return geo;
}

/**
 * UV por projecao de caixa em espaco de mundo: escolhe o eixo dominante da normal
 * de cada triangulo. 1 unidade de UV = `scale` metros. Sem esticamento, e a
 * repeticao casa entre pecas vizinhas porque a projecao e global.
 */
export function boxProjectUV(geo, scale = 1, rotate = 0) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const inv = 1 / scale;
  const cr = Math.cos(rotate), sr = Math.sin(rotate);
  for (let t = 0; t < count; t += 3) {
    // normal media do triangulo decide o plano de projecao
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) { nx += nrm.getX(t + k); ny += nrm.getY(t + k); nz += nrm.getZ(t + k); }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = z; }            // horizontal: piso/laje
      else if (ax >= az) { u = z * Math.sign(nx || 1); v = y; }  // parede voltada a X
      else { u = -x * Math.sign(nz || 1); v = y; }               // parede voltada a Z
      uv[i * 2] = (u * cr - v * sr) * inv;
      uv[i * 2 + 1] = (u * sr + v * cr) * inv;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2)); // aoMap (three usa uv1)
  return geo;
}

/** Garante uv/uv1 numa geometria que ja traz UV proprio (cilindros, esferas...). */
export function scaleExistingUV(geo, s = 1) {
  const uv = geo.attributes.uv;
  if (!uv) return boxProjectUV(geo, 1);
  const arr = uv.array;
  if (s !== 1) for (let i = 0; i < arr.length; i++) arr[i] *= s;
  geo.setAttribute('uv1', new THREE.BufferAttribute(arr.slice(), 2));
  return geo;
}
