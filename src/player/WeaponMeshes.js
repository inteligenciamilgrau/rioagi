/**
 * WeaponMeshes — geometria 100% procedural das armas + mãos.
 * Dono: PLAYER.
 *
 * Convenção do espaço local da arma:
 *   -Z = cano / frente (mesma convenção da câmera)
 *   +Y = cima, +X = direita
 *   origem ≈ topo do punho / região do gatilho
 *
 * Tudo é construído com primitivas chanfradas (ExtrudeGeometry com bevel),
 * LatheGeometry para peças torneadas e "CSG manual" (vãos deixados entre peças)
 * onde um furo seria necessário. Nada de cubo com cano.
 *
 * Desgaste: as quinas são detectadas pela normal (face de chanfro não é alinhada
 * a nenhum eixo) e recebem vertex color mais clara; o material usa essa cor para
 * clarear o albedo E baixar a rugosidade, imitando metal polido pelo uso.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

/* ==================================================================== *
 * Primitivas
 * ==================================================================== */

/** Retângulo com cantos arredondados, centrado na origem. */
function roundedRect(w, h, r) {
  r = Math.max(0.0001, Math.min(r, w * 0.5 - 1e-4, h * 0.5 - 1e-4));
  const s = new THREE.Shape();
  const x = -w * 0.5, y = -h * 0.5;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function extrudeCentered(shape, d, c, curve) {
  c = Math.min(c, d * 0.45);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, d - c * 2),
    bevelEnabled: true, bevelThickness: c, bevelSize: c, bevelOffset: 0,
    bevelSegments: 1, curveSegments: curve, steps: 1,
  });
  geo.translate(0, 0, c - d * 0.5);   // centraliza a espessura em z
  return geo;
}

/** Caixa chanfrada centrada na origem (perfil no plano XY, espessura em Z). */
function box(w, h, d, r = 0.004, c = 0.0022, curve = 2) {
  return extrudeCentered(roundedRect(w, h, r), d, Math.min(c, w * 0.4, h * 0.4), curve);
}

/** Perfil livre (lista de [x,y]) extrudado em Z, centrado. */
function profileBox(pts, d, c = 0.002, curve = 2, holes = null) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  if (holes) {
    for (const h of holes) {
      const p = new THREE.Path();
      p.moveTo(h[0][0], h[0][1]);
      for (let i = 1; i < h.length; i++) p.lineTo(h[i][0], h[i][1]);
      p.closePath();
      s.holes.push(p);
    }
  }
  return extrudeCentered(s, d, c, curve);
}

/**
 * Perfil desenhado no plano lateral (z, y) — o jeito natural de desenhar
 * a silhueta de uma arma — extrudado para a largura em X.
 */
function profileZY(pts, width, c = 0.002, curve = 2, holes = null) {
  const g = profileBox(pts, width, c, curve, holes);
  g.rotateY(-HALF_PI);   // x_perfil -> z do mundo, espessura -> x do mundo
  return g;
}

/** Cilindro deitado no eixo Z. */
function tube(r1, r2, len, seg = 18, open = false) {
  const g = new THREE.CylinderGeometry(r1, r2, len, seg, 1, open);
  g.rotateX(HALF_PI);
  return g;
}

/**
 * Peça torneada a partir de um perfil [ [raio, avanço], ... ].
 * O avanço cresce para a FRENTE da arma (-Z). É o que dá forma ao cano com
 * seus degraus, ao quebra-chamas e às porcas.
 */
function lathe(profile, seg = 20) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(1e-5, r), z));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(-HALF_PI);   // +Y do lathe -> -Z do mundo
  return g;
}

/** Anel elíptico deitado (usado em ranhuras de punho). */
function ring(radius, thick, squash = 0.7, seg = 14) {
  const g = new THREE.TorusGeometry(radius, thick, 5, seg);
  g.scale(1, squash, 1);
  g.rotateX(HALF_PI);
  return g;
}

/** Aplica transformação a uma geometria. */
function place(geo, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0) {
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(px, py, pz);
  return geo;
}

/** Espelha em X mantendo as normais e o winding corretos (geometria não indexada). */
function mirrorX(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) { p.setX(i, -p.getX(i)); n.setX(i, -n.getX(i)); }
  const arrays = [p.array, n.array, geo.attributes.uv?.array, geo.attributes.color?.array];
  const sizes = [3, 3, 2, 3];
  for (let k = 0; k < arrays.length; k++) {
    const a = arrays[k]; if (!a) continue;
    const s = sizes[k];
    for (let t = 0; t < p.count; t += 3) {
      for (let c = 0; c < s; c++) {
        const i1 = (t + 1) * s + c, i2 = (t + 2) * s + c;
        const tmp = a[i1]; a[i1] = a[i2]; a[i2] = tmp;
      }
    }
  }
  p.needsUpdate = true; n.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

/* ==================================================================== *
 * Trilho picatinny — base + ranhuras (MIL-STD-1913, passo 10,1 mm)
 * ==================================================================== */
function picatinny(out, len, width = 0.021) {
  const local = [];
  const base = profileBox([
    [-width * 0.5, -0.0060], [width * 0.5, -0.0060],
    [width * 0.5 - 0.0018, -0.0008], [-width * 0.5 + 0.0018, -0.0008],
  ], len, 0.0012, 1);
  local.push(base);
  const teeth = Math.floor((len - 0.008) / 0.0101);
  const start = -(teeth - 1) * 0.0101 * 0.5;
  for (let i = 0; i < teeth; i++) {
    const t = profileBox([
      [-width * 0.5, -0.0010], [width * 0.5, -0.0010],
      [width * 0.5 - 0.0016, 0.0044], [-width * 0.5 + 0.0016, 0.0044],
    ], 0.0046, 0.0006, 1);
    place(t, 0, 0, start + i * 0.0101);
    local.push(t);
  }
  for (const g of local) out.push(g);
  return local;
}

/* ==================================================================== *
 * Desgaste por vertex color
 * ==================================================================== */
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Desgaste por vertex color.
 * A quina é identificada pela GEOMETRIA, não pela normal: as faces de chanfro
 * são tiras finas e compridas, então a menor altura do triângulo denuncia o
 * chanfro. Usar a normal marcaria qualquer peça rotacionada como quina e
 * clarearia a arma inteira.
 */
function applyWear(geo, edgeGain = 1.0, grime = 0.16) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();

  for (let t = 0; t + 2 < n; t += 3) {
    ax.fromBufferAttribute(pos, t);
    bx.fromBufferAttribute(pos, t + 1);
    cx.fromBufferAttribute(pos, t + 2);
    e1.subVectors(bx, ax); e2.subVectors(cx, ax);
    const area2 = cr.crossVectors(e1, e2).length();      // = 2 * área
    const maxSide = Math.max(e1.length(), e2.length(), bx.distanceTo(cx));
    const alt = maxSide > 1e-9 ? area2 / maxSide : 1;    // menor altura do triângulo
    let edge = 1 - THREE.MathUtils.smoothstep(alt, 0.0010, 0.0042);

    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nse = hash3(Math.round(x * 190), Math.round(y * 190), Math.round(z * 190));
      const w = edge * (0.25 + 0.75 * nse);
      const dirt = grime * (0.5 - nrm.getY(i) * 0.5) * (0.35 + 0.65 * hash3(x * 63, y * 63, z * 63));
      const v = 1 + w * edgeGain - dirt;
      col[i * 3] = v;
      col[i * 3 + 1] = v * (1 - dirt * 0.10);
      col[i * 3 + 2] = v * (1 - dirt * 0.18);
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Une geometrias normalizando o layout de atributos e aplica o desgaste. */
function fuse(geos, edgeGain, grime) {
  const clean = geos.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const keep = new THREE.BufferGeometry();
    keep.setAttribute('position', g.attributes.position);
    keep.setAttribute('normal', g.attributes.normal);
    keep.setAttribute('uv', g.attributes.uv ??
      new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    return keep;
  });
  const merged = mergeGeometries(clean, false);
  merged.computeBoundingSphere();
  return applyWear(merged, edgeGain, grime);
}

