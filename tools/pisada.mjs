/**
 * pisada.mjs — o pe prende NAQUELE ponto: reproduz, mede e nomeia o culpado.
 *
 * Relato do F3:  X -25,91  Y 32,77  Z -64,01 · olho Y 34,45 · rumo 182° ·
 * chao 32,74 · terra. "Perto dessa coordenada o chao encrenca no pe na hora de
 * passar." Nao e buraco (pes e chao colados): e obstrucao.
 *
 * Quatro medicoes, e cada uma responde uma pergunta que a outra nao responde:
 *
 * 1) RELEVO — corte do terreno no rumo andado: cota do PLANO (`world.heightAt`,
 *    o que a malha visual desenha) contra a cota da COLISAO (raio de cima para
 *    baixo, o que o pe pisa). A diferenca entre as duas e o degrau invisivel.
 *
 * 2) SUBIDA POR PASSADA — quanto a colisao sobe no comprimento de uma passada
 *    de quadro (4,3 m/s a 60 fps = 7,2 cm) e no diametro da capsula. Acima de
 *    `stepHeight` (0,45 m no `capsuleSweep`) o corpo simplesmente para.
 *
 * 3) TRAVESSIA — o jogador de verdade, largado atras do ponto, andando no rumo
 *    relatado, quadro a quadro. Anota avanco pedido x avanco obtido, `stepped`,
 *    `grounded` e a velocidade. Trava = avanco < 25% do pedido com o comando de
 *    andar em pe.
 *
 *    ARMADILHA JA PAGA (NOTES.md, secao do buraco no chao): o vetor de
 *    movimento e relativo ao YAW. Sem `jog.rig.reset(...)` o boneco anda para o
 *    lado sorteado no `Player.init()` e a medicao inteira e sobre outro lugar.
 *
 * 4) VARREDURA — as celulas irmas: o mapa inteiro medido com o mesmo criterio
 *    da (2), para o conserto nao ser so daquele ponto.
 *
 * Uso:  node tools/pisada.mjs [--json saida.json] [--x -25.91 --z -64.01 --rumo 182]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5291);
const arg = (nome, padrao) => {
  const i = process.argv.indexOf('--' + nome);
  return i > 0 ? process.argv[i + 1] : padrao;
};
const SAIDA = arg('json', null);
const ALVO = { x: Number(arg('x', -25.91)), z: Number(arg('z', -64.01)), rumo: Number(arg('rumo', 182)) };

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
p.on('console', m => { const t = m.text(); if (/\[Movement\]|\[WORLD\]/.test(t)) console.log('  cons:', t.slice(0, 140)); });
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

/* ============================================ 1 e 2) relevo e subida por passada */

