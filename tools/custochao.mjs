/**
 * custochao.mjs — a medicao que faltava: quanto custa casar a malha de COLISAO
 * do terreno com a visual (2 m -> 1 m).
 *
 * O agente anterior estimou "4x os triangulos de terreno, 16 200 -> 64 800" e
 * registrou como divida por nao ter medido fps. Esta ferramenta mede, no MESMO
 * processo e no mesmo mundo, os dois valores de `World.DEC_COLISAO_TERRENO`:
 *
 *   - triangulos de colisao e de desenho
 *   - tempo de geracao do mundo e tempo de construcao do BVH
 *   - custo de consulta: 20 000 raycasts e 4 000 capsuleSweep cronometrados
 *   - fps do JOGO rodando, com quadros de aquecimento descartados
 *   - memoria de JS
 *
 * ARMADILHA: a colisao NAO e desenhada. Ela nao entra em draw call, nem em
 * shadow map, nem em shader. Esperar queda de fps por triangulo de colisao e
 * confundir malha de fisica com malha de render — o que ela encarece e BVH
 * (uma vez, na geracao) e consulta (log do numero de triangulos). Por isso a
 * medicao de fps vem junto: para dizer o numero, nao para justificar a intuicao.
 *
 * Uso:  node tools/custochao.mjs [--json saida.json] [--seg 8]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5296);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const SAIDA = arg('json', null);
const SEG = Number(arg('seg', 8));

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--expose-gc'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(1200);

/* ---------------------------------------------------------- fps do jogo real */
const fpsDoJogo = async (rotulo) => {
  const r = await p.evaluate(async (SEG) => {
    const ctx = window.__game.ctx;
    ctx.state = 'jogando';
    // aquecimento: shaders ja compilados e caches quentes antes de contar
    await new Promise((res) => { let n = 0; const f = () => (++n < 90 ? requestAnimationFrame(f) : res()); requestAnimationFrame(f); });
    const dts = [];
    await new Promise((res) => {
      let t0 = performance.now(); const fim = t0 + SEG * 1000;
      const f = () => { const t = performance.now(); dts.push(t - t0); t0 = t; if (t < fim) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f);
    });
    dts.sort((a, c) => a - c);
    const med = dts[dts.length >> 1];
    const p95 = dts[Math.floor(dts.length * 0.95)];
    const soma = dts.reduce((a, c) => a + c, 0);
    return { quadros: dts.length, medio: +(soma / dts.length).toFixed(2), mediana: +med.toFixed(2), p95: +p95.toFixed(2), fps: +(1000 / (soma / dts.length)).toFixed(1) };
  }, SEG);
  console.log(`  ${rotulo.padEnd(26)} ${String(r.fps).padStart(6)} fps   quadro medio ${r.medio} ms   mediana ${r.mediana} ms   p95 ${r.p95} ms   (${r.quadros} quadros)`);
  return r;
};