/* ==================================================================== *
 * Materiais da arma
 * ==================================================================== */

export function createWeaponMaterials(ctx) {
  const lib = ctx?.materials;
  const pick = (...names) => {
    if (!lib?.get) return null;
    for (const n of names) {
      try { const m = lib.get(n); if (m && m.isMaterial) return m; } catch { /* nome inexistente */ }
    }
    return null;
  };

  const make = (fallback, ...names) => {
    const base = pick(...names);
    const m = base ? base.clone() : new THREE.MeshStandardMaterial(fallback);
    m.vertexColors = true;
    m.side = THREE.FrontSide;
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         #ifdef USE_COLOR
           float _wear = clamp(vColor.r - 1.0, 0.0, 1.2);
           roughnessFactor = clamp(roughnessFactor * (1.0 - _wear * 0.62), 0.045, 1.0);
         #endif`
      );
    };
    m.customProgramCacheKey = () => 'oca-weapon-wear';
    return m;
  };

  return {
    metal: make(
      { color: 0x2b2e32, metalness: 0.92, roughness: 0.55, envMapIntensity: 0.75 },
      'metal_escovado', 'metal', 'aco'),
    metalDark: make(
      { color: 0x191b1e, metalness: 0.88, roughness: 0.62, envMapIntensity: 0.65 },
      'metal_escovado', 'metal'),
    polymer: make(
      { color: 0x1d1f21, metalness: 0.05, roughness: 0.76, envMapIntensity: 0.40 },
      'plastico', 'polimero'),
    rubber: make(
      { color: 0x0f1011, metalness: 0.0, roughness: 0.93, envMapIntensity: 0.3 },
      'borracha', 'rubber'),
    wood: make(
      { color: 0x5a3a22, metalness: 0.0, roughness: 0.66, envMapIntensity: 0.4 },
      'madeira', 'wood'),
    glove: make(
      { color: 0x231f1a, metalness: 0.03, roughness: 0.90, envMapIntensity: 0.28 },
      'borracha', 'plastico'),
  };
}

/* ==================================================================== *
 * Mãos e antebraços
 * ==================================================================== *
 * Frame local da mão: dedos saem em -Z a partir dos nós e curvam para -Y,
 * ou seja, envolvem um eixo paralelo a X. O antebraço sai em +Z.
 */

function finger(out, len1, len2, r, curl, x, y, z, splay = 0) {
  const rot = (g, a) => { g.rotateX(-a); if (splay) g.rotateY(splay); return g; };

  const g1 = new THREE.CapsuleGeometry(r, len1, 2, 7);
  g1.rotateX(HALF_PI); g1.translate(0, 0, -len1 * 0.5);
  rot(g1, curl);
  place(g1, x, y, z);
  out.push(g1);

  const e = new THREE.Vector3(0, 0, -len1)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), -curl)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), splay);

  const g2 = new THREE.CapsuleGeometry(r * 0.86, len2, 2, 7);
  g2.rotateX(HALF_PI); g2.translate(0, 0, -len2 * 0.5);
  rot(g2, curl * 2.05);
  place(g2, x + e.x, y + e.y, z + e.z);
  out.push(g2);

  // Nó do dedo (dá volume na articulação)
  const kn = new THREE.SphereGeometry(r * 1.05, 7, 5);
  place(kn, x + e.x, y + e.y, z + e.z);
  out.push(kn);
}

/**
 * Antebraço: cone truncado ao longo de -Z (para casar com `Object3D.lookAt`,
 * que aponta o -Z do objeto para o alvo). Fica separado da mão para poder
 * mirar no ombro sem torcer o punho.
 */
function buildForearmGeo(len = 0.30) {
  const g = [];
  const cuff = lathe([[0.0300, 0], [0.0370, 0.010], [0.0370, 0.034], [0.0305, 0.042], [0.0300, 0]], 14);
  g.push(cuff);
  const arm = lathe([
    [0.0272, 0.040], [0.0262, 0.10], [0.0280, len * 0.62],
    [0.0330, len * 0.90], [0.0350, len], [0.0, len + 0.005],
  ], 14);
  g.push(arm);
  const geo = fuse(g, 0.18, 0.24);
  geo.rotateY(Math.PI);   // avanço +Z do lathe (-Z do mundo) vira o eixo -Z local
  return geo;
}

/**
 * Mão enluvada fechando em torno de um punho.
 * Frame local: dedos saem em -Z e curvam para -Y (envolvem um eixo paralelo a X);
 * o punho fica em +Z.
 * `open` (0..1) relaxa os dedos — usado na mão de apoio.
 */
function buildHandGeo(opts = {}) {
  const { curl = 1.15, open = 0 } = opts;
  const g = [];

  // Palma levemente arqueada + dorso da luva
  const palm = box(0.052, 0.030, 0.086, 0.012, 0.005, 3);
  place(palm, 0, 0, -0.010);
  g.push(palm);
  const back = box(0.050, 0.012, 0.070, 0.010, 0.004, 3);
  place(back, 0, 0.016, -0.014);
  g.push(back);
  // Metacarpo (base dos dedos)
  const meta = box(0.050, 0.026, 0.030, 0.010, 0.004, 3);
  place(meta, 0, -0.002, -0.058);
  g.push(meta);
  // Almofada da palma (thenar)
  const pad = new THREE.SphereGeometry(0.017, 8, 6);
  pad.scale(0.8, 0.7, 1.25);
  place(pad, -0.017, -0.012, -0.020);
  g.push(pad);

  // 4 dedos alinhados em X, saindo em -Z
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const c = curl * (1 - open * (0.55 + 0.22 * t)) * (1 - t * 0.06);
    finger(g,
      0.031 - t * 0.005, 0.025 - t * 0.004, 0.0082 - t * 0.0009,
      c, -0.019 + i * 0.0128, -0.004 - t * 0.002, -0.070, (t - 0.5) * 0.10);
  }

  // Polegar: sai da lateral -X, cruza por baixo
  const tb = [];
  finger(tb, 0.030, 0.025, 0.0100, curl * 0.55 * (1 - open * 0.35), 0, 0, 0, 0);
  for (const gg of tb) { gg.rotateY(1.05); gg.rotateZ(-0.30); place(gg, -0.024, -0.012, -0.038); g.push(gg); }

  // Punho curto: o antebraço é uma peça à parte, mirada no ombro.
  const wrist = new THREE.CapsuleGeometry(0.024, 0.024, 3, 12);
  wrist.rotateX(HALF_PI);
  place(wrist, 0, 0, 0.044);
  g.push(wrist);

  return fuse(g, 0.24, 0.26);
}

/* ==================================================================== *
 * Peças compartilhadas
 * ==================================================================== */

/** Guarda-mato: aro fechado desenhado no plano lateral (z,y). */
function triggerGuard(out, zFront, zBack, yTop, yBot, thick = 0.007, width = 0.013) {
  const seg = 12;
  const cz = (zFront + zBack) * 0.5, rz = Math.abs(zBack - zFront) * 0.5;
  const cy = (yTop + yBot) * 0.5, ry = Math.abs(yTop - yBot) * 0.5;
  const outer = [], inner = [];
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI * (i / seg);
    outer.push([cz + Math.cos(a) * rz, cy - Math.sin(a) * ry]);
    inner.push([cz + Math.cos(a) * (rz - thick), cy - Math.sin(a) * (ry - thick)]);
  }
  const pts = outer.concat(inner.reverse());
  out.push(profileZY(pts, width, 0.0016, 1));
  return out;
}

/** Gatilho curvo. */
function triggerBlade(out, z, y, width = 0.0075) {
  const g = profileZY([
    [0.000, 0], [0.008, 0], [0.010, -0.011], [0.009, -0.021],
    [0.004, -0.027], [-0.002, -0.025], [0.000, -0.012],
  ], width, 0.0012, 2);
  place(g, 0, y, z);
  out.push(g);
  return out;
}