const relevo = await p.evaluate((ALVO) => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision;
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 };
  const ALTO = (mundo.muralha?.topo ?? (mundo.favela.cotaMax + 30)) - 1.0;
  const FUNDO = mundo.favela.cotaMin - 80;

  /** Cota da COLISAO em (x,z) — o que o pe pisa. NaN se nao ha nada. */
  const colY = (x, z) => {
    O.x = x; O.y = ALTO; O.z = z;
    const r = col.raycast(O, D, ALTO - FUNDO);
    // devolve SEMPRE o mesmo objeto: leia agora, nao guarde a referencia
    return r.hit ? { y: r.point.y, ny: r.normal.y, sup: r.surface } : null;
  };

  const rad = ALVO.rumo * Math.PI / 180;
  const dx = -Math.sin(rad), dz = -Math.cos(rad);

  // --- corte ao longo do rumo, de -8 m a +8 m do ponto, de 25 em 25 cm ---
  const corte = [];
  for (let t = -8; t <= 8.001; t += 0.25) {
    const x = ALVO.x + dx * t, z = ALVO.z + dz * t;
    const c = colY(x, z);
    corte.push({
      t: +t.toFixed(2), x: +x.toFixed(2), z: +z.toFixed(2),
      plano: +mundo.heightAt(x, z).toFixed(3),
      col: c ? +c.y.toFixed(3) : null, ny: c ? +c.ny.toFixed(3) : null, sup: c ? c.sup : null,
    });
  }

  /* --- subida da COLISAO por passada ---
   * PASSADA: 4,3 m/s / 60 fps = 7,2 cm, o deslocamento de UM quadro andando.
   * CAPSULA: 0,70 m, o diametro do corpo — subida maior que isso dentro do
   * proprio corpo e o que a capsula tem de vencer de uma vez. */
  const PASSADA = 4.3 / 60;
  const subidas = [];
  for (let t = -8; t <= 8.001; t += PASSADA) {
    const a = colY(ALVO.x + dx * t, ALVO.z + dz * t);
    const c = colY(ALVO.x + dx * (t + PASSADA), ALVO.z + dz * (t + PASSADA));
    if (!a || !c) continue;
    subidas.push({ t: +t.toFixed(2), sobe: +(c.y - a.y).toFixed(3) });
  }
  subidas.sort((u, v) => v.sobe - u.sobe);

  // --- mapa 2D da diferenca colisao-plano em torno do ponto (12 x 12 m) ---
  const mapa = [];
  let pior = 0, piorEm = null;
  for (let j = -6; j <= 6.001; j += 0.5) {
    const linha = [];
    for (let i = -6; i <= 6.001; i += 0.5) {
      const x = ALVO.x + i, z = ALVO.z + j;
      const c = colY(x, z);
      const d = c ? c.y - mundo.heightAt(x, z) : NaN;
      linha.push(Number.isFinite(d) ? +d.toFixed(2) : null);
      if (Number.isFinite(d) && Math.abs(d) > Math.abs(pior)) { pior = d; piorEm = [+x.toFixed(2), +z.toFixed(2)]; }
    }
    mapa.push(linha);
  }

  // --- o que ha no ponto: casa, muro, prop? ---
  const perto = [];
  const dist = (a, bx, bz) => Math.hypot(a.x - bx, a.z - bz);
  for (const c of (mundo.favela.casas || [])) {
    const d = dist(c, ALVO.x, ALVO.z);
    if (d < 12) perto.push({ o: 'casa', d: +d.toFixed(1), x: +c.x.toFixed(1), z: +c.z.toFixed(1), w: +c.w?.toFixed(1), dd: +c.d?.toFixed(1) });
  }
  for (const m of (mundo.favela.muros || [])) {
    const d = dist(m, ALVO.x, ALVO.z);
    if (d < 12) perto.push({ o: 'muro', d: +d.toFixed(1), x: +m.x.toFixed(1), z: +m.z.toFixed(1), len: +m.len?.toFixed(1) });
  }
  perto.sort((u, v) => u.d - v.d);

  const noPonto = colY(ALVO.x, ALVO.z);
  return {
    corte, subidas: subidas.slice(0, 12), mapa, pior, piorEm, perto: perto.slice(0, 8),
    noPonto: noPonto ? { y: +noPonto.y.toFixed(2), ny: +noPonto.ny.toFixed(3), sup: noPonto.sup } : null,
    plano: +mundo.heightAt(ALVO.x, ALVO.z).toFixed(2),
    dx: +dx.toFixed(3), dz: +dz.toFixed(3),
    trisColisao: col.triangleCount,
  };
}, ALVO);

console.log('');
console.log('=== 1) O PONTO ========================================================');
console.log(`  alvo X=${ALVO.x} Z=${ALVO.z}  rumo ${ALVO.rumo}° -> direcao (${relevo.dx}, ${relevo.dz})`);
console.log(`  plano do terreno ${relevo.plano} m   colisao ${relevo.noPonto?.y} m  (normal.y ${relevo.noPonto?.ny}, ${relevo.noPonto?.sup})`);
console.log(`  colisao - plano: pior ${relevo.pior.toFixed(2)} m em X=${relevo.piorEm?.[0]} Z=${relevo.piorEm?.[1]} (janela de 12x12 m)`);
console.log('  geometria a menos de 12 m:');
for (const o of relevo.perto) console.log(`    ${o.o.padEnd(5)} a ${String(o.d).padStart(5)} m  X=${o.x} Z=${o.z}`);
if (!relevo.perto.length) console.log('    nenhuma casa nem muro. E terreno puro.');

console.log('');
console.log('=== corte no rumo andado (t<0 = antes do ponto) =======================');
console.log('       t       X       Z    plano  colisao     dif   normal.y  sup');
for (const c of relevo.corte) {
  if (Math.abs(c.t) > 4.01) continue;
  const dif = c.col === null ? NaN : c.col - c.plano;
  const flag = Math.abs(dif) > 0.35 ? '  <<' : '';
  console.log(`  ${String(c.t).padStart(6)}${String(c.x).padStart(8)}${String(c.z).padStart(8)}`
    + `${c.plano.toFixed(2).padStart(9)}${(c.col === null ? '-' : c.col.toFixed(2)).padStart(9)}`
    + `${(Number.isFinite(dif) ? dif.toFixed(2) : '-').padStart(8)}${String(c.ny ?? '-').padStart(11)}  ${c.sup ?? ''}${flag}`);
}

