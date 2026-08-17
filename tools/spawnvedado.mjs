/**
 * spawnvedado.mjs — AUDITORIA: nenhum ponto jogavel pode ficar com a visao
 * vedada pela vegetacao.
 *
 * Para CADA ponto de spawn do mundo, lanca 72 raios visuais (de 5 em 5 graus) na
 * altura do olho e mede:
 *   - quantos batem em FOLHAGEM a menos de `PERTO` metros;
 *   - qual e o obstaculo mais proximo, e se ele e folhagem;
 *   - se sobra ao menos um setor de 60 graus com visada > 12 m (o "por onde eu saio daqui").
 *
 * O criterio de reprovacao e o do defeito original: folhagem tapando mais de
 * metade das direçoes bem na cara do jogador.
 *
 * Uso: node tools/spawnvedado.mjs [rotulo]
 * Saida: shots/spawn-vedado-<rotulo>.json + tabela no console
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const ROTULO = process.argv[2] ?? 'depois';
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p.waitForTimeout(2500);

const rel = await p.evaluate(async () => {
  const THREE = window.__three ?? (window.__three = await import('/node_modules/three/build/three.module.js'));
  const ctx = window.__game.ctx;
  const PERTO = 6;             // "na cara do jogador"
  const LIVRE = 12;            // visada considerada aberta

  const alvos = [];
  ctx.world.group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible) alvos.push(o); });
  const ehFolha = new Set();
  for (const o of alvos) {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some((m) => m && (m.name === 'folha' || m.name === 'grama'))) ehFolha.add(o.name);
  }

  const rc = new THREE.Raycaster();
  rc.far = 80;
  const olho = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const saida = [];

  const pts = ctx.world.getSpawnPoints();
  for (let s = 0; s < pts.length; s++) {
    const q = pts[s].position ?? pts[s];
    olho.set(q.x, q.y + 1.68, q.z);
    let matoPerto = 0, bloqPerto = 0, minD = Infinity, minObj = 'ceu';
    const dists = [];
    for (let a = 0; a < 360; a += 5) {
      const r = a * Math.PI / 180;
      dir.set(Math.sin(r), 0, -Math.cos(r));
      rc.set(olho, dir);
      const h = rc.intersectObjects(alvos, false)[0];
      const d = h ? h.distance : Infinity;
      dists.push(d);
      if (d < PERTO) {
        bloqPerto++;
        if (ehFolha.has(h.object.name)) matoPerto++;
      }
      if (d < minD) { minD = d; minObj = h ? h.object.name : 'ceu'; }
    }
    // existe algum setor contiguo de 60 graus (12 raios) todo acima de LIVRE?
    let temSaida = false;
    for (let i = 0; i < 72 && !temSaida; i++) {
      let ok = true;
      for (let k = 0; k < 12; k++) if (dists[(i + k) % 72] < LIVRE) { ok = false; break; }
      if (ok) temSaida = true;
    }
    saida.push({
      i: s, x: +q.x.toFixed(1), z: +q.z.toFixed(1),
      matoPerto, bloqPerto, temSaida,
      minD: +(minD === Infinity ? 999 : minD).toFixed(2),
      minObj: minObj.replace('inst:', '').replace('merge:', ''),
      minEhMato: ehFolha.has(minObj),
    });
  }
  return { total: pts.length, saida };
});

writeFileSync(`${ROOT}/shots/spawn-vedado-${ROTULO}.json`, JSON.stringify(rel, null, 1));

const s = rel.saida;
const reprovados = s.filter((r) => r.matoPerto > 36);          // >50% das direçoes
const semSaida = s.filter((r) => !r.temSaida);
const matoNaCara = s.filter((r) => r.minEhMato && r.minD < 1.0);

const media = (f) => (s.reduce((a, r) => a + f(r), 0) / s.length).toFixed(1);
console.log(`spawns: ${rel.total}`);
console.log(`media de raios (de 72) com MATO a <6 m: ${media((r) => r.matoPerto)}`);
console.log(`media de raios com QUALQUER obstaculo a <6 m: ${media((r) => r.bloqPerto)}`);
console.log(`REPROVADOS (mato em >50% das direçoes a <6 m): ${reprovados.length}`);
for (const r of reprovados.slice(0, 12)) console.log(`   #${r.i} (${r.x},${r.z}) mato=${r.matoPerto}/72 minD=${r.minD} ${r.minObj}`);
console.log(`sem nenhum setor de 60 graus com visada >12 m: ${semSaida.length}`);
for (const r of semSaida.slice(0, 12)) console.log(`   #${r.i} (${r.x},${r.z}) minD=${r.minD} ${r.minObj}`);
console.log(`com folhagem colada (<1,0 m do olho): ${matoNaCara.length}`);
for (const r of matoNaCara.slice(0, 12)) console.log(`   #${r.i} (${r.x},${r.z}) ${r.minObj} a ${r.minD} m`);

const pior = s.slice().sort((a, b) => b.matoPerto - a.matoPerto).slice(0, 5);
console.log('\npiores 5 por mato perto:');
for (const r of pior) console.log(`   #${r.i} (${r.x},${r.z}) mato=${r.matoPerto}/72 bloq=${r.bloqPerto}/72 saida=${r.temSaida} minD=${r.minD} ${r.minObj}`);

await b.close();