/** Massa de mira dentro de orelhas protetoras (o vão entre elas é o "furo"). */
function frontSight(out, y, scale = 1) {
  const s = scale;
  const base = profileBox([
    [-0.013 * s, 0], [0.013 * s, 0], [0.011 * s, 0.020 * s], [-0.011 * s, 0.020 * s],
  ], 0.024 * s, 0.0018, 1);
  place(base, 0, y - 0.030 * s, 0);
  out.push(base);
  for (const sd of [-1, 1]) {
    const ear = profileBox([
      [0.0048 * s * sd, 0], [0.0110 * s * sd, 0], [0.0110 * s * sd, 0.026 * s],
      [0.0080 * s * sd, 0.031 * s], [0.0048 * s * sd, 0.029 * s],
    ], 0.018 * s, 0.0012, 1);
    place(ear, 0, y - 0.030 * s, 0);
    out.push(ear);
  }
  const post = box(0.0024 * s, 0.014 * s, 0.0030 * s, 0.0006, 0.0004, 1);
  place(post, 0, y - 0.006 * s, 0);
  out.push(post);
  const tip = tube(0.0019 * s, 0.0019 * s, 0.0042 * s, 8);
  place(tip, 0, y, 0);
  out.push(tip);
  return out;
}

/** Alça de mira com abertura (aperture) real furada na geometria. */
function rearSight(out, y, scale = 1, bare = false) {
  const s = scale, seg = 14, rOut = 0.0074 * s, rIn = 0.0034 * s;
  const outer = [], hole = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * TAU;
    outer.push([Math.cos(a) * rOut, Math.sin(a) * rOut]);
  }
  for (let i = seg; i >= 0; i--) {
    const a = (i / seg) * TAU;
    hole.push([Math.cos(a) * rIn, Math.sin(a) * rIn]);
  }
  const g = profileBox(outer, 0.0045 * s, 0.0009, 1, [hole]);
  place(g, 0, y, 0.002);
  out.push(g);

  if (bare) {
    // Dentro da alça de transporte: só o disco da abertura e um pé curto.
    const foot = box(0.014 * s, 0.008 * s, 0.014 * s, 0.001, 0.0008, 1);
    place(foot, 0, y - 0.010 * s, 0.002);
    out.push(foot);
    return out;
  }
  const bs = profileBox([
    [-0.015 * s, 0], [0.015 * s, 0], [0.013 * s, 0.013 * s], [-0.013 * s, 0.013 * s],
  ], 0.020 * s, 0.0016, 1);
  place(bs, 0, y - 0.020 * s, 0.004);
  out.push(bs);
  for (const sd of [-1, 1]) {
    const ear = box(0.0036 * s, 0.020 * s, 0.015 * s, 0.0012, 0.0008, 1);
    place(ear, 0.0110 * s * sd, y - 0.003 * s, 0.003);
    out.push(ear);
  }
  const drum = tube(0.0055 * s, 0.0055 * s, 0.008 * s, 12);
  place(drum, -0.016 * s, y - 0.010 * s, 0.004, 0, HALF_PI, 0);
  out.push(drum);
  return out;
}

/** Carregador curvo, construído por seções ao longo de um arco. */
function curvedMag(out, len, w, d, curve, taper = 0.90) {
  const steps = 8, segLen = len / steps;
  let py = 0, pz = 0;
  for (let i = 0; i < steps; i++) {
    const a = ((i + 0.5) / steps) * curve;
    const dy = -Math.cos(a) * segLen, dz = -Math.sin(a) * segLen;
    const sc = 1 - (i / steps) * (1 - taper);
    const seg = box(w * sc, segLen + 0.0016, d * sc, 0.003, 0.0013, 2);
    place(seg, 0, py + dy * 0.5, pz + dz * 0.5, a, 0, 0);
    out.push(seg);
    py += dy; pz += dz;
  }
  const foot = box(w * taper * 1.15, 0.009, d * taper * 1.10, 0.002, 0.001, 2);
  place(foot, 0, py - 0.004 * Math.cos(curve), pz - 0.004 * Math.sin(curve), curve, 0, 0);
  out.push(foot);
  const lips = box(w * 1.05, 0.013, d * 1.02, 0.002, 0.001, 2);
  place(lips, 0, 0.005, 0);
  out.push(lips);
  // Costelas laterais (aquele reforço estampado do carregador)
  for (let i = 1; i < 4; i++) {
    const a = (i / steps) * curve;
    const rb = box(w * 1.03, 0.006, d * 0.55, 0.001, 0.0006, 1);
    place(rb, 0, -Math.cos(a) * len * (i / 4), -Math.sin(a) * len * (i / 4), a, 0, 0);
    out.push(rb);
  }
  return out;
}

/* ==================================================================== *
 * IA2 5,56 — fuzil do Exército Brasileiro
 * ==================================================================== */
