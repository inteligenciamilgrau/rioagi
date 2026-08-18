/**
 * pisadazoom.mjs — lupa no ponto: perfil do piso de 2 em 2 cm, o que a sonda de
 * chao de 5 raios enxerga, e QUAL objeto e o concreto que esta ali.
 *
 * Complementa `tools/pisada.mjs`: aquele reproduz a caminhada, este disseca o
 * quadro em que ela engasga.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5292);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ALVO = { x: Number(arg('x', -25.91)), z: Number(arg('z', -64.01)), rumo: Number(arg('rumo', 182)) };
const SAIDA = arg('json', null);

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

const r = await p.evaluate((ALVO) => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision;
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 };
  const rad = ALVO.rumo * Math.PI / 180, dx = -Math.sin(rad), dz = -Math.cos(rad);

  /** Raio de cima para baixo a partir de `deY` — le AGORA, o objeto e reusado. */
  const raio = (x, z, deY) => { O.x = x; O.y = deY; O.z = z; const h = col.raycast(O, D, deY - (mundo.favela.cotaMin - 60)); return h.hit ? { y: h.point.y, ny: h.normal.y, sup: h.surface } : null; };

  /* Sonda de chao COMO A COLISAO FAZ: 5 raios (centro + 4 a 0,62*raio), maior
   * Y ganha, e o raio nasce em pos.y + raio + 0,02 com alcance raio+0,24. */
  const RAIO = 0.35, OFF = RAIO * 0.62;
  const sonda = (x, y, z, alcance) => {
    const am = [[0, 0], [OFF, 0], [-OFF, 0], [0, OFF], [0, -OFF]];
    let melhor = -Infinity, achou = false, qual = -1;
    for (let i = 0; i < am.length; i++) {
      O.x = x + am[i][0]; O.y = y + RAIO + 0.02; O.z = z + am[i][1];
      const h = col.raycast(O, D, RAIO + alcance);
      if (!h.hit || h.normal.y < 0.5) continue;
      achou = true;
      if (h.point.y > melhor) { melhor = h.point.y; qual = i; }
    }
    return achou ? { y: melhor, qual } : null;
  };

  // --- perfil fino de 2 em 2 cm, de -2 a +4 m ---
  const ALTO = (mundo.muralha?.topo ?? mundo.favela.cotaMax + 30) - 1.0;
  const perfil = [];
  for (let t = -2; t <= 4.001; t += 0.02) {
    const x = ALVO.x + dx * t, z = ALVO.z + dz * t;
    const c = raio(x, z, ALTO);
    perfil.push({ t: +t.toFixed(2), z: +z.toFixed(2), plano: +mundo.heightAt(x, z).toFixed(3), y: c ? +c.y.toFixed(3) : null, ny: c ? +c.ny.toFixed(3) : null, sup: c ? c.sup : null });
  }

  /* Maior SALTO do piso entre duas amostras de 2 cm — degrau vertical de
   * verdade, o que a capsula tem de vencer. */
  let salto = 0, saltoEm = null;
  for (let i = 1; i < perfil.length; i++) {
    if (perfil[i].y === null || perfil[i - 1].y === null) continue;
    const d = perfil[i].y - perfil[i - 1].y;
    if (d > salto) { salto = d; saltoEm = perfil[i]; }
  }

  // --- o que a sonda de 5 raios devolve caminhando (passo de 1 cm) ---
  const sondas = [];
  for (let t = -1; t <= 3.001; t += 0.01) {
    const x = ALVO.x + dx * t, z = ALVO.z + dz * t;
    const c = raio(x, z, ALTO);
    if (!c) continue;
    const s = sonda(x, c.y, z, 0.24);
    sondas.push({ t: +t.toFixed(2), pe: +c.y.toFixed(3), sonda: s ? +s.y.toFixed(3) : null, qual: s ? s.qual : -1, dif: s ? +(s.y - c.y).toFixed(3) : null });
  }

  /* --- QUEM e o concreto? Varre a cena por malhas cujo bbox cobre o ponto --- */
  const cx = ALVO.x + dx * 1.0, cz = ALVO.z + dz * 1.0;
  const achados = [];
  const V3 = mundo.group.position.constructor;
  const caixa = new (mundo.group.children[0]?.geometry?.boundingBox?.constructor ?? Object)();
  mundo.group.traverse?.((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (!o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    // bbox em mundo por amostragem de instancias e caro; aqui basta o nome + centro
    const c = new V3();
    o.geometry.boundingBox.getCenter(c);
    o.localToWorld(c);
    const d = Math.hypot(c.x - cx, c.z - cz);
    if (d < 14) achados.push({ nome: o.name || '(sem nome)', inst: !!o.isInstancedMesh, n: o.count ?? 1, d: +d.toFixed(1), y: +c.y.toFixed(1) });
  });
  achados.sort((a, b2) => a.d - b2.d);

  // props/casas registrados no favela
  const perto = [];
  for (const c of (mundo.favela.casas || [])) { const d = Math.hypot(c.x - cx, c.z - cz); if (d < 10) perto.push({ o: 'casa', d: +d.toFixed(1), x: +c.x.toFixed(1), z: +c.z.toFixed(1), w: c.w, dd: c.d, yaw: +(c.yaw ?? 0).toFixed(2), baseY: c.baseY, niveis: c.niveis, interior: !!c.interior }); }
  for (const m of (mundo.favela.muros || [])) { const d = Math.hypot(m.x - cx, m.z - cz); if (d < 10) perto.push({ o: 'muro', d: +d.toFixed(1), x: +m.x.toFixed(1), z: +m.z.toFixed(1), len: m.len }); }
  for (const v of (mundo.favela.vias || mundo.favela.ruas || [])) { const d = Math.hypot((v.x ?? 0) - cx, (v.z ?? 0) - cz); if (d < 14) perto.push({ o: 'via', d: +d.toFixed(1), ...v }); }
  perto.sort((a, b2) => a.d - b2.d);

  return { perfil, salto: +salto.toFixed(3), saltoEm, sondas, achados: achados.slice(0, 14), perto: perto.slice(0, 10), chaves: Object.keys(mundo.favela) };
}, ALVO);