console.log('');
console.log('=== 2) SUBIDA DA COLISAO POR PASSADA DE QUADRO (7,2 cm) ===============');
console.log('  limite do capsuleSweep: stepHeight = 0,45 m. Acima disso o corpo para.');
for (const s of relevo.subidas.slice(0, 8)) {
  console.log(`    t=${String(s.t).padStart(6)} m   sobe ${s.sobe.toFixed(3)} m${s.sobe > 0.45 ? '   >>> ACIMA DO DEGRAU MAXIMO' : ''}`);
}

/* ================================================== 3) travessia com o jogador */

const travessia = await p.evaluate(async (ALVO) => {
  const ctx = window.__game.ctx, jog = ctx.player, mundo = ctx.world;
  ctx.state = 'jogando';
  const rad = ALVO.rumo * Math.PI / 180;
  const dx = -Math.sin(rad), dz = -Math.cos(rad);

  // larga 6 m ANTES do ponto, no mesmo rumo, e anda 14 m
  const RECUO = 6;
  const px = ALVO.x - dx * RECUO, pz = ALVO.z - dz * RECUO;

  jog.destravar?.();
  jog.movement.teleport(px, mundo.heightAt(px, pz) + 1.2, pz);
  jog.movement.velocity.set(0, 0, 0);
  /* O vetor de movimento e relativo ao YAW: sem escrever o rumo aqui, "para a
   * frente" e o lado que o Player.init() sorteou. Ver NOTES.md. */
  jog.rig.reset(rad, 0);
  for (let i = 0; i < 90; i++) jog.update(1 / 60);           // assenta no chao

  const orig = ctx.input.getMoveVector.bind(ctx.input);
  ctx.input.getMoveVector = (out) => { out.x = 0; out.y = 1; return out; };
  ctx.input.locked = true;

  const quadros = [];
  const PEDIDO = 4.3 / 60;
  let ax = jog.position.x, az = jog.position.z;
  for (let i = 0; i < 60 * 7; i++) {
    jog.update(1 / 60);
    const q = jog.position, mv = jog.movement;
    const avanco = Math.hypot(q.x - ax, q.z - az);
    // projecao do avanco no rumo pedido: andar de lado nao conta como passar
    const proj = (q.x - ax) * dx + (q.z - az) * dz;
    quadros.push({
      i, x: +q.x.toFixed(3), y: +q.y.toFixed(3), z: +q.z.toFixed(3),
      plano: +mundo.heightAt(q.x, q.z).toFixed(2),
      av: +avanco.toFixed(4), proj: +proj.toFixed(4),
      vp: +Math.hypot(mv.velocity.x, mv.velocity.z).toFixed(2),
      g: mv.grounded, st: mv.state,
      // distancia assinada ate o ponto alvo, ao longo do rumo
      s: +((q.x - ALVO.x) * dx + (q.z - ALVO.z) * dz).toFixed(2),
    });
    ax = q.x; az = q.z;
  }
  ctx.input.getMoveVector = orig;

  /* Trava = avanco projetado abaixo de 25% do pedido depois que ja andava.
   * Os primeiros 20 quadros sao aceleracao, nao contam. */
  const travas = [];
  for (let k = 20; k < quadros.length; k++) {
    if (quadros[k].proj < PEDIDO * 0.25) travas.push(quadros[k]);
  }
  const percorrido = Math.hypot(quadros.at(-1).x - quadros[0].x, quadros.at(-1).z - quadros[0].z);

  return {
    largada: { x: +px.toFixed(2), z: +pz.toFixed(2) },
    quadros, travas: travas.slice(0, 40), nTravas: travas.length,
    percorrido: +percorrido.toFixed(2),
    fim: { x: +jog.position.x.toFixed(2), z: +jog.position.z.toFixed(2), y: +jog.position.y.toFixed(2) },
    velMedia: +(quadros.slice(30).reduce((a, q) => a + q.vp, 0) / Math.max(1, quadros.length - 30)).toFixed(2),
    velMin: +Math.min(...quadros.slice(30).map(q => q.vp)).toFixed(2),
  };
}, ALVO);

console.log('');
console.log('=== 3) TRAVESSIA (larga 6 m antes, anda 7 s no rumo) ==================');
console.log(`  largada X=${travessia.largada.x} Z=${travessia.largada.z}   fim X=${travessia.fim.x} Z=${travessia.fim.z} Y=${travessia.fim.y}`);
console.log(`  percorrido ${travessia.percorrido} m em 7 s   (livre seriam ~30 m)`);
console.log(`  velocidade planar: media ${travessia.velMedia} m/s   minima ${travessia.velMin} m/s   (andar = 4,30)`);
console.log(`  quadros travados (avanco < 25% do pedido): ${travessia.nTravas}`);