function buildIA2(mats) {
  const metal = [], poly = [], rubber = [];
  const BORE = 0.052;
  // A linha de mira fica NO TOPO da alça de transporte (padrão M16/IA2).
  // Se a alça ficasse acima da mira, ela taparia a tela inteira em ADS.
  const SIGHT = 0.138;

  /* --- receiver --- */
  const upper = box(0.062, 0.066, 0.300, 0.010, 0.004, 3);
  place(upper, 0, BORE + 0.010, 0.028);
  metal.push(upper);
  // Aresta superior em trapézio: silhueta de fuzil, não de tijolo
  const upperTop = profileBox([
    [-0.031, 0], [0.031, 0], [0.023, 0.014], [-0.023, 0.014],
  ], 0.300, 0.0025, 1);
  place(upperTop, 0, BORE + 0.042, 0.028);
  metal.push(upperTop);

  const lower = profileZY([
    [-0.088, 0.020], [0.072, 0.020], [0.074, -0.030], [0.010, -0.036],
    [-0.030, -0.042], [-0.088, -0.038],
  ], 0.056, 0.0035, 2);
  place(lower, 0, BORE - 0.030, 0);
  poly.push(lower);

  // Poço do carregador com boca alargada
  const well = profileBox([
    [-0.016, -0.050], [0.016, -0.050], [0.021, 0.012], [-0.021, 0.012],
  ], 0.052, 0.0022, 1);
  place(well, 0, BORE - 0.052, -0.046);
  poly.push(well);

  // Janela de ejeção, tampa e defletor (lado direito)
  const port = box(0.005, 0.024, 0.052, 0.002, 0.001, 2);
  place(port, 0.031, BORE + 0.014, -0.030);
  metal.push(port);
  const cover = profileZY([
    [-0.030, -0.014], [0.028, -0.012], [0.028, 0.014], [-0.030, 0.012],
  ], 0.006, 0.0015, 2);
  place(cover, 0.034, BORE + 0.014, -0.030, 0, 0, -0.05);
  metal.push(cover);
  const defl = profileBox([[0, 0], [0.013, 0.005], [0.013, 0.019], [0, 0.017]], 0.020, 0.0015, 1);
  place(defl, 0.030, BORE + 0.014, 0.006);
  metal.push(defl);

  // Seletor de tiro (esquerda)
  const selAxis = tube(0.0068, 0.0068, 0.014, 12);
  place(selAxis, -0.030, BORE - 0.026, -0.006, 0, HALF_PI, 0);
  metal.push(selAxis);
  const selLever = profileBox([
    [-0.0045, 0], [0.0045, 0], [0.0055, 0.021], [-0.0055, 0.021],
  ], 0.006, 0.0012, 1);
  place(selLever, -0.038, BORE - 0.026, -0.006, 0, HALF_PI, -0.95);
  poly.push(selLever);

  // Retentor do carregador e do ferrolho
  const relBtn = tube(0.005, 0.005, 0.013, 10);
  place(relBtn, 0.030, BORE - 0.026, -0.046, 0, HALF_PI, 0);
  metal.push(relBtn);
  const boltCatch = box(0.005, 0.015, 0.022, 0.002, 0.001, 1);
  place(boltCatch, -0.031, BORE - 0.022, -0.040);
  metal.push(boltCatch);

  /* --- guarda-mão: aletas com vãos + anéis --- */
  const hgZ0 = -0.140, hgZ1 = -0.392;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + 0.45;
    const rr = 0.0295;
    const slat = box(0.014, 0.011, Math.abs(hgZ1 - hgZ0), 0.003, 0.0016, 2);
    place(slat, Math.cos(a) * rr, BORE + Math.sin(a) * rr, (hgZ0 + hgZ1) * 0.5, 0, 0, a + HALF_PI);
    poly.push(slat);
  }
  for (const z of [hgZ0 - 0.005, (hgZ0 + hgZ1) * 0.5, hgZ1 + 0.007]) {
    const r = lathe([
      [0.0255, -0.008], [0.0335, -0.007], [0.0345, 0], [0.0335, 0.007],
      [0.0255, 0.008], [0.0255, -0.008],
    ], 16);
    place(r, 0, BORE, z);
    poly.push(r);
  }
  { const t = []; picatinny(t, 0.098, 0.019); for (const g of t) { place(g, 0, BORE - 0.030, -0.300, Math.PI, 0, 0); metal.push(g); } }
  { const t = []; picatinny(t, 0.400, 0.021); for (const g of t) { place(g, 0, BORE + 0.052, -0.110); metal.push(g); } }

  /* --- cano, bloco de gás, quebra-chamas --- */
  const barrel = lathe([
    [0.0140, -0.020], [0.0140, 0.020], [0.0118, 0.030], [0.0114, 0.140],
    [0.0130, 0.160], [0.0130, 0.192], [0.0100, 0.202], [0.0098, 0.300],
    [0.0108, 0.318], [0.0108, 0.350],
  ], 18);
  place(barrel, 0, BORE, -0.130);
  metal.push(barrel);

  const gasBlock = profileBox([
    [-0.014, -0.013], [0.014, -0.013], [0.014, 0.016], [0.008, 0.023],
    [-0.008, 0.023], [-0.014, 0.016],
  ], 0.030, 0.0018, 1);
  place(gasBlock, 0, BORE, -0.408);
  metal.push(gasBlock);
  const gasTube = tube(0.0035, 0.0035, 0.265, 8);
  place(gasTube, 0, BORE + 0.020, -0.276);
  metal.push(gasTube);

  // Quebra-chamas tipo birdcage: corpo torneado + 4 dentes (os vãos são os rasgos)
  const fh = lathe([
    [0.0108, 0], [0.0132, 0.004], [0.0132, 0.013], [0.0114, 0.015],
    [0.0150, 0.019], [0.0150, 0.056], [0.0132, 0.060], [0.0132, 0.066],
    [0.0078, 0.066], [0.0078, 0],
  ], 18);
  place(fh, 0, BORE, -0.498);
  metal.push(fh);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.42;
    const tooth = box(0.0080, 0.0075, 0.032, 0.0012, 0.0008, 1);
    place(tooth, Math.cos(a) * 0.0120, BORE + Math.sin(a) * 0.0120, -0.535, 0, 0, a);
    metal.push(tooth);
  }

  /* --- alça de transporte com a alça de mira integrada --- */
  const HB = BORE + 0.056;   // base da alça, em cima do trilho
  for (const s of [-1, 1]) {
    const wall = profileZY([
      [0.046, 0.000], [-0.096, 0.000], [-0.096, 0.030],
      [-0.074, 0.044], [0.026, 0.044], [0.046, 0.028],
    ], 0.0055, 0.0016, 2);
    place(wall, 0.0158 * s, HB, 0);
    metal.push(wall);
  }
  const handleTop = profileZY([
    [0.040, 0.000], [-0.092, 0.000], [-0.092, 0.010], [0.040, 0.010],
  ], 0.040, 0.0022, 2);
  place(handleTop, 0, HB + 0.042, 0);
  metal.push(handleTop);
  // Rebaixo do vão da alça (o "furo" onde a mão entra) é o espaço entre paredes.

  /* --- ferros de mira --- */
  { const t = []; rearSight(t, SIGHT, 0.78, true); for (const g of t) { place(g, 0, 0, 0.030); metal.push(g); } }
  { const t = []; frontSight(t, SIGHT); for (const g of t) { place(g, 0, 0, -0.430); metal.push(g); } }
  // Torre da massa de mira, do bloco de gás até a base da mira
  const fsTower = profileBox([
    [-0.013, 0], [0.013, 0], [0.011, 0.040], [-0.011, 0.040],
  ], 0.026, 0.0018, 1);
  place(fsTower, 0, BORE + 0.018, -0.430);
  metal.push(fsTower);

  /* --- punho, gatilho, guarda-mato --- */
  const grip = profileZY([
    [0.020, 0.006], [-0.018, 0.006], [-0.030, -0.048], [-0.036, -0.096],
    [-0.020, -0.128], [0.004, -0.126], [0.010, -0.086], [0.020, -0.030],
  ], 0.034, 0.003, 2);
  place(grip, 0, BORE - 0.048, 0.000);
  poly.push(grip);
  for (let i = 0; i < 3; i++) {
    const rg = ring(0.0175, 0.0027, 0.55, 12);
    place(rg, 0, BORE - 0.076 - i * 0.022, 0.006 + i * 0.008, 0.30, 0, 0);
    rubber.push(rg);
  }
  const gripCap = box(0.030, 0.009, 0.030, 0.003, 0.0015, 2);
  place(gripCap, 0, BORE - 0.176, 0.014, 0.30, 0, 0);
  rubber.push(gripCap);

  triggerGuard(poly, -0.076, -0.010, BORE - 0.018, BORE - 0.078, 0.0075, 0.014);
  triggerBlade(metal, -0.040, BORE - 0.026);

  /* --- coronha retrátil --- */
  const bufferTube = lathe([
    [0.0195, 0], [0.0195, -0.020], [0.0180, -0.026], [0.0180, -0.200],
    [0.0195, -0.206], [0.0195, -0.216],
  ], 16);
  place(bufferTube, 0, BORE + 0.006, 0.052);
  metal.push(bufferTube);
  for (let i = 0; i < 5; i++) {
    const n = box(0.0105, 0.005, 0.0090, 0.001, 0.0006, 1);
    place(n, 0, BORE - 0.012, 0.092 + i * 0.024);
    metal.push(n);
  }
  const stockBody = profileZY([
    [-0.055, 0.030], [0.048, 0.030], [0.060, -0.004], [0.056, -0.032],
    [-0.030, -0.038], [-0.055, -0.012],
  ], 0.048, 0.004, 2);
  place(stockBody, 0, BORE + 0.006, 0.180);
  poly.push(stockBody);
  const cheek = profileZY([
    [-0.058, 0], [0.052, 0], [0.046, 0.017], [-0.052, 0.015],
  ], 0.028, 0.003, 2);
  place(cheek, 0, BORE + 0.036, 0.178);
  poly.push(cheek);
  const buttPad = profileZY([
    [-0.008, 0.036], [0.008, 0.042], [0.008, -0.032], [-0.008, -0.038],
  ], 0.046, 0.003, 2);
  place(buttPad, 0, BORE + 0.004, 0.244);
  rubber.push(buttPad);
  const stockLever = box(0.014, 0.011, 0.042, 0.002, 0.001, 1);
  place(stockLever, 0, BORE - 0.028, 0.190);
  poly.push(stockLever);

  /* --- pontos de bandoleira --- */
  for (const [x, y, z] of [[-0.030, BORE - 0.016, 0.046], [0, BORE - 0.030, -0.372]]) {
    const loop = new THREE.TorusGeometry(0.0078, 0.0022, 5, 10);
    place(loop, x, y, z, 0, HALF_PI, 0);
    metal.push(loop);
  }

  /* --- peças animadas --- */
  const magGeos = [];
  curvedMag(magGeos, 0.140, 0.026, 0.048, 0.36);
  const magMesh = new THREE.Mesh(fuse(magGeos, 0.55, 0.30), mats.polymer);
  magMesh.name = 'mag';
  magMesh.position.set(0, BORE - 0.062, -0.046);

  const boltGeos = [];
  const bh = box(0.011, 0.015, 0.032, 0.002, 0.001, 2);
  place(bh, 0.030, BORE + 0.044, 0.040);
  boltGeos.push(bh);
  const bhBar = box(0.052, 0.008, 0.017, 0.002, 0.001, 1);
  place(bhBar, 0.010, BORE + 0.044, 0.050);
  boltGeos.push(bhBar);
  const boltMesh = new THREE.Mesh(fuse(boltGeos, 0.75, 0.14), mats.metal);
  boltMesh.name = 'bolt';

  const group = new THREE.Group();
  group.name = 'ia2';
  group.add(new THREE.Mesh(fuse(metal, 0.62, 0.20), mats.metal));
  group.add(new THREE.Mesh(fuse(poly, 0.30, 0.26), mats.polymer));
  group.add(new THREE.Mesh(fuse(rubber, 0.16, 0.30), mats.rubber));
  group.add(magMesh, boltMesh);

  return {
    group,
    meta: {
      sightRear: new THREE.Vector3(0, SIGHT, 0.032),
      sightFront: new THREE.Vector3(0, SIGHT, -0.430),
      muzzle: new THREE.Vector3(0, BORE, -0.566),
      ejectPort: new THREE.Vector3(0.042, BORE + 0.014, -0.030),
      gripR: new THREE.Vector3(0.030, BORE - 0.104, 0.037),
      gripRRot: [0.10, 0.02, -HALF_PI + 0.26],
      gripL: new THREE.Vector3(-0.044, BORE + 0.027, -0.249),
      gripLRot: [0.05, -HALF_PI + 0.10, -0.45],
      shoulderR: new THREE.Vector3(0.14, -0.30, 0.48),
      shoulderL: new THREE.Vector3(-0.24, -0.32, 0.30),
      magRest: magMesh.position.clone(),
      boltTravel: 0.058,
      mag: magMesh, bolt: boltMesh,
    },
  };
}