console.log('\n=== perfil do piso de 2 em 2 cm (colisao) =============================');
console.log('     t       Z    plano    piso     dif   ny   sup');
let ant = null;
for (const q of r.perfil) {
  if (q.t < -0.6 || q.t > 2.6) continue;
  const salto = ant && q.y !== null && ant.y !== null ? q.y - ant.y : 0;
  const marca = Math.abs(salto) > 0.05 ? `   <<< SALTO ${salto > 0 ? '+' : ''}${salto.toFixed(3)} m` : '';
  console.log(`  ${String(q.t).padStart(5)}${String(q.z).padStart(8)}${q.plano.toFixed(2).padStart(9)}${(q.y ?? 0).toFixed(3).padStart(9)}`
    + `${((q.y ?? 0) - q.plano).toFixed(3).padStart(8)}${String(q.ny).padStart(7)}  ${q.sup}${marca}`);
  ant = q;
}
console.log(`\n  maior salto vertical em 2 cm: ${r.salto} m  em t=${r.saltoEm?.t} Z=${r.saltoEm?.z} (${r.saltoEm?.sup})`);

console.log('\n=== o que a sonda de 5 raios devolve (dif = sonda - piso central) =====');
let piorDif = 0, piorT = null;
for (const s of r.sondas) if (s.dif !== null && s.dif > piorDif) { piorDif = s.dif; piorT = s.t; }
console.log(`  a sonda levanta o jogador ate ${piorDif.toFixed(3)} m acima do piso do ponto (em t=${piorT})`);
for (const s of r.sondas) { if (s.t < 0.4 || s.t > 1.8) continue; if (Math.round(s.t * 100) % 5) continue;
  console.log(`   t=${String(s.t).padStart(5)}  piso ${s.pe}  sonda ${s.sonda}  (raio ${['centro','+X','-X','+Z','-Z'][s.qual] ?? '-'})  dif ${s.dif}`); }

console.log('\n=== geometria da favela perto do concreto =============================');
for (const o of r.perto) console.log('  ' + JSON.stringify(o));
console.log('  campos de favela: ' + r.chaves.join(', '));
console.log('\n=== malhas da cena perto (nome / instancias / distancia) ==============');
for (const a of r.achados) console.log(`  ${a.d.toString().padStart(5)} m  ${a.inst ? 'inst x' + a.n : 'mesh   '}  ${a.nome}`);

if (SAIDA) { writeFileSync(SAIDA, JSON.stringify(r, null, 1)); console.log('\n  json em ' + SAIDA); }
await b.close(); vite.kill();