// janela em torno do ponto: s = distancia assinada ate o alvo
console.log('');
console.log('  quadro a quadro na travessia do ponto (s = metros ate o alvo):');
console.log('   quadro       s        X        Z        Y   avanco     vel  noChao  estado');
for (const q of travessia.quadros) {
  if (q.s < -2.5 || q.s > 2.5) continue;
  const lento = q.proj < (4.3 / 60) * 0.5 ? '  <<' : '';
  console.log(`  ${String(q.i).padStart(7)}${String(q.s).padStart(8)}${String(q.x).padStart(9)}${String(q.z).padStart(9)}`
    + `${String(q.y).padStart(9)}${q.proj.toFixed(3).padStart(9)}${String(q.vp).padStart(8)}   ${q.g ? 'sim' : 'NAO'}  ${q.st}${lento}`);
}

/* ================================================= 4) as celulas irmas do mapa */

const varredura = await p.evaluate(() => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision, ng = mundo.navGrid;
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 };
  const ALTO = (mundo.muralha?.topo ?? (mundo.favela.cotaMax + 30)) - 1.0;
  const FUNDO = mundo.favela.cotaMin - 80;
  const colY = (x, z) => { O.x = x; O.y = ALTO; O.z = z; const r = col.raycast(O, D, ALTO - FUNDO); return r.hit ? r.point.y : NaN; };

  /* Criterio: |colisao - plano| na celula. E a mesma conta do piso.mjs, mas
   * aqui interessa a faixa de 0,25 a 0,75 m — a que nao derruba ninguem e
   * mesmo assim se sente no pe. */
  const hist = { '<=0.10': 0, '0.10..0.25': 0, '0.25..0.50': 0, '0.50..0.75': 0, '>0.75': 0 };
  let andaveis = 0, soma = 0, pior = 0, piorEm = null;
  const ruins = [];

  for (let j = 0; j < ng.height; j++) {
    for (let i = 0; i < ng.width; i++) {
      if (!ng.isWalkable(i, j)) continue;                    // indices de CELULA
      andaveis++;
      const x = ng.origin.x + (i + 0.5) * ng.cellSize;
      const z = ng.origin.z + (j + 0.5) * ng.cellSize;
      const y = colY(x, z);
      if (!Number.isFinite(y)) continue;
      const d = y - ng.heightAt(i, j);
      const a = Math.abs(d);
      soma += a;
      if (a > Math.abs(pior)) { pior = d; piorEm = [+x.toFixed(2), +z.toFixed(2)]; }
      if (a <= 0.10) hist['<=0.10']++;
      else if (a <= 0.25) hist['0.10..0.25']++;
      else if (a <= 0.50) hist['0.25..0.50']++;
      else if (a <= 0.75) hist['0.50..0.75']++;
      else hist['>0.75']++;
      if (a > 0.25 && ruins.length < 4000) ruins.push({ x: +x.toFixed(1), z: +z.toFixed(1), d: +d.toFixed(2) });
    }
  }
  ruins.sort((u, v) => Math.abs(v.d) - Math.abs(u.d));
  return {
    andaveis, hist, pior: +pior.toFixed(2), piorEm,
    media: +(soma / Math.max(1, andaveis)).toFixed(3),
    acima025: hist['0.25..0.50'] + hist['0.50..0.75'] + hist['>0.75'],
    piores: ruins.slice(0, 15),
    trisColisao: col.triangleCount,
    trisVisual: mundo._trisTerreno ?? null,
  };
});

console.log('');
console.log('=== 4) O MAPA INTEIRO: colisao x plano, celula a celula ===============');
console.log(`  ${varredura.andaveis} celulas andaveis   |dif| media ${varredura.media} m`);
console.log(`  pior ${varredura.pior} m em X=${varredura.piorEm?.[0]} Z=${varredura.piorEm?.[1]}`);
console.log(`  ${JSON.stringify(varredura.hist)}`);
console.log(`  >> celulas com desacordo > 0,25 m: ${varredura.acima025}`);
console.log(`  triangulos de colisao no mundo: ${varredura.trisColisao}   (terreno visual: ${varredura.trisVisual})`);
console.log('  as 10 piores:');
for (const r of varredura.piores.slice(0, 10)) console.log(`    X=${String(r.x).padStart(7)} Z=${String(r.z).padStart(7)}   ${r.d > 0 ? '+' : ''}${r.d} m`);

if (SAIDA) {
  writeFileSync(SAIDA, JSON.stringify({ alvo: ALVO, relevo, travessia, varredura }, null, 1));
  console.log('\n  json em ' + SAIDA);
}

await b.close(); vite.kill();
console.log('');
const passou = travessia.nTravas === 0 && travessia.percorrido > 20;
console.log(passou ? '>>> ATRAVESSOU SEM PRENDER' : `>>> PRENDEU (${travessia.nTravas} quadros travados, andou ${travessia.percorrido} m)`);
process.exit(0);