/* ==================================================================== *
 * Taurus SMT-40 — submetralhadora .40
 * ==================================================================== */
function buildSMT40(mats) {
  const metal = [], poly = [], rubber = [];
  const BORE = 0.046;
  // Miras montadas SOBRE o trilho: nada da arma cruza a linha de mira.
  const SIGHT = 0.112;

  const body = box(0.056, 0.058, 0.240, 0.014, 0.005, 3);
  place(body, 0, BORE + 0.008, 0.018);
  poly.push(body);
  const bodyTop = profileBox([
    [-0.028, 0], [0.028, 0], [0.019, 0.011], [-0.019, 0.011],
  ], 0.240, 0.0025, 1);
  place(bodyTop, 0, BORE + 0.036, 0.018);
  poly.push(bodyTop);
  const chassis = box(0.060, 0.028, 0.150, 0.004, 0.002, 2);
  place(chassis, 0, BORE - 0.004, -0.004);
  metal.push(chassis);

  const port = box(0.005, 0.020, 0.046, 0.002, 0.001, 2);
  place(port, 0.029, BORE + 0.014, -0.040);
  metal.push(port);

  { const t = []; picatinny(t, 0.205, 0.020); for (const g of t) { place(g, 0, BORE + 0.042, -0.030); metal.push(g); } }

  // Cano curto + protetor ventilado + compensador
  const barrel = lathe([
    [0.0110, -0.02], [0.0110, 0.02], [0.0094, 0.026], [0.0094, 0.120],
    [0.0108, 0.130], [0.0108, 0.146],
  ], 16);
  place(barrel, 0, BORE, -0.098);
  metal.push(barrel);
  const shroud = lathe([
    [0.0165, 0], [0.0205, 0.005], [0.0205, 0.068], [0.0165, 0.073], [0.0165, 0],
  ], 16);
  place(shroud, 0, BORE, -0.108);
  metal.push(shroud);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    for (let j = 0; j < 3; j++) {
      const pin = box(0.0055, 0.0055, 0.011, 0.001, 0.0006, 1);
      place(pin, Math.cos(a) * 0.0195, BORE + Math.sin(a) * 0.0195, -0.126 - j * 0.020, 0, 0, a);
      metal.push(pin);
    }
  }
  const comp = lathe([
    [0.0108, 0], [0.0148, 0.003], [0.0148, 0.028], [0.0108, 0.031],
    [0.0074, 0.031], [0.0074, 0],
  ], 16);
  place(comp, 0, BORE, -0.222);
  metal.push(comp);
  for (let i = 0; i < 3; i++) {
    const slot = box(0.028, 0.0045, 0.006, 0.001, 0.0005, 1);
    place(slot, 0, BORE + 0.012, -0.230 - i * 0.008);
    metal.push(slot);
  }

  { const t = []; rearSight(t, SIGHT, 0.9); for (const g of t) { place(g, 0, 0, -0.052); metal.push(g); } }
  { const t = []; frontSight(t, SIGHT, 0.9); for (const g of t) { place(g, 0, 0, -0.212); metal.push(g); } }

  // Punho de pistola
  const grip = profileZY([
    [0.018, 0.004], [-0.016, 0.004], [-0.026, -0.042], [-0.032, -0.090],
    [-0.018, -0.116], [0.002, -0.112], [0.008, -0.072], [0.018, -0.026],
  ], 0.032, 0.003, 2);
  place(grip, 0, BORE - 0.022, 0.004);
  poly.push(grip);
  for (let i = 0; i < 3; i++) {
    const rg = ring(0.0160, 0.0025, 0.55, 12);
    place(rg, 0, BORE - 0.050 - i * 0.021, 0.010 + i * 0.007, 0.30, 0, 0);
    rubber.push(rg);
  }
  triggerGuard(poly, -0.062, -0.004, BORE - 0.002, BORE - 0.058, 0.007, 0.013);
  triggerBlade(metal, -0.032, BORE - 0.010);

  // Punho vertical dianteiro
  const fgrip = lathe([
    [0.0170, 0], [0.0195, 0.012], [0.0180, 0.052], [0.0165, 0.086],
    [0.0205, 0.098], [0.0, 0.105],
  ], 14);
  place(fgrip, 0, BORE - 0.028, -0.148, -HALF_PI + 0.20, 0, 0);
  poly.push(fgrip);
  for (let i = 0; i < 4; i++) {
    const rg = ring(0.0185, 0.0023, 0.7, 14);
    place(rg, 0, BORE - 0.048 - i * 0.019, -0.148 + i * 0.004);
    rubber.push(rg);
  }

  // Carregador quase reto (.40) à frente do gatilho
  const magGeos = [];
  curvedMag(magGeos, 0.128, 0.024, 0.040, 0.12);
  const magMesh = new THREE.Mesh(fuse(magGeos, 0.50, 0.30), mats.polymer);
  magMesh.name = 'mag';
  magMesh.position.set(0, BORE - 0.026, -0.084);
  const well = profileBox([
    [-0.015, -0.028], [0.015, -0.028], [0.018, 0.012], [-0.018, 0.012],
  ], 0.046, 0.002, 1);
  place(well, 0, BORE - 0.026, -0.084);
  poly.push(well);

  // Coronha lateral esqueletada
  for (const s of [-1, 1]) {
    const rail = tube(0.0072, 0.0072, 0.158, 10);
    place(rail, 0.021 * s, BORE + 0.008, 0.190);
    metal.push(rail);
  }
  const butt = profileZY([
    [-0.007, 0.032], [0.007, 0.036], [0.007, -0.028], [-0.007, -0.032],
  ], 0.058, 0.003, 2);
  place(butt, 0, BORE + 0.008, 0.262);
  rubber.push(butt);
  const cross = box(0.058, 0.012, 0.015, 0.002, 0.001, 1);
  place(cross, 0, BORE + 0.008, 0.150);
  metal.push(cross);

  const selAxis = tube(0.006, 0.006, 0.013, 10);
  place(selAxis, -0.028, BORE - 0.004, -0.014, 0, HALF_PI, 0);
  metal.push(selAxis);
  const selLever = box(0.005, 0.019, 0.007, 0.0012, 0.0008, 1);
  place(selLever, -0.034, BORE - 0.013, -0.014, 0, 0, -0.62);
  poly.push(selLever);

  const boltGeos = [];
  const ch = box(0.014, 0.013, 0.027, 0.0025, 0.0012, 2);
  place(ch, -0.032, BORE + 0.022, -0.050);
  boltGeos.push(ch);
  const chBar = box(0.014, 0.008, 0.014, 0.002, 0.001, 1);
  place(chBar, -0.023, BORE + 0.022, -0.050);
  boltGeos.push(chBar);
  const boltMesh = new THREE.Mesh(fuse(boltGeos, 0.75, 0.14), mats.metal);
  boltMesh.name = 'bolt';

  const group = new THREE.Group();
  group.name = 'smt40';
  group.add(new THREE.Mesh(fuse(metal, 0.60, 0.20), mats.metal));
  group.add(new THREE.Mesh(fuse(poly, 0.28, 0.26), mats.polymer));
  group.add(new THREE.Mesh(fuse(rubber, 0.14, 0.30), mats.rubber));
  group.add(magMesh, boltMesh);

  return {
    group,
    meta: {
      sightRear: new THREE.Vector3(0, SIGHT, -0.048),
      sightFront: new THREE.Vector3(0, SIGHT, -0.212),
      muzzle: new THREE.Vector3(0, BORE, -0.256),
      ejectPort: new THREE.Vector3(0.038, BORE + 0.014, -0.040),
      gripR: new THREE.Vector3(0.030, BORE - 0.075, 0.043),
      gripRRot: [0.10, 0.02, -HALF_PI + 0.26],
      gripL: new THREE.Vector3(-0.028, BORE - 0.076, -0.103),
      gripLRot: [0.10, 0.02, HALF_PI - 0.30],
      shoulderR: new THREE.Vector3(0.14, -0.30, 0.44),
      shoulderL: new THREE.Vector3(-0.24, -0.34, 0.26),
      magRest: magMesh.position.clone(),
      boltTravel: 0.046,
      mag: magMesh, bolt: boltMesh,
    },
  };
}

