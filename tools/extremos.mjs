/**
 * Sonda de geometria: lista os vertices que passam de um raio lateral, para
 * caçar peça que "voa" para fora da silhueta.  node tools/extremos.mjs [limX]
 */
import { Soldier } from '../src/ai/Soldier.js';

const LIM = +(process.argv[2] || 0.26);
const s = new Soldier({}, { variante: 1 });
const pos = s.rec.geo.attributes.position.array;
const bandas = new Map();
for (let i = 0; i < pos.length; i += 3) {
  const x = pos[i], y = pos[i + 1], z = pos[i + 2];
  if (Math.abs(x) < LIM && Math.abs(z) < 0.32) continue;
  const k = (Math.round(y * 20) / 20).toFixed(2);
  const b = bandas.get(k) || { n: 0, maxX: 0, maxZ: 0, minZ: 0 };
  b.n++;
  b.maxX = Math.max(b.maxX, Math.abs(x));
  b.maxZ = Math.max(b.maxZ, z);
  b.minZ = Math.min(b.minZ, z);
  bandas.set(k, b);
}
console.log(`vertices com |x|>${LIM} ou |z|>0.32, por faixa de altura:`);
for (const k of [...bandas.keys()].sort((a, b) => b - a)) {
  const b = bandas.get(k);
  console.log(`  y=${k}  n=${String(b.n).padStart(4)}  maxAbsX=${b.maxX.toFixed(3)}  z=[${b.minZ.toFixed(3)}, ${b.maxZ.toFixed(3)}]`);
}
const bb = s.rec.geo.boundingBox;
console.log('bbox', JSON.stringify(bb.min), JSON.stringify(bb.max));
