/**
 * meiofio.mjs — conta os DEGRAUS INVISIVEIS do mapa inteiro e depois manda a
 * capsula andar contra eles.
 *
 * ## A conta que explica o defeito
 * A capsula tem raio R = 0,35 m. Quando a esfera de baixo encosta na ARESTA de
 * um piso levantado de altura h, a normal de saida que `_depenetrate` calcula
 * vale, no instante do primeiro toque,
 *
 *     push.y = (R - h) / R
 *
 * e o contato so e tratado como CHAO se `push.y >= CHAO_PISAVEL_Y` (0,5).
 * Resolvendo: **h <= R/2 = 0,175 m**. Uma aresta mais alta que 17,5 cm e
 * classificada como PAREDE e empurra o corpo para tras — mesmo estando muito
 * abaixo do `stepHeight` de 0,45 m que o degrau automatico aceitaria.
 *
 * ## Por que a varredura geometrica sozinha MENTE (armadilha ja paga)
 * Medir so "quanto o piso sobe em 0,35 m" mistura tres coisas diferentes:
 *   - a base de uma casa (sobe 0,4 m e segue subindo 3 m): e PAREDE, e barrar
 *     ali esta certo;
 *   - um barranco de 50 graus: sobe igual, mas e uma superficie CONTINUA e a
 *     capsula cavalga por cima sem sentir nada;
 *   - a aresta viva de uma calcada: sobe igual e TRAVA.
 * Por isso o veredito e a MARCHA — a capsula de verdade, com o mesmo ciclo de
 * reaceleracao do `Movement` — e so conta como defeito quando havia para onde
 * ir: patamar dentro do `stepHeight` e pe-direito de sobra em cima dele.
 *
 * Uso:  node tools/meiofio.mjs [--json saida.json] [--passo 3]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5294);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const SAIDA = arg('json', null);
const PASSO_CEL = Number(arg('passo', 3));

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

const r = await p.evaluate((PASSO_CEL) => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision, ng = mundo.navGrid;
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 }, U = { x: 0, y: 1, z: 0 };
  const R = 0.35, ALTURA = 1.80, STEP = 0.45, LIMITE = R * 0.5;
  const ALTO = (mundo.muralha?.topo ?? mundo.favela.cotaMax + 30) - 1.0;
  const FUNDO = mundo.favela.cotaMin - 80;

  /** Piso de colisao em (x,z) partindo de `deY`. Le AGORA: o objeto e reusado. */
  const piso = (x, z, deY) => { O.x = x; O.y = deY; O.z = z; const h = col.raycast(O, D, deY - FUNDO); return h.hit ? { y: h.point.y, sup: h.surface, ny: h.normal.y } : null; };
  /** Cabe em pe sobre (x, y, z)? */
  const cabeDePe = (x, y, z) => { O.x = x; O.y = y + 0.10; O.z = z; return !col.raycast(O, U, ALTURA - 0.12).hit; };

  const RUMOS = [];
  for (let a = 0; a < 8; a++) { const t = a * Math.PI / 4; RUMOS.push([Math.cos(t), Math.sin(t)]); }

  /* ------------------------------ 1) varredura geometrica (contexto) */
  const faixa = { 'ate 0.175 (a capsula cavalga)': 0, '0.175..0.45 (aresta vira parede)': 0, '> 0.45 (degrau alto de verdade)': 0 };
  const candidatos = [];
  let andaveis = 0;

  for (let j = 0; j < ng.height; j++) {
    for (let i = 0; i < ng.width; i++) {
      if (!ng.isWalkable(i, j)) continue;                     // ATENCAO: indices de CELULA
      andaveis++;
      const x = ng.origin.x + (i + 0.5) * ng.cellSize;
      const z = ng.origin.z + (j + 0.5) * ng.cellSize;
      const aqui = piso(x, z, ALTO);
      if (!aqui) continue;
      const teto = aqui.y + 1.2;                              // nao pegar telhado
      let pior = 0, piorSup = null, piorRumo = null, piorY = 0;
      for (const [dx, dz] of RUMOS) {
        const f = piso(x + dx * R, z + dz * R, teto);
        if (!f) continue;
        const d = f.y - aqui.y;
        if (d > pior) { pior = d; piorSup = f.sup; piorRumo = [dx, dz]; piorY = f.y; }
      }
      if (pior <= LIMITE) { faixa['ate 0.175 (a capsula cavalga)']++; continue; }
      if (pior > STEP) { faixa['> 0.45 (degrau alto de verdade)']++; continue; }
      faixa['0.175..0.45 (aresta vira parede)']++;
      // patamar util? (cabe de pe em cima e nao e a base de uma parede)
      const util = cabeDePe(x + piorRumo[0] * R, piorY, z + piorRumo[1] * R);
      candidatos.push({ x: +x.toFixed(2), z: +z.toFixed(2), h: +pior.toFixed(3), sup: piorSup, base: aqui.sup, y: aqui.y, rumo: piorRumo, util });
    }
  }
  const uteis = candidatos.filter((c) => c.util);
  uteis.sort((a, c) => c.h - a.h);

  /* ------------------------------ 2) marcha: a capsula de verdade
   * Reproduz o ciclo do jogo: quando o sweep barra, `Movement` zera a
   * velocidade planar, e no quadro seguinte o pedido volta a ser
   * `groundAccel * walk * dt^2` = 11,0 * 4,3 / 3600 = 1,31 cm. */
  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  const REINICIO = 11.0 * 4.3 / 3600;
  const marchar = (x0, z0, y0, dx, dz, quadros = 45) => {
    let px = x0, py = y0, pz = z0, parado = 0, andou = 0, vel = 4.3;
    for (let k = 0; k < quadros; k++) {
      const passo = vel / 60;
      A.x = px; A.y = py; A.z = pz;
      B.x = px + dx * passo; B.y = py - 2.0 / 60; B.z = pz + dz * passo;
      const cs = col.capsuleSweep(A, B, R, ALTURA);
      const av = (cs.position.x - px) * dx + (cs.position.z - pz) * dz;
      px = cs.position.x; py = cs.position.y; pz = cs.position.z;
      andou += Math.max(0, av);
      if (av < passo * 0.25) { parado++; vel = REINICIO * 60; } else { parado = 0; vel = 4.3; }
      if (parado >= 12) return { travou: true, andou: +andou.toFixed(3), x: +px.toFixed(2), z: +pz.toFixed(2), y: +py.toFixed(2) };
    }
    return { travou: false, andou: +andou.toFixed(3), x: +px.toFixed(2), z: +pz.toFixed(2), y: +py.toFixed(2) };
  };

  let testados = 0, travas = 0;
  const bloqueios = [];
  const porSup = {};
  for (const c of uteis) {
    testados++;
    const sx = c.x - c.rumo[0] * 0.9, sz = c.z - c.rumo[1] * 0.9;
    const base = piso(sx, sz, ALTO);
    if (!base) { testados--; continue; }
    const m = marchar(sx, sz, base.y + 0.02, c.rumo[0], c.rumo[1]);
    if (m.travou) {
      travas++;
      porSup[c.sup] = (porSup[c.sup] || 0) + 1;
      if (bloqueios.length < 25) bloqueios.push({ x: c.x, z: c.z, h: c.h, sup: c.sup, base: c.base, andou: m.andou });
    }
  }

  /* ------------------------------ 3) marcha CEGA: varre o mapa sem escolher
   * onde. A (2) so anda onde a geometria ja acusou; esta anda em todo lugar,
   * para nao ficar cega a um travamento que a sonda de 0,35 m nao viu. */
  let cegoTest = 0, cegoTrava = 0;
  const cegoOnde = [];
  const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let j = 2; j < ng.height - 2; j += PASSO_CEL) {
    for (let i = 2; i < ng.width - 2; i += PASSO_CEL) {
      if (!ng.isWalkable(i, j)) continue;
      const x = ng.origin.x + (i + 0.5) * ng.cellSize;
      const z = ng.origin.z + (j + 0.5) * ng.cellSize;
      const base = piso(x, z, ALTO);
      if (!base) continue;
      for (const [dx, dz] of CARD) {
        cegoTest++;
        const m = marchar(x, z, base.y + 0.02, dx, dz, 30);
        if (!m.travou) continue;
        // travou: havia patamar alcancavel a frente?
        const f = piso(m.x + dx * R, z + dz * R, m.y + 1.2);
        if (!f) continue;
        const sobe = f.y - m.y;
        if (sobe > LIMITE && sobe <= STEP && cabeDePe(m.x + dx * R, f.y, m.z + dz * R)) {
          cegoTrava++;
          if (cegoOnde.length < 25) cegoOnde.push({ x: +m.x.toFixed(2), z: +m.z.toFixed(2), sobe: +sobe.toFixed(3), sup: f.sup });
        }
      }
    }
  }

  return {
    andaveis, faixa,
    candidatos: candidatos.length, uteis: uteis.length,
    piores: uteis.slice(0, 12),
    marcha: { testados, travas, porSup, bloqueios },
    cego: { testados: cegoTest, travas: cegoTrava, onde: cegoOnde },
    trisColisao: col.triangleCount,
    trisTerrenoCol: mundo._trisTerrenoCol ?? null,
    trisTerrenoVis: mundo._trisTerreno ?? null,
  };
}, PASSO_CEL);