/* ==================================================================== *
 * Taurus PT-92 — pistola 9 mm
 * ==================================================================== */
function buildPT92(mats) {
  const metal = [], poly = [], rubber = [];
  const BORE = 0.028;
  const SIGHT = 0.052;

  // Armação
  const frame = profileZY([
    [0.052, 0.012], [-0.070, 0.012], [-0.078, -0.006], [-0.062, -0.020],
    [-0.030, -0.028], [-0.020, -0.014], [0.010, -0.012], [0.052, -0.010],
  ], 0.026, 0.003, 2);
  place(frame, 0, BORE - 0.014, 0);
  metal.push(frame);
  const dustCover = profileZY([
    [-0.010, 0.006], [-0.108, 0.006], [-0.108, -0.010], [-0.010, -0.008],
  ], 0.024, 0.0025, 2);
  place(dustCover, 0, BORE - 0.020, 0);
  metal.push(dustCover);

  // Ferrolho (peça animada)
  const slideGeos = [];
  const slide = box(0.026, 0.028, 0.175, 0.005, 0.0025, 3);
  place(slide, 0, BORE + 0.006, -0.026);
  slideGeos.push(slide);
  for (const s of [-1, 1]) {
    const rail = box(0.0072, 0.013, 0.108, 0.002, 0.001, 2);
    place(rail, 0.0094 * s, BORE + 0.023, -0.058);
    slideGeos.push(rail);
  }
  const slideFront = lathe([
    [0.0136, 0], [0.0136, 0.018], [0.0106, 0.022], [0.0106, 0], [0.0136, 0],
  ], 14);
  place(slideFront, 0, BORE + 0.006, -0.100);
  slideGeos.push(slideFront);
  // Serrilhado traseiro e dianteiro do ferrolho
  for (let i = 0; i < 8; i++) {
    const gr = box(0.028, 0.024, 0.0034, 0.0006, 0.0004, 1);
    place(gr, 0, BORE + 0.006, 0.034 - i * 0.0072);
    slideGeos.push(gr);
  }
  for (let i = 0; i < 5; i++) {
    const gr = box(0.028, 0.021, 0.0030, 0.0006, 0.0004, 1);
    place(gr, 0, BORE + 0.005, -0.070 - i * 0.0068);
    slideGeos.push(gr);
  }
  // Chanfro frontal do ferrolho (o \"nariz\" da Beretta)
  const noseCut = profileZY([
    [-0.086, 0.010], [-0.104, 0.002], [-0.104, -0.012], [-0.086, -0.012],
  ], 0.024, 0.0018, 2);
  place(noseCut, 0, BORE + 0.012, 0);
  slideGeos.push(noseCut);
  // Janela de ejeção aberta no ferrolho (vão entre dois blocos laterais)
  for (const s of [-1, 1]) {
    const w = box(0.005, 0.016, 0.052, 0.0012, 0.0008, 1);
    place(w, 0.0108 * s, BORE + 0.014, -0.014);
    slideGeos.push(w);
  }
  { const t = []; rearSight(t, SIGHT, 0.62); for (const g of t) { place(g, 0, 0.008, 0.042); slideGeos.push(g); } }
  const fpost = profileBox([
    [-0.0036, 0], [0.0036, 0], [0.0022, 0.011], [-0.0022, 0.011],
  ], 0.010, 0.0008, 1);
  place(fpost, 0, SIGHT - 0.004, -0.096);
  slideGeos.push(fpost);
  const slideMesh = new THREE.Mesh(fuse(slideGeos, 0.75, 0.16), mats.metal);
  slideMesh.name = 'bolt';

  // Cão exposto (fica na armação)
  const hammer = profileZY([
    [0.000, 0], [0.011, 0.002], [0.013, 0.018], [0.004, 0.022], [-0.004, 0.014],
  ], 0.007, 0.0012, 2);
  place(hammer, 0, BORE + 0.006, 0.046);
  metal.push(hammer);

  // Cano visível pela abertura do ferrolho
  const barrel = lathe([
    [0.0092, -0.02], [0.0092, 0.055], [0.0112, 0.060], [0.0112, 0.072], [0.0076, 0.072]
  ], 14);
  place(barrel, 0, BORE + 0.008, -0.046);
  metal.push(barrel);

  // Punho + talas serrilhadas
  const gripCore = profileZY([
    [0.028, 0.000], [-0.010, 0.000], [-0.012, -0.052], [-0.008, -0.098],
    [0.024, -0.096], [0.030, -0.046],
  ], 0.030, 0.003, 2);
  place(gripCore, 0, BORE - 0.028, 0.010);
  metal.push(gripCore);
  for (const s of [-1, 1]) {
    const panel = profileZY([
      [0.026, -0.002], [-0.008, -0.002], [-0.010, -0.050], [-0.006, -0.090],
      [0.022, -0.088], [0.026, -0.044],
    ], 0.005, 0.0012, 2);
    place(panel, 0.0163 * s, BORE - 0.028, 0.010);
    poly.push(panel);
    for (let i = 0; i < 6; i++) {
      const line = box(0.0034, 0.0034, 0.026, 0.0006, 0.0004, 1);
      place(line, 0.0185 * s, BORE - 0.044 - i * 0.012, 0.014 + i * 0.0035, 0, 0.28 * s, 0);
      poly.push(line);
    }
  }
  const backstrap = profileZY([
    [0.032, 0.000], [0.026, -0.004], [0.020, -0.096], [0.030, -0.098],
  ], 0.028, 0.002, 2);
  place(backstrap, 0, BORE - 0.028, 0.010);
  rubber.push(backstrap);

  triggerGuard(metal, -0.056, -0.004, BORE - 0.014, BORE - 0.062, 0.0065, 0.013);
  triggerBlade(metal, -0.028, BORE - 0.020, 0.0068);

  const safety = tube(0.007, 0.007, 0.011, 10);
  place(safety, -0.018, BORE + 0.004, 0.028, 0, HALF_PI, 0);
  metal.push(safety);
  const safetyLever = box(0.005, 0.009, 0.023, 0.0012, 0.0008, 1);
  place(safetyLever, -0.023, BORE + 0.002, 0.034);
  metal.push(safetyLever);
  const magBtn = tube(0.0052, 0.0052, 0.011, 10);
  place(magBtn, 0.017, BORE - 0.026, -0.010, 0, HALF_PI, 0);
  metal.push(magBtn);
  const takedown = tube(0.006, 0.006, 0.027, 10);
  place(takedown, 0, BORE - 0.014, -0.050, 0, HALF_PI, 0);
  metal.push(takedown);
  // Trilho de acessório sob o guarda-pó
  { const t = []; picatinny(t, 0.052, 0.016); for (const g of t) { place(g, 0, BORE - 0.026, -0.078, Math.PI, 0, 0); metal.push(g); } }
  // Alça de fiel e pino do cão
  const lanyard = new THREE.TorusGeometry(0.005, 0.0016, 5, 10);
  place(lanyard, 0, BORE - 0.128, 0.030, 0, HALF_PI, 0);
  metal.push(lanyard);
  const hammerPin = tube(0.0042, 0.0042, 0.026, 10);
  place(hammerPin, 0, BORE - 0.004, 0.036, 0, HALF_PI, 0);
  metal.push(hammerPin);
  // Guarda-mato com gancho frontal (apoio do dedo da mão de apoio)
  const guardHook = profileZY([
    [-0.050, -0.024], [-0.062, -0.030], [-0.062, -0.040], [-0.046, -0.038],
  ], 0.013, 0.0015, 2);
  place(guardHook, 0, BORE, 0);
  metal.push(guardHook);

  // Carregador dentro do punho
  const magGeos = [];
  const magBody = profileZY([
    [0.024, 0], [-0.006, 0], [-0.008, -0.050], [-0.004, -0.092],
    [0.020, -0.090], [0.024, -0.044],
  ], 0.023, 0.002, 2);
  magGeos.push(magBody);
  const magFoot = box(0.030, 0.008, 0.034, 0.002, 0.001, 2);
  place(magFoot, 0, -0.094, 0.008);
  magGeos.push(magFoot);
  const magMesh = new THREE.Mesh(fuse(magGeos, 0.50, 0.28), mats.metalDark);
  magMesh.name = 'mag';
  magMesh.position.set(0, BORE - 0.030, 0.010);

  const group = new THREE.Group();
  group.name = 'pt92';
  group.add(new THREE.Mesh(fuse(metal, 0.70, 0.18), mats.metal));
  group.add(new THREE.Mesh(fuse(poly, 0.26, 0.26), mats.polymer));
  group.add(new THREE.Mesh(fuse(rubber, 0.14, 0.30), mats.rubber));
  group.add(magMesh, slideMesh);

  return {
    group,
    meta: {
      sightRear: new THREE.Vector3(0, SIGHT + 0.0080, 0.044),
      sightFront: new THREE.Vector3(0, SIGHT + 0.0070, -0.096),
      muzzle: new THREE.Vector3(0, BORE + 0.008, -0.120),
      ejectPort: new THREE.Vector3(0.024, BORE + 0.018, -0.010),
      gripR: new THREE.Vector3(0.030, BORE - 0.074, 0.063),
      gripRRot: [0.10, 0.02, -HALF_PI + 0.22],
      gripL: new THREE.Vector3(-0.036, BORE - 0.086, 0.052),
      gripLRot: [0.10, 0.02, HALF_PI - 0.42],
      shoulderR: new THREE.Vector3(0.14, -0.28, 0.42),
      shoulderL: new THREE.Vector3(-0.18, -0.30, 0.34),
      magRest: magMesh.position.clone(),
      boltTravel: 0.030,
      mag: magMesh, bolt: slideMesh,
    },
  };
}

