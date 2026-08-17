/**
 * Batcher: junta geometria estatica por (material x setor espacial) num unico
 * BufferGeometry. E o que segura a contagem de draw calls: ~15 materiais x 9
 * setores no pior caso, em vez de milhares de meshes.
 *
 * O corte por setor existe para o frustum culling continuar funcionando — um
 * merge global de 180x180 m nunca sairia do frustum.
 *
 * Tambem centraliza:
 *  - UV em espaco de mundo (1 UV = 1 m) aplicada DEPOIS da matriz;
 *  - pools de InstancedMesh para tudo que repete.
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { boxProjectUV, scaleExistingUV } from './geo.js';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _nrmMat = new THREE.Matrix3();

/** Merge manual de geometrias nao-indexadas com position/normal/uv/uv1. */
function mergeSimple(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const uv1 = new Float32Array(total * 2);
  let o3 = 0, o2 = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o3);
    nrm.set(g.attributes.normal.array, o3);
    uv.set(g.attributes.uv.array, o2);
    uv1.set(g.attributes.uv1 ? g.attributes.uv1.array : g.attributes.uv.array, o2);
    o3 += g.attributes.position.count * 3;
    o2 += g.attributes.position.count * 2;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

export class Batcher {
  /**
   * @param {object} materials  fonte com .get(nome) -> THREE.Material
   * @param {number} worldSize  lado do mundo em metros
   * @param {number} sectors    divisoes por eixo (3 => 9 setores)
   */
  constructor(materials, worldSize = 180, sectors = 3) {
    this.materials = materials;
    this.worldSize = worldSize;
    this.sectors = sectors;
    this.buckets = new Map();      // chave "material|setor" -> {mat, list}
    this.instances = new Map();    // nome -> {geo, mat, transforms[], colors[]}
    this.meshes = [];
    this.stats = { merged: 0, instanced: 0, triangles: 0 };
  }

  _sectorOf(x, z) {
    const s = this.sectors, half = this.worldSize * 0.5;
    const i = Math.min(s - 1, Math.max(0, Math.floor(((x + half) / this.worldSize) * s)));
    const j = Math.min(s - 1, Math.max(0, Math.floor(((z + half) / this.worldSize) * s)));
    return j * s + i;
  }