/* --------------------------------------- gera o mundo de novo com outro `dec` */
const medirDec = async (dec) => {
  const r = await p.evaluate(async (dec) => {
    const ctx = window.__game.ctx;
    const { World } = await import('/src/world/World.js');
    const antes = ctx.world;
    const t0 = performance.now();
    World.DEC_COLISAO_TERRENO = dec;
    const w = new World(ctx, { seed: antes.seed, size: antes.size });
    await w.init();
    const tGera = performance.now() - t0;

    const col = w.collision;
    // --- custo de consulta: raycast ---
    const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 };
    const meia = w.size * 0.5 - 4, alto = w.favela.cotaMax + 20;
    let semen = 12345;
    const rnd = () => (semen = (semen * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pts = [];
    for (let i = 0; i < 20000; i++) pts.push([(rnd() * 2 - 1) * meia, (rnd() * 2 - 1) * meia]);
    let soma = 0;
    const t1 = performance.now();
    for (const [x, z] of pts) { O.x = x; O.y = alto; O.z = z; const h = col.raycast(O, D, 200); if (h.hit) soma += h.point.y; }
    const tRay = performance.now() - t1;

    // --- custo de consulta: capsuleSweep ---
    const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
    const t2 = performance.now();
    for (let i = 0; i < 4000; i++) {
      const [x, z] = pts[i];
      O.x = x; O.y = alto; O.z = z;
      const h = col.raycast(O, D, 200);
      if (!h.hit) continue;
      A.x = x; A.y = h.point.y + 0.05; A.z = z;
      B.x = x + 0.07; B.y = A.y - 0.03; B.z = z;
      col.capsuleSweep(A, B, 0.35, 1.80);
    }
    const tSweep = performance.now() - t2;

    const mem = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;

    // troca o mundo do jogo pelo recem-gerado, para o fps medir ESTE
    ctx.scene.remove(antes.group);
    antes.dispose?.();
    ctx.scene.add(w.group);
    ctx.world = w;

    let trisVis = 0;
    ctx.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const g = o.geometry; if (!g) return;
      const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
      trisVis += n * (o.isInstancedMesh ? o.count : 1);
    });

    return {
      dec,
      trisColisao: col.triangleCount, trisTerrenoCol: w._trisTerrenoCol, trisTerrenoVis: w._trisTerreno,
      trisCena: Math.round(trisVis),
      tGera: +tGera.toFixed(0), tRay: +tRay.toFixed(1), tSweep: +tSweep.toFixed(1),
      mem, soma: +soma.toFixed(0),
    };
  }, dec);
  return r;
};

const saidas = [];
for (const dec of [2, 1]) {
  console.log(`\n=== malha de colisao do terreno a cada ${dec} m ======================`);
  const m = await medirDec(dec);
  console.log(`  triangulos de colisao TOTAIS : ${m.trisColisao}   (terreno: ${m.trisTerrenoCol})`);
  console.log(`  triangulos de DESENHO na cena: ${m.trisCena}   (terreno visual: ${m.trisTerrenoVis})`);
  console.log(`  geracao do mundo (com BVH)   : ${m.tGera} ms`);
  console.log(`  20 000 raycasts              : ${m.tRay} ms  (${(m.tRay * 1000 / 20000).toFixed(2)} us cada)`);
  console.log(`  4 000 capsuleSweep           : ${m.tSweep} ms  (${(m.tSweep * 1000 / 4000).toFixed(2)} us cada)`);
  console.log(`  heap de JS                   : ${m.mem} MB`);
  m.fps = await fpsDoJogo('fps do jogo rodando');
  saidas.push(m);
}

const [a, c] = saidas;
console.log('\n=== 2 m  ->  1 m ======================================================');
const linha = (n, x, y, u = '') => console.log(`  ${n.padEnd(30)} ${String(x).padStart(9)} ${String(y).padStart(9)}   ${y > x ? '+' : ''}${(((y - x) / x) * 100).toFixed(1)}% ${u}`);
linha('triangulos de colisao', a.trisColisao, c.trisColisao);
linha('  dos quais, terreno', a.trisTerrenoCol, c.trisTerrenoCol);
linha('triangulos de DESENHO', a.trisCena, c.trisCena);
linha('geracao do mundo (ms)', a.tGera, c.tGera);
linha('20k raycasts (ms)', a.tRay, c.tRay);
linha('4k capsuleSweep (ms)', a.tSweep, c.tSweep);
if (a.mem && c.mem) linha('heap de JS (MB)', a.mem, c.mem);
linha('quadro medio (ms)', a.fps.medio, c.fps.medio);
console.log(`  ${'fps'.padEnd(30)} ${String(a.fps.fps).padStart(9)} ${String(c.fps.fps).padStart(9)}   ${(c.fps.fps - a.fps.fps).toFixed(1)} fps`);

if (SAIDA) { writeFileSync(SAIDA, JSON.stringify(saidas, null, 1)); console.log('\n  json em ' + SAIDA); }
await b.close(); vite.kill();