/* ==================================================================== *
 * API pública
 * ==================================================================== */

/* ==================================================================== *
 * IMBEL AGLC .308 — fuzil de precisão de ferrolho.
 *
 * A luneta é a peça que define a silhueta, então ela ganha altura real
 * (linha de mira 4,5 cm acima do cano) e anéis de montagem visíveis. O ADS
 * alinha a LUNETA, não ferro de mira: `sightRear/sightFront` apontam para o
 * eixo óptico do tubo.
 * ==================================================================== */
function buildAGLC(mats) {
  const metal = [], poly = [], rubber = [];
  const BORE = 0.052;
  const OPTICA = BORE + 0.045;      // eixo da luneta

  /* --- receiver longo e pesado --- */
  const upper = box(0.056, 0.062, 0.340, 0.008, 0.004, 3);
  place(upper, 0, BORE + 0.008, 0.030);
  metal.push(upper);

  // trilho picatinny com ranhuras
  const trilho = box(0.030, 0.010, 0.240, 0.0015, 0.001, 1);
  place(trilho, 0, BORE + 0.043, 0.020);
  metal.push(trilho);
  for (let i = 0; i < 12; i++) {
    const r = box(0.031, 0.005, 0.006, 0.0008, 0.0005, 1);
    place(r, 0, BORE + 0.044, -0.088 + i * 0.019);
    metal.push(r);
  }

  /* --- cano pesado com estrias e quebra-chamas --- */
  const canoBase = tube(0.0135, 0.0135, 0.230, 20);
  place(canoBase, 0, BORE, -0.245, HALF_PI);
  metal.push(canoBase);
  const canoFino = tube(0.0112, 0.0112, 0.240, 20);
  place(canoFino, 0, BORE, -0.478, HALF_PI);
  metal.push(canoFino);
  // caneluras de refrigeração
  for (let i = 0; i < 5; i++) {
    const c = tube(0.0142, 0.0142, 0.012, 18);
    place(c, 0, BORE, -0.180 - i * 0.040, HALF_PI);
    metal.push(c);
  }
  // freio de boca com dois rasgos laterais
  const freio = tube(0.0165, 0.0165, 0.062, 18);
  place(freio, 0, BORE, -0.628, HALF_PI);
  metal.push(freio);
  for (const s of [-1, 1]) {
    const rasgo = box(0.008, 0.020, 0.030, 0.001, 0.0008, 1);
    place(rasgo, s * 0.014, BORE + 0.004, -0.628);
    metal.push(rasgo);
  }

  /* --- luneta: tubo + objetiva + ocular + anéis --- */
  const tubo = tube(0.0165, 0.0165, 0.185, 20);
  place(tubo, 0, OPTICA, -0.040, HALF_PI);
  metal.push(tubo);
  const objetiva = tube(0.0235, 0.0235, 0.058, 22);
  place(objetiva, 0, OPTICA, -0.150, HALF_PI);
  metal.push(objetiva);
  const ocular = tube(0.0205, 0.0205, 0.046, 22);
  place(ocular, 0, OPTICA, 0.070, HALF_PI);
  metal.push(ocular);
  // torres de ajuste
  const torreC = tube(0.0105, 0.0105, 0.026, 14);
  place(torreC, 0, OPTICA + 0.022, -0.052, 0, 0, 0);
  metal.push(torreC);
  const torreL = tube(0.0095, 0.0095, 0.024, 14);
  place(torreL, 0.021, OPTICA, -0.052, 0, 0, HALF_PI);
  metal.push(torreL);
  // anéis de montagem
  for (const z of [-0.096, 0.020]) {
    const anel = tube(0.0195, 0.0195, 0.016, 18);
    place(anel, 0, OPTICA, z, HALF_PI);
    metal.push(anel);
    const perna = box(0.024, 0.030, 0.015, 0.002, 0.001, 1);
    place(perna, 0, OPTICA - 0.028, z);
    metal.push(perna);
  }

  /* --- coronha com apoio de face e cepo --- */
  const coronha = profileZY([
    [0.055, 0.030], [0.250, 0.026], [0.252, -0.030], [0.180, -0.048],
    [0.090, -0.052], [0.055, -0.040],
  ], 0.048, 0.004, 2);
  place(coronha, 0, BORE - 0.004, 0);
  poly.push(coronha);
  const face = box(0.046, 0.026, 0.130, 0.006, 0.003, 2);
  place(face, 0, BORE + 0.038, 0.128);
  poly.push(face);
  const cepo = box(0.050, 0.070, 0.026, 0.008, 0.004, 2);
  place(cepo, 0, BORE - 0.014, 0.264);
  rubber.push(cepo);

  /* --- punho de pistola e guarda-mato --- */
  const punho = profileZY([
    [0.020, -0.020], [0.052, -0.026], [0.060, -0.120], [0.020, -0.126],
  ], 0.040, 0.004, 2);
  place(punho, 0, BORE - 0.030, 0.030);
  poly.push(punho);
  const guarda = profileZY([
    [-0.030, -0.020], [0.020, -0.020], [0.020, -0.052], [-0.030, -0.052],
  ], 0.030, 0.002, 1);
  place(guarda, 0, BORE - 0.030, -0.010);
  metal.push(guarda);

  /* --- carregador reto de 5 tiros --- */
  const magGeos = [];
  const corpoMag = box(0.028, 0.086, 0.056, 0.004, 0.002, 2);
  place(corpoMag, 0, -0.048, 0);
  magGeos.push(corpoMag);
  const magMesh = new THREE.Mesh(fuse(magGeos, 0.42, 0.24), mats.polymer);
  magMesh.name = 'mag';
  magMesh.position.set(0, BORE - 0.026, -0.052);

  /* --- ferrolho lateral (bolt-action) --- */
  const boltGeos = [];
  const haste = tube(0.0075, 0.0075, 0.060, 12);
  place(haste, 0.040, BORE + 0.014, 0.070, 0, 0, HALF_PI);
  boltGeos.push(haste);
  const bola = tube(0.0135, 0.0135, 0.020, 14);
  place(bola, 0.068, BORE + 0.014, 0.070, 0, 0, HALF_PI);
  boltGeos.push(bola);
  const boltMesh = new THREE.Mesh(fuse(boltGeos, 0.7, 0.16), mats.metal);
  boltMesh.name = 'bolt';

  /* --- bipé recolhido sob o guarda-mão --- */
  for (const s of [-1, 1]) {
    const perna = tube(0.0055, 0.0055, 0.135, 10);
    place(perna, s * 0.012, BORE - 0.020, -0.330, 0, 0, s * 0.12);
    metal.push(perna);
  }

  const group = new THREE.Group();
  group.name = 'aglc';
  group.add(new THREE.Mesh(fuse(metal, 0.66, 0.22), mats.metal));
  group.add(new THREE.Mesh(fuse(poly, 0.30, 0.28), mats.polymer));
  group.add(new THREE.Mesh(fuse(rubber, 0.16, 0.32), mats.rubber));
  group.add(magMesh, boltMesh);

  return {
    group,
    meta: {
      // ADS alinha o EIXO DA LUNETA, não ferro de mira
      sightRear: new THREE.Vector3(0, OPTICA, 0.086),
      sightFront: new THREE.Vector3(0, OPTICA, -0.170),
      muzzle: new THREE.Vector3(0, BORE, -0.660),
      ejectPort: new THREE.Vector3(0.034, BORE + 0.014, 0.040),
      gripR: new THREE.Vector3(0.030, BORE - 0.098, 0.052),
      gripRRot: [0.10, 0.02, -HALF_PI + 0.24],
      gripL: new THREE.Vector3(-0.040, BORE + 0.010, -0.300),
      gripLRot: [0.05, -HALF_PI + 0.08, -0.42],
      shoulderR: new THREE.Vector3(0.14, -0.30, 0.50),
      shoulderL: new THREE.Vector3(-0.22, -0.32, 0.26),
      magRest: magMesh.position.clone(),
      boltTravel: 0.075,
      mag: magMesh, bolt: boltMesh,
    },
  };
}