  /**
   * Adiciona geometria estatica. A geometria e consumida (transformada in-place).
   * @param {THREE.BufferGeometry} geo
   * @param {THREE.Matrix4|null} matrix
   * @param {string} matName
   * @param {object} [opt] {uv:'box'|'keep', uvScale, uvRotate, sector}
   */
  add(geo, matrix, matName, opt = {}) {
    if (matrix) {
      geo.applyMatrix4(matrix);
      if (geo.attributes.normal) {
        _nrmMat.getNormalMatrix(matrix);
        const n = geo.attributes.normal.array;
        for (let i = 0; i < n.length; i += 3) {
          _v.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(_nrmMat).normalize();
          n[i] = _v.x; n[i + 1] = _v.y; n[i + 2] = _v.z;
        }
      }
    }
    if (opt.uv === 'keep') scaleExistingUV(geo, opt.uvScale ?? 1);
    else boxProjectUV(geo, opt.uvScale ?? 1, opt.uvRotate ?? 0);

    geo.computeBoundingBox();
    _box.copy(geo.boundingBox).getCenter(_v);
    const sec = opt.sector ?? this._sectorOf(_v.x, _v.z);
    const key = `${matName}|${sec}`;
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = { matName, sector: sec, list: [] }; this.buckets.set(key, bucket); }
    bucket.list.push(geo);
    return this;
  }

  /** Declara um tipo instanciado (geometria prototipo criada uma unica vez). */
  defineInstance(name, geoFactory, matName, opt = {}) {
    if (this.instances.has(name)) return;
    const geo = geoFactory();
    if (opt.uv === 'keep') scaleExistingUV(geo, opt.uvScale ?? 1);
    else boxProjectUV(geo, opt.uvScale ?? 1);
    if (!geo.attributes.uv1) geo.setAttribute('uv1', geo.attributes.uv.clone());
    geo.computeBoundingSphere();
    this.instances.set(name, {
      geo, matName, transforms: [], colors: [], sectorOf: [],
      castShadow: opt.castShadow !== false,
      receiveShadow: opt.receiveShadow !== false,
      tint: opt.tint ?? null,
      transparent: opt.transparent ?? false,
      opacity: opt.opacity ?? 1,
      side: opt.side ?? null,
      // props miudos sao fatiados por setor: assim o frustum culling funciona e
      // da para aplicar LOD por distancia sem tocar em cada instancia.
      sectored: opt.sectored === true,
      lodMax: opt.lodMax ?? Infinity,
    });
  }

  /** Empurra uma instancia. `color` opcional (THREE.Color) usa instanceColor. */
  pushInstance(name, matrix, color = null) {
    const inst = this.instances.get(name);
    if (!inst) { console.warn(`[Batcher] instancia nao declarada: ${name}`); return; }
    inst.transforms.push(matrix.clone());
    inst.colors.push(color);
    if (inst.sectored) {
      inst.sectorOf.push(this._sectorOf(matrix.elements[12], matrix.elements[14]));
    }
  }

  /** Constroi todos os meshes e adiciona ao grupo. */
  build(group) {
    // --- estaticos merged ---
    for (const [, bucket] of this.buckets) {
      if (!bucket.list.length) continue;
      const geo = mergeSimple(bucket.list);
      for (const g of bucket.list) g.dispose();
      const mat = this.materials.get(bucket.matName);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `merge:${bucket.matName}:${bucket.sector}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.lodMax = Infinity;
      mesh.userData.centro = geo.boundingSphere.center.clone();
      mesh.userData.raio = geo.boundingSphere.radius;
      group.add(mesh);
      this.meshes.push(mesh);
      this.stats.merged++;
      this.stats.triangles += geo.attributes.position.count / 3;
    }
    this.buckets.clear();

    // --- instanciados ---
    const branco = new THREE.Color(1, 1, 1);
    for (const [name, inst] of this.instances) {
      const total = inst.transforms.length;
      if (total === 0) { inst.geo.dispose(); continue; }
      let mat = this.materials.get(inst.matName);
      const anyColor = inst.colors.some(Boolean);
      if (anyColor || inst.tint || inst.transparent || inst.side !== null) {
        mat = mat.clone();
        mat.__cloned = true;
        if (anyColor) mat.color.setRGB(1, 1, 1);
        if (inst.tint) mat.color.copy(inst.tint);
        if (inst.transparent) { mat.transparent = true; mat.opacity = inst.opacity; mat.depthWrite = inst.opacity > 0.85; }
        if (inst.side !== null) mat.side = inst.side;
      }

      // agrupa por setor (ou tudo num grupo so)
      const grupos = new Map();
      for (let i = 0; i < total; i++) {
        const sec = inst.sectored ? inst.sectorOf[i] : -1;
        let g = grupos.get(sec);
        if (!g) { g = []; grupos.set(sec, g); }
        g.push(i);
      }

      for (const [sec, idxs] of grupos) {
        const im = new THREE.InstancedMesh(inst.geo, mat, idxs.length);
        im.name = sec < 0 ? `inst:${name}` : `inst:${name}:${sec}`;
        im.castShadow = inst.castShadow;
        im.receiveShadow = inst.receiveShadow;
        for (let k = 0; k < idxs.length; k++) im.setMatrixAt(k, inst.transforms[idxs[k]]);
        if (anyColor) {
          for (let k = 0; k < idxs.length; k++) im.setColorAt(k, inst.colors[idxs[k]] || branco);
          im.instanceColor.needsUpdate = true;
        }
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.frustumCulled = true;
        im.userData.lodMax = inst.lodMax;
        im.userData.centro = im.boundingSphere ? im.boundingSphere.center.clone() : new THREE.Vector3();
        im.userData.raio = im.boundingSphere ? im.boundingSphere.radius : 0;
        group.add(im);
        this.meshes.push(im);
        this.stats.instanced++;
        this.stats.triangles += (inst.geo.attributes.position.count / 3) * idxs.length;
      }
      inst.transforms.length = 0; inst.colors.length = 0; inst.sectorOf.length = 0;
    }
    return this.stats;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry?.dispose();
      if (m.material && m.material.__cloned) m.material.dispose();
    }
    this.meshes.length = 0;
  }
}
