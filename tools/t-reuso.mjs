// Diagnostico: ciclo completo de reuso do pool — vivo -> morto (ragdoll) ->
// corpo assentado -> despawn -> respawn (reviver) -> andando de novo.
// Mede vertices skinados reais (peito/cabeca/canela) contra a posicao do
// inimigo, em cada etapa. E o caminho que a partida real exercita ao matar.
import * as THREE from 'three';
import { Enemy } from '../src/ai/Enemy.js';

const ctx = {
  world: { collision: { raycast: (o, d, max) => {
    // chao plano em y=0
    if (d.y >= 0) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > max) return null;
    return { hit: true, distance: t, point: new THREE.Vector3(o.x + d.x * t, 0, o.z + d.z * t), normal: new THREE.Vector3(0, 1, 0), surface: 'terra' };
  } } },
  bus: { emit: () => {}, on: () => {} },
};

const e = new Enemy(ctx, { variante: 0 });
const alvosSonda = { peito: [0, 1.40, -0.12], cabeca: [0, 1.72, -0.02], canela: [0.103, 0.30, 0.0] };
const sondas = {};
{
  const pos = e.soldado.rec.geo.getAttribute('position');
  for (const [nome, a] of Object.entries(alvosSonda)) {
    let melhor = 0, md = 1e9;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - a[0], dy = pos.getY(i) - a[1], dz = pos.getZ(i) - a[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < md) { md = d2; melhor = i; }
    }
    sondas[nome] = melhor;
  }
}
const _t = new THREE.Vector3();
const mede = (rot) => {
  const s = e.soldado;
  s.grupo.updateMatrixWorld(true);
  s.esqueleto.update();          // renderer faria isto; em node fazemos na mao
  const out = {};
  for (const [nome, idx] of Object.entries(sondas)) {
    s.malha.getVertexPosition(idx, _t);
    s.malha.localToWorld(_t);
    const esp = alvosSonda[nome];
    out[nome] = { y: +_t.y.toFixed(2), desloc: +Math.hypot(_t.x - e.pos.x, _t.y - (e.pos.y + esp[1]), _t.z - e.pos.z).toFixed(2) };
  }
  console.log(rot.padEnd(26), JSON.stringify(out), 'grupoY=' + s.grupo.position.y.toFixed(2), 'vis=' + s.grupo.visible);
  return out;
};

// --- vida 1: anda 3 s ---
e.spawn(new THREE.Vector3(0, 0, 0), 0, null);
e.vel.set(0, 0, 2.1);
for (let i = 0; i < 180; i++) { e.soldado.setLocomocao(0, 2.1, false); e.soldado.update(1 / 60); }
mede('vida1 andando');

// --- morte + ragdoll assentando (30 s) ---
e.levarDano(500, e.pos.clone(), 'torso', new THREE.Vector3(0, 0, -1));
for (let i = 0; i < 1800; i++) e.update(1 / 60);
mede('morto 30s (ragdoll)');

// --- expira e reusa ---
e.despawn();
e.spawn(new THREE.Vector3(5, 0, 5), Math.PI / 3, null);
mede('respawn imediato');

// --- vida 2: anda 3 s ---
for (let i = 0; i < 180; i++) { e.update(1 / 60); }
mede('vida2 apos 3s parado');
e.vel.set(0, 0, 2.1);
for (let i = 0; i < 180; i++) { e.soldado.setLocomocao(0, 2.1, false); e.soldado.update(1 / 60); }
mede('vida2 andando');

// --- vida 2: correndo (o caminho do sprint/_bracosNaArma) ---
try {
  for (let i = 0; i < 120; i++) { e.soldado.setLocomocao(0, 4.6, false); e.soldado.update(1 / 60); }
  mede('vida2 correndo');
} catch (err) {
  console.log('vida2 correndo LANCOU:', err.message);
  mede('vida2 pos-erro');
  // e o proximo frame? (o loop real continua chamando)
  try { e.soldado.update(1 / 60); } catch (err2) { console.log('frame seguinte LANCOU de novo:', err2.message); }
  mede('vida2 2 frames pos-erro');
}