const BUILDERS = { ia2: buildIA2, smt40: buildSMT40, pt92: buildPT92, aglc: buildAGLC };

/** Soma de triângulos de um Object3D. */
export function countTriangles(obj) {
  let t = 0;
  obj.traverse((o) => {
    const g = o.geometry;
    if (!g) return;
    t += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  return Math.round(t);
}

/**
 * Constrói a arma `id` com as mãos posicionadas nos punhos.
 * Retorna `{ group, meta }`; `meta.parts` expõe o que a animação move.
 */
export function buildWeapon(id, mats) {
  const fn = BUILDERS[id];
  if (!fn) throw new Error(`[WeaponMeshes] arma desconhecida: ${id}`);
  const { group, meta } = fn(mats);

  /* --- mãos: a mão fecha no punho; o antebraço é mirado no ombro --- */
  const handR = new THREE.Group();
  handR.name = 'handR';
  handR.position.copy(meta.gripR);
  handR.rotation.set(...meta.gripRRot);
  handR.add(new THREE.Mesh(buildHandGeo({ curl: 1.32, open: 0 }), mats.glove));

  const handL = new THREE.Group();
  handL.name = 'handL';
  handL.position.copy(meta.gripL);
  handL.rotation.set(...meta.gripLRot);
  handL.add(new THREE.Mesh(
    mirrorX(buildHandGeo({ curl: 1.14, open: id === 'pt92' ? 0.28 : 0.10 })), mats.glove));

  group.add(handR, handL);

  // Ombros aproximados no espaço da arma (a arma repousa à frente-direita do peito).
  const armLen = 0.34;
  for (const [hand, shoulder] of [
    [handR, meta.shoulderR ?? new THREE.Vector3(0.10, -0.26, 0.46)],
    [handL, meta.shoulderL ?? new THREE.Vector3(-0.26, -0.28, 0.40)],
  ]) {
    const arm = new THREE.Mesh(buildForearmGeo(armLen), mats.glove);
    arm.name = hand.name + 'Arm';
    arm.position.copy(hand.position);
    arm.lookAt(shoulder);          // -Z do antebraço aponta para o ombro
    group.add(arm);
    hand.userData.arm = arm;
    hand.userData.armRest = { p: arm.position.clone(), q: arm.quaternion.clone() };
  }

  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.name = 'muzzle';
  muzzleAnchor.position.copy(meta.muzzle);
  group.add(muzzleAnchor);

  const shellAnchor = new THREE.Object3D();
  shellAnchor.name = 'eject';
  shellAnchor.position.copy(meta.ejectPort);
  group.add(shellAnchor);

  group.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });

  meta.parts = { handR, handL, mag: meta.mag, bolt: meta.bolt, muzzleAnchor, shellAnchor };
  meta.handRRest = handR.position.clone();
  meta.handLRest = handL.position.clone();
  meta.handLRestRot = handL.rotation.clone();
  meta.triangles = countTriangles(group);

  return { group, meta };
}

/** Libera geometrias de um conjunto construído por buildWeapon. */
export function disposeWeapon(group) {
  group.traverse((o) => { o.geometry?.dispose?.(); });
}
