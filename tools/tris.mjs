/**
 * Conta triangulos por variante do Soldier e quantos triangulos o corretor de
 * winding precisou inverter. Roda em node puro (sem navegador).
 *
 *   node tools/tris.mjs
 */
import { Soldier } from '../src/ai/Soldier.js';

const ctx = {};
let total = 0;
const N = 4;
for (let v = 0; v < N; v++) {
  const s = new Soldier(ctx, { variante: v });
  console.log(
    `variante ${v}: corpo=${s.rec.tris} tris · arma=${s.rec.trisArma} tris · total=${s.triangulos}`,
  );
  total += s.rec.tris;
}
console.log(`soma dos corpos (${N} variantes) = ${total} tris`);
