/**
 * Teste headless do modulo WORLD: geracao deterministica, colisao, navGrid,
 * spawns e coberturas. Roda em Node puro (sem WebGL).
 *   node test/world.smoke.mjs
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { World } from '../src/world/World.js';

const t0 = Date.now();
const w = new World({ scene: null, camera: null }, { seed: 20260728 });
await w.init();
console.log('== STATS ==');
console.log(JSON.stringify(w.stats, null, 1));

let ok = 0, falhou = 0;
const teste = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome} ${extra}`); }
  else { falhou++; console.log(`  FALHA ${nome} ${extra}`); }
};

// ---------------------------------------------------------------- colisao
const col = w.collision;
console.log('\n== COLISAO ==');

const r1 = col.raycast(new THREE.Vector3(0, 120, 0), new THREE.Vector3(0, -1, 0), 300);
teste('raycast acha o chao', r1.hit && r1.normal.y > 0.2,
  `y=${r1.point?.y.toFixed(2)} sup=${r1.surface} n.y=${r1.normal?.y.toFixed(2)}`);

const spawns = w.getSpawnPoints();
let acertos = 0;
for (const s of spawns) {
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    const r = col.raycast(
      new THREE.Vector3(s.position.x, s.position.y + 1.5, s.position.z),
      new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)), 40);
    if (r.hit) acertos++;
  }
}
teste('raycast horizontal encontra geometria', acertos > spawns.length * 3,
  `${acertos}/${spawns.length * 8} raios`);

const sup = new Set();
for (const s of spawns) {
  const r = col.raycast(new THREE.Vector3(s.position.x, s.position.y + 3, s.position.z),
    new THREE.Vector3(0, -1, 0), 20);
  if (r.hit) sup.add(r.surface);
}
teste('superficies etiquetadas', sup.size >= 2, `[${[...sup].join(', ')}]`);

const sc = col.sphereCast(new THREE.Vector3(0, 120, 0), new THREE.Vector3(0, -1, 0), 0.3, 200);
teste('sphereCast acha o chao', sc.hit, `d=${sc.distance?.toFixed(2)} sup=${sc.surface}`);

const RAIO = 0.34, ALT = 1.75;
let pousou = 0;
for (const s of spawns) {
  // 1,1 m acima do piso: alto o bastante para provar a queda, baixo o bastante
  // para nao nascer dentro de uma lona de beco ou marquise
  const p = new THREE.Vector3(s.position.x, s.position.y + 1.1, s.position.z);
  let res = null;
  for (let i = 0; i < 60; i++) {
    res = col.capsuleSweep(p, p.clone().add(new THREE.Vector3(0, -0.12, 0)), RAIO, ALT);
    p.copy(res.position);
    if (res.grounded) break;
  }
  if (res?.grounded) pousou++;
}
teste('capsuleSweep pousa em todo spawn', pousou === spawns.length, `${pousou}/${spawns.length}`);

let dentroDeParede = 0;
for (const s of spawns) {
  const p = new THREE.Vector3(s.position.x, s.position.y + 0.4, s.position.z);
  for (let i = 0; i < 60; i++) {
    const res = col.capsuleSweep(p, p.clone().add(new THREE.Vector3(0.25, -0.12, 0)), RAIO, ALT);
    p.copy(res.position);
  }
  const d = col.raycast(new THREE.Vector3(p.x, p.y + 0.9, p.z), new THREE.Vector3(1, 0, 0), 0.25);
  if (d.hit && d.distance < 0.04) dentroDeParede++;
}
teste('capsuleSweep nunca termina dentro de parede', dentroDeParede === 0, `${dentroDeParede} casos`);

// Sobe escadaria: percorre varios lances seguindo a polilinha do beco.
// O "piloto" aqui e burro de proposito (anda reto para o proximo ponto, sem
// desvio local), entao o criterio e a MEDIANA — mede a colisao, nao o pathing.
const subidas = [];
for (const via of w.favela.vias) {
  if (!via.lances?.length || subidas.length >= 10) continue;
  for (const [i0, i1] of via.lances) {
    if (i1 - i0 < 6 || subidas.length >= 10) continue;
    const a = via.pts[i0], b = via.pts[i1];
    const ya = col.groundAt(a[0], a[1]), yb = col.groundAt(b[0], b[1]);
    if (yb < ya + 0.8) continue;
    const p = new THREE.Vector3(a[0], ya + 0.15, a[1]);
    const dir = new THREE.Vector3();
    let alvoIdx = i0 + 1;
    for (let i = 0; i < 500; i++) {
      while (alvoIdx < i1 && Math.hypot(via.pts[alvoIdx][0] - p.x, via.pts[alvoIdx][1] - p.z) < 0.55) alvoIdx++;
      const t = via.pts[Math.min(alvoIdx, i1)];
      dir.set(t[0] - p.x, 0, t[1] - p.z);
      if (dir.lengthSq() < 1e-6) break;
      dir.normalize().multiplyScalar(0.13);
      const res = col.capsuleSweep(p, p.clone().add(dir).add(new THREE.Vector3(0, -0.07, 0)), RAIO, ALT);
      p.copy(res.position);
    }
    subidas.push(Math.max(0, (p.y - ya) / (yb - ya)));
  }
}
subidas.sort((x, y) => x - y);
const mediana = subidas.length ? subidas[subidas.length >> 1] : 0;
teste('capsuleSweep sobe escadaria (degrau ate 0,45 m)', mediana > 0.7,
  `mediana ${(mediana * 100).toFixed(0)}% de ${subidas.length} lances | ` +
  `${subidas.filter((s) => s > 0.9).length} lances vencidos por inteiro`);

// ---------------------------------------------------------------- navGrid
console.log('\n== NAVGRID ==');
const ng = w.navGrid;
teste('API do contrato',
  ng.width && ng.height && ng.cellSize && ng.origin && ng.data instanceof Uint8Array
  && ng.heightData instanceof Float32Array && typeof ng.worldToCell === 'function'
  && typeof ng.cellToWorld === 'function' && typeof ng.isWalkable === 'function',
  `${ng.width}x${ng.height} @ ${ng.cellSize} m`);

const andavel = ng.walkableCount;
teste('area andavel razoavel', andavel > 20000 && andavel < ng.data.length * 0.9,
  `${andavel} celulas = ${(andavel * ng.cellSize ** 2).toFixed(0)} m2`);

const cel = { x: 0, z: 0 };
const v = new THREE.Vector3(13.7, 0, -42.3);
ng.worldToCell(v, cel);
const back = ng.cellToWorld(cel.x, cel.z, new THREE.Vector3());
teste('worldToCell/cellToWorld coerentes',
  Math.abs(back.x - v.x) <= ng.cellSize && Math.abs(back.z - v.z) <= ng.cellSize);

const rua = w.favela.vias[0].pts[Math.floor(w.favela.vias[0].pts.length / 2)];
const alvo = { x: 0, z: 0 };
ng.worldToCell(new THREE.Vector3(rua[0], 0, rua[1]), alvo);
const visto = new Uint8Array(ng.width * ng.height);
const fila = [alvo.z * ng.width + alvo.x];
visto[fila[0]] = 1;
for (let h = 0; h < fila.length; h++) {
  const k = fila[h], ki = k % ng.width, kj = (k / ng.width) | 0;
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ni = ki + di, nj = kj + dj;
    if (ni < 0 || nj < 0 || ni >= ng.width || nj >= ng.height) continue;
    const nk = nj * ng.width + ni;
    if (visto[nk] || !ng.isWalkable(ni, nj)) continue;
    if (Math.abs(ng.heightData[nk] - ng.heightData[k]) > 0.46) continue;
    visto[nk] = 1; fila.push(nk);
  }
}
let alcancados = 0;
for (const s of spawns) { ng.worldToCell(s.position, cel); if (visto[cel.z * ng.width + cel.x]) alcancados++; }
teste('todo spawn e alcancavel a pe pela rede de becos', alcancados === spawns.length,
  `${alcancados}/${spawns.length}`);

let spawnsBons = 0;
for (const s of spawns) {
  ng.worldToCell(s.position, cel);
  const teto = col.raycast(new THREE.Vector3(s.position.x, s.position.y + 0.25, s.position.z),
    new THREE.Vector3(0, 1, 0), 1.85);
  if (ng.isWalkable(cel.x, cel.z) && !teto.hit) spawnsBons++;
}
teste('spawns em pe livre com altura de gente', spawnsBons >= 12, `${spawnsBons}/${spawns.length}`);
teste('pelo menos 12 spawns', spawns.length >= 12, `${spawns.length}`);
let dmin = Infinity;
for (let i = 0; i < spawns.length; i++) for (let j = i + 1; j < spawns.length; j++)
  dmin = Math.min(dmin, spawns[i].position.distanceTo(spawns[j].position));
teste('spawns espalhados', dmin > 6, `distancia minima ${dmin.toFixed(1)} m`);

// ---------------------------------------------------------------- cobertura
console.log('\n== COBERTURA ==');
const covers = w.getCoverPoints();
teste('tem pontos de cobertura', covers.length > 100, `${covers.length}`);
let cobValidos = 0;
for (const c of covers) {
  const atras = col.raycast(new THREE.Vector3(c.position.x, c.position.y + 1.0, c.position.z),
    c.normal.clone().negate(), 2.4);
  if (atras.hit) cobValidos++;
}
teste('cobertura tem parede atras', cobValidos > covers.length * 0.5, `${cobValidos}/${covers.length}`);

// ------------------------------------------------------------ determinismo
console.log('\n== DETERMINISMO ==');
const w2 = new World({ scene: null, camera: null }, { seed: 20260728 });
await w2.init();
const a1 = { ...w.stats }, a2 = { ...w2.stats };
delete a1.msGeracao; delete a2.msGeracao;
teste('mesma seed => mesmo mapa', JSON.stringify(a1) === JSON.stringify(a2));

const w3 = new World({ scene: null, camera: null }, { seed: 777 });
await w3.init();
teste('seed diferente => mapa diferente',
  w3.stats.casas !== w.stats.casas || w3.stats.vias !== w.stats.vias,
  `casas ${w.stats.casas} vs ${w3.stats.casas} | vias ${w.stats.vias} vs ${w3.stats.vias}`);

console.log(`\n${ok} ok, ${falhou} falhas — ${Date.now() - t0} ms`);
process.exit(falhou ? 1 : 0);