console.log('\n=== 1) VARREDURA: quanto o piso sobe em 0,35 m (raio da capsula) =====');
console.log(`  ${r.andaveis} celulas andaveis`);
for (const [k, v] of Object.entries(r.faixa)) console.log(`    ${k.padEnd(36)} ${String(v).padStart(7)}`);
console.log(`\n  dessas, com PATAMAR UTIL em cima (cabe de pe): ${r.uteis} de ${r.candidatos}`);
console.log('  as 12 piores:');
for (const c of r.piores) console.log(`    X=${String(c.x).padStart(8)} Z=${String(c.z).padStart(8)}  aresta ${c.h.toFixed(3)} m  ${c.base} -> ${c.sup}`);

console.log('\n=== 2) MARCHA contra cada aresta acusada ==============================');
console.log(`  ${r.marcha.testados} arestas   ${r.marcha.travas} TRAVARAM (${(100 * r.marcha.travas / Math.max(1, r.marcha.testados)).toFixed(1)}%)`);
console.log(`  por superficie da aresta: ${JSON.stringify(r.marcha.porSup)}`);
for (const bq of r.marcha.bloqueios) console.log(`    X=${String(bq.x).padStart(8)} Z=${String(bq.z).padStart(8)}  ${bq.base} -> ${bq.sup} ${bq.h} m   andou ${bq.andou} m`);

console.log('\n=== 3) MARCHA CEGA pelo mapa (sem escolher onde) ======================');
console.log(`  ${r.cego.testados} marchas   ${r.cego.travas} travaram com patamar alcancavel a frente`);
for (const c of r.cego.onde) console.log(`    X=${String(c.x).padStart(8)} Z=${String(c.z).padStart(8)}  sobe ${c.sobe} m (${c.sup})`);

console.log(`\n  triangulos de colisao: ${r.trisColisao}   terreno visual: ${r.trisTerrenoVis}   terreno de colisao: ${r.trisTerrenoCol}`);
if (SAIDA) { writeFileSync(SAIDA, JSON.stringify(r, null, 1)); console.log('\n  json em ' + SAIDA); }
await b.close(); vite.kill();
console.log('');
console.log(r.marcha.travas === 0 && r.cego.travas === 0 ? '>>> NENHUMA ARESTA TRAVA' : `>>> ${r.marcha.travas} + ${r.cego.travas} TRAVAMENTOS`);
