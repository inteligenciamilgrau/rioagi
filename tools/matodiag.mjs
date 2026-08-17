/**
 * matodiag.mjs — MEDE quem esta tapando a tela no spawn do "paredao verde".
 *
 * Nao adivinha: lanca um leque de raios VISUAIS (THREE.Raycaster contra as malhas
 * desenhadas, nao contra a malha de colisao) a partir do olho do jogador e diz,
 * por angulo, o nome da InstancedMesh atingida e a distancia. Tambem varre todas
 * as instancias de vegetacao num raio de 12 m e imprime nome/escala/altura.
 *
 * Uso: node tools/matodiag.mjs [rotulo]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const ROTULO = process.argv[2] ?? 'antes';
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando'; ctx.bus.emit('game:start', {});
});
await p.waitForTimeout(700);

const rel = await p.evaluate(async () => {
  // O jogo nao publica o modulo three; pegamos uma copia pelo caminho servido
  // pelo vite. So usamos matematica + Raycaster, que e duck-typed.
  const THREE = window.__three ?? (window.__three = await import('/node_modules/three/build/three.module.js'));
  const ctx = window.__game.ctx;

  // mesmo criterio do semcapim.mjs: primeiro spawn com chao de terra
  const pts = ctx.world.getSpawnPoints();
  let alvo = null, alvoIdx = -1;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i].position ?? pts[i];
    const g = ctx.world.collision.raycast({ x: q.x, y: q.y + 2, z: q.z }, { x: 0, y: -1, z: 0 }, 6);
    if (g.hit && g.surface === 'terra') { alvo = q; alvoIdx = i; break; }
  }
  if (!alvo) return { erro: 'nenhum spawn de terra' };

  ctx.player.movement.teleport(alvo.x, alvo.y + 0.1, alvo.z);
  ctx.player.rig.reset(ctx.player._rumoInicial(alvo), 0);
  for (let f = 0; f < 60; f++) ctx.player.update(1 / 60);
  const olho = ctx.player.eyePosition.clone();

  // --- 1) leque visual de 360 graus ---
  const rc = new THREE.Raycaster();
  rc.far = 60;
  const alvos = [];
  ctx.world.group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible) alvos.push(o); });

  const leque = [];
  const dir = new THREE.Vector3();
  for (let a = 0; a < 360; a += 5) {
    const r = a * Math.PI / 180;
    dir.set(Math.sin(r), 0, -Math.cos(r)).normalize();
    rc.set(olho, dir);
    const hits = rc.intersectObjects(alvos, false);
    const h = hits[0];
    leque.push({
      ang: a,
      d: h ? +h.distance.toFixed(2) : null,
      obj: h ? h.object.name : 'ceu',
      inst: h && h.instanceId != null ? h.instanceId : null,
    });
  }

  // --- 2) censo de instancias de vegetacao perto ---
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), esc = new THREE.Vector3(), qq = new THREE.Quaternion();
  const perto = [];
  for (const o of alvos) {
    if (!o.isInstancedMesh || !o.name.startsWith('inst:')) continue;
    const nome = o.name.split(':')[1];
    const raioProto = o.geometry.boundingSphere ? o.geometry.boundingSphere.radius : 0;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m4);
      m4.decompose(pos, qq, esc);
      const d = Math.hypot(pos.x - olho.x, pos.z - olho.z);
      if (d > 14) continue;
      perto.push({
        nome, d: +d.toFixed(2),
        esc: [+esc.x.toFixed(2), +esc.y.toFixed(2)],
        raio: +(raioProto * Math.max(esc.x, esc.y, esc.z)).toFixed(2),
        y: +pos.y.toFixed(2),
      });
    }
  }
  perto.sort((a, b) => a.d - b.d);

  // --- 3) fracao de tela: quantos raios do leque batem em `grama` ---
  const gramaObjs = new Set();
  for (const o of alvos) {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some((m) => m && (m.name === 'folha' || m.name === 'grama'))) gramaObjs.add(o.name);
  }
  const bloqueados = leque.filter((l) => l.d != null && l.d < 8);
  const porMato = leque.filter((l) => l.d != null && l.d < 8 && gramaObjs.has(l.obj));

  // --- 4) contagem global de triangulos de vegetacao ---
  let triVeg = 0, instVeg = 0;
  const porTipo = {};
  ctx.world.group.traverse((o) => {
    if (!o.isInstancedMesh || !o.name.startsWith('inst:')) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some((m) => m && (m.name === 'folha' || m.name === 'grama'))) return;
    const nome = o.name.split(':')[1];
    const t = (o.geometry.attributes.position.count / 3) * o.count;
    triVeg += t; instVeg += o.count;
    porTipo[nome] = porTipo[nome] || { inst: 0, tri: 0, triProto: o.geometry.attributes.position.count / 3 };
    porTipo[nome].inst += o.count; porTipo[nome].tri += t;
  });

  // --- 5) o material grama, como esta configurado ---
  const gm = ctx.materials?.get?.('grama') ?? null;
  const matInfo = gm ? {
    transparent: gm.transparent, alphaTest: gm.alphaTest, side: gm.side,
    temAlphaMap: !!gm.alphaMap, depthWrite: gm.depthWrite, opacity: gm.opacity,
  } : null;

  return {
    spawn: { idx: alvoIdx, x: +alvo.x.toFixed(1), z: +alvo.z.toFixed(1) },
    olho: [+olho.x.toFixed(2), +olho.y.toFixed(2), +olho.z.toFixed(2)],
    leque,
    perto: perto.slice(0, 40),
    vedado: { raios: leque.length, bloq8m: bloqueados.length, porMato: porMato.length },
    veg: { triVeg, instVeg, porTipo },
    matInfo,
  };
});

writeFileSync(`${ROOT}/shots/matodiag-${ROTULO}.json`, JSON.stringify(rel, null, 1));

console.log(`spawn #${rel.spawn.idx} em (${rel.spawn.x}, ${rel.spawn.z})  olho ${rel.olho}`);
console.log(`material grama:`, JSON.stringify(rel.matInfo));
console.log(`\n--- leque 360 (raio visual, 5 em 5 graus) ---`);
let linha = '';
for (const l of rel.leque) {
  linha += `${String(l.ang).padStart(3)}:${String(l.d ?? 'ceu').padStart(6)} ${(l.obj || '').replace('inst:', '').padEnd(16)}`;
  if (l.ang % 20 === 15) { console.log(linha); linha = ''; }
}
if (linha) console.log(linha);
console.log(`\nvedado: ${rel.vedado.porMato}/${rel.vedado.raios} raios batem em MATO a menos de 8 m ` +
  `(qualquer obstaculo <8m: ${rel.vedado.bloq8m})`);
console.log(`\n--- instancias de vegetacao a <=14 m ---`);
for (const q of rel.perto.slice(0, 22)) {
  console.log(`  ${q.nome.padEnd(12)} d=${String(q.d).padStart(6)} m  esc=${q.esc[0]}x${q.esc[1]}  raioMundo=${q.raio} m`);
}
console.log(`\n--- orcamento de vegetacao ---`);
for (const [k, v] of Object.entries(rel.veg.porTipo)) {
  console.log(`  ${k.padEnd(12)} ${String(v.inst).padStart(6)} inst x ${String(v.triProto).padStart(5)} tri = ${(v.tri / 1000).toFixed(0)}k`);
}
console.log(`  TOTAL ${(rel.veg.triVeg / 1e6).toFixed(2)} M tri em ${rel.veg.instVeg} instancias`);

await b.close();
