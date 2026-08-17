// Diagnostico: soldado armado correndo (sprint) sem mirar — exercita _bracosNaArma.
// Suspeita: `_v5 = null` reatribui uma const de modulo -> TypeError em strict mode.
import { Soldier } from '../src/ai/Soldier.js';

const s = new Soldier({}, { variante: 0 });
s.setLocomocao(0, 4.6, false); // correndo para frente a 4.6 m/s (VEL_CORRER)
s.setMira(null, 0);            // sem mira -> sprint alto -> pesoMaoE cai
try {
  for (let i = 0; i < 180; i++) s.update(1 / 60);
  console.log('OK: 180 frames de sprint sem erro. pesoMaoE =', s.est.pesoMaoE.toFixed(3));
} catch (e) {
  console.log('LANCOU:', e.constructor.name, '-', e.message);
}
